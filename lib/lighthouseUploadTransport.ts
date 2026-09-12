import { Buffer } from "node:buffer";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export type LighthouseUploadFailureReason =
  | "invalid_request"
  | "encoding_error"
  | "http_status"
  | "stream_error"
  | "incomplete_response"
  | "response_too_large"
  | "timeout"
  | "network_error";

/** Safe to log: no upstream response, URL, credential, or raw error is retained. */
export class LighthouseUploadError extends Error {
  readonly reason: LighthouseUploadFailureReason;
  readonly statusCode?: number;

  constructor(reason: LighthouseUploadFailureReason, statusCode?: number) {
    super("lighthouse_upload_failed");
    this.name = reason === "timeout" ? "TimeoutError" : "LighthouseUploadError";
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

type LighthouseUploadOptions = {
  url: string;
  formData: FormData;
  apiKey: string;
  timeoutMs: number;
  maxResponseBytes?: number;
};

function hasStreamError(headers: IncomingHttpHeaders): boolean {
  const value = headers["x-stream-error"];
  return Array.isArray(value)
    ? value.some((item) => item.trim().length > 0)
    : typeof value === "string" && value.trim().length > 0;
}

/**
 * Upload-only Node transport. Kubo can report a late failure exclusively in
 * X-Stream-Error trailers; Fetch's Response does not expose those trailers.
 * The existing native FormData encoder still owns the exact multipart bytes.
 */
export async function uploadLighthouseForm({
  url,
  formData,
  apiKey,
  timeoutMs,
  maxResponseBytes = 64_000,
}: LighthouseUploadOptions): Promise<string> {
  let target: URL;
  try { target = new URL(url); }
  catch { throw new LighthouseUploadError("invalid_request"); }
  if (
    target.protocol !== "https:" || target.hostname !== "upload.lighthouse.storage" ||
    target.pathname !== "/api/v0/add" || target.username || target.password || target.port ||
    target.hash || !apiKey || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0
  ) throw new LighthouseUploadError("invalid_request");

  return new Promise<string>((resolve, reject) => {
    const deadlineAt = Date.now() + timeoutMs;
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    let finished = false;
    let responseBytes = 0;
    let chunks: Buffer[] = [];

    const fail = (reason: LighthouseUploadFailureReason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chunks = [];
      // Do not pass raw upstream errors into destroy(), reject(), or logs.
      incoming?.destroy();
      outgoing?.destroy();
      reject(new LighthouseUploadError(reason, incoming?.statusCode));
    };
    // One wall-clock budget covers encoding, connection, body, and trailers.
    const timer = setTimeout(() => fail("timeout"), timeoutMs);

    const send = async () => {
      let body: Buffer;
      let contentType: string | null;
      try {
        const encoded = new Response(formData);
        contentType = encoded.headers.get("content-type");
        body = Buffer.from(await encoded.arrayBuffer());
      } catch {
        fail("encoding_error");
        return;
      }
      if (finished) return;
      if (Date.now() >= deadlineAt) { fail("timeout"); return; }
      if (!contentType?.startsWith("multipart/form-data; boundary=")) {
        fail("encoding_error");
        return;
      }

      try {
        // node:https does not follow redirects or retry this POST. The caller's
        // CID/pinning query remains unchanged, with credentials sent only here.
        outgoing = httpsRequest(target, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "X-Storage-Type": "annual",
            "content-type": contentType,
            "content-length": String(body.byteLength),
          },
        }, (response) => {
          incoming = response;
          response.once("error", () => fail("incomplete_response"));
          response.once("aborted", () => fail("incomplete_response"));
          response.once("close", () => {
            if (!response.complete) fail("incomplete_response");
          });
          response.on("data", (chunk: Buffer) => {
            if (finished) return;
            responseBytes += chunk.byteLength;
            if (responseBytes > maxResponseBytes) { fail("response_too_large"); return; }
            chunks.push(chunk);
          });
          response.once("end", () => {
            if (finished) return;
            if (!response.complete) { fail("incomplete_response"); return; }
            // Merely declaring `Trailer: X-Stream-Error` is normal on success.
            // Only its actual nonempty value means the completed stream failed.
            if (hasStreamError(response.headers) || hasStreamError(response.trailers)) {
              fail("stream_error");
              return;
            }
            finished = true;
            clearTimeout(timer);
            const text = Buffer.concat(chunks, responseBytes).toString("utf8");
            chunks = [];
            resolve(text);
          });
          if (finished) { response.destroy(); return; }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            fail("http_status");
          } else if (hasStreamError(response.headers)) {
            fail("stream_error");
          }
        });
        outgoing.once("error", () => fail("network_error"));
        if (finished) { outgoing.destroy(); return; }
        outgoing.end(body);
      } catch {
        fail("network_error");
      }
    };
    void send().catch(() => fail("network_error"));
  });
}
