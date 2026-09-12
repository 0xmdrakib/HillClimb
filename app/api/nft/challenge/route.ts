import { NextResponse } from "next/server";
import { enforceRateLimit, RequestBodyTooLargeError } from "@/lib/apiProtection";
import {
  assertUploadOrigin,
  getUploadConfiguration,
  issueUploadChallenge,
  readUploadBody,
  UploadAuthorizationError,
} from "@/lib/nftUploadAuthorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;
const HEADERS = { "cache-control": "no-store" } as const;

export async function POST(request: Request) {
  const deadlineAt = Date.now() + 9_000;
  const limited = enforceRateLimit(request, {
    name: "nft:challenge:ingress",
    ip: [{ limit: 10, windowMs: 60_000 }, { limit: 40, windowMs: 3_600_000 }],
    global: [{ limit: 60, windowMs: 60_000 }, { limit: 360, windowMs: 3_600_000 }],
    headers: HEADERS,
  });
  if (limited) return limited;
  try {
    const config = getUploadConfiguration();
    assertUploadOrigin(request, config.origin);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new UploadAuthorizationError("content_type_must_be_json", 415);
    }
    const body = await readUploadBody(request, 4_096, deadlineAt);
    let input: unknown;
    try { input = JSON.parse(body); }
    catch { throw new UploadAuthorizationError("invalid_json", 400); }
    return NextResponse.json({ ok: true, ...issueUploadChallenge(input, config) }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413, headers: HEADERS });
    }
    const status = error instanceof UploadAuthorizationError ? error.status : 400;
    const code = error instanceof UploadAuthorizationError ? error.code : "invalid_request";
    return NextResponse.json({ error: code }, { status, headers: HEADERS });
  }
}
