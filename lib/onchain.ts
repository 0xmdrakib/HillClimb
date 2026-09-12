"use client";

import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  parseEther,
  type Address,
} from "viem";

import {
  getEthereumProvider,
  requestAccounts,
  getAccounts,
  getChainId,
  type Eip1193Provider,
  type EthereumProviderOptions,
} from "@/lib/wallet";
import { scoreboardAbi, runNftAbi } from "@/lib/onchainAbi";
import {
  isPaymasterServiceConfigured,
  primePaymasterServiceSupport,
  supportsPaymasterService,
  sendSponsoredCallsAndGetTxHash,
  getSponsoredCallsTransactionHash,
  SponsoredCallsFailedError,
  SponsoredCallsPendingError,
} from "@/lib/gasless";
import { appendErc8021Suffix, ERC8021_DATA_SUFFIX } from "@/lib/builderCodes";

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_ID_HEX = "0x2105";
const BASE_CHAIN = defineChain({
  id: BASE_CHAIN_ID,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["/api/rpc"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
});

function isUserRejected(e: unknown): boolean {
  const err = e as any;
  const code = err?.code ?? err?.data?.code ?? err?.data?.originalError?.code;
  if (code === 4001) return true; // EIP-1193 userRejectedRequest
  const msg = String(err?.message ?? e);
  return /user rejected|rejected the request|request rejected|cancelled|canceled/i.test(msg);
}

async function trySponsoredWriteContract(params: {
  provider: Eip1193Provider;
  from: Address;
  to: Address;
  abi: any;
  functionName: string;
  args: any[];
  beforeSend?: () => void | Promise<void>;
  onSubmitted?: (submission: { callsId: string }) => void | Promise<void>;
}): Promise<`0x${string}` | null> {
  if (!isPaymasterServiceConfigured()) return null;

  // Only attempt gas sponsorship when the wallet reports support.
  const supported = await supportsPaymasterService({
    provider: params.provider,
    from: params.from as `0x${string}`,
    chainIdHex: BASE_CHAIN_ID_HEX,
  });
  if (!supported) return null;

  let guardFailed = false;
  const beforeSend = params.beforeSend ? async () => {
    try { await params.beforeSend!(); }
    catch (error) { guardFailed = true; throw error; }
  } : undefined;
  try {
    const data = appendErc8021Suffix(encodeFunctionData({
      abi: params.abi,
      functionName: params.functionName as any,
      args: params.args as any,
    }) as `0x${string}`);

    return await sendSponsoredCallsAndGetTxHash({
      provider: params.provider,
      chainIdHex: BASE_CHAIN_ID_HEX,
      from: params.from as `0x${string}`,
      calls: [{ to: params.to as `0x${string}`, value: "0x0", data }],
      beforeSend,
      onSubmitted: params.onSubmitted,
    });
  } catch (e) {
    // A stale run/account/preparation is not a gasless provider error. Preserve
    // the original typed guard failure so the UI cannot mistake it for a tx.
    if (guardFailed) throw e;
    if (e instanceof SponsoredCallsPendingError) throw e;
    if (e instanceof SponsoredCallsFailedError) throw new TransactionRevertedError();
    // Ensure *one* wallet prompt total:
    // - If the wallet supports gasless, we do NOT fall back to a second onchain prompt if sponsorship fails.
    // - If the user rejects, we surface that rejection.
    if (isUserRejected(e)) throw e;

    const msg = (e as any)?.message ? String((e as any).message) : String(e);
    throw new Error(`Gasless transaction failed: ${msg}`);
  }
}

function getRpcProxyUrl() {
  if (typeof window === "undefined") return "/api/rpc";
  return new URL("/api/rpc", window.location.origin).toString();
}

const publicClient = createPublicClient({
  chain: BASE_CHAIN,
  transport: http(getRpcProxyUrl()),
});

export async function ensureBaseMainnet(provider?: Eip1193Provider) {
  const p = provider ?? (await getEthereumProvider());
  if (!p) throw new Error("No wallet provider found");

  const chainId = await getChainId(p);
  if (chainId === BASE_CHAIN_ID) return;

  try {
    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (err: any) {
    const code = err?.code ?? err?.data?.originalError?.code;
    if (code !== 4902) {
      const msg = err?.message ? String(err.message) : "Failed to switch network";
      throw new Error(msg);
    }

    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: BASE_CHAIN_ID_HEX,
          chainName: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [getRpcProxyUrl()],
          blockExplorerUrls: ["https://basescan.org"],
        },
      ],
    });

    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  }
}

export async function connectWallet(
  opts?: EthereumProviderOptions,
): Promise<{ provider: Eip1193Provider; address: Address }> {
  const provider = await getEthereumProvider(opts);
  if (!provider) throw new Error("No wallet provider found");

  // Prefer a silent check first (no popups).
  const existing = await getAccounts(provider);
  const a0 = existing?.[0];
  if (a0) return { provider, address: a0 as Address };

  // Otherwise, request accounts (may prompt).
  const requested = await requestAccounts(provider);
  const r0 = requested?.[0];
  if (!r0) throw new Error("Wallet connection rejected");

  return { provider, address: r0 as Address };
}

export type ConnectedWallet = { provider: Eip1193Provider; address: Address };
let cachedWallet: ConnectedWallet | null = null;

function primePaymasterCapability(wallet: ConnectedWallet) {
  primePaymasterServiceSupport({
    provider: wallet.provider,
    from: wallet.address as `0x${string}`,
    chainIdHex: BASE_CHAIN_ID_HEX,
  });
}

/**
 * Cache the connected wallet to avoid double prompts.
 */
export async function getOrConnectWallet(opts?: EthereumProviderOptions): Promise<ConnectedWallet> {
  if (cachedWallet) {
    primePaymasterCapability(cachedWallet);
    return cachedWallet;
  }
  const w = await connectWallet(opts);
  cachedWallet = w;
  primePaymasterCapability(w);
  return w;
}

export function primeCachedWallet(wallet: ConnectedWallet | null) {
  cachedWallet = wallet;
  if (wallet) primePaymasterCapability(wallet);
}

export function clearCachedWallet() {
  cachedWallet = null;
}

/**
 * Silent auto-connect helper: returns null if not already connected (no popups).
 * This is used on normal web to reconnect the last-used injected wallet.
 */
export async function tryAutoConnectWallet(opts?: EthereumProviderOptions): Promise<ConnectedWallet | null> {
  const provider = await getEthereumProvider(opts);
  if (!provider) return null;
  const accounts = await getAccounts(provider);
  const a0 = accounts?.[0];
  if (!a0) return null;
  const w = { provider, address: a0 as Address };
  cachedWallet = w;
  primePaymasterCapability(w);
  return w;
}

function getWalletClient(provider: Eip1193Provider, address: Address) {
  return createWalletClient({
    chain: BASE_CHAIN,
    transport: custom(provider),
    account: address,
  });
}

export async function assertNftWalletAccount(wallet: ConnectedWallet): Promise<void> {
  const accounts = await getAccounts(wallet.provider);
  if (accounts[0]?.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("NFT wallet account changed");
  }
}

/** An upload authorization only; this does not submit a chain transaction. */
export async function signNftUploadMessage(message: string, wallet: ConnectedWallet): Promise<`0x${string}`> {
  await ensureBaseMainnet(wallet.provider);
  await assertNftWalletAccount(wallet);
  return getWalletClient(wallet.provider, wallet.address).signMessage({ message });
}

export async function readBestMeters(scoreboardAddress: string, playerAddress: string): Promise<bigint> {
  if (!scoreboardAddress) return 0n;

  return (await publicClient.readContract({
    address: scoreboardAddress as Address,
    abi: scoreboardAbi,
    functionName: "bestMeters",
    args: [playerAddress as Address],
  })) as bigint;
}

export async function submitScoreMeters(
  scoreboardAddress: string,
  meters: number,
  wallet?: ConnectedWallet,
): Promise<string> {
  const { provider, address } = wallet ?? (await getOrConnectWallet());
  await ensureBaseMainnet(provider);

  const m = BigInt(Math.max(0, Math.floor(meters)));

  const sponsored = await trySponsoredWriteContract({
    provider,
    from: address,
    to: scoreboardAddress as Address,
    abi: scoreboardAbi,
    functionName: "submitScore",
    args: [m],
  });
  if (sponsored) return String(sponsored);

  const client = getWalletClient(provider, address);

  const data = appendErc8021Suffix(
    encodeFunctionData({
      abi: scoreboardAbi,
      functionName: "submitScore",
      args: [m],
    }) as `0x${string}`,
  );

  const hash = await client.sendTransaction({
    to: scoreboardAddress as Address,
    data,
  });

  return String(hash);
}

export async function mintRunNft(
  runNftAddress: string,
  meters: number,
  driverId: number,
  tokenUri: string,
  wallet?: ConnectedWallet,
  beforeSend?: () => void | Promise<void>,
  onSubmitted?: (submission: { callsId: string }) => void | Promise<void>,
): Promise<string> {
  const { provider, address } = wallet ?? (await getOrConnectWallet());
  await ensureBaseMainnet(provider);
  const guardBeforeSend = async () => {
    // Chain switching and capability detection may await wallet interaction.
    // Recheck the real account and caller's run/expiry at the send boundary.
    await assertNftWalletAccount({ provider, address });
    await beforeSend?.();
  };

  const m = BigInt(Math.max(0, Math.floor(meters)));
  const did = Math.max(0, Math.min(255, Math.floor(driverId)));

  const sponsored = await trySponsoredWriteContract({
    provider,
    from: address,
    to: runNftAddress as Address,
    abi: runNftAbi,
    functionName: "mintRun",
    args: [m, did, tokenUri],
    beforeSend: guardBeforeSend,
    onSubmitted,
  });
  if (sponsored) return String(sponsored);

  let sendGuardFailed = false;
  let sendGuardFailure: unknown;
  const guardedProvider: Eip1193Provider = {
    request: async (request) => {
      if (request.method === "eth_sendTransaction" || request.method === "wallet_sendTransaction") {
        // Viem itself awaits eth_chainId and can fall back between these two
        // methods. Guard the final provider boundary after those awaits too.
        if (sendGuardFailed) throw sendGuardFailure;
        try { await guardBeforeSend(); }
        catch (error) { sendGuardFailed = true; sendGuardFailure = error; throw error; }
      }
      return provider.request(request);
    },
  };
  const client = getWalletClient(guardedProvider, address);

  const data = appendErc8021Suffix(
    encodeFunctionData({
      abi: runNftAbi,
      functionName: "mintRun",
      args: [m, did, tokenUri],
    }) as `0x${string}`,
  );

  await guardBeforeSend();
  try {
    const hash = await client.sendTransaction({
      to: runNftAddress as Address,
      data,
    });
    return String(hash);
  } catch (error) {
    // Viem wraps provider errors; preserve the caller's preparation error class.
    if (sendGuardFailed) throw sendGuardFailure;
    throw error;
  }
}

/** Resolve an accepted NFT batch without reconnecting, resending, or uploading. */
export async function resolveSponsoredMintTransaction(
  callsId: string,
  walletAddress: string,
  wallet?: ConnectedWallet,
): Promise<string> {
  if (!wallet || wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new SponsoredCallsPendingError(callsId);
  }
  try {
    await assertNftWalletAccount(wallet);
    return await getSponsoredCallsTransactionHash(wallet.provider, callsId);
  } catch (error) {
    if (error instanceof SponsoredCallsFailedError) throw new TransactionRevertedError();
    throw new SponsoredCallsPendingError(callsId);
  }
}

async function waitForBaseReceipt(transactionHash: string) {
  let replacementReason: "cancelled" | "replaced" | "repriced" | null = null;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash as `0x${string}`,
    confirmations: 1,
    pollingInterval: 1_200,
    timeout: 180_000,
    onReplaced: ({ reason }) => { replacementReason = reason; },
  });
  if (receipt.status !== "success" || replacementReason === "cancelled" || replacementReason === "replaced") {
    throw new TransactionRevertedError();
  }
  return receipt;
}

export async function waitForBaseTransaction(transactionHash: string): Promise<string> {
  return (await waitForBaseReceipt(transactionHash)).transactionHash;
}

/** Confirm a prepared NFT from its actual event, without any storage request. */
export async function confirmPreparedRunNft(
  transactionHash: string,
  contract: string,
  tokenUri: string,
  checkOnly = false,
): Promise<{ txHash: string; openSeaUrl: string }> {
  const receipt = checkOnly
    ? await publicClient.getTransactionReceipt({ hash: transactionHash as `0x${string}` })
    : await waitForBaseReceipt(transactionHash);
  if (receipt.status !== "success") throw new TransactionRevertedError();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: runNftAbi, data: log.data, topics: log.topics });
      if (decoded.eventName !== "RunMinted" || decoded.args.tokenURI !== tokenUri) continue;
      return {
        txHash: receipt.transactionHash,
        openSeaUrl: `https://opensea.io/item/base/${contract}/${decoded.args.tokenId.toString()}`,
      };
    } catch { /* Other contract events do not confirm this NFT. */ }
  }
  throw new TransactionRevertedError();
}

export class TransactionRevertedError extends Error {
  readonly code = "TRANSACTION_REVERTED";

  constructor() {
    super("Transaction failed");
    this.name = "TransactionRevertedError";
  }
}


export async function sendEthTip(
  to: string,
  amountEth: string,
  wallet?: ConnectedWallet,
): Promise<string> {
  const { provider, address } = wallet ?? (await getOrConnectWallet());
  await ensureBaseMainnet(provider);

  const client = getWalletClient(provider, address);
  const hash = await client.sendTransaction({
    to: to as Address,
    value: parseEther(amountEth),
    ...(ERC8021_DATA_SUFFIX ? { data: appendErc8021Suffix("0x") } : {}),
  });

  return String(hash);
}
