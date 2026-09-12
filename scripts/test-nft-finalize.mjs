/**
 * Hermetic regression tests for the real NFT finalizer route.
 *
 * The route and its local TypeScript dependencies are transpiled and executed
 * in a VM. CAR/CID construction plus RunMinted event encoding/decoding use the
 * real project libraries. Only network transport (Base receipt RPC,
 * Lighthouse uploads/gateways) and Next.js' `after()` hook are replaced.
 *
 * The tiny JPEG byte fixture below is intentionally only sufficient for the
 * route's archive-schema, dimension, CID, and byte-integrity validation. It is
 * not a rendered screenshot and these tests make no visual-quality claim.
 *
 * Run with: node --test scripts/test-nft-finalize.mjs
 */

import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import * as IpldCar from "@ipld/car";
import * as IpfsCar from "ipfs-car";
import * as UnixfsExporter from "ipfs-unixfs-exporter";
import * as MultiformatsCid from "multiformats/cid";
import * as MultiformatsSha2 from "multiformats/hashes/sha2";
import ts from "typescript";
import * as Viem from "viem";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE_PATH = path.join(PROJECT_ROOT, "app", "api", "nft", "finalize", "route.ts");
const CONTRACT = "0x1111111111111111111111111111111111111111";
const PLAYER = "0x2222222222222222222222222222222222222222";
const SITE_URL = "https://game.example";
const PAID_GATEWAY = "https://paid-test.lighthouseweb3.xyz/ipfs";
const PUBLIC_GATEWAY = "https://gateway.lighthouse.storage/ipfs";
const UPLOAD_URL = "https://upload.lighthouse.storage/api/v0/add";
const FileCtor = globalThis.File ?? NodeFile;

function transactionHash(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function syntheticJpeg(seed = 0) {
  const width = 960;
  const height = 540;
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
    seed & 0xff,
  ]);
}

async function collectBlocks(stream) {
  const blocks = [];
  await stream.pipeTo(new WritableStream({ write: (block) => blocks.push(block) }));
  assert.ok(blocks.length > 0, "fixture encoder must produce at least one block");
  return blocks;
}

async function encodeCar(blocks, roots) {
  const blockStream = new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(block);
      controller.close();
    },
  });
  const encoded = blockStream.pipeThrough(new IpfsCar.CAREncoderStream(roots));
  return new Uint8Array(await new Response(encoded).arrayBuffer());
}

async function encodeFile(bytes, name, type) {
  const file = new FileCtor([bytes], name, { type });
  const blocks = await collectBlocks(IpfsCar.createFileEncoderStream(file));
  return { blocks, cid: blocks.at(-1).cid.toString() };
}

async function buildFlatPackage({
  terrain,
  meters = 321,
  driverId = 0,
  tokenStyle = "paid",
  metadataTerrain = terrain,
  seed = 0,
}) {
  const imageBytes = syntheticJpeg(seed);
  const image = await encodeFile(imageBytes, "run.jpg", "image/jpeg");
  const imageUri = tokenStyle === "paid"
    ? `${PAID_GATEWAY}/${image.cid}`
    : `ipfs://${image.cid}`;
  const metadata = {
    name: `Jesse Hill Climb — ${meters}m Run`,
    description: "A hill-climb run captured at the finish on Base.",
    image: imageUri,
    external_url: SITE_URL,
    attributes: [
      { trait_type: "Distance", value: meters, display_type: "number" },
      { trait_type: "Driver", value: driverId === 0 ? "Jesse" : "Brian" },
      { trait_type: "Vehicle", value: "Jeep" },
      { trait_type: "Terrain", value: metadataTerrain },
      { trait_type: "Coins collected", value: 7, display_type: "number" },
      { trait_type: "Result", value: "Crash" },
    ],
    properties: {
      category: "image",
      files: [{ uri: `ipfs://${image.cid}`, type: "image/jpeg" }],
    },
  };
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const metadataFile = await encodeFile(metadataBytes, "metadata.json", "application/json");
  const carBytes = await encodeCar(
    [...metadataFile.blocks, ...image.blocks],
    [metadataFile.blocks.at(-1).cid, image.blocks.at(-1).cid],
  );
  const tokenUri = tokenStyle === "paid"
    ? `${PAID_GATEWAY}/${metadataFile.cid}`
    : `ipfs://${metadataFile.cid}`;
  return {
    carBase64: Buffer.from(carBytes).toString("base64"),
    carBytes,
    driverId,
    imageBytes,
    imageCid: image.cid,
    metadata,
    metadataBytes,
    meters,
    rootCid: metadataFile.cid,
    tokenUri,
  };
}

function createHarness() {
  const state = {
    afterTasks: [],
    gatewayMode: { paid: "exact", public: "unavailable" },
    gatewayMimeOverride: {},
    gatewayRequests: [],
    networkEvents: [],
    mismatchNextUpload: false,
    receipts: new Map(),
    uploaded: new Map(),
    uploadedTypes: new Map(),
    uploads: [],
  };

  const env = {
    BASE_RPC_URL: "https://rpc.example",
    LIGHTHOUSE_API_KEY: "test-lighthouse-key",
    NEXT_PUBLIC_LIGHTHOUSE_GATEWAY_URL: PAID_GATEWAY,
    NEXT_PUBLIC_RUNNFT_ADDRESS: CONTRACT,
    NEXT_PUBLIC_URL: SITE_URL,
    OPENSEA_API_KEY: "",
  };

  function gatewayResponse(url, init) {
    const gateway = url.startsWith(`${PUBLIC_GATEWAY}/`)
      ? "public"
      : url.startsWith(`${PAID_GATEWAY}/`)
        ? "paid"
        : null;
    if (!gateway) return null;
    state.gatewayRequests.push(url);
    state.networkEvents.push({ kind: "gateway", url, redirect: init.redirect });
    const mode = state.gatewayMode[gateway];
    const prefix = gateway === "public" ? `${PUBLIC_GATEWAY}/` : `${PAID_GATEWAY}/`;
    const key = url.slice(prefix.length);
    const bytes = state.uploaded.get(key);
    if (!bytes || mode === "unavailable") return new Response("missing", { status: 404 });
    const storedType = state.uploadedTypes.get(key);
    const type = state.gatewayMimeOverride[storedType] ?? storedType;
    const headers = { "content-type": type };
    if (mode === "redirect") {
      // Model fetch's redirect:error behavior. A caller that follows redirects
      // would receive valid bytes from an unapproved host and fail our tests.
      if (init.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
      return new Response(bytes, { status: 200, headers });
    }
    if (mode === "wrong") {
      const wrong = bytes.slice();
      wrong[0] ^= 0xff;
      return new Response(wrong, { status: 200, headers });
    }
    if (mode === "exact") return new Response(bytes, { status: 200, headers });
    throw new Error(`Unknown ${gateway} gateway mode: ${mode}`);
  }

  async function mockedFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(UPLOAD_URL)) {
      assert.equal(init.method, "POST");
      assert.ok(init.body instanceof FormData, "Lighthouse upload must use FormData");
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("cid-version"), "1");
      assert.equal(parsed.searchParams.get("raw-leaves"), "true");
      assert.equal(parsed.searchParams.get("chunker"), "size-1048576");
      assert.equal(parsed.searchParams.get("pin"), "true");
      assert.equal(parsed.searchParams.get("wrap-with-directory"), "false");
      const files = init.body.getAll("file");
      assert.equal(files.length, 1, "flat packages upload one immutable file per request");
      const file = files[0];
      state.networkEvents.push({ kind: "upload", name: file.name, redirect: init.redirect });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const encoded = await encodeFile(bytes, file.name, file.type);
      const headers = new Headers(init.headers);
      state.uploads.push({
        bytes,
        cid: encoded.cid,
        name: file.name,
        storageType: headers.get("x-storage-type"),
      });
      state.uploaded.set(encoded.cid, bytes);
      state.uploadedTypes.set(encoded.cid, file.type);
      let returnedCid = encoded.cid;
      if (state.mismatchNextUpload) {
        state.mismatchNextUpload = false;
        returnedCid = (await encodeFile(Uint8Array.from([9, 8, 7]), "other.bin", "application/octet-stream")).cid;
      }
      return Response.json({ Hash: returnedCid });
    }

    const gateway = gatewayResponse(url, init);
    if (gateway) return gateway;
    throw new Error(`Unexpected external fetch in hermetic test: ${url}`);
  }

  const externalModules = new Map([
    ["@ipld/car", IpldCar],
    ["ipfs-car", IpfsCar],
    ["ipfs-unixfs-exporter", UnixfsExporter],
    ["multiformats/cid", MultiformatsCid],
    ["multiformats/hashes/sha2", MultiformatsSha2],
    ["next/server", {
      NextResponse: { json: (body, init) => Response.json(body, init) },
      after: (task) => state.afterTasks.push(task),
    }],
    ["viem", {
      ...Viem,
      createPublicClient: () => ({
        getTransactionReceipt: async ({ hash }) => {
          const result = state.receipts.get(hash.toLowerCase());
          if (result instanceof Error) throw result;
          if (!result) throw new Error("transaction not found");
          return result;
        },
      }),
    }],
  ]);

  const context = vm.createContext({
    AbortSignal,
    Blob,
    Buffer,
    FormData,
    Headers,
    ReadableStream,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    TransformStream,
    URL,
    URLSearchParams,
    Uint8Array,
    WritableStream,
    clearTimeout,
    console,
    fetch: mockedFetch,
    process: { env },
    setTimeout: (callback, _delay, ...args) => setTimeout(callback, 0, ...args),
  });
  const moduleCache = new Map();

  function resolveLocalModule(specifier) {
    if (!specifier.startsWith("@/")) return null;
    const base = path.join(PROJECT_ROOT, specifier.slice(2));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* Try the next supported TypeScript path. */ }
    }
    throw new Error(`Cannot resolve project module ${specifier}`);
  }

  function loadTypeScriptModule(filename) {
    const resolved = path.resolve(filename);
    if (moduleCache.has(resolved)) return moduleCache.get(resolved).exports;
    const source = readFileSync(resolved, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: resolved,
      reportDiagnostics: true,
    });
    const errors = (output.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    assert.deepEqual(errors, [], `TypeScript transpilation failed for ${resolved}`);

    const moduleRecord = { exports: {} };
    moduleCache.set(resolved, moduleRecord);
    const localRequire = (specifier) => {
      if (externalModules.has(specifier)) return externalModules.get(specifier);
      const local = resolveLocalModule(specifier);
      if (local) return loadTypeScriptModule(local);
      throw new Error(`Unexpected module import in hermetic route test: ${specifier}`);
    };
    const wrapper = vm.runInContext(
      `(function (exports, require, module, __filename, __dirname) { ${output.outputText}\n})`,
      context,
      { filename: resolved },
    );
    wrapper(moduleRecord.exports, localRequire, moduleRecord, resolved, path.dirname(resolved));
    return moduleRecord.exports;
  }

  const route = loadTypeScriptModule(ROUTE_PATH);
  const { runNftAbi } = loadTypeScriptModule(path.join(PROJECT_ROOT, "lib", "onchainAbi.ts"));

  function reset() {
    state.afterTasks.length = 0;
    state.gatewayMode = { paid: "exact", public: "unavailable" };
    state.gatewayMimeOverride = {};
    state.gatewayRequests.length = 0;
    state.networkEvents.length = 0;
    state.mismatchNextUpload = false;
    state.receipts.clear();
    state.uploaded.clear();
    state.uploadedTypes.clear();
    state.uploads.length = 0;
  }

  function receiptFor(nftPackage, tokenId = 1n, status = "success") {
    if (status !== "success") return { status, logs: [] };
    const topics = Viem.encodeEventTopics({
      abi: runNftAbi,
      eventName: "RunMinted",
      args: { player: PLAYER, tokenId },
    });
    const data = Viem.encodeAbiParameters(
      [
        { name: "meters", type: "uint256" },
        { name: "driverId", type: "uint8" },
        { name: "tokenURI", type: "string" },
      ],
      [BigInt(nftPackage.meters), nftPackage.driverId, nftPackage.tokenUri],
    );
    return { status: "success", logs: [{ address: CONTRACT, data, topics }] };
  }

  let ipCounter = 1;
  async function invoke(nftPackage, txHash, { ip, retry = false } = {}) {
    const request = new Request(`${SITE_URL}/api/nft/finalize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: SITE_URL,
        "x-forwarded-host": "game.example",
        "x-vercel-forwarded-for": ip ?? `203.0.113.${ipCounter++}`,
      },
      body: JSON.stringify({
        txHash,
        rootCid: nftPackage.rootCid,
        tokenUri: nftPackage.tokenUri,
        carBase64: nftPackage.carBase64,
        retry,
      }),
    });
    const response = await route.POST(request);
    const body = await response.json();
    return { body, response };
  }

  return { invoke, receiptFor, reset, route, state };
}

const harness = createHarness();

test("NFT finalizer route hermetic regression suite", async (t) => {
  const maps = ["Countryside", "Desert", "Arctic", "Moon"];

  for (const [index, terrain] of maps.entries()) {
    await t.test(`valid paid-gateway flat package: ${terrain}`, async () => {
      harness.reset();
      const nftPackage = await buildFlatPackage({ terrain, meters: 300 + index, seed: index + 1 });
      const txHash = transactionHash(100 + index);
      harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, BigInt(index + 1)));

      const { body, response } = await harness.invoke(nftPackage, txHash);

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.alreadyStored, false);
      assert.equal(body.rootCid, nftPackage.rootCid);
      assert.equal(body.tokenUri, `${PAID_GATEWAY}/${nftPackage.rootCid}`);
      assert.equal(body.metadataUrl, `${PAID_GATEWAY}/${nftPackage.rootCid}`);
      assert.equal(body.artworkUrl, `${PAID_GATEWAY}/${nftPackage.imageCid}`);
      assert.deepEqual(harness.state.uploads.map((upload) => upload.name), ["run.jpg", "metadata.json"]);
      assert.deepEqual(harness.state.uploads.map((upload) => upload.cid), [nftPackage.imageCid, nftPackage.rootCid]);
      assert.deepEqual(
        harness.state.uploads.map((upload) => upload.storageType),
        ["annual", "annual"],
        "both artwork and metadata must use the paid Lighthouse storage plan",
      );
      assert.deepEqual(harness.state.uploads[0].bytes, nftPackage.imageBytes);
      assert.deepEqual(harness.state.uploads[1].bytes, nftPackage.metadataBytes);
      assert.deepEqual(
        harness.state.networkEvents.slice(0, 2).map(({ kind, name }) => ({ kind, name })),
        [{ kind: "upload", name: "run.jpg" }, { kind: "upload", name: "metadata.json" }],
        "a fresh finalization must store both files before its first paid gateway GET",
      );
      assert.ok(
        harness.state.networkEvents.every((event) => event.redirect === "error"),
        "upload and paid delivery requests must reject redirects",
      );
      assert.ok(harness.state.gatewayRequests.length > 0);
      assert.ok(harness.state.gatewayRequests.every((url) => url.startsWith(`${PAID_GATEWAY}/`)));
      assert.equal(harness.state.gatewayRequests.some((url) => url.startsWith(`${PUBLIC_GATEWAY}/`)), false);
    });
  }

  await t.test("explicit retry verifies exact paid files without uploading them again", async () => {
    harness.reset();
    const nftPackage = await buildFlatPackage({ terrain: "Desert", meters: 420, seed: 20 });
    const txHash = transactionHash(210);
    harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, 19n));
    harness.state.uploaded.set(nftPackage.imageCid, nftPackage.imageBytes);
    harness.state.uploaded.set(nftPackage.rootCid, nftPackage.metadataBytes);
    harness.state.uploadedTypes.set(nftPackage.imageCid, "image/jpeg");
    harness.state.uploadedTypes.set(nftPackage.rootCid, "application/json");

    const { body, response } = await harness.invoke(nftPackage, txHash, { retry: true });

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.alreadyStored, true);
    assert.equal(body.availability, "verified");
    assert.equal(harness.state.uploads.length, 0);
    assert.equal(harness.state.gatewayRequests.length, 2);
    assert.ok(harness.state.networkEvents.every((event) => event.kind === "gateway" && event.redirect === "error"));
  });

  await t.test("explicit retry uploads when its paid files are missing", async () => {
    harness.reset();
    const nftPackage = await buildFlatPackage({ terrain: "Moon", meters: 421, seed: 21 });
    const txHash = transactionHash(211);
    harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, 20n));

    const { body, response } = await harness.invoke(nftPackage, txHash, { retry: true });

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.alreadyStored, false);
    assert.deepEqual(harness.state.networkEvents.slice(0, 2).map((event) => event.kind), ["gateway", "gateway"]);
    assert.deepEqual(harness.state.uploads.map((upload) => upload.name), ["run.jpg", "metadata.json"]);
    assert.deepEqual(harness.state.uploads.map((upload) => upload.storageType), ["annual", "annual"]);
  });

  for (const [index, [fileType, wrongType]] of [
    ["application/json", "text/html"],
    ["image/jpeg", "image/png"],
    ["application/json", ""],
    ["image/jpeg", ""],
  ].entries()) {
    await t.test(`exact ${fileType} bytes served as ${wrongType || "missing MIME"} cannot report success`, async () => {
      harness.reset();
      const nftPackage = await buildFlatPackage({ terrain: maps[index], meters: 430 + index, seed: 22 + index });
      const txHash = transactionHash(212 + index);
      harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, BigInt(21 + index)));
      harness.state.gatewayMimeOverride[fileType] = wrongType;

      const { body, response } = await harness.invoke(nftPackage, txHash);

      assert.equal(response.status, 202);
      assert.deepEqual(body, { ok: false, pending: true, error: "nft_storage_pending" });
      assert.equal(harness.state.uploads.length, 2);
      assert.equal(harness.state.afterTasks.length, 0, "unverified content must not trigger marketplace finalization");
    });
  }

  await t.test("valid MIME parameters do not reject exact paid JSON and JPEG", async () => {
    harness.reset();
    const nftPackage = await buildFlatPackage({ terrain: "Countryside", meters: 435, seed: 27 });
    const txHash = transactionHash(217);
    harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, 26n));
    harness.state.gatewayMimeOverride = {
      "application/json": "application/json; charset=utf-8",
      "image/jpeg": "image/jpeg; charset=binary",
    };

    const { body, response } = await harness.invoke(nftPackage, txHash);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.availability, "verified");
  });

  await t.test("paid gateway redirects cannot make unapproved-host bytes verified", async () => {
    harness.reset();
    const nftPackage = await buildFlatPackage({ terrain: "Arctic", meters: 434, seed: 26 });
    const txHash = transactionHash(216);
    harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, 25n));
    harness.state.gatewayMode.paid = "redirect";

    const { body, response } = await harness.invoke(nftPackage, txHash);

    assert.equal(response.status, 202);
    assert.deepEqual(body, { ok: false, pending: true, error: "nft_storage_pending" });
    assert.equal(harness.state.uploads.length, 2);
    assert.ok(harness.state.gatewayRequests.length > 0);
    assert.ok(harness.state.networkEvents.every((event) => event.redirect === "error"));
    assert.equal(harness.state.afterTasks.length, 0);
  });

  await t.test("unconfirmed receipt returns pending and uploads nothing", async () => {
    harness.reset();
    const nftPackage = await buildFlatPackage({ terrain: "Countryside", seed: 10 });
    const txHash = transactionHash(200);
    harness.state.receipts.set(txHash, new Error("receipt unavailable"));

    const { body, response } = await harness.invoke(nftPackage, txHash);

    assert.equal(response.status, 202);
    assert.deepEqual(body, { ok: false, pending: true, error: "transaction_not_confirmed" });
    assert.equal(harness.state.uploads.length, 0);
    assert.equal(harness.state.gatewayRequests.length, 0);
  });

  await t.test("reverted receipt is terminal and uploads nothing", async () => {
    harness.reset();
    const nftPackage = await buildFlatPackage({ terrain: "Desert", seed: 11 });
    const txHash = transactionHash(201);
    harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, 10n, "reverted"));

    const { body, response } = await harness.invoke(nftPackage, txHash);

    assert.equal(response.status, 409);
    assert.equal(body.error, "transaction_failed");
    assert.equal(harness.state.uploads.length, 0);
  });

  await t.test("invalid metadata is rejected before upload", async () => {
    harness.reset();
    const nftPackage = await buildFlatPackage({
      terrain: "Countryside",
      metadataTerrain: "Volcano",
      seed: 12,
    });
    const txHash = transactionHash(202);
    harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, 11n));

    const { body, response } = await harness.invoke(nftPackage, txHash);

    assert.equal(response.status, 422);
    assert.equal(body.error, "invalid_car_archive");
    assert.equal(harness.state.uploads.length, 0);
  });

  await t.test("corrupted CAR is rejected before upload", async () => {
    harness.reset();
    const validPackage = await buildFlatPackage({ terrain: "Arctic", seed: 13 });
    const corrupted = validPackage.carBytes.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    const nftPackage = { ...validPackage, carBase64: Buffer.from(corrupted).toString("base64") };
    const txHash = transactionHash(203);
    harness.state.receipts.set(txHash, harness.receiptFor(validPackage, 12n));

    const { body, response } = await harness.invoke(nftPackage, txHash);

    assert.equal(response.status, 422);
    assert.equal(body.error, "invalid_car_archive");
    assert.equal(harness.state.uploads.length, 0);
  });

  await t.test("Lighthouse CID mismatch can never report success", async () => {
    harness.reset();
    const nftPackage = await buildFlatPackage({ terrain: "Moon", seed: 14 });
    const txHash = transactionHash(204);
    harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, 13n));
    harness.state.mismatchNextUpload = true;

    const { body, response } = await harness.invoke(nftPackage, txHash);

    assert.equal(response.status, 502);
    assert.equal(body.ok, undefined);
    assert.equal(body.error, "lighthouse_cid_mismatch");
    assert.deepEqual(harness.state.uploads.map((upload) => upload.name), ["run.jpg"]);
  });

  for (const mode of ["wrong", "unavailable"]) {
    await t.test(`${mode} paid-gateway bytes retain pending state`, async () => {
      harness.reset();
      const nftPackage = await buildFlatPackage({ terrain: "Countryside", seed: mode === "wrong" ? 15 : 16 });
      const txHash = transactionHash(mode === "wrong" ? 205 : 206);
      harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, mode === "wrong" ? 14n : 15n));
      harness.state.gatewayMode = { paid: mode, public: "exact" };

      const { body, response } = await harness.invoke(nftPackage, txHash);

      assert.equal(response.status, 202);
      assert.deepEqual(body, { ok: false, pending: true, error: "nft_storage_pending" });
      assert.deepEqual(harness.state.uploads.map((upload) => upload.name), ["run.jpg", "metadata.json"]);
      assert.deepEqual(harness.state.uploads.map((upload) => upload.storageType), ["annual", "annual"]);
      assert.deepEqual(
        harness.state.uploads.map((upload) => upload.cid),
        [nftPackage.imageCid, nftPackage.rootCid],
        "accepted upload CIDs must not count as success while paid delivery is unavailable",
      );
      assert.ok(harness.state.gatewayRequests.every((url) => url.startsWith(`${PAID_GATEWAY}/`)));
      assert.equal(harness.state.gatewayRequests.some((url) => url.startsWith(`${PUBLIC_GATEWAY}/`)), false);
    });
  }

  await t.test("compatible ipfs input cannot pass using public gateway bytes", async () => {
    harness.reset();
    const nftPackage = await buildFlatPackage({ terrain: "Desert", tokenStyle: "canonical", seed: 17 });
    const txHash = transactionHash(207);
    harness.state.receipts.set(txHash, harness.receiptFor(nftPackage, 16n));
    harness.state.gatewayMode = { paid: "unavailable", public: "exact" };

    const { body, response } = await harness.invoke(nftPackage, txHash);

    assert.equal(response.status, 202);
    assert.deepEqual(body, { ok: false, pending: true, error: "nft_storage_pending" });
    assert.ok(harness.state.gatewayRequests.length > 0);
    assert.ok(harness.state.gatewayRequests.every((url) => url.startsWith(`${PAID_GATEWAY}/`)));
    assert.equal(harness.state.gatewayRequests.some((url) => url.startsWith(`${PUBLIC_GATEWAY}/`)), false);
  });

  await t.test("per-transaction limiter throttles one tx without blocking a fresh tx", async () => {
    harness.reset();
    const first = await buildFlatPackage({ terrain: "Arctic", meters: 411, seed: 18 });
    const second = await buildFlatPackage({ terrain: "Moon", meters: 412, seed: 19 });
    const firstHash = transactionHash(208);
    const secondHash = transactionHash(209);
    const ip = "198.51.100.44";
    harness.state.receipts.set(firstHash, harness.receiptFor(first, 17n));
    harness.state.receipts.set(secondHash, harness.receiptFor(second, 18n));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { response } = await harness.invoke(first, firstHash, { ip, retry: attempt > 0 });
      assert.equal(response.status, 200, `same transaction attempt ${attempt + 1} should be allowed`);
    }
    const throttled = await harness.invoke(first, firstHash, { ip, retry: true });
    assert.equal(throttled.response.status, 429);
    assert.equal(throttled.body.error, "rate_limited");

    const fresh = await harness.invoke(second, secondHash, { ip });
    assert.equal(fresh.response.status, 200);
    assert.equal(fresh.body.ok, true);
  });
});
