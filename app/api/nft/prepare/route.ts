import { NextResponse } from "next/server";
import { enforceRateLimit, RequestBodyTooLargeError } from "@/lib/apiProtection";
import { LighthouseUploadError } from "@/lib/lighthouseUploadTransport";
import {
  base64ToBytes,
  isRecord,
  uploadFiles,
  validateArchive,
  waitForGatewayAssets,
} from "@/lib/nftStorage";
import {
  assertUploadOrigin,
  getUploadConfiguration,
  readUploadBody,
  singleFlightPreparation,
  UploadAuthorizationError,
  verifyUploadChallenge,
  verifyUploadSignature,
  type PreparedNft,
} from "@/lib/nftUploadAuthorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const HEADERS = { "cache-control": "no-store" } as const;
const PREPARE_DEADLINE_MS = 50_000;
const MAX_BODY_BYTES = 1_200_000;

export async function POST(request: Request) {
  const deadlineAt = Date.now() + PREPARE_DEADLINE_MS;
  const limited = enforceRateLimit(request, {
    name: "nft:prepare:ingress",
    ip: [{ limit: 8, windowMs: 60_000 }, { limit: 40, windowMs: 3_600_000 }],
    global: [{ limit: 30, windowMs: 60_000 }, { limit: 120, windowMs: 3_600_000 }],
    headers: HEADERS,
  });
  if (limited) return limited;
  try {
    const config = getUploadConfiguration();
    assertUploadOrigin(request, config.origin);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new UploadAuthorizationError("content_type_must_be_json", 415);
    }
    const bodyText = await readUploadBody(request, MAX_BODY_BYTES, deadlineAt);
    let body: unknown;
    try { body = JSON.parse(bodyText); }
    catch { throw new UploadAuthorizationError("invalid_json", 400); }
    if (!isRecord(body)) throw new UploadAuthorizationError("invalid_json", 400);
    const authorization = verifyUploadChallenge(body.challenge, config);
    const carBytes = typeof body.carBase64 === "string" ? base64ToBytes(body.carBase64) : null;
    if (!carBytes) throw new UploadAuthorizationError("invalid_or_oversized_car", 413);
    await verifyUploadSignature(authorization, body.signature, config, deadlineAt);
    // This bucket is wallet-wide, not keyed by caller IP or a fresh challenge.
    // Only a verified signer can consume it; counters are warm-instance limits.
    const walletLimited = enforceRateLimit(request, {
      name: `nft:prepare:wallet:${authorization.address.toLowerCase()}`,
      ip: [],
      global: [{ limit: 4, windowMs: 60_000 }, { limit: 12, windowMs: 3_600_000 }],
      headers: HEADERS,
    });
    if (walletLimited) return walletLimited;
    let archive: Awaited<ReturnType<typeof validateArchive>>;
    try {
      archive = await validateArchive(carBytes, authorization.rootCid, {
        meters: BigInt(authorization.meters),
        driverId: authorization.driverId,
        tokenURI: authorization.tokenUri,
      }, config.origin, { freshOnly: true });
    } catch { throw new UploadAuthorizationError("invalid_car_archive", 422); }

    const result = await singleFlightPreparation(authorization, async (): Promise<PreparedNft> => {
      const taskDeadline = Math.min(deadlineAt, authorization.expiresAt);
      let stage: "image" | "metadata" | "verification" = "image";
      try {
        // Keep the reference upload-before-probe sequence. A new attempt stores
        // both exact files before its first GET. Failed attempts may resubmit the
        // same content-addressed bytes; an accepted CID is not a storage proof.
        await uploadFiles(config.apiKey, [{ bytes: archive.imageBytes, name: "run.jpg", type: "image/jpeg" }], archive.imageCid, false, taskDeadline);
        stage = "metadata";
        await uploadFiles(config.apiKey, [{ bytes: archive.metadataBytes, name: "metadata.json", type: "application/json" }], authorization.rootCid, false, taskDeadline);
        stage = "verification";
        // Probe BOTH again after the upload. A provider Hash or one readable
        // file alone can never authorize the frontend to open the mint wallet.
        const assets = await waitForGatewayAssets(
          archive.deliveryGateway, archive.metadataPath, archive.imageCid,
          archive.metadataBytes, archive.imageBytes, [0, 500, 1_000, 2_000], taskDeadline,
        );
        if (!assets) throw new UploadAuthorizationError("nft_storage_unavailable", 503);
        const verifiedAt = Date.now();
        const expiresAt = Math.min(verifiedAt + 60_000, authorization.expiresAt);
        if (expiresAt <= verifiedAt || verifiedAt >= taskDeadline) {
          throw new UploadAuthorizationError("upload_authorization_expired", 401);
        }
        return {
          ok: true,
          availability: "verified",
          rootCid: authorization.rootCid,
          tokenUri: authorization.tokenUri,
          ...assets,
          verifiedAt,
          expiresAt,
        };
      } catch (error) {
        console.warn("nft_prepare_failed", {
          stage,
          metadataCid: authorization.rootCid,
          imageCid: archive.imageCid,
          reason: error instanceof LighthouseUploadError ? error.reason
            : error instanceof UploadAuthorizationError ? error.code
              : error instanceof Error && ["invalid_lighthouse_response", "lighthouse_cid_mismatch", "finalize_deadline"].includes(error.message)
                ? error.message : "storage_error",
          ...(error instanceof LighthouseUploadError && error.statusCode ? { statusCode: error.statusCode } : {}),
        });
        if (error instanceof UploadAuthorizationError) throw error;
        throw new UploadAuthorizationError("nft_storage_unavailable", 503);
      }
    });
    return NextResponse.json(result, { headers: HEADERS });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413, headers: HEADERS });
    }
    const status = error instanceof UploadAuthorizationError ? error.status : 503;
    const code = error instanceof UploadAuthorizationError ? error.code : "nft_storage_unavailable";
    // No partial state, upstream text, or ready-to-mint proof leaks on failure.
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
