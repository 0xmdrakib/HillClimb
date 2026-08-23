import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  readBodyWithLimit,
  requestTooLargeResponse,
  RequestBodyTooLargeError,
} from "@/lib/apiProtection";

// IMPORTANT:
// Keep the CDP paymaster/bundler URL (which contains your client key) server-side only.
// The frontend should only ever reference this proxy endpoint.
//
// This route forwards JSON-RPC requests to CDP, with a small allowlist to reduce abuse.

export const runtime = "nodejs";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
} as const;

const MAX_BODY_BYTES = 256 * 1024;
const POST_RATE_LIMIT = {
  name: "paymaster:post",
  ip: [
    { limit: 60, windowMs: 60_000 },
    { limit: 600, windowMs: 60 * 60_000 },
  ],
  global: [{ limit: 2_000, windowMs: 60_000 }],
  headers: corsHeaders,
} as const;
const OPTIONS_RATE_LIMIT = {
  name: "paymaster:options",
  ip: [{ limit: 120, windowMs: 60_000 }],
  global: [{ limit: 4_000, windowMs: 60_000 }],
  headers: corsHeaders,
} as const;

// Allow paymaster methods + a conservative set of bundler methods.
const ALLOWED_BUNDLER_METHODS = new Set([
  "eth_supportedEntryPoints",
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt",
  "eth_getUserOperationByHash",
  "eth_chainId",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_getUserOperationGasPrice",
]);

function isAllowedMethod(method: string) {
  if (method.startsWith("pm_")) return true;
  if (ALLOWED_BUNDLER_METHODS.has(method)) return true;
  return false;
}

export async function OPTIONS(req: Request) {
  const limited = enforceRateLimit(req, OPTIONS_RATE_LIMIT);
  if (limited) return limited;
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, POST_RATE_LIMIT);
  if (limited) return limited;

  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers: corsHeaders });
  }

  // Forward the request body as-is (JSON-RPC), but never buffer an unbounded payload.
  let bodyText: string;
  try {
    bodyText = await readBodyWithLimit(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestTooLargeResponse(error, corsHeaders);
    throw error;
  }

  // Validate methods to reduce abuse if this endpoint is discovered.
  try {
    const payload: any = JSON.parse(bodyText);
    const requests = Array.isArray(payload) ? payload : [payload];
    if (requests.length === 0 || requests.length > 10) {
      return NextResponse.json({ error: "JSON-RPC batch must contain 1-10 requests" }, { status: 400, headers: corsHeaders });
    }
    for (const r of requests) {
      const method = String(r?.method ?? "");
      if (!isAllowedMethod(method)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: corsHeaders });
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const upstream = (process.env.CDP_PAYMASTER_URL ?? "").trim();
  if (!upstream) {
    return NextResponse.json({ error: "Missing CDP_PAYMASTER_URL" }, { status: 500, headers: corsHeaders });
  }

  const upstreamRes = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyText,
  });

  const text = await upstreamRes.text();
  return new NextResponse(text, {
    status: upstreamRes.status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}
