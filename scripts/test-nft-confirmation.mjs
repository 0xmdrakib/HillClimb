/** Actual onchain receipt handling and viem event decoding, with no RPC or wallet traffic. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as viem from "viem";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADDRESS = `0x${"a".repeat(40)}`;
const CONTRACT = `0x${"c".repeat(40)}`;
const OTHER_CONTRACT = `0x${"b".repeat(40)}`;
const TX = `0x${"1".repeat(64)}`;
const REPRICED_TX = `0x${"2".repeat(64)}`;
const TOKEN_URI = `https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs/bafkrei${"a".repeat(52)}`;

function loadTs(relative, bindings, globals = {}) {
  const sourcePath = path.join(ROOT, relative);
  const result = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: sourcePath, reportDiagnostics: true,
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

const abiModule = loadTs("lib/onchainAbi.ts", {});
const gaslessModule = loadTs("lib/gasless.ts", {
  "@/lib/builderCodes": { appendErc8021Suffix: (value) => value },
}, { process: { env: {} }, setTimeout, clearTimeout });

function runMintedLog(overrides = {}) {
  const tokenUri = overrides.tokenUri ?? TOKEN_URI;
  return {
    address: overrides.address ?? CONTRACT,
    topics: viem.encodeEventTopics({
      abi: abiModule.runNftAbi, eventName: "RunMinted",
      args: { player: ADDRESS, tokenId: overrides.tokenId ?? 244n },
    }),
    data: viem.encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "string" }],
      [43n, 1, tokenUri],
    ),
  };
}

function createHarness(options = {}) {
  const state = {
    waits: [], reads: [], accountReads: 0, providerRequests: [], signCalls: [], walletClients: [],
    accounts: [ADDRESS], transactions: [], sponsoredCalls: [], capabilityCalls: [], guardCalls: 0,
    currentRun: true, proofExpiresAt: 60_000, now: 0,
  };
  const receipt = {
    status: "success", transactionHash: TX, logs: [runMintedLog()], ...options.receipt,
  };
  const provider = {
    async request(request) {
      state.providerRequests.push(request);
      const result = await options.onProviderRequest?.(request, state);
      if (result !== undefined) return result;
      if (options.realWalletClient) {
        if (request.method === "eth_chainId") return "0x2105";
        if (["eth_sendTransaction", "wallet_sendTransaction"].includes(request.method)) {
          state.transactions.push(request);
          return TX;
        }
      }
      return null;
    },
  };
  const exports = loadTs("lib/onchain.ts", {
    viem: {
      ...viem,
      createPublicClient() {
        return {
          async waitForTransactionReceipt(request) {
            state.waits.push(request);
            if (options.reason) request.onReplaced({ reason: options.reason });
            if (options.waitError) throw options.waitError;
            return receipt;
          },
          async getTransactionReceipt(request) {
            state.reads.push(request);
            if (options.readError) throw options.readError;
            return receipt;
          },
        };
      },
      createWalletClient(config) {
        state.walletClients.push(config);
        if (options.realWalletClient) return viem.createWalletClient(config);
        return {
          async signMessage(request) {
            state.signCalls.push(request);
            if (options.signError) throw options.signError;
            return "0xuploadsignature";
          },
          async sendTransaction(request) {
            assert.ok(options.mintMode, "Confirmation/authorization must never send a transaction");
            state.transactions.push(request);
            return TX;
          },
        };
      },
    },
    "@/lib/wallet": {
      async getAccounts(received) {
        assert.equal(received, provider);
        state.accountReads += 1;
        await options.onAccountRead?.(state);
        return state.accounts;
      },
      async getChainId(received) {
        assert.equal(received, provider);
        await options.onChainRead?.(state);
        return options.chainId ?? 8453;
      },
    },
    "@/lib/onchainAbi": abiModule,
    "@/lib/gasless": {
      ...gaslessModule,
      isPaymasterServiceConfigured() {
        assert.ok(options.mintMode, "No sponsorship during authorization/confirmation");
        return options.sponsorshipConfigured ?? false;
      },
      async supportsPaymasterService(request) {
        state.capabilityCalls.push(request);
        await options.onCapability?.(state);
        return options.sponsorshipSupported ?? false;
      },
      async sendSponsoredCallsAndGetTxHash(request) {
        assert.ok(options.mintMode, "No sponsored transaction during authorization/confirmation");
        await request.beforeSend?.();
        state.sponsoredCalls.push(request);
        return TX;
      },
    },
    "@/lib/builderCodes": { ERC8021_DATA_SUFFIX: "", appendErc8021Suffix: (value) => value },
  });
  return { ...exports, state, receipt, wallet: { provider, address: ADDRESS } };
}

test("fresh confirmation waits for actual receipt and decodes matching contract/tokenURI/tokenId", async () => {
  const h = createHarness();
  const result = await h.confirmPreparedRunNft(TX, CONTRACT, TOKEN_URI);
  assert.equal(result.txHash, TX);
  assert.equal(result.openSeaUrl, `https://opensea.io/item/base/${CONTRACT}/244`);
  assert.equal(h.state.waits.length, 1);
  assert.equal(h.state.reads.length, 0);
  assert.equal(h.state.waits[0].hash, TX);
  assert.equal(h.state.waits[0].confirmations, 1);
  assert.equal(h.state.waits[0].timeout, 180_000);
  assert.equal(h.state.providerRequests.length, 0);
});

test("confirmation retry performs one read-only receipt check, never another wait, upload or mint", async () => {
  const h = createHarness();
  await h.confirmPreparedRunNft(TX, CONTRACT, TOKEN_URI, true);
  assert.equal(h.state.waits.length, 0);
  assert.equal(h.state.reads.length, 1);
  assert.equal(h.state.reads[0].hash, TX);
  assert.equal(h.state.providerRequests.length, 0);
});

for (const [label, logs] of [
  ["wrong emitting contract", [runMintedLog({ address: OTHER_CONTRACT })]],
  ["wrong tokenURI", [runMintedLog({ tokenUri: `${TOKEN_URI}different` })]],
  ["no events", []],
  ["unrelated event", [{ address: CONTRACT, topics: [`0x${"e".repeat(64)}`], data: "0x" }]],
  ["truncated event", [{ ...runMintedLog(), data: "0x0001" }]],
]) {
  test(`${label} cannot confirm a minted NFT even on a successful transaction`, async () => {
    const h = createHarness({ receipt: { logs } });
    await assert.rejects(h.confirmPreparedRunNft(TX, CONTRACT, TOKEN_URI), { code: "TRANSACTION_REVERTED" });
  });
}

test("valid matching event is found after unrelated or malformed logs", async () => {
  const h = createHarness({ receipt: { logs: [
    runMintedLog({ address: OTHER_CONTRACT }),
    { address: CONTRACT, topics: [], data: "0x" },
    runMintedLog({ tokenId: 999n }),
  ] } });
  const result = await h.confirmPreparedRunNft(TX, CONTRACT.toUpperCase().replace("0X", "0x"), TOKEN_URI);
  assert.match(result.openSeaUrl, /\/999$/);
});

for (const checkOnly of [false, true]) {
  test(`reverted receipt is rejected in ${checkOnly ? "read-only retry" : "fresh wait"}`, async () => {
    const h = createHarness({ receipt: { status: "reverted" } });
    await assert.rejects(h.confirmPreparedRunNft(TX, CONTRACT, TOKEN_URI, checkOnly), { code: "TRANSACTION_REVERTED" });
  });
}

for (const reason of ["cancelled", "replaced"]) {
  test(`wallet ${reason} transaction does not report mint success`, async () => {
    const h = createHarness({ reason });
    await assert.rejects(h.confirmPreparedRunNft(TX, CONTRACT, TOKEN_URI), { code: "TRANSACTION_REVERTED" });
  });
}

test("repriced mint with a valid actual event returns replacement hash", async () => {
  const h = createHarness({ reason: "repriced", receipt: { transactionHash: REPRICED_TX } });
  const result = await h.confirmPreparedRunNft(TX, CONTRACT, TOKEN_URI);
  assert.equal(result.txHash, REPRICED_TX);
});

test("repriced non-mint receipt cannot count as a successful NFT", async () => {
  const h = createHarness({ reason: "repriced", receipt: { transactionHash: REPRICED_TX, logs: [] } });
  await assert.rejects(h.confirmPreparedRunNft(TX, CONTRACT, TOKEN_URI), { code: "TRANSACTION_REVERTED" });
});

test("RPC wait timeout is propagated without a fallback transaction or false confirmation", async () => {
  const failure = new Error("Receipt timeout");
  const h = createHarness({ waitError: failure });
  await assert.rejects(h.confirmPreparedRunNft(TX, CONTRACT, TOKEN_URI), (error) => error === failure);
  assert.equal(h.state.waits.length, 1);
  assert.equal(h.state.reads.length, 0);
});

test("not-yet-mined read-only retry propagates missing receipt and sends nothing", async () => {
  const failure = new Error("TransactionReceiptNotFoundError");
  const h = createHarness({ readError: failure });
  await assert.rejects(h.confirmPreparedRunNft(TX, CONTRACT, TOKEN_URI, true), (error) => error === failure);
  assert.equal(h.state.reads.length, 1);
  assert.equal(h.state.waits.length, 0);
});

test("upload authorization checks Base/account and signs only the provided message", async () => {
  const h = createHarness();
  const result = await h.signNftUploadMessage("Locally constructed upload authorization", h.wallet);
  assert.equal(result, "0xuploadsignature");
  assert.equal(h.state.accountReads, 1);
  assert.equal(h.state.signCalls.length, 1);
  assert.equal(h.state.signCalls[0].message, "Locally constructed upload authorization");
  assert.equal(h.state.walletClients[0].account, ADDRESS);
  assert.equal(h.state.providerRequests.length, 0);
});

test("changed wallet account cannot sign the old run's upload authorization", async () => {
  const h = createHarness();
  h.state.accounts = [OTHER_CONTRACT];
  await assert.rejects(h.signNftUploadMessage("Upload authorization", h.wallet), /account changed/);
  assert.equal(h.state.signCalls.length, 0);
});

test("disconnected wallet cannot sign the old run's upload authorization", async () => {
  const h = createHarness();
  h.state.accounts = [];
  await assert.rejects(h.assertNftWalletAccount(h.wallet), /account changed/);
  assert.equal(h.state.signCalls.length, 0);
});

test("account switch while Base network check awaits is detected before signing", async () => {
  const h = createHarness({ onChainRead(state) { state.accounts = [OTHER_CONTRACT]; } });
  await assert.rejects(h.signNftUploadMessage("Upload authorization", h.wallet), /account changed/);
  assert.equal(h.state.signCalls.length, 0);
});

test("signature cancellation is propagated unchanged with no automatic second prompt", async () => {
  const failure = Object.assign(new Error("User rejected request"), { code: 4001 });
  const h = createHarness({ signError: failure });
  await assert.rejects(h.signNftUploadMessage("Upload authorization", h.wallet), (error) => error === failure);
  assert.equal(h.state.signCalls.length, 1);
  assert.equal(h.state.providerRequests.length, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mintGuard(h) {
  return async () => {
    h.state.guardCalls += 1;
    await h.assertNftWalletAccount(h.wallet);
    if (!h.state.currentRun) throw new Error("run_changed");
    if (h.state.proofExpiresAt <= h.state.now) throw new Error("unverified_or_expired_preparation");
  };
}

function startMint(h, guard = mintGuard(h)) {
  return h.mintRunNft(CONTRACT, 43, 1, TOKEN_URI, h.wallet, guard);
}

function assertNoMintSend(h) {
  assert.equal(h.state.transactions.length, 0, "No normal transaction may reach the wallet");
  assert.equal(h.state.sponsoredCalls.length, 0, "No sponsored transaction may reach the wallet");
}

for (const [name, options, sponsored] of [
  ["normal", {}, false],
  ["unsupported sponsorship fallback", { sponsorshipConfigured: true, sponsorshipSupported: false }, false],
  ["sponsored", { sponsorshipConfigured: true, sponsorshipSupported: true }, true],
]) {
  test(`${name} mint invokes the final proof guard before exactly one transaction`, async () => {
    const h = createHarness({ mintMode: true, ...options });
    const result = await startMint(h, async () => {
      assertNoMintSend(h);
      await mintGuard(h)();
    });
    assert.equal(result, TX);
    assert.ok(h.state.guardCalls >= 1);
    assert.equal(h.state.transactions.length, sponsored ? 0 : 1);
    assert.equal(h.state.sponsoredCalls.length, sponsored ? 1 : 0);
    const data = sponsored ? h.state.sponsoredCalls[0].calls[0].data : h.state.transactions[0].data;
    const decoded = viem.decodeFunctionData({ abi: abiModule.runNftAbi, data });
    assert.equal(decoded.functionName, "mintRun");
    assert.deepEqual(decoded.args, [43n, 1, TOKEN_URI]);
  });
}

for (const [stage, options, hook] of [
  ["Base chain check", {}, "onChainRead"],
  ["Base chain switch", { chainId: 1 }, "onProviderRequest"],
  ["supported capability lookup", { sponsorshipConfigured: true, sponsorshipSupported: true }, "onCapability"],
  ["unsupported capability lookup", { sponsorshipConfigured: true, sponsorshipSupported: false }, "onCapability"],
]) {
  for (const [change, mutate, expected] of [
    ["run changed", (state) => { state.currentRun = false; }, /run_changed/],
    ["account changed", (state) => { state.accounts = [OTHER_CONTRACT]; }, /account changed/],
    ["proof expired", (state) => { state.now = state.proofExpiresAt; }, /unverified_or_expired_preparation/],
  ]) {
    test(`${change} during ${stage} stops both transaction paths`, async () => {
      const entered = deferred();
      const released = deferred();
      const h = createHarness({
        mintMode: true, ...options,
        [hook]: async () => { entered.resolve(); await released.promise; },
      });
      const pending = startMint(h);
      await entered.promise;
      assertNoMintSend(h);
      mutate(h.state);
      released.resolve();
      await assert.rejects(pending, expected);
      assertNoMintSend(h);
    });
  }
}

for (const sponsorshipSupported of [false, true]) {
  test(`proof expires while final account check awaits (${sponsorshipSupported ? "sponsored" : "normal"}) and no mint is sent`, async () => {
    const entered = deferred();
    const released = deferred();
    const h = createHarness({
      mintMode: true, sponsorshipConfigured: true, sponsorshipSupported,
      onAccountRead: async () => { entered.resolve(); await released.promise; },
    });
    const pending = startMint(h);
    await entered.promise;
    h.state.now = h.state.proofExpiresAt;
    released.resolve();
    await assert.rejects(pending, /unverified_or_expired_preparation/);
    assertNoMintSend(h);
  });
}

function createGaslessHarness(options = {}) {
  const state = { requests: [], guards: 0, valid: true, acknowledged: [], now: 0 };
  class Clock extends Date { static now() { return state.now; } }
  const implementation = loadTs("lib/gasless.ts", {
    "@/lib/builderCodes": { appendErc8021Suffix: (value) => value },
  }, {
    process: { env: { NEXT_PUBLIC_PAYMASTER_PROXY_SERVER_URL: "https://paymaster-test.invalid" } },
    setTimeout: options.mockClock ? (callback, ms) => { state.now += ms; queueMicrotask(callback); return 0; } : setTimeout,
    clearTimeout,
    ...(options.mockClock ? { Date: Clock } : {}),
  });
  const provider = {
    async request(request) {
      state.requests.push(request);
      if (request.method === "wallet_sendCalls") {
        const first = state.requests.filter((r) => r.method === "wallet_sendCalls").length === 1;
        if (first && options.invalidParams) {
          await options.beforeInvalidParams?.(state);
          throw Object.assign(new Error("unsupported version"), { code: -32602 });
        }
        if (options.rejection) throw options.rejection;
        return "local-test-batch";
      }
      assert.equal(request.method, "wallet_getCallsStatus");
      await options.onStatus?.(state);
      if (options.statusError) throw options.statusError;
      if (options.pendingStatus) return { status: 100 };
      if (options.failedStatus) return { status: 500 };
      return { status: 200, receipts: [{ transactionHash: TX }] };
    },
  };
  const input = {
    provider, chainIdHex: "0x2105", from: ADDRESS,
    calls: [{ to: CONTRACT, value: "0x0", data: "0x1234" }],
    beforeSend: async () => {
      state.guards += 1;
      if (!state.valid) throw options.guardError ?? new Error("run_changed");
    },
    onSubmitted: async (submission) => {
      state.acknowledged.push(submission);
      await options.onSubmitted?.(submission, state);
    },
  };
  return { ...implementation, state, input };
}

test("actual gasless sender runs guard before the initial wallet_sendCalls", async () => {
  const h = createGaslessHarness();
  const result = await h.sendSponsoredCallsAndGetTxHash(h.input);
  assert.equal(result, TX);
  assert.equal(h.state.guards, 1);
  assert.deepEqual(h.state.requests.map((r) => r.method), ["wallet_sendCalls", "wallet_getCallsStatus"]);
});

test("actual gasless sender repeats guard before legacy-version fallback", async () => {
  const h = createGaslessHarness({ invalidParams: true });
  const result = await h.sendSponsoredCallsAndGetTxHash(h.input);
  assert.equal(result, TX);
  assert.equal(h.state.guards, 2);
  assert.deepEqual(h.state.requests.filter((r) => r.method === "wallet_sendCalls").map((r) => r.params[0].version), ["2.0.0", "1.0"]);
});

test("state invalidated while initial sponsored call rejects stops the legacy fallback", async () => {
  const h = createGaslessHarness({ invalidParams: true, beforeInvalidParams(state) { state.valid = false; } });
  await assert.rejects(h.sendSponsoredCallsAndGetTxHash(h.input), /run_changed/);
  assert.equal(h.state.guards, 2);
  assert.deepEqual(h.state.requests.map((r) => r.method), ["wallet_sendCalls"]);
});

test("initial gasless guard errors mentioning version do not trigger compatibility fallback", async () => {
  const error = new Error("prepared version expired");
  const h = createGaslessHarness({ guardError: error });
  h.state.valid = false;
  await assert.rejects(h.sendSponsoredCallsAndGetTxHash(h.input), (received) => received === error);
  assert.equal(h.state.guards, 1);
  assert.equal(h.state.requests.length, 0);
});

test("wallet rejection in actual gasless sender never retries a second prompt", async () => {
  const rejection = Object.assign(new Error("User rejected"), { code: 4001 });
  const h = createGaslessHarness({ rejection });
  await assert.rejects(h.sendSponsoredCallsAndGetTxHash(h.input), (received) => received === rejection);
  assert.equal(h.state.guards, 1);
  assert.deepEqual(h.state.requests.map((r) => r.method), ["wallet_sendCalls"]);
});

test("actual viem client sends one guarded eth_sendTransaction with the prepared URI", async () => {
  const h = createHarness({ mintMode: true, realWalletClient: true });
  assert.equal(await startMint(h), TX);
  assert.deepEqual(h.state.providerRequests.map((request) => request.method), ["eth_chainId", "eth_sendTransaction"]);
  assert.equal(h.state.transactions.length, 1);
  assert.ok(h.state.guardCalls >= 2);
  const decoded = viem.decodeFunctionData({ abi: abiModule.runNftAbi, data: h.state.transactions[0].params[0].data });
  assert.deepEqual(decoded.args, [43n, 1, TOKEN_URI]);
});

for (const [change, mutate, expected] of [
  ["run changes", (state) => { state.currentRun = false; }, /run_changed/],
  ["account changes", (state) => { state.accounts = [OTHER_CONTRACT]; }, /account changed/],
  ["proof expires", (state) => { state.now = state.proofExpiresAt; }, /unverified_or_expired_preparation/],
]) {
  test(`actual viem internal chain-read delay cannot submit when ${change}`, async () => {
    const entered = deferred();
    const released = deferred();
    const h = createHarness({
      mintMode: true, realWalletClient: true,
      onProviderRequest: async (request) => {
        if (request.method === "eth_chainId") { entered.resolve(); await released.promise; }
      },
    });
    const pending = startMint(h);
    await entered.promise;
    mutate(h.state);
    released.resolve();
    await assert.rejects(pending, expected);
    assert.deepEqual(h.state.providerRequests.map((request) => request.method), ["eth_chainId"]);
    assertNoMintSend(h);
  });
}

test("actual viem wrapper preserves original preparation error identity after its internal await", async () => {
  const error = Object.assign(new Error("unverified_or_expired_preparation"), { reason: "unverified_or_expired_preparation" });
  const h = createHarness({ mintMode: true, realWalletClient: true, onProviderRequest(request, state) {
    if (request.method === "eth_chainId") state.currentRun = false;
  } });
  await assert.rejects(startMint(h, () => { if (!h.state.currentRun) throw error; }), (received) => received === error);
  assertNoMintSend(h);
});

test("actual viem unsupported-method fallback rechecks state before wallet_sendTransaction", async () => {
  const h = createHarness({ mintMode: true, realWalletClient: true, onProviderRequest(request, state) {
    if (request.method === "eth_sendTransaction") {
      state.currentRun = false;
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    }
  } });
  await assert.rejects(startMint(h), /run_changed/);
  assert.deepEqual(h.state.providerRequests.map((request) => request.method), ["eth_chainId", "eth_sendTransaction"]);
  assertNoMintSend(h);
});

test("accepted sponsored callsId is acknowledged and awaited before any status polling", async () => {
  const accepted = deferred();
  const durable = deferred();
  const h = createGaslessHarness({
    onSubmitted: async (submission) => {
      assert.equal(submission.callsId, "local-test-batch");
      accepted.resolve();
      await durable.promise;
    },
  });
  const pending = h.sendSponsoredCallsAndGetTxHash(h.input);
  await accepted.promise;
  assert.deepEqual(h.state.requests.map((request) => request.method), ["wallet_sendCalls"]);
  durable.resolve();
  assert.equal(await pending, TX);
  assert.equal(h.state.acknowledged.length, 1);
});

test("RPC status failure after accepted sponsored batch preserves callsId and never resubmits", async () => {
  const h = createGaslessHarness({ statusError: new Error("RPC unavailable") });
  await assert.rejects(h.sendSponsoredCallsAndGetTxHash({ ...h.input, timeoutMs: 100 }), (error) => {
    assert.ok(error instanceof h.SponsoredCallsPendingError);
    assert.equal(error.callsId, "local-test-batch");
    return true;
  });
  assert.equal(h.state.acknowledged.length, 1);
  assert.deepEqual(h.state.requests.map((request) => request.method), ["wallet_sendCalls", "wallet_getCallsStatus"]);
});

test("sponsored polling timeout retains accepted callsId for chain-only retry", async () => {
  const h = createGaslessHarness({ pendingStatus: true, mockClock: true });
  await assert.rejects(h.sendSponsoredCallsAndGetTxHash({ ...h.input, timeoutMs: 10 }), (error) => {
    assert.ok(error instanceof h.SponsoredCallsPendingError);
    assert.equal(error.callsId, "local-test-batch");
    return true;
  });
  assert.equal(h.state.acknowledged.length, 1);
  assert.equal(h.state.requests.filter((request) => request.method === "wallet_sendCalls").length, 1);
});

test("storage acknowledgement failure after batch acceptance never sends a second transaction", async () => {
  const h = createGaslessHarness({ onSubmitted: async () => { throw new Error("Local storage unavailable"); } });
  await assert.rejects(h.sendSponsoredCallsAndGetTxHash(h.input), (error) => {
    assert.ok(error instanceof h.SponsoredCallsPendingError);
    assert.equal(error.callsId, "local-test-batch");
    return true;
  });
  assert.deepEqual(h.state.requests.map((request) => request.method), ["wallet_sendCalls"]);
});

test("definitive sponsored failure is distinct from an uncertain pending status", async () => {
  const h = createGaslessHarness({ failedStatus: true });
  await assert.rejects(h.sendSponsoredCallsAndGetTxHash(h.input), (error) => error instanceof h.SponsoredCallsFailedError);
  assert.equal(h.state.acknowledged.length, 1);
  assert.equal(h.state.requests.filter((request) => request.method === "wallet_sendCalls").length, 1);
});

test("sponsored retry resolves only the existing batch via one read-only wallet status call", async () => {
  const h = createHarness({ onProviderRequest(request) {
    assert.equal(request.method, "wallet_getCallsStatus");
    assert.deepEqual(Array.from(request.params), ["existing-batch"]);
    return { status: 200, receipts: [{ transactionHash: TX }] };
  } });
  assert.equal(await h.resolveSponsoredMintTransaction("existing-batch", ADDRESS, h.wallet), TX);
  assert.equal(h.state.accountReads, 1);
  assert.equal(h.state.providerRequests.length, 1);
  assert.equal(h.state.signCalls.length, 0);
  assertNoMintSend(h);
});

for (const walletState of ["missing", "different cached account", "changed provider account"]) {
  test(`sponsored retry with ${walletState} stays pending without wallet prompts or reads on another wallet`, async () => {
    const h = createHarness();
    const wallet = walletState === "missing" ? undefined : h.wallet;
    if (walletState === "different cached account") wallet.address = OTHER_CONTRACT;
    if (walletState === "changed provider account") h.state.accounts = [OTHER_CONTRACT];
    await assert.rejects(h.resolveSponsoredMintTransaction("existing-batch", ADDRESS, wallet), (error) => {
      assert.ok(error instanceof gaslessModule.SponsoredCallsPendingError);
      assert.equal(error.callsId, "existing-batch");
      return true;
    });
    assert.equal(h.state.providerRequests.length, 0);
    assertNoMintSend(h);
  });
}

for (const [label, response] of [
  ["still pending", { status: 100 }],
  ["legacy PENDING", { status: "PENDING" }],
  ["unknown status", { status: 0 }],
  ["missing hash", { status: 200, receipts: [] }],
  ["malformed hash", { status: 200, receipts: [{ transactionHash: "not-a-hash" }] }],
]) {
  test(`sponsored retry ${label} remains pending and never sends another batch`, async () => {
    const h = createHarness({ onProviderRequest: () => response });
    await assert.rejects(h.resolveSponsoredMintTransaction("existing-batch", ADDRESS, h.wallet), (error) => error instanceof gaslessModule.SponsoredCallsPendingError);
    assert.deepEqual(h.state.providerRequests.map((request) => request.method), ["wallet_getCallsStatus"]);
    assertNoMintSend(h);
  });
}

test("sponsored retry definitive failure becomes a reverted transaction, not another mint", async () => {
  const h = createHarness({ onProviderRequest: () => ({ status: 500 }) });
  await assert.rejects(h.resolveSponsoredMintTransaction("existing-batch", ADDRESS, h.wallet), { code: "TRANSACTION_REVERTED" });
  assert.deepEqual(h.state.providerRequests.map((request) => request.method), ["wallet_getCallsStatus"]);
  assertNoMintSend(h);
});

for (const status of ["CONFIRMED", 201]) {
  test(`sponsored retry accepts ${status} with a real hash but confirms NFT only from its actual receipt`, async () => {
    const h = createHarness({ onProviderRequest: () => ({ status, receipts: [{ transactionHash: TX }] }) });
    const txHash = await h.resolveSponsoredMintTransaction("existing-batch", ADDRESS, h.wallet);
    assert.equal(txHash, TX);
    assert.equal(h.state.reads.length, 0, "A batch status alone has not verified the NFT event");
    const result = await h.confirmPreparedRunNft(txHash, CONTRACT, TOKEN_URI, true);
    assert.equal(result.openSeaUrl, `https://opensea.io/item/base/${CONTRACT}/244`);
    assert.equal(h.state.reads.length, 1);
    assertNoMintSend(h);
  });
}

test("legacy CONFIRMED batch without a matching RunMinted receipt cannot report NFT success", async () => {
  const h = createHarness({
    onProviderRequest: () => ({ status: "CONFIRMED", receipts: [{ transactionHash: TX }] }),
    receipt: { logs: [] },
  });
  const txHash = await h.resolveSponsoredMintTransaction("existing-batch", ADDRESS, h.wallet);
  await assert.rejects(h.confirmPreparedRunNft(txHash, CONTRACT, TOKEN_URI, true), { code: "TRANSACTION_REVERTED" });
  assertNoMintSend(h);
});
