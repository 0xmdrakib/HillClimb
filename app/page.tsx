"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HeadPicker } from "@/components/HeadPicker";
import { loadHead, saveHead, HeadId, HEADS } from "@/lib/heads";
import { VehicleId, VEHICLES, loadVehicle, saveVehicle } from "@/lib/vehicles";
import { MapId, loadMap, saveMap } from "@/lib/maps";
import { AllUpgrades, loadAllUpgrades, saveAllUpgrades, upgradeCostForLevel, defaultUpgradeLevels, UPGRADE_CATEGORIES, UPGRADE_META, MAX_LEVEL } from "@/lib/upgrades";
import { loadGarage, saveGarage, UnlockedVehicles, purchaseVehicle, loadLocalCoins, addLocalCoins, spendLocalCoins } from "@/lib/garage";
import { loadAchievements, saveAchievements, UnlockedAchievements, checkRunAchievements, ACHIEVEMENTS, AchievementId } from "@/lib/achievements";
import { HillClimbCanvas, HillClimbHandle, HillClimbState } from "@/components/HillClimbCanvas";
import { MainMenu } from "@/components/MainMenu";
import { listInjectedWallets, type InjectedWallet } from "@/lib/wallet";
import {
  getOrConnectWallet, tryAutoConnectWallet, readBestMeters,
  submitScoreMeters, getNextTokenId, mintRunNft, sendEthTip, clearCachedWallet,
} from "@/lib/onchain";
import { audioManager } from "@/lib/audio";

const DEFAULT_INJECTED_WALLET = "any" as const;
const LAST_WALLET_KEY = "jhc_last_wallet_id_v1";
const TOTAL_RUNS_KEY = "jhc_total_runs_v1";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function getViewportBox() {
  if (typeof window === "undefined") return { width: 0, height: 0, shortEdge: 0, longEdge: 0 };
  const vv = (window as any).visualViewport as VisualViewport | undefined;
  const width = vv?.width ?? window.innerWidth;
  const height = vv?.height ?? window.innerHeight;
  return { width, height, shortEdge: Math.min(width, height), longEdge: Math.max(width, height) };
}

function isLikelyPhoneViewport() {
  if (typeof window === "undefined") return false;
  const { shortEdge, longEdge } = getViewportBox();
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  const ua = nav.userAgent || "";
  const uaMobile = Boolean(nav.userAgentData?.mobile) || /android|iphone|ipod|mobile|iemobile|opera mini/i.test(ua);
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const noHover = window.matchMedia?.("(hover: none)")?.matches ?? false;
  return shortEdge > 0 && shortEdge <= 520 && longEdge <= 1100 && (uaMobile || (coarse && noHover));
}

function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function dailySeedUTC() {
  const d = new Date();
  return (Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000)) >>> 0;
}
function fmtM(m: number) { return String(Math.max(0, Math.floor(m || 0))); }
function fmtKmh(kmh: number) { return String(Math.max(0, Math.floor(kmh || 0))); }
function shortHash(h?: string | null) { if (!h) return ""; if (h.length <= 12) return h; return `${h.slice(0, 6)}…${h.slice(-4)}`; }
function humanizeTxErr(err: any) {
  const e = err?.cause ?? err;
  const code = e?.code ?? e?.cause?.code;
  const msg = String(e?.shortMessage ?? e?.message ?? e?.details ?? "").toLowerCase();
  if (code === 4001 || code === "ACTION_REJECTED" || msg.includes("user rejected") || msg.includes("rejected the request")) return "User rejected the tx";
  return "Transaction failed";
}

const BACK_BUTTON_THEMES: Record<MapId, { background: string; borderColor: string; shadow: string; color: string }> = {
  hills: {
    background: "linear-gradient(145deg,#43c566,#2d8a56)",
    borderColor: "rgba(232,255,238,.86)",
    shadow: "0 8px 22px rgba(45,138,86,.28), inset 0 1px 0 rgba(255,255,255,.42)",
    color: "#ffffff",
  },
  desert: {
    background: "linear-gradient(145deg,#d4a843,#b88030)",
    borderColor: "rgba(255,239,190,.88)",
    shadow: "0 8px 22px rgba(184,128,48,.30), inset 0 1px 0 rgba(255,255,255,.38)",
    color: "#ffffff",
  },
  arctic: {
    background: "linear-gradient(145deg,#d0e8f4,#6a9ac4)",
    borderColor: "rgba(255,255,255,.92)",
    shadow: "0 8px 22px rgba(80,130,170,.26), inset 0 1px 0 rgba(255,255,255,.62)",
    color: "#1a2a4a",
  },
  moon: {
    background: "linear-gradient(145deg,#8898a8,#505868)",
    borderColor: "rgba(230,238,255,.58)",
    shadow: "0 8px 22px rgba(8,13,26,.35), inset 0 1px 0 rgba(255,255,255,.20)",
    color: "#ffffff",
  },
};

function ShareIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 3h7v7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M21 3l-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M10 7H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ChevronDownIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function RotateIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.66-5.66" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M18 3v4h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M20 12a8 8 0 0 1-13.66 5.66" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M6 21v-4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function TipIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 12v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M4 12h16v-2a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M12 8v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M12 8H8.8a2.2 2.2 0 1 1 0-4.4c1.9 0 3.2 2.6 3.2 4.4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M12 8h3.2a2.2 2.2 0 1 0 0-4.4c-1.9 0-3.2 2.6-3.2 4.4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>;
}
function XIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
}

function AchToast({ name, emoji, reward }: { name: string; emoji: string; reward: number }) {
  return (
    <div style={{
      position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
      zIndex: 9999, background: "linear-gradient(135deg,rgba(15,23,42,0.97),rgba(30,41,59,0.97))",
      border: "2px solid rgba(251,191,36,0.5)", borderRadius: 999,
      padding: "10px 18px", display: "flex", alignItems: "center", gap: 10,
      boxShadow: "0 8px 32px rgba(251,191,36,0.3)", pointerEvents: "none",
      fontFamily: "system-ui, sans-serif", animation: "achSlide 0.4s ease",
    }}>
      <span style={{ fontSize: 22 }}>{emoji}</span>
      <div>
        <div style={{ fontSize: 10, color: "#fbbf24", fontWeight: 900, letterSpacing: 0.5 }}>ACHIEVEMENT UNLOCKED</div>
        <div style={{ fontSize: 13, color: "#f1f5f9", fontWeight: 800 }}>{name} · +{reward}🪙</div>
      </div>
      <style>{`@keyframes achSlide{from{opacity:0;transform:translateX(-50%) translateY(-16px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
    </div>
  );
}

function WalletPickerModal({
  open, choices, connectBusy, onClose, onSelect,
}: {
  open: boolean;
  choices: InjectedWallet[];
  connectBusy: boolean;
  onClose: () => void;
  onSelect: (wallet: InjectedWallet) => void;
}) {
  if (!open) return null;
  return (
    <div className="walletModal" onClick={onClose} role="presentation">
      <div className="walletCard" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="wallet-picker-title">
        <div className="walletCardTop">
          <div>
            <div id="wallet-picker-title" className="walletTitle">Choose wallet</div>
            <div className="walletSubtitle">Pick one injected wallet to use on Base.</div>
          </div>
          <button type="button" className="driverClose" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="walletList">
          {choices.map(w => (
            <button key={w.id} type="button" className="walletRow" disabled={connectBusy} onClick={() => onSelect(w)}>
              {w.icon ? <img className="walletIcon" src={w.icon} alt="" /> : <span className="walletIcon walletIconFallback">◆</span>}
              <span>{w.name}</span>
            </button>
          ))}
        </div>
        <div className="walletHint">Selecting the same already-approved wallet reconnects instantly.</div>
      </div>
    </div>
  );
}

export default function Page() {
  const [gamePhase, setGamePhase] = useState<"menu" | "playing">("menu");

  const [head, setHead] = useState<HeadId>("jesse");
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleId>("jeep");
  const [selectedMap, setSelectedMap] = useState<MapId>("hills");

  const [coins, setCoins] = useState(0);
  const [garage, setGarage] = useState<UnlockedVehicles>({ jeep: true, bicycle: true });
  const [allUpgrades, setAllUpgrades] = useState<AllUpgrades>(() => ({
    jeep: defaultUpgradeLevels(), bicycle: defaultUpgradeLevels(),
    sportsCar: defaultUpgradeLevels(),
  }));
  const [achievements, setAchievements] = useState<UnlockedAchievements>({});
  const [totalRuns, setTotalRuns] = useState(0);
  const [newAch, setNewAch] = useState<{ name: string; emoji: string; reward: number } | null>(null);

  const [driverOpen, setDriverOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [seed] = useState<number>(() => dailySeedUTC());
  const [boostHeld, setBoostHeld] = useState(false);
  const [phoneViewport, setPhoneViewport] = useState(false);
  const [landscapeSide, setLandscapeSide] = useState<"right" | "left">("right");
  const [tipOpen, setTipOpen] = useState(false);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [ethUsdSource, setEthUsdSource] = useState<string>("");
  const [tipPresetUsd, setTipPresetUsd] = useState<number>(10);
  const [tipCustomUsd, setTipCustomUsd] = useState<string>("");
  const [tipBusy, setTipBusy] = useState(false);
  const [tipErr, setTipErr] = useState("");
  const [tipTx, setTipTx] = useState<string | null>(null);
  const [isPortrait, setIsPortrait] = useState(false);
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [walletSource, setWalletSource] = useState<string>("");
  const [bestOnchainM, setBestOnchainM] = useState<number>(0);
  const [scoreBusy, setScoreBusy] = useState(false);
  const [mintBusy, setMintBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [scoreTx, setScoreTx] = useState<string | null>(null);
  const [mintTx, setMintTx] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string>("");
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [walletChoices, setWalletChoices] = useState<InjectedWallet[]>([]);
  const [gameOverShot, setGameOverShot] = useState<string | null>(null);
  const [gameOverMeters, setGameOverMeters] = useState<number>(0);

  const scoreboardAddress = (process.env.NEXT_PUBLIC_SCOREBOARD_ADDRESS ?? "").trim();
  const runNftAddress = (process.env.NEXT_PUBLIC_RUNNFT_ADDRESS ?? "").trim();

  const [state, setState] = useState<HillClimbState>({
    distanceM: 0, bestM: 0, coins: 0, fuel: 100, status: "IDLE",
    rpm01: 0, boost01: 0, speedKmh: 0, airtimeS: 0, flips: 0, toast: "", toastT: 0,
  });

  const gameRef = useRef<HillClimbHandle | null>(null);
  const walletRef = useRef<{ provider: any; address: string } | null>(null);

  useEffect(() => {
    if (gamePhase === "menu") audioManager.suspend();
  }, [gamePhase]);

  useEffect(() => {
    setHead(loadHead());
    setSelectedVehicle(loadVehicle());
    setSelectedMap(loadMap());
    setCoins(loadLocalCoins());
    setGarage(loadGarage());
    setAllUpgrades(loadAllUpgrades());
    setAchievements(loadAchievements());
    try { setTotalRuns(parseInt(localStorage.getItem(TOTAL_RUNS_KEY) ?? "0", 10) || 0); } catch { }
  }, []);

  useEffect(() => saveHead(head), [head]);
  useEffect(() => saveVehicle(selectedVehicle), [selectedVehicle]);
  useEffect(() => saveMap(selectedMap), [selectedMap]);
  useEffect(() => saveAllUpgrades(allUpgrades), [allUpgrades]);

  useClientLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    let lastPortrait: boolean | null = null;
    const compute = () => {
      const { width: w, height: h } = getViewportBox();
      const nextPortrait = h > w * 1.08 ? true : w > h * 1.08 ? false : (lastPortrait ?? (h >= w));
      lastPortrait = nextPortrait; setIsPortrait(nextPortrait); setPhoneViewport(isLikelyPhoneViewport());
    };
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(compute); };
    compute();
    vv?.addEventListener?.("resize", on); vv?.addEventListener?.("scroll", on); window.addEventListener("resize", on);
    return () => { cancelAnimationFrame(raf); vv?.removeEventListener?.("resize", on); vv?.removeEventListener?.("scroll", on); window.removeEventListener("resize", on); };
  }, []);

  useEffect(() => { try { const v = localStorage.getItem("jhc_landscape_side"); if (v === "left" || v === "right") setLandscapeSide(v); } catch { } }, []);
  useEffect(() => { try { localStorage.setItem("jhc_landscape_side", landscapeSide); } catch { } }, [landscapeSide]);

  useEffect(() => {
    if (!tipOpen) return; let alive = true;
    (async () => {
      try {
        setTipErr(""); setTipTx(null); setEthUsd(null); setEthUsdSource("");
        const r = await fetch("/api/ethusd", { cache: "no-store" }); const j = await r.json(); const usd = Number(j?.usd);
        if (!alive) return;
        if (r.ok && Number.isFinite(usd) && usd > 0) { setEthUsd(usd); setEthUsdSource(String(j?.source || "")); }
        else setTipErr("Failed to fetch ETH price");
      } catch { if (!alive) return; setTipErr("Failed to fetch ETH price"); }
    })();
    return () => { alive = false; };
  }, [tipOpen]);

  const immersiveMobileUi = phoneViewport;

  useEffect(() => {
    if (!immersiveMobileUi) return;
    document.body.classList.add("miniBody"); document.documentElement.classList.add("miniHtml");
    return () => { document.body.classList.remove("miniBody"); document.documentElement.classList.remove("miniHtml"); };
  }, [immersiveMobileUi]);

  useClientLayoutEffect(() => {
    if (!immersiveMobileUi) return;
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    const root = document.documentElement;
    let raf = 0, lastW = -1, lastH = -1;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = vv?.width ?? window.innerWidth, h = vv?.height ?? window.innerHeight;
        if (Math.abs(w - lastW) < 1 && Math.abs(h - lastH) < 1) return;
        lastW = w; lastH = h;
        const ww = Math.round(w), hh = Math.round(h);
        root.style.setProperty("--vvw", `${ww}px`); root.style.setProperty("--vvh", `${hh}px`);
        root.style.setProperty("--lvw", `${Math.max(ww, hh)}px`); root.style.setProperty("--lvh", `${Math.min(ww, hh)}px`);
        root.style.setProperty("--mini-ui-scale", Math.max(0.68, Math.min(1, Math.min(ww, hh) / 420)).toFixed(3));
      });
    };
    update();
    vv?.addEventListener?.("resize", update); vv?.addEventListener?.("scroll", update); window.addEventListener("resize", update);
    return () => { cancelAnimationFrame(raf); vv?.removeEventListener?.("resize", update); vv?.removeEventListener?.("scroll", update); window.removeEventListener("resize", update); };
  }, [immersiveMobileUi]);

  const virtualLandscape = immersiveMobileUi && isPortrait;

  useEffect(() => { const onVis = () => setPaused(Boolean(document.hidden)); document.addEventListener("visibilitychange", onVis); return () => document.removeEventListener("visibilitychange", onVis); }, []);
  useEffect(() => { if (driverOpen || walletModalOpen) setPaused(true); else if (!document.hidden) setPaused(false); }, [driverOpen, walletModalOpen]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") gameRef.current?.setThrottle(1);
      if (e.key === "ArrowLeft") gameRef.current?.setThrottle(-1);
      if (e.key.toLowerCase() === "r") onTryAgain();
    };
    const up = (e: KeyboardEvent) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") gameRef.current?.setThrottle(0); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [head, bestOnchainM]);

  const url = useMemo(() => { const env = process.env.NEXT_PUBLIC_URL; if (env?.startsWith("http")) return env.replace(/\/$/, ""); if (typeof window !== "undefined") return window.location.origin; return "https://YOUR_DOMAIN"; }, []);
  const shareText = useMemo(() => `Jesse Hill Climb: ${fmtM(state.distanceM)}m (best ${fmtM(bestOnchainM)}m)\n${url}`, [bestOnchainM, state.distanceM, url]);

  const doShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Jesse Hill Climb",
          text: `I drove ${fmtM(state.distanceM)}m in Jesse Hill Climb (best ${fmtM(bestOnchainM)}m).`,
          url,
        });
        return;
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
    }
    try { await navigator.clipboard.writeText(shareText); setState(s => ({ ...s, toast: "Copied!", toastT: 1.1 })); } catch { }
  };

  const refreshBest = async (address: string) => {
    if (!scoreboardAddress) return;
    const best = await readBestMeters(scoreboardAddress, address);
    const bestNum = Number(best);
    setBestOnchainM(Number.isFinite(bestNum) ? bestNum : 0);
  };
  const labelFromProvider = (p: any) => p?.isMetaMask ? "MetaMask" : p?.isCoinbaseWallet ? "Coinbase" : "Injected wallet";

  const ensureConnected = async (opts?: { walletId?: string; walletLabel?: string }) => {
    setActionErr(""); setConnectBusy(true);
    try {
      let walletId = opts?.walletId;
      if (!walletId) { try { walletId = localStorage.getItem(LAST_WALLET_KEY) || undefined; } catch { } }
      const { provider, address } = await getOrConnectWallet({ prefer: DEFAULT_INJECTED_WALLET, walletId });
      setWalletAddr(address); walletRef.current = { provider, address };
      setWalletSource(opts?.walletLabel ?? labelFromProvider(provider));
      if (walletId) { try { localStorage.setItem(LAST_WALLET_KEY, walletId); } catch { } }
      await refreshBest(address); return address;
    } finally { setConnectBusy(false); }
  };

  useEffect(() => {
    let lastId: string | null = null;
    try { lastId = localStorage.getItem(LAST_WALLET_KEY); } catch { }
    if (!lastId) return;
    (async () => { try { const choices = await listInjectedWallets(650); const picked = choices.find(x => x.id === lastId); const w = await tryAutoConnectWallet({ walletId: lastId, prefer: "any" }); if (!w) return; walletRef.current = { provider: w.provider, address: w.address }; setWalletAddr(w.address); setWalletSource(picked?.name ?? labelFromProvider(w.provider)); await refreshBest(w.address); } catch { } })();
  }, [scoreboardAddress]);

  const onConnectWalletClick = async () => {
    try {
      setActionErr("");
      setConnectBusy(true);
      const ws = await listInjectedWallets(900);
      setWalletChoices(ws);
      if (!ws.length) { setActionErr("No injected wallet found."); return; }
      setWalletModalOpen(true);
    } catch (e: any) {
      setActionErr(e?.message ? String(e.message) : "Wallet connection failed");
    } finally {
      setConnectBusy(false);
    }
  };

  const onDisconnectWallet = () => {
    clearCachedWallet();
    walletRef.current = null;
    setWalletAddr(null);
    setWalletSource("");
    setBestOnchainM(0);
    setScoreTx(null);
    setMintTx(null);
    setActionErr("");
    setWalletModalOpen(false);
    try { localStorage.removeItem(LAST_WALLET_KEY); } catch { }
  };

  const onTryAgain = () => {
    setPaused(false); setGameOverShot(null); setGameOverMeters(0);
    setScoreBusy(false); setMintBusy(false); setScoreTx(null); setMintTx(null); setActionErr("");
    gameRef.current?.reset();
  };

  const onSubmitScore = async () => {
    try {
      setActionErr(""); setScoreTx(null);
      if (!scoreboardAddress) { setActionErr("Missing NEXT_PUBLIC_SCOREBOARD_ADDRESS in .env.local"); return; }
      setScoreBusy(true);
      const addr = walletAddr ?? (await ensureConnected());
      const meters = Math.max(0, Math.floor(gameOverMeters || state.distanceM));
      const w = walletRef.current;
      const tx = await submitScoreMeters(scoreboardAddress, meters, w ? { provider: w.provider, address: w.address as any } : undefined);
      setScoreTx(tx); await refreshBest(addr);
    } catch (e: any) { setActionErr(humanizeTxErr(e)); } finally { setScoreBusy(false); }
  };

  const onMintNft = async () => {
    try {
      setActionErr(""); setMintTx(null);
      if (!runNftAddress) { setActionErr("Missing NEXT_PUBLIC_RUNNFT_ADDRESS in .env.local"); return; }
      if (!gameOverShot) { setActionErr("No snapshot. Try again and crash once."); return; }
      setMintBusy(true);
      void (walletAddr ?? (await ensureConnected()));
      const meters = Math.max(0, Math.floor(gameOverMeters || state.distanceM));
      const driverId = head === "jesse" ? 0 : 1;
      const driverName = HEADS[head].label;
      const tokenId = await getNextTokenId(runNftAddress);
      const resp = await fetch("/api/pinata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ imageDataUrl: gameOverShot, meters, driverId, driverName, tokenId: tokenId.toString(), gameUrl: url }) });
      if (!resp.ok) throw new Error((await resp.text().catch(() => "")) || "IPFS upload failed");
      const out = (await resp.json()) as { tokenUri: string };
      if (!out?.tokenUri) throw new Error("Missing tokenUri");
      const w = walletRef.current;
      const tx = await mintRunNft(runNftAddress, meters, driverId, out.tokenUri, w ? { provider: w.provider, address: w.address as any } : undefined);
      setMintTx(tx);
    } catch (e: any) { setActionErr(humanizeTxErr(e)); } finally { setMintBusy(false); }
  };

  const handleSelectVehicle = (vid: VehicleId) => { setSelectedVehicle(vid); };
  const handleSelectMap = (mid: MapId) => { setSelectedMap(mid); };
  const handlePurchase = (vid: VehicleId, price: number) => {
    const { success, newGarage, newCoins } = purchaseVehicle(vid, price, garage);
    if (success) { setGarage(newGarage); saveGarage(newGarage); setCoins(newCoins); setSelectedVehicle(vid); }
  };
  const handleUpgrade = (vid: VehicleId, cat: string) => {
    const c = cat as keyof typeof allUpgrades[typeof vid];
    const cur = allUpgrades[vid][c] ?? 0;
    const cost = upgradeCostForLevel(cur);
    if (cost === Infinity) return;
    if (!spendLocalCoins(cost)) return;
    setCoins(loadLocalCoins());
    setAllUpgrades(prev => { const next = { ...prev, [vid]: { ...prev[vid], [c]: cur + 1 } }; saveAllUpgrades(next); return next; });
  };

  const onGameOver = (p: { snapshotDataUrl: string | null; meters: number; status: "CRASH" | "OUT_OF_FUEL" }) => {
    setGameOverShot(p.snapshotDataUrl); setGameOverMeters(p.meters);
    const freshCoins = loadLocalCoins(); setCoins(freshCoins);
    const runs = totalRuns + 1; setTotalRuns(runs);
    try { localStorage.setItem(TOTAL_RUNS_KEY, String(runs)); } catch { }
    const { newly, totalReward } = checkRunAchievements({
      distanceM: p.meters, coins: state.coins, flips: state.flips,
      maxSpeedKmh: state.speedKmh, fuelRemaining: state.fuel,
      map: selectedMap, prevUnlocked: achievements,
    });
    if (newly.length > 0) {
      const nextAch = { ...achievements }; newly.forEach(id => { nextAch[id] = true; });
      setAchievements(nextAch); saveAchievements(nextAch);
      if (totalReward > 0) { const nc = addLocalCoins(totalReward); setCoins(nc); }
      const def = ACHIEVEMENTS.find(a => a.id === newly[0]);
      if (def) { setNewAch({ name: def.name, emoji: def.emoji, reward: def.reward }); setTimeout(() => setNewAch(null), 3500); }
    }
  };

  const fuel01 = clamp01(state.fuel / 100);
  const isEnd = state.status === "CRASH" || state.status === "OUT_OF_FUEL";
  const beatOnchainBest = isEnd && Math.floor(state.distanceM) > Math.floor(bestOnchainM);
  const backTheme = BACK_BUTTON_THEMES[selectedMap] ?? BACK_BUTTON_THEMES.hills;
  const throttleSet = (t: number) => {
    audioManager.init(); // Initialize audio on first control tap
    gameRef.current?.setThrottle(t);
  };
  const onGasDown = () => throttleSet(1);
  const onBrakeDown = () => throttleSet(-1);
  const boostSet = (on: boolean) => { setBoostHeld(on); gameRef.current?.setBoost?.(on); };

  if (gamePhase === "menu") {
    return (
      <>
        {newAch && <AchToast name={newAch.name} emoji={newAch.emoji} reward={newAch.reward} />}
        <MainMenu
          coins={coins}
          bestM={bestOnchainM}
          selectedVehicle={selectedVehicle}
          selectedMap={selectedMap}
          selectedHead={head}
          garage={garage}
          upgrades={allUpgrades}
          achievements={achievements}
          totalRuns={totalRuns}
          onPlay={() => setGamePhase("playing")}
          onSelectVehicle={handleSelectVehicle}
          onSelectMap={handleSelectMap}
          onSelectHead={setHead}
          onPurchaseVehicle={handlePurchase}
          onUpgrade={handleUpgrade}
          walletAddress={walletAddr}
          walletSource={walletSource}
          connectBusy={connectBusy}
          walletError={actionErr}
          onConnectWallet={() => void onConnectWalletClick()}
          onDisconnectWallet={onDisconnectWallet}
        />
        <WalletPickerModal
          open={walletModalOpen}
          choices={walletChoices}
          connectBusy={connectBusy}
          onClose={() => setWalletModalOpen(false)}
          onSelect={(w) => { setWalletModalOpen(false); void ensureConnected({ walletId: w.id, walletLabel: w.name }).catch((e: any) => setActionErr(e?.message ?? "Failed")); }}
        />
      </>
    );
  }

  return (
    <>
      {newAch && <AchToast name={newAch.name} emoji={newAch.emoji} reward={newAch.reward} />}
      <main className={"main " + (immersiveMobileUi ? "mainMini" : "")}>
        <div className={
          "shell " + (immersiveMobileUi ? "shellMini" : "") +
          (virtualLandscape ? " miniVirtualLandscape" : "") +
          (virtualLandscape && landscapeSide === "left" ? " landscapeLeft" : "")
        }>
          <div className={"header " + (immersiveMobileUi ? "headerMini" : "")}>
            <div><div className="titleRow"><img className="brandLogo" src="/icon.png" alt="" /><div className="title">Jesse Hill Climb</div></div></div>
            <div className="headerBtns">
              <button className="iconBtn iconBtnPrimary" type="button" onClick={doShare} aria-label="Share"><ShareIcon /></button>
            </div>
          </div>

          <div className="stage"><div className="playfield">
            <HillClimbCanvas
              ref={h => { gameRef.current = h; }}
              headId={head}
              vehicleId={selectedVehicle}
              mapId={selectedMap}
              paused={paused}
              miniMode={immersiveMobileUi}
              seed={seed}
              bestM={bestOnchainM}
              onState={setState}
              onGameOver={onGameOver}
            />

            {/* HUD */}
            <div className="hud"><div className="hudCard">
              <div className="hudTop"><div className="bigNum">{fmtM(state.distanceM)}m</div><div className="small">best {fmtM(bestOnchainM)}m</div></div>
              <div className={"fuelBar " + (state.fuel < 18 ? "fuelLow" : "")}><div className="fuelFill" style={{ width: `${fuel01 * 100}%` }} /></div>
              <div className="hudRow">
                <div className="tag">⛽ {Math.floor(state.fuel)}%</div>
                <div className="tag">🪙 {state.coins}</div>
                <div className="tag">⚡ {fmtKmh(state.speedKmh)} km/h</div>
              </div>
              {state.flips > 0 || state.airtimeS > 0.2 ? <div className="hudRow"><div className="tag">🌀 {state.flips}</div><div className="tag">🕊 {state.airtimeS.toFixed(1)}s</div></div> : null}
            </div></div>

            {/* Top-right tools */}
            <div className="topRightTools">
              {!isEnd && (
                <button type="button" className="mapBackBtn" onClick={() => { audioManager.suspend(); setGamePhase("menu"); }} aria-label="Back to Menu" title="Back to Menu" style={{
                  background: backTheme.background, borderColor: backTheme.borderColor, boxShadow: backTheme.shadow, color: backTheme.color,
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M14 6L8 12L14 18" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              {virtualLandscape ? <button type="button" className="miniToolBtn" onClick={() => setLandscapeSide(s => s === "left" ? "right" : "left")} aria-label="Flip"><RotateIcon /></button> : null}
              <button type="button" className="driverBtn driverBtnInTools" onClick={() => setDriverOpen(o => !o)}>
                <img className="driverIcon" src={HEADS[head].src} alt="" />
                <span className="driverLabel">{HEADS[head].label}</span>
                <span className="driverChevron"><ChevronDownIcon /></span>
              </button>
            </div>

            {driverOpen ? (
              <div className="driverBackdrop" onClick={() => setDriverOpen(false)} role="presentation">
                <div className="driverCard" onClick={e => e.stopPropagation()}>
                  <div className="driverCardTop"><div className="driverTitle">Driver</div><button type="button" className="driverClose" onClick={() => setDriverOpen(false)}>✕</button></div>
                  <HeadPicker value={head} onChange={h => { setHead(h); setDriverOpen(false); }} />
                </div>
              </div>
            ) : null}

            {tipOpen ? (
              <div className="tipBackdrop" onClick={() => setTipOpen(false)} role="presentation">
                <div className="tipCard" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
                  <div className="tipTop"><div className="tipTitle">Tip</div><button type="button" className="tipClose" onClick={() => setTipOpen(false)} aria-label="Close"><XIcon /></button></div>
                  <div className="tipMeta">{ethUsd ? <>1 ETH ≈ ${ethUsd.toFixed(2)} {ethUsdSource ? <span style={{ opacity: 0.7 }}>({ethUsdSource})</span> : null}</> : <>Loading ETH price…</>}</div>
                  {(() => {
                    const usd = Number(tipCustomUsd) > 0 ? Number(tipCustomUsd) : tipPresetUsd;
                    const ethStr = ethUsd && ethUsd > 0 ? (usd / ethUsd).toFixed(6) : "…";
                    return (<>
                      <div className="tipGrid">
                        {[{ usd: 10, label: "$10" }, { usd: 100, label: "$100" }, { usd: 1000, label: "$1000" }].map(o => (
                          <button key={o.usd} type="button" className={"tipAmt " + (tipCustomUsd === "" && tipPresetUsd === o.usd ? "tipAmtActive" : "")} onClick={() => { setTipCustomUsd(""); setTipPresetUsd(o.usd); }}>
                            <strong>{o.label}</strong><span>{ethUsd ? `${(o.usd / ethUsd).toFixed(6)} ETH` : "—"}</span>
                          </button>
                        ))}
                      </div>
                      <div className="tipRow">
                        <input className="tipInput" inputMode="decimal" placeholder="Custom USD" value={tipCustomUsd} onChange={e => setTipCustomUsd(e.target.value.replace(/[^0-9.]/g, ""))} />
                        <div style={{ fontSize: 12, opacity: 0.85, whiteSpace: "nowrap" }}>≈ {ethStr} ETH</div>
                      </div>
                      <button type="button" className="tipSend" disabled={tipBusy || !ethUsd} onClick={async () => {
                        try {
                          setTipErr(""); setTipTx(null);
                          const tipTo = (process.env.NEXT_PUBLIC_TIP_ADDRESS ?? "").trim();
                          if (!tipTo) { setTipErr("Missing NEXT_PUBLIC_TIP_ADDRESS"); return; }
                          const usd2 = Number(tipCustomUsd) > 0 ? Number(tipCustomUsd) : tipPresetUsd;
                          if (!Number.isFinite(usd2) || usd2 <= 0) { setTipErr("Enter a valid amount"); return; }
                          if (!ethUsd || ethUsd <= 0) { setTipErr("ETH price unavailable"); return; }
                          setTipBusy(true); await ensureConnected();
                          const w = walletRef.current;
                          const tx = await sendEthTip(tipTo, (usd2 / ethUsd).toFixed(6), w ? { provider: w.provider, address: w.address as any } : undefined);
                          setTipTx(tx);
                        } catch (e: any) { setTipErr(humanizeTxErr(e)); } finally { setTipBusy(false); }
                      }}>{tipBusy ? "Sending…" : "Send tip"}</button>
                      {tipTx ? <div className="tipMeta" style={{ marginTop: 10 }}>Sent ✅<div style={{ fontSize: 12, opacity: 0.8, marginTop: 4, overflowWrap: "anywhere" }}>{tipTx}</div></div> : null}
                      {tipErr ? <div className="tipErr">{tipErr}</div> : null}
                    </>);
                  })()}
                </div>
              </div>
            ) : null}

            <WalletPickerModal
              open={walletModalOpen}
              choices={walletChoices}
              connectBusy={connectBusy}
              onClose={() => setWalletModalOpen(false)}
              onSelect={(w) => { setWalletModalOpen(false); void ensureConnected({ walletId: w.id, walletLabel: w.name }).catch((e: any) => setActionErr(e?.message ?? "Failed")); }}
            />

            {state.toastT > 0 && state.toast ? <div className="toast">{state.toast}</div> : null}
            {state.status !== "RUN" && !isEnd ? <div className="centerHint">Tap GAS to start</div> : null}

            {isEnd ? (
              <div className="endScreen"><div className="endCard">
                <div className="endTitle">{state.status === "CRASH" ? "CRASH!" : "OUT OF FUEL"}</div>
                <div className="endSub">{fmtM(state.distanceM)}m • best {fmtM(bestOnchainM)}m{beatOnchainBest ? " • NEW BEST (pending onchain)" : ""}</div>
                <div className="endShotWrap">{gameOverShot ? <img className="endShot" src={gameOverShot} alt="Run snapshot" /> : <div className="endShotPlaceholder">Snapshot</div>}</div>
                <div className="endOnchain">
                  <div className="endOnchainTitle">Onchain (optional)</div>
                  <div className="endOnchainRow"><div className="endOnchainMeta">
                    <div className="endOnchainLine">Network: Base mainnet</div>
                    <div className="endOnchainLine">Wallet: {walletAddr ?? "Not connected"}{walletAddr && walletSource ? ` (${walletSource})` : ""}</div>
                    {!scoreboardAddress || !runNftAddress ? <div className="endOnchainWarn">Set contract addresses in .env.local to enable.</div> : null}
                    {scoreTx ? <div className="endOnchainOk">Score tx: {shortHash(scoreTx)}</div> : null}
                    {mintTx ? <div className="endOnchainOk">Mint tx: {shortHash(mintTx)}</div> : null}
                    {actionErr ? <div className="endOnchainErr">{actionErr}</div> : null}
                  </div></div>
                  <div className="endOnchainBtns">
                    {!walletAddr ? <button type="button" className="actionBtn btnDark" disabled={scoreBusy || mintBusy || connectBusy} onClick={() => void onConnectWalletClick()}>{connectBusy ? "Connecting…" : "Connect wallet"}</button> : null}
                    <button type="button" className="actionBtn btnDark" disabled={scoreBusy || mintBusy || !scoreboardAddress || connectBusy} onClick={onSubmitScore}>{scoreBusy ? "Submitting…" : "Save score onchain"}</button>
                    <button type="button" className="actionBtn btnDark" disabled={scoreBusy || mintBusy || !runNftAddress || !gameOverShot || connectBusy} onClick={onMintNft}>{mintBusy ? "Minting…" : "Mint run NFT"}</button>
                  </div>
                </div>
                <div className="endBtns">
                  <button type="button" className="actionBtn btnPrimary" onClick={onTryAgain}>Try again</button>
                  <button type="button" className="actionBtn btnDark" onClick={doShare}>Share</button>
                  <button type="button" className="actionBtn btnDark" onClick={() => { audioManager.suspend(); setGamePhase("menu"); }}>← Menu</button>
                </div>
              </div></div>
            ) : null}

            <div className="controls">
              <Pedal label="BRAKE" side="left" onDown={onBrakeDown} onUp={() => throttleSet(0)} />
              <Pedal label="GAS" side="right" onDown={onGasDown} onUp={() => throttleSet(0)} />
            </div>
            <div className="gauges">
              <Gauge label="RPM" value01={clamp01(state.rpm01)} />
              <GaugeButton label="BOOST" value01={clamp01(state.boost01)} active={boostHeld} disabled={state.status !== "RUN" || state.boost01 < 0.05} onDown={() => boostSet(true)} onUp={() => boostSet(false)} />
            </div>
          </div></div>
        </div>
      </main>
    </>
  );
}

function Gauge({ label, value01 }: { label: string; value01: number }) {
  const deg = -120 + value01 * 240;
  return <div className="gauge"><div className="gaugeFace" /><div className="needle" style={{ transform: `translateX(-50%) rotate(${deg}deg)` }} /><div className="gaugeCap" /><div className="gaugeLabel">{label}</div></div>;
}
function GaugeButton({ label, value01, disabled, active, onDown, onUp }: { label: string; value01: number; disabled: boolean; active: boolean; onDown: () => void; onUp: () => void }) {
  const deg = -120 + value01 * 240;
  return (
    <button type="button" className={"gauge gaugeInteract " + (disabled ? "gaugeDisabled " : "") + (active ? "gaugeActive" : "")}
      onPointerDown={e => { e.preventDefault(); if (disabled) return; (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId); onDown(); }}
      onPointerUp={e => { e.preventDefault(); onUp(); }} onPointerCancel={e => { e.preventDefault(); onUp(); }} onPointerLeave={onUp}
      aria-label={label} title={disabled ? "Charge boost by doing stunts" : "Hold to boost"}>
      <div className="gaugeFace" /><div className="needle" style={{ transform: `translateX(-50%) rotate(${deg}deg)` }} /><div className="gaugeCap" /><div className="gaugeLabel">{label}</div>
    </button>
  );
}
function Pedal({ label, side, onDown, onUp }: { label: string; side: "left" | "right"; onDown: () => void; onUp: () => void }) {
  return (
    <button type="button" className={"pedal " + (side === "left" ? "pedalLeft" : "pedalRight")}
      onPointerDown={e => { e.preventDefault(); (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId); onDown(); }}
      onPointerUp={e => { e.preventDefault(); onUp(); }} onPointerCancel={e => { e.preventDefault(); onUp(); }} onPointerLeave={onUp}>
      <div className="holes" /><div className="pedalLabel">{label}</div>
    </button>
  );
}
