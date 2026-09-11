import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

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
    "requestMintFinalization",
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
          requestMintFinalization,
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

class MintStorageError extends Error {
  constructor(reason) {
    super(`NFT storage is pending (${reason})`);
    this.name = "MintStorageError";
    this.reason = reason;
  }
}

class TransactionRevertedError extends Error {
  constructor() {
    super("Transaction reverted");
    this.name = "TransactionRevertedError";
  }
}

const TX_A = `0x${"a".repeat(64)}`;
const TX_B = `0x${"b".repeat(64)}`;

function nftPackage(label = "current") {
  const rootCid = `bafy-${label}`;
  return {
    rootCid,
    tokenUri: `ipfs://${rootCid}`,
    carBase64: `base64-${label}`,
  };
}

function legacyNftPackage(label, tokenUri) {
  return { ...nftPackage(label), tokenUri };
}

function successfulResponse(overrides = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      metadataUrl: "https://gateway.example/ipfs/bafy/metadata.json",
      gatewayUrl: "https://gateway.example/ipfs/bafy/image.webp",
      openSeaUrl: "https://opensea.io/assets/base/contract/1",
      ...overrides,
    }),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function createHarness(overrides = {}) {
  const state = {
    actionErr: "",
    hasPendingMint: false,
    mintBusy: false,
    mintGatewayUrl: null,
    mintOpenSeaUrl: null,
    mintStage: "",
    mintTx: null,
    transitions: [],
  };
  const calls = {
    build: 0,
    ensureWallet: 0,
    fetch: 0,
    load: 0,
    mint: 0,
    remove: [],
    save: [],
    wait: 0,
  };
  const persisted = new Map();
  const refs = {
    pending: { current: null },
    verificationRuns: { current: new Map() },
    finalizeRequests: { current: new Map() },
    mintRun: { current: 0 },
    mintAttempt: { current: null },
    mintedRun: { current: false },
    finalizedHashes: { current: new Set() },
    wallet: { current: { provider: {}, address: "0xabc" } },
  };
  const currentPackage = nftPackage();
  const setState = (name) => (value) => {
    state[name] = value;
    state.transitions.push([name, value]);
  };

  const defaultBindings = {
    AbortSignal,
    HEADS: { jesse: { label: "Jesse" }, brian: { label: "Brian" } },
    MAPS: { countryside: { name: "Countryside" } },
    MintStorageError,
    TransactionRevertedError,
    VEHICLES: { jeep: { name: "Jeep" } },
    buildRunNftPackage: async () => {
      calls.build += 1;
      return currentPackage;
    },
    console: { error() {}, warn() {}, log() {} },
    ensureConnected: async () => {
      calls.ensureWallet += 1;
      return "0xabc";
    },
    fetch: async () => {
      calls.fetch += 1;
      return successfulResponse();
    },
    finalizedMintHashesRef: refs.finalizedHashes,
    gameOverCoins: 3,
    gameOverMeters: 42,
    gameOverShot: "data:image/png;base64,snapshot",
    hasPendingMint: false,
    head: "jesse",
    humanizeTxErr: (error) => String(error?.message || error || "Transaction failed"),
    loadPendingRunMints: async () => {
      calls.load += 1;
      return [];
    },
    mintAttemptRef: refs.mintAttempt,
    mintFinalizeRequestsRef: refs.finalizeRequests,
    mintRunNft: async () => {
      calls.mint += 1;
      return TX_A;
    },
    mintRunRef: refs.mintRun,
    mintVerificationRunsRef: refs.verificationRuns,
    mintedRunRef: refs.mintedRun,
    pendingMintRef: refs.pending,
    removePendingRunMint: async (txHash) => {
      calls.remove.push(txHash);
      persisted.delete(txHash);
    },
    runNftAddress: "0x0000000000000000000000000000000000000001",
    savePendingRunMint: async (pending) => {
      calls.save.push(pending);
      persisted.set(pending.txHash, pending);
    },
    selectedMap: "countryside",
    selectedVehicle: "jeep",
    setActionErr: setState("actionErr"),
    setHasPendingMint: setState("hasPendingMint"),
    setMintBusy: setState("mintBusy"),
    setMintGatewayUrl: setState("mintGatewayUrl"),
    setMintOpenSeaUrl: setState("mintOpenSeaUrl"),
    setMintStage: setState("mintStage"),
    setMintTx: setState("mintTx"),
    state: { distanceM: 42, status: "CRASH" },
    url: "https://hillclimb.example",
    waitForBaseTransaction: async (txHash) => {
      calls.wait += 1;
      return txHash;
    },
    walletAddr: "0xabc",
    walletRef: refs.wallet,
    // Background verification should remain dormant in unit tests. A pending
    // Promise has no event-loop handle and therefore cannot make node:test hang.
    window: { setTimeout: () => 0 },
  };

  const bindings = { ...defaultBindings, ...(overrides.bindings ?? {}) };
  const flow = makeMintFlow(bindings);
  return { bindings, calls, currentPackage, flow, persisted, refs, state };
}

test("a persisted old run finishes silently and never hijacks the current run", async () => {
  const oldPending = { package: nftPackage("old"), txHash: TX_A };
  const newPending = { package: nftPackage("new"), txHash: TX_B };
  const responseGate = deferred();
  let loadPass = 0;
  const harness = createHarness({
    bindings: {
      fetch: async () => {
        harness.calls.fetch += 1;
        return responseGate.promise;
      },
      loadPendingRunMints: async () => {
        harness.calls.load += 1;
        loadPass += 1;
        return loadPass === 1 ? [oldPending] : [];
      },
    },
  });

  const cleanup = harness.flow.startupEffect();
  await eventually(() => harness.calls.fetch === 1, "startup recovery did not request finalization");

  harness.flow.resetRunMint();
  harness.refs.pending.current = newPending;
  harness.state.hasPendingMint = true;
  responseGate.resolve(successfulResponse());

  await eventually(() => harness.calls.remove.includes(TX_A), "old persisted mint did not finish");
  assert.equal(harness.refs.pending.current, newPending);
  assert.equal(harness.state.hasPendingMint, true);
  assert.equal(harness.state.mintGatewayUrl, null);
  assert.equal(harness.refs.mintedRun.current, false);
  cleanup();
});

test("startup leaves legacy HTTP and metadata.json records untouched", async () => {
  const legacyRecords = [
    {
      package: legacyNftPackage(
        "legacy-http",
        "https://gateway.example/ipfs/bafy-legacy-http/metadata.json",
      ),
      txHash: TX_A,
    },
    {
      package: legacyNftPackage(
        "legacy-directory",
        "ipfs://bafy-legacy-directory/metadata.json",
      ),
      txHash: TX_B,
    },
  ];
  let loadPass = 0;
  const harness = createHarness({
    bindings: {
      loadPendingRunMints: async () => {
        harness.calls.load += 1;
        loadPass += 1;
        return loadPass === 1 ? legacyRecords : [];
      },
    },
  });
  for (const pending of legacyRecords) harness.persisted.set(pending.txHash, pending);

  const cleanup = harness.flow.startupEffect();
  await eventually(() => harness.calls.load > 0, "startup recovery did not inspect persistence");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.fetch, 0);
  assert.equal(harness.calls.remove.length, 0);
  assert.equal(harness.calls.ensureWallet, 0);
  assert.equal(harness.calls.mint, 0);
  assert.deepEqual([...harness.persisted.keys()].sort(), [TX_A, TX_B].sort());
  assert.equal(harness.refs.pending.current, null);
  cleanup();
});

test("startup finalizes a canonical flat-CAR record when no fresh attempt is active", async () => {
  const canonical = { package: nftPackage("canonical"), txHash: TX_A };
  let loadPass = 0;
  const harness = createHarness({
    bindings: {
      loadPendingRunMints: async () => {
        harness.calls.load += 1;
        loadPass += 1;
        return loadPass === 1 ? [canonical] : [];
      },
    },
  });
  harness.persisted.set(canonical.txHash, canonical);

  const cleanup = harness.flow.startupEffect();
  await eventually(() => harness.calls.remove.includes(TX_A), "canonical recovery did not finish");

  assert.equal(harness.calls.fetch, 1);
  assert.equal(harness.calls.wait, 0);
  assert.equal(harness.calls.ensureWallet, 0);
  assert.equal(harness.calls.mint, 0);
  assert.equal(harness.persisted.has(TX_A), false);
  cleanup();
});

test("a fresh foreground mint blocks startup recovery until the attempt is released", async () => {
  const canonical = { package: nftPackage("queued"), txHash: TX_A };
  const sleepers = [];
  let loadPass = 0;
  const harness = createHarness({
    bindings: {
      loadPendingRunMints: async () => {
        harness.calls.load += 1;
        loadPass += 1;
        return loadPass === 1 ? [canonical] : [];
      },
      window: {
        setTimeout(resolve, delay) {
          sleepers.push({ delay, resolve });
          return sleepers.length;
        },
      },
    },
  });
  harness.refs.mintAttempt.current = harness.refs.mintRun.current;

  const cleanup = harness.flow.startupEffect();
  await eventually(() => sleepers.length === 1, "startup recovery did not yield to foreground mint");

  assert.equal(sleepers[0].delay, 1_000);
  assert.equal(harness.calls.fetch, 0);
  assert.equal(harness.calls.remove.length, 0);

  harness.refs.mintAttempt.current = null;
  sleepers.shift().resolve();
  await eventually(() => harness.calls.remove.includes(TX_A), "recovery did not resume after mint release");

  assert.equal(harness.calls.fetch, 1);
  assert.equal(harness.calls.ensureWallet, 0);
  assert.equal(harness.calls.mint, 0);
  cleanup();
});

test("same-run pending retry skips wallet, package building, and client receipt wait", async () => {
  const harness = createHarness();
  harness.refs.pending.current = { package: nftPackage("pending"), txHash: TX_A };
  harness.state.hasPendingMint = true;

  await harness.flow.onMintNft();

  assert.equal(harness.calls.ensureWallet, 0);
  assert.equal(harness.calls.build, 0);
  assert.equal(harness.calls.mint, 0);
  assert.equal(harness.calls.wait, 0);
  assert.equal(harness.calls.fetch, 1);
  assert.equal(harness.refs.pending.current, null);
  assert.equal(harness.refs.mintedRun.current, true);
});

test("wallet rejection never starts persistence or server upload", async () => {
  const rejection = Object.assign(new Error("User rejected the request"), { code: 4001 });
  const harness = createHarness({
    bindings: {
      mintRunNft: async () => {
        harness.calls.mint += 1;
        throw rejection;
      },
    },
  });

  await harness.flow.onMintNft();

  assert.equal(harness.calls.mint, 1);
  assert.equal(harness.calls.fetch, 0);
  assert.equal(harness.calls.save.length, 0);
  assert.equal(harness.refs.pending.current, null);
  assert.match(harness.state.actionErr, /reject/i);
});

test("a fast double click submits exactly one wallet mint", async () => {
  const walletGate = deferred();
  const harness = createHarness({
    bindings: {
      mintRunNft: async () => {
        harness.calls.mint += 1;
        return walletGate.promise;
      },
    },
  });

  const first = harness.flow.onMintNft();
  const second = harness.flow.onMintNft();
  await eventually(() => harness.calls.mint === 1, "first click did not reach wallet mint");
  walletGate.resolve(TX_A);
  await Promise.all([first, second]);

  assert.equal(harness.calls.mint, 1);
  assert.equal(harness.calls.fetch, 1);
  assert.equal(harness.calls.save.length, 1);
});

test("a late finalization result cannot mutate the reset/new-run UI", async () => {
  const receiptGate = deferred();
  const harness = createHarness({
    bindings: {
      waitForBaseTransaction: async () => {
        harness.calls.wait += 1;
        return receiptGate.promise;
      },
    },
  });

  const mint = harness.flow.onMintNft();
  await eventually(() => harness.calls.wait === 1, "mint did not reach receipt wait");
  harness.flow.resetRunMint();
  const runAfterReset = harness.refs.mintRun.current;
  receiptGate.resolve(TX_A);
  await mint;

  assert.equal(harness.refs.mintRun.current, runAfterReset);
  assert.equal(harness.refs.pending.current, null);
  assert.equal(harness.refs.mintedRun.current, false);
  assert.equal(harness.state.mintBusy, false);
  assert.equal(harness.state.mintStage, "");
  assert.equal(harness.state.mintGatewayUrl, null);
  assert.equal(harness.state.mintOpenSeaUrl, null);
});

test("starting a new run does not delete an unfinished persisted package", async () => {
  const harness = createHarness();
  const pending = { package: nftPackage("durable"), txHash: TX_A };
  await harness.bindings.savePendingRunMint(pending);
  harness.refs.pending.current = pending;

  harness.flow.resetRunMint();

  assert.equal(harness.calls.remove.length, 0);
  assert.equal(harness.persisted.get(TX_A), pending);
  assert.equal(harness.refs.pending.current, null);
});

test("successful storage completion disables duplicate mint attempts for that run", async () => {
  const harness = createHarness();

  await harness.flow.onMintNft();
  const completedCounts = {
    build: harness.calls.build,
    fetch: harness.calls.fetch,
    mint: harness.calls.mint,
    save: harness.calls.save.length,
  };
  await harness.flow.onMintNft();

  assert.deepEqual(
    {
      build: harness.calls.build,
      fetch: harness.calls.fetch,
      mint: harness.calls.mint,
      save: harness.calls.save.length,
    },
    completedCounts,
  );
  assert.equal(harness.refs.mintedRun.current, true);
  assert.match(String(harness.state.mintGatewayUrl), /^https:\/\//);
});

test("HTTP 202 leaves the exact package pending and shows a retryable message", async () => {
  const harness = createHarness({
    bindings: {
      fetch: async () => {
        harness.calls.fetch += 1;
        return {
          ok: true,
          status: 202,
          json: async () => ({
            ok: false,
            pending: true,
            error: "gateway_verification_pending",
          }),
        };
      },
    },
  });

  await harness.flow.onMintNft();

  assert.equal(harness.calls.mint, 1);
  assert.equal(harness.calls.fetch, 1);
  assert.equal(harness.refs.pending.current?.txHash, TX_A);
  assert.equal(harness.refs.pending.current?.package, harness.currentPackage);
  assert.equal(harness.state.hasPendingMint, true);
  assert.equal(harness.state.mintBusy, false);
  assert.equal(harness.state.mintGatewayUrl, null);
  assert.ok(
    String(harness.state.actionErr || harness.state.mintStage).trim().length > 0,
    "a pending 202 response must leave visible recovery feedback",
  );
});
