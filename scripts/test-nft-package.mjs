/**
 * Hermetic regression test for the real browser-side NFT package builder.
 *
 * lib/nftPackage.ts and its local gateway dependency are transpiled and run in
 * a VM. CAR/CID/UnixFS work uses the project's real libraries. Only browser
 * image decoding and canvas JPEG encoding are mocked, so this verifies sizing,
 * draw geometry, encoding options, archive contents, and URLs—not subjective
 * visual quality or browser-specific JPEG output.
 *
 * Run with: node --test scripts/test-nft-package.mjs
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
import ts from "typescript";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = path.join(PROJECT_ROOT, "lib", "nftPackage.ts");
const PAID_GATEWAY = "https://paid-delivery.example/ipfs";
const FileCtor = globalThis.File ?? NodeFile;
const MAPS = ["Countryside", "Desert", "Arctic", "Moon"];

// It only needs to be deterministic JPEG-shaped output for UnixFS/CAR checks.
// Browser codec fidelity is deliberately outside this hermetic test's scope.
const JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08,
  0x02, 0x1c, // 540px
  0x03, 0xc0, // 960px
  0x03,
  0x01, 0x11, 0x00,
  0x02, 0x11, 0x00,
  0x03, 0x11, 0x00,
  0xff, 0xd9,
]);

function createHarness() {
  const state = {
    canvases: [],
    dataFetches: [],
    httpRequests: [],
    objectUrlsCreated: [],
    objectUrlsRevoked: [],
  };

  class MockUrl extends URL {
    static createObjectURL(blob) {
      assert.ok(blob instanceof Blob);
      const value = `blob:local-nft-test-${state.objectUrlsCreated.length + 1}`;
      state.objectUrlsCreated.push(value);
      return value;
    }

    static revokeObjectURL(value) {
      state.objectUrlsRevoked.push(value);
    }
  }

  class MockImage {
    constructor() {
      this.naturalWidth = 1920;
      this.naturalHeight = 1080;
      this.onload = null;
      this.onerror = null;
      this._src = "";
    }

    set src(value) {
      this._src = value;
      this.onload?.();
    }

    get src() {
      return this._src;
    }
  }

  const document = {
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      const record = {
        alpha: null,
        clearCalls: [],
        drawCalls: [],
        fillCalls: [],
        height: 0,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        mimeType: null,
        quality: null,
        width: 0,
      };
      const context = {
        get imageSmoothingEnabled() { return record.imageSmoothingEnabled; },
        set imageSmoothingEnabled(value) { record.imageSmoothingEnabled = value; },
        get imageSmoothingQuality() { return record.imageSmoothingQuality; },
        set imageSmoothingQuality(value) { record.imageSmoothingQuality = value; },
        clearRect(...args) { record.clearCalls.push(args); },
        drawImage(...args) { record.drawCalls.push(args); },
        fillRect(...args) { record.fillCalls.push(args); },
      };
      const canvas = {
        get width() { return record.width; },
        set width(value) { record.width = value; },
        get height() { return record.height; },
        set height(value) { record.height = value; },
        getContext(kind, options) {
          assert.equal(kind, "2d");
          record.alpha = options?.alpha;
          return context;
        },
        toBlob(callback, mimeType, quality) {
          record.mimeType = mimeType;
          record.quality = quality;
          callback(new Blob([JPEG_BYTES], { type: mimeType }));
        },
      };
      state.canvases.push(record);
      return canvas;
    },
  };

  async function mockedFetch(input) {
    const url = typeof input === "string" ? input : input.url;
    if (/^https?:/i.test(url)) {
      state.httpRequests.push(url);
      throw new Error(`NFT package creation attempted a network request: ${url}`);
    }
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!match) throw new Error(`Unexpected fetch in NFT package test: ${url}`);
    const bytes = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    state.dataFetches.push(url);
    return new Response(bytes, {
      headers: { "content-type": match[1] || "application/octet-stream" },
    });
  }

  const externalModules = new Map([["ipfs-car", IpfsCar]]);
  const context = vm.createContext({
    Blob,
    Buffer,
    File: FileCtor,
    Image: MockImage,
    ReadableStream,
    Response,
    TextDecoder,
    TextEncoder,
    URL: MockUrl,
    Uint8Array,
    WritableStream,
    btoa: (binary) => Buffer.from(binary, "binary").toString("base64"),
    console,
    document,
    fetch: mockedFetch,
    process: {
      env: { NEXT_PUBLIC_LIGHTHOUSE_GATEWAY_URL: PAID_GATEWAY },
    },
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
    const errors = (output.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    assert.deepEqual(errors, [], `TypeScript transpilation failed for ${resolved}`);

    const moduleRecord = { exports: {} };
    moduleCache.set(resolved, moduleRecord);
    const localRequire = (specifier) => {
      if (externalModules.has(specifier)) return externalModules.get(specifier);
      const local = resolveLocalModule(specifier);
      if (local) return loadTypeScriptModule(local);
      throw new Error(`Unexpected module import in hermetic package test: ${specifier}`);
    };
    const wrapper = vm.runInContext(
      `(function (exports, require, module, __filename, __dirname) { ${output.outputText}\n})`,
      context,
      { filename: resolved },
    );
    wrapper(moduleRecord.exports, localRequire, moduleRecord, resolved, path.dirname(resolved));
    return moduleRecord.exports;
  }

  return {
    buildRunNftPackage: loadTypeScriptModule(PACKAGE_PATH).buildRunNftPackage,
    state,
  };
}

async function readUnixfsFile(reader, cid) {
  const blockstore = {
    async get(key) {
      const block = await reader.get(key);
      if (!block) throw new Error(`Missing CAR block ${key}`);
      return block.bytes;
    },
  };
  const entry = await UnixfsExporter.exporter(cid, blockstore);
  assert.ok(entry.type === "file" || entry.type === "raw");
  const chunks = [];
  for await (const chunk of entry.content()) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

function attribute(metadata, trait) {
  return metadata.attributes.find((item) => item.trait_type === trait)?.value;
}

const harness = createHarness();

test("actual NFT package builder emits paid URLs, canonical provenance, and uncropped 16:9 JPEGs", async (t) => {
  const snapshot = `data:image/png;base64,${Buffer.from("local-only-snapshot").toString("base64")}`;

  for (const [index, terrain] of MAPS.entries()) {
    await t.test(terrain, async () => {
      const canvasIndex = harness.state.canvases.length;
      const result = await harness.buildRunNftPackage({
        snapshotDataUrl: snapshot,
        meters: 100.9 + index,
        coins: 5.8 + index,
        driver: index % 2 ? "Brian" : "Jesse",
        vehicle: "Jeep",
        terrain,
        result: index === 3 ? "Out of fuel" : "Crash",
        siteUrl: "https://game.example",
      });

      const carBytes = new Uint8Array(Buffer.from(result.carBase64, "base64"));
      assert.equal(result.carBytes, carBytes.byteLength);
      const reader = await IpldCar.CarReader.fromBytes(carBytes);
      const roots = await reader.getRoots();
      assert.equal(roots.length, 2);
      assert.equal(roots[0].toString(), result.rootCid);
      const imageCid = roots[1].toString();

      const metadataBytes = await readUnixfsFile(reader, roots[0]);
      const imageBytes = await readUnixfsFile(reader, roots[1]);
      const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));

      assert.equal(result.tokenUri, `${PAID_GATEWAY}/${result.rootCid}`);
      assert.equal(metadata.image, `${PAID_GATEWAY}/${imageCid}`);
      assert.deepEqual(metadata.properties.files, [
        { uri: `ipfs://${imageCid}`, type: "image/jpeg" },
      ]);
      assert.equal(attribute(metadata, "Terrain"), terrain);
      assert.equal(attribute(metadata, "Distance"), 100 + index);
      assert.equal(attribute(metadata, "Coins collected"), 5 + index);
      assert.deepEqual(imageBytes, JPEG_BYTES);
      assert.equal(result.imageBytes, JPEG_BYTES.byteLength);

      const canvas = harness.state.canvases[canvasIndex];
      assert.ok(canvas, "package builder must create one canvas");
      assert.equal(harness.state.canvases.length, canvasIndex + 1);
      assert.equal(canvas.width, 960);
      assert.equal(canvas.height, 540);
      assert.equal(canvas.alpha, false);
      assert.equal(canvas.imageSmoothingEnabled, true);
      assert.equal(canvas.imageSmoothingQuality, "high");
      assert.equal(canvas.mimeType, "image/jpeg");
      assert.equal(canvas.quality, 0.9);
      assert.equal(canvas.drawCalls.length, 1);
      assert.equal(canvas.drawCalls[0].length, 5, "five-argument drawImage preserves the full frame");
      assert.deepEqual(canvas.drawCalls[0].slice(1), [0, 0, 960, 540]);
      assert.equal(canvas.fillCalls.length, 0, "16:9 source must not receive padding");
      assert.equal(canvas.clearCalls.length, 0);
    });
  }

  assert.equal(harness.state.dataFetches.length, MAPS.length);
  assert.equal(harness.state.httpRequests.length, 0, "local package creation must perform zero uploads");
  assert.deepEqual(harness.state.objectUrlsRevoked, harness.state.objectUrlsCreated);
});
