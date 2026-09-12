/** Hermetic storage-before-mint tests: real routes, CAR/CIDs and EOA signatures.
 * Only network requests and Next response lifecycle hooks are replaced. No
 * Lighthouse request, wallet transaction, or external RPC can be sent here.
 * The tiny JPEG fixture checks headers/dimensions, not rendered image quality.
 */
import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import * as NodeCrypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as IpldCar from "@ipld/car";
import * as IpfsCar from "ipfs-car";
import * as UnixfsExporter from "ipfs-unixfs-exporter";
import * as MultiformatsCid from "multiformats/cid";
import * as MultiformatsSha2 from "multiformats/hashes/sha2";
import ts from "typescript";
import * as Viem from "viem";
import * as ViemChains from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://game.example";
const GATEWAY = "https://paid-test.lighthouseweb3.xyz/ipfs";
const CONTRACT = "0x1111111111111111111111111111111111111111";
// Publicly reproducible fixture keys only. Never use them for actual funds.
const PLAYER = privateKeyToAccount(`0x${"01".repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${"02".repeat(32)}`);
const FileCtor = globalThis.File ?? NodeFile;

function jpeg(width = 960, height = 540, seed = 0) {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9, seed & 0xff,
  ]);
}

async function fileBlocks(bytes, name, type) {
  const blocks = [];
  await IpfsCar.createFileEncoderStream(new FileCtor([bytes], name, { type }))
    .pipeTo(new WritableStream({ write: (block) => blocks.push(block) }));
  return { blocks, cid: blocks.at(-1).cid.toString() };
}

async function fixture({ terrain = "Countryside", meters = 321, driverId = 0,
  width = 960, height = 540, seed = 0, editMetadata = () => {} } = {}) {
  const imageBytes = jpeg(width, height, seed);
  const image = await fileBlocks(imageBytes, "run.jpg", "image/jpeg");
  const metadata = {
    name: `Jesse Hill Climb — ${meters}m Run`,
    description: "A hill-climb run captured at the finish on Base.",
    image: `${GATEWAY}/${image.cid}`,
    external_url: SITE,
    attributes: [
      { trait_type: "Distance", value: meters, display_type: "number" },
      { trait_type: "Driver", value: driverId === 0 ? "Jesse" : "Brian" },
      { trait_type: "Vehicle", value: "Jeep" },
      { trait_type: "Terrain", value: terrain },
      { trait_type: "Coins collected", value: 7, display_type: "number" },
      { trait_type: "Result", value: "Crash" },
    ],
    properties: { category: "image", files: [{ uri: `ipfs://${image.cid}`, type: "image/jpeg" }] },
  };
  editMetadata(metadata);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const meta = await fileBlocks(metadataBytes, "metadata.json", "application/json");
  const blocks = [...meta.blocks, ...image.blocks];
  const carStream = new ReadableStream({ start(controller) {
    blocks.forEach((block) => controller.enqueue(block));
    controller.close();
  } }).pipeThrough(new IpfsCar.CAREncoderStream([meta.blocks.at(-1).cid, image.blocks.at(-1).cid]));
  const carBytes = new Uint8Array(await new Response(carStream).arrayBuffer());
  return { rootCid: meta.cid, imageCid: image.cid, tokenUri: `${GATEWAY}/${meta.cid}`,
    carBase64: Buffer.from(carBytes).toString("base64"), carBytes, metadataBytes, imageBytes,
    meters, driverId, metadata };
}

function harness(envOverrides = {}) {
  const state = {
    now: Date.now(), uploads: [], gets: [], signatures: [], logs: [],
    stored: new Map(), modes: {}, mime: {}, uploadResponse: null, uploadFailure: null,
    signatureFailure: null, uploadGate: null, chainId: 8453,
    signatureGate: null, rpcOptions: [], timers: [], storageEvents: [],
  };
  const env = {
    LIGHTHOUSE_API_KEY: "test-only-lighthouse-secret-do-not-expose",
    NEXT_PUBLIC_RUNNFT_ADDRESS: CONTRACT, NEXT_PUBLIC_LIGHTHOUSE_GATEWAY_URL: GATEWAY,
    NEXT_PUBLIC_URL: SITE, BASE_RPC_URL: "https://rpc.example", OPENSEA_API_KEY: "",
    ...envOverrides,
  };
  class Clock extends Date { static now() { return state.now; } }
  class UploadError extends Error {
    constructor(reason, statusCode) {
      super("lighthouse_upload_failed");
      this.name = reason === "timeout" ? "TimeoutError" : "LighthouseUploadError";
      this.reason = reason;
      this.statusCode = statusCode;
    }
  }
  const networkFetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    assert.ok(url.startsWith(`${GATEWAY}/`), `Unexpected network request: ${url}`);
    assert.equal(init.redirect, "error", "paid delivery may never follow a redirect");
    assert.equal(init.method ?? "GET", "GET");
    state.gets.push(url);
    state.storageEvents.push({ method: "GET", url });
    const cid = url.slice(GATEWAY.length + 1);
    const entry = state.stored.get(cid);
    if (!entry || state.modes[entry.type] === "unavailable") return new Response("missing", { status: 404 });
    const mode = state.modes[entry.type];
    if (mode === "redirect") throw new TypeError("redirect blocked");
    let bytes = entry.bytes;
    if (mode === "wrong") { bytes = bytes.slice(); bytes[0] ^= 0xff; }
    const headers = { "content-type": state.mime[entry.type] ?? entry.type };
    return new Response(bytes, { status: 200, headers });
  };
  const modules = new Map([
    ["node:crypto", NodeCrypto], ["crypto", NodeCrypto], ["node:buffer", { Buffer }],
    ["@ipld/car", IpldCar], ["ipfs-car", IpfsCar], ["ipfs-unixfs-exporter", UnixfsExporter],
    ["multiformats/cid", MultiformatsCid], ["multiformats/hashes/sha2", MultiformatsSha2],
    ["viem/chains", ViemChains],
    ["viem", { ...Viem, http: (url, options) => {
      state.rpcOptions.push(options);
      return Viem.http(url, options);
    }, createPublicClient: () => ({
      getChainId: async () => state.chainId,
      verifyMessage: async (args) => {
        state.signatures.push(args);
        if (state.signatureFailure) throw new Error(state.signatureFailure);
        if (state.signatureGate) await state.signatureGate;
        return Viem.verifyMessage(args);
      },
      getTransactionReceipt: () => { throw new Error("Preparation must never require a mint transaction"); },
      readContract: () => { throw new Error("Unexpected contract RPC"); },
    }) }],
    ["next/server", { NextResponse: { json: (body, init) => Response.json(body, init) },
      after: () => { throw new Error("Preparation must not start marketplace writes"); } }],
    ["@/lib/lighthouseUploadTransport", {
      LighthouseUploadError: UploadError,
      uploadLighthouseForm: async ({ url, formData, apiKey, timeoutMs }) => {
        assert.equal(apiKey, env.LIGHTHOUSE_API_KEY);
        assert.ok(timeoutMs > 0 && timeoutMs <= 12_000);
        const parsed = new URL(url);
        assert.equal(parsed.origin, "https://upload.lighthouse.storage");
        assert.equal(parsed.pathname, "/api/v0/add");
        assert.equal(parsed.searchParams.get("cid-version"), "1");
        assert.equal(parsed.searchParams.get("raw-leaves"), "true");
        assert.equal(parsed.searchParams.get("chunker"), "size-1048576");
        assert.equal(parsed.searchParams.get("pin"), "true");
        assert.equal(parsed.searchParams.get("wrap-with-directory"), "false");
        const files = formData.getAll("file");
        assert.equal(files.length, 1);
        const file = files[0];
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { cid } = await fileBlocks(bytes, file.name, file.type);
        state.uploads.push({ name: file.name, type: file.type, bytes, cid });
        state.storageEvents.push({ method: "POST", name: file.name, cid });
        if (state.uploadGate) await state.uploadGate;
        if (state.uploadFailure) throw new UploadError(state.uploadFailure.reason, state.uploadFailure.statusCode);
        state.stored.set(cid, { bytes, type: file.type });
        return state.uploadResponse ? state.uploadResponse({ cid, name: file.name, bytes }) : JSON.stringify({ Hash: cid });
      },
    }],
  ]);
  const context = vm.createContext({
    AbortController, AbortSignal, Blob, Buffer, Date: Clock, Error, FormData, Headers, ReadableStream,
    Request, Response, TextDecoder, TextEncoder, TransformStream, URL, URLSearchParams,
    Uint8Array, WritableStream, crypto: NodeCrypto.webcrypto, clearTimeout,
    setTimeout: (callback, delay, ...args) => {
      state.timers.push(delay);
      return setTimeout(callback, 0, ...args);
    },
    fetch: networkFetch, process: { env },
    console: { warn: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args), log() {} },
  });
  const cache = new Map();
  function load(filename) {
    const full = path.resolve(filename);
    if (cache.has(full)) return cache.get(full).exports;
    const compiled = ts.transpileModule(readFileSync(full, "utf8"), { fileName: full,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const moduleRecord = { exports: {} };
    cache.set(full, moduleRecord);
    const require = (specifier) => {
      if (modules.has(specifier)) return modules.get(specifier);
      assert.ok(specifier.startsWith("@/") || specifier.startsWith("."), `Unexpected module: ${specifier}`);
      const base = specifier.startsWith("@/") ? path.join(ROOT, specifier.slice(2)) : path.resolve(path.dirname(full), specifier);
      const candidate = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((name) => {
        try { return statSync(name).isFile(); } catch { return false; }
      });
      assert.ok(candidate, `Missing local module: ${specifier}`);
      return load(candidate);
    };
    vm.runInContext(`(function(exports,require,module){${compiled}\n})`, context, { filename: full })(moduleRecord.exports, require, moduleRecord);
    return moduleRecord.exports;
  }
  const routes = {
    challenge: load(path.join(ROOT, "app/api/nft/challenge/route.ts")),
    prepare: load(path.join(ROOT, "app/api/nft/prepare/route.ts")),
  };
  async function invoke(which, body, { origin = SITE, requestOrigin = SITE, ip = "203.0.113.10", headers = {}, rawBody } = {}) {
    const requestHeaders = { "content-type": "application/json", origin,
      "x-forwarded-host": new URL(requestOrigin).host, "x-vercel-forwarded-for": ip, ...headers };
    if (origin === null) delete requestHeaders.origin;
    const response = await routes[which].POST(new Request(`${requestOrigin}/api/nft/${which}`, {
      method: "POST", headers: requestHeaders, body: rawBody ?? JSON.stringify(body),
      ...(rawBody ? { duplex: "half" } : {}),
    }));
    return { response, body: await response.json() };
  }
  async function authorize(pkg, { account = PLAYER, claims = {}, request = {} } = {}) {
    const challenge = await invoke("challenge", { address: account.address, rootCid: pkg.rootCid,
      tokenUri: pkg.tokenUri, meters: pkg.meters, driverId: pkg.driverId, ...claims }, request);
    assert.equal(challenge.response.status, 200, JSON.stringify(challenge.body));
    const signature = await account.signMessage({ message: challenge.body.message });
    return { challenge: challenge.body.challenge, signature, carBase64: pkg.carBase64, issued: challenge.body };
  }
  return { state, env, invoke, authorize,
    authorization: load(path.join(ROOT, "lib/nftUploadAuthorization.ts")) };
}

function noUpload(h) { assert.equal(h.state.uploads.length, 0); }
function notReady(result) {
  assert.notEqual(result.body.ok, true);
  assert.notEqual(result.body.availability, "verified");
  assert.equal(result.body.tokenUri, undefined);
}

test("preparation stores and verifies both exact paid files before returning ready on every map", async (t) => {
  for (const terrain of ["Countryside", "Desert", "Arctic", "Moon"]) await t.test(terrain, async () => {
    const h = harness();
    const pkg = await fixture({ terrain });
    const auth = await h.authorize(pkg);
    noUpload(h);
    const result = await h.invoke("prepare", auth);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    assert.equal(result.body.availability, "verified");
    assert.equal(result.body.rootCid, pkg.rootCid);
    assert.equal(result.body.tokenUri, pkg.tokenUri);
    assert.equal(result.body.metadataUrl, pkg.tokenUri);
    assert.equal(result.body.artworkUrl, `${GATEWAY}/${pkg.imageCid}`);
    assert.deepEqual(h.state.uploads.map((upload) => upload.name), ["run.jpg", "metadata.json"]);
    assert.deepEqual(h.state.uploads[0].bytes, pkg.imageBytes);
    assert.deepEqual(h.state.uploads[1].bytes, pkg.metadataBytes);
    assert.deepEqual(h.state.storageEvents.slice(0, 2).map(({ method, name }) => [method, name]),
      [["POST", "run.jpg"], ["POST", "metadata.json"]], "both files must upload before the first paid GET");
    assert.equal(h.state.storageEvents.findIndex((event) => event.method === "GET"), 2);
    assert.ok(h.state.gets.includes(pkg.tokenUri));
    assert.ok(h.state.gets.includes(`${GATEWAY}/${pkg.imageCid}`));
    assert.equal(h.state.signatures.length, 1);
    assert.ok(!JSON.stringify(result.body).includes(h.env.LIGHTHOUSE_API_KEY));
  });
});

test("challenge rejects foreign origin/request URL and invalid bound claims without uploads", async (t) => {
  const cases = [
    ["foreign origin", {}, { origin: "https://attacker.example" }],
    ["spoofed matching origin and host", {}, { origin: "https://attacker.example", requestOrigin: "https://attacker.example" }],
    ["missing origin", {}, { origin: null }],
    ["wrong request URL", {}, { requestOrigin: "https://attacker.example" }],
    ["invalid address", { address: "bad-address" }],
    ["wrong paid URI", { tokenUri: "https://attacker.example/metadata.json" }],
    ["negative distance", { meters: -1 }],
    ["out-of-range distance", { meters: 100_001 }],
    ["invalid driver", { driverId: 7 }],
  ];
  for (const [name, claims, options] of cases) await t.test(name, async () => {
    const h = harness();
    const pkg = await fixture();
    const result = await h.invoke("challenge", { address: PLAYER.address, rootCid: pkg.rootCid,
      tokenUri: pkg.tokenUri, meters: pkg.meters, driverId: pkg.driverId, ...claims }, options);
    assert.ok(result.response.status >= 400);
    notReady(result);
    noUpload(h);
  });
});

test("invalid signatures, altered HMACs, expiration and changed bindings never upload", async (t) => {
  for (const kind of ["other signer", "malformed signature", "tampered challenge", "expired", "foreign origin", "foreign contract", "rotated signing secret"]) {
    await t.test(kind, async () => {
      const h = harness();
      const pkg = await fixture();
      const auth = await h.authorize(pkg);
      let target = h;
      let options;
      if (kind === "other signer") auth.signature = await OTHER.signMessage({ message: auth.issued.message });
      if (kind === "malformed signature") auth.signature = "0x1234";
      if (kind === "tampered challenge") {
        const i = Math.floor(auth.challenge.length / 2);
        auth.challenge = auth.challenge.slice(0, i) + (auth.challenge[i] === "a" ? "b" : "a") + auth.challenge.slice(i + 1);
      }
      if (kind === "expired") h.state.now += 6 * 60_000;
      if (kind === "foreign origin") options = { origin: "https://attacker.example" };
      if (kind === "foreign contract") target = harness({ NEXT_PUBLIC_RUNNFT_ADDRESS: "0x3333333333333333333333333333333333333333" });
      if (kind === "rotated signing secret") target = harness({ LIGHTHOUSE_API_KEY: "different-test-only-key" });
      const result = await target.invoke("prepare", auth, options);
      assert.ok(result.response.status >= 400);
      notReady(result);
      noUpload(target);
    });
  }
});

test("signed claims still require exact CID-bound canonical landscape CAR validation", async (t) => {
  const cases = [
    ["square image", { width: 960, height: 960 }],
    ["portrait image", { width: 540, height: 960 }],
    ["wrong canonical name", { editMetadata: (meta) => { meta.name = "Jesse Hill Climb — fake"; } }],
    ["IPFS primary image instead of paid delivery", { editMetadata: (meta) => { meta.image = meta.properties.files[0].uri; } }],
    ["foreign external URL", { editMetadata: (meta) => { meta.external_url = "https://attacker.example"; } }],
    ["unknown terrain", { terrain: "Invented" }],
    ["hidden extra metadata payload", { editMetadata: (meta) => { meta.image_data = "unrelated payload"; } }],
  ];
  for (const [name, changes] of cases) await t.test(name, async () => {
    const h = harness();
    const pkg = await fixture(changes);
    const auth = await h.authorize(pkg);
    const result = await h.invoke("prepare", auth);
    assert.ok(result.response.status >= 400);
    notReady(result);
    noUpload(h);
  });
  await t.test("valid signature cannot substitute another package", async () => {
    const h = harness();
    const pkg = await fixture();
    const other = await fixture({ seed: 4 });
    const auth = await h.authorize(pkg);
    auth.carBase64 = other.carBase64;
    const result = await h.invoke("prepare", auth);
    assert.ok(result.response.status >= 400);
    notReady(result);
    noUpload(h);
  });
  await t.test("corrupt CAR block cannot pass matching root claims", async () => {
    const h = harness();
    const pkg = await fixture();
    const auth = await h.authorize(pkg);
    const bytes = pkg.carBytes.slice();
    bytes[bytes.length - 1] ^= 1;
    auth.carBase64 = Buffer.from(bytes).toString("base64");
    const result = await h.invoke("prepare", auth);
    assert.ok(result.response.status >= 400);
    notReady(result);
    noUpload(h);
  });
});

test("missing/wrong paid metadata or image never produces a ready-to-mint result", async (t) => {
  for (const type of ["application/json", "image/jpeg"]) {
    for (const mode of ["unavailable", "wrong", "redirect", "wrong MIME", "missing MIME"]) {
      await t.test(`${type}: ${mode}`, async () => {
        const h = harness();
        const pkg = await fixture();
        const auth = await h.authorize(pkg);
        if (mode === "wrong MIME") h.state.mime[type] = "text/html";
        else if (mode === "missing MIME") h.state.mime[type] = "";
        else h.state.modes[type] = mode;
        const result = await h.invoke("prepare", auth);
        notReady(result);
        assert.notEqual(result.response.status, 200);
        assert.equal(h.state.uploads.length, 2, "read-back verification follows the two authorized uploads");
        assert.ok(!JSON.stringify(result.body).includes(h.env.LIGHTHOUSE_API_KEY));
      });
    }
  }
});

test("provider upload errors cannot be presented as ready or leak details", async (t) => {
  for (const reason of ["timeout", "stream_error", "network_error", "incomplete_response", "http_status"]) {
    await t.test(reason, async () => {
      const h = harness();
      const pkg = await fixture();
      const auth = await h.authorize(pkg);
      h.state.uploadFailure = { reason, statusCode: reason === "http_status" ? 402 : 200 };
      const result = await h.invoke("prepare", auth);
      notReady(result);
      assert.notEqual(result.response.status, 200);
      assert.equal(h.state.uploads.length, 1);
      assert.equal(h.state.gets.length, 0, "a failed upload must not start readback");
      assert.ok(!JSON.stringify([result.body, h.state.logs]).includes(h.env.LIGHTHOUSE_API_KEY));
    });
  }
});

test("duplicates share one upload; fresh cached proof avoids writes until expiration", async () => {
  const h = harness();
  const pkg = await fixture();
  const auth = await h.authorize(pkg);
  let release;
  h.state.uploadGate = new Promise((resolve) => { release = resolve; });
  const first = h.invoke("prepare", auth);
  const second = h.invoke("prepare", auth);
  // Real crypto and CAR validation must have time to reach the held upload.
  for (let i = 0; i < 100 && h.state.uploads.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(h.state.uploads.length, 1);
  release();
  const results = await Promise.all([first, second]);
  results.forEach((result) => assert.equal(result.body.ok, true, JSON.stringify(result.body)));
  assert.equal(h.state.uploads.length, 2, "one image + one metadata upload for concurrent duplicate preparation");
  const again = await h.invoke("prepare", auth);
  assert.equal(again.body.ok, true);
  assert.equal(h.state.uploads.length, 2, "cached authorized proof must not repeat storage writes");
  assert.ok(again.body.expiresAt <= h.state.now + 60_000);
  h.state.now += 61_000;
  const readsBefore = h.state.gets.length;
  const reverified = await h.invoke("prepare", auth);
  assert.equal(reverified.body.ok, true, JSON.stringify(reverified.body));
  assert.ok(h.state.gets.length >= readsBefore + 2, "expired proof must re-check paid bytes");
  assert.equal(h.state.uploads.length, 4, "expired proof performs a new two-file upload and verification");
});

test("failed verification is not cached; retry uploads the same exact two files before readback", async () => {
  const h = harness();
  const pkg = await fixture();
  const auth = await h.authorize(pkg);
  h.state.modes["application/json"] = "unavailable";
  notReady(await h.invoke("prepare", auth));
  assert.equal(h.state.uploads.length, 2);
  h.state.modes["application/json"] = "exact";
  h.state.storageEvents.length = 0;
  const next = await h.invoke("prepare", auth);
  assert.equal(next.body.ok, true, JSON.stringify(next.body));
  assert.equal(h.state.uploads.length, 4);
  assert.deepEqual(h.state.uploads.slice(2).map(({ cid }) => cid), [pkg.imageCid, pkg.rootCid]);
  assert.deepEqual(h.state.storageEvents.slice(0, 2).map(({ method, name }) => [method, name]),
    [["POST", "run.jpg"], ["POST", "metadata.json"]]);
  assert.equal(h.state.storageEvents.findIndex((event) => event.method === "GET"), 2);
});

test("successful proof cache cannot bypass wallet authorization", async () => {
  const h = harness();
  const pkg = await fixture();
  const auth = await h.authorize(pkg);
  assert.equal((await h.invoke("prepare", auth)).body.ok, true);
  const forged = { ...auth, signature: await OTHER.signMessage({ message: auth.issued.message }) };
  const result = await h.invoke("prepare", forged);
  assert.ok(result.response.status >= 400);
  notReady(result);
  assert.equal(h.state.uploads.length, 2);
});

test("signature verifier failure is sanitized and fails closed before upload", async () => {
  const h = harness();
  const pkg = await fixture();
  const auth = await h.authorize(pkg);
  h.state.signatureFailure = `private RPC detail ${h.env.LIGHTHOUSE_API_KEY}`;
  const result = await h.invoke("prepare", auth);
  notReady(result);
  assert.ok(result.response.status >= 400);
  noUpload(h);
  assert.ok(!JSON.stringify([result.body, h.state.logs]).includes(h.env.LIGHTHOUSE_API_KEY));
});

test("upstream CID mismatch is not accepted as preparation success", async () => {
  const h = harness();
  const pkg = await fixture();
  const auth = await h.authorize(pkg);
  h.state.uploadResponse = () => JSON.stringify({ Hash: pkg.rootCid });
  const result = await h.invoke("prepare", auth);
  notReady(result);
  assert.ok(result.response.status >= 400);
  assert.equal(h.state.uploads.length, 1);
});

test("per-instance challenge limiter eventually blocks the same client without storing anything", async () => {
  const h = harness();
  const pkg = await fixture();
  let result;
  for (let i = 0; i < 100; i++) {
    result = await h.invoke("challenge", { address: PLAYER.address, rootCid: pkg.rootCid,
      tokenUri: pkg.tokenUri, meters: pkg.meters, driverId: pkg.driverId });
    if (result.response.status === 429) break;
  }
  assert.equal(result.response.status, 429);
  noUpload(h);
});

test("every signed challenge binding is HMAC-protected against individual alteration", async (t) => {
  const alterations = {
    address: OTHER.address,
    rootCid: (await fixture({ seed: 9 })).rootCid,
    tokenUri: "https://attacker.example/metadata.json",
    meters: 999,
    driverId: 1,
    origin: "https://attacker.example",
    contract: "0x3333333333333333333333333333333333333333",
    chainId: 1,
    nonce: "00".repeat(32),
    expiresAt: 9_999_999_999_999,
  };
  for (const [field, value] of Object.entries(alterations)) await t.test(field, async () => {
    const h = harness();
    const pkg = await fixture();
    const auth = await h.authorize(pkg);
    const [payload, mac] = auth.challenge.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded[field] = value;
    auth.challenge = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${mac}`;
    const result = await h.invoke("prepare", auth);
    assert.equal(result.response.status, 401);
    notReady(result);
    noUpload(h);
  });
});

test("incorrect RPC chain fails closed before preparation upload", async () => {
  const h = harness();
  const pkg = await fixture();
  const auth = await h.authorize(pkg);
  h.state.chainId = 1;
  const result = await h.invoke("prepare", auth);
  assert.equal(result.response.status, 503);
  notReady(result);
  noUpload(h);
});

test("wallet-wide quota cannot be reset just by changing caller IP or challenge", async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    const pkg = await fixture({ seed: i });
    const auth = await h.authorize(pkg);
    const result = await h.invoke("prepare", auth, { ip: `203.0.113.${20 + i}` });
    if (i < 4) assert.equal(result.body.ok, true, JSON.stringify(result.body));
    else {
      assert.equal(result.response.status, 429);
      notReady(result);
    }
  }
  assert.equal(h.state.uploads.length, 8);
});

test("stalled incoming bodies time out at five seconds and cancel their actual reader", async (t) => {
  for (const route of ["challenge", "prepare"]) await t.test(route, async () => {
    const h = harness();
    let cancelled = 0;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"incomplete":')); },
      cancel() {
        cancelled += 1;
        // An uncooperative source must not prevent timeout JSON from returning.
        return new Promise(() => {});
      },
    });
    const result = await h.invoke(route, null, { rawBody: stream });
    assert.equal(result.response.status, 408);
    assert.equal(result.body.error, "request_body_timeout");
    assert.equal(cancelled, 1, "the source, not only a wrapper promise, must be cancelled");
    assert.equal(stream.locked, false, "reader lock must be released on timeout");
    assert.ok(h.state.timers.includes(5_000));
    notReady(result);
    noUpload(h);
    assert.equal(h.state.signatures.length, 0);
  });
});

test("request body overflow cancels its actual source before authentication", async () => {
  const h = harness();
  let cancelled = 0;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4_097)); },
    cancel() { cancelled += 1; },
  });
  const result = await h.invoke("challenge", null, { rawBody: stream });
  assert.equal(result.response.status, 413);
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
  noUpload(h);
});

test("signature timeout is capped by remaining request budget and aborts RPC transport", async () => {
  const h = harness();
  const pkg = await fixture();
  const auth = await h.authorize(pkg);
  const config = h.authorization.getUploadConfiguration();
  const claims = h.authorization.verifyUploadChallenge(auth.challenge, config);
  let release;
  h.state.signatureGate = new Promise((resolve) => { release = resolve; });
  await assert.rejects(
    h.authorization.verifyUploadSignature(claims, auth.signature, config, h.state.now + 300),
    (error) => error.code === "upload_authorization_unavailable" && error.status === 503,
  );
  assert.equal(h.state.rpcOptions.at(-1).timeout, 50);
  assert.equal(h.state.rpcOptions.at(-1).fetchOptions.signal.aborted, true);
  assert.ok(h.state.timers.includes(50));
  release();
  noUpload(h);
});

test("exhausted absolute signature budget cannot create an RPC client", async () => {
  const h = harness();
  const pkg = await fixture();
  const auth = await h.authorize(pkg);
  const config = h.authorization.getUploadConfiguration();
  const claims = h.authorization.verifyUploadChallenge(auth.challenge, config);
  await assert.rejects(
    h.authorization.verifyUploadSignature(claims, auth.signature, config, h.state.now),
    (error) => error.code === "upload_authorization_unavailable" && error.status === 503,
  );
  assert.equal(h.state.rpcOptions.length, 0);
  assert.equal(h.state.signatures.length, 0);
  noUpload(h);
});
