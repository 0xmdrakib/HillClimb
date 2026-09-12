import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { isAddress } from "viem";

import ts from "typescript";

const pagePath = path.resolve(process.cwd(), "app/page.tsx");
const pageSource = fs.readFileSync(pagePath, "utf8");
const sourceFile = ts.createSourceFile(
  pagePath,
  pageSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function findPageFunction() {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "Page") return statement;
  }
  throw new Error("Could not find Page() in app/page.tsx");
}

function extractMintImplementation() {
  const page = findPageFunction();
  assert.ok(page.body, "Page() must have a body");

  const targets = new Set([
    "resetRunMint",
    "silentlyVerifyMint",
    "finalizeMintStorage",
    "onMintNft",
  ]);
  const found = new Map();
  let startupEffect = null;

  for (const statement of page.body.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && targets.has(statement.name.text)) {
      found.set(statement.name.text, statement);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && targets.has(declaration.name.text)) {
          found.set(declaration.name.text, statement);
        }
      }
      continue;
    }

    if (
      ts.isExpressionStatement(statement)
      && ts.isCallExpression(statement.expression)
      && ts.isIdentifier(statement.expression.expression)
      && statement.expression.expression.text === "useEffect"
      && statement.getText(sourceFile).includes("loadPendingRunMints")
    ) {
      startupEffect = statement.expression.arguments[0]?.getText(sourceFile) ?? null;
    }
  }

  for (const target of targets) {
    assert.ok(found.has(target), `Could not extract Page.${target} from app/page.tsx`);
  }
  assert.ok(startupEffect, "Could not extract the pending-mint startup effect from app/page.tsx");

  const declarations = [...new Set(found.values())]
    .sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile))
    .map((node) => node.getText(sourceFile))
    .join("\n\n");

  const transpiled = ts.transpileModule(
    `${declarations}\nconst __startupEffect = ${startupEffect};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
      fileName: pagePath,
      reportDiagnostics: true,
    },
  );
  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(
    errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    [],
    "Extracted mint implementation must transpile",
  );

  const factorySource = `
    (function makeMintFlow(bindings) {
      with (bindings) {
        ${transpiled.outputText}
        return {
          resetRunMint,
          silentlyVerifyMint,
          finalizeMintStorage,
          onMintNft,
          startupEffect: __startupEffect,
        };
      }
    })
  `;
  return vm.runInNewContext(factorySource, {}, { filename: "page-mint-flow.vm.js" });
}

const makeMintFlow = extractMintImplementation();

const LIGHTHOUSE_DELIVERY_GATEWAY = "https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs";
const TX_A = "0x" + "a".repeat(64);
const TX_B = "0x" + "b".repeat(64);
class TransactionRevertedError extends Error {}
class NftPreparationError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
function nftPackage(label = "current") {
  const rootCid = "bafkrei" + label.padEnd(53, "a");
  return { rootCid, tokenUri: LIGHTHOUSE_DELIVERY_GATEWAY + "/" + rootCid, carBase64: "local-car" };
}
function prepared(nft) {
  const verifiedAt = Date.now();
  return {
    ok: true, availability: "verified", rootCid: nft.rootCid, tokenUri: nft.tokenUri,
    metadataUrl: nft.tokenUri, artworkUrl: LIGHTHOUSE_DELIVERY_GATEWAY + "/bafkrei" + "a".repeat(53),
    verifiedAt, expiresAt: verifiedAt + 60_000,
  };
}
function loadPendingImplementation(storage = { value: undefined }) {
  const output = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve("lib/pendingMint.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction() {
            const transaction = {
              abort() { transaction.onabort?.(); },
              objectStore() {
                const perform = (kind, value) => {
                  const operation = {};
                  queueMicrotask(() => {
                    if (kind === "put") storage.value = structuredClone(value);
                    if (kind === "delete") storage.value = undefined;
                    operation.result = kind === "get" ? structuredClone(storage.value) : undefined;
                    operation.onsuccess?.();
                    if (kind !== "get") queueMicrotask(() => transaction.oncomplete?.());
                  });
                  return operation;
                };
                return { get: () => perform("get"), put: (value) => perform("put", value), delete: () => perform("delete") };
              },
            };
            return transaction;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
  vm.runInNewContext(code, {
    exports: output.exports, module: output, indexedDB, Date,
    require: (id) => {
      if (id === "viem") return { isAddress };
      assert.equal(id, "@/lib/nftGateway");
      return { LIGHTHOUSE_DELIVERY_GATEWAY };
    },
  });
  return output.exports;
}
const { pendingMintKey } = loadPendingImplementation();
const prepModule = { exports: {} };
const prepCode = ts.transpileModule(fs.readFileSync(path.resolve("lib/nftPreparation.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(prepCode, {
  exports: prepModule.exports, module: prepModule,
  require: (id) => {
    if (id === "@/lib/nftGateway") return { LIGHTHOUSE_DELIVERY_GATEWAY };
    if (id === "@/lib/nftUploadMessage" || id === "@/lib/onchain") return {};
    throw new Error("Unexpected preparation module: " + id);
  }, Date,
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function eventually(predicate, message) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}
function createHarness(overrides = {}) {
  const state = { actionErr: "", hasPendingMint: false, mintBusy: false, mintGatewayUrl: null, mintOpenSeaUrl: null, mintStage: "", mintTx: null };
  const calls = { build: 0, prepare: 0, mint: 0, confirm: 0, resolveBatch: 0, fetch: 0, save: [], remove: [], load: 0, sequence: [] };
  const wallet = { provider: {}, address: "0x1111111111111111111111111111111111111111" };
  const refs = {
    pending: { current: null }, verificationRuns: { current: new Map() }, confirmations: { current: new Map() },
    mintRun: { current: 0 }, mintAttempt: { current: null }, mintedRun: { current: false },
    finalizedHashes: { current: new Set() }, wallet: { current: wallet },
  };
  const currentPackage = nftPackage();
  const persisted = new Map();
  const set = (key) => (value) => { state[key] = value; };
  const bindings = {
    HEADS: { jesse: { label: "Jesse" } }, VEHICLES: { jeep: { name: "Jeep" } },
    MAPS: { hills: { name: "Countryside" } }, LIGHTHOUSE_DELIVERY_GATEWAY,
    TransactionRevertedError, NftPreparationError,
    buildRunNftPackage: async () => { calls.build++; calls.sequence.push("build"); return currentPackage; },
    prepareRunNft: async () => { calls.prepare++; calls.sequence.push("prepare"); return prepared(currentPackage); },
    assertPreparedNft: prepModule.exports.assertPreparedNft,
    assertNftWalletAccount: async () => { calls.sequence.push("account"); },
    confirmPreparedRunNft: async (txHash) => {
      calls.confirm++; calls.sequence.push("confirm");
      return { txHash, openSeaUrl: "https://opensea.io/item/base/contract/1" };
    },
    resolveSponsoredMintTransaction: async () => { calls.resolveBatch++; return TX_A; },
    pendingMintKey,
    mintRunNft: async (...args) => { await args[5](); calls.mint++; calls.sequence.push("mint"); return TX_A; },
    ensureConnected: async () => { refs.wallet.current = wallet; return wallet.address; },
    console: { error() {}, warn() {} },
    humanizeTxErr: (error) => error.message,
    fetch: async () => { calls.fetch++; throw new Error("Post-mint storage calls are forbidden"); },
    loadPendingRunMints: async () => { calls.load++; return []; },
    removePendingRunMint: async (hash) => { calls.remove.push(hash); persisted.delete(hash); },
    savePendingRunMint: async (value) => { calls.save.push(value); persisted.set(pendingMintKey(value), value); },
    finalizedMintHashesRef: refs.finalizedHashes, mintAttemptRef: refs.mintAttempt,
    mintRunRef: refs.mintRun, mintVerificationRunsRef: refs.verificationRuns,
    mintConfirmationRequestsRef: refs.confirmations, mintedRunRef: refs.mintedRun, pendingMintRef: refs.pending,
    walletRef: refs.wallet, walletAddr: wallet.address,
    gameOverCoins: 3, gameOverMeters: 42, gameOverShot: "data:image/png;base64,test",
    head: "jesse", selectedVehicle: "jeep", selectedMap: "hills",
    state: { distanceM: 42, status: "CRASH" }, runNftAddress: "0x2222222222222222222222222222222222222222",
    url: "https://game.example", window: { location: { origin: "https://game.example" }, setTimeout: () => 0 },
    setActionErr: set("actionErr"), setHasPendingMint: set("hasPendingMint"), setMintBusy: set("mintBusy"),
    setMintGatewayUrl: set("mintGatewayUrl"), setMintOpenSeaUrl: set("mintOpenSeaUrl"), setMintStage: set("mintStage"),
    setMintTx: set("mintTx"),
    ...overrides,
  };
  return { bindings, calls, refs, state, currentPackage, persisted, flow: makeMintFlow(bindings) };
}
test("actual handler verifies preparation before mint and makes no post-mint storage call", async () => {
  const h = createHarness();
  await h.flow.onMintNft();
  assert.deepEqual(h.calls.sequence, ["build", "prepare", "account", "mint", "confirm"]);
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.calls.save[0].prepared, true);
  assert.equal(h.refs.mintedRun.current, true);
  assert.equal(h.state.mintStage, "Mint successful");
  assert.equal(h.state.mintGatewayUrl, h.currentPackage.tokenUri);
  assert.match(h.state.mintOpenSeaUrl, /^https:\/\/opensea.io\/item\/base\//);
});
for (const [label, change] of [
  ["pending response", (value) => ({ ...value, ok: false, availability: "pending" })],
  ["missing proof", () => null],
  ["wrong metadata CID", (value) => ({ ...value, rootCid: "another" })],
  ["wrong token URI", (value) => ({ ...value, tokenUri: "https://wrong.example/file" })],
  ["expired proof", (value) => ({ ...value, expiresAt: Date.now() - 1 })],
  ["unverified availability", (value) => ({ ...value, availability: "uploaded" })],
]) {
  test(label + " cannot reach wallet mint or persist a transaction", async () => {
    const h = createHarness();
    h.bindings.prepareRunNft = async () => { h.calls.prepare++; return change(prepared(h.currentPackage)); };
    await h.flow.onMintNft();
    assert.equal(h.calls.mint, 0);
    assert.equal(h.calls.confirm, 0);
    assert.equal(h.calls.save.length, 0);
    assert.equal(h.refs.pending.current, null);
    assert.equal(h.state.mintBusy, false);
    assert.ok(h.state.actionErr);
  });
}
test("upload failure cannot send a mint", async () => {
  const h = createHarness({ prepareRunNft: async () => { throw new NftPreparationError("metadata_unavailable"); } });
  await h.flow.onMintNft();
  assert.equal(h.calls.mint, 0);
  assert.equal(h.calls.save.length, 0);
  assert.equal(h.refs.pending.current, null);
});
test("wallet cancellation after verified upload keeps files but stores no pending mint", async () => {
  const h = createHarness();
  h.bindings.mintRunNft = async () => { h.calls.mint++; throw new Error("User rejected the request"); };
  await h.flow.onMintNft();
  assert.equal(h.calls.prepare, 1);
  assert.equal(h.calls.mint, 1);
  assert.equal(h.calls.save.length, 0);
  assert.equal(h.calls.remove.length, 0);
  assert.equal(h.refs.pending.current, null);
  assert.match(h.state.actionErr, /rejected/);
});
test("double click prepares and mints only once", async () => {
  const gate = deferred();
  const h = createHarness();
  h.bindings.prepareRunNft = async () => { h.calls.prepare++; return gate.promise; };
  const first = h.flow.onMintNft();
  const second = h.flow.onMintNft();
  await eventually(() => h.calls.prepare === 1, "did not start preparation");
  assert.equal(h.calls.mint, 0);
  gate.resolve(prepared(h.currentPackage));
  await Promise.all([first, second]);
  assert.equal(h.calls.prepare, 1);
  assert.equal(h.calls.mint, 1);
});
test("reset during preparation prevents late wallet submission and stale UI", async () => {
  const gate = deferred();
  const h = createHarness({ prepareRunNft: async () => { h.calls.prepare++; return gate.promise; } });
  const attempt = h.flow.onMintNft();
  await eventually(() => h.calls.prepare === 1, "did not begin preparation");
  h.flow.resetRunMint();
  gate.resolve(prepared(h.currentPackage));
  await attempt;
  assert.equal(h.calls.mint, 0);
  assert.equal(h.state.mintBusy, false);
  assert.equal(h.state.mintStage, "");
});
test("disconnect during preparation cannot submit from a stale wallet", async () => {
  const gate = deferred();
  const h = createHarness({ prepareRunNft: async () => { h.calls.prepare++; return gate.promise; } });
  const attempt = h.flow.onMintNft();
  await eventually(() => h.calls.prepare === 1, "did not begin preparation");
  h.refs.wallet.current = null;
  gate.resolve(prepared(h.currentPackage));
  await attempt;
  assert.equal(h.calls.mint, 0);
});
test("account change before mint fails closed", async () => {
  const h = createHarness({ assertNftWalletAccount: async () => { throw new Error("NFT wallet account changed"); } });
  await h.flow.onMintNft();
  assert.equal(h.calls.mint, 0);
  assert.equal(h.calls.save.length, 0);
});
test("proof expiring during the final account check cannot send a mint", async () => {
  const h = createHarness();
  let result;
  h.bindings.prepareRunNft = async () => { result = prepared(h.currentPackage); return result; };
  h.bindings.assertNftWalletAccount = async () => { result.expiresAt = Date.now() - 1; };
  await h.flow.onMintNft();
  assert.equal(h.calls.mint, 0);
});
for (const change of ["run", "wallet", "proof"]) {
  test(`actual page send guard blocks ${change} changing inside mint network preparation`, async () => {
    const h = createHarness();
    let result;
    h.bindings.prepareRunNft = async () => { result = prepared(h.currentPackage); return result; };
    h.bindings.mintRunNft = async (...args) => {
      assert.equal(typeof args[5], "function");
      if (change === "run") h.flow.resetRunMint();
      if (change === "wallet") h.refs.wallet.current = null;
      if (change === "proof") result.expiresAt = Date.now() - 1;
      await args[5]();
      h.calls.mint++;
      return TX_A;
    };
    await h.flow.onMintNft();
    assert.equal(h.calls.mint, 0);
    assert.equal(h.calls.save.length, 0);
    assert.equal(h.calls.confirm, 0);
  });
}

test("late receipt from a prior run cannot overwrite current-run UI", async () => {
  const gate = deferred();
  const h = createHarness();
  h.bindings.confirmPreparedRunNft = async () => { h.calls.confirm++; return gate.promise; };
  const attempt = h.flow.onMintNft();
  await eventually(() => h.calls.confirm === 1, "did not await receipt");
  h.flow.resetRunMint();
  gate.resolve({ txHash: TX_A, openSeaUrl: "https://opensea.io/item/base/contract/1" });
  await attempt;
  assert.equal(h.state.mintStage, "");
  assert.equal(h.state.mintGatewayUrl, null);
  assert.equal(h.refs.mintedRun.current, false);
  assert.ok(h.calls.remove.includes(TX_A));
});
test("confirmed mint remains successful without any upload/finalize API", async () => {
  const h = createHarness({ fetch: async () => { throw new Error("storage offline"); } });
  await h.flow.onMintNft();
  assert.equal(h.refs.mintedRun.current, true);
  assert.equal(h.state.actionErr, "");
  assert.equal(h.calls.confirm, 1);
});
test("pending receipt only offers a confirmation check, never a second mint or upload", async () => {
  const h = createHarness();
  h.bindings.confirmPreparedRunNft = async () => { h.calls.confirm++; throw new Error("receipt unavailable"); };
  await h.flow.onMintNft();
  assert.equal(h.refs.pending.current.prepared, true);
  assert.equal(h.state.hasPendingMint, true);
  assert.equal(h.state.mintStage, "");
  assert.match(h.state.actionErr, /confirming/);
  await h.flow.onMintNft();
  assert.equal(h.calls.prepare, 1);
  assert.equal(h.calls.mint, 1);
  assert.equal(h.calls.confirm, 2);
  assert.equal(h.calls.fetch, 0);
});
test("repriced transaction retains prepared provenance and updates the explorer hash", async () => {
  const h = createHarness({ confirmPreparedRunNft: async () => ({ txHash: TX_B, openSeaUrl: "https://opensea.io/item/base/contract/2" }) });
  await h.flow.onMintNft();
  assert.equal(h.state.mintTx, TX_B);
  assert.equal(h.calls.save.at(-1).prepared, true);
  assert.ok(h.calls.remove.includes(TX_A));
  assert.ok(h.calls.remove.includes(TX_B));
});
test("reset while a repriced transaction is being persisted cannot mark the new run minted", async () => {
  const replacementSaved = deferred();
  const h = createHarness({ confirmPreparedRunNft: async () => ({ txHash: TX_B, openSeaUrl: "https://opensea.io/item/base/contract/2" }) });
  h.bindings.savePendingRunMint = async (pending) => {
    h.calls.save.push(pending);
    if (pending.txHash === TX_B) await replacementSaved.promise;
    h.persisted.set(pendingMintKey(pending), pending);
  };
  const attempt = h.flow.onMintNft();
  await eventually(() => h.calls.save.some((pending) => pending.txHash === TX_B), "replacement persistence did not begin");
  assert.equal(h.state.mintTx, TX_B);
  h.flow.resetRunMint();
  replacementSaved.resolve();
  await attempt;
  assert.equal(h.refs.pending.current, null);
  assert.equal(h.refs.mintedRun.current, false);
  assert.equal(h.state.mintTx, null);
  assert.equal(h.state.hasPendingMint, false);
  assert.equal(h.state.mintStage, "");
  assert.equal(h.state.mintGatewayUrl, null);
  assert.equal(h.state.mintOpenSeaUrl, null);
  assert.equal(h.state.actionErr, "");
  assert.ok(h.calls.remove.includes(TX_A));
  assert.ok(h.calls.remove.includes(TX_B));
});
test("reverted transaction clears only that confirmation record", async () => {
  const h = createHarness({ confirmPreparedRunNft: async () => { throw new TransactionRevertedError("Transaction failed"); } });
  await h.flow.onMintNft();
  assert.equal(h.refs.pending.current, null);
  assert.equal(h.state.hasPendingMint, false);
  assert.equal(h.refs.mintedRun.current, false);
  assert.ok(h.calls.remove.includes(TX_A));
});
test("completed run cannot mint a second time", async () => {
  const h = createHarness();
  await h.flow.onMintNft();
  await h.flow.onMintNft();
  assert.equal(h.calls.prepare, 1);
  assert.equal(h.calls.mint, 1);
});
test("startup leaves all version1 and version2 records untouched", async () => {
  const h = createHarness();
  const old = [1, 2].map((version) => ({ version, txHash: version === 1 ? TX_A : TX_B, package: nftPackage("old"), savedAt: Date.now() }));
  h.bindings.loadPendingRunMints = async () => { h.calls.load++; return old; };
  const cleanup = h.flow.startupEffect();
  await eventually(() => h.calls.load > 0, "did not inspect confirmation records");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.confirm, 0);
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.calls.remove.length, 0);
  cleanup();
});
test("startup resumes version3 through chain receipt only and does not attach it to current run", async () => {
  const h = createHarness();
  const pending = { version: 3, prepared: true, txHash: TX_A, package: nftPackage("old"), savedAt: Date.now() };
  h.bindings.loadPendingRunMints = async () => h.calls.load++ ? [] : [pending];
  const cleanup = h.flow.startupEffect();
  await eventually(() => h.calls.remove.includes(TX_A), "did not confirm prepared old run");
  assert.equal(h.calls.confirm, 1);
  assert.equal(h.calls.prepare, 0);
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.calls.mint, 0);
  assert.equal(h.refs.pending.current, null);
  assert.equal(h.state.mintGatewayUrl, null);
  cleanup();
});
test("an old unprepared record cannot invoke confirmation or storage", async () => {
  const h = createHarness();
  const result = await h.flow.finalizeMintStorage({ package: nftPackage("old"), txHash: TX_A }, true);
  assert.equal(result, false);
  assert.equal(h.calls.confirm, 0);
  assert.equal(h.calls.fetch, 0);
});

const CALLS_ID = "0xlocal-sponsored-batch";
const PENDING_WALLET = "0x1111111111111111111111111111111111111111";
function sponsoredPending(overrides = {}) {
  return {
    prepared: true, callsId: CALLS_ID, walletAddress: PENDING_WALLET,
    package: { ...nftPackage("batch"), carBytes: 20, imageBytes: 10 },
    ...overrides,
  };
}

test("real pending storage restores an accepted sponsored callsId without inventing a tx hash", async () => {
  const storage = { value: undefined };
  const first = loadPendingImplementation(storage);
  const pending = sponsoredPending();
  await first.savePendingRunMint(pending);
  const reloaded = loadPendingImplementation(storage);
  const records = await reloaded.loadPendingRunMints();
  assert.equal(records.length, 1);
  assert.equal(records[0].version, 3);
  assert.equal(records[0].prepared, true);
  assert.equal(records[0].callsId, CALLS_ID);
  assert.equal(records[0].walletAddress, PENDING_WALLET);
  assert.equal(records[0].txHash, undefined);
});

test("real pending storage retains stable batch identity when its actual transaction hash arrives", async () => {
  const api = loadPendingImplementation();
  const initial = sponsoredPending();
  const key = api.pendingMintKey(initial);
  await api.savePendingRunMint(initial);
  await api.savePendingRunMint({ ...initial, txHash: TX_A });
  const records = await api.loadPendingRunMints();
  assert.equal(records.length, 1);
  assert.equal(records[0].txHash, TX_A);
  assert.equal(api.pendingMintKey(records[0]), key);
  await api.removePendingRunMint(key);
  assert.equal((await api.loadPendingRunMints()).length, 0);
});

test("real pending storage separates identical batch IDs belonging to different wallets", async () => {
  const api = loadPendingImplementation();
  const first = sponsoredPending();
  const second = sponsoredPending({ walletAddress: "0x2222222222222222222222222222222222222222" });
  await api.savePendingRunMint(first);
  await api.savePendingRunMint(second);
  assert.notEqual(api.pendingMintKey(first), api.pendingMintKey(second));
  assert.equal((await api.loadPendingRunMints()).length, 2);
  await api.removePendingRunMint(api.pendingMintKey(first));
  const records = await api.loadPendingRunMints();
  assert.equal(records.length, 1);
  assert.equal(records[0].walletAddress, second.walletAddress);
});

function installPendingSponsoredMint(h) {
  h.bindings.mintRunNft = async (...args) => {
    await args[5]();
    h.calls.mint++;
    assert.equal(typeof args[6], "function", "Accepted batch acknowledgement must be supplied");
    await args[6]({ callsId: CALLS_ID });
    throw new Error("Sponsored transaction is still confirming");
  };
}

test("accepted batch is retained and persisted before delayed status polling can fail", async () => {
  const h = createHarness();
  const durable = deferred();
  let statusPollingReached = false;
  h.bindings.savePendingRunMint = async (pending) => {
    h.calls.save.push(pending);
    await durable.promise;
    h.persisted.set(pendingMintKey(pending), pending);
  };
  h.bindings.mintRunNft = async (...args) => {
    await args[5]();
    h.calls.mint++;
    await args[6]({ callsId: CALLS_ID });
    statusPollingReached = true;
    throw new Error("Status RPC unavailable");
  };
  const first = h.flow.onMintNft();
  await eventually(() => h.calls.save.length === 1, "accepted batch was not captured");
  assert.equal(h.refs.pending.current.callsId, CALLS_ID);
  assert.equal(h.refs.pending.current.txHash, undefined);
  assert.equal(h.state.mintTx, null);
  assert.equal(h.state.hasPendingMint, true);
  assert.equal(statusPollingReached, false);
  await h.flow.onMintNft();
  assert.equal(h.calls.mint, 1);
  durable.resolve();
  await first;
  assert.equal(statusPollingReached, true);
  assert.ok(h.persisted.has(pendingMintKey(h.refs.pending.current)));
  assert.match(h.state.actionErr, /confirming/);
  assert.equal(h.calls.fetch, 0);
});

test("retrying an accepted batch resolves its real hash and receipt without minting or uploading again", async () => {
  const h = createHarness();
  installPendingSponsoredMint(h);
  await h.flow.onMintNft();
  const key = pendingMintKey(h.refs.pending.current);
  assert.equal(h.state.mintTx, null);
  await h.flow.onMintNft();
  assert.equal(h.calls.build, 1);
  assert.equal(h.calls.prepare, 1);
  assert.equal(h.calls.mint, 1);
  assert.equal(h.calls.resolveBatch, 1);
  assert.equal(h.calls.confirm, 1);
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.state.mintTx, TX_A);
  assert.equal(h.state.mintStage, "Mint successful");
  assert.ok(h.calls.save.some((record) => record.callsId === CALLS_ID && record.txHash === TX_A));
  assert.ok(h.calls.remove.includes(key));
  assert.equal(h.refs.pending.current, null);
});

test("once batch hash is discovered a later receipt retry does not re-query or resend the batch", async () => {
  const h = createHarness();
  installPendingSponsoredMint(h);
  await h.flow.onMintNft();
  h.bindings.confirmPreparedRunNft = async () => { h.calls.confirm++; throw new Error("Receipt pending"); };
  await h.flow.onMintNft();
  assert.equal(h.refs.pending.current.txHash, TX_A);
  assert.equal(h.calls.resolveBatch, 1);
  await h.flow.onMintNft();
  assert.equal(h.calls.resolveBatch, 1);
  assert.equal(h.calls.confirm, 2);
  assert.equal(h.calls.mint, 1);
  assert.equal(h.calls.prepare, 1);
  assert.equal(h.calls.fetch, 0);
});

test("reload checks stored accepted batch through wallet status and receipt only", async () => {
  const h = createHarness();
  const record = { version: 3, savedAt: Date.now(), ...sponsoredPending() };
  const key = pendingMintKey(record);
  h.bindings.loadPendingRunMints = async () => h.calls.load++ ? [] : [record];
  const cleanup = h.flow.startupEffect();
  await eventually(() => h.calls.remove.includes(key), "stored batch was not confirmed");
  assert.equal(h.calls.resolveBatch, 1);
  assert.equal(h.calls.confirm, 1);
  assert.equal(h.calls.prepare, 0);
  assert.equal(h.calls.mint, 0);
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.refs.pending.current, null);
  assert.equal(h.state.mintTx, null);
  assert.equal(h.state.mintGatewayUrl, null);
  cleanup();
});

test("reload with an unavailable batch wallet keeps record pending without connecting or resubmitting", async () => {
  const h = createHarness();
  const record = { version: 3, savedAt: Date.now(), ...sponsoredPending() };
  h.refs.wallet.current = null;
  h.bindings.loadPendingRunMints = async () => { h.calls.load++; return [record]; };
  h.bindings.resolveSponsoredMintTransaction = async (_id, _address, wallet) => {
    h.calls.resolveBatch++;
    assert.equal(wallet, undefined);
    throw new Error("Wallet not connected; batch pending");
  };
  h.bindings.ensureConnected = async () => assert.fail("Background confirmation must not open a wallet");
  const cleanup = h.flow.startupEffect();
  await eventually(() => h.calls.resolveBatch === 1, "stored batch was not checked");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.confirm, 0);
  assert.equal(h.calls.remove.length, 0);
  assert.equal(h.calls.prepare, 0);
  assert.equal(h.calls.mint, 0);
  assert.equal(h.calls.fetch, 0);
  cleanup();
});

test("definitive sponsored failure clears only its accepted batch and does not send a replacement", async () => {
  const h = createHarness();
  h.bindings.mintRunNft = async (...args) => {
    await args[5]();
    h.calls.mint++;
    await args[6]({ callsId: CALLS_ID });
    throw new TransactionRevertedError("Transaction failed");
  };
  await h.flow.onMintNft();
  assert.equal(h.refs.pending.current, null);
  assert.equal(h.state.hasPendingMint, false);
  assert.equal(h.calls.remove.length, 1);
  assert.equal(h.calls.remove[0], pendingMintKey(sponsoredPending()));
  assert.equal(h.calls.mint, 1);
  assert.equal(h.calls.prepare, 1);
  assert.equal(h.calls.fetch, 0);
});

test("late accepted batch result from an old run cannot overwrite new-run state", async () => {
  const h = createHarness();
  installPendingSponsoredMint(h);
  await h.flow.onMintNft();
  const key = pendingMintKey(h.refs.pending.current);
  const gate = deferred();
  h.bindings.resolveSponsoredMintTransaction = async () => { h.calls.resolveBatch++; return gate.promise; };
  const retry = h.flow.onMintNft();
  await eventually(() => h.calls.resolveBatch === 1, "batch retry was not started");
  h.flow.resetRunMint();
  gate.resolve(TX_A);
  await retry;
  assert.equal(h.refs.pending.current, null);
  assert.equal(h.refs.mintedRun.current, false);
  assert.equal(h.state.mintTx, null);
  assert.equal(h.state.mintStage, "");
  assert.equal(h.state.mintGatewayUrl, null);
  assert.ok(h.calls.remove.includes(key));
  assert.equal(h.calls.mint, 1);
});

test("concurrent checks of the same accepted batch share one status and receipt request", async () => {
  const h = createHarness();
  const gate = deferred();
  h.bindings.resolveSponsoredMintTransaction = async () => { h.calls.resolveBatch++; return gate.promise; };
  const pending = sponsoredPending();
  const first = h.flow.finalizeMintStorage(pending, true, { silent: true });
  const second = h.flow.finalizeMintStorage(pending, true, { silent: true });
  await eventually(() => h.calls.resolveBatch === 1, "batch lookup did not start");
  gate.resolve(TX_A);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(h.calls.resolveBatch, 1);
  assert.equal(h.calls.confirm, 1);
  assert.equal(h.calls.prepare, 0);
  assert.equal(h.calls.mint, 0);
  assert.equal(h.calls.fetch, 0);
});
