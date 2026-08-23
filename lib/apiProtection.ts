type RateLimitRule = {
  limit: number;
  windowMs: number;
};

export type RateLimitPolicy = {
  name: string;
  ip: readonly RateLimitRule[];
  global?: readonly RateLimitRule[];
  headers?: HeadersInit;
};

type Bucket = {
  count: number;
  resetAt: number;
};

type RateLimitStore = {
  buckets: Map<string, Bucket>;
  checks: number;
};

declare global {
  // Reuse counters across warm Vercel invocations in the same function instance.
  // A distributed store would require external configuration, which this project avoids.
  var __jhcRateLimitStore: RateLimitStore | undefined;
}

const store = globalThis.__jhcRateLimitStore ??= {
  buckets: new Map<string, Bucket>(),
  checks: 0,
};

const MAX_BUCKETS = 10_000;
const TARGET_BUCKETS_AFTER_TRIM = 8_000;

// Published at https://www.cloudflare.com/ips-v4/ and /ips-v6/.
// Keeping the ranges in code avoids another runtime service or configuration dependency.
const CLOUDFLARE_CIDRS = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
] as const;

function cleanIp(value: string | null): string | null {
  if (!value) return null;
  let ip = value.split(",", 1)[0]?.trim() ?? "";
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  if (!ip || ip.length > 64 || !/^[0-9a-f:.]+$/i.test(ip)) return null;
  return ip.toLowerCase();
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let normalized = ip.toLowerCase().split("%", 1)[0];

  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = ipv4ToBigInt(normalized.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${Number((ipv4 >> 16n) & 0xffffn).toString(16)}:${Number(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8) return null;

  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(part, 16));
  }
  return value;
}

function ipToBigInt(ip: string): { value: bigint; bits: 32 | 128 } | null {
  const v4 = ipv4ToBigInt(ip);
  if (v4 !== null) return { value: v4, bits: 32 };
  const v6 = ipv6ToBigInt(ip);
  return v6 === null ? null : { value: v6, bits: 128 };
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [networkText, prefixText] = cidr.split("/");
  const address = ipToBigInt(ip);
  const network = ipToBigInt(networkText);
  const prefix = Number(prefixText);
  if (!address || !network || address.bits !== network.bits || !Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) return false;
  const shift = BigInt(address.bits - prefix);
  return (address.value >> shift) === (network.value >> shift);
}

function isCloudflareIp(ip: string): boolean {
  return CLOUDFLARE_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
}

/**
 * Resolve a stable visitor IP without trusting Cloudflare headers on direct
 * *.vercel.app requests, where a client could supply those headers itself.
 */
export function getClientIp(request: Request): string {
  const cloudflareIp = cleanIp(request.headers.get("cf-connecting-ip"));
  const hasCloudflareRay = Boolean(request.headers.get("cf-ray"));
  const vercelIp =
    cleanIp(request.headers.get("x-vercel-forwarded-for")) ??
    cleanIp(request.headers.get("x-forwarded-for")) ??
    cleanIp(request.headers.get("x-real-ip"));

  if (cloudflareIp && hasCloudflareRay && vercelIp && isCloudflareIp(vercelIp)) return cloudflareIp;
  return vercelIp ?? "unknown";
}

function trimStore(now: number) {
  store.checks += 1;
  if (store.checks % 256 !== 0 && store.buckets.size <= MAX_BUCKETS) return;

  for (const [key, bucket] of store.buckets) {
    if (bucket.resetAt <= now) store.buckets.delete(key);
  }

  if (store.buckets.size <= MAX_BUCKETS) return;

  for (const key of store.buckets.keys()) {
    // Preserve the small number of circuit-breaker buckets.
    if (key.includes("|global|")) continue;
    store.buckets.delete(key);
    if (store.buckets.size <= TARGET_BUCKETS_AFTER_TRIM) break;
  }
}

function consume(key: string, rule: RateLimitRule, now: number) {
  const current = store.buckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + rule.windowMs }
    : current;

  bucket.count += 1;
  store.buckets.set(key, bucket);

  return {
    allowed: bucket.count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

export function enforceRateLimit(request: Request, policy: RateLimitPolicy): Response | null {
  const now = Date.now();
  trimStore(now);

  const ip = getClientIp(request);
  const checks = [
    ...policy.ip.map((rule) => ({ scope: `ip:${ip}`, rule })),
    ...(policy.global ?? []).map((rule) => ({ scope: "global", rule })),
  ];

  let blocked: ReturnType<typeof consume> | null = null;
  for (const { scope, rule } of checks) {
    const key = `${policy.name}|${scope}|${rule.windowMs}`;
    const result = consume(key, rule, now);
    if (!result.allowed && (!blocked || result.resetAt > blocked.resetAt)) blocked = result;
  }

  if (!blocked) return null;

  const retryAfter = Math.max(1, Math.ceil((blocked.resetAt - now) / 1000));
  const headers = new Headers(policy.headers);
  headers.set("cache-control", "no-store");
  headers.set("retry-after", String(retryAfter));
  headers.set("x-ratelimit-limit", String(blocked.limit));
  headers.set("x-ratelimit-remaining", String(blocked.remaining));
  headers.set("x-ratelimit-reset", String(Math.ceil(blocked.resetAt / 1000)));

  return Response.json(
    { error: "rate_limited", retryAfter },
    { status: 429, headers },
  );
}

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

/** Read a request body without allowing an unbounded allocation. */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

export function requestTooLargeResponse(error: RequestBodyTooLargeError, headers?: HeadersInit) {
  return Response.json(
    { error: "payload_too_large", maxBytes: error.maxBytes },
    { status: 413, headers },
  );
}
