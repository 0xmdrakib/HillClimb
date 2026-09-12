import { CarReader } from "@ipld/car";
import { exporter, type ReadableStorage, type UnixFSEntry } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { LIGHTHOUSE_DELIVERY_GATEWAY } from "@/lib/nftGateway";
import { uploadLighthouseForm } from "@/lib/lighthouseUploadTransport";

const LIGHTHOUSE_FILE_UPLOAD_URL = "https://upload.lighthouse.storage/api/v0/add";
const MAX_CAR_BYTES = 850_000;
const MAX_IMAGE_BYTES = 650_000;
const MAX_METADATA_BYTES = 12_000;
const UPLOAD_TIMEOUT_MS = 12_000;
const GATEWAY_TIMEOUT_MS = 2_500;
type JsonRecord = Record<string, unknown>;
export type ArchiveRun = { meters: bigint; driverId: number; tokenURI: string };

export function boundedTimeout(deadlineAt: number, maximumMs: number) {
  const remaining = deadlineAt - Date.now() - 250;
  if (remaining <= 0) throw new Error("finalize_deadline");
  return Math.max(1, Math.min(maximumMs, remaining));
}


export function base64ToBytes(value: string): Uint8Array | null {
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

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attributeValue(metadata: unknown, trait: string): unknown {
  if (!isRecord(metadata) || !Array.isArray(metadata.attributes)) return undefined;
  const attribute = metadata.attributes.find((item) => isRecord(item) && item.trait_type === trait);
  return isRecord(attribute) ? attribute.value : undefined;
}

export async function validateArchive(
  carBytes: Uint8Array,
  claimedRoot: string,
  mint: ArchiveRun,
  expectedSiteUrl: string,
  { freshOnly = false }: { freshOnly?: boolean } = {},
) {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  const rootCids = roots.map((root) => root.toString());
  const deliveryGateway = LIGHTHOUSE_DELIVERY_GATEWAY;
  const isFlatPackage = mint.tokenURI === `ipfs://${claimedRoot}`
    || mint.tokenURI === `${LIGHTHOUSE_DELIVERY_GATEWAY}/${claimedRoot}`;
  const isLegacyDirectoryPackage = mint.tokenURI === `ipfs://${claimedRoot}/metadata.json`;
  if (freshOnly && mint.tokenURI !== `${deliveryGateway}/${claimedRoot}`) {
    throw new Error("invalid_token_uri");
  }
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
  const imageCid = imageUri.startsWith(ipfsImagePrefix)
    ? imageUri.slice(ipfsImagePrefix.length)
    : imageUri.startsWith(deliveryImagePrefix)
      ? imageUri.slice(deliveryImagePrefix.length)
      : "";
  if (!imageCid || imageCid.includes("/")) throw new Error("invalid_metadata_schema");
  try { CID.parse(imageCid); } catch { throw new Error("invalid_metadata_schema"); }
  if (isFlatPackage && !rootCids.includes(imageCid)) throw new Error("missing_image_root");
  const imageEntry = legacyImageEntry ?? await exporter(imageCid, blockstore);
  if (imageEntry.cid.toString() !== imageCid) throw new Error("image_cid_mismatch");
  const imageBytes = await readEntryBytes(imageEntry, MAX_IMAGE_BYTES);
  const dimensions = jpegDimensions(imageBytes);
  if (!dimensions || dimensions.width < 480 || dimensions.height < 270 || dimensions.width > 960 || dimensions.height > 960) {
    throw new Error("invalid_image");
  }
  const ratio = dimensions.width / dimensions.height;
  const isLandscape = Math.abs(ratio - 16 / 9) <= 0.02;
  const isSquare = Math.abs(ratio - 1) <= 0.02;
  if (!isLandscape && !isSquare) throw new Error("invalid_image_ratio");
  if (freshOnly && !isLandscape) throw new Error("invalid_image_ratio");

  const expectedImageUri = `ipfs://${imageCid}`;
  const expectedDeliveryImageUri = `${LIGHTHOUSE_DELIVERY_GATEWAY}/${imageCid}`;
  const properties = isRecord(metadata.properties) ? metadata.properties : null;
  const propertyFile = properties && Array.isArray(properties.files) && properties.files.length === 1 && isRecord(properties.files[0])
    ? properties.files[0]
    : null;
  const expectedDriver = Number(mint.driverId) === 0 ? "Jesse" : Number(mint.driverId) === 1 ? "Brian" : null;
  if (
    typeof metadata.name !== "string" || !metadata.name.startsWith("Jesse Hill Climb — ") ||
    ![expectedImageUri, expectedDeliveryImageUri].includes(String(metadata.image)) ||
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

  if (freshOnly) {
    const attributes = metadata.attributes;
    const allowedTraits = ["Distance", "Driver", "Vehicle", "Terrain", "Coins collected", "Result"];
    if (
      metadata.name !== `Jesse Hill Climb — ${mint.meters.toString()}m Run` ||
      metadata.description !== "A hill-climb run captured at the finish on Base." ||
      metadata.image !== expectedDeliveryImageUri ||
      Object.keys(metadata).some((key) => !["name", "description", "image", "external_url", "attributes", "properties"].includes(key)) ||
      properties?.category !== "image" ||
      Object.keys(properties).some((key) => !["category", "files"].includes(key)) ||
      !propertyFile || Object.keys(propertyFile).some((key) => !["uri", "type"].includes(key)) ||
      !Array.isArray(attributes) || attributes.length !== allowedTraits.length ||
      new Set(attributes.map((item) => isRecord(item) ? item.trait_type : null)).size !== allowedTraits.length ||
      attributes.some((item) => {
        if (!isRecord(item) || !allowedTraits.includes(String(item.trait_type))) return true;
        if (Object.keys(item).some((key) => !["trait_type", "value", "display_type"].includes(key))) return true;
        const numeric = item.trait_type === "Distance" || item.trait_type === "Coins collected";
        return numeric
          ? !Number.isInteger(item.value) || item.display_type !== "number"
          : typeof item.value !== "string" || "display_type" in item;
      })
    ) throw new Error("invalid_metadata_schema");
  }

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


export async function firstMatchingUrl(
  urls: string[],
  expectedBytes: Uint8Array,
  kind: "metadata" | "image",
  deadlineAt: number,
) {
  const matches = await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(url, {
        headers: {
          accept: kind === "metadata" ? "application/json" : "image/jpeg,image/*",
        },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(boundedTimeout(deadlineAt, GATEWAY_TIMEOUT_MS)),
      });
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const expectedType = kind === "metadata" ? "application/json" : "image/jpeg";
      if (!response.ok || contentType !== expectedType) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const bytes = await readBinaryResponseWithLimit(response, expectedBytes.byteLength + 1);
      return equalBytes(bytes, expectedBytes) ? url : null;
    } catch { /* Paid delivery has not been verified. */ }
    return null;
  }));
  return matches.find((url): url is string => Boolean(url)) ?? null;
}

export async function waitForGatewayAssets(
  gateway: string,
  metadataPath: string,
  imageCid: string,
  metadataBytes: Uint8Array,
  imageBytes: Uint8Array,
  delays = [0, 750, 1_500, 3_000],
  deadlineAt = Date.now() + 15_000,
) {
  // The paid host is the only delivery authority. Verify both exact files here;
  // no alternate host may turn a missing or incorrect paid asset into success.
  for (const delay of delays) {
    if (Date.now() + delay + 300 >= deadlineAt) return null;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const [metadataUrl, artworkUrl] = await Promise.all([
      firstMatchingUrl([`${gateway}/${metadataPath}`], metadataBytes, "metadata", deadlineAt),
      firstMatchingUrl([`${gateway}/${imageCid}`], imageBytes, "image", deadlineAt),
    ]);
    if (metadataUrl && artworkUrl) return { metadataUrl, artworkUrl };
  }
  return null;
}


type UploadFile = { bytes: Uint8Array; name: string; type: string };

function lighthouseHashes(responseText: string): string[] {
  let records: unknown;
  try {
    records = JSON.parse(responseText);
  } catch {
    // The add endpoint may stream NDJSON. Every nonblank record must parse:
    // an earlier Hash does not make a truncated or failed stream successful.
    const lines = responseText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error("invalid_lighthouse_response");
    try {
      records = lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error("invalid_lighthouse_response");
    }
  }
  const hashes: string[] = [];
  const collect = (value: unknown, depth = 0) => {
    if (depth > 32) throw new Error("invalid_lighthouse_response");
    if (Array.isArray(value)) {
      if (!value.length) throw new Error("invalid_lighthouse_response");
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (!isRecord(value)) throw new Error("invalid_lighthouse_response");
    if (
      "error" in value || "Error" in value || value.success === false ||
      (typeof value.Type === "string" && value.Type.toLowerCase() === "error") ||
      (typeof value.type === "string" && value.type.toLowerCase() === "error") ||
      ("Message" in value && "Code" in value)
    ) throw new Error("lighthouse_upload_failed");

    const hasHash = "Hash" in value;
    const hasData = "data" in value;
    if (hasHash) {
      if (typeof value.Hash !== "string" || !value.Hash) throw new Error("invalid_lighthouse_response");
      try { CID.parse(value.Hash); }
      catch { throw new Error("invalid_lighthouse_response"); }
      hashes.push(value.Hash);
    }
    if (hasData) collect(value.data, depth + 1);
    // Kubo may emit progress before the completed file record. Progress alone
    // is never acceptance; unknown/empty envelopes are not ignored either.
    const isProgress = typeof value.Name === "string" &&
      typeof value.Bytes === "number" && Number.isFinite(value.Bytes) && value.Bytes >= 0;
    if (!hasHash && !hasData && !isProgress) throw new Error("invalid_lighthouse_response");
  };
  collect(records);
  if (!hashes.length) throw new Error("invalid_lighthouse_response");
  return hashes;
}

export async function uploadFiles(
  apiKey: string,
  files: UploadFile[],
  expectedRoot: string,
  wrapWithDirectory: boolean,
  deadlineAt: number,
) {
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
  const responseText = await uploadLighthouseForm({
    url: `${LIGHTHOUSE_FILE_UPLOAD_URL}?${params.toString()}`,
    formData,
    apiKey,
    timeoutMs: boundedTimeout(deadlineAt, UPLOAD_TIMEOUT_MS),
  });
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
