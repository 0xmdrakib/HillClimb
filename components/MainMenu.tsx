"use client";
import React, { useRef, useState, useCallback } from "react";
import { VehicleId, VEHICLES, VehicleConfig } from "@/lib/vehicles";
import { MapId, MAPS } from "@/lib/maps";
import { AllUpgrades, UPGRADE_CATEGORIES, UPGRADE_META, MAX_LEVEL, upgradeCostForLevel } from "@/lib/upgrades";
import { UnlockedVehicles } from "@/lib/garage";
import { UnlockedAchievements, ACHIEVEMENTS } from "@/lib/achievements";
import { HeadId, HEADS } from "@/lib/heads";

type Tab = "home" | "garage" | "maps" | "upgrades" | "achievements";

export interface MainMenuProps {
  coins: number;
  bestM: number;
  selectedVehicle: VehicleId;
  selectedMap: MapId;
  selectedHead: HeadId;
  garage: UnlockedVehicles;
  upgrades: AllUpgrades;
  achievements: UnlockedAchievements;
  totalRuns: number;
  onPlay: () => void;
  onSelectVehicle: (id: VehicleId) => void;
  onSelectMap: (id: MapId) => void;
  onSelectHead: (id: HeadId) => void;
  onPurchaseVehicle: (id: VehicleId, price: number) => void;
  onUpgrade: (vehicleId: VehicleId, category: string) => void;
  walletAddress?: string | null;
  walletSource?: string;
  connectBusy?: boolean;
  walletError?: string;
  onConnectWallet?: () => void;
  onDisconnectWallet?: () => void;
}

const VEHICLE_ORDER: VehicleId[] = ["jeep", "bicycle", "sportsCar"];
const MAP_ORDER: MapId[] = ["hills", "desert", "arctic", "moon"];

function shortWalletAddress(address?: string | null) {
  if (!address) return "";
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');

*{scrollbar-width:none;-webkit-tap-highlight-color:transparent}
*::-webkit-scrollbar{display:none}

.gm{--gm-top-inset:12px;position:fixed;inset:0;display:flex;flex-direction:column;background:#f0ebe0;font-family:'Nunito',sans-serif;color:#2a1f0e;overflow:hidden;user-select:none}

/* Browser tabs and embedded webviews already start below their top chrome.
   Only installed/fullscreen experiences need the physical screen safe area. */
@media (display-mode:standalone),(display-mode:fullscreen){
  .gm{--gm-top-inset:max(12px,env(safe-area-inset-top,0px))}
}

/* top bar */
.gm-top{position:relative;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:var(--gm-top-inset) 18px 10px;flex-shrink:0}
.gm-brand{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.gm-brandText{min-width:0}
.gm-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;flex-shrink:0}

/* coin badge */
.gm-coin{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#b8892c,#d4ab55);border-radius:999px;padding:6px 14px 6px 9px;color:#fff;font-weight:800;font-size:14px;box-shadow:0 2px 10px rgba(184,137,44,.35);white-space:nowrap}
.gm-coin .ico{width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;font-size:13px}

/* wallet badge */
.gm-wallet{appearance:none;border:1px solid rgba(42,31,14,.10);border-radius:999px;background:rgba(255,255,255,.90);color:#2a1f0e;min-height:38px;padding:6px 11px;display:inline-flex;align-items:center;gap:8px;font-family:'Nunito',sans-serif;font-weight:900;font-size:12px;box-shadow:0 4px 16px rgba(42,31,14,.08);cursor:pointer;white-space:nowrap}
.gm-wallet:disabled{opacity:.7;cursor:default}
.gm-walletConnected{cursor:default;padding:4px 5px 4px 10px;gap:8px;background:rgba(255,255,255,.94);box-shadow:0 4px 18px rgba(42,31,14,.10),inset 0 1px 0 rgba(255,255,255,.75)}
.gm-walletDot{width:8px;height:8px;border-radius:999px;background:#25c26a;box-shadow:0 0 0 4px rgba(37,194,106,.12);margin-left:1px;flex:0 0 auto}
.gm-walletText{max-width:106px;overflow:hidden;text-overflow:ellipsis;line-height:1}
.gm-walletPower{appearance:none;width:30px;height:30px;border-radius:999px;border:1px solid rgba(42,31,14,.10);background:linear-gradient(180deg,#fffaf2,#f3ead8);color:#8a7d6a;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.78);transition:transform .15s,background .15s,color .15s}
.gm-walletPower svg{width:15px;height:15px;display:block;stroke:currentColor;stroke-width:2.4;fill:none;stroke-linecap:round;stroke-linejoin:round}
.gm-walletPower:hover{background:#fff;color:#6b5d4a}
.gm-walletPower:active,.gm-wallet:active{transform:translateY(1px)}
.gm-errorPill{position:relative;z-index:11;margin:-4px 18px 8px auto;width:fit-content;max-width:calc(100% - 36px);border-radius:999px;background:#fff1f1;color:#d73535;border:1px solid rgba(215,53,53,.16);padding:6px 10px;font-size:11px;font-weight:900;box-shadow:0 4px 16px rgba(215,53,53,.08)}
.gm-pageCoin{position:absolute;top:calc(54px + var(--gm-top-inset));right:16px;z-index:12;pointer-events:none}
.gm-pageCoinNudge{right:66px}

@media (max-width:390px){
  .gm-top{align-items:flex-start;gap:10px;padding:var(--gm-top-inset) 14px 8px}
  .gm-brand{min-width:0}
  .gm-brandText>div:first-child{font-size:15px}
  .gm-wallet{min-height:34px;padding:5px 9px;font-size:11px}
  .gm-walletConnected{padding:4px 5px 4px 9px}
  .gm-walletPower{width:28px;height:28px}
  .gm-walletPower svg{width:14px;height:14px}
  .gm-coin{font-size:12px;padding:5px 12px 5px 8px}
  .gm-coin .ico{width:19px;height:19px;font-size:11px}
  .gm-pageCoin{top:calc(46px + var(--gm-top-inset));right:14px}
  .gm-pageCoinNudge{right:58px}
}

.gm-homeHero{position:relative;padding:28px 20px 22px;text-align:center}
.gm-homeHeroCoin{position:absolute;top:16px;right:16px;z-index:2}

@media (max-width:390px){
  .gm-homeHero{padding:64px 18px 22px}
  .gm-homeHeroCoin{top:14px;right:14px}
}

/* body */
.gm-body{position:relative;z-index:1;flex:1;overflow-y:auto;overflow-x:hidden;padding:10px 16px 115px}

/* bottom nav */
.gm-nav{position:fixed;bottom:0;left:0;right:0;z-index:20;display:flex;background:#fff;border-radius:24px 24px 0 0;box-shadow:0 -4px 24px rgba(0,0,0,.08);padding:6px 0 max(8px,env(safe-area-inset-bottom))}
.gm-tb{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 0 4px;background:none;border:none;cursor:pointer;font-family:'Nunito',sans-serif;font-size:10px;font-weight:700;color:#b0a48e;transition:color .2s}
.gm-tb:active{transform:scale(.92)}
.gm-tb.on{color:#b8892c}
.gm-tb .ti{font-size:22px;transition:transform .2s}
.gm-tb.on .ti{transform:scale(1.15)}
.gm-tb .dot{width:5px;height:5px;border-radius:50%;background:#b8892c;opacity:0;transition:opacity .2s}
.gm-tb.on .dot{opacity:1}

/* play button */
.gm-playw{position:fixed;bottom:72px;left:0;right:0;display:flex;justify-content:center;z-index:30;pointer-events:none}
.gm-play{pointer-events:auto;background:linear-gradient(135deg,#b8892c,#8a6420);border:none;border-radius:999px;padding:16px 56px;font-family:'Nunito',sans-serif;font-size:16px;font-weight:900;letter-spacing:1px;color:#fff;cursor:pointer;box-shadow:0 6px 24px rgba(184,137,44,.45),0 2px 6px rgba(0,0,0,.15);transition:transform .15s,box-shadow .2s;text-transform:uppercase}
.gm-play:hover{transform:translateY(-2px);box-shadow:0 10px 36px rgba(184,137,44,.55),0 2px 6px rgba(0,0,0,.15)}
.gm-play:active{transform:scale(.96)}

/* soft card */
.gm-c{background:#fff;border-radius:20px;box-shadow:0 2px 12px rgba(42,31,14,.06);overflow:hidden;transition:transform .15s,box-shadow .2s}
.gm-c:active{transform:scale(.985)}
.gm-c.sel{box-shadow:0 2px 12px rgba(184,137,44,.18),0 0 0 2.5px #d4ab55}

/* pill tags */
.gm-pill{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}

/* stat bar */
.gm-bar{height:8px;border-radius:4px;background:#ede5d8;overflow:hidden}
.gm-fill{height:100%;border-radius:4px;transition:width .4s ease}

/* upgrade progress */
.gm-uprog{display:flex;gap:5px}
.gm-upip{flex:1;height:8px;border-radius:4px;transition:background .3s}

/* section title */
.gm-sec{font-size:20px;font-weight:900;margin-bottom:14px;display:flex;align-items:center;gap:8px}

/* map thumb */
.gm-mthumb{width:56px;height:56px;border-radius:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:26px;position:relative;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.gm-mthumb::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.2) 0%,transparent 50%);border-radius:inherit}

/* fade in */
@keyframes gmUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
.gm-body>div{animation:gmUp .4s ease both}

/* achievement row */
.gm-ach{display:flex;gap:12px;align-items:center;padding:14px 16px}
.gm-ach+.gm-ach{border-top:1px solid #f0ebe0}
`;

export function MainMenu({
  coins, bestM, selectedVehicle, selectedMap, selectedHead,
  garage, upgrades, achievements, totalRuns,
  onPlay, onSelectVehicle, onSelectMap, onSelectHead, onPurchaseVehicle, onUpgrade,
  walletAddress, walletSource, connectBusy = false, walletError = "", onConnectWallet, onDisconnectWallet,
}: MainMenuProps) {
  const [tab, setTab] = useState<Tab>("home");
  const scrollRef = useRef<HTMLDivElement>(null);

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const vc = VEHICLES[selectedVehicle];
  const mc = MAPS[selectedMap];
  const upg = upgrades[selectedVehicle];
  const unlockedCount = VEHICLE_ORDER.filter(id => id === "jeep" || id === "bicycle" || garage[id]).length;
  const achCount = Object.keys(achievements).length;

  const statColors = { Speed: "#e25c3e", Grip: "#38a169", Stability: "#3b82f6", Fuel: "#d4ab55" };

  const handleActionBtn = () => {
    if (tab === "home") switchTab("garage");
    else if (tab === "garage") switchTab("maps");
    else if (tab === "maps") onPlay();
    else switchTab("garage");
  };

  const btnLabel = tab === "garage" ? "▶ Next: Select Map" : "▶ Start Race";
  const showPageCoin = tab === "garage" || tab === "maps";

  return (
    <div className="gm">
      <style>{CSS}</style>

      {/* ═══ TOP BAR ═══ */}
      <div className="gm-top">
        <div className="gm-brand">
          <img src="/icon.png" alt="Logo" style={{
            width: 38, height: 38, borderRadius: 12,
            boxShadow: "0 2px 8px rgba(184,137,44,.3)",
          }} />
          <div className="gm-brandText">
            <div style={{ fontSize: 16, fontWeight: 900, color: "#2a1f0e", whiteSpace: "nowrap" }}>Jesse Hill Climb</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#b0a48e", letterSpacing: 1 }}>RACING GAME</div>
          </div>
        </div>
        <div className="gm-actions">
          {walletAddress ? (
            <div className="gm-wallet gm-walletConnected" title={walletSource || "Connected wallet"}>
              <span className="gm-walletDot" />
              <span className="gm-walletText">{shortWalletAddress(walletAddress)}</span>
              <button type="button" className="gm-walletPower" onClick={(event) => { event.stopPropagation(); onDisconnectWallet?.(); }} aria-label="Disconnect wallet" title="Disconnect wallet">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 3v8" />
                  <path d="M7.05 7.05a7 7 0 1 0 9.9 0" />
                </svg>
              </button>
            </div>
          ) : (
            <button type="button" className="gm-wallet" onClick={onConnectWallet} disabled={connectBusy}>
              <span className="gm-walletDot" style={{ background: connectBusy ? "#d4ab55" : "#b0a48e", boxShadow: connectBusy ? "0 0 0 4px rgba(212,171,85,.12)" : "none" }} />
              <span>{connectBusy ? "Connecting…" : "Connect"}</span>
            </button>
          )}
        </div>
      </div>
      {walletError ? <div className="gm-errorPill">⚠ {walletError}</div> : null}
      {showPageCoin ? (
        <div className="gm-pageCoin gm-coin" aria-label="Coins balance">
          <div className="ico">🪙</div>
          <span>{coins.toLocaleString()}</span>
        </div>
      ) : null}

      {/* ═══ BODY ═══ */}
      <div ref={scrollRef} className="gm-body">

        {/* ══════ HOME ══════ */}
        {tab === "home" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Hero vehicle showcase */}
            <div className="gm-c" style={{
              background: "linear-gradient(150deg,#faf6ed 0%,#f3ead8 100%)",
            }}>
              <div className="gm-homeHero">
                <div className="gm-homeHeroCoin gm-coin" aria-label="Coins balance">
                  <div className="ico">🪙</div>
                  <span>{coins.toLocaleString()}</span>
                </div>
              <div style={{ fontSize: 64, lineHeight: 1, marginBottom: 12 }}>{vc.emoji}</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#2a1f0e", marginBottom: 4 }}>{vc.name}</div>
              <div style={{ fontSize: 13, color: "#8a7d6a", marginBottom: 14 }}>{vc.tagline}</div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <span className="gm-pill" style={{ background: "#fff", color: "#6b5d4a", boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>{mc.emoji} {mc.name}</span>
                <span className="gm-pill" style={{ background: "#fff", color: "#b8892c", boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>🏆 Best: {bestM}m</span>
              </div>
              </div>
            </div>

            {/* Stats row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              {[
                { ico: "🏆", val: `${bestM}m`, label: "Best Run", tint: "#f3e8ff", accent: "#8b5cf6" },
                { ico: "🚗", val: `${unlockedCount}/${VEHICLE_ORDER.length}`, label: "Cars", tint: "#fef3c7", accent: "#b8892c" },
                { ico: "🏅", val: `${achCount}/11`, label: "Trophies", tint: "#fee2e2", accent: "#e25c3e" },
              ].map(s => (
                <div key={s.label} className="gm-c" style={{ padding: "16px 10px", textAlign: "center" }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 10, margin: "0 auto 8px",
                    background: s.tint, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
                  }}>{s.ico}</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: s.accent, lineHeight: 1 }}>{s.val}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#b0a48e", marginTop: 4, textTransform: "uppercase", letterSpacing: .5 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Quick nav */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {([
                { t: "garage" as Tab, ico: "🚗", l: "Cars", s: "Pick your ride", bg: "linear-gradient(145deg,#3b82f6,#2563eb)" },
                { t: "maps" as Tab, ico: "🗺️", l: "Maps", s: "Choose terrain", bg: "linear-gradient(145deg,#38a169,#2d8a56)" },
                { t: "upgrades" as Tab, ico: "⚙️", l: "Upgrades", s: "Power up", bg: "linear-gradient(145deg,#d4ab55,#b8892c)" },
                { t: "achievements" as Tab, ico: "🏅", l: "Trophies", s: `${achCount}/11`, bg: "linear-gradient(145deg,#e25c3e,#c44020)" },
              ]).map(c => (
                <button key={c.t} onClick={() => switchTab(c.t)} style={{
                  background: c.bg, borderRadius: 20, padding: "20px 16px",
                  border: "none", cursor: "pointer", textAlign: "left", color: "#fff",
                  boxShadow: "0 4px 16px rgba(0,0,0,.1)",
                  display: "flex", flexDirection: "column", gap: 6,
                  transition: "transform .15s",
                }}>
                  <span style={{ fontSize: 28 }}>{c.ico}</span>
                  <span style={{ fontSize: 15, fontWeight: 900 }}>{c.l}</span>
                  <span style={{ fontSize: 11, opacity: .8, fontWeight: 600 }}>{c.s}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ══════ GARAGE (CARS) ══════ */}
        {tab === "garage" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* Driver picker */}
            <div>
              <div className="gm-sec">👤 Driver</div>
              <div style={{ display: "flex", gap: 12 }}>
                {(Object.keys(HEADS) as HeadId[]).map(hid => {
                  const sel = selectedHead === hid;
                  return (
                    <button key={hid} onClick={() => onSelectHead(hid)}
                      className={`gm-c ${sel ? "sel" : ""}`}
                      style={{
                        flex: 1, cursor: "pointer", padding: "18px 12px", textAlign: "center",
                        border: "none", color: "#2a1f0e",
                      }}>
                      <div style={{
                        width: 52, height: 52, borderRadius: 16, margin: "0 auto 10px",
                        background: sel ? "rgba(184,137,44,.1)" : "#f0ebe0",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        boxShadow: sel ? "0 2px 10px rgba(184,137,44,.2)" : "none",
                      }}>
                        <img src={HEADS[hid].src} alt={HEADS[hid].label} style={{ width: 36, height: 36, imageRendering: "pixelated" }} />
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 800 }}>{HEADS[hid].label}</div>
                      {sel && (
                        <div className="gm-pill" style={{ background: "linear-gradient(135deg,#b8892c,#d4ab55)", color: "#fff", fontSize: 9, marginTop: 6, display: "inline-flex" }}>
                          SELECTED
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Vehicles */}
            <div>
              <div className="gm-sec">🚗 Cars</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {VEHICLE_ORDER.map(vid => {
                  const v = VEHICLES[vid];
                  const unlocked = vid === "jeep" || vid === "bicycle" || Boolean(garage[vid]);
                  const active = selectedVehicle === vid;
                  const canBuy = !unlocked && coins >= v.price;

                  return (
                    <button key={vid} onClick={() => {
                      if (!unlocked) { if (canBuy) onPurchaseVehicle(vid, v.price); return; }
                      onSelectVehicle(vid);
                    }} className={`gm-c ${active ? "sel" : ""}`}
                      style={{
                        display: "flex", gap: 14, alignItems: "center", padding: "16px",
                        border: "none", cursor: unlocked || canBuy ? "pointer" : "default",
                        textAlign: "left", color: "#2a1f0e",
                        opacity: !unlocked && !canBuy ? 0.5 : 1,
                      }}>

                      <div style={{
                        width: 64, height: 64, borderRadius: 18, flexShrink: 0,
                        background: active ? `${v.visual.bodyColor}15` : "#f0ebe0",
                        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34,
                        boxShadow: active ? `0 3px 12px ${v.visual.bodyColor}25` : "none",
                      }}>{v.emoji}</div>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 16, fontWeight: 900 }}>{v.name}</span>
                          {active && (
                            <span className="gm-pill" style={{ background: "linear-gradient(135deg,#b8892c,#d4ab55)", color: "#fff", fontSize: 9 }}>SELECTED</span>
                          )}
                          {!unlocked && (
                            <span className="gm-pill" style={{
                              background: canBuy ? "rgba(56,161,105,.1)" : "rgba(226,92,62,.1)",
                              color: canBuy ? "#38a169" : "#e25c3e", fontSize: 9,
                            }}>
                              {canBuy ? `BUY · ${v.price}🪙` : `🔒 ${v.price}🪙`}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: "#8a7d6a", marginBottom: 8 }}>{v.tagline}</div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 18px" }}>
                          {(["Speed", "Grip", "Stability", "Fuel"] as const).map(name => {
                            const val = v.stats[name.toLowerCase() as keyof typeof v.stats];
                            return (
                              <div key={name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: "#b0a48e", width: 54, flexShrink: 0 }}>{name}</span>
                                <div className="gm-bar" style={{ flex: 1 }}>
                                  <div className="gm-fill" style={{ width: `${(val / 5) * 100}%`, background: statColors[name] }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ══════ MAPS ══════ */}
        {tab === "maps" && (
          <div>
            <div className="gm-sec">🗺️ Choose Terrain</div>
            <div style={{ fontSize: 13, color: "#8a7d6a", marginBottom: 16, marginTop: -8 }}>Each map has unique gravity, grip, and weather effects</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {MAP_ORDER.map(mid => {
                const m = MAPS[mid];
                const sel = selectedMap === mid;
                return (
                  <button key={mid} onClick={() => onSelectMap(mid)}
                    className={`gm-c ${sel ? "sel" : ""}`}
                    style={{
                      display: "flex", gap: 14, alignItems: "center", padding: "16px",
                      border: "none", cursor: "pointer", textAlign: "left", color: "#2a1f0e",
                    }}>
                    <div className="gm-mthumb" style={{ background: `linear-gradient(180deg,${m.colors.skyTop},${m.colors.skyHorizon} 55%,${m.colors.grassColor})` }}>{m.emoji}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 17, fontWeight: 900 }}>{m.name}</span>
                        {sel && <span className="gm-pill" style={{ background: "linear-gradient(135deg,#b8892c,#d4ab55)", color: "#fff", fontSize: 9 }}>SELECTED</span>}
                      </div>
                      <div style={{ fontSize: 12, color: "#8a7d6a", marginBottom: 8 }}>{m.tagline}</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <span className="gm-pill" style={{ background: "#f0ebe0", color: "#6b5d4a", fontSize: 10 }}>Gravity: {m.gravity === -10 ? "Normal" : "Low"}</span>
                        <span className="gm-pill" style={{ background: "#f0ebe0", color: "#6b5d4a", fontSize: 10 }}>Grip: {m.groundFriction >= 0.8 ? "High" : m.groundFriction >= 0.5 ? "Med" : "Low"}</span>
                        {m.iceZones && <span className="gm-pill" style={{ background: "rgba(59,130,246,.1)", color: "#3b82f6", fontSize: 10 }}>❄️ Ice</span>}
                        {m.snowParticles && <span className="gm-pill" style={{ background: "rgba(148,163,184,.1)", color: "#64748b", fontSize: 10 }}>🌨 Snow</span>}
                        {m.dustParticles && <span className="gm-pill" style={{ background: "rgba(184,137,44,.1)", color: "#b8892c", fontSize: 10 }}>🌪 Dust</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ══════ UPGRADES ══════ */}
        {tab === "upgrades" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div className="gm-sec" style={{ marginBottom: 0 }}>⚙️ Upgrades</div>
              <div className="gm-coin" style={{ fontSize: 12, padding: "4px 12px 4px 8px" }}>
                <div className="ico" style={{ width: 18, height: 18, fontSize: 11 }}>🪙</div>
                <span>{coins.toLocaleString()}</span>
              </div>
            </div>
            <div style={{ fontSize: 13, color: "#8a7d6a", marginBottom: 16 }}>Upgrading: <strong style={{ color: "#b8892c" }}>{vc.name}</strong></div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {UPGRADE_CATEGORIES.map(cat => {
                const meta = UPGRADE_META[cat];
                const curLvl = upg[cat] ?? 0;
                const cost = upgradeCostForLevel(curLvl);
                const maxed = curLvl >= MAX_LEVEL;
                const canAfford = !maxed && coins >= cost;

                return (
                  <div key={cat} className="gm-c" style={{ padding: "18px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{
                          width: 40, height: 40, borderRadius: 12,
                          background: maxed ? "linear-gradient(135deg,#38a169,#2d8a56)" : "linear-gradient(135deg,#b8892c,#d4ab55)",
                          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
                          color: "#fff", boxShadow: "0 2px 8px rgba(0,0,0,.1)",
                        }}>{meta.emoji}</div>
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 900 }}>{meta.name}</div>
                          <div style={{ fontSize: 11, color: "#8a7d6a" }}>{meta.description}</div>
                        </div>
                      </div>
                      <span className="gm-pill" style={{
                        background: maxed ? "rgba(56,161,105,.1)" : "rgba(184,137,44,.1)",
                        color: maxed ? "#38a169" : "#b8892c", fontSize: 10, fontWeight: 900,
                      }}>{maxed ? "MAX" : `${curLvl}/${MAX_LEVEL}`}</span>
                    </div>

                    <div className="gm-uprog" style={{ marginBottom: 14 }}>
                      {Array.from({ length: MAX_LEVEL }).map((_, i) => (
                        <div key={i} className="gm-upip" style={{ background: i < curLvl ? (maxed ? "#38a169" : "#d4ab55") : "#ede5d8" }} />
                      ))}
                    </div>

                    <button disabled={maxed || !canAfford} onClick={() => { if (!maxed && canAfford) onUpgrade(selectedVehicle, cat); }}
                      style={{
                        width: "100%", padding: "12px", borderRadius: 14, border: "none", fontFamily: "'Nunito',sans-serif", fontWeight: 800, fontSize: 13,
                        cursor: maxed || !canAfford ? "default" : "pointer", transition: "transform .15s",
                        background: maxed ? "rgba(56,161,105,.08)" : canAfford ? "linear-gradient(135deg,#b8892c,#8a6420)" : "#ede5d8",
                        color: maxed ? "#38a169" : canAfford ? "#fff" : "#b0a48e",
                        boxShadow: canAfford && !maxed ? "0 3px 12px rgba(184,137,44,.3)" : "none",
                      }}>
                      {maxed ? "✦ Maxed Out" : canAfford ? `Upgrade · 🪙 ${cost.toLocaleString()}` : `🔒 Need 🪙 ${cost.toLocaleString()}`}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ══════ ACHIEVEMENTS ══════ */}
        {tab === "achievements" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div className="gm-sec" style={{ marginBottom: 0 }}>🏅 Trophies</div>
              <span className="gm-pill" style={{ background: "rgba(184,137,44,.1)", color: "#b8892c", fontWeight: 900, fontSize: 11 }}>{achCount}/{ACHIEVEMENTS.length}</span>
            </div>
            <div style={{ fontSize: 13, color: "#8a7d6a", marginBottom: 16 }}>{totalRuns} runs completed · earn coins by unlocking achievements</div>

            <div className="gm-c" style={{ padding: "16px", marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#8a7d6a" }}>Overall Progress</span>
                <span style={{ fontSize: 12, fontWeight: 900, color: "#b8892c" }}>{Math.round((achCount / ACHIEVEMENTS.length) * 100)}%</span>
              </div>
              <div className="gm-bar" style={{ height: 10, borderRadius: 5 }}>
                <div className="gm-fill" style={{ width: `${(achCount / ACHIEVEMENTS.length) * 100}%`, background: "linear-gradient(90deg,#b8892c,#d4ab55)", borderRadius: 5 }} />
              </div>
            </div>

            <div className="gm-c">
              {ACHIEVEMENTS.map(ach => {
                const done = Boolean(achievements[ach.id]);
                return (
                  <div key={ach.id} className="gm-ach" style={{ opacity: done ? 1 : 0.45 }}>
                    <div style={{
                      width: 48, height: 48, borderRadius: 14, flexShrink: 0, background: done ? "rgba(184,137,44,.08)" : "#f0ebe0",
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, boxShadow: done ? "0 2px 8px rgba(184,137,44,.15)" : "none",
                    }}>{done ? ach.emoji : "🔒"}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 900 }}>{ach.name}</div>
                      <div style={{ fontSize: 11, color: "#8a7d6a", marginTop: 2 }}>{ach.description}</div>
                    </div>
                    <div style={{ flexShrink: 0, textAlign: "center" }}>
                      <div style={{ fontSize: 16, fontWeight: 900, color: done ? "#b8892c" : "#d4d0c8" }}>+{ach.reward}</div>
                      <div style={{ fontSize: 9, fontWeight: 700, color: "#b0a48e" }}>🪙</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ═══ BOTTOM NAV ═══ */}
      <div className="gm-nav">
        {([
          { id: "home" as Tab, ico: "🏠", l: "Home" },
          { id: "garage" as Tab, ico: "🚗", l: "Cars" },
          { id: "maps" as Tab, ico: "🗺️", l: "Maps" },
          { id: "upgrades" as Tab, ico: "⚙️", l: "Upgrade" },
          { id: "achievements" as Tab, ico: "🏅", l: "Trophies" },
        ]).map(t => (
          <button key={t.id} onClick={() => switchTab(t.id)} className={`gm-tb ${tab === t.id ? "on" : ""}`}>
            <span className="ti">{t.ico}</span>
            <span>{t.l}</span>
            <div className="dot" />
          </button>
        ))}
      </div>

      {/* ═══ PLAY ═══ */}
      <div className="gm-playw">
        <button onClick={handleActionBtn} className="gm-play">{btnLabel}</button>
      </div>
    </div>
  );
}
