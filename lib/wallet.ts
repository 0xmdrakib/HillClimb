"use client";

export type Eip1193Provider = {
  request: (args: { method: string; params?: any }) => Promise<any>;
  disconnect?: () => Promise<void>;
};

export type EthereumProviderOptions = {
  /** Use an already-created EIP-1193 provider (for example WalletConnect). */
  provider?: Eip1193Provider;
  /** Prefer a specific injected wallet when multiple are present. */
  prefer?: "any" | "metamask" | "coinbase";
  /** If provided, pick a specific injected wallet by id (EIP-6963 rdns/uuid, or fallback injected id). */
  walletId?: string;
};

type EIP6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns?: string;
};

type EIP6963ProviderDetail = {
  info: EIP6963ProviderInfo;
  provider: Eip1193Provider;
};

export type InjectedWallet = {
  id: string;
  name: string;
  icon?: string;
  rdns?: string;
  provider: Eip1193Provider;
};

export const WALLETCONNECT_WALLET_ID = "walletconnect";
let walletConnectProviderPromise: Promise<Eip1193Provider> | null = null;

/** Initialize WalletConnect without opening its modal. Calling enable() opens the QR/deep-link UI. */
export async function getWalletConnectProvider(): Promise<Eip1193Provider> {
  if (typeof window === "undefined") throw new Error("WalletConnect is only available in the browser");
  const projectId = (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "").trim();
  if (!projectId) throw new Error("WalletConnect is not configured");
  if (walletConnectProviderPromise) return walletConnectProviderPromise;

  walletConnectProviderPromise = (async () => {
    const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
    const origin = window.location.origin;
    const provider = await EthereumProvider.init({
      projectId,
      metadata: {
        name: "Jesse Hill Climb",
        description: "A hill climb racing game on Base",
        url: origin,
        icons: [`${origin}/icon.png`],
      },
      showQrModal: true,
      optionalChains: [8453],
      optionalMethods: [
        "eth_accounts",
        "eth_requestAccounts",
        "eth_sendTransaction",
        "personal_sign",
        "eth_signTypedData",
        "eth_signTypedData_v4",
        "wallet_switchEthereumChain",
        "wallet_addEthereumChain",
        "wallet_getCapabilities",
        "wallet_sendCalls",
        "wallet_getCallsStatus",
      ],
      optionalEvents: ["accountsChanged", "chainChanged", "disconnect"],
      rpcMap: { 8453: `${origin}/api/rpc` },
      qrModalOptions: {
        themeMode: "dark",
        enableExplorer: true,
      },
    });
    return provider as unknown as Eip1193Provider;
  })().catch((error) => {
    walletConnectProviderPromise = null;
    throw error;
  });

  return walletConnectProviderPromise;
}

async function discoverEip6963Providers(timeoutMs = 250): Promise<EIP6963ProviderDetail[]> {
  if (typeof window === "undefined") return [];

  const out: EIP6963ProviderDetail[] = [];
  const handler = (ev: any) => {
    const d = ev?.detail;
    if (!d?.provider || typeof d.provider.request !== "function") return;
    if (!d?.info) return;
    out.push(d as EIP6963ProviderDetail);
  };

  try {
    window.addEventListener("eip6963:announceProvider" as any, handler as any);
    window.dispatchEvent(new Event("eip6963:requestProvider" as any));
    await new Promise((r) => setTimeout(r, timeoutMs));
  } finally {
    window.removeEventListener("eip6963:announceProvider" as any, handler as any);
  }

  return out;
}

function compactWalletKey(value: string) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function providerFlagKey(provider: any): string | null {
  if (!provider) return null;
  if (provider.isRabby) return "rabbywallet";
  if (provider.isBackpack) return "backpack";
  if (provider.isPhantom) return "phantom";
  if (provider.isKeplr) return "keplr";
  if (provider.isSubWallet) return "subwallet";
  if (provider.isCoinbaseWallet) return "coinbasewallet";
  if (provider.isMetaMask) return "metamask";
  return null;
}

function knownWalletBrand(value: string): string | null {
  const key = compactWalletKey(value);
  if (key.includes("metamask")) return "metamask";
  if (key.includes("coinbase")) return "coinbasewallet";
  if (key.includes("rabby")) return "rabbywallet";
  if (key.includes("backpack")) return "backpack";
  if (key.includes("phantom")) return "phantom";
  if (key.includes("keplr")) return "keplr";
  if (key.includes("subwallet")) return "subwallet";
  return null;
}

function walletIdentityKeys(wallet: InjectedWallet): string[] {
  const keys = new Set<string>();
  const rdns = compactWalletKey(wallet.rdns ?? "");
  if (rdns) keys.add(`rdns:${rdns}`);

  const rdnsBrand = knownWalletBrand(wallet.rdns ?? "");
  const nameBrand = knownWalletBrand(wallet.name);
  const declaredBrand = rdnsBrand ?? nameBrand;
  const fallbackBrand = providerFlagKey(wallet.provider as any);
  if (declaredBrand) keys.add(`brand:${declaredBrand}`);
  else if (fallbackBrand) keys.add(`brand:${fallbackBrand}`);

  const name = compactWalletKey(wallet.name);
  if (name && name !== "injectedwallet" && name !== "wallet") keys.add(`name:${name}`);

  if (!keys.size) keys.add(`id:${wallet.id}`);
  return [...keys];
}

function dedupeInjectedWallets(arr: InjectedWallet[]): InjectedWallet[] {
  const seenProviders = new Set<any>();
  const seenIdentities = new Set<string>();
  const out: InjectedWallet[] = [];

  for (const wallet of arr) {
    if (!wallet?.provider) continue;

    if (seenProviders.has(wallet.provider as any)) continue;
    seenProviders.add(wallet.provider as any);

    const identities = walletIdentityKeys(wallet);
    if (identities.some((identity) => seenIdentities.has(identity))) continue;
    identities.forEach((identity) => seenIdentities.add(identity));

    out.push(wallet);
  }

  return out;
}

function normalizeWalletName(name: string) {
  const n = String(name ?? "").trim();
  if (!n) return "Injected wallet";
  return n.length > 32 ? n.slice(0, 32) + "…" : n;
}

function walletIdFromEip6963(info: EIP6963ProviderInfo): string {
  const rdns = (info?.rdns ?? "").trim();
  if (rdns) return `eip6963:${rdns.toLowerCase()}`;
  const uuid = (info?.uuid ?? "").trim();
  return uuid ? `eip6963:${uuid}` : "eip6963:unknown";
}

function fallbackWalletLabel(p: any) {
  if (p?.isRabby) return "Rabby Wallet";
  if (p?.isKeplr) return "Keplr";
  if (p?.isSubWallet) return "SubWallet";
  if (p?.isPhantom) return "Phantom";
  if (p?.isBackpack) return "Backpack";
  if (p?.isCoinbaseWallet) return "Coinbase Wallet";
  if (p?.isMetaMask) return "MetaMask";
  return "Injected wallet";
}

/**
 * List injected wallets in the browser.
 * Uses EIP-6963 multi-provider discovery when available, plus the legacy providers array when present.
 */
export async function listInjectedWallets(timeoutMs = 600): Promise<InjectedWallet[]> {
  if (typeof window === "undefined") return [];

  const out: InjectedWallet[] = [];

  // 1) EIP-6963
  try {
    const announced = await discoverEip6963Providers(timeoutMs);
    for (const d of announced) {
      if (!d?.provider) continue;
      const id = walletIdFromEip6963(d.info);
      out.push({
        id,
        name: normalizeWalletName(d.info?.name ?? "Wallet"),
        icon: d.info?.icon,
        rdns: d.info?.rdns,
        provider: d.provider,
      });
    }
  } catch {
    // ignore
  }

  // 2) Legacy injected-provider fallback. This also covers the Base App's
  // standard in-app browser when it exposes a single EIP-1193 provider.
  try {
    const anyWin: any = window as any;
    const eth: any = anyWin.ethereum;
    const providers: any[] | undefined = Array.isArray(eth?.providers) ? eth.providers : undefined;

    if (providers && providers.length) {
      providers.forEach((p, i) => {
        if (!p || typeof p.request !== "function") return;
        const label = fallbackWalletLabel(p);
        const id = `injected:${compactWalletKey(label) || "wallet"}:${i}`;
        out.push({ id, name: label, provider: p as Eip1193Provider });
      });
    }

    if (eth && typeof eth.request === "function") {
      out.push({
        id: "injected:ethereum",
        name: fallbackWalletLabel(eth),
        provider: eth as Eip1193Provider,
      });
    }
  } catch {
    // ignore
  }

  return dedupeInjectedWallets(out);
}

function pickByPrefer(wallets: InjectedWallet[], prefer: "any" | "metamask" | "coinbase"): InjectedWallet | null {
  if (!wallets.length) return null;
  if (prefer === "any") return wallets[0] ?? null;

  const want = prefer === "metamask" ? "metamask" : "coinbase";
  const found =
    wallets.find((w) => w.id.includes(want)) ||
    wallets.find((w) => w.name.toLowerCase().includes(want)) ||
    null;
  return found ?? wallets[0] ?? null;
}

export async function getEthereumProvider(opts?: EthereumProviderOptions): Promise<Eip1193Provider | null> {
  if (typeof window === "undefined") return null;
  if (opts?.provider) return opts.provider;

  // Standard injected wallet (Base App, Coinbase Wallet, MetaMask, etc.).
  const prefer = opts?.prefer ?? "any";

  // If a specific wallet id is requested, pick it if present.
  if (opts?.walletId) {
    const wallets = await listInjectedWallets(900);
    const match = wallets.find((w) => w.id === opts.walletId) || null;
    if (match) return match.provider;
  }

  // Otherwise pick a sensible default.
  const wallets = await listInjectedWallets(900);
  const chosen = pickByPrefer(wallets, prefer);
  if (chosen) return chosen.provider;

  return null;
}

export async function requestAccounts(provider: Eip1193Provider): Promise<string[]> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  return Array.isArray(accounts) ? accounts : [];
}

export async function getAccounts(provider: Eip1193Provider): Promise<string[]> {
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  return Array.isArray(accounts) ? accounts : [];
}

export async function getChainId(provider: Eip1193Provider): Promise<number> {
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  if (typeof hex !== "string") return 0;
  return parseInt(hex, 16);
}
