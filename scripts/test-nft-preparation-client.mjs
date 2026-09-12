/** Real preparation code and message formatter; only wallet/network are mocked. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = "https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs";
const ADDRESS = `0x${"a".repeat(40)}`;
const CONTRACT = `0x${"c".repeat(40)}`;
const ROOT_CID = `bafkrei${"a".repeat(52)}`;
const IMAGE_CID = `bafkrei${"b".repeat(52)}`;
const ORIGIN = "https://hillclimb.rakibhq.xyz";
const NOW = 1_800_000_000_000;
const NONCE = "ab".repeat(32);

function loadTs(relative, bindings, globals = {}) {
  const sourcePath = path.join(ROOT, relative);
  const result = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.deepEqual((result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error), []);
  const compiledModule = { exports: {} };
  vm.runInNewContext(result.outputText, {
    module: compiledModule, exports: compiledModule.exports,
    require(name) {
      assert.ok(Object.hasOwn(bindings, name), `Unexpected dependency: ${name}`);
      return bindings[name];
    },
    ...globals,
  }, { filename: sourcePath });
  return compiledModule.exports;
}

const { nftUploadMessage } = loadTs("lib/nftUploadMessage.ts", {});

function packageFixture() {
  return { rootCid: ROOT_CID, tokenUri: `${GATEWAY}/${ROOT_CID}`, carBase64: "local-car", carBytes: 10, imageBytes: 5 };
}

function createHarness(options = {}) {
  const state = { current: true, accountChecks: 0, signatures: [], requests: [], stages: [], now: NOW };
  const nftPackage = packageFixture();
  const wallet = { address: ADDRESS, provider: { request() { throw new Error("Unexpected real wallet call"); } } };
  const messageInput = {
    address: ADDRESS, rootCid: ROOT_CID, tokenUri: nftPackage.tokenUri,
    meters: 43, driverId: 1, origin: ORIGIN, contract: CONTRACT,
    nonce: NONCE, expiresAt: NOW + 300_000,
  };
  const challenge = {
    ok: true, challenge: "signed-server-challenge", nonce: NONCE,
    expiresAt: messageInput.expiresAt, message: nftUploadMessage(messageInput),
    ...options.challenge,
  };
  const prepared = {
    ok: true, availability: "verified", rootCid: ROOT_CID,
    tokenUri: nftPackage.tokenUri, metadataUrl: nftPackage.tokenUri,
    artworkUrl: `${GATEWAY}/${IMAGE_CID}`, verifiedAt: NOW, expiresAt: NOW + 60_000,
    ...options.prepared,
  };
  class Clock extends Date { static now() { return state.now; } }
  const exports = loadTs("lib/nftPreparation.ts", {
    "@/lib/nftGateway": { LIGHTHOUSE_DELIVERY_GATEWAY: GATEWAY },
    "@/lib/nftUploadMessage": { nftUploadMessage },
    "@/lib/onchain": {
      async assertNftWalletAccount(received) {
        assert.equal(received, wallet);
        state.accountChecks += 1;
        await options.onAccountCheck?.(state);
      },
      async signNftUploadMessage(message, received) {
        assert.equal(received, wallet);
        state.signatures.push(message);
        await options.onSign?.(state);
        return "0xsigned-upload-only";
      },
    },
  }, {
    Date: Clock, AbortSignal,
    async fetch(url, request) {
      const body = JSON.parse(request.body);
      state.requests.push({ url, request, body });
      await options.onFetch?.(url, state);
      const isChallenge = url === "/api/nft/challenge";
      assert.ok(isChallenge || url === "/api/nft/prepare", "Never call mint, RPC, recovery or an external host");
      return new Response(options.invalidJson ? "{" : JSON.stringify(isChallenge ? challenge : prepared), {
        status: isChallenge ? (options.challengeStatus ?? 200) : (options.prepareStatus ?? 200),
        headers: { "content-type": "application/json" },
      });
    },
  });
  const input = {
    nftPackage, wallet, contract: CONTRACT, meters: 43, driverId: 1, origin: ORIGIN,
    isCurrent: () => state.current,
    onStage: (stage) => state.stages.push(stage),
  };
  return { ...exports, state, input, messageInput, prepared, challenge };
}

async function rejectsBeforeUpload(harness, expected = /./) {
  await assert.rejects(harness.prepareRunNft(harness.input), expected);
  assert.equal(harness.state.requests.filter((r) => r.url === "/api/nft/prepare").length, 0);
}

test("preparation signs a locally constructed, exact run authorization before sending only its CAR", async () => {
  const h = createHarness();
  const result = await h.prepareRunNft(h.input);
  assert.equal(result.ok, true);
  assert.deepEqual(h.state.signatures, [nftUploadMessage(h.messageInput)]);
  assert.deepEqual(h.state.requests.map((r) => r.url), ["/api/nft/challenge", "/api/nft/prepare"]);
  assert.deepEqual(h.state.requests[0].body, {
    address: ADDRESS, rootCid: ROOT_CID, tokenUri: `${GATEWAY}/${ROOT_CID}`, meters: 43, driverId: 1,
  });
  assert.deepEqual(h.state.requests[1].body, {
    challenge: "signed-server-challenge", signature: "0xsigned-upload-only", carBase64: "local-car",
  });
  assert.equal(h.state.accountChecks, 2);
  for (const { request } of h.state.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.ok(request.signal instanceof AbortSignal);
  }
  assert.deepEqual(h.state.stages, ["Approve upload…", "Preparing NFT…"]);
});

test("authorization text explicitly explains canceled-mint storage and gives no spending approval", () => {
  const h = createHarness();
  const text = nftUploadMessage(h.messageInput);
  assert.match(text, /Files may remain stored if I cancel the later NFT mint/);
  assert.match(text, /does not authorize a transaction, NFT mint, transfer, or spending/);
  assert.match(text, /Network: Base \(8453\)/);
  assert.match(text, new RegExp(`Nonce: ${NONCE}`));
});

for (const [field, value] of [
  ["origin", "https://attacker.example"], ["address", `0x${"b".repeat(40)}`],
  ["contract", `0x${"d".repeat(40)}`], ["rootCid", IMAGE_CID],
  ["tokenUri", `https://attacker.example/${ROOT_CID}`], ["meters", 999],
  ["driverId", 2], ["nonce", "cd".repeat(32)], ["expiresAt", NOW + 200_000],
]) {
  test(`server challenge cannot change signed ${field}`, async () => {
    const h = createHarness();
    h.challenge.message = nftUploadMessage({ ...h.messageInput, [field]: value });
    await rejectsBeforeUpload(h, { reason: "invalid_upload_challenge" });
    assert.equal(h.state.signatures.length, 0);
  });
}

for (const [label, challenge] of [
  ["arbitrary signature text", { message: "Approve unlimited funds" }],
  ["missing nonce", { nonce: null }], ["malformed nonce", { nonce: "z".repeat(64) }],
  ["expired challenge", { expiresAt: NOW }], ["overlong expiry", { expiresAt: NOW + 306_000 }],
  ["fractional expiry", { expiresAt: NOW + 1.5 }], ["missing proof", { challenge: null }],
  ["oversized proof", { challenge: "x".repeat(8_001) }],
]) {
  test(`${label} cannot cause signature or upload`, async () => {
    const h = createHarness({ challenge });
    await rejectsBeforeUpload(h, { reason: "invalid_upload_challenge" });
    assert.equal(h.state.signatures.length, 0);
  });
}

for (const status of [202, 400, 401, 429, 500]) {
  test(`challenge HTTP ${status} cannot proceed despite a well-formed success-shaped body`, async () => {
    const h = createHarness({ challengeStatus: status });
    await rejectsBeforeUpload(h);
    assert.equal(h.state.signatures.length, 0);
  });
}

test("malformed challenge JSON never reaches signature", async () => {
  const h = createHarness({ invalidJson: true });
  await rejectsBeforeUpload(h);
  assert.equal(h.state.signatures.length, 0);
});

test("challenge HTTP 200 ok:false never reaches signature", async () => {
  const h = createHarness({ challenge: { ok: false, error: "rejected" } });
  await rejectsBeforeUpload(h);
  assert.equal(h.state.signatures.length, 0);
});

test("signature rejection stops before upload", async () => {
  const h = createHarness({ onSign() { throw Object.assign(new Error("User rejected"), { code: 4001 }); } });
  await rejectsBeforeUpload(h, { code: 4001 });
  assert.equal(h.state.signatures.length, 1);
});

for (const check of [1, 2]) {
  test(`wallet account changes at account check ${check} stop before upload`, async () => {
    const h = createHarness({ onAccountCheck(state) {
      if (state.accountChecks === check) throw new Error("NFT wallet account changed");
    } });
    await rejectsBeforeUpload(h, /account changed/);
    assert.equal(h.state.signatures.length, check - 1);
  });
}

for (const stage of ["before-start", "first-account", "challenge", "signature", "second-account", "prepare"]) {
  test(`new run during ${stage} rejects stale work without any later requests`, async () => {
    const h = createHarness({
      onAccountCheck(state) {
        if ((stage === "first-account" && state.accountChecks === 1)
          || (stage === "second-account" && state.accountChecks === 2)) state.current = false;
      },
      onSign(state) { if (stage === "signature") state.current = false; },
      onFetch(url, state) {
        if ((stage === "challenge" && url.endsWith("challenge"))
          || (stage === "prepare" && url.endsWith("prepare"))) state.current = false;
      },
    });
    if (stage === "before-start") h.state.current = false;
    await assert.rejects(h.prepareRunNft(h.input), { reason: "run_changed" });
    assert.equal(h.state.requests.filter((r) => r.url.endsWith("prepare")).length, stage === "prepare" ? 1 : 0);
    if (["before-start", "first-account", "challenge"].includes(stage)) assert.equal(h.state.signatures.length, 0);
  });
}

for (const status of [202, 400, 429, 500]) {
  test(`prepare HTTP ${status} cannot count as verified even with success-shaped JSON`, async () => {
    const h = createHarness({ prepareStatus: status });
    await assert.rejects(h.prepareRunNft(h.input));
    assert.equal(h.state.requests.length, 2);
  });
}

for (const [label, changes] of [
  ["ok:false", { ok: false }], ["unverified", { availability: "pending" }],
  ["wrong root CID", { rootCid: IMAGE_CID }], ["wrong token URI", { tokenUri: `${GATEWAY}/${IMAGE_CID}` }],
  ["wrong metadata host", { metadataUrl: `https://attacker.example/${ROOT_CID}` }],
  ["wrong image host", { artworkUrl: `https://attacker.example/${IMAGE_CID}` }],
  ["image URL query", { artworkUrl: `${GATEWAY}/${IMAGE_CID}?download=true` }],
  ["image URL path", { artworkUrl: `${GATEWAY}/${IMAGE_CID}/image.jpg` }],
  ["malformed image CID", { artworkUrl: `${GATEWAY}/not-a-cid` }],
  ["expired", { expiresAt: NOW }], ["stale verification", { verifiedAt: NOW - 60_001 }],
  ["future verification", { verifiedAt: NOW + 5_001 }],
  ["overlong validity", { expiresAt: NOW + 60_001 }],
  ["non-integer timestamp", { verifiedAt: NOW + 0.5 }], ["missing timestamp", { expiresAt: undefined }],
]) {
  test(`prepared response with ${label} cannot reach a usable mint preparation`, async () => {
    const h = createHarness({ prepared: changes });
    await assert.rejects(h.prepareRunNft(h.input), { reason: "unverified_or_expired_preparation" });
  });
}

test("preparation is checked again immediately before use and expires while the wallet waits", async () => {
  const h = createHarness();
  const result = await h.prepareRunNft(h.input);
  h.assertPreparedNft(result, h.input.nftPackage);
  h.state.now = NOW + 60_000;
  assert.throws(() => h.assertPreparedNft(result, h.input.nftPackage), { reason: "unverified_or_expired_preparation" });
});

test("network failure is sanitized and never retried as an upload or mint", async () => {
  const h = createHarness({ onFetch() { throw new Error("sensitive network detail"); } });
  await rejectsBeforeUpload(h, { reason: "storage_request_failed" });
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.signatures.length, 0);
});
