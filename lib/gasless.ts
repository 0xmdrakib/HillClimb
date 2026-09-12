"use client";

import type { Eip1193Provider } from "@/lib/wallet";
import { appendErc8021Suffix } from "@/lib/builderCodes";

type JsonRpcError = { code?: number; message?: string; data?: any };

const CAPABILITY_WAIT_MS = 350;
const POSITIVE_CAPABILITY_TTL_MS = 10 * 60_000;
const NEGATIVE_CAPABILITY_TTL_MS = 60_000;
const SLOW_CAPABILITY_RETRY_MS = 30_000;

type CapabilityCacheEntry = {
  promise: Promise<boolean> | null;
  value: boolean | null;
  expiresAt: number;
  retryAfter: number;
};

const capabilityCache = new WeakMap<Eip1193Provider, Map<string, CapabilityCacheEntry>>();

function paymasterProxyUrl() {
  return (process.env.NEXT_PUBLIC_PAYMASTER_PROXY_SERVER_URL ?? "").trim();
}

export function isPaymasterServiceConfigured(): boolean {
  return Boolean(paymasterProxyUrl());
}

function isUserRejected(e: unknown): boolean {
  const err = e as any;
  const code = err?.code ?? err?.data?.code ?? err?.data?.originalError?.code;
  if (code === 4001) return true; // EIP-1193 userRejectedRequest
  const msg = String(err?.message ?? e);
  return /user rejected|rejected the request|request rejected|cancelled|canceled/i.test(msg);
}

function isInvalidParams(e: unknown): boolean {
  const err = e as JsonRpcError;
  const msg = String(err?.message ?? e);
  return err?.code === -32602 || /invalid params|invalid argument|version|atomicRequired/i.test(msg);
}

function methodUnsupported(e: unknown) {
  const err = e as JsonRpcError;
  const msg = String(err?.message ?? e);
  return err?.code === -32601 || /does not support|not support|Method not found/i.test(msg);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class SponsoredCallsPendingError extends Error {
  constructor(readonly callsId: string) {
    super("Sponsored transaction is still confirming");
    this.name = "SponsoredCallsPendingError";
  }
}

export class SponsoredCallsFailedError extends Error {
  constructor(readonly status: number) {
    super(`Sponsored batch failed (status=${status})`);
    this.name = "SponsoredCallsFailedError";
  }
}

function validCallsId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/** One read-only status request; never sends a new batch or opens a wallet. */
export async function getSponsoredCallsTransactionHash(
  provider: Eip1193Provider,
  callsId: string,
): Promise<`0x${string}`> {
  if (!validCallsId(callsId)) throw new SponsoredCallsPendingError("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      provider.request({ method: "wallet_getCallsStatus", params: [callsId] }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SponsoredCallsPendingError(callsId)), 8_000);
      }),
    ]);
    const rawStatus = status?.status;
    // The supported 1.0 sendCalls fallback reports string statuses, while
    // newer wallets use numeric EIP-5792 status families.
    const code = rawStatus === "CONFIRMED" ? 200 : rawStatus === "PENDING" ? 100 : Number(rawStatus ?? 0);
    if (code >= 400 && code < 700) throw new SponsoredCallsFailedError(code);
    const hash = status?.receipts?.[0]?.transactionHash;
    if (code >= 200 && code < 300 && typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) return hash as `0x${string}`;
    throw new SponsoredCallsPendingError(callsId);
  } catch (error) {
    if (error instanceof SponsoredCallsFailedError) throw error;
    throw new SponsoredCallsPendingError(callsId);
  } finally { clearTimeout(timer); }
}

function capabilityKey(from: `0x${string}`, chainIdHex: `0x${string}`) {
  return `${from.toLowerCase()}:${chainIdHex.toLowerCase()}`;
}

function providerCapabilityCache(provider: Eip1193Provider) {
  let cache = capabilityCache.get(provider);
  if (!cache) {
    cache = new Map();
    capabilityCache.set(provider, cache);
  }
  return cache;
}

async function detectPaymasterService(params: {
  provider: Eip1193Provider;
  from: `0x${string}`;
  chainIdHex: `0x${string}`;
}): Promise<boolean> {
  try {
    const caps = (await params.provider.request({
      method: "wallet_getCapabilities",
      params: [params.from],
    })) as any;

    // Different implementations key this map differently (hex chainId like "0x2105" vs decimal like 8453).
    const chainIdDec = Number.parseInt(params.chainIdHex, 16);
    const byHex = caps?.[params.chainIdHex];
    const byDec = caps?.[chainIdDec] ?? caps?.[String(chainIdDec)];
    const cap = byHex ?? byDec;
    return cap?.paymasterService?.supported === true;
  } catch (e) {
    if (methodUnsupported(e)) return false;
    return false;
  }
}

function capabilityEntry(params: {
  provider: Eip1193Provider;
  from: `0x${string}`;
  chainIdHex: `0x${string}`;
}): CapabilityCacheEntry {
  const cache = providerCapabilityCache(params.provider);
  const key = capabilityKey(params.from, params.chainIdHex);
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && (existing.promise || (existing.value !== null && existing.expiresAt > now))) return existing;

  const entry: CapabilityCacheEntry = {
    promise: null,
    value: null,
    expiresAt: 0,
    retryAfter: 0,
  };
  entry.promise = detectPaymasterService(params).catch(() => false).then((value) => {
    // Do not let an older, slow request overwrite a newer cache entry.
    if (cache.get(key) === entry) {
      entry.promise = null;
      entry.value = value;
      entry.expiresAt = Date.now() + (value ? POSITIVE_CAPABILITY_TTL_MS : NEGATIVE_CAPABILITY_TTL_MS);
      entry.retryAfter = 0;
    }
    return value;
  });
  cache.set(key, entry);
  return entry;
}

function waitForCapability(promise: Promise<boolean>, timeoutMs: number) {
  return new Promise<{ completed: boolean; value: boolean }>((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ completed: false, value: false });
    }, timeoutMs);
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve({ completed: true, value });
    });
  });
}

/** Start the read-only capability check while the wallet is idle. */
export function primePaymasterServiceSupport(params: {
  provider: Eip1193Provider;
  from: `0x${string}`;
  chainIdHex: `0x${string}`;
}): void {
  if (!isPaymasterServiceConfigured()) return;
  capabilityEntry(params);
}

/**
 * Checks whether the connected wallet supports gas sponsorship on Base via paymasterService.
 */
export async function supportsPaymasterService(params: {
  provider: Eip1193Provider;
  from: `0x${string}`;
  chainIdHex: `0x${string}`;
}): Promise<boolean> {
  // No proxy means no sponsorship attempt and, importantly, no provider RPC.
  if (!isPaymasterServiceConfigured()) return false;

  const entry = capabilityEntry(params);
  if (entry.value !== null && entry.expiresAt > Date.now()) return entry.value;
  if (!entry.promise || entry.retryAfter > Date.now()) return false;

  const result = await waitForCapability(entry.promise, CAPABILITY_WAIT_MS);
  if (!result.completed) {
    // The read-only request may still resolve and populate the cache later, but
    // it must not hold the user's normal transaction prompt hostage.
    entry.retryAfter = Date.now() + SLOW_CAPABILITY_RETRY_MS;
    return false;
  }
  return result.value;
}

async function sendCalls(params: {
  provider: Eip1193Provider;
  chainIdHex: `0x${string}`;
  from: `0x${string}`;
  calls: Array<{ to: `0x${string}`; value: `0x${string}`; data: `0x${string}` }>;
  paymasterProxyUrl: string;
  beforeSend?: () => void | Promise<void>;
}): Promise<unknown> {
  // Try newer shape first (some wallets want this), then fall back to the simpler 1.0 style.
  // Guard failures are deliberately outside the wallet-error fallback handler.
  await params.beforeSend?.();
  try {
    return (await params.provider.request({
      method: "wallet_sendCalls",
      params: [
        {
          version: "2.0.0",
          chainId: params.chainIdHex,
          from: params.from,
          calls: params.calls,
          atomicRequired: true,
          capabilities: {
            paymasterService: { url: params.paymasterProxyUrl },
          },
        },
      ],
    })) as any;
  } catch (e) {
    // If the user rejects the prompt, do NOT retry (avoids a 2nd prompt).
    if (isUserRejected(e)) throw e;
    if (!isInvalidParams(e)) throw e;

    // Fall back to 1.0 style
    await params.beforeSend?.();
    return (await params.provider.request({
      method: "wallet_sendCalls",
      params: [
        {
          version: "1.0",
          chainId: params.chainIdHex,
          from: params.from,
          calls: params.calls,
          capabilities: {
            paymasterService: { url: params.paymasterProxyUrl },
          },
        },
      ],
    })) as any;
  }
}

/**
 * Sends a sponsored call batch and resolves the eventual transaction hash.
 */
export async function sendSponsoredCallsAndGetTxHash(params: {
  provider: Eip1193Provider;
  chainIdHex: `0x${string}`;
  from: `0x${string}`;
  calls: Array<{ to: `0x${string}`; value: `0x${string}`; data: `0x${string}` }>;
  timeoutMs?: number;
  beforeSend?: () => void | Promise<void>;
  onSubmitted?: (submission: { callsId: string }) => void | Promise<void>;
}): Promise<`0x${string}`> {
  const proxyUrl = paymasterProxyUrl();
  if (!proxyUrl) throw new Error("Missing NEXT_PUBLIC_PAYMASTER_PROXY_SERVER_URL");

  const callsIdRaw = await sendCalls({
    provider: params.provider,
    chainIdHex: params.chainIdHex,
    from: params.from,
    calls: params.calls.map((c) => ({ ...c, data: appendErc8021Suffix(c.data) })),
    paymasterProxyUrl: proxyUrl,
    beforeSend: params.beforeSend,
  });

  // Some wallets return the id directly as a string; others return an object.
  let callsId: unknown = callsIdRaw;
  if (typeof callsIdRaw !== "string" && callsIdRaw && typeof callsIdRaw === "object") {
    const obj = callsIdRaw as Record<string, unknown>;
    callsId = obj.id ?? obj.result ?? obj.callsId;
  }

  if (!validCallsId(callsId)) {
    throw new Error("wallet_sendCalls did not return a callsId");
  }

  // Capture the accepted batch before any status request can fail. NFT callers
  // persist this identity; a failed poll is not evidence of a failed submission.
  if (params.onSubmitted) {
    try {
      await params.onSubmitted({ callsId });
      // NFT state is durable now. One bounded read is enough; the caller can
      // resume confirmation in the background without keeping the card busy.
      return await getSponsoredCallsTransactionHash(params.provider, callsId);
    } catch (error) {
      if (error instanceof SponsoredCallsFailedError) throw error;
      throw new SponsoredCallsPendingError(callsId);
    }
  }

  // Score submission keeps its existing polling and error behavior.
  const timeoutMs = params.timeoutMs ?? 60_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    let status: any;
    try {
      status = await params.provider.request({
        method: "wallet_getCallsStatus",
        params: [callsId],
      });
    } catch (e) {
      if (methodUnsupported(e)) throw new Error("wallet_getCallsStatus not supported by this wallet");
      throw e;
    }

    const code = Number(status?.status ?? 0);
    // 100 = pending; 200 = success; 4xx/5xx/6xx = failures per Base docs.
    if (code === 100) {
      await sleep(1200);
      continue;
    }
    if (code === 200) {
      const receipts = status?.receipts ?? [];
      const txHash = receipts?.[0]?.transactionHash;
      if (!txHash) throw new Error("No transactionHash found in receipts");
      return txHash as `0x${string}`;
    }

    throw new Error(`Sponsored batch failed (status=${code})`);
  }

  throw new Error("Timed out waiting for sponsored transaction");
}
