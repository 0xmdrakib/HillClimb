/**
 * Local-only transport regressions. The production TypeScript is transpiled
 * unchanged; node:https is replaced with node:http aimed at a loopback server
 * (or a controlled stream). No Lighthouse request, upload, or wallet is used.
 *
 * Run: node --test scripts/test-lighthouse-upload-transport.mjs
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(path.join(ROOT, "lib", "lighthouseUploadTransport.ts"), "utf8");
const COMPILED = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const UPLOAD_URL = "https://upload.lighthouse.storage/api/v0/add?cid-version=1&raw-leaves=true&chunker=size-1048576&pin=true&wrap-with-directory=false";
const SECRET = "test-only-private-key-never-echo";
const HASH_BODY = JSON.stringify({ Name: "run.jpg", Hash: "bafy-test-result" });

function makeForm() {
  const formData = new FormData();
  formData.append("file", new Blob([Uint8Array.of(0xff, 0xd8, 0x00, 0xfe, 0xff, 0xd9)], { type: "image/jpeg" }), "run.jpg");
  formData.append("file", new Blob(['{"name":"Jesse Hill Climb — 6m Run"}'], { type: "application/json" }), "metadata.json");
  return formData;
}

function loadTransport(request, ResponseCtor = Response) {
  const moduleRecord = { exports: {} };
  const context = vm.createContext({
    module: moduleRecord,
    exports: moduleRecord.exports,
    require: (id) => {
      if (id === "node:https") return { request };
      if (id === "node:buffer") return { Buffer };
      throw new Error(`Unexpected transport dependency: ${id}`);
    },
    Buffer, URL, Response: ResponseCtor, setTimeout, clearTimeout,
  });
  new vm.Script(COMPILED, { filename: "lighthouseUploadTransport.js" }).runInContext(context);
  return moduleRecord.exports.uploadLighthouseForm;
}

function options(overrides = {}) {
  return { url: UPLOAD_URL, formData: makeForm(), apiKey: SECRET, timeoutMs: 2_000, ...overrides };
}

function failure(reason, statusCode) {
  return (error) => {
    assert.equal(error.message, "lighthouse_upload_failed");
    assert.equal(error.reason, reason);
    assert.equal(error.name, reason === "timeout" ? "TimeoutError" : "LighthouseUploadError");
    assert.equal(error.statusCode, statusCode);
    assert.equal("cause" in error, false, "raw upstream errors must not be retained as causes");
    assert.ok(!JSON.stringify(error).includes(SECRET));
    assert.ok(!error.stack.includes(SECRET));
    return true;
  };
}

async function localTransport(t, handler, ResponseCtor) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const calls = [];
  const upload = loadTransport((url, init, callback) => {
    assert.equal(url.origin, "https://upload.lighthouse.storage");
    calls.push({ url: url.href, init });
    return http.request({
      ...init,
      hostname: "127.0.0.1",
      port: server.address().port,
      path: url.pathname + url.search,
    }, callback);
  }, ResponseCtor);
  return { upload, calls };
}

test("sends native multipart bytes, MIME, filenames, paid headers and CID query unchanged", async (t) => {
  let encoded;
  class RecordingResponse extends Response {
    constructor(body, init) {
      super(body, init);
      encoded = { type: this.headers.get("content-type"), bytes: this.clone().arrayBuffer() };
    }
  }
  let received;
  const { upload, calls } = await localTransport(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
    response.end(HASH_BODY);
  }, RecordingResponse);
  assert.equal(await upload(options()), HASH_BODY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, UPLOAD_URL);
  assert.equal(received.method, "POST");
  assert.equal(received.url, new URL(UPLOAD_URL).pathname + new URL(UPLOAD_URL).search);
  assert.equal(received.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(received.headers["x-storage-type"], "annual");
  assert.equal(received.headers["content-type"], encoded.type);
  assert.equal(Number(received.headers["content-length"]), received.body.byteLength);
  assert.deepEqual(received.body, Buffer.from(await encoded.bytes));
  const parsed = await new Response(received.body, { headers: { "content-type": encoded.type } }).formData();
  const files = parsed.getAll("file");
  assert.deepEqual(files.map((file) => [file.name, file.type]), [["run.jpg", "image/jpeg"], ["metadata.json", "application/json"]]);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), Buffer.from([0xff, 0xd8, 0x00, 0xfe, 0xff, 0xd9]));
  assert.equal(await files[1].text(), '{"name":"Jesse Hill Climb — 6m Run"}');
});

test("real HTTP trailers override an earlier successful Hash without leaking provider text", async (t) => {
  const { upload, calls } = await localTransport(t, (_request, response) => {
    response.writeHead(200, { Trailer: "X-Stream-Error" });
    response.write(HASH_BODY);
    response.addTrailers({ "X-Stream-Error": `provider failed with ${SECRET}` });
    response.end();
  });
  await assert.rejects(upload(options()), failure("stream_error", 200));
  assert.equal(calls.length, 1, "failed POST must not be retried");
});

test("a Trailer declaration alone, or an empty actual trailer, is valid", async (t) => {
  for (const includeEmpty of [false, true]) {
    await t.test(String(includeEmpty), async (t) => {
      const { upload } = await localTransport(t, (_request, response) => {
        response.writeHead(200, { Trailer: "X-Stream-Error" });
        response.write(HASH_BODY);
        if (includeEmpty) response.addTrailers({ "X-Stream-Error": "" });
        response.end();
      });
      assert.equal(await upload(options()), HASH_BODY);
    });
  }
});

test("an actual error in initial headers rejects even with a successful body", async (t) => {
  const { upload } = await localTransport(t, (_request, response) => {
    response.writeHead(200, { "X-Stream-Error": `private ${SECRET}` });
    response.end(HASH_BODY);
  });
  await assert.rejects(upload(options()), failure("stream_error", 200));
});

test("truncated chunked response after a Hash cannot count as completed upload", async (t) => {
  const { upload } = await localTransport(t, (_request, response) => {
    response.writeHead(200, { Trailer: "X-Stream-Error" });
    response.write(HASH_BODY);
    setImmediate(() => response.destroy());
  });
  await assert.rejects(upload(options()), failure("incomplete_response", 200));
});

test("response with an incomplete Content-Length rejects", async (t) => {
  const { upload } = await localTransport(t, (_request, response) => {
    response.writeHead(200, { "content-length": String(Buffer.byteLength(HASH_BODY) + 50) });
    response.write(HASH_BODY);
    setImmediate(() => response.destroy());
  });
  await assert.rejects(upload(options()), failure("incomplete_response", 200));
});

test("response size is bounded in bytes, including multi-byte text", async (t) => {
  const { upload } = await localTransport(t, (_request, response) => {
    response.end("ééé");
  });
  await assert.rejects(upload(options({ maxResponseBytes: 5 })), failure("response_too_large", 200));
});

test("response exactly at the configured byte bound succeeds", async (t) => {
  const { upload } = await localTransport(t, (_request, response) => response.end("ééé"));
  assert.equal(await upload(options({ maxResponseBytes: 6 })), "ééé");
});

test("absolute timeout includes waiting for headers", async (t) => {
  const { upload, calls } = await localTransport(t, () => {});
  await assert.rejects(upload(options({ timeoutMs: 100 })), failure("timeout"));
  assert.equal(calls.length, 1);
});

test("absolute timeout remains active after headers and a valid Hash until stream end", async (t) => {
  const { upload } = await localTransport(t, (_request, response) => {
    response.writeHead(200, { Trailer: "X-Stream-Error" });
    response.write(HASH_BODY);
  });
  await assert.rejects(upload(options({ timeoutMs: 100 })), failure("timeout", 200));
});

test("redirects and other non-2xx statuses fail without following or retrying", async (t) => {
  for (const status of [301, 302, 307, 308, 400, 402, 500]) {
    await t.test(String(status), async (t) => {
      const { upload, calls } = await localTransport(t, (_request, response) => {
        response.writeHead(status, { location: `https://other.example/${SECRET}` });
        response.end(HASH_BODY);
      });
      await assert.rejects(upload(options()), failure("http_status", status));
      assert.equal(calls.length, 1);
    });
  }
});

test("only the fixed HTTPS upload endpoint can receive credentials", async () => {
  let calls = 0;
  const upload = loadTransport(() => { calls += 1; throw new Error("must not request"); });
  for (const url of [
    "invalid", "http://upload.lighthouse.storage/api/v0/add", "https://other.example/api/v0/add",
    "https://upload.lighthouse.storage:444/api/v0/add", "https://upload.lighthouse.storage/wrong",
    "https://user:password@upload.lighthouse.storage/api/v0/add", `${UPLOAD_URL}#fragment`,
  ]) await assert.rejects(upload(options({ url })), failure("invalid_request"));
  assert.equal(calls, 0);
});

test("invalid timeout, size bounds and empty API key are rejected before requesting", async () => {
  let calls = 0;
  const upload = loadTransport(() => { calls += 1; throw new Error("must not request"); });
  for (const overrides of [
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 0.5 }, { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 },
    { maxResponseBytes: 0 }, { maxResponseBytes: -1 }, { maxResponseBytes: 0.5 }, { maxResponseBytes: Infinity }, { apiKey: "" },
  ]) await assert.rejects(upload(options(overrides)), failure("invalid_request"));
  assert.equal(calls, 0);
});

test("encoding errors are sanitized and cannot send a request", async () => {
  let calls = 0;
  class BrokenResponse extends Response {
    async arrayBuffer() { throw new Error(SECRET); }
  }
  const upload = loadTransport(() => { calls += 1; }, BrokenResponse);
  await assert.rejects(upload(options()), failure("encoding_error"));
  assert.equal(calls, 0);
});

test("encoding consumes the same absolute timeout and cannot send late bytes", async () => {
  let calls = 0;
  let release;
  class SlowResponse extends Response {
    async arrayBuffer() {
      await new Promise((resolve) => { release = resolve; });
      return super.arrayBuffer();
    }
  }
  const upload = loadTransport(() => { calls += 1; }, SlowResponse);
  await assert.rejects(upload(options({ timeoutMs: 30 })), failure("timeout"));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("synchronous request failures are sanitized", async () => {
  const upload = loadTransport(() => { throw new Error(`request failed: ${SECRET}`); });
  await assert.rejects(upload(options()), failure("network_error"));
});

function controlledTransport(emit) {
  const state = { outgoing: undefined, incoming: undefined };
  const upload = loadTransport((_url, _init, callback) => {
    const outgoing = new EventEmitter();
    outgoing.destroyed = false;
    outgoing.destroy = () => { outgoing.destroyed = true; };
    outgoing.end = () => queueMicrotask(() => emit({ outgoing, callback, state }));
    state.outgoing = outgoing;
    return outgoing;
  });
  return { upload, state };
}

function controlledResponse(callback, state, complete = false) {
  const incoming = new PassThrough();
  incoming.statusCode = 200;
  incoming.headers = {};
  incoming.trailers = {};
  incoming.complete = complete;
  state.incoming = incoming;
  callback(incoming);
  return incoming;
}

test("request error events cannot expose their raw error", async () => {
  const { upload, state } = controlledTransport(({ outgoing }) => outgoing.emit("error", new Error(SECRET)));
  await assert.rejects(upload(options()), failure("network_error"));
  assert.equal(state.outgoing.destroyed, true);
});

test("body error events reject and destroy both streams", async () => {
  const { upload, state } = controlledTransport(({ callback, state }) => {
    const response = controlledResponse(callback, state);
    response.write(HASH_BODY);
    response.emit("error", new Error(SECRET));
  });
  await assert.rejects(upload(options()), failure("incomplete_response", 200));
  assert.equal(state.outgoing.destroyed, true);
  assert.equal(state.incoming.destroyed, true);
});

test("end without HTTP message.complete cannot succeed", async () => {
  const { upload } = controlledTransport(({ callback, state }) => {
    controlledResponse(callback, state).end(HASH_BODY);
  });
  await assert.rejects(upload(options()), failure("incomplete_response", 200));
});

test("premature close without end cannot succeed", async () => {
  const { upload } = controlledTransport(({ callback, state }) => {
    controlledResponse(callback, state).destroy();
  });
  await assert.rejects(upload(options()), failure("incomplete_response", 200));
});

test("multiple response chunks share one size bound and destroy the request", async () => {
  const { upload, state } = controlledTransport(({ callback, state }) => {
    const response = controlledResponse(callback, state, true);
    response.write("abc");
    response.end("def");
  });
  await assert.rejects(upload(options({ maxResponseBytes: 5 })), failure("response_too_large", 200));
  assert.equal(state.outgoing.destroyed, true);
  assert.equal(state.incoming.destroyed, true);
});
