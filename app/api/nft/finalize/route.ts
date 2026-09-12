import {
  createPublicClient,
  decodeEventLog,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { after, NextResponse } from "next/server";
import {
  enforceRateLimit,
  readBodyWithLimit,
  requestTooLargeResponse,
  RequestBodyTooLargeError,
} from "@/lib/apiProtection";
import { runNftAbi } from "@/lib/onchainAbi";
import { LIGHTHOUSE_DELIVERY_GATEWAY } from "@/lib/nftGateway";
import { LighthouseUploadError } from "@/lib/lighthouseUploadTransport";

import { base64ToBytes, isRecord, validateArchive, waitForGatewayAssets, uploadFiles } from "@/lib/nftStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OPENSEA_API_URL = "https://api.opensea.io/api/v2";
const OPENSEA_COLLECTION_URL = "https://opensea.io/collection/jesse-hill-climb";
const MAX_BODY_BYTES = 1_200_000;
const FINALIZE_DEADLINE_MS = 50_000;
const RPC_TIMEOUT_MS = 5_000;
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;

const INGRESS_RATE_LIMIT = {
  name: "nft:finalize:ingress",
  ip: [
    { limit: 30, windowMs: 60_000 },
    { limit: 120, windowMs: 60 * 60_000 },
  ],
  global: [{ limit: 60, windowMs: 60_000 }],
  headers: RESPONSE_HEADERS,
} as const;

type MintEvent = {
  player: Address;
  tokenId: bigint;
  meters: bigint;
  driverId: number;
  tokenURI: string;
};

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: RESPONSE_HEADERS });
}

function jsonPending(error: string) {
  return NextResponse.json({ ok: false, pending: true, error }, { status: 202, headers: RESPONSE_HEADERS });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))
    ?.split(",", 1)[0]
    .trim();
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); }
  catch { return false; }
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

function validateMintValues(meters: bigint, driverId: number, tokenURI: string, expectedTokenUri: string) {
  if (tokenURI !== expectedTokenUri) throw new Error("token_uri_mismatch");
  if (meters < 0n || meters > 100_000n) throw new Error("invalid_distance");
  if (driverId !== 0 && driverId !== 1) throw new Error("invalid_driver");
}

async function verifyMintTransaction(rpcUrl: string, contract: Address, txHash: Hex, expectedTokenUri: string): Promise<MintEvent> {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }) });
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("transaction_failed");

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: runNftAbi, data: log.data, topics: log.topics });
      if (decoded.eventName !== "RunMinted") continue;
      const args = decoded.args as unknown as MintEvent;
      validateMintValues(args.meters, Number(args.driverId), args.tokenURI, expectedTokenUri);
      return args;
    } catch (error) {
      if (error instanceof Error && ["token_uri_mismatch", "invalid_distance", "invalid_driver"].includes(error.message)) throw error;
    }
  }
  throw new Error("mint_event_not_found");
}

async function queueOpenSeaRefresh(contract: Address, tokenId: bigint) {
  const apiKey = (process.env.OPENSEA_API_KEY ?? "").trim();
  if (!apiKey) return "not_configured" as const;
  try {
    const response = await fetch(
      `${OPENSEA_API_URL}/chain/base/contract/${contract}/nfts/${tokenId.toString()}/refresh?ignoreCachedItemUrls=true`,
      {
        method: "POST",
        headers: { "x-api-key": apiKey, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      },
    );
    // 409 means a refresh for the same token is already in OpenSea's queue.
    return response.ok || response.status === 409 ? "queued" as const : "failed" as const;
  } catch { return "failed" as const; }
}

function successPayload(
  contract: Address,
  mint: MintEvent,
  rootCid: string,
  tokenUri: string,
  assets: { metadataUrl: string; artworkUrl: string },
  alreadyStored: boolean,
  openSeaRefresh: "scheduled" | "queued" | "failed" | "not_configured",
) {
  const tokenId = mint.tokenId.toString();
  return {
    ok: true,
    alreadyStored,
    rootCid,
    tokenUri,
    gatewayUrl: assets.metadataUrl,
    metadataUrl: assets.metadataUrl,
    artworkUrl: assets.artworkUrl,
    tokenId,
    availability: "verified" as const,
    openSeaRefresh,
    openSeaUrl: `https://opensea.io/item/base/${contract}/${tokenId}`,
    collectionUrl: OPENSEA_COLLECTION_URL,
  };
}

function scheduleMarketplaceFinalization(
  contract: Address,
  mint: MintEvent,
) {
  after(async () => {
    await queueOpenSeaRefresh(contract, mint.tokenId);
  });
}

export async function POST(request: Request) {
  const deadlineAt = Date.now() + FINALIZE_DEADLINE_MS;
  // Keep a coarse ingress ceiling for oversized or malformed requests. The
  // stricter limiter below is isolated per transaction so an old retry queue
  // cannot consume the budget needed to finalize a newly approved mint.
  const limited = enforceRateLimit(request, INGRESS_RATE_LIMIT);
  if (limited) return limited;
  if (!sameOrigin(request)) return jsonError("forbidden_origin", 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return jsonError("content_type_must_be_json", 415);
  }

  const apiKey = (process.env.LIGHTHOUSE_API_KEY ?? "").trim();
  const rpcUrl = httpsUrl((process.env.BASE_RPC_URL ?? "").trim());
  const contractValue = (process.env.NEXT_PUBLIC_RUNNFT_ADDRESS ?? "").trim();
  if (!apiKey || !rpcUrl || !isAddress(contractValue)) return jsonError("nft_storage_not_configured", 503);

  let bodyText: string;
  try { bodyText = await readBodyWithLimit(request, MAX_BODY_BYTES); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestTooLargeResponse(error, RESPONSE_HEADERS);
    return jsonError("invalid_request_body", 400);
  }

  let body: unknown;
  try { body = JSON.parse(bodyText); }
  catch { return jsonError("invalid_json", 400); }
  if (!isRecord(body)) return jsonError("invalid_json", 400);
  const txHash = String(body.txHash ?? "") as Hex;
  const rootCid = String(body.rootCid ?? "");
  const tokenUri = String(body.tokenUri ?? "");
  const validTokenUri = tokenUri === `ipfs://${rootCid}`
    || tokenUri === `${LIGHTHOUSE_DELIVERY_GATEWAY}/${rootCid}`
    || tokenUri === `ipfs://${rootCid}/metadata.json`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !/^b[a-z2-7]{40,100}$/.test(rootCid) || !validTokenUri) {
    return jsonError("invalid_mint_package", 400);
  }
  const transactionLimited = enforceRateLimit(request, {
    name: `nft:finalize:tx:${txHash.toLowerCase()}`,
    ip: [
      { limit: 3, windowMs: 60_000 },
      { limit: 12, windowMs: 60 * 60_000 },
    ],
    headers: RESPONSE_HEADERS,
  });
  if (transactionLimited) return transactionLimited;
  const carBytes = base64ToBytes(String(body.carBase64 ?? ""));
  if (!carBytes) return jsonError("invalid_or_oversized_car", 413);

  // Storage is deliberately gated behind a confirmed, successful RunMinted
  // receipt. A rejected, cancelled, replaced, or reverted wallet transaction
  // can therefore never consume Lighthouse storage.
  let mint: MintEvent;
  try { mint = await verifyMintTransaction(rpcUrl, contractValue, txHash, tokenUri); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "transaction_failed") return jsonError(message, 409);
    if (["token_uri_mismatch", "invalid_distance", "invalid_driver", "mint_event_not_found"].includes(message)) {
      return jsonError(message, 422);
    }
    return jsonPending("transaction_not_confirmed");
  }

  const requestOrigin = new URL(request.headers.get("origin")!).origin.replace(/\/$/, "");
  const configuredSite = httpsUrl((process.env.NEXT_PUBLIC_URL ?? "").trim()) ?? requestOrigin;
  let archive: Awaited<ReturnType<typeof validateArchive>>;
  try { archive = await validateArchive(carBytes, rootCid, mint, configuredSite); }
  catch { return jsonError("invalid_car_archive", 422); }

  // After receipt verification, keep the known-working upload-before-probe path
  // for a fresh request. Do not request potentially unpinned CIDs before this
  // upload. A retry first checks whether an earlier upload already completed.
  let deliveryAssets = body.retry === true
    ? await waitForGatewayAssets(
      archive.deliveryGateway,
      archive.metadataPath,
      archive.imageCid,
      archive.metadataBytes,
      archive.imageBytes,
      [0],
      deadlineAt,
    )
    : null;
  const alreadyStored = Boolean(deliveryAssets);

  if (!deliveryAssets) {
    let uploadStage: "image" | "metadata" | "directory" = "image";
    try {
      const imageFile = { bytes: archive.imageBytes, name: "run.jpg", type: "image/jpeg" };
      const metadataFile = { bytes: archive.metadataBytes, name: "metadata.json", type: "application/json" };
      if (archive.isLegacyDirectoryPackage) {
        uploadStage = "directory";
        await uploadFiles(apiKey, [imageFile, metadataFile], rootCid, true, deadlineAt);
      } else {
        // The token URI and image URI point to these exact raw file CIDs. Using
        // Lighthouse's normal add endpoint stores the content itself; uploading
        // a CAR here would only register a `carfile.car` record and leave these
        // roots unavailable to gateways and marketplaces.
        // Keep the proven flat two-CID structure. Store the artwork first and its
        // metadata second, both under the same server-only Lighthouse account.
        await uploadFiles(apiKey, [imageFile], archive.imageCid, false, deadlineAt);
        uploadStage = "metadata";
        await uploadFiles(apiKey, [metadataFile], rootCid, false, deadlineAt);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "lighthouse_upload_failed";
      // Keep operational evidence server-side. Never log a request/package,
      // credential, response body, or arbitrary upstream error message.
      console.warn("nft_upload_failed", {
        tokenId: mint.tokenId.toString(),
        stage: uploadStage,
        reason: error instanceof LighthouseUploadError ? error.reason
          : ["invalid_lighthouse_response", "lighthouse_cid_mismatch", "finalize_deadline"].includes(reason)
            ? reason : "upload_error",
        ...(error instanceof LighthouseUploadError && error.statusCode
          ? { statusCode: error.statusCode } : {}),
      });
      if (
        reason === "finalize_deadline" ||
        (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
      ) return jsonPending("nft_storage_pending");
      return jsonError(
        ["invalid_lighthouse_response", "lighthouse_cid_mismatch"].includes(reason) ? reason : "lighthouse_upload_failed",
        502,
      );
    }
  }

  if (!deliveryAssets) {
    deliveryAssets = await waitForGatewayAssets(
      archive.deliveryGateway,
      archive.metadataPath,
      archive.imageCid,
      archive.metadataBytes,
      archive.imageBytes,
      [0, 500, 1_000, 2_000],
      deadlineAt,
    );
  }
  if (!deliveryAssets) {
    console.warn("nft_delivery_unavailable", {
      tokenId: mint.tokenId.toString(),
      metadataCid: rootCid,
      imageCid: archive.imageCid,
    });
    return jsonPending("nft_storage_pending");
  }

  // A successful response now means both immutable files were fetched back and
  // byte-verified. Only then refresh the marketplace and clear client pending data.
  scheduleMarketplaceFinalization(contractValue, mint);
  const refreshState = (process.env.OPENSEA_API_KEY ?? "").trim() ? "scheduled" as const : "not_configured" as const;
  return NextResponse.json(successPayload(
    contractValue,
    mint,
    rootCid,
    tokenUri,
    deliveryAssets,
    alreadyStored,
    refreshState,
  ), { headers: RESPONSE_HEADERS });
}
