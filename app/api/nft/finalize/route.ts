import { CarReader } from "@ipld/car";
import { exporter, type ReadableStorage, type UnixFSEntry } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  createPublicClient,
  decodeEventLog,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  readBodyWithLimit,
  readResponseWithLimit,
  requestTooLargeResponse,
  RequestBodyTooLargeError,
} from "@/lib/apiProtection";
import { runNftAbi } from "@/lib/onchainAbi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIGHTHOUSE_CAR_UPLOAD_URL = "https://upload.lighthouse.storage/api/v0/dag/import";
const MAX_BODY_BYTES = 1_200_000;
const MAX_CAR_BYTES = 850_000;
const MAX_IMAGE_BYTES = 650_000;
const MAX_METADATA_BYTES = 12_000;
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;

const RATE_LIMIT = {
  name: "nft:finalize",
  ip: [
    { limit: 3, windowMs: 60_000 },
    { limit: 12, windowMs: 60 * 60_000 },
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

type JsonRecord = Record<string, unknown>;

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: RESPONSE_HEADERS });
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

function base64ToBytes(value: string): Uint8Array | null {
  if (!value || value.length > 1_150_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const buffer = Buffer.from(value, "base64");
    if (!buffer.length || buffer.length > MAX_CAR_BYTES) return null;
    return new Uint8Array(buffer);
  } catch { return null; }
}

async function readEntryBytes(entry: UnixFSEntry, maxBytes: number) {
  if (entry.type !== "file" && entry.type !== "raw") throw new Error("invalid_file");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of entry.content()) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("file_too_large");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attributeValue(metadata: unknown, trait: string): unknown {
  if (!isRecord(metadata) || !Array.isArray(metadata.attributes)) return undefined;
  const attribute = metadata.attributes.find((item) => isRecord(item) && item.trait_type === trait);
  return isRecord(attribute) ? attribute.value : undefined;
}

async function validateArchive(
  carBytes: Uint8Array,
  claimedRoot: string,
  mint: MintEvent,
  expectedSiteUrl: string,
) {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  if (roots.length !== 1 || roots[0].toString() !== claimedRoot) throw new Error("root_mismatch");

  let blockCount = 0;
  let hasRoot = false;
  for await (const block of reader.blocks()) {
    blockCount += 1;
    if (blockCount > 32) throw new Error("too_many_blocks");
    if (block.cid.multihash.code !== sha256.code) throw new Error("unsupported_hash");
    const digest = await sha256.digest(block.bytes);
    if (!equalBytes(digest.bytes, block.cid.multihash.bytes)) throw new Error("invalid_block");
    if (block.cid.toString() === claimedRoot) hasRoot = true;
  }
  if (!hasRoot) throw new Error("missing_root");

  const blockstore: ReadableStorage = {
    get: async (cid: CID) => {
      // @ipld/car and the exporter currently carry compatible, but separately
      // typed, multiformats versions in their dependency trees.
      const carCid = cid as unknown as Parameters<typeof reader.get>[0];
      const block = await reader.get(carCid);
      if (!block) throw new Error("missing_block");
      return block.bytes;
    },
  };

  const root = await exporter(claimedRoot, blockstore);
  if (root.type !== "directory") throw new Error("invalid_root");
  const children = [];
  for await (const child of root.content()) children.push(child);
  if (children.length !== 2 || !children.some((item) => item.name === "run.jpg") || !children.some((item) => item.name === "metadata.json")) {
    throw new Error("invalid_archive_files");
  }

  const imageEntry = await exporter(`${claimedRoot}/run.jpg`, blockstore);
  const metadataEntry = await exporter(`${claimedRoot}/metadata.json`, blockstore);
  const imageBytes = await readEntryBytes(imageEntry, MAX_IMAGE_BYTES);
  const dimensions = jpegDimensions(imageBytes);
  if (!dimensions || dimensions.width < 480 || dimensions.height < 270 || dimensions.width > 960 || dimensions.height > 540) {
    throw new Error("invalid_image");
  }
  if (Math.abs(dimensions.width / dimensions.height - 16 / 9) > 0.02) throw new Error("invalid_image_ratio");

  const metadataBytes = await readEntryBytes(metadataEntry, MAX_METADATA_BYTES);
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder().decode(metadataBytes)); }
  catch { throw new Error("invalid_metadata"); }

  if (!isRecord(metadata)) throw new Error("invalid_metadata_schema");

  const expectedImageUri = `ipfs://${imageEntry.cid.toString()}`;
  const expectedDriver = Number(mint.driverId) === 0 ? "Jesse" : Number(mint.driverId) === 1 ? "Brian" : null;
  if (
    typeof metadata.name !== "string" || !metadata.name.startsWith("Jesse Hill Climb — ") ||
    metadata.image !== expectedImageUri ||
    metadata.external_url !== expectedSiteUrl ||
    Number(attributeValue(metadata, "Distance")) !== Number(mint.meters) ||
    attributeValue(metadata, "Driver") !== expectedDriver ||
    !["Jeep", "Drift Bike", "Sports Car"].includes(String(attributeValue(metadata, "Vehicle"))) ||
    !["Countryside", "Desert", "Arctic", "Moon"].includes(String(attributeValue(metadata, "Terrain"))) ||
    !["Crash", "Out of fuel"].includes(String(attributeValue(metadata, "Result"))) ||
    !Number.isInteger(Number(attributeValue(metadata, "Coins collected"))) ||
    Number(attributeValue(metadata, "Coins collected")) < 0 ||
    Number(attributeValue(metadata, "Coins collected")) > 10_000
  ) throw new Error("invalid_metadata_schema");

  return { imageBytes: imageBytes.byteLength, metadataBytes: metadataBytes.byteLength };
}

async function verifyMintTransaction(rpcUrl: string, contract: Address, txHash: Hex, expectedTokenUri: string): Promise<MintEvent> {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("transaction_failed");

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: runNftAbi, data: log.data, topics: log.topics });
      if (decoded.eventName !== "RunMinted") continue;
      const args = decoded.args as unknown as MintEvent;
      if (args.tokenURI !== expectedTokenUri) throw new Error("token_uri_mismatch");
      if (args.meters < 0n || args.meters > 100_000n) throw new Error("invalid_distance");
      return args;
    } catch (error) {
      if (error instanceof Error && ["token_uri_mismatch", "invalid_distance"].includes(error.message)) throw error;
    }
  }
  throw new Error("mint_event_not_found");
}

async function gatewayHasMetadata(gateway: string, rootCid: string) {
  try {
    const response = await fetch(`${gateway}/${rootCid}/metadata.json`, {
      headers: { accept: "application/json", range: "bytes=0-64" },
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    return response.ok;
  } catch { return false; }
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, RATE_LIMIT);
  if (limited) return limited;
  if (!sameOrigin(request)) return jsonError("forbidden_origin", 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return jsonError("content_type_must_be_json", 415);
  }

  const apiKey = (process.env.LIGHTHOUSE_API_KEY ?? "").trim();
  const gateway = httpsUrl((process.env.LIGHTHOUSE_GATEWAY_URL ?? "").trim());
  const rpcUrl = httpsUrl((process.env.BASE_RPC_URL ?? "").trim());
  const contractValue = (process.env.NEXT_PUBLIC_RUNNFT_ADDRESS ?? "").trim();
  if (!apiKey || !gateway || !rpcUrl || !isAddress(contractValue)) return jsonError("nft_storage_not_configured", 503);

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
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !/^b[a-z2-7]{40,100}$/.test(rootCid) || tokenUri !== `ipfs://${rootCid}/metadata.json`) {
    return jsonError("invalid_mint_package", 400);
  }
  const carBytes = base64ToBytes(String(body.carBase64 ?? ""));
  if (!carBytes) return jsonError("invalid_or_oversized_car", 413);

  let mint: MintEvent;
  try { mint = await verifyMintTransaction(rpcUrl, contractValue, txHash, tokenUri); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason = ["transaction_failed", "token_uri_mismatch", "invalid_distance", "mint_event_not_found"].includes(message)
      ? message
      : "transaction_not_confirmed";
    return jsonError(reason, reason === "transaction_failed" ? 409 : 422);
  }

  const requestOrigin = new URL(request.headers.get("origin")!).origin.replace(/\/$/, "");
  const configuredSite = httpsUrl((process.env.NEXT_PUBLIC_URL ?? "").trim()) ?? requestOrigin;
  try { await validateArchive(carBytes, rootCid, mint, configuredSite); }
  catch { return jsonError("invalid_car_archive", 422); }

  const gatewayUrl = `${gateway}/${rootCid}/metadata.json`;
  if (await gatewayHasMetadata(gateway, rootCid)) {
    return NextResponse.json({ ok: true, alreadyStored: true, rootCid, tokenUri, gatewayUrl, tokenId: mint.tokenId.toString() }, { headers: RESPONSE_HEADERS });
  }

  const formData = new FormData();
  const carBuffer = carBytes.buffer.slice(carBytes.byteOffset, carBytes.byteOffset + carBytes.byteLength) as ArrayBuffer;
  formData.append("file", new Blob([carBuffer], { type: "application/vnd.ipld.car" }), `${rootCid}.car`);

  try {
    const upstream = await fetch(LIGHTHOUSE_CAR_UPLOAD_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: formData,
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    const responseText = await readResponseWithLimit(upstream, 64_000);
    if (!upstream.ok) return jsonError("lighthouse_upload_failed", 502);
    let response: unknown;
    try { response = JSON.parse(responseText); } catch { return jsonError("invalid_lighthouse_response", 502); }
    const responseData = isRecord(response) && isRecord(response.data) ? response.data : null;
    const uploadedCid = String(responseData?.Hash ?? (isRecord(response) ? response.Hash : "") ?? "");
    try {
      if (!uploadedCid || !CID.parse(uploadedCid).equals(CID.parse(rootCid))) {
        return jsonError("lighthouse_cid_mismatch", 502);
      }
    } catch { return jsonError("invalid_lighthouse_response", 502); }
  } catch {
    return jsonError("lighthouse_upload_failed", 502);
  }

  return NextResponse.json({ ok: true, alreadyStored: false, rootCid, tokenUri, gatewayUrl, tokenId: mint.tokenId.toString() }, { headers: RESPONSE_HEADERS });
}
