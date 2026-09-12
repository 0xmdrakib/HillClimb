import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CID } from "multiformats/cid";
import { createPublicClient, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { LIGHTHOUSE_DELIVERY_GATEWAY } from "@/lib/nftGateway";
import { nftUploadMessage, type NftUploadMessageInput } from "@/lib/nftUploadMessage";
import { RequestBodyTooLargeError } from "@/lib/apiProtection";

export const UPLOAD_CHALLENGE_TTL_MS = 5 * 60_000;
const SIGNATURE_TIMEOUT_MS = 8_000;
const UPLOAD_BODY_TIMEOUT_MS = 5_000;
const MAX_REPLAY_ENTRIES = 512;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type UploadConfiguration = { apiKey: string; rpcUrl: string; origin: string; contract: Address };
export type UploadAuthorization = NftUploadMessageInput & { version: 1; chainId: 8453 };
export type PreparedNft = {
  ok: true;
  availability: "verified";
  rootCid: string;
  tokenUri: string;
  metadataUrl: string;
  artworkUrl: string;
  verifiedAt: number;
  expiresAt: number;
};

export class UploadAuthorizationError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "UploadAuthorizationError";
  }
}

/** Bound the actual incoming reader, including bodies that never finish. */
export async function readUploadBody(request: Request, maxBytes: number, deadlineAt: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  let timedOut = false;
  try {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
    const timeoutMs = Math.min(UPLOAD_BODY_TIMEOUT_MS, deadlineAt - Date.now());
    if (timeoutMs <= 0) throw new UploadAuthorizationError("request_body_timeout", 408);
    const expiresAt = Date.now() + timeoutMs;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        // Cancel resolves a pending read as well as notifying the actual source.
        // Do not await an untrusted source's possibly stalled cancel callback.
        void reader.cancel().catch(() => undefined);
        reject(new UploadAuthorizationError("request_body_timeout", 408));
      }, timeoutMs);
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (timedOut || Date.now() >= expiresAt) throw new UploadAuthorizationError("request_body_timeout", 408);
      if (done) { completed = true; break; }
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof UploadAuthorizationError || error instanceof RequestBodyTooLargeError) throw error;
    throw new UploadAuthorizationError("invalid_request_body", 400);
  } finally {
    clearTimeout(timer);
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getUploadConfiguration(): UploadConfiguration {
  try {
    const apiKey = (process.env.LIGHTHOUSE_API_KEY ?? "").trim();
    const originUrl = new URL((process.env.NEXT_PUBLIC_URL ?? "").trim());
    const rpcUrl = new URL((process.env.BASE_RPC_URL ?? "").trim());
    const contract = (process.env.NEXT_PUBLIC_RUNNFT_ADDRESS ?? "").trim();
    if (
      !apiKey || originUrl.protocol !== "https:" || originUrl.pathname !== "/" ||
      originUrl.search || originUrl.hash || originUrl.username || originUrl.password ||
      rpcUrl.protocol !== "https:" || rpcUrl.hash || rpcUrl.username || rpcUrl.password ||
      !isAddress(contract) || contract.toLowerCase() === ZERO_ADDRESS
    ) throw new Error();
    return { apiKey, rpcUrl: rpcUrl.href, origin: originUrl.origin, contract: getAddress(contract) };
  } catch { throw new UploadAuthorizationError("nft_storage_not_configured", 503); }
}

export function assertUploadOrigin(request: Request, origin: string): void {
  try {
    // Bind to configured deployment origin, not a client-controlled Host pair.
    if (request.headers.get("origin") !== origin || new URL(request.url).origin !== origin) throw new Error();
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin") throw new Error();
  } catch { throw new UploadAuthorizationError("forbidden_origin", 403); }
}

function validateRunInput(input: unknown): Omit<NftUploadMessageInput, "origin" | "contract" | "nonce" | "expiresAt"> {
  if (!record(input)) throw new UploadAuthorizationError("invalid_mint_package", 400);
  const { address, rootCid, tokenUri, meters, driverId } = input;
  if (
    typeof address !== "string" || !isAddress(address) || address.toLowerCase() === ZERO_ADDRESS ||
    typeof rootCid !== "string" || !/^b[a-z2-7]{40,100}$/.test(rootCid) ||
    tokenUri !== `${LIGHTHOUSE_DELIVERY_GATEWAY}/${rootCid}` ||
    typeof meters !== "number" || !Number.isInteger(meters) || meters < 0 || meters > 100_000 ||
    (driverId !== 0 && driverId !== 1)
  ) throw new UploadAuthorizationError("invalid_mint_package", 400);
  try {
    const cid = CID.parse(rootCid);
    if (cid.version !== 1 || cid.multihash.code !== 0x12 || cid.toString() !== rootCid) throw new Error();
  } catch { throw new UploadAuthorizationError("invalid_mint_package", 400); }
  return { address: getAddress(address), rootCid, tokenUri, meters, driverId };
}

function challengeMac(payload: string, apiKey: string): Buffer {
  const key = createHmac("sha256", apiKey).update("jesse-hill-climb:nft-upload-challenge:v1").digest();
  return createHmac("sha256", key).update(payload).digest();
}

export function issueUploadChallenge(input: unknown, config: UploadConfiguration) {
  const authorization: UploadAuthorization = {
    ...validateRunInput(input),
    version: 1,
    chainId: 8453,
    origin: config.origin,
    contract: config.contract,
    nonce: randomBytes(32).toString("hex"),
    expiresAt: Date.now() + UPLOAD_CHALLENGE_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(authorization)).toString("base64url");
  const challenge = `${payload}.${challengeMac(payload, config.apiKey).toString("base64url")}`;
  return {
    challenge,
    message: nftUploadMessage(authorization),
    nonce: authorization.nonce,
    expiresAt: authorization.expiresAt,
  };
}

export function verifyUploadChallenge(challenge: unknown, config: UploadConfiguration): UploadAuthorization {
  if (typeof challenge !== "string" || challenge.length > 4_096) {
    throw new UploadAuthorizationError("invalid_upload_authorization", 401);
  }
  const parts = challenge.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) {
    throw new UploadAuthorizationError("invalid_upload_authorization", 401);
  }
  const suppliedMac = Buffer.from(parts[1], "base64url");
  const expectedMac = challengeMac(parts[0], config.apiKey);
  if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) {
    throw new UploadAuthorizationError("invalid_upload_authorization", 401);
  }
  let input: unknown;
  try { input = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { throw new UploadAuthorizationError("invalid_upload_authorization", 401); }
  if (!record(input)) throw new UploadAuthorizationError("invalid_upload_authorization", 401);
  const { version, chainId, origin, contract, nonce, expiresAt } = input;
  if (
    version !== 1 || chainId !== 8453 || origin !== config.origin || contract !== config.contract ||
    typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) ||
    typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)
  ) throw new UploadAuthorizationError("invalid_upload_authorization", 401);
  if (expiresAt <= Date.now() || expiresAt > Date.now() + UPLOAD_CHALLENGE_TTL_MS + 5_000) {
    throw new UploadAuthorizationError("upload_authorization_expired", 401);
  }
  let run: ReturnType<typeof validateRunInput>;
  try { run = validateRunInput(input); }
  catch { throw new UploadAuthorizationError("invalid_upload_authorization", 401); }
  return { ...run, version, chainId, origin, contract, nonce, expiresAt };
}

export async function verifyUploadSignature(
  authorization: UploadAuthorization,
  signature: unknown,
  config: UploadConfiguration,
  deadlineAt: number,
) {
  if (typeof signature !== "string" || signature.length > 32_770 || !/^0x(?:[a-fA-F0-9]{2})+$/.test(signature)) {
    throw new UploadAuthorizationError("invalid_upload_signature", 401);
  }
  const timeoutMs = Math.min(SIGNATURE_TIMEOUT_MS, deadlineAt - Date.now() - 250);
  if (timeoutMs <= 0) throw new UploadAuthorizationError("upload_authorization_unavailable", 503);
  const controller = new AbortController();
  const client = createPublicClient({ chain: base, transport: http(config.rpcUrl, {
    timeout: Math.min(4_000, timeoutMs), retryCount: 0,
    fetchOptions: { signal: controller.signal },
  }) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verified = await Promise.race([
      (async () => {
        if (await client.getChainId() !== 8453) throw new Error();
        if (controller.signal.aborted) throw new Error();
        // Public-client verification supports EOAs and ERC-1271/6492 smart wallets.
        return client.verifyMessage({ address: authorization.address as Address, message: nftUploadMessage(authorization), signature: signature as Hex });
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new UploadAuthorizationError("upload_authorization_unavailable", 503));
        }, timeoutMs);
      }),
    ]);
    if (!verified) throw new UploadAuthorizationError("invalid_upload_signature", 401);
  } catch (error) {
    if (error instanceof UploadAuthorizationError) throw error;
    throw new UploadAuthorizationError("upload_authorization_unavailable", 503);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

type ReplayEntry = { challengeExpiresAt: number; task: Promise<PreparedNft>; proof?: PreparedNft };
declare global {
  // Warm-instance protection only: neither this map nor apiProtection counters
  // claim a distributed quota or globally single-use authorization guarantee.
  var __jhcUploadReplay: Map<string, ReplayEntry> | undefined;
}
const replay = globalThis.__jhcUploadReplay ??= new Map<string, ReplayEntry>();

export async function singleFlightPreparation(authorization: UploadAuthorization, task: () => Promise<PreparedNft>): Promise<PreparedNft> {
  const now = Date.now();
  for (const [key, entry] of replay) if (entry.challengeExpiresAt <= now) replay.delete(key);
  if (authorization.expiresAt <= now) throw new UploadAuthorizationError("upload_authorization_expired", 401);
  const key = `${authorization.origin}:${authorization.contract}:${authorization.address.toLowerCase()}:${authorization.nonce}`;
  const existing = replay.get(key);
  if (existing && (!existing.proof || existing.proof.expiresAt > now)) return existing.task;
  if (!existing && replay.size >= MAX_REPLAY_ENTRIES) throw new UploadAuthorizationError("nft_storage_busy", 429);
  const entry: ReplayEntry = { challengeExpiresAt: authorization.expiresAt, task: Promise.resolve().then(task) };
  replay.set(key, entry);
  try {
    const proof = await entry.task;
    entry.proof = proof;
    return proof;
  } catch (error) {
    if (replay.get(key) === entry) replay.delete(key);
    throw error;
  }
}
