"use client";

import {
  createPublicClient,
  createWalletClient,
  custom,
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
  supportsPaymasterService,
  sendSponsoredCallsAndGetTxHash,
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
}): Promise<`0x${string}` | null> {
  // Only attempt gas sponsorship when the wallet reports support.
  const supported = await supportsPaymasterService({
    provider: params.provider,
    from: params.from as `0x${string}`,
    chainIdHex: BASE_CHAIN_ID_HEX,
  });
  if (!supported) return null;

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
    });
  } catch (e) {
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

type ConnectedWallet = { provider: Eip1193Provider; address: Address };
let cachedWallet: ConnectedWallet | null = null;

/**
 * Cache the connected wallet to avoid double prompts.
 */
export async function getOrConnectWallet(opts?: EthereumProviderOptions): Promise<ConnectedWallet> {
  if (cachedWallet) return cachedWallet;
  const w = await connectWallet(opts);
  cachedWallet = w;
  return w;
}

export function primeCachedWallet(wallet: ConnectedWallet | null) {
  cachedWallet = wallet;
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
  return w;
}

function getWalletClient(provider: Eip1193Provider, address: Address) {
  return createWalletClient({
    chain: BASE_CHAIN,
    transport: custom(provider),
    account: address,
  });
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

export async function getNextTokenId(runNftAddress: string): Promise<bigint> {
  if (!runNftAddress) return 1n;

  return (await publicClient.readContract({
    address: runNftAddress as Address,
    abi: runNftAbi,
    functionName: "nextTokenId",
    args: [],
  })) as bigint;
}

export async function mintRunNft(
  runNftAddress: string,
  meters: number,
  driverId: number,
  tokenUri: string,
  wallet?: ConnectedWallet,
): Promise<string> {
  const { provider, address } = wallet ?? (await getOrConnectWallet());
  await ensureBaseMainnet(provider);

  const m = BigInt(Math.max(0, Math.floor(meters)));
  const did = Math.max(0, Math.min(255, Math.floor(driverId)));

  const sponsored = await trySponsoredWriteContract({
    provider,
    from: address,
    to: runNftAddress as Address,
    abi: runNftAbi,
    functionName: "mintRun",
    args: [m, did, tokenUri],
  });
  if (sponsored) return String(sponsored);

  const client = getWalletClient(provider, address);

  const data = appendErc8021Suffix(
    encodeFunctionData({
      abi: runNftAbi,
      functionName: "mintRun",
      args: [m, did, tokenUri],
    }) as `0x${string}`,
  );

  const hash = await client.sendTransaction({
    to: runNftAddress as Address,
    data,
  });

  return String(hash);
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
