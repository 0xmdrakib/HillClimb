/** Read-only live evidence: node scripts/verify-nft-delivery.mjs <tokenId> */
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import { createPublicClient, http, isAddress, parseAbi } from "viem";
import { base } from "viem/chains";

const DEFAULT_GATEWAY = "https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs";
const DEFAULT_CONTRACT = "0x6362da72665385a437910d276f5db9777a2f4edd";
const report = { tokenId: process.argv[2] ?? null, ok: false };

function fail(reason) { throw new Error(reason); }

function paidUrl(value, gateway) {
  if (typeof value !== "string") fail("missing_paid_url");
  let url;
  try { url = new URL(value); } catch { fail("invalid_paid_url"); }
  if (url.protocol !== "https:" || url.origin !== gateway.origin || url.username || url.password
    || url.search || url.hash || !url.pathname.startsWith(`${gateway.pathname}/`)) {
    fail("non_paid_delivery_url");
  }
  const cid = url.pathname.slice(gateway.pathname.length + 1);
  if (!/^(?:b[a-z2-7]{40,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(cid)) fail("invalid_delivery_cid");
  return url.href;
}

function verifyContentType(contentType, kind) {
  const mimeType = contentType?.split(";", 1)[0].trim().toLowerCase();
  const expectedType = kind === "metadata" ? "application/json" : "image/jpeg";
  if (mimeType !== expectedType) fail(`${kind}_unexpected_content_type`);
}

function verifyCidBytes(url, bytes, kind) {
  let cid;
  try { cid = CID.parse(new URL(url).pathname.split("/").at(-1)); }
  catch { fail(`${kind}_invalid_cid`); }
  const verification = {
    version: cid.version,
    codec: cid.code,
    hashCode: cid.multihash.code,
    matches: null,
    method: "not_checked_unsupported_cid",
  };
  report[kind].cidVerification = verification;
  // A UnixFS dag-pb root hashes its encoded block, not the fetched file bytes.
  // Do not report a false mismatch for those older file CIDs.
  if (cid.code === 0x70) {
    verification.method = "not_checked_unixfs_dag";
    return;
  }
  if (cid.version !== 1 || cid.code !== 0x55 || cid.multihash.code !== 0x12) return;
  verification.method = "raw_sha256";
  verification.matches = Buffer.from(cid.multihash.digest).equals(createHash("sha256").update(bytes).digest());
  if (!verification.matches) fail(`${kind}_cid_mismatch`);
}

async function getBytes(url, kind, maximumBytes) {
  const response = await fetch(url, {
    headers: { accept: kind === "metadata" ? "application/json" : "image/jpeg" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  report[kind] = { status: response.status, contentType: response.headers.get("content-type") };
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail(`${kind}_http_error`);
  }
  try { verifyContentType(report[kind].contentType, kind); }
  catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) fail(`${kind}_empty_body`);
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumBytes) fail(`${kind}_too_large`);
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  report[kind].bytes = size;
  const bytes = Buffer.concat(parts, size);
  verifyCidBytes(url, bytes, kind);
  return bytes;
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail("image_not_jpeg");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) fail("invalid_jpeg_marker");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) break;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  fail("jpeg_dimensions_missing");
}

try {
  if (!/^\d{1,78}$/.test(report.tokenId ?? "")) fail("usage_expected_decimal_token_id");
  const tokenId = BigInt(report.tokenId);
  if (tokenId >= 2n ** 256n) fail("invalid_token_id");
  const contract = process.env.NEXT_PUBLIC_RUNNFT_ADDRESS?.trim() || DEFAULT_CONTRACT;
  if (!isAddress(contract)) fail("invalid_contract");
  const gateway = new URL((process.env.NEXT_PUBLIC_LIGHTHOUSE_GATEWAY_URL?.trim() || DEFAULT_GATEWAY).replace(/\/+$/, ""));
  if (gateway.protocol !== "https:" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.lighthouseweb3\.xyz$/.test(gateway.hostname)
    || gateway.pathname !== "/ipfs" || gateway.port
    || gateway.username || gateway.password || gateway.href.includes("?") || gateway.href.includes("#")) fail("invalid_paid_gateway_configuration");
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org", { timeout: 15_000, retryCount: 0 }),
  });
  let tokenUri;
  try {
    tokenUri = await client.readContract({
      address: contract,
      abi: parseAbi(["function tokenURI(uint256) view returns (string)"]),
      functionName: "tokenURI",
      args: [tokenId],
    });
  } catch { fail("token_uri_read_failed"); }
  report.tokenUri = paidUrl(tokenUri, gateway);
  const metadataBytes = await getBytes(report.tokenUri, "metadata", 12_000);
  let metadata;
  try { metadata = JSON.parse(metadataBytes.toString("utf8")); } catch { fail("metadata_not_json"); }
  if (!metadata || typeof metadata.name !== "string" || !metadata.name.trim()) fail("metadata_name_missing");
  report.name = metadata.name;
  report.imageUrl = paidUrl(metadata.image, gateway);
  const imageBytes = await getBytes(report.imageUrl, "image", 650_000);
  const dimensions = jpegDimensions(imageBytes);
  Object.assign(report.image, dimensions);
  if (Math.abs(dimensions.width / dimensions.height - 16 / 9) > 0.02
    || dimensions.width < 480 || dimensions.width > 960 || dimensions.height < 270 || dimensions.height > 540) {
    fail("image_not_full_frame_16_by_9");
  }
  report.contentAddressVerified = report.metadata.cidVerification.matches === true
    && report.image.cidVerification.matches === true;
  report.ok = true;
} catch (error) {
  // Never print transport errors: configured RPC URLs may contain API secrets.
  report.error = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "delivery_check_failed";
  process.exitCode = 1;
}
console.log(JSON.stringify(report));
