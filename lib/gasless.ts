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
}): Promise<unknown> {
  // Try newer shape first (some wallets want this), then fall back to the simpler 1.0 style.
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
}): Promise<`0x${string}`> {
  const proxyUrl = paymasterProxyUrl();
  if (!proxyUrl) throw new Error("Missing NEXT_PUBLIC_PAYMASTER_PROXY_SERVER_URL");

  const callsIdRaw = await sendCalls({
    provider: params.provider,
    chainIdHex: params.chainIdHex,
    from: params.from,
    calls: params.calls.map((c) => ({ ...c, data: appendErc8021Suffix(c.data) })),
    paymasterProxyUrl: proxyUrl,
  });

  // Some wallets return the id directly as a string; others return an object.
  let callsId: unknown = callsIdRaw;
  if (typeof callsIdRaw !== "string" && callsIdRaw && typeof callsIdRaw === "object") {
    const obj = callsIdRaw as Record<string, unknown>;
    callsId = obj.id ?? obj.result ?? obj.callsId;
  }

  if (!callsId || typeof callsId !== "string") {
    throw new Error("wallet_sendCalls did not return a callsId");
  }

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
