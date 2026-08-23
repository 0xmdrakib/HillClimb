import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  readBodyWithLimit,
  readResponseWithLimit,
  requestTooLargeResponse,
  RequestBodyTooLargeError,
} from "@/lib/apiProtection";

export const runtime = "nodejs";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
} as const;

const MAX_BODY_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_SIZE = 20;

const POST_RATE_LIMIT = {
  name: "rpc:post",
  ip: [
    { limit: 120, windowMs: 60_000 },
    { limit: 2_000, windowMs: 60 * 60_000 },
  ],
  global: [{ limit: 5_000, windowMs: 60_000 }],
  headers: corsHeaders,
} as const;

const WRITE_RATE_LIMIT = {
  name: "rpc:send-raw-transaction",
  ip: [
    { limit: 12, windowMs: 60_000 },
    { limit: 120, windowMs: 60 * 60_000 },
  ],
  global: [{ limit: 500, windowMs: 60_000 }],
  headers: corsHeaders,
} as const;

const OPTIONS_RATE_LIMIT = {
  name: "rpc:options",
  ip: [{ limit: 180, windowMs: 60_000 }],
  global: [{ limit: 8_000, windowMs: 60_000 }],
  headers: corsHeaders,
} as const;

// No account, signing, debug, trace, admin, or filter-subscription methods.
const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_createAccessList",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
  "net_version",
  "web3_clientVersion",
]);

function getPrivateRpcUrl(): string | null {
  const value = (process.env.BASE_RPC_URL ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && isLocal)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseRpcPayload(text: string): { payload: unknown; requests: any[] } | null {
  try {
    const payload: any = JSON.parse(text);
    const requests = Array.isArray(payload) ? payload : [payload];
    if (requests.length === 0 || requests.length > MAX_BATCH_SIZE) return null;
    for (const request of requests) {
      if (!request || request.jsonrpc !== "2.0" || !ALLOWED_METHODS.has(String(request.method ?? ""))) return null;
      if (request.params !== undefined && !Array.isArray(request.params)) return null;
    }
    return { payload, requests };
  } catch {
    return null;
  }
}

export async function OPTIONS(request: Request) {
  const limited = enforceRateLimit(request, OPTIONS_RATE_LIMIT);
  if (limited) return limited;
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, POST_RATE_LIMIT);
  if (limited) return limited;

  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers: corsHeaders });
  }

  let bodyText: string;
  try {
    bodyText = await readBodyWithLimit(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestTooLargeResponse(error, corsHeaders);
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: corsHeaders });
  }

  const parsed = parseRpcPayload(bodyText);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid or forbidden JSON-RPC request" }, { status: 403, headers: corsHeaders });
  }

  if (parsed.requests.some((item) => item.method === "eth_sendRawTransaction")) {
    const writeLimited = enforceRateLimit(request, WRITE_RATE_LIMIT);
    if (writeLimited) return writeLimited;
  }

  const upstream = getPrivateRpcUrl();
  if (!upstream) {
    return NextResponse.json({ error: "Private RPC is unavailable" }, { status: 503, headers: corsHeaders });
  }

  try {
    const upstreamResponse = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.payload),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    let responseText: string;
    try {
      responseText = await readResponseWithLimit(upstreamResponse, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "RPC response exceeded safety limit" }, { status: 502, headers: corsHeaders });
      }
      throw error;
    }

    if (!upstreamResponse.ok) {
      return NextResponse.json({ error: "Private RPC request failed" }, { status: 502, headers: corsHeaders });
    }

    return new NextResponse(responseText, {
      status: 200,
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch {
    return NextResponse.json({ error: "Private RPC request failed" }, { status: 502, headers: corsHeaders });
  }
}
