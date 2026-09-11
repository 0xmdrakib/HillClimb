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
import { after, NextResponse } from "next/server";
import {
  enforceRateLimit,
  readBodyWithLimit,
  readResponseWithLimit,
  requestTooLargeResponse,
  RequestBodyTooLargeError,
} from "@/lib/apiProtection";
import { runNftAbi } from "@/lib/onchainAbi";
import { LIGHTHOUSE_DELIVERY_GATEWAY, LIGHTHOUSE_LEGACY_PUBLIC_GATEWAY } from "@/lib/nftGateway";
import { NFT_PIPELINE_VERSION } from "@/lib/nftPipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LIGHTHOUSE_FILE_UPLOAD_URL = "https://upload.lighthouse.storage/api/v0/add";
const LIGHTHOUSE_UPLOAD_INDEX_URL = "https://api.lighthouse.storage/api/user/files_uploaded?lastKey=null&fileType=all";
const OPENSEA_API_URL = "https://api.opensea.io/api/v2";
const OPENSEA_COLLECTION_URL = "https://opensea.io/collection/jesse-hill-climb";
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

async function readBinaryResponseWithLimit(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("response_too_large");
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("response_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
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
  const rootCids = roots.map((root) => root.toString());
  const deliveryGateway = mint.tokenURI === `${LIGHTHOUSE_LEGACY_PUBLIC_GATEWAY}/${claimedRoot}`
    ? LIGHTHOUSE_LEGACY_PUBLIC_GATEWAY
    : LIGHTHOUSE_DELIVERY_GATEWAY;
  const isFlatPackage = mint.tokenURI === `ipfs://${claimedRoot}`
    || mint.tokenURI === `${LIGHTHOUSE_LEGACY_PUBLIC_GATEWAY}/${claimedRoot}`
    || mint.tokenURI === `${LIGHTHOUSE_DELIVERY_GATEWAY}/${claimedRoot}`;
  const isLegacyDirectoryPackage = mint.tokenURI === `ipfs://${claimedRoot}/metadata.json`;
  if (
    (!isFlatPackage && !isLegacyDirectoryPackage) ||
    !rootCids.includes(claimedRoot) ||
    (isFlatPackage && roots.length !== 2) ||
    (isLegacyDirectoryPackage && (roots.length !== 1 || roots[0].toString() !== claimedRoot))
  ) throw new Error("root_mismatch");

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

  let metadataEntry: UnixFSEntry;
  let metadataPath: string;
  let legacyImageEntry: UnixFSEntry | null = null;
  if (isFlatPackage) {
    metadataEntry = await exporter(claimedRoot, blockstore);
    metadataPath = claimedRoot;
  } else {
    const root = await exporter(claimedRoot, blockstore);
    if (root.type !== "directory") throw new Error("invalid_root");
    const children = [];
    for await (const child of root.content()) children.push(child);
    if (children.length !== 2 || !children.some((item) => item.name === "run.jpg") || !children.some((item) => item.name === "metadata.json")) {
      throw new Error("invalid_archive_files");
    }
    legacyImageEntry = await exporter(`${claimedRoot}/run.jpg`, blockstore);
    metadataEntry = await exporter(`${claimedRoot}/metadata.json`, blockstore);
    metadataPath = `${claimedRoot}/metadata.json`;
  }
  const metadataBytes = await readEntryBytes(metadataEntry, MAX_METADATA_BYTES);
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder().decode(metadataBytes)); }
  catch { throw new Error("invalid_metadata"); }

  if (!isRecord(metadata)) throw new Error("invalid_metadata_schema");

  const imageUri = typeof metadata.image === "string" ? metadata.image : "";
  const ipfsImagePrefix = "ipfs://";
  const deliveryImagePrefix = `${LIGHTHOUSE_DELIVERY_GATEWAY}/`;
  const legacyImagePrefix = `${LIGHTHOUSE_LEGACY_PUBLIC_GATEWAY}/`;
  const imageCid = imageUri.startsWith(ipfsImagePrefix)
    ? imageUri.slice(ipfsImagePrefix.length)
    : imageUri.startsWith(deliveryImagePrefix)
      ? imageUri.slice(deliveryImagePrefix.length)
      : imageUri.startsWith(legacyImagePrefix)
        ? imageUri.slice(legacyImagePrefix.length)
      : "";
  if (!imageCid || imageCid.includes("/")) throw new Error("invalid_metadata_schema");
  try { CID.parse(imageCid); } catch { throw new Error("invalid_metadata_schema"); }
  if (isFlatPackage && !rootCids.includes(imageCid)) throw new Error("missing_image_root");
  const imageEntry = legacyImageEntry ?? await exporter(imageCid, blockstore);
  if (imageEntry.cid.toString() !== imageCid) throw new Error("image_cid_mismatch");
  const imageBytes = await readEntryBytes(imageEntry, MAX_IMAGE_BYTES);
  const dimensions = jpegDimensions(imageBytes);
  const properties = isRecord(metadata.properties) ? metadata.properties : null;
  const isSquareArtwork = properties?.artwork_format === "square-v1";
  const maxHeight = isSquareArtwork ? 960 : 540;
  if (!dimensions || dimensions.width < 480 || dimensions.height < 270 || dimensions.width > 960 || dimensions.height > maxHeight) {
    throw new Error("invalid_image");
  }
  const expectedRatio = isSquareArtwork ? 1 : 16 / 9;
  if (Math.abs(dimensions.width / dimensions.height - expectedRatio) > 0.02) throw new Error("invalid_image_ratio");

  const expectedImageUri = `ipfs://${imageCid}`;
  const expectedDeliveryImageUri = `${LIGHTHOUSE_DELIVERY_GATEWAY}/${imageCid}`;
  const expectedLegacyImageUri = `${LIGHTHOUSE_LEGACY_PUBLIC_GATEWAY}/${imageCid}`;
  const propertyFile = properties && Array.isArray(properties.files) && properties.files.length === 1 && isRecord(properties.files[0])
    ? properties.files[0]
    : null;
  const expectedDriver = Number(mint.driverId) === 0 ? "Jesse" : Number(mint.driverId) === 1 ? "Brian" : null;
  if (
    typeof metadata.name !== "string" || !metadata.name.startsWith("Jesse Hill Climb — ") ||
    ![expectedImageUri, expectedDeliveryImageUri, expectedLegacyImageUri].includes(String(metadata.image)) ||
    propertyFile?.uri !== expectedImageUri ||
    propertyFile?.type !== "image/jpeg" ||
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

  return {
    imageBytes,
    metadataBytes,
    imageCid,
    metadataPath,
    rootCids,
    isLegacyDirectoryPackage,
    deliveryGateway,
  };
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

async function firstMatchingUrl(urls: string[], expectedBytes: Uint8Array, kind: "metadata" | "image") {
  const matches = await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(url, {
        headers: {
          accept: kind === "metadata" ? "application/json" : "image/jpeg,image/*",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) return null;
      const bytes = await readBinaryResponseWithLimit(response, expectedBytes.byteLength + 1);
      return equalBytes(bytes, expectedBytes) ? url : null;
    } catch { /* Try the next gateway. */ }
    return null;
  }));
  return matches.find((url): url is string => Boolean(url)) ?? null;
}

async function waitForGatewayAssets(
  gateway: string,
  metadataPath: string,
  imageCid: string,
  metadataBytes: Uint8Array,
  imageBytes: Uint8Array,
  delays = [0, 750, 1_500, 3_000],
) {
  // Future tokenURI/image fields point to these exact paid-gateway URLs. Only clear
  // the local recovery package after those same URLs serve the expected bytes.
  const metadataCandidates = [`${gateway}/${metadataPath}`];
  const imageCandidates = [`${gateway}/${imageCid}`];
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const [metadataUrl, artworkUrl] = await Promise.all([
      firstMatchingUrl(metadataCandidates, metadataBytes, "metadata"),
      firstMatchingUrl(imageCandidates, imageBytes, "image"),
    ]);
    if (metadataUrl && artworkUrl) return { metadataUrl, artworkUrl };
  }
  return null;
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
        signal: AbortSignal.timeout(10_000),
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
  availability: "verified" | "propagating" = "verified",
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
    availability,
    openSeaRefresh,
    openSeaUrl: `https://opensea.io/item/base/${contract}/${tokenId}`,
    collectionUrl: OPENSEA_COLLECTION_URL,
  };
}

function scheduleMarketplaceFinalization(
  apiKey: string,
  rootCid: string,
  contract: Address,
  mint: MintEvent,
  archive: Awaited<ReturnType<typeof validateArchive>>,
) {
  after(async () => {
    try {
      const indexedCids = archive.isLegacyDirectoryPackage ? [rootCid] : [rootCid, archive.imageCid];
      const [assets, indexed] = await Promise.all([
        waitForGatewayAssets(
          archive.deliveryGateway,
          archive.metadataPath,
          archive.imageCid,
          archive.metadataBytes,
          archive.imageBytes,
          [1_500],
        ),
        hasIndexedUploads(apiKey, indexedCids),
      ]);
      if (!assets || !indexed) return;
      await queueOpenSeaRefresh(contract, mint.tokenId);
    } catch {
      // The upload has already been accepted under the exact onchain CIDs.
      // Gateway propagation and marketplace refresh are best-effort follow-up.
    }
  });
}

type UploadFile = { bytes: Uint8Array; name: string; type: string };

function lighthouseHashes(responseText: string): string[] {
  const records: unknown[] = [];
  try {
    const parsed = JSON.parse(responseText);
    if (Array.isArray(parsed)) records.push(...parsed);
    else records.push(parsed);
  } catch {
    for (const line of responseText.split(/\r?\n/).filter(Boolean)) {
      try { records.push(JSON.parse(line)); } catch { /* Ignore a malformed line. */ }
    }
  }
  const hashes: string[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) { for (const item of value) collect(item); return; }
    if (!isRecord(value)) return;
    if (typeof value.Hash === "string") hashes.push(value.Hash);
    if ("data" in value) collect(value.data);
  };
  for (const record of records) collect(record);
  return hashes;
}

function lighthouseIndexedCids(responseText: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (!isRecord(parsed)) return new Set();
    const payload = isRecord(parsed.data) ? parsed.data : parsed;
    if (!Array.isArray(payload.fileList)) return new Set();
    return new Set(
      payload.fileList
        .filter(isRecord)
        .map((file) => typeof file.cid === "string" ? file.cid : "")
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function hasIndexedUploads(apiKey: string, expectedCids: string[]) {
  try {
    const response = await fetch(LIGHTHOUSE_UPLOAD_INDEX_URL, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const responseText = await readResponseWithLimit(response, 256_000);
    if (!response.ok) return false;
    const indexedCids = lighthouseIndexedCids(responseText);
    return expectedCids.every((cid) => indexedCids.has(cid));
  } catch {
    return false;
  }
}

async function uploadFiles(apiKey: string, files: UploadFile[], expectedRoot: string, wrapWithDirectory: boolean) {
  const formData = new FormData();
  for (const file of files) {
    const buffer = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
    formData.append("file", new Blob([buffer], { type: file.type }), file.name);
  }

  const params = new URLSearchParams({
    "cid-version": "1",
    "raw-leaves": "true",
    chunker: "size-1048576",
    pin: "true",
    "wrap-with-directory": String(wrapWithDirectory),
  });
  const upstream = await fetch(`${LIGHTHOUSE_FILE_UPLOAD_URL}?${params.toString()}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: formData,
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  const responseText = await readResponseWithLimit(upstream, 64_000);
  if (!upstream.ok) throw new Error("lighthouse_upload_failed");
  const uploadedCids = lighthouseHashes(responseText);
  try {
    if (!uploadedCids.some((uploadedCid) => CID.parse(uploadedCid).equals(CID.parse(expectedRoot)))) {
      throw new Error("lighthouse_cid_mismatch");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "lighthouse_cid_mismatch") throw error;
    throw new Error("invalid_lighthouse_response");
  }
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, RATE_LIMIT);
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
    || tokenUri === `${LIGHTHOUSE_LEGACY_PUBLIC_GATEWAY}/${rootCid}`
    || tokenUri === `${LIGHTHOUSE_DELIVERY_GATEWAY}/${rootCid}`
    || tokenUri === `ipfs://${rootCid}/metadata.json`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !/^b[a-z2-7]{40,100}$/.test(rootCid) || !validTokenUri) {
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
  let archive: Awaited<ReturnType<typeof validateArchive>>;
  try { archive = await validateArchive(carBytes, rootCid, mint, configuredSite); }
  catch { return jsonError("invalid_car_archive", 422); }

  const isRetry = body.retry === true;
  if (isRetry) {
    const indexedCids = archive.isLegacyDirectoryPackage ? [rootCid] : [rootCid, archive.imageCid];
    const [existingAssets, indexed] = await Promise.all([
      waitForGatewayAssets(
        archive.deliveryGateway,
        archive.metadataPath,
        archive.imageCid,
        archive.metadataBytes,
        archive.imageBytes,
        [0],
      ),
      hasIndexedUploads(apiKey, indexedCids),
    ]);
    if (existingAssets && indexed) {
      const refreshState = (process.env.OPENSEA_API_KEY ?? "").trim() ? "scheduled" as const : "not_configured" as const;
      scheduleMarketplaceFinalization(apiKey, rootCid, contractValue, mint, archive);
      return NextResponse.json(successPayload(contractValue, mint, rootCid, tokenUri, existingAssets, true, refreshState), { headers: RESPONSE_HEADERS });
    }
  }

  try {
    const imageFile = { bytes: archive.imageBytes, name: "run.jpg", type: "image/jpeg" };
    const metadataFile = { bytes: archive.metadataBytes, name: "metadata.json", type: "application/json" };
    if (archive.isLegacyDirectoryPackage) {
      await uploadFiles(apiKey, [imageFile, metadataFile], rootCid, true);
    } else {
      // The token URI and image URI point to these exact raw file CIDs. Using
      // Lighthouse's normal add endpoint stores the content itself; uploading
      // a CAR here would only register a `carfile.car` record and leave these
      // roots unavailable to gateways and marketplaces.
      await Promise.all([
        uploadFiles(apiKey, [imageFile], archive.imageCid, false),
        uploadFiles(apiKey, [metadataFile], rootCid, false),
      ]);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "lighthouse_upload_failed";
    return jsonError(
      ["invalid_lighthouse_response", "lighthouse_cid_mismatch"].includes(reason) ? reason : "lighthouse_upload_failed",
      502,
    );
  }

  // Lighthouse returned the exact CIDs committed in the transaction. Gateway
  // propagation can take longer than a serverless request and is not a failed
  // mint or failed upload. Verify it and refresh OpenSea after responding.
  scheduleMarketplaceFinalization(apiKey, rootCid, contractValue, mint, archive);
  const deliveryAssets = {
    metadataUrl: `${archive.deliveryGateway}/${archive.metadataPath}`,
    artworkUrl: `${archive.deliveryGateway}/${archive.imageCid}`,
  };
  const refreshState = (process.env.OPENSEA_API_KEY ?? "").trim() ? "scheduled" as const : "not_configured" as const;
  return NextResponse.json(
    successPayload(contractValue, mint, rootCid, tokenUri, deliveryAssets, false, refreshState, "propagating"),
    { headers: RESPONSE_HEADERS },
  );
}

export async function GET() {
  return NextResponse.json(
    { pipelineVersion: NFT_PIPELINE_VERSION },
    { headers: RESPONSE_HEADERS },
  );
}
