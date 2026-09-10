"use client";

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import planck from "planck-js";
import { HeadId, HEADS } from "@/lib/heads";
import { VehicleId, VEHICLES } from "@/lib/vehicles";
import { MapId, MAPS, MapConfig } from "@/lib/maps";
import { audioManager } from "@/lib/audio";

export type HillClimbState = {
  distanceM: number;
  bestM: number;
  coins: number;
  fuel: number;
  status: "IDLE" | "RUN" | "CRASH" | "OUT_OF_FUEL";
  rpm01: number;
  boost01: number;
  speedKmh: number;
  airtimeS: number;
  flips: number;
  toast: string;
  toastT: number;
};

export type HillClimbHandle = {
  setThrottle: (t: number) => void;
  setBoost: (on: boolean) => void;
  reset: () => void;
};

const Vec2 = planck.Vec2;
let SCALE = 45;
const HZ = 60;
const DT = 1 / HZ;
const VEL_ITERS = 8;
const POS_ITERS = 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

const TRACK_X0 = -40;
const TRACK_X1 = 1800;
const TRACK_DX = 0.25;
const JEEP_BODY_SRC = "/assets/vehicles/jeep_body.png";
const JEEP_WHEEL_SRC = "/assets/vehicles/jeep_wheel.png";
const SPORTS_CAR_BODY_SRC = "/assets/vehicles/sports_car_body.png";
const SPORTS_CAR_WHEEL_SRC = "/assets/vehicles/sports_car_wheel.png";

const JEEP_REAR_WHEEL_X_PCT = 0.213;
const JEEP_FRONT_WHEEL_X_PCT = 0.755;
const JEEP_WHEEL_Y_PCT = 0.795;
const JEEP_WHEEL_SEPARATION_PCT = JEEP_FRONT_WHEEL_X_PCT - JEEP_REAR_WHEEL_X_PCT;

// Sports car desktop zoom: phone already looks good, but wide desktop screens made the car too tiny.
// This only changes the sports car camera scale on desktop; mobile and other vehicles stay unchanged.
const SPORTS_CAR_DESKTOP_MIN_CSS_W = 760;
const SPORTS_CAR_DESKTOP_TARGET_WORLD_W = 12.6;
const SPORTS_CAR_DESKTOP_MIN_PX_PER_M = 42;
const SPORTS_CAR_DESKTOP_MAX_PX_PER_M = 74;

function isPhoneSizedViewport(cssW: number, cssH: number) {
  const shortEdge = Math.min(cssW, cssH);
  const coarsePointer = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  return shortEdge <= 520 || (coarsePointer && shortEdge <= 620);
}

type Track = { xs: number[]; ys: number[] };

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTrack(seed = 1337): Track {
  const rnd = mulberry32(seed);
  const xs: number[] = [];
  const ys: number[] = [];

  type SegKind = "flat" | "roll" | "hill";
  const smooth01 = (t: number) => {
    const u = clamp01(t);
    return u * u * (3 - 2 * u);
  };

  let x = TRACK_X0;
  let y = 0.86;
  let lastDy = 0;
  let kind: SegKind = "flat";
  let segLen = 24;
  let segT = 0;
  let y0 = y;
  let y1 = y;
  let bump = 0;
  let phase = rnd() * Math.PI * 2;

  const SLOPE_KIND_MUL: Record<SegKind, number> = { flat: 1, roll: 1.08, hill: 1.16 };

  const chooseSeg = (d: number) => {
    const diff = clamp01((d - 2) / 160);
    if (d < 25) {
      kind = "hill";
    } else if (d < 60) {
      kind = rnd() < 0.15 ? "roll" : "hill";
    } else {
      const wFlat = 0.08, wRoll = 0.32, wHill = 0.60 + 0.32 * diff;
      const r = rnd() * (wFlat + wRoll + wHill);
      if (r < wFlat) kind = "flat";
      else if (r < wFlat + wRoll) kind = "roll";
      else kind = "hill";
    }

    const baseline = 0.95 + 0.35 * diff;
    const basePull = (baseline - y) * (kind === "hill" ? 0.55 : 0.80);

    if (kind === "flat") {
      y1 = y0 + basePull + (rnd() * 2 - 1) * 0.10;
      bump = 0;
      segLen = 10 + rnd() * 18;
    } else if (kind === "roll") {
      y1 = y0 + basePull + (rnd() * 2 - 1) * (0.34 + 0.20 * diff);
      bump = 0.55 + rnd() * (0.75 + 0.40 * diff);
      segLen = 14 + rnd() * 22;
      // Ensure smooth slope: max sine derivative is bump * 2 * PI / segLen
      segLen = Math.max(segLen, bump * 12); 
    } else {
      y1 = y0 + basePull + (rnd() * 2 - 1) * (1.10 + 0.95 * diff);
      bump = 1.60 + rnd() * (2.35 + 1.75 * diff);
      if (rnd() < 0.30 + 0.20 * diff) bump *= 1.35;
      segLen = 18 + rnd() * 44;
      // Ensure smooth slope: max sine derivative is bump * PI / segLen. We limit slope to ~0.35.
      segLen = Math.max(segLen, bump * 10);
    }

    segT = 0;
    y0 = y;
    phase = rnd() * Math.PI * 2;
  };

  chooseSeg(0);

  while (x <= TRACK_X1) {
    const d = x - TRACK_X0;
    if (segT >= segLen) chooseSeg(d);

    const startEase = clamp01(d / 20); // 20 meters of gentle start
    const diff = clamp01((d - 10) / 220);
    const easy = 1 - clamp01((d - 2) / 40);

    const slopeKindMul = SLOPE_KIND_MUL[kind];
    const slopeMaxBase = (0.28 * easy) + (0.44 + 0.52 * diff) * (1 - easy);
    const slopeMax = clamp(slopeMaxBase * (0.40 + 0.60 * startEase) * slopeKindMul, 0.08, 0.42); 
    const maxStep = slopeMax * TRACK_DX;
    const curvMax = (0.020 + 0.026 * diff) * TRACK_DX;

    const u = clamp01(segT / Math.max(0.001, segLen));
    const su = smooth01(u);
    let targetY = y0 + (y1 - y0) * su;

    if ((kind as SegKind) === "roll") {
      targetY += bump * Math.sin(u * Math.PI * 2 + phase);
    } else if ((kind as SegKind) === "hill") {
      targetY += bump * Math.sin(u * Math.PI);
    }

    const micro = (Math.sin((x + 12.3) * 0.85) * 0.012 + Math.sin((x - 7.1) * 1.95) * 0.005) * startEase;
    targetY += micro;

    let dy = clamp(targetY - y, -maxStep, maxStep);
    dy = clamp(dy, lastDy - curvMax, lastDy + curvMax);
    lastDy = dy;

    y = clamp(y + dy, -0.55, 4.9);
    xs.push(x);
    ys.push(y);

    x += TRACK_DX;
    segT += TRACK_DX;
  }

  for (let k = 0; k < 2; k++) {
    for (let i = 1; i < ys.length - 1; i++) {
      ys[i] = ys[i] * 0.50 + (ys[i - 1] + ys[i + 1]) * 0.25;
    }
  }

  const PAD_X0 = -4, PAD_X1 = 8, PAD_BLEND = 25; // Blended over 25 meters instead of 3!
  const i0 = Math.max(0, Math.min(ys.length - 1, Math.round((0 - TRACK_X0) / TRACK_DX)));
  const yPad = ys[i0];

  for (let i = 0; i < xs.length; i++) {
    const xx = xs[i];
    if (xx >= PAD_X0 && xx <= PAD_X1) {
      ys[i] = yPad;
    } else if (xx > PAD_X0 - PAD_BLEND && xx < PAD_X0) {
      const t = smooth01((xx - (PAD_X0 - PAD_BLEND)) / PAD_BLEND);
      ys[i] = ys[i] * (1 - t) + yPad * t;
    } else if (xx > PAD_X1 && xx < PAD_X1 + PAD_BLEND) {
      const t = smooth01((xx - PAD_X1) / PAD_BLEND);
      ys[i] = yPad * (1 - t) + ys[i] * t;
    }
  }

  return { xs, ys };
}

function sampleTrackY(track: Track, x: number) {
  if (x <= track.xs[0]) return track.ys[0];
  if (x >= track.xs[track.xs.length - 1]) return track.ys[track.ys.length - 1];
  const i = Math.floor((x - TRACK_X0) / TRACK_DX);
  const i0 = Math.max(0, Math.min(track.xs.length - 2, i));
  const x0 = track.xs[i0], x1 = track.xs[i0 + 1];
  const y0 = track.ys[i0], y1 = track.ys[i0 + 1];
  const u = (x - x0) / (x1 - x0);
  return y0 + (y1 - y0) * u;
}

type Pickup = { kind: "coin" | "fuel"; x: number; y: number; value: number; taken?: boolean };

type CarRig = {
  chassis: planck.Body;
  wheel1: planck.Body;
  wheel2: planck.Body;
  spring1: planck.WheelJoint;
  spring2: planck.WheelJoint;
};

export const HillClimbCanvas = forwardRef<
  HillClimbHandle,
  {
    headId: HeadId;
    vehicleId: VehicleId;
    mapId: MapId;
    paused: boolean;
    miniMode?: boolean;
    seed?: number;
    onState: (s: HillClimbState) => void;
    bestM?: number;
    onGameOver?: (p: { snapshotDataUrl: string | null; meters: number; coins: number; status: "CRASH" | "OUT_OF_FUEL" }) => void;
  }
>(function HillClimbCanvas(props, ref) {
  const { headId, vehicleId, mapId, paused, miniMode, seed, onState, bestM, onGameOver } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const pausedRef = useRef(paused);
  const headIdRef = useRef(headId);
  const vehicleIdRef = useRef(vehicleId);
  const mapIdRef = useRef(mapId);
  const miniModeRef = useRef(Boolean(miniMode));
  const onGameOverRef = useRef(onGameOver);

  const throttleTargetRef = useRef(0);
  const throttleRef = useRef(0);
  const boostHeldRef = useRef(false);
  const camRef = useRef({ x: 0, y: 0 });

  const bestRef = useRef(0);
  const groundedRef = useRef({ w1: 0, w2: 0 });
  const crashFreezeRef = useRef({ t: 0, frozen: false });
  const upsideCrashRef = useRef(0);

  const worldRef = useRef<planck.World | null>(null);
  const carRef = useRef<CarRig | null>(null);
  const pickupsRef = useRef<Pickup[]>([]);
  const trackRef = useRef<Track>(buildTrack());
  const seedRef = useRef<number>(1337);

  const timeRef = useRef(0);
  const snapshotRef = useRef<string | null>(null);
  const lastSnapTRef = useRef(0);
  const lastEndStatusRef = useRef<"CRASH" | "OUT_OF_FUEL" | null>(null);

  const airRef = useRef<{ active: boolean; t: number; acc: number; lastAngle: number; flipCount: number; }>({ active: false, t: 0, acc: 0, lastAngle: 0, flipCount: 0 });
  const headImgRef = useRef<HTMLImageElement | null>(null);
  const headImg2Ref = useRef<HTMLImageElement | null>(null);
  const jeepBodyImgRef = useRef<HTMLImageElement | null>(null);
  const jeepWheelImgRef = useRef<HTMLImageElement | null>(null);
  const sportsCarBodyImgRef = useRef<HTMLImageElement | null>(null);
  const sportsCarWheelImgRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef({ cssW: 0, cssH: 0, isPhone: false });

  const stateRef = useRef<HillClimbState>({
    distanceM: 0, bestM: 0, coins: 0, fuel: 100, status: "IDLE",
    rpm01: 0, boost01: 0, speedKmh: 0, airtimeS: 0, flips: 0, toast: "", toastT: 0,
  });

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { miniModeRef.current = Boolean(miniMode); }, [miniMode]);
  useEffect(() => { headIdRef.current = headId; }, [headId]);
  useEffect(() => { onGameOverRef.current = onGameOver; }, [onGameOver]);

  const updateScaleForViewport = (cssW: number, cssH: number) => {
    const isPhone = miniModeRef.current || isPhoneSizedViewport(cssW, cssH);
    const isSportsCarDesktop =
      vehicleIdRef.current === "sportsCar" && !isPhone && cssW >= SPORTS_CAR_DESKTOP_MIN_CSS_W;

    const targetWorldWidthM = isPhone
      ? 18
      : isSportsCarDesktop
        ? SPORTS_CAR_DESKTOP_TARGET_WORLD_W
        : 20;
    const raw = cssW / targetWorldWidthM;
    const minPxPerM = isPhone ? 18 : isSportsCarDesktop ? SPORTS_CAR_DESKTOP_MIN_PX_PER_M : 28;
    const maxPxPerM = isPhone ? 32 : isSportsCarDesktop ? SPORTS_CAR_DESKTOP_MAX_PX_PER_M : 46;

    SCALE = Math.max(minPxPerM, Math.min(maxPxPerM, raw));
    viewportRef.current = { cssW, cssH, isPhone };
  };

  useEffect(() => {
    if (vehicleIdRef.current !== vehicleId || mapIdRef.current !== mapId || seedRef.current !== resolveSeed()) {
      vehicleIdRef.current = vehicleId;
      mapIdRef.current = mapId;
      reset();
    }
  }, [vehicleId, mapId, seed]);

  useEffect(() => {
    const bm = typeof bestM === "number" && Number.isFinite(bestM) ? bestM : 0;
    bestRef.current = bm;
    stateRef.current.bestM = bm;
    onState({ ...stateRef.current });
  }, [bestM, onState]);

  const resolveSeed = () => {
    const s = typeof seed === "number" && Number.isFinite(seed) ? Math.floor(seed) : Math.floor(Math.random() * 0xffffffff);
    return s >>> 0;
  };

  const reset = () => {
    throttleTargetRef.current = 0;
    throttleRef.current = 0;
    boostHeldRef.current = false;
    snapshotRef.current = null;
    lastSnapTRef.current = 0;
    lastEndStatusRef.current = null;

    seedRef.current = resolveSeed();
    const bm = typeof bestM === "number" && Number.isFinite(bestM) ? bestM : 0;
    bestRef.current = bm;
    groundedRef.current = { w1: 0, w2: 0 };
    crashFreezeRef.current = { t: 0, frozen: false };
    upsideCrashRef.current = 0;
    airRef.current = { active: false, t: 0, acc: 0, lastAngle: 0, flipCount: 0 };

    stateRef.current = {
      distanceM: 0, bestM: bestRef.current, coins: 0, fuel: 100, status: "IDLE",
      rpm01: 0, boost01: 0, speedKmh: 0, airtimeS: 0, flips: 0, toast: "", toastT: 0,
    };

    buildWorld();
    onState({ ...stateRef.current });
  };

  const buildWorld = () => {
    const mConfig = MAPS[mapIdRef.current];
    const track = buildTrack(seedRef.current ^ mConfig.seedOffset);
    trackRef.current = track;

    const world = new planck.World(Vec2(0, mConfig.gravity));
    worldRef.current = world;

    groundedRef.current = { w1: 0, w2: 0 };
    crashFreezeRef.current = { t: 0, frozen: false };
    upsideCrashRef.current = 0;
    airRef.current = { active: false, t: 0, acc: 0, lastAngle: 0, flipCount: 0 };

    const ground = world.createBody();
    ground.setUserData({ kind: "ground" });

    const pts: planck.Vec2[] = [];
    for (let i = 0; i < track.xs.length; i++) pts.push(Vec2(track.xs[i], track.ys[i]));

    ground.createFixture(planck.Chain(pts, false), { friction: mConfig.groundFriction });
    ground.createFixture(planck.Edge(Vec2(TRACK_X0 - 200, -18), Vec2(TRACK_X1 + 200, -18)), { friction: 0.9 });

    const spawnX = 0;
    const groundY0 = sampleTrackY(track, spawnX);
    const vPhys = VEHICLES[vehicleIdRef.current].physics;
    const spawnY = groundY0 + vPhys.spawnY;

    const chassis = world.createDynamicBody({
      position: Vec2(spawnX, spawnY),
      angularDamping: vPhys.chassisAngularDamping,
      linearDamping: vPhys.chassisLinearDamping,
      bullet: true,
    });
    chassis.setUserData({ kind: "chassis" });

    if (vehicleIdRef.current === "bicycle") {
      chassis.createFixture(planck.Box(0.5, 0.1), { density: vPhys.chassisDensity, friction: 0.25 });
      chassis.createFixture(planck.Box(0.1, 0.3, Vec2(-0.2, 0.2), 0), { density: vPhys.chassisDensity });
    } else if (vehicleIdRef.current === "sportsCar") {
      chassis.createFixture(planck.Box(1.2, 0.15), { density: vPhys.chassisDensity, friction: 0.25 });
      chassis.createFixture(planck.Box(0.6, 0.15, Vec2(-0.2, 0.2), 0), { density: vPhys.chassisDensity * 0.5 });
    } else {
      // Jeep-only chassis retune: keep the heavy lower rail above the wheel line so the body no longer feels sunk into the tires.
      chassis.createFixture(planck.Box(1.18, 0.20, Vec2(0.00, 0.03), 0), { density: vPhys.chassisDensity, friction: 0.30 });
      chassis.createFixture(planck.Box(0.50, 0.20, Vec2(-0.18, 0.36), 0), { density: vPhys.chassisDensity * 0.55, friction: 0.28 });
      chassis.createFixture(planck.Box(0.72, 0.08, Vec2(0.03, -0.16), 0), { density: vPhys.chassisDensity * 1.25, friction: 0.35 });
    }

    const wheelRadius = vPhys.wheelRadius;
    const wheelY0 = groundY0 + wheelRadius + 0.2;
    const wheel1 = world.createDynamicBody({ position: Vec2(spawnX - vPhys.wheelbase, wheelY0), angularDamping: vPhys.wheelAngularDamping, bullet: true });
    const wheel2 = world.createDynamicBody({ position: Vec2(spawnX + vPhys.wheelbase, wheelY0), angularDamping: vPhys.wheelAngularDamping, bullet: true });
    wheel1.setUserData({ kind: "wheel1" });
    wheel2.setUserData({ kind: "wheel2" });

    wheel1.createFixture(planck.Circle(wheelRadius), { density: vPhys.wheelDensity, friction: vPhys.wheelFriction });
    wheel2.createFixture(planck.Circle(wheelRadius), { density: vPhys.wheelDensity, friction: vPhys.wheelFriction });

    const axis = Vec2(0, 1);
    const common = {
      collideConnected: false,
      enableMotor: true,
      motorSpeed: 0,
      maxMotorTorque: vPhys.maxMotorTorque,
      frequencyHz: vPhys.suspensionHz,
      dampingRatio: vPhys.suspensionDamping,
    };

    const spring1 = world.createJoint(planck.WheelJoint(common as any, chassis, wheel1, wheel1.getPosition(), axis)) as planck.WheelJoint;
    const spring2 = world.createJoint(planck.WheelJoint(common as any, chassis, wheel2, wheel2.getPosition(), axis)) as planck.WheelJoint;

    carRef.current = { chassis, wheel1, wheel2, spring1, spring2 };

    chassis.setAngle(0);
    chassis.setAngularVelocity(0);

    world.on("begin-contact", (c: planck.Contact) => {
      const a = c.getFixtureA().getBody();
      const b = c.getFixtureB().getBody();
      const ak = (a.getUserData() as any)?.kind;
      const bk = (b.getUserData() as any)?.kind;

      if ((ak === "wheel1" && bk === "ground") || (ak === "ground" && bk === "wheel1")) groundedRef.current.w1++;
      if ((ak === "wheel2" && bk === "ground") || (ak === "ground" && bk === "wheel2")) groundedRef.current.w2++;
    });

    world.on("end-contact", (c: planck.Contact) => {
      const a = c.getFixtureA().getBody();
      const b = c.getFixtureB().getBody();
      const ak = (a.getUserData() as any)?.kind;
      const bk = (b.getUserData() as any)?.kind;

      if ((ak === "wheel1" && bk === "ground") || (ak === "ground" && bk === "wheel1")) groundedRef.current.w1 = Math.max(0, groundedRef.current.w1 - 1);
      if ((ak === "wheel2" && bk === "ground") || (ak === "ground" && bk === "wheel2")) groundedRef.current.w2 = Math.max(0, groundedRef.current.w2 - 1);
    });

    const prnd = mulberry32((seedRef.current ^ 0x9e3779b9) >>> 0);
    const pickups: Pickup[] = [];

    for (let i = 12; i <= TRACK_X1 - 40; i += 24) {
      const jitter = (prnd() * 2 - 1) * 4;
      const x = i + jitter;
      const baseY = sampleTrackY(track, x) + 2.05;
      pickups.push({ kind: "coin", x, y: baseY, value: 1 });
      pickups.push({ kind: "coin", x: x + 2.0, y: sampleTrackY(track, x + 2.0) + 2.05, value: 1 });
      pickups.push({ kind: "coin", x: x + 4.0, y: sampleTrackY(track, x + 4.0) + 2.05, value: 1 });
    }

    for (let i = 32; i <= TRACK_X1 - 60; i += 62) {
      const jitter = (prnd() * 2 - 1) * 7;
      const x = i + jitter;
      const arch = 0.25 * Math.sin((i / 62) * Math.PI);
      pickups.push({ kind: "fuel", x, y: sampleTrackY(track, x) + 2.05 + arch, value: 35 });
    }
    pickupsRef.current = pickups;

    camRef.current.x = spawnX;
    camRef.current.y = spawnY;
  };

  useEffect(() => {
    const img1 = new Image(); img1.src = HEADS.jesse.src; headImgRef.current = img1;
    const img2 = new Image(); img2.src = HEADS.brian.src; headImg2Ref.current = img2;
    const jeepBody = new Image(); jeepBody.src = JEEP_BODY_SRC; jeepBodyImgRef.current = jeepBody;
    const jeepWheel = new Image(); jeepWheel.src = JEEP_WHEEL_SRC; jeepWheelImgRef.current = jeepWheel;
    const sportsBody = new Image(); sportsBody.src = SPORTS_CAR_BODY_SRC; sportsCarBodyImgRef.current = sportsBody;
    const sportsWheel = new Image(); sportsWheel.src = SPORTS_CAR_WHEEL_SRC; sportsCarWheelImgRef.current = sportsWheel;

    let raf = 0;
    let lastTime = performance.now() / 1000;
    let accumulator = 0;
    let lastEmit = 0;
    let lastStatus: HillClimbState["status"] = stateRef.current.status;
    let lastToastT = 0;

    const offscreenSnap = document.createElement("canvas");
    const captureSnapshot = () => {
      try {
        const c = canvasRef.current;
        if (!c) return null;
        const outW = 960, outH = 540, outAspect = outW / outH;
        const srcW = Math.max(1, c.width), srcH = Math.max(1, c.height), srcAspect = srcW / srcH;
        let sx = 0, sy = 0, sw = srcW, sh = srcH;
        if (srcAspect > outAspect) { sw = Math.floor(srcH * outAspect); sx = Math.floor((srcW - sw) / 2); }
        else if (srcAspect < outAspect) { sh = Math.floor(srcW / outAspect); sy = Math.floor((srcH - sh) / 2); }

        offscreenSnap.width = outW; offscreenSnap.height = outH;
        const octx = offscreenSnap.getContext("2d");
        if (!octx) return null;
        octx.imageSmoothingEnabled = true; octx.drawImage(c, sx, sy, sw, sh, 0, 0, outW, outH);
        return offscreenSnap.toDataURL("image/png");
      } catch { return null; }
    };

    const loop = (tMs: number) => {
      raf = requestAnimationFrame(loop);
      const ctx = canvasRef.current?.getContext("2d");
      const canvas = canvasRef.current;
      if (!ctx || !canvas) return;

      const world = worldRef.current;
      const car = carRef.current;
      if (!world || !car) return;

      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, Math.ceil(canvas.clientWidth || rect.width));
      const cssH = Math.max(1, Math.ceil(canvas.clientHeight || rect.height));
      updateScaleForViewport(cssW, cssH);

      const now = tMs / 1000;
      let frameTime = now - lastTime;
      lastTime = now;
      timeRef.current = now;

      frameTime = Math.min(frameTime, 0.25);
      if (!pausedRef.current) {
        accumulator += frameTime;
        while (accumulator >= DT) {
          stepGame(world, car);
          accumulator -= DT;
        }
        updateCamera(car, frameTime);
      }

      render(ctx, canvas.width, canvas.height, car, now);

      const sNow = stateRef.current;
      if ((sNow.status === "CRASH" || sNow.status === "OUT_OF_FUEL") && lastEndStatusRef.current !== sNow.status) {
        if (sNow.status === "CRASH") audioManager.playCrash();
        lastEndStatusRef.current = sNow.status;
        snapshotRef.current = captureSnapshot() ?? snapshotRef.current;
        try {
          onGameOverRef.current?.({
            snapshotDataUrl: snapshotRef.current,
            meters: Math.max(0, Math.floor(sNow.distanceM)),
            coins: Math.max(0, Math.floor(sNow.coins)),
            status: sNow.status,
          });
        } catch { }
      }

      if (sNow.status === "IDLE" || sNow.status === "RUN") lastEndStatusRef.current = null;

      const engineAudible = sNow.status === "RUN" && (
        Math.abs(throttleRef.current) > 0.03 ||
        Math.abs(throttleTargetRef.current) > 0.03 ||
        sNow.speedKmh > 1.25
      );
      audioManager.updateEngine(sNow.rpm01, engineAudible);

      const emitDue = now - lastEmit > 1 / 30;
      const emitImportant = sNow.status !== lastStatus || (sNow.toastT > 0 && sNow.toastT !== lastToastT);
      if (emitDue || emitImportant) {
        lastEmit = now; lastStatus = sNow.status; lastToastT = sNow.toastT;
        onState({ ...sNow });
      }
    };

    let lastPxW = 0, lastPxH = 0;
    const resize = () => {
      const c = canvasRef.current;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.max(1, Math.ceil(c.clientWidth || rect.width));
      const cssH = Math.max(1, Math.ceil(c.clientHeight || rect.height));

      updateScaleForViewport(cssW, cssH);

      const pxW = Math.max(1, Math.ceil(cssW * dpr));
      const pxH = Math.max(1, Math.ceil(cssH * dpr));
      if (c.width !== pxW) c.width = pxW;
      if (c.height !== pxH) c.height = pxH;
      lastPxW = pxW; lastPxH = pxH;
    };

    const ro = new ResizeObserver(() => requestAnimationFrame(resize));
    if (canvasRef.current) ro.observe(canvasRef.current);
    window.addEventListener("resize", resize);
    requestAnimationFrame(() => { resize(); requestAnimationFrame(resize); });
    raf = requestAnimationFrame(loop);

    return () => { ro.disconnect(); window.removeEventListener("resize", resize); cancelAnimationFrame(raf); };
  }, []);

  useImperativeHandle(ref, () => ({
    setThrottle: (t: number) => { throttleTargetRef.current = Math.max(-1, Math.min(1, t)); },
    setBoost: (on: boolean) => { boostHeldRef.current = Boolean(on); },
    reset,
  }));

  const isGrounded = () => groundedRef.current.w1 + groundedRef.current.w2 > 0;

  const stepGame = (world: planck.World, car: CarRig) => {
    const s = stateRef.current;
    const vPhys = VEHICLES[vehicleIdRef.current].physics;

    const target = throttleTargetRef.current;
    const cur = throttleRef.current;
    const k = 1 - Math.exp(-10 * DT);
    throttleRef.current = cur + (target - cur) * k;

    const throttle = throttleRef.current;
    const grounded = isGrounded();

    if (s.status === "IDLE" && Math.abs(throttle) > 0.02) s.status = "RUN";

    if (s.status === "RUN") {
      const gas01 = Math.max(0, throttle);
      const vx = Math.abs(car.chassis.getLinearVelocity().x);
      s.fuel -= (vPhys.fuelDrainBase + vPhys.fuelDrainThrottle * gas01 + 0.012 * vx * gas01) * DT;
      if (s.fuel <= 0) {
        s.fuel = 0; s.status = "OUT_OF_FUEL";
        throttleTargetRef.current = Math.min(0, throttleTargetRef.current);
      }
    }

    const drive = s.status === "OUT_OF_FUEL" ? Math.min(0, throttle) : throttle;
    const boostActive = s.status === "RUN" && boostHeldRef.current && s.boost01 > 0.03;
    if (boostActive) s.boost01 = Math.max(0, s.boost01 - 0.75 * DT);

    const forwardMax = vPhys.maxMotorSpeed;
    const reverseMax = 10;
    const gr = groundedRef.current;
    const rearGrounded = gr.w1 > 0, frontGrounded = gr.w2 > 0, groundedAny = rearGrounded || frontGrounded;

    const pitch = car.chassis.getAngle();
    const pitchAbs = Math.abs(wrapAngle(pitch));
    const pitchCut = clamp01(1 - Math.max(0, pitchAbs - 1.35) / 0.65);
    const traction = rearGrounded ? 1 : 0.35;

    let motorSpeed = 0, rearTorque = 0, brakeTorque = 0;

    if (s.status === "IDLE") { rearTorque = 10; }

    if (s.status === "RUN") {
      if (drive > 0.02) {
        const speedMul = boostActive ? 1.15 : 1.0;
        motorSpeed = -(throttle * forwardMax * speedMul);
        const omega = Math.abs(car.wheel1.getAngularVelocity());
        const omega01 = clamp01(omega / forwardMax);
        const powerDrop = 1 - 0.62 * omega01;
        const max = vPhys.maxMotorTorque;
        const base = max * 0.35;
        const boostMul = boostActive ? 1.45 : 1.0;
        rearTorque = (base + (max - base) * throttle) * powerDrop * traction * pitchCut * boostMul;
      } else if (drive < -0.02) {
        const vx = car.chassis.getLinearVelocity().x;
        const brake = clamp01(-drive);
        const endoCut = clamp01(1 - Math.max(0, (-pitch) - 0.55) / 0.45);
        brakeTorque = (vPhys.brakeMaxTorque * brake) * (0.55 + 0.45 * endoCut);

        if (vx > 0.8) { motorSpeed = 0; rearTorque = 0; }
        else { motorSpeed = brake * reverseMax; rearTorque = 36 * brake * traction; }
      } else { rearTorque = 7; }
    }

    if (s.status === "OUT_OF_FUEL" && drive < -0.02) {
      const vx = car.chassis.getLinearVelocity().x;
      const brake = clamp01(-drive);
      const endoCut = clamp01(1 - Math.max(0, (-pitch) - 0.55) / 0.45);
      brakeTorque = (vPhys.brakeMaxTorque * brake) * (0.55 + 0.45 * endoCut);
      if (vx <= 0.8) { motorSpeed = brake * reverseMax; rearTorque = 28 * brake * traction; }
    }

    const jeepFourWheelDrive = vehicleIdRef.current === "jeep" && s.status === "RUN" && drive > 0.02;
    const jeepFrontDriveTorque = jeepFourWheelDrive
      ? vPhys.maxMotorTorque * clamp01(drive) * (frontGrounded ? 0.42 : 0.12) * pitchCut
      : 0;
    const jeepRearDriveTorque = jeepFourWheelDrive ? rearTorque * 0.84 : rearTorque;

    car.spring1.setMotorSpeed(motorSpeed);
    car.spring1.setMaxMotorTorque(jeepRearDriveTorque + brakeTorque);
    car.spring2.setMotorSpeed(jeepFourWheelDrive ? motorSpeed * 0.98 : 0);
    car.spring2.setMaxMotorTorque(jeepFrontDriveTorque + brakeTorque * 0.8);

    if (s.status === "RUN" && groundedAny) {
      const av = car.chassis.getAngularVelocity();
      const vx = car.chassis.getLinearVelocity().x;
      const bothDown = rearGrounded && frontGrounded;
      const pedalEase = clamp01(1 - Math.abs(throttle));
      const speedEase = clamp01((7.5 - Math.abs(vx)) / 7.5);
      const assist = pedalEase * speedEase * (bothDown ? 1 : 0.35);

      let stab = (-2.8 * pitch) - (0.8 * av);
      stab *= assist;
      stab = Math.max(-10, Math.min(10, stab));
      car.chassis.applyTorque(stab);

      if (vehicleIdRef.current === "jeep") {
        const jeepAssist = clamp01((10 - Math.abs(vx)) / 10) * (bothDown ? 1 : 0.55);
        const jeepStab = clamp((-4.2 * pitch) - (1.15 * av), -16, 16) * jeepAssist;
        car.chassis.applyTorque(jeepStab);
      }

      const maxAV = vehicleIdRef.current === "jeep" ? 5.8 : 6.5;
      if (Math.abs(av) > maxAV) car.chassis.setAngularVelocity(Math.sign(av) * maxAV);
    }

    if ((s.status === "RUN" || s.status === "OUT_OF_FUEL") && !groundedAny) {
      car.chassis.applyTorque(30 * throttle);
      s.boost01 = Math.min(1, s.boost01 + 0.05 * DT);
    }

    world.step(DT, VEL_ITERS, POS_ITERS);
    (world as any).clearForces?.();

    const x = car.chassis.getPosition().x;
    s.distanceM = Math.max(s.distanceM, x);
    s.bestM = bestRef.current;

    const w = Math.abs(car.wheel1.getAngularVelocity());
    s.rpm01 = Math.max(0, Math.min(1, w / forwardMax));

    const v = car.chassis.getLinearVelocity();
    s.speedKmh = Math.hypot(v.x, v.y) * 3.6;

    if (s.toastT > 0) { s.toastT = Math.max(0, s.toastT - DT); if (s.toastT === 0) s.toast = ""; }

    if ((s.status === "RUN" || s.status === "OUT_OF_FUEL") && !groundedAny) {
      const a = airRef.current;
      if (!a.active) { a.active = true; a.t = 0; a.acc = 0; a.flipCount = 0; a.lastAngle = car.chassis.getAngle(); }
      a.t += DT; s.airtimeS = a.t;

      const ang = car.chassis.getAngle();
      let d = ang - a.lastAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      a.acc += d; a.lastAngle = ang;

      const flipsNow = Math.floor(Math.abs(a.acc) / (Math.PI * 2));
      if (flipsNow > a.flipCount) {
        const gained = flipsNow - a.flipCount;
        a.flipCount = flipsNow; s.flips += gained;
        const coinBonus = 5 * gained; const fuelBonus = 3 * gained;
        s.coins += coinBonus; s.fuel = Math.min(100, s.fuel + fuelBonus);
        s.toast = `FLIP +${coinBonus} - FUEL +${fuelBonus}`; s.toastT = 1.35;
        s.boost01 = Math.min(1, s.boost01 + 0.18 * gained);
      }
    } else { airRef.current.active = false; s.airtimeS = 0; }

    const headLocal = getHeadLocal(vehicleIdRef.current);
    const points = [car.chassis.getPosition(), car.wheel1.getPosition(), car.wheel2.getPosition(), car.chassis.getWorldPoint(headLocal)];

    for (const p of pickupsRef.current) {
      if (p.taken) continue;
      const r = p.kind === "fuel" ? 1.85 : 1.35;
      const r2 = r * r;
      let hit = false;
      for (const pos of points) {
        const dx = p.x - pos.x, dy = p.y - pos.y;
        if (dx * dx + dy * dy < r2) { hit = true; break; }
      }
      if (!hit) continue;
      p.taken = true;

      if (p.kind === "coin") {
        audioManager.playCoin();
        s.coins += p.value; s.toast = `+${p.value} COIN`; s.toastT = 0.9;
        s.boost01 = Math.min(1, s.boost01 + 0.015 * p.value);
      } else if (p.kind === "fuel") {
        const before = s.fuel; s.fuel = Math.min(100, s.fuel + p.value);
        s.toast = `FUEL +${p.value}`; s.toastT = 1.1;
        s.boost01 = Math.min(1, s.boost01 + 0.10);
        if (s.status === "OUT_OF_FUEL" && before <= 0 && s.fuel > 0.5) {
          s.status = "RUN"; crashFreezeRef.current = { t: 0, frozen: false };
          car.chassis.setAwake(true); car.wheel1.setAwake(true); car.wheel2.setAwake(true);
          car.chassis.setLinearDamping(vPhys.chassisLinearDamping); car.chassis.setAngularDamping(vPhys.chassisAngularDamping);
          car.wheel1.setAngularDamping(vPhys.wheelAngularDamping); car.wheel2.setAngularDamping(vPhys.wheelAngularDamping);
        }
      }
    }

    if (s.status === "RUN") {
      const tr = trackRef.current;
      const headWorld = car.chassis.getWorldPoint(headLocal);
      const gyHead = sampleTrackY(tr, headWorld.x);
      const pitchNow = car.chassis.getAngle();
      const pitchNorm = wrapAngle(pitchNow);
      const upside = Math.abs(pitchNorm) > 2.2;
      const posNow = car.chassis.getPosition();
      const gyBody = sampleTrackY(tr, posNow.x);
      const nearGround = posNow.y < gyBody + 0.85;
      // Sports car is very low: when it flips upside-down, the car body can touch/hover near
      // the terrain while neither wheel is grounded. The shared crash rule uses `groundedAny`,
      // so only sports car needs this extra body-near-ground upside-down check.
      const sportsCarUpsideNearGround = vehicleIdRef.current === "sportsCar" && upside && nearGround;

      let jeepUpsideNearGround = false;
      if (vehicleIdRef.current === "jeep" && upside) {
        const roofWorld = car.chassis.getWorldPoint(Vec2(0.0, 0.62));
        const roofGroundY = sampleTrackY(tr, roofWorld.x);
        const rearWheel = car.wheel1.getPosition();
        const frontWheel = car.wheel2.getPosition();
        const rearWheelClearance = rearWheel.y - sampleTrackY(tr, rearWheel.x) - vPhys.wheelRadius;
        const frontWheelClearance = frontWheel.y - sampleTrackY(tr, frontWheel.x) - vPhys.wheelRadius;
        const roofTouchingTerrain = roofWorld.y < roofGroundY + 0.18;
        const headTouchingTerrain = headWorld.y < gyHead + 0.32;
        const wheelTouchingTerrain = groundedAny || rearWheelClearance < 0.12 || frontWheelClearance < 0.12;
        const lowEnoughToBeRestingUpsideDown = posNow.y < gyBody + 1.34;
        const invertedContact = roofTouchingTerrain || headTouchingTerrain || (lowEnoughToBeRestingUpsideDown && wheelTouchingTerrain);
        upsideCrashRef.current = invertedContact ? upsideCrashRef.current + DT : 0;
        jeepUpsideNearGround = upsideCrashRef.current > 0.08;
      } else if (vehicleIdRef.current === "jeep") {
        upsideCrashRef.current = 0;
      }

      if (headWorld.y < gyHead + 0.08 || (upside && nearGround && groundedAny) || sportsCarUpsideNearGround || jeepUpsideNearGround) {
        s.status = "CRASH"; throttleTargetRef.current = 0; throttleRef.current = 0;
        crashFreezeRef.current = { t: 0, frozen: false }; upsideCrashRef.current = 0; airRef.current = { active: false, t: 0, acc: 0, lastAngle: 0, flipCount: 0 }; s.airtimeS = 0;
      }
    }

    if (s.status === "CRASH" || (s.status === "OUT_OF_FUEL" && s.fuel <= 0.01)) {
      const cf = crashFreezeRef.current;
      if (!cf.frozen) {
        const lv = car.chassis.getLinearVelocity();
        const sp = Math.hypot(lv.x, lv.y);
        const settleT = s.status === "CRASH" ? 0.65 : 1.35;
        const canFreeze = s.status === "CRASH" || sp < 0.35;
        cf.t = canFreeze ? (cf.t + DT) : 0;

        car.chassis.setLinearDamping(2.0); car.chassis.setAngularDamping(3.2);
        car.wheel1.setAngularDamping(2.0); car.wheel2.setAngularDamping(2.0);

        if (cf.t > settleT) {
          car.spring1.setMotorSpeed(0); car.spring1.setMaxMotorTorque(0);
          car.spring2.setMotorSpeed(0); car.spring2.setMaxMotorTorque(0);
          car.chassis.setLinearVelocity(Vec2(0, 0)); car.chassis.setAngularVelocity(0);
          car.wheel1.setAngularVelocity(0); car.wheel2.setAngularVelocity(0);
          car.chassis.setAwake(false); car.wheel1.setAwake(false); car.wheel2.setAwake(false);
          cf.frozen = true;
        }
      }
    }
  };

  const updateCamera = (car: CarRig, frameTime: number) => {
    const p = car.chassis.getPosition();
    const v = car.chassis.getLinearVelocity();
    const isMini = miniModeRef.current;
    const lookMul = isMini ? 0.55 : 0.6;
    const lookMax = isMini ? 6 : 8;
    const lookAhead = Math.max(0, Math.min(lookMax, v.x * lookMul));
    const targetX = p.x + lookAhead;
    const targetY = p.y + 0.6;
    const smooth = 1 - Math.exp(-6 * frameTime);
    camRef.current.x += (targetX - camRef.current.x) * smooth;
    camRef.current.y += (targetY - camRef.current.y) * smooth;
  };

  const render = (ctx: CanvasRenderingContext2D, w: number, h: number, car: CarRig, nowS: number) => {
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const camX = camRef.current.x, camY = camRef.current.y;
    const viewCX = w * (miniModeRef.current ? 0.32 : 0.33);
    const viewCY = h * 0.62;

    const toScreen = (v: planck.Vec2) => ({
      x: viewCX + (v.x - camX) * SCALE * dpr,
      y: viewCY - (v.y - camY) * SCALE * dpr,
    });

    const mapConfig = MAPS[mapIdRef.current];

    drawSkyPro(ctx, w, h, camX, dpr, seedRef.current, mapConfig);
    drawMountains(ctx, w, h, camX, dpr, 0.08, mapConfig.colors.mountainFar, 0.60);
    drawMountains(ctx, w, h, camX, dpr, 0.12, mapConfig.colors.mountainNear, 0.70);

    const track = trackRef.current;
    drawHills(ctx, w, h, track, camX, camY, dpr, 0.18, mapConfig.colors.hillFar, 0.92);
    drawHills(ctx, w, h, track, camX, camY, dpr, 0.28, mapConfig.colors.hillMid, 0.84);
    drawHills(ctx, w, h, track, camX, camY, dpr, 0.40, mapConfig.colors.hillNear, 0.75);

    if (mapIdRef.current !== "moon") {
      drawForest(ctx, w, h, camX, dpr, 0.52, mapConfig.colors.forestColor, 0.72);
    }

    drawGround(ctx, w, h, track, camX, camY, dpr, viewCX, viewCY, mapConfig);
    drawDecorations(ctx, w, h, track, camX, camY, dpr, viewCX, viewCY, mapConfig, seedRef.current);
    drawWeather(ctx, w, h, nowS, mapConfig);

    for (const p of pickupsRef.current) {
      if (p.taken) continue;
      const bob = Math.sin(nowS * 2.2 + p.x * 0.85) * 0.10;
      const sp = toScreen(Vec2(p.x, p.y + bob));
      if (p.kind === "coin") drawCoin(ctx, sp.x, sp.y, 14 * dpr);
      if (p.kind === "fuel") drawFuel(ctx, sp.x, sp.y, 16 * dpr);
    }

    const groundY = sampleTrackY(track, car.chassis.getPosition().x);
    const screenGroundY = toScreen(Vec2(0, groundY)).y;
    drawVehicle(ctx, toScreen, car, dpr, headIdRef.current, headImgRef.current, headImg2Ref.current, jeepBodyImgRef.current, jeepWheelImgRef.current, sportsCarBodyImgRef.current, sportsCarWheelImgRef.current, miniModeRef.current, viewportRef.current.isPhone, vehicleIdRef.current, screenGroundY);

    // Foreground Parallax (Fast moving elements)
    drawForeground(ctx, w, h, track, camX, camY, dpr, viewCX, viewCY, mapConfig, seedRef.current);

    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.10)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };

  return <canvas ref={canvasRef} />;
});

// -------------------- Render helpers --------------------

function drawWeather(ctx: CanvasRenderingContext2D, w: number, h: number, timeS: number, map: MapConfig) {
  if (!map.snowParticles && !map.dustParticles) return;
  ctx.save();
  const count = map.snowParticles ? 100 : 50;
  ctx.fillStyle = map.snowParticles ? "rgba(255,255,255,0.8)" : "rgba(212,171,85,0.4)";
  for (let i = 0; i < count; i++) {
    const seed = i * 1337.31;
    const speedY = map.snowParticles ? 100 + (seed % 50) : -20 + (seed % 40);
    const speedX = map.snowParticles ? -50 + (seed % 100) : 200 + (seed % 100);
    const px = (seed + timeS * speedX) % w;
    const py = (seed * 2 + timeS * speedY) % h;
    const size = (seed % 3) + 1;
    ctx.beginPath();
    ctx.arc(px < 0 ? px + w : px, py < 0 ? py + h : py, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawForeground(ctx: CanvasRenderingContext2D, w: number, h: number, track: Track, camX: number, camY: number, dpr: number, viewCX: number, viewCY: number, map: MapConfig, seed: number) {
  const parallax = 1.45;
  const startX = camX - (viewCX / (SCALE * dpr * parallax));
  const endX = camX + ((w - viewCX) / (SCALE * dpr * parallax));

  ctx.save(); 
  for (let wx = Math.floor(startX); wx <= Math.ceil(endX); wx++) {
    const rnd = mulberry32((wx + seed) * 777);
    if (rnd() > 0.04) continue; // Very sparse
    const xPos = wx + rnd();
    const sx = viewCX + (xPos - camX) * SCALE * dpr * parallax;
    const sy = h + 10*dpr;

    if (map.id === "hills") {
      ctx.fillStyle = "#064e3b";
      const s = 1.0 + rnd() * 0.8;
      ctx.beginPath(); ctx.arc(sx, sy - 8*dpr*s, 22*dpr*s, Math.PI, 0); ctx.fill();
      ctx.beginPath(); ctx.arc(sx - 14*dpr*s, sy, 14*dpr*s, Math.PI, 0); ctx.fill();
      ctx.beginPath(); ctx.arc(sx + 14*dpr*s, sy, 14*dpr*s, Math.PI, 0); ctx.fill();
    } else if (map.id === "desert") {
      ctx.fillStyle = "#271c19";
      const s = 0.8 + rnd() * 0.8;
      ctx.beginPath(); ctx.moveTo(sx - 25*dpr*s, sy); ctx.lineTo(sx + 25*dpr*s, sy); ctx.lineTo(sx + 5*dpr*s, sy - 40*dpr*s); ctx.fill();
    } else if (map.id === "arctic") {
      ctx.fillStyle = "#0c1929";
      const s = 0.8 + rnd() * 0.8;
      ctx.beginPath(); ctx.moveTo(sx - 20*dpr*s, sy); ctx.lineTo(sx + 15*dpr*s, sy); ctx.lineTo(sx - 5*dpr*s, sy - 45*dpr*s); ctx.fill();
    } else if (map.id === "moon") {
      ctx.fillStyle = "#020617";
      const s = 0.8 + rnd() * 0.6;
      ctx.beginPath(); ctx.arc(sx, sy, 30*dpr*s, Math.PI, 0); ctx.fill();
    }
  }
  ctx.restore();
}

function drawDecorations(ctx: CanvasRenderingContext2D, w: number, h: number, track: Track, camX: number, camY: number, dpr: number, viewCX: number, viewCY: number, map: MapConfig, seed: number) {
  const screenYOfGround = (xWorld: number) => viewCY - (sampleTrackY(track, xWorld) - camY) * SCALE * dpr;
  const startX = camX - (viewCX / (SCALE * dpr)) - 2;
  const endX = camX + ((w - viewCX) / (SCALE * dpr)) + 2;

  ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";

  for (let wx = Math.floor(startX); wx <= Math.ceil(endX); wx++) {
    const rnd = mulberry32((wx + seed) * 12345);
    if (rnd() > 0.12) continue; // 12% chance per meter

    const xPos = wx + rnd();
    const sx = viewCX + (xPos - camX) * SCALE * dpr;
    const sy = screenYOfGround(xPos);

    if (map.id === "hills") {
      const type = rnd();
      if (type > 0.6) {
        // Wooden Fence
        ctx.fillStyle = "#78350f"; 
        ctx.fillRect(sx - 15*dpr, sy - 24*dpr, 6*dpr, 24*dpr);
        ctx.fillRect(sx + 15*dpr, sy - 24*dpr, 6*dpr, 24*dpr);
        ctx.fillStyle = "#92400e";
        ctx.fillRect(sx - 20*dpr, sy - 18*dpr, 46*dpr, 5*dpr);
        ctx.fillRect(sx - 20*dpr, sy - 10*dpr, 46*dpr, 5*dpr);
      } else if (type > 0.2) {
        // Detailed Pine Tree
        const scale = 0.8 + rnd() * 0.6;
        ctx.save(); ctx.translate(sx, sy); ctx.scale(scale, scale);
        // Trunk
        ctx.fillStyle = "#451a03"; ctx.fillRect(-4*dpr, -15*dpr, 8*dpr, 15*dpr);
        // Leaves (3 overlapping triangles)
        ctx.fillStyle = "#14532d"; ctx.beginPath(); ctx.moveTo(-20*dpr, -10*dpr); ctx.lineTo(20*dpr, -10*dpr); ctx.lineTo(0, -35*dpr); ctx.fill();
        ctx.fillStyle = "#166534"; ctx.beginPath(); ctx.moveTo(-16*dpr, -25*dpr); ctx.lineTo(16*dpr, -25*dpr); ctx.lineTo(0, -50*dpr); ctx.fill();
        ctx.fillStyle = "#22c55e"; ctx.beginPath(); ctx.moveTo(-12*dpr, -40*dpr); ctx.lineTo(12*dpr, -40*dpr); ctx.lineTo(0, -65*dpr); ctx.fill();
        ctx.restore();
      } else {
        // Bush
        ctx.fillStyle = "#15803d";
        ctx.beginPath(); ctx.arc(sx, sy - 5*dpr, 12*dpr, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(sx - 8*dpr, sy - 2*dpr, 8*dpr, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(sx + 8*dpr, sy - 2*dpr, 8*dpr, 0, Math.PI*2); ctx.fill();
      }
    } else if (map.id === "desert") {
      const type = rnd();
      if (type > 0.6) {
        // Detailed Cactus
        const scale = 0.7 + rnd() * 0.5;
        ctx.save(); ctx.translate(sx, sy); ctx.scale(scale, scale);
        ctx.fillStyle = "#166534"; ctx.strokeStyle = "#14532d"; ctx.lineWidth = 2*dpr;
        // Main stem
        ctx.beginPath(); ctx.roundRect(-6*dpr, -50*dpr, 12*dpr, 50*dpr, 6*dpr); ctx.fill(); ctx.stroke();
        // Left arm
        ctx.beginPath(); ctx.moveTo(-6*dpr, -20*dpr); ctx.lineTo(-18*dpr, -20*dpr); ctx.arcTo(-24*dpr, -20*dpr, -24*dpr, -30*dpr, 6*dpr); ctx.lineTo(-24*dpr, -35*dpr); 
        ctx.lineTo(-12*dpr, -35*dpr); ctx.lineTo(-12*dpr, -26*dpr); ctx.lineTo(-6*dpr, -26*dpr); ctx.fill(); ctx.stroke();
        // Right arm
        ctx.beginPath(); ctx.moveTo(6*dpr, -30*dpr); ctx.lineTo(18*dpr, -30*dpr); ctx.arcTo(24*dpr, -30*dpr, 24*dpr, -40*dpr, 6*dpr); ctx.lineTo(24*dpr, -45*dpr);
        ctx.lineTo(12*dpr, -45*dpr); ctx.lineTo(12*dpr, -36*dpr); ctx.lineTo(6*dpr, -36*dpr); ctx.fill(); ctx.stroke();
        ctx.restore();
      } else if (type > 0.3) {
        // Dead tree / Bones
        ctx.strokeStyle = "#d4d4d8"; ctx.lineWidth = 3*dpr;
        ctx.beginPath(); ctx.moveTo(sx - 15*dpr, sy); ctx.quadraticCurveTo(sx, sy - 20*dpr, sx + 15*dpr, sy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx - 10*dpr, sy); ctx.quadraticCurveTo(sx, sy - 14*dpr, sx + 10*dpr, sy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx - 5*dpr, sy); ctx.quadraticCurveTo(sx, sy - 8*dpr, sx + 5*dpr, sy); ctx.stroke();
        ctx.fillStyle = "#e4e4e7"; ctx.beginPath(); ctx.arc(sx + 20*dpr, sy - 5*dpr, 4*dpr, 0, Math.PI*2); ctx.fill();
      } else {
        // Tumbleweed
        ctx.strokeStyle = "#92400e"; ctx.lineWidth = dpr;
        ctx.beginPath();
        for(let i=0; i<15; i++) {
          ctx.ellipse(sx, sy - 8*dpr, 8*dpr + rnd()*3*dpr, 6*dpr + rnd()*3*dpr, rnd()*Math.PI*2, 0, Math.PI*2);
        }
        ctx.stroke();
      }
    } else if (map.id === "arctic") {
      const type = rnd();
      if (type > 0.7) {
        // Detailed Igloo
        ctx.fillStyle = "#e0f2fe"; ctx.strokeStyle = "#93c5fd"; ctx.lineWidth = 2*dpr;
        ctx.beginPath(); ctx.arc(sx, sy, 25*dpr, Math.PI, 0); ctx.fill(); ctx.stroke();
        // Igloo blocks
        ctx.beginPath(); ctx.moveTo(sx - 25*dpr, sy - 8*dpr); ctx.lineTo(sx + 25*dpr, sy - 8*dpr); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx - 18*dpr, sy - 16*dpr); ctx.lineTo(sx + 18*dpr, sy - 16*dpr); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx - 5*dpr, sy); ctx.lineTo(sx - 5*dpr, sy - 8*dpr); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx + 15*dpr, sy); ctx.lineTo(sx + 15*dpr, sy - 8*dpr); ctx.stroke();
        // Entrance
        ctx.fillStyle = "#0f172a"; ctx.beginPath(); ctx.arc(sx + 12*dpr, sy, 8*dpr, Math.PI, 0); ctx.fill();
      } else {
        // Iceberg/crystal cluster
        const scale = 0.8 + rnd() * 0.7;
        ctx.save(); ctx.translate(sx, sy); ctx.scale(scale, scale);
        ctx.fillStyle = "#bae6fd"; ctx.beginPath(); ctx.moveTo(-15*dpr, 0); ctx.lineTo(0, -40*dpr); ctx.lineTo(10*dpr, 0); ctx.fill();
        ctx.fillStyle = "#7dd3fc"; ctx.beginPath(); ctx.moveTo(-5*dpr, 0); ctx.lineTo(15*dpr, -25*dpr); ctx.lineTo(25*dpr, 0); ctx.fill();
        ctx.fillStyle = "#e0f2fe"; ctx.beginPath(); ctx.moveTo(-25*dpr, 0); ctx.lineTo(-10*dpr, -20*dpr); ctx.lineTo(-5*dpr, 0); ctx.fill();
        ctx.restore();
      }
    } else if (map.id === "moon") {
      const type = rnd();
      if (type > 0.6) {
        // Crater — draw as a dip below ground, not floating on it
        ctx.fillStyle = "#475569"; ctx.beginPath(); ctx.ellipse(sx, sy + 4*dpr, 22*dpr, 6*dpr, 0, 0, Math.PI); ctx.fill();
        ctx.fillStyle = "#1e293b"; ctx.beginPath(); ctx.ellipse(sx, sy + 5*dpr, 18*dpr, 4*dpr, 0, 0, Math.PI); ctx.fill();
        // Rim highlight above ground
        ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1.5*dpr; ctx.beginPath(); ctx.ellipse(sx, sy, 20*dpr, 5*dpr, 0, Math.PI, 0); ctx.stroke();
      } else if (type > 0.3) {
        // Lunar Lander
        ctx.fillStyle = "#fbbf24"; ctx.fillRect(sx - 8*dpr, sy - 14*dpr, 16*dpr, 8*dpr);
        ctx.fillStyle = "#cbd5e1"; ctx.beginPath(); ctx.moveTo(sx - 5*dpr, sy - 14*dpr); ctx.lineTo(sx + 5*dpr, sy - 14*dpr); ctx.lineTo(sx + 3*dpr, sy - 20*dpr); ctx.lineTo(sx - 3*dpr, sy - 20*dpr); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 2*dpr;
        ctx.beginPath(); ctx.moveTo(sx - 6*dpr, sy - 6*dpr); ctx.lineTo(sx - 12*dpr, sy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx + 6*dpr, sy - 6*dpr); ctx.lineTo(sx + 12*dpr, sy); ctx.stroke();
      } else {
        // Flag
        ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 2*dpr; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy - 22*dpr); ctx.stroke();
        ctx.fillStyle = "#ef4444"; ctx.fillRect(sx, sy - 21*dpr, 12*dpr, 8*dpr);
        ctx.fillStyle = "#fff"; ctx.fillRect(sx, sy - 21*dpr, 5*dpr, 4*dpr);
      }
    }
  }
  ctx.restore();
}

let skyNoisePattern: CanvasPattern | null = null;
function getSkyNoisePattern(ctx: CanvasRenderingContext2D, seed: number) {
  if (skyNoisePattern) return skyNoisePattern;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas"); c.width = 64; c.height = 64;
  const cctx = c.getContext("2d"); if (!cctx) return null;
  const rnd = mulberry32((seed ^ 0x6a09e667) >>> 0);
  const img = cctx.createImageData(c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const a = Math.floor(6 + rnd() * 18);
    img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = a;
  }
  cctx.putImageData(img, 0, 0);
  skyNoisePattern = ctx.createPattern(c, "repeat");
  return skyNoisePattern;
}

function drawSkyPro(ctx: CanvasRenderingContext2D, w: number, h: number, camX: number, dpr: number, seed: number, map: MapConfig) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, map.colors.skyTop);
  sky.addColorStop(0.44, map.colors.skyMid);
  sky.addColorStop(0.74, map.colors.skyHorizon);
  sky.addColorStop(1, map.colors.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const pat = getSkyNoisePattern(ctx, seed);
  if (pat) { ctx.save(); ctx.globalAlpha = 0.08; ctx.fillStyle = pat; ctx.fillRect(0, 0, w, h); ctx.restore(); }

  const sx = w * 0.82, sy = h * 0.20, sr = 70 * dpr;

  // Moon: draw stars instead of clouds
  if (map.id === "moon") {
    ctx.save();
    const starRnd = mulberry32((seed ^ 0xbeef) >>> 0);
    for (let i = 0; i < 120; i++) {
      const starX = starRnd() * w;
      const starY = starRnd() * h * 0.7;
      const starR = (0.5 + starRnd() * 2.0) * dpr;
      const twinkle = 0.4 + 0.6 * Math.abs(Math.sin(Date.now() * 0.002 + i * 1.7));
      ctx.globalAlpha = twinkle * (0.5 + starRnd() * 0.5);
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(starX, starY, starR, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  if (map.id === "hills") {
    // Realistic Birds in sky
    ctx.save();
    const rndB = mulberry32(seed * 111);
    for(let i=0; i<5; i++) {
      const bx = (camX * -10 * dpr + w*2 + rndB() * w * 2) % w;
      const by = h * 0.1 + rndB() * h * 0.2;
      const t = Date.now() * 0.005 + i;
      const wingY = Math.sin(t) * 8 * dpr;
      
      ctx.fillStyle = "#334155";
      // Body
      ctx.beginPath(); ctx.ellipse(bx, by, 5*dpr, 2.5*dpr, -0.2, 0, Math.PI*2); ctx.fill();
      // Head
      ctx.beginPath(); ctx.arc(bx + 4*dpr, by - 1*dpr, 2*dpr, 0, Math.PI*2); ctx.fill();
      // Beak
      ctx.beginPath(); ctx.moveTo(bx + 5*dpr, by - 1.5*dpr); ctx.lineTo(bx + 8*dpr, by - 0.5*dpr); ctx.lineTo(bx + 5*dpr, by + 0.5*dpr); ctx.fill();
      // Wing (flapping)
      ctx.beginPath(); ctx.moveTo(bx - 1*dpr, by - 1*dpr); 
      ctx.quadraticCurveTo(bx - 4*dpr, by - wingY, bx - 8*dpr, by - wingY - 2*dpr); 
      ctx.quadraticCurveTo(bx - 2*dpr, by - wingY * 0.5, bx + 2*dpr, by); ctx.fill();
    }
    ctx.restore();
  }

  if (map.id === "arctic") {
    // Smooth flowing aurora curtains
    ctx.save(); ctx.globalAlpha = 0.35;
    const auroraColors = ["#4ade80", "#2dd4bf", "#a78bfa"];
    const now = Date.now() * 0.0005;
    for (let i = 0; i < 3; i++) {
      const baseY = h * (0.12 + i * 0.08);
      const bandH = 60 * dpr;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const wave = Math.sin(x * 0.004 + camX * 0.015 + i * 2.1 + now) * 40 * dpr
                   + Math.sin(x * 0.009 + now * 1.3 + i) * 15 * dpr;
        const topY = baseY + wave;
        if (x === 0) ctx.moveTo(x, topY); else ctx.lineTo(x, topY);
      }
      for (let x = w; x >= 0; x -= 8) {
        const wave = Math.sin(x * 0.004 + camX * 0.015 + i * 2.1 + now) * 40 * dpr
                   + Math.sin(x * 0.009 + now * 1.3 + i) * 15 * dpr;
        const botY = baseY + wave + bandH + Math.sin(x * 0.006 + i) * 20 * dpr;
        ctx.lineTo(x, botY);
      }
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, baseY - 40*dpr, 0, baseY + bandH + 40*dpr);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.3, auroraColors[i]);
      grad.addColorStop(0.7, auroraColors[i]);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.restore();
  } else if (map.id === "desert") {
    // Pyramids in the far background (fix negative modulo)
    ctx.save(); ctx.globalAlpha = 0.5;
    const rawPx = (camX * -0.05 * SCALE * dpr + w);
    const px = ((rawPx % (w * 2)) + w * 2) % (w * 2) - w * 0.5;
    ctx.fillStyle = "#d97706";
    ctx.beginPath(); ctx.moveTo(px, h*0.5); ctx.lineTo(px + 150*dpr, h*0.25); ctx.lineTo(px + 300*dpr, h*0.5); ctx.fill();
    ctx.fillStyle = "#b45309";
    ctx.beginPath(); ctx.moveTo(px + 150*dpr, h*0.5); ctx.lineTo(px + 150*dpr, h*0.25); ctx.lineTo(px + 300*dpr, h*0.5); ctx.fill();
    
    const rawPx2 = (camX * -0.04 * SCALE * dpr + w * 1.5);
    const px2 = ((rawPx2 % (w * 2)) + w * 2) % (w * 2) - w * 0.5;
    ctx.fillStyle = "#d97706";
    ctx.beginPath(); ctx.moveTo(px2, h*0.5); ctx.lineTo(px2 + 100*dpr, h*0.3); ctx.lineTo(px2 + 200*dpr, h*0.5); ctx.fill();
    ctx.fillStyle = "#b45309";
    ctx.beginPath(); ctx.moveTo(px2 + 100*dpr, h*0.5); ctx.lineTo(px2 + 100*dpr, h*0.3); ctx.lineTo(px2 + 200*dpr, h*0.5); ctx.fill();
    ctx.restore();

    // Intense heat sun
    ctx.save();
    const sunGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 120*dpr);
    sunGrad.addColorStop(0, "rgba(255,255,255,1)");
    sunGrad.addColorStop(0.15, "rgba(253,224,71,0.9)");
    sunGrad.addColorStop(0.5, "rgba(253,186,71,0.3)");
    sunGrad.addColorStop(1, "rgba(253,224,71,0)");
    ctx.fillStyle = sunGrad;
    ctx.beginPath(); ctx.arc(sx, sy, 120*dpr, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  if (map.id === "moon") {
    // Logo-accurate Earth
    ctx.save();
    const R = 42 * dpr;
    
    // Draw Earth Ocean
    ctx.fillStyle = "#2b9de5"; 
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.fill();

    // Clip to circle so continents don't bleed out
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.clip();

    const drawContinents = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) => {
      // Americas
      ctx.beginPath();
      ctx.moveTo(cx - 0.4*r, cy - 0.95*r);
      ctx.lineTo(cx + 0.0*r, cy - 0.9*r);
      ctx.lineTo(cx + 0.3*r, cy - 0.8*r);
      ctx.lineTo(cx + 0.1*r, cy - 0.6*r);
      ctx.lineTo(cx + 0.4*r, cy - 0.4*r);
      ctx.lineTo(cx + 0.1*r, cy - 0.2*r); // Florida
      ctx.lineTo(cx - 0.3*r, cy - 0.1*r); // Gulf of Mexico
      ctx.lineTo(cx - 0.1*r, cy + 0.05*r); // Central America
      ctx.lineTo(cx + 0.4*r, cy + 0.1*r); // Brazil bulge
      ctx.lineTo(cx + 0.6*r, cy + 0.3*r); 
      ctx.lineTo(cx + 0.5*r, cy + 0.5*r); 
      ctx.lineTo(cx + 0.2*r, cy + 0.8*r); 
      ctx.lineTo(cx - 0.1*r, cy + 0.95*r); // Tip
      ctx.lineTo(cx - 0.1*r, cy + 0.6*r); // West coast SA
      ctx.lineTo(cx - 0.3*r, cy + 0.4*r); 
      ctx.lineTo(cx - 0.4*r, cy + 0.1*r); // West coast CA
      ctx.lineTo(cx - 0.6*r, cy - 0.1*r); // Mexico
      ctx.lineTo(cx - 0.8*r, cy - 0.3*r); 
      ctx.lineTo(cx - 0.85*r, cy - 0.6*r); 
      ctx.fill();

      // Cuba / Islands
      ctx.beginPath(); ctx.ellipse(cx - 0.05*r, cy - 0.05*r, 0.1*r, 0.04*r, 0.2, 0, Math.PI*2); ctx.fill();

      // Africa/Europe Edge
      ctx.beginPath();
      ctx.moveTo(cx + 0.8*r, cy - 0.7*r);
      ctx.lineTo(cx + 0.95*r, cy - 0.6*r);
      ctx.lineTo(cx + 0.98*r, cy + 0.1*r);
      ctx.lineTo(cx + 0.8*r, cy + 0.05*r);
      ctx.lineTo(cx + 0.7*r, cy - 0.3*r);
      ctx.fill();
    };

    // Draw shadow continents (shifted slightly right/down)
    ctx.fillStyle = "#688e3a";
    drawContinents(ctx, sx + 2*dpr, sy + 2*dpr, R);
    
    // Draw main continents
    ctx.fillStyle = "#94c952";
    drawContinents(ctx, sx, sy, R);

    ctx.restore(); // remove clip

    // Shadow (crescent darkness) on the left side to give 3D depth
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI*2);
    ctx.arc(sx + 8*dpr, sy, R*1.05, 0, Math.PI*2, true); 
    ctx.fill();
    ctx.restore();

    // Shooting stars (use time-based position so they move)
    const shootT = (Date.now() % 5000) / 5000;
    if (shootT < 0.04) {
      const stRnd = mulberry32(Math.floor(Date.now() / 5000) * 7919);
      const stX = stRnd() * w * 0.8 + w * 0.1;
      const stY = stRnd() * h * 0.25 + h * 0.05;
      const len = (40 + stRnd() * 40) * dpr;
      const progress = shootT / 0.04;
      ctx.save(); ctx.globalAlpha = 1 - progress;
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2*dpr; ctx.lineCap = "round";
      ctx.beginPath(); 
      ctx.moveTo(stX + len * progress, stY + len * 0.5 * progress); 
      ctx.lineTo(stX + len * progress - len * 0.3, stY + len * 0.5 * progress - len * 0.15);
      ctx.stroke();
      ctx.restore();
    }
  } else if (map.id !== "desert") {
    // Regular Sun
    ctx.save();
    ctx.globalAlpha = 0.90; ctx.fillStyle = map.colors.sunColor;
    ctx.beginPath(); ctx.arc(sx, sy, 30 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    const sun = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
    sun.addColorStop(0, map.colors.sunGlow);
    sun.addColorStop(0.55, map.colors.sunGlow.replace(/[\d.]+\)$/g, '0.4)'));
    sun.addColorStop(1, "rgba(255, 255, 255, 0.0)");
    ctx.fillStyle = sun;
    ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill();
  }

  const rnd = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const drift = (camX * 0.014) % 1;
  const margin = 240 * dpr;

  // Skip clouds on Moon (it's space!)
  if (map.id !== "moon") {
    for (let i = 0; i < 7; i++) {
      const x01 = rnd(), y01 = 0.08 + rnd() * 0.22, s01 = 0.55 + rnd() * 0.75, a = 0.22 + rnd() * 0.20;
      const x = (((x01 - drift + 1) % 1) * (w + margin)) - margin * 0.5, y = h * y01;
      drawCloud(ctx, x, y, 96 * dpr * s01, 36 * dpr * s01, a);
    }
  }

  // Skip white horizon haze on Moon and Arctic (looks bad on dark skies)
  if (map.id !== "moon" && map.id !== "arctic") {
    const hz = ctx.createLinearGradient(0, h * 0.42, 0, h);
    hz.addColorStop(0, "rgba(255,255,255,0)"); hz.addColorStop(1, "rgba(255,255,255,0.18)");
    ctx.fillStyle = hz; ctx.fillRect(0, 0, w, h);
  }
}

function ridgeNoise(x: number) { return Math.sin(x * 0.90) * 0.55 + Math.sin(x * 0.37 + 1.9) * 0.28 + Math.sin(x * 1.55 - 0.3) * 0.17; }

function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(x - w * 0.18, y, w * 0.24, h * 0.40, 0, 0, Math.PI * 2);
  ctx.ellipse(x, y - h * 0.12, w * 0.32, h * 0.52, 0, 0, Math.PI * 2);
  ctx.ellipse(x + w * 0.22, y, w * 0.24, h * 0.40, 0, 0, Math.PI * 2);
  ctx.ellipse(x + w * 0.06, y + h * 0.06, w * 0.46, h * 0.48, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.restore();
}

function drawHills(ctx: CanvasRenderingContext2D, w: number, h: number, track: Track, camX: number, camY: number, dpr: number, parallax: number, color: string, alpha: number) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.beginPath();
  const baseY = h * (0.70 - 0.12 * parallax), ampPx = (60 + 110 * parallax) * dpr, freq = 0.08 + 0.06 * parallax;
  ctx.moveTo(0, h);
  const step = 18 * dpr;
  for (let sx = 0; sx < w; sx += step) {
    const worldX = (camX * parallax) + ((sx - w * 0.5) / (SCALE * dpr)) * 0.9;
    const y = baseY - ridgeNoise((worldX + 1200 * parallax) * freq) * ampPx;
    ctx.lineTo(sx, y);
  }
  const sxW = w, worldX = (camX * parallax) + ((sxW - w * 0.5) / (SCALE * dpr)) * 0.9;
  ctx.lineTo(sxW, baseY - ridgeNoise((worldX + 1200 * parallax) * freq) * ampPx);
  ctx.lineTo(w, h); ctx.closePath(); ctx.fill(); ctx.restore();
}

function drawForest(ctx: CanvasRenderingContext2D, w: number, h: number, camX: number, dpr: number, parallax: number, color: string, alpha: number) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color;
  const baseY = h * 0.70, amp = 32 * dpr, freq = 0.12, step = 14 * dpr, widthWorld = (w / (SCALE * dpr)) * 0.9;
  ctx.beginPath(); ctx.moveTo(0, h);
  let lastSx = 0;
  for (let sx = 0; sx <= w; sx += 18 * dpr) {
    lastSx = sx; const worldX = (camX * parallax) + ((sx - w * 0.5) / (SCALE * dpr)) * 0.85;
    ctx.lineTo(sx, baseY - ridgeNoise((worldX + 999) * freq) * amp);
  }
  if (lastSx < w) {
    const worldX = (camX * parallax) + ((w - w * 0.5) / (SCALE * dpr)) * 0.85;
    ctx.lineTo(w, baseY - ridgeNoise((worldX + 999) * freq) * amp);
  }
  ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = alpha * 0.90;
  for (let sx = -40 * dpr; sx <= w + 40 * dpr; sx += step) {
    const worldX = (camX * parallax) + ((sx - w * 0.5) / (SCALE * dpr)) * 0.85;
    const n = ridgeNoise((worldX + 333) * (freq * 1.35));
    if (Math.abs(((worldX - camX) / widthWorld)) > 1.1) continue;
    const ridgeY = baseY - n * amp, th = (16 + (n + 1) * 8) * dpr, tw = 7.5 * dpr;
    ctx.beginPath(); ctx.moveTo(sx, ridgeY); ctx.lineTo(sx + tw, ridgeY - th); ctx.lineTo(sx + tw * 2, ridgeY); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawMountains(ctx: CanvasRenderingContext2D, w: number, h: number, camX: number, dpr: number, parallax: number, color: string, alpha: number) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.beginPath();
  const baseY = h * 0.52; ctx.moveTo(0, h);
  const step = 24 * dpr;
  for (let sx = 0; sx < w; sx += step) {
    const worldX = (camX * parallax) + ((sx - w * 0.5) / (SCALE * dpr)) * 0.85;
    ctx.lineTo(sx, baseY - (52 + ridgeNoise(worldX * (0.09 + parallax * 0.03)) * 78) * dpr * (0.68 + parallax * 1.35));
  }
  const sxW = w, worldX = (camX * parallax) + ((sxW - w * 0.5) / (SCALE * dpr)) * 0.85;
  ctx.lineTo(sxW, baseY - (52 + ridgeNoise(worldX * (0.09 + parallax * 0.03)) * 78) * dpr * (0.68 + parallax * 1.35));
  ctx.lineTo(w, h); ctx.closePath(); ctx.fill(); ctx.restore();
}

function drawGround(ctx: CanvasRenderingContext2D, w: number, h: number, track: Track, camX: number, camY: number, dpr: number, viewCX: number, viewCY: number, map: MapConfig) {
  const screenYOfGround = (xWorld: number) => viewCY - (sampleTrackY(track, xWorld) - camY) * SCALE * dpr;

  const dirtGrad = ctx.createLinearGradient(0, 0, 0, h);
  dirtGrad.addColorStop(0, map.colors.dirtTop);
  dirtGrad.addColorStop(0.55, map.colors.dirtMid);
  dirtGrad.addColorStop(1, map.colors.dirtBottom);
  ctx.fillStyle = dirtGrad; ctx.beginPath(); ctx.moveTo(0, h);
  let lastSx = 0;
  for (let sx = 0; sx <= w; sx += 4 * dpr) {
    lastSx = sx; ctx.lineTo(sx, screenYOfGround(camX + (sx - viewCX) / (SCALE * dpr)));
  }
  if (lastSx < w) ctx.lineTo(w, screenYOfGround(camX + (w - viewCX) / (SCALE * dpr)));
  ctx.lineTo(w, h); ctx.closePath(); ctx.fill();

  ctx.strokeStyle = "rgba(0,0,0,0.16)"; ctx.lineWidth = 22 * dpr; ctx.lineCap = "round"; ctx.beginPath();
  let lastSx2 = 0;
  for (let sx = 0; sx <= w; sx += 6 * dpr) {
    lastSx2 = sx; const y = screenYOfGround(camX + (sx - viewCX) / (SCALE * dpr)) + 4 * dpr;
    if (sx === 0) ctx.moveTo(sx, y); else ctx.lineTo(sx, y);
  }
  if (lastSx2 < w) ctx.lineTo(w, screenYOfGround(camX + (w - viewCX) / (SCALE * dpr)) + 4 * dpr);
  ctx.stroke();

  const startX = camX - (viewCX / (SCALE * dpr));
  const endX = camX + ((w - viewCX) / (SCALE * dpr));

  ctx.fillStyle = "rgba(255,255,255,0.05)";
  for (let wx = Math.floor(startX); wx <= Math.ceil(endX); wx++) {
    const prnd = mulberry32(wx * 1234.5);
    const groundY = sampleTrackY(track, wx);
    for (let j = 0; j < 4; j++) {
      const dx = prnd();
      const dy = prnd() * 8 + 0.8;
      const sx = viewCX + (wx + dx - camX) * SCALE * dpr;
      const sy = viewCY - (groundY - dy - camY) * SCALE * dpr;
      const r = (2 + prnd() * 5) * dpr;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  ctx.fillStyle = "rgba(0,0,0,0.12)";
  for (let wx = Math.floor(startX); wx <= Math.ceil(endX); wx++) {
    const prnd = mulberry32(Math.abs(wx * 9876));
    const groundY = sampleTrackY(track, wx);
    for (let j = 0; j < 8; j++) {
      const dx = prnd();
      const dy = prnd() * 15 + 1.5;
      const sx = viewCX + (wx + dx - camX) * SCALE * dpr;
      const sy = viewCY - (groundY - dy - camY) * SCALE * dpr;
      const wR = (2 + prnd() * 6) * dpr;
      const hR = (2 + prnd() * 4) * dpr;
      ctx.beginPath(); ctx.ellipse(sx, sy, wR, hR, prnd()*Math.PI, 0, Math.PI * 2); ctx.fill();
    }
  }

  const startXWorld = camX - (viewCX / (SCALE * dpr)) - 1;
  const endXWorld = camX + ((w - viewCX) / (SCALE * dpr)) + 1;

  ctx.strokeStyle = map.colors.grassColor; ctx.lineWidth = 12 * dpr; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.beginPath();
  let first = true;
  for (let wx = Math.floor(startXWorld * 5) / 5; wx <= Math.ceil(endXWorld * 5) / 5; wx += 0.2) {
    const sx = viewCX + (wx - camX) * SCALE * dpr;
    const wave = Math.sin(wx * 15) * 3 * dpr + Math.sin(wx * 43) * 2 * dpr;
    const y = screenYOfGround(wx) + wave;
    if (first) { ctx.moveTo(sx, y); first = false; } else ctx.lineTo(sx, y);
  }
  ctx.stroke();

  ctx.strokeStyle = map.colors.grassHighlight; ctx.lineWidth = 4 * dpr; ctx.beginPath();
  first = true;
  for (let wx = Math.floor(startXWorld * 5) / 5; wx <= Math.ceil(endXWorld * 5) / 5; wx += 0.2) {
    const sx = viewCX + (wx - camX) * SCALE * dpr;
    const wave = Math.sin(wx * 15) * 3 * dpr + Math.sin(wx * 43) * 2 * dpr;
    const y = screenYOfGround(wx) - 4 * dpr + wave;
    if (first) { ctx.moveTo(sx, y); first = false; } else ctx.lineTo(sx, y);
  }
  ctx.stroke();
}

function drawCoin(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save(); ctx.fillStyle = "#ffd60a"; ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.35, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawFuel(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save(); ctx.translate(x, y);
  const w = s * 1.55, h = s * 1.90, r = Math.max(2, s * 0.16), outline = Math.max(2, s * 0.14);
  ctx.fillStyle = "#e11d2e"; ctx.strokeStyle = "#0f172a"; ctx.lineWidth = outline;
  roundRect(ctx, -w / 2, -h / 2, w, h, r); ctx.fill(); ctx.stroke();
  ctx.save(); ctx.globalCompositeOperation = "destination-out"; roundRect(ctx, -w * 0.32, -h * 0.47, w * 0.40, h * 0.22, r * 0.65); ctx.fill(); ctx.restore();
  ctx.strokeStyle = "#0f172a"; ctx.lineWidth = outline * 0.8; roundRect(ctx, -w * 0.32, -h * 0.47, w * 0.40, h * 0.22, r * 0.65); ctx.stroke();
  ctx.fillStyle = "#0f172a"; roundRect(ctx, w * 0.10, -h * 0.63, w * 0.38, h * 0.18, r * 0.55); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.25)"; roundRect(ctx, w * 0.16, -h * 0.60, w * 0.18, h * 0.10, r * 0.45); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.65)"; ctx.lineWidth = outline * 0.55; roundRect(ctx, -w * 0.28, -h * 0.18, w * 0.56, h * 0.52, r * 0.8); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.92)"; ctx.lineWidth = outline * 0.65; ctx.lineCap = "round";
  const x0 = -w * 0.18, x1 = w * 0.18, y0 = -h * 0.02, y1 = h * 0.26;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.moveTo(x1, y0); ctx.lineTo(x0, y1); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.16)"; roundRect(ctx, -w * 0.40, -h * 0.42, w * 0.22, h * 0.70, r * 0.8); ctx.fill();
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
}

const SPORTS_CAR_REAR_WHEEL_X_PCT = 179.4 / 1024;
const SPORTS_CAR_WHEEL_SEPARATION_PCT = (801.0 - 179.4) / 1024;
const SPORTS_CAR_WHEEL_Y_PCT = 226.2 / 295;
// Manual sports-car head tuning.
// Change these if you want to move the head by hand:
// - xPct: bigger = move right, smaller = move left
// - yPct: bigger = move down, smaller = move up
// - offsetXPx / offsetYPx: fine pixel nudges after percentage placement
// - sizeMult: selected head size inside the sports-car cockpit
const SPORTS_CAR_HEAD_MANUAL = {
  xPct: 0.473,
  yPct: 0.13,
  offsetXPx: 0,
  offsetYPx: 0,
  sizeMult: 0.72,
} as const;

const JEEP_BODY_MANUAL = {
  offsetXPx: 0,      // fine body nudge in pixels
  offsetYPx: -10,    // negative = lift jeep body above the wheel centers
} as const;

const JEEP_HEAD_MANUAL = {
  xPct: 0.392,      // bigger = move head right, smaller = move head left
  yPct: 0.265,      // bigger = move head down, smaller = move head up
  offsetXPx: 0,     // fine left/right nudge in pixels
  offsetYPx: 0,     // fine up/down nudge in pixels
  sizeMult: 0.56,   // selected head size inside the jeep cabin
} as const;

const JEEP_WHEEL_MANUAL = {
  rearOffsetXPx: 0,     // rear wheel: bigger = move right, negative = move left
  frontOffsetXPx: 0,    // front wheel: bigger = move right, negative = move left
  offsetYPx: 0,         // both wheels: bigger = move down, negative = move up
  sizeMult: 1.0,        // visual wheel size; keep 1.0 to match physics radius
} as const;

type VehicleArtTuning = {
  bodyScale: number;
  bodyOffsetXPx: number;
  bodyOffsetYPx: number;
  headOffsetXPx: number;
  headOffsetYPx: number;
  headSizeMult: number;
  rearWheelOffsetXPx: number;
  frontWheelOffsetXPx: number;
  wheelOffsetYPx: number;
  wheelSizeMult: number;
};

function getVehicleArtTuning(vehicleId: VehicleId, isPhoneViewport: boolean): VehicleArtTuning {
  if (vehicleId === "jeep") {
    return {
      bodyScale: 1,
      bodyOffsetXPx: JEEP_BODY_MANUAL.offsetXPx,
      bodyOffsetYPx: JEEP_BODY_MANUAL.offsetYPx,
      headOffsetXPx: JEEP_HEAD_MANUAL.offsetXPx,
      headOffsetYPx: JEEP_HEAD_MANUAL.offsetYPx,
      headSizeMult: JEEP_HEAD_MANUAL.sizeMult,
      rearWheelOffsetXPx: JEEP_WHEEL_MANUAL.rearOffsetXPx,
      frontWheelOffsetXPx: JEEP_WHEEL_MANUAL.frontOffsetXPx,
      wheelOffsetYPx: JEEP_WHEEL_MANUAL.offsetYPx,
      wheelSizeMult: JEEP_WHEEL_MANUAL.sizeMult,
    };
  }

  if (vehicleId === "sportsCar") {
    return {
      bodyScale: isPhoneViewport ? 1.12 : 1,
      bodyOffsetXPx: 0,
      bodyOffsetYPx: isPhoneViewport ? -1 : 0,
      headOffsetXPx: SPORTS_CAR_HEAD_MANUAL.offsetXPx,
      headOffsetYPx: SPORTS_CAR_HEAD_MANUAL.offsetYPx,
      headSizeMult: isPhoneViewport ? 0.68 : SPORTS_CAR_HEAD_MANUAL.sizeMult,
      rearWheelOffsetXPx: 0,
      frontWheelOffsetXPx: isPhoneViewport ? 8 : 0,
      wheelOffsetYPx: 0,
      wheelSizeMult: 1,
    };
  }

  return {
    bodyScale: 1,
    bodyOffsetXPx: 0,
    bodyOffsetYPx: 0,
    headOffsetXPx: 0,
    headOffsetYPx: 0,
    headSizeMult: 1,
    rearWheelOffsetXPx: 0,
    frontWheelOffsetXPx: 0,
    wheelOffsetYPx: 0,
    wheelSizeMult: 1,
  };
}

function getJeepBodyLayout(vPhys: { spawnY: number; wheelRadius: number; wheelbase: number }, imgW: number, imgH: number, tuning: VehicleArtTuning = getVehicleArtTuning("jeep", false)) {
  const wheelRestY = (vPhys.spawnY - (vPhys.wheelRadius + 0.2)) * SCALE;
  const bodyW = (((vPhys.wheelbase * SCALE) * 2) / JEEP_WHEEL_SEPARATION_PCT) * tuning.bodyScale;
  const bodyH = bodyW * (imgH / imgW);
  const bodyX = (-vPhys.wheelbase * SCALE) - JEEP_REAR_WHEEL_X_PCT * bodyW + tuning.bodyOffsetXPx;
  const bodyY = wheelRestY - JEEP_WHEEL_Y_PCT * bodyH + tuning.bodyOffsetYPx;
  return { bodyX, bodyY, bodyW, bodyH };
}

function getJeepHeadTargetPx(
  vPhys: { spawnY: number; wheelRadius: number; wheelbase: number },
  imgW = 1829,
  imgH = 784,
  tuning: VehicleArtTuning = getVehicleArtTuning("jeep", false),
) {
  const { bodyX, bodyY, bodyW, bodyH } = getJeepBodyLayout(vPhys, imgW, imgH, tuning);
  return {
    x: bodyX + JEEP_HEAD_MANUAL.xPct * bodyW + tuning.headOffsetXPx,
    y: bodyY + JEEP_HEAD_MANUAL.yPct * bodyH + tuning.headOffsetYPx,
  };
}

function getSportsCarBodyLayout(vPhys: { spawnY: number; wheelRadius: number; wheelbase: number }, imgW: number, imgH: number, tuning: VehicleArtTuning = getVehicleArtTuning("sportsCar", false)) {
  const wheelRestY = (vPhys.spawnY - (vPhys.wheelRadius + 0.2)) * SCALE;
  const bodyW = (((vPhys.wheelbase * SCALE) * 2) / SPORTS_CAR_WHEEL_SEPARATION_PCT) * tuning.bodyScale;
  const bodyH = bodyW * (imgH / imgW);
  const bodyX = (-vPhys.wheelbase * SCALE) - SPORTS_CAR_REAR_WHEEL_X_PCT * bodyW + tuning.bodyOffsetXPx;
  const bodyY = wheelRestY - SPORTS_CAR_WHEEL_Y_PCT * bodyH + tuning.bodyOffsetYPx;
  return { bodyX, bodyY, bodyW, bodyH };
}

function getSportsCarHeadTargetPx(
  vPhys: { spawnY: number; wheelRadius: number; wheelbase: number },
  imgW = 1024,
  imgH = 295,
  tuning: VehicleArtTuning = getVehicleArtTuning("sportsCar", false),
) {
  const { bodyX, bodyY, bodyW, bodyH } = getSportsCarBodyLayout(vPhys, imgW, imgH, tuning);

  return {
    x: bodyX + SPORTS_CAR_HEAD_MANUAL.xPct * bodyW + tuning.headOffsetXPx,
    y: bodyY + SPORTS_CAR_HEAD_MANUAL.yPct * bodyH + tuning.headOffsetYPx,
  };
}

function getHeadLocal(vehicleId: VehicleId) {
  if (vehicleId === "sportsCar") {
    const target = getSportsCarHeadTargetPx(VEHICLES.sportsCar.physics);
    return Vec2(target.x / SCALE, -target.y / SCALE);
  }
  if (vehicleId === "jeep") {
    const target = getJeepHeadTargetPx(VEHICLES.jeep.physics);
    return Vec2(target.x / SCALE, -target.y / SCALE);
  }
  return Vec2(-0.25, 0.75);
}

function drawVehicle(ctx: CanvasRenderingContext2D, toScreen: (v: planck.Vec2) => { x: number; y: number }, car: CarRig, dpr: number, headId: HeadId, headImg: HTMLImageElement | null, headImg2: HTMLImageElement | null, jeepBodyImg: HTMLImageElement | null, jeepWheelImg: HTMLImageElement | null, sportsCarBodyImg: HTMLImageElement | null, sportsCarWheelImg: HTMLImageElement | null, miniMode: boolean, isPhoneViewport: boolean, vehicleId: VehicleId, screenGroundY: number) {
  const chassis = car.chassis; const p = chassis.getPosition(); const a = chassis.getAngle(); const sp = toScreen(p);
  const vPhys = VEHICLES[vehicleId].physics; const vVis = VEHICLES[vehicleId].visual;
  const artTuning = getVehicleArtTuning(vehicleId, isPhoneViewport);

  if (!miniMode) {
    const heightDiff = Math.max(0, screenGroundY - sp.y);
    const shadowAlpha = Math.max(0.02, 0.25 - (heightDiff * 0.0015));
    const shadowSize = (vehicleId === "bicycle" ? 50 : 92) * dpr * Math.max(0.4, 1 - (heightDiff * 0.002));
    ctx.save(); ctx.globalAlpha = shadowAlpha; ctx.fillStyle = "#000"; ctx.beginPath();
    ctx.ellipse(sp.x, screenGroundY, shadowSize, 14 * dpr, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }

  if (vehicleId === "sportsCar" && sportsCarWheelImg && sportsCarWheelImg.complete) {
    drawSportsCarWheel(ctx, toScreen(car.wheel1.getPosition()), car.wheel1.getAngle(), chassis.getAngle(), vPhys.wheelRadius, dpr, sportsCarWheelImg, artTuning.wheelSizeMult, artTuning.rearWheelOffsetXPx, artTuning.wheelOffsetYPx);
    drawSportsCarWheel(ctx, toScreen(car.wheel2.getPosition()), car.wheel2.getAngle(), chassis.getAngle(), vPhys.wheelRadius, dpr, sportsCarWheelImg, artTuning.wheelSizeMult, artTuning.frontWheelOffsetXPx, artTuning.wheelOffsetYPx);
  } else if (vehicleId === "jeep" && jeepWheelImg && jeepWheelImg.complete) {
    drawJeepWheel(ctx, toScreen(car.wheel1.getPosition()), car.wheel1.getAngle(), chassis.getAngle(), vPhys.wheelRadius, dpr, jeepWheelImg, artTuning.rearWheelOffsetXPx, artTuning.wheelOffsetYPx, artTuning.wheelSizeMult);
    drawJeepWheel(ctx, toScreen(car.wheel2.getPosition()), car.wheel2.getAngle(), chassis.getAngle(), vPhys.wheelRadius, dpr, jeepWheelImg, artTuning.frontWheelOffsetXPx, artTuning.wheelOffsetYPx, artTuning.wheelSizeMult);
  } else {
    drawWheel(ctx, toScreen(car.wheel1.getPosition()), car.wheel1.getAngle(), vPhys.wheelRadius, dpr);
    drawWheel(ctx, toScreen(car.wheel2.getPosition()), car.wheel2.getAngle(), vPhys.wheelRadius, dpr);
  }

  ctx.save(); ctx.translate(sp.x, sp.y); ctx.rotate(-a);
  const BODY_BASE_PX_PER_M = 45;
  // Image-based vehicle art is already sized from the current physics SCALE.
  // Applying the extra Mini App scale again made the jeep/sports-car bodies shrink on phones
  // while their wheels stayed full-size. Keep that extra scale only for the hand-drawn bike.
  const bodyScale = miniMode && vehicleId === "bicycle" ? (SCALE / BODY_BASE_PX_PER_M) : 1;
  ctx.scale(dpr * bodyScale, dpr * bodyScale);

  if (vehicleId === "bicycle") {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const color = vVis.bodyColor; // Yellow

    // Rear Shock Absorber (Red spring)
    ctx.lineWidth = 4; ctx.strokeStyle = "#171717";
    ctx.beginPath(); ctx.moveTo(-12, -10); ctx.lineTo(-20, 6); ctx.stroke();
    ctx.lineWidth = 6; ctx.strokeStyle = "#ef4444";
    ctx.beginPath(); ctx.moveTo(-13, -8); ctx.lineTo(-19, 4); ctx.stroke();

    // 1. Rear Swingarm & Chain
    ctx.lineWidth = 6; ctx.strokeStyle = "#a3a3a3"; // Silver swingarm
    ctx.beginPath(); ctx.moveTo(-15, 6); ctx.lineTo(-35, 18); ctx.stroke();
    // Chain
    ctx.lineWidth = 2; ctx.strokeStyle = "#1a1a1a";
    ctx.beginPath(); ctx.moveTo(-15, 2); ctx.lineTo(-35, 14); ctx.moveTo(-15, 10); ctx.lineTo(-35, 22); ctx.stroke();

    // 2. Main Frame (Silver)
    ctx.strokeStyle = "#d4d4d4"; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(16, -24); // steering head
    ctx.lineTo(6, 6);    // down tube
    ctx.lineTo(-15, 6);  // bottom rail
    ctx.lineTo(-10, -18); // up to seat
    ctx.closePath(); ctx.stroke();

    // 3. Subframe (Silver)
    ctx.beginPath(); ctx.moveTo(-10, -18); ctx.lineTo(-42, -16); ctx.lineTo(-15, 6); ctx.stroke();

    // 4. Front Forks (Chrome/Gold)
    ctx.lineWidth = 6; ctx.strokeStyle = "#e5e5e5";
    ctx.beginPath(); ctx.moveTo(22, -26); ctx.lineTo(34, 18); ctx.stroke();
    // Fork upper tube (Gold)
    ctx.lineWidth = 8; ctx.strokeStyle = "#eab308";
    ctx.beginPath(); ctx.moveTo(20, -32); ctx.lineTo(26, -5); ctx.stroke();
    // Triple clamps
    ctx.fillStyle = "#171717"; ctx.fillRect(18, -30, 8, 4); ctx.fillRect(20, -22, 8, 4);

    // 5. Engine & Transmission
    // Engine case
    ctx.fillStyle = "#a3a3a3"; ctx.beginPath(); ctx.roundRect(-12, -4, 22, 14, 4); ctx.fill();
    ctx.fillStyle = "#737373"; ctx.beginPath(); ctx.arc(-4, 6, 8, 0, Math.PI * 2); ctx.fill(); // Clutch cover
    ctx.fillStyle = "#171717"; ctx.beginPath(); ctx.arc(-4, 6, 2, 0, Math.PI * 2); ctx.fill(); 
    // Cylinder & Head (Cooling fins)
    ctx.fillStyle = "#525252"; ctx.beginPath(); ctx.moveTo(-8, -4); ctx.lineTo(2, -16); ctx.lineTo(12, -12); ctx.lineTo(10, -4); ctx.fill();
    ctx.strokeStyle = "#a3a3a3"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-4, -8); ctx.lineTo(8, -8); ctx.moveTo(-2, -12); ctx.lineTo(10, -12); ctx.stroke();

    // 6. 4-Stroke Exhaust Pipe (Silver pipe curving down, out back)
    ctx.strokeStyle = "#d4d4d4"; ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(10, -8);
    ctx.quadraticCurveTo(18, 0, 10, 8);
    ctx.quadraticCurveTo(5, 12, -10, 8);
    ctx.lineTo(-25, -2);
    ctx.stroke();
    // Tailpipe & Silencer
    ctx.lineWidth = 9; ctx.strokeStyle = "#e5e5e5"; // Silver silencer
    ctx.beginPath(); ctx.moveTo(-25, -2); ctx.lineTo(-45, -10); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = "#171717"; // silencer detail
    ctx.beginPath(); ctx.moveTo(-30, -3); ctx.lineTo(-40, -7); ctx.stroke();
    ctx.lineWidth = 5; ctx.strokeStyle = "#171717"; // tip
    ctx.beginPath(); ctx.moveTo(-45, -10); ctx.lineTo(-50, -12); ctx.stroke();

    // 7. Bodywork / Plastics (Yellow & White)

    // Rear Fender (Yellow tail, white side panels)
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.moveTo(-10, -20); ctx.lineTo(-48, -20); ctx.lineTo(-44, -14); ctx.lineTo(-15, -14); ctx.fill();
    ctx.fillStyle = color; // Yellow tip
    ctx.beginPath(); ctx.moveTo(-38, -20); ctx.lineTo(-52, -18); ctx.lineTo(-44, -14); ctx.fill();

    // Side Number Plate (White)
    ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#e5e5e5"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-28, -16); ctx.lineTo(-8, -16); ctx.lineTo(-4, 0); ctx.lineTo(-24, -4); ctx.closePath(); ctx.fill(); ctx.stroke();
    // Number
    ctx.fillStyle = "#171717"; ctx.font = "bold 8px Arial"; ctx.fillText("4", -20, -6);

    // Tank & Shrouds (Yellow with Red 'S')
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-12, -24); // seat junction
    ctx.lineTo(16, -28); // steering head
    ctx.lineTo(26, -8);  // tip of shroud pointing to forks
    ctx.lineTo(12, 2);   // bottom of shroud
    ctx.lineTo(0, -10);
    ctx.closePath(); ctx.fill();
    // Radiator louvers (dark lines under shroud)
    ctx.strokeStyle = "#171717"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(8, -8); ctx.lineTo(14, -2); ctx.moveTo(12, -10); ctx.lineTo(18, -4); ctx.stroke();
    
    // Shroud graphic (Red 'S')
    ctx.fillStyle = "#ef4444";
    ctx.font = "bold 14px Arial";
    ctx.save(); ctx.translate(12, -12); ctx.rotate(-0.2); ctx.fillText("S", -5, 5); ctx.restore();

    // Front Fender (Yellow, long and pointy)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(14, -22);
    ctx.quadraticCurveTo(32, -22, 48, -10);
    ctx.lineTo(44, -6);
    ctx.quadraticCurveTo(28, -16, 16, -16);
    ctx.closePath(); ctx.fill();

    // Front Number Plate (White)
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.moveTo(16, -30); ctx.lineTo(24, -16); ctx.lineTo(18, -14); ctx.lineTo(12, -26); ctx.closePath(); ctx.fill();

    // 8. Seat (Blue, ribbed)
    ctx.fillStyle = "#1d4ed8"; // Blue
    ctx.beginPath();
    ctx.moveTo(-38, -20); // rear tip
    ctx.lineTo(-12, -22); // mid dip
    ctx.lineTo(10, -28);  // front up on tank
    ctx.lineTo(6, -24);
    ctx.lineTo(-12, -18);
    ctx.lineTo(-36, -16);
    ctx.closePath(); ctx.fill();
    // Seat ribs
    ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 1;
    for(let i = -30; i < 5; i+=4) { ctx.beginPath(); ctx.moveTo(i, -21); ctx.lineTo(i+2, -18); ctx.stroke(); }

    // 9. Handlebars & Grips
    ctx.strokeStyle = "#262626"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(16, -28); ctx.lineTo(10, -42); ctx.lineTo(22, -44); ctx.stroke();
    // Crossbar pad
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(12, -39, 8, 4, 2); ctx.fill();
    // Grip
    ctx.lineWidth = 6; ctx.strokeStyle = "#111";
    ctx.beginPath(); ctx.moveTo(18, -43); ctx.lineTo(24, -45); ctx.stroke();
  }
  else if (vehicleId === "sportsCar") {
    if (sportsCarBodyImg && sportsCarBodyImg.complete) {
      // Pixel-matched to the supplied artwork: the body is scaled from the two wheel-hole centers,
      // so the physics wheel bodies stay visually inside the arches instead of drifting by eye.
      const { bodyX, bodyY, bodyW, bodyH } = getSportsCarBodyLayout(vPhys, sportsCarBodyImg.naturalWidth, sportsCarBodyImg.naturalHeight, artTuning);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(sportsCarBodyImg, bodyX, bodyY, bodyW, bodyH);
      ctx.restore();
    } else {
      const bodyGrad = ctx.createLinearGradient(0, -40, 0, 30);
      bodyGrad.addColorStop(0, vVis.highlightColor);
      bodyGrad.addColorStop(0.6, vVis.bodyColor);
      bodyGrad.addColorStop(1, vVis.accentColor);

      ctx.fillStyle = bodyGrad; ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-75, 5);
      ctx.lineTo(-75, -5);
      ctx.lineTo(-60, -15);
      ctx.lineTo(-30, -15);
      ctx.quadraticCurveTo(-10, -42, 10, -35);
      ctx.lineTo(40, -18);
      ctx.quadraticCurveTo(75, -10, 85, 8);
      ctx.lineTo(85, 20);
      ctx.lineTo(60, 25);
      ctx.lineTo(-60, 25);
      ctx.lineTo(-75, 20);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  else if (vehicleId === "jeep") {
    if (jeepBodyImg && jeepBodyImg.complete) {
      const { bodyX, bodyY, bodyW, bodyH } = getJeepBodyLayout(vPhys, jeepBodyImg.naturalWidth, jeepBodyImg.naturalHeight, artTuning);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(jeepBodyImg, bodyX, bodyY, bodyW, bodyH);
      ctx.restore();
    }
  }

  // --- DRIVER RENDERING ---
  ctx.save(); ctx.fillStyle = "#2b1a0f"; ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 3;
  if (vehicleId === "bicycle") {
    // Advanced Rider Body for Dirt Bike
    // Boot (Black)
    ctx.fillStyle = "#111"; ctx.strokeStyle = "#222"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-2, -4);  // ankle back
    ctx.lineTo(6, -4);   // ankle front
    ctx.lineTo(12, 6);   // toe top
    ctx.lineTo(14, 10);  // toe front
    ctx.lineTo(14, 14);  // sole front
    ctx.lineTo(-4, 14);  // sole back
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // Pants (Yellow/White)
    ctx.fillStyle = "#eab308"; // Yellow
    ctx.beginPath();
    ctx.moveTo(-18, -24); // butt on seat
    ctx.lineTo(-4, -28);  // hip
    ctx.lineTo(8, -8);    // knee front
    ctx.lineTo(12, -4);   // knee guard
    ctx.lineTo(6, -4);    // ankle front
    ctx.lineTo(-2, -4);   // ankle back
    ctx.lineTo(-14, -20); // under thigh
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Pants white detail
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.moveTo(-4, -28); ctx.lineTo(4, -16); ctx.lineTo(-8, -22); ctx.fill();

    // Torso (Jersey - White with Yellow)
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(-18, -24); // lower back
    ctx.lineTo(0, -26);   // waist front
    ctx.lineTo(6, -55);   // chest
    ctx.lineTo(-10, -60); // upper back/neck base
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Jersey detail
    ctx.fillStyle = "#eab308";
    ctx.beginPath(); ctx.moveTo(-4, -35); ctx.lineTo(4, -45); ctx.lineTo(0, -55); ctx.lineTo(-8, -45); ctx.fill();

    // Neck
    ctx.fillStyle = "#f3ae7d";
    ctx.beginPath();
    ctx.moveTo(-8, -66);
    ctx.lineTo(4, -66);
    ctx.lineTo(6, -55);
    ctx.lineTo(-10, -60);
    ctx.closePath(); ctx.fill();

    // Arm (Jersey sleeve)
    ctx.fillStyle = "#1f2937"; ctx.strokeStyle = "#111"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(2, -55);  // shoulder top
    ctx.lineTo(-4, -58); // shoulder back
    ctx.lineTo(4, -35);  // elbow back
    ctx.lineTo(18, -46); // wrist top
    ctx.lineTo(24, -42); // wrist bottom
    ctx.lineTo(10, -30); // inner elbow
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Glove (Black)
    ctx.fillStyle = "#222";
    ctx.beginPath(); ctx.arc(21, -44, 5, 0, Math.PI*2); ctx.fill();
  }
  else if (vehicleId === "sportsCar") {
    // No visible torso for the low convertible: the cockpit/seats are already part of the body art.
    // Drawing only the selected head keeps it seated instead of pasted on top of the door.
  }
  else if (vehicleId === "jeep") {
    // The new jeep artwork already includes the seat and steering wheel, so only the selected head is drawn.
  }
  else { roundRect(ctx, -24, -32, 18, 18, 6); ctx.fill(); ctx.stroke(); }
  ctx.restore();

  const head = headId === "brian" ? headImg2 : headImg;
  if (head && head.complete) {
    ctx.imageSmoothingEnabled = false; const cfg = HEADS[headId].draw;
    let hx = cfg.x, hy = cfg.y, headSize = cfg.size;

    if (vehicleId === "bicycle") { hx += 10; hy -= 32; }
    else if (vehicleId === "sportsCar") {
      const target = sportsCarBodyImg && sportsCarBodyImg.complete
        ? getSportsCarHeadTargetPx(vPhys, sportsCarBodyImg.naturalWidth, sportsCarBodyImg.naturalHeight, artTuning)
        : { x: cfg.x + 25, y: cfg.y + 64 };
      headSize = Math.round(cfg.size * artTuning.headSizeMult);
      hx = target.x - headSize / 2;
      hy = target.y - headSize / 2;
    }
    else if (vehicleId === "jeep") {
      const target = jeepBodyImg && jeepBodyImg.complete
        ? getJeepHeadTargetPx(vPhys, jeepBodyImg.naturalWidth, jeepBodyImg.naturalHeight, artTuning)
        : { x: cfg.x + 20, y: cfg.y + 52 };
      headSize = Math.round(cfg.size * artTuning.headSizeMult);
      hx = target.x - headSize / 2;
      hy = target.y - headSize / 2;
    }

    ctx.drawImage(head, hx, hy, headSize, headSize);
  }
  ctx.restore();
}

function drawJeepWheel(
  ctx: CanvasRenderingContext2D,
  sp: { x: number; y: number },
  wheelAngle: number,
  chassisAngle: number,
  radiusM: number,
  dpr: number,
  wheelImg: HTMLImageElement,
  offsetXPx: number,
  offsetYPx: number,
  sizeMult: number,
) {
  const c = Math.cos(-chassisAngle);
  const s = Math.sin(-chassisAngle);
  const ox = (offsetXPx * c - offsetYPx * s) * dpr;
  const oy = (offsetXPx * s + offsetYPx * c) * dpr;
  const r = radiusM * SCALE * dpr * sizeMult;
  ctx.save();
  ctx.translate(sp.x + ox, sp.y + oy);
  ctx.rotate(-wheelAngle);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(wheelImg, -r, -r, r * 2, r * 2);
  ctx.restore();
}

function drawSportsCarWheel(ctx: CanvasRenderingContext2D, sp: { x: number; y: number }, ang: number, chassisAngle: number, radiusM: number, dpr: number, wheelImg: HTMLImageElement, sizeMult = 1, offsetXPx = 0, offsetYPx = 0) {
  const c = Math.cos(-chassisAngle);
  const s = Math.sin(-chassisAngle);
  const ox = (offsetXPx * c - offsetYPx * s) * dpr;
  const oy = (offsetXPx * s + offsetYPx * c) * dpr;
  const r = radiusM * SCALE * dpr * sizeMult;
  ctx.save(); ctx.translate(sp.x + ox, sp.y + oy); ctx.rotate(-ang);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(wheelImg, -r, -r, r * 2, r * 2);
  ctx.restore();
}

function drawWheel(ctx: CanvasRenderingContext2D, sp: { x: number; y: number }, ang: number, radiusM: number, dpr: number) {
  const r = radiusM * SCALE * dpr;
  ctx.save(); ctx.translate(sp.x, sp.y); ctx.rotate(-ang);
  ctx.fillStyle = "#262626"; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#cfcfcf"; ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 3 * dpr;
  for (let i = 0; i < 6; i++) { ctx.rotate((Math.PI * 2) / 6); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r * 0.62, 0); ctx.stroke(); }
  ctx.fillStyle = "#e6e6e6"; ctx.beginPath(); ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
