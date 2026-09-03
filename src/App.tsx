import { Fragment, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Helicopter } from './game/entities';
import {
  EnemyVariant,
  GameEngine,
  HANGAR_UPGRADE_INFO,
  HelicopterModel,
  buyHangarUpgrade,
  countermeasureConfig,
  readDeliveryCredits,
  readHangarUpgrades,
} from './game';
import type {
  DeliveryHudSnapshot,
  GameSettings,
  HangarUpgradeId,
  HangarUpgrades,
  MinimapSnapshot,
  MissionHudSnapshot,
  UpgradeId,
  UpgradeOption,
} from './game';
import {
  formatDuration,
  formatScorecard,
  MAX_PERK_RANK,
  PERK_INFO,
  readMastery,
  readPerks,
  readProgress,
  readRunHistory,
  readWeaponMods,
  STARTER_CREDITS,
  SUPER_MAX_CHARGE,
  WEAPON_MODS,
  writePerkRank,
  writeProgress,
  writeWeaponMod,
} from './game/logic';
import type { PerkId, PerkRanks, RunRecord } from './game/logic';
import {
  Award,
  Bomb,
  BookOpen,
  ChevronRight,
  Cog,
  Coins,
  Crosshair,
  Flame,
  Fuel,
  Play,
  Rocket,
  Shield,
  Skull,
  Sliders,
  Sparkles,
  Trophy,
  Wrench,
  Zap,
} from 'lucide-react';
import React from 'react';

const STORAGE_KEYS = {
  HIGH_SCORE: 'helistrike:highScore',
  CREDITS: 'helistrike:credits',
  SETTINGS: 'helistrike:settings',
  PLAYER_MODEL: 'helistrike:playerModel',
  TUTORIAL_DONE: 'helistrike:tutorialDone',
  PERF: 'helistrike:perf',
} as const;

type GameMode = 'menu' | 'playing' | 'paused' | 'gameover';

type OpeningState = { phase: 'countdown' | 'grace' | 'live'; count?: number; remaining?: number };
type TutorialState = { active: boolean; index?: number; total?: number; id?: string; title?: string; desc?: string };

type RunStats = {
  time: number;
  kills: number;
  maxCombo: number;
  accuracy: number;
  wave: number;
  status?: 'DESTROYED' | 'EXTRACTED';
  threatLevel?: number;
  deliveries?: number;
  samSitesDestroyed?: number;
  radarSitesDestroyed?: number;
  bossesDestroyed?: number;
  missionsCompleted?: number;
  missionBonusesCompleted?: number;
  salvage?: number;
  lostUnsecured?: number;
  securedThreatBonus?: number;
  causeOfDeath?: string;
  credits?: number;
  combatPay?: number;
  achievementCredits?: number;
  achievementLabels?: string[];
};

type PerfStats = {
  fps: number;
  avgFrameMs: number;
  p95FrameMs: number;
  worstFrameMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  graphics: string;
  governorLevel: number;
  enemies: number;
  playerProjectiles: number;
  enemyProjectiles: number;
  particles: number;
  physicsBodies: number;
  sceneObjects: number;
  powerups: number;
  objectives: number;
};

type StickPayload = { x: number; y: number; active: boolean };

const DEFAULT_SETTINGS: GameSettings = {
  invertedY: false,
  gamepadSensitivity: 1.5,
  quality: 'low',
  graphics: 'sp1',
  volume: 0.8,
  musicVolume: 0.8,
  sfxVolume: 1,
  touchMode: false,
  difficulty: 'normal',
  autoAim: false,
  movement: 'arcade',
  screenShake: 'full',
  reduceFlash: false,
  adaptiveQuality: true,
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function readHighScore() {
  const stored = Number(window.localStorage.getItem(STORAGE_KEYS.HIGH_SCORE) ?? 0);
  return Number.isFinite(stored) ? stored : 0;
}

/** One-time starter credit grant for brand-new profiles — paid before the
 *  engine reads the credit bank so the very first Hangar visit can buy. */
function grantStarterCreditsOnce(): number {
  const base = readDeliveryCredits();
  try {
    const progress = readProgress();
    if (progress.starterGranted) return base;
    progress.starterGranted = true;
    writeProgress(progress);
    const next = base + STARTER_CREDITS;
    window.localStorage.setItem(STORAGE_KEYS.CREDITS, String(next));
    return next;
  } catch {
    return base;
  }
}

/** Difficulty copy must match the final balance in DIFFICULTIES. */
const DIFFICULTY_INFO: Record<'casual' | 'normal' | 'hard', { name: string; desc: string }> = {
  casual: {
    name: 'Casual',
    desc: 'Softer enemies, slower fire, lighter collisions — plus an emergency hull repair when you flatline. Best for learning the ropes.',
  },
  normal: {
    name: 'Normal',
    desc: 'The intended experience: full threat director, standard enemy aggression and rewards.',
  },
  hard: {
    name: 'Hard',
    desc: 'Enemies hit 25% harder, fire faster and swarm denser. No emergency repair — but rewards scale up.',
  },
};

function readSettings(): GameSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<GameSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function detectTouch() {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
  );
}



function HeartIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="h-7 w-7 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <path d="M8 5h6v4h4V5h6v4h4v8h-4v4h-4v4h-4v4h-4v-4H8v-4H4v-4H0V9h4V5h4Z" fill="#ef233c" />
      <path d="M8 7h5v3H8v3H5v-3h3V7Z" fill="#ff7b86" opacity="0.75" />
    </svg>
  );
}

function GasIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="h-6 w-6 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <path d="M7 4h14v24H5V8h2V4Z" fill="#2bd66f" />
      <path d="M10 8h8v5h-8V8Z" fill="#caffdb" />
      <path d="M21 8h4l3 4v10h-4v-8l-3-2V8Z" fill="#1a9f52" />
      <path d="M8 22h10v3H8v-3Z" fill="#13783b" opacity="0.5" />
    </svg>
  );
}

function CoinIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="h-6 w-6 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <circle cx="16" cy="16" r="12" fill="#ffd43b" />
      <circle cx="16" cy="16" r="8" fill="#f6b800" />
      <rect x="14" y="8" width="4" height="16" fill="#fff3a3" opacity="0.8" />
    </svg>
  );
}

function BulletIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="h-6 w-6">
      <path d="M18 3h5v5h3v16h-3v5H9v-5H6V12h12V3Z" fill="#ffe66d" />
      <path d="M9 17h14v4H9v-4Z" fill="#ff4b35" />
      <path d="M18 7h3v5h-3V7Z" fill="#fff6ad" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="h-6 w-6 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <circle cx="16" cy="16" r="12" fill="none" stroke="#ff3344" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="5" fill="#ff3344" />
      <rect x="15" y="2" width="2" height="6" fill="#ff3344" />
      <rect x="15" y="24" width="2" height="6" fill="#ff3344" />
      <rect x="2" y="15" width="6" height="2" fill="#ff3344" />
      <rect x="24" y="15" width="6" height="2" fill="#ff3344" />
    </svg>
  );
}

const KeyCap = React.memo(function KeyCap({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[4px] border border-white/30 bg-white/14 px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-white shadow-[0_2px_0_rgba(0,0,0,0.25)]">
      {children}
    </span>
  );
});

function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '0 M';
  if (meters < 1000) return `${Math.round(meters)} M`;
  return `${(meters / 1000).toFixed(2)} KM`;
}

const CONTROL_HINTS: { keys: string; label: string }[] = [
  { keys: 'A / D', label: 'Yaw — rotate heading' },
  { keys: 'W / S', label: 'Thrust forward / reverse' },
  { keys: 'Q / E', label: 'Lateral strafe' },
  { keys: 'SHIFT / SPACE / CTRL', label: 'Climb / Descend' },
  { keys: 'MOUSE', label: 'Aim gun (ground cursor)' },
  { keys: 'HOLD LEFT MOUSE', label: 'Fire' },
  { keys: 'HOLD RIGHT MOUSE', label: 'Salvo target lock' },
  { keys: 'C', label: 'Flares' },
];

/** Contextual onboarding: a short fading hint sequence after each run starts.
 *  Replaces the old always-on control bar — hints never persist during combat. */
const ControlHints = React.memo(function ControlHints({ runId }: { runId: number }) {
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(false);

  // runId effect: starts the sequence at hint 0, then advances to hint 1.
  useEffect(() => {
    setIdx(0);
    setVisible(false);
    let timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
      setVisible(true);
      timeout = setTimeout(() => {
        setVisible(false);
        timeout = setTimeout(() => setIdx(1), 450);
      }, 2400);
    }, 350);
    return () => clearTimeout(timeout);
  }, [runId]);

  // idx effect: show the hint, hide it, then advance to the next (or stay
  // hidden on the last hint). Re-mounts its timers on every idx change.
  useEffect(() => {
    if (idx === 0) return;
    setVisible(true);
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        setVisible(false);
        if (idx < CONTROL_HINTS.length - 1) {
          timers.push(setTimeout(() => setIdx(idx + 1), 450));
        }
      }, 2400),
    );
    return () => timers.forEach(clearTimeout);
  }, [idx]);

  const hint = CONTROL_HINTS[idx];
  return (
    <div
      className={`pointer-events-none absolute bottom-[7.5rem] left-1/2 z-30 -translate-x-1/2 transition-opacity duration-500 ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className="hud-panel flex items-center gap-3 px-4 py-2">
        <KeyCap>{hint.keys}</KeyCap>
        <span className="text-xs font-black uppercase tracking-[0.2em] text-white/90" style={{ textShadow: '0 2px 0 rgba(0,0,0,0.55)' }}>
          {hint.label}
        </span>
      </div>
    </div>
  );
});

const Meter = React.memo(function Meter({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-3 w-20 overflow-hidden rounded-[4px] border-2 border-black/45 bg-black/35 shadow-[0_2px_0_rgba(0,0,0,0.35)] sm:w-32">
      <div className={`h-full ${color} transition-[width] duration-300`} style={{ width: `${clampPercent(value)}%` }} />
    </div>
  );
});

// --- Tactical minimap ------------------------------------------------------
// A north-up radar fed by the engine's ~12 Hz `helistrike:minimap` snapshot.
// The snapshot lives in a ref and is drawn imperatively on a canvas — no React
// re-renders, no entity objects in the UI layer.
function drawMinimap(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  snap: MinimapSnapshot | null,
) {
  const W = canvas.width;
  const H = canvas.height;
  const R = Math.min(W, H) / 2 - 8;
  const cx = W / 2;
  const cy = H / 2;
  const t = performance.now() / 1000;

  ctx.clearRect(0, 0, W, H);

  // Circular radar disc (military round-screen look)
  ctx.beginPath();
  ctx.arc(cx, cy, R + 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10, 16, 12, 0.94)';
  ctx.fill();

  // Grid rings + cross
  ctx.strokeStyle = 'rgba(80, 235, 255, 0.12)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();

  // Everything inside the disc is clipped so edge-clamped markers never
  // paint outside the round screen.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  if (!snap) {
    ctx.fillStyle = 'rgba(160, 210, 255, 0.5)';
    ctx.font = '700 13px Silkscreen, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO SIGNAL', cx, cy);
    ctx.restore();
    return;
  }

  const range = Math.max(1, snap.range);
  // North-up: world +X right, world -Z (forward) up.
  const toX = (x: number) => cx + ((x - snap.player.x) / range) * R;
  const toY = (z: number) => cy + ((z - snap.player.z) / range) * R;
  const edgeX = (dx: number, dz: number) => {
    const len = Math.hypot(dx, dz) || 1;
    return { x: cx + (dx / len) * (R - 14), y: cy + (dz / len) * (R - 14) };
  };

  // Route line: player → destination while carrying (clamped to the radar edge)
  if (snap.delivery?.carrying) {
    const d = snap.delivery.destination;
    const dx = d.x - snap.player.x;
    const dz = d.z - snap.player.z;
    const outside = Math.hypot(dx, dz) > range;
    const end = outside ? edgeX(dx, dz) : { x: toX(d.x), y: toY(d.z) };
    ctx.strokeStyle = 'rgba(85, 242, 194, 0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Delivery markers
  if (snap.delivery) {
    const origin = snap.delivery.origin;
    const dest = snap.delivery.destination;
    // Destination: bright green diamond, clamped to the edge when out of range
    const ddx = dest.x - snap.player.x;
    const ddz = dest.z - snap.player.z;
    const destOutside = Math.hypot(ddx, ddz) > range;
    const dp = destOutside ? edgeX(ddx, ddz) : { x: toX(dest.x), y: toY(dest.z) };
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dp.x, dp.y - 9);
    ctx.lineTo(dp.x + 7, dp.y);
    ctx.lineTo(dp.x, dp.y + 9);
    ctx.lineTo(dp.x - 7, dp.y);
    ctx.closePath();
    ctx.fillStyle = snap.delivery.carrying ? 'rgba(85, 242, 194, 0.95)' : 'rgba(85, 242, 194, 0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(240, 255, 250, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Origin: amber crate, only while the pickup is still relevant
    if (!snap.delivery.carrying) {
      const ox = toX(origin.x);
      const oy = toY(origin.z);
      if (Math.abs(ox - cx) <= R && Math.abs(oy - cy) <= R) {
        const pulse = 0.7 + Math.sin(t * 4.5) * 0.3;
        ctx.fillStyle = `rgba(255, 189, 63, ${pulse.toFixed(2)})`;
        ctx.fillRect(ox - 4.5, oy - 4.5, 9, 9);
        ctx.strokeStyle = 'rgba(255, 235, 170, 0.9)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(ox - 4.5, oy - 4.5, 9, 9);
      }
    }
  }

  // Objectives
  for (const o of snap.objectives) {
    const dx = o.x - snap.player.x;
    const dz = o.z - snap.player.z;
    if (Math.hypot(dx, dz) > range) continue;
    const ox = toX(o.x);
    const oy = toY(o.z);
    if (o.type === 0) {
      // SAM — red warning triangle
      ctx.beginPath();
      ctx.moveTo(ox, oy - 9);
      ctx.lineTo(ox + 8, oy + 7);
      ctx.lineTo(ox - 8, oy + 7);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 85, 102, 0.95)';
      ctx.fill();
    } else {
      // RADAR — antenna mast + dish
      ctx.strokeStyle = 'rgba(126, 224, 255, 0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ox, oy + 6);
      ctx.lineTo(ox, oy - 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ox, oy - 6, 4, Math.PI, 0);
      ctx.stroke();
    }
  }

  // Friendly extraction marker stays clamped to the radar edge.
  if (snap.extraction) {
    const dx = snap.extraction.x - snap.player.x;
    const dz = snap.extraction.z - snap.player.z;
    const dist = Math.hypot(dx, dz);
    const inRange = dist <= range;
    const ep = inRange ? { x: toX(snap.extraction.x), y: toY(snap.extraction.z) } : edgeX(dx, dz);
    // Zone radius: pulsing green circle so the landing area itself reads.
    if (inRange && snap.extraction.radius > 0) {
      const rPx = Math.max(3, (snap.extraction.radius / range) * R);
      const pulse = 0.5 + Math.sin(t * 3) * 0.15;
      ctx.beginPath();
      ctx.arc(ep.x, ep.y, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(85, 242, 162, ${pulse.toFixed(2)})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ep.x, ep.y, rPx * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = snap.extraction.active ? 'rgba(100,255,175,1)' : 'rgba(85,242,162,0.9)';
    ctx.font = '10px "Press Start 2P", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', ep.x, ep.y);
    ctx.strokeStyle = 'rgba(210,255,230,0.9)';
    ctx.strokeRect(ep.x - 8, ep.y - 8, 16, 16);
    // Pad elevation vs the player — "▲ 42m" reads as a rooftop to climb to.
    const dy = snap.extraction.elevation - (snap.player.y ?? 0);
    const dir = dy > 4 ? '▲' : dy < -4 ? '▼' : '≈';
    ctx.font = '700 8px Silkscreen, system-ui, sans-serif';
    ctx.fillStyle = dy > 4 ? 'rgba(255, 189, 63, 0.95)' : 'rgba(160, 230, 200, 0.95)';
    ctx.fillText(`${dir} ${Math.abs(Math.round(dy))}m`, ep.x, ep.y + 16);
  }

  // Enemies inside the radar radius
  for (const e of snap.enemies) {
    if (e.boss) continue;
    const dx = e.x - snap.player.x;
    const dz = e.z - snap.player.z;
    if (Math.hypot(dx, dz) > range) continue;
    const ex = toX(e.x);
    const ey = toY(e.z);
    // Variant markers override base-type icons — color/roll says "what is it".
    const v = e.variant;
    if (v === EnemyVariant.KAMIKAZE_DRONE) {
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 7));
      ctx.beginPath();
      ctx.moveTo(ex, ey - 7);
      ctx.lineTo(ex + 5.5, ey + 5);
      ctx.lineTo(ex - 5.5, ey + 5);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 34, 68, ${pulse})`;
      ctx.fill();
    } else if (v === EnemyVariant.SCOUT_DRONE) {
      ctx.beginPath();
      ctx.moveTo(ex, ey - 7);
      ctx.lineTo(ex + 3.5, ey);
      ctx.lineTo(ex, ey + 7);
      ctx.lineTo(ex - 3.5, ey);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 120, 140, 0.95)';
      ctx.fill();
    } else if (v === EnemyVariant.ATTACK_GUNSHIP || v === EnemyVariant.ROCKET_GUNSHIP || v === EnemyVariant.HEAVY_GUNSHIP) {
      const size = v === EnemyVariant.HEAVY_GUNSHIP ? 9 : v === EnemyVariant.ROCKET_GUNSHIP ? 6.5 : 6;
      ctx.beginPath();
      ctx.moveTo(ex, ey - size);
      ctx.lineTo(ex + size * 0.75, ey);
      ctx.lineTo(ex, ey + size);
      ctx.lineTo(ex - size * 0.75, ey);
      ctx.closePath();
      ctx.fillStyle = v === EnemyVariant.ROCKET_GUNSHIP ? 'rgba(255, 170, 51, 0.95)' : 'rgba(255, 90, 90, 0.95)';
      ctx.fill();
    } else if (v === EnemyVariant.MISSILE_CARRIER) {
      // Amber missile marker: slim body + fin
      ctx.fillStyle = 'rgba(255, 194, 63, 0.95)';
      ctx.fillRect(ex - 1.5, ey - 7, 3, 12);
      ctx.beginPath();
      ctx.moveTo(ex, ey - 7);
      ctx.lineTo(ex - 5, ey - 3.5);
      ctx.lineTo(ex + 5, ey - 3.5);
      ctx.closePath();
      ctx.fill();
    } else if (v === EnemyVariant.FLAK_TANK || v === EnemyVariant.SIEGE_TANK) {
      const size = v === EnemyVariant.SIEGE_TANK ? 9 : 6;
      ctx.fillStyle = 'rgba(255, 120, 60, 0.95)';
      ctx.fillRect(ex - size * 0.5, ey - size * 0.5, size, size);
      ctx.fillStyle = 'rgba(255, 60, 60, 0.95)';
      ctx.beginPath();
      ctx.arc(ex, ey, 1.8, 0, Math.PI * 2);
      ctx.fill();
    } else if (v === EnemyVariant.SHIELD_DRONE) {
      ctx.beginPath();
      ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(85, 238, 255, 0.95)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex, ey, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 60, 60, 0.95)';
      ctx.fill();
    } else if (v === EnemyVariant.REPAIR_DRONE) {
      ctx.beginPath();
      ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(85, 255, 153, 0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(85, 255, 153, 0.95)';
      ctx.fill();
    } else if (v === EnemyVariant.INTERCEPTOR) {
      // Blue swept arrow — fast pass threat
      ctx.beginPath();
      ctx.moveTo(ex, ey - 7);
      ctx.lineTo(ex + 5, ey + 5);
      ctx.lineTo(ex, ey + 2);
      ctx.lineTo(ex - 5, ey + 5);
      ctx.closePath();
      ctx.fillStyle = 'rgba(85, 170, 255, 0.95)';
      ctx.fill();
    } else if (v === EnemyVariant.MINELAYER) {
      // Pink diamond — mine hazard
      ctx.beginPath();
      ctx.moveTo(ex, ey - 6);
      ctx.lineTo(ex + 5, ey);
      ctx.lineTo(ex, ey + 6);
      ctx.lineTo(ex - 5, ey);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 68, 170, 0.95)';
      ctx.fill();
    } else if (v === EnemyVariant.GATLING_HEAVY) {
      // Heavy yellow square — armored suppressor
      ctx.fillStyle = 'rgba(255, 217, 46, 0.95)';
      ctx.fillRect(ex - 4.5, ey - 4.5, 9, 9);
      ctx.fillStyle = 'rgba(60, 40, 10, 0.95)';
      ctx.fillRect(ex - 1.5, ey - 1.5, 3, 3);
    } else if (e.type === 1) {
      ctx.beginPath();
      ctx.moveTo(ex, ey - 6);
      ctx.lineTo(ex + 4.5, ey);
      ctx.lineTo(ex, ey + 6);
      ctx.lineTo(ex - 4.5, ey);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 80, 80, 0.95)';
      ctx.fill();
    } else if (e.type === 2) {
      ctx.fillStyle = 'rgba(255, 80, 80, 0.95)';
      ctx.fillRect(ex - 3.5, ey - 3.5, 7, 7);
    } else if (e.type === 3) {
      ctx.beginPath();
      ctx.moveTo(ex, ey - 6);
      ctx.lineTo(ex + 5, ey + 4);
      ctx.lineTo(ex - 5, ey + 4);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 120, 120, 0.95)';
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255, 70, 70, 0.9)';
      ctx.beginPath();
      ctx.arc(ex, ey, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (e.elite) {
      ctx.strokeStyle = 'rgba(255, 170, 60, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ex, ey, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (e.priority) {
      const pulse = 0.7 + Math.sin(t * 8) * 0.3;
      ctx.strokeStyle = `rgba(255, 215, 0, ${pulse.toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(ex - 7, ey - 7, 14, 14);
      ctx.beginPath();
      ctx.arc(ex, ey, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Repaint SAMs above normal contacts and reveal the envelope only while engaged.
  for (const o of snap.objectives) {
    if (o.type !== 0) continue;
    const dx = o.x - snap.player.x;
    const dz = o.z - snap.player.z;
    const dist = Math.hypot(dx, dz);
    if (dist > range) continue;
    const ox = toX(o.x);
    const oy = toY(o.z);
    const engaged = o.samState === 'TRACKING' || o.samState === 'LOCKING' || o.samState === 'FIRING';
    if (engaged && o.detectionRange) {
      ctx.beginPath();
      ctx.arc(ox, oy, Math.min(R, (o.detectionRange / range) * R), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 77, 62, 0.045)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 105, 70, 0.16)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const lockPulse = o.samState === 'LOCKING' ? 0.58 + Math.abs(Math.sin(t * 9)) * 0.42 : 0.9;
    ctx.beginPath();
    ctx.moveTo(ox, oy - 10);
    ctx.lineTo(ox + 9, oy + 8);
    ctx.lineTo(ox - 9, oy + 8);
    ctx.closePath();
    ctx.fillStyle = o.samState === 'RELOADING'
      ? 'rgba(255, 174, 70, 0.72)'
      : `rgba(255, 65, 82, ${lockPulse})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 235, 210, 0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (const threat of snap.threats) {
    const dx = threat.x - snap.player.x;
    const dz = threat.z - snap.player.z;
    const dist = Math.hypot(dx, dz);
    const mp = dist > range ? edgeX(dx, dz) : { x: toX(threat.x), y: toY(threat.z) };
    ctx.save();
    ctx.translate(mp.x, mp.y);
    ctx.rotate(Math.atan2(dx, -dz));
    ctx.fillStyle = threat.target === 'DECOY' ? 'rgba(130, 220, 190, 0.9)' : 'rgba(255, 153, 45, 0.98)';
    ctx.fillRect(-1.8, -7, 3.6, 12);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(4.5, -4);
    ctx.lineTo(-4.5, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // The active mission target is repainted over ordinary contacts. A pulsing
  // cyan diamond is readable at a glance and remains clamped when off-screen.
  if (snap.mission) {
    const dx = snap.mission.x - snap.player.x;
    const dz = snap.mission.z - snap.player.z;
    const dist = Math.hypot(dx, dz);
    const mp = dist > range ? edgeX(dx, dz) : { x: toX(snap.mission.x), y: toY(snap.mission.z) };
    const size = 9 + Math.sin(t * 4.5) * 1.5;
    ctx.beginPath();
    ctx.moveTo(mp.x, mp.y - size);
    ctx.lineTo(mp.x + size, mp.y);
    ctx.lineTo(mp.x, mp.y + size);
    ctx.lineTo(mp.x - size, mp.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(20, 40, 55, 0.8)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(80, 235, 255, 0.98)';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 230, 109, 0.98)';
    ctx.font = '7px "Press Start 2P", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', mp.x, mp.y + 0.5);
  }

  // Boss — large crimson ring, clamped to the edge if far away
  for (const e of snap.enemies) {
    if (!e.boss) continue;
    const dx = e.x - snap.player.x;
    const dz = e.z - snap.player.z;
    const dist = Math.hypot(dx, dz);
    const bp = dist > range ? edgeX(dx, dz) : { x: toX(e.x), y: toY(e.z) };
    const pulse = 1 + Math.sin(t * 3) * 0.12;
    ctx.strokeStyle = 'rgba(255, 60, 80, 0.95)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, 11 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 60, 80, 0.9)';
    ctx.fill();
  }

  // Camera Viewing Cone (tactical radar view frustum)
  if (snap.player.cameraYaw !== undefined) {
    const camAngle = snap.player.cameraYaw;
    const fovHalf = (52 * Math.PI / 180) * 0.5;
    const coneLen = R * 0.72;
    const midAngle = -Math.PI / 2 + camAngle;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, coneLen, midAngle - fovHalf, midAngle + fovHalf);
    ctx.closePath();
    ctx.fillStyle = 'rgba(80, 235, 255, 0.07)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(80, 235, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Player — centered heading arrow (body heading only; gun aim never affects it).
  // The engine sets heading = atan2(velocity.x, velocity.z), so the nose points
  // along world (sin h, cos h). North-up (screen up = world -Z) then needs a
  // canvas rotation of PI - h: forward (-Z, h=PI) points up, strafe right (+X,
  // h=PI/2) points right.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI - snap.player.heading);
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(8, 9);
  ctx.lineTo(0, 5);
  ctx.lineTo(-8, 9);
  ctx.closePath();
  ctx.fillStyle = 'rgba(110, 235, 255, 0.95)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(240, 255, 255, 0.95)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore(); // end circular clip

  // Tactical radar bezel ring + compass tick
  ctx.beginPath();
  ctx.arc(cx, cy, R + 3, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(80, 235, 255, 0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(80, 235, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(125, 249, 255, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy - R - 1);
  ctx.lineTo(cx + 4, cy - R - 1);
  ctx.stroke();
  ctx.fillStyle = 'rgba(125, 249, 255, 0.95)';
  ctx.font = '700 11px Oxanium, "Chakra Petch", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - R - 8);
}

function MinimapPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapRef = useRef<MinimapSnapshot | null>(null);

  useEffect(() => {
    const onMinimap = (e: Event) => {
      snapRef.current = (e as CustomEvent<MinimapSnapshot>).detail;
    };
    window.addEventListener('helistrike:minimap', onMinimap);
    return () => window.removeEventListener('helistrike:minimap', onMinimap);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      drawMinimap(ctx, canvas, snapRef.current);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="pointer-events-none">
      <canvas
        ref={canvasRef}
        width={380}
        height={380}
        className="block"
        style={{ width: 'clamp(165px, 14vw, 215px)', height: 'clamp(165px, 14vw, 215px)' }}
        aria-label="Tactical minimap"
      />
    </div>
  );
}

const MenuButton = React.memo(function MenuButton({
  children,
  onClick,
  secondary,
  danger,
  size = 'md',
}: {
  children: ReactNode;
  onClick: () => void;
  secondary?: boolean;
  danger?: boolean;
  size?: 'md' | 'sm' | 'lg';
}) {
  const sizing =
    size === 'sm'
      ? 'mil-btn-sm min-w-28 sm:flex-1 sm:min-w-0'
      : size === 'lg'
        ? 'mil-btn-lg min-w-56'
        : 'min-w-44';
  const variant = danger
    ? 'mil-btn-danger'
    : secondary
      ? 'mil-btn-secondary'
      : 'mil-btn-primary';
  return (
    <button
      className={`pointer-events-auto mil-btn ${variant} ${sizing}`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
});

const DifficultyChip = React.memo(function DifficultyChip({ difficulty }: { difficulty: GameSettings['difficulty'] }) {
  const info = DIFFICULTY_INFO[difficulty];
  const tone =
    difficulty === 'casual'
      ? 'border-[#58a72b] text-[#7de04a] bg-[#1a2e10]'
      : difficulty === 'hard'
        ? 'border-[#d32f2f] text-[#ff6666] bg-[#3a0d0d]'
        : 'border-[#f5ba2c] text-[#ffd766] bg-[#332205]';
  const multiplier =
    difficulty === 'casual' ? '1.0×' : difficulty === 'hard' ? '2.0×' : '1.5×';
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2.5 py-0.5 text-[10px] font-military tracking-[0.14em] rounded-[3px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)] ${tone}`}>
      {difficulty === 'hard' ? (
        <Skull size={11} className="text-[#ff6666]" />
      ) : difficulty === 'casual' ? (
        <Shield size={11} className="text-[#7de04a]" />
      ) : (
        <Crosshair size={11} className="text-[#ffd766]" />
      )}
      <span>{info.name}</span>
      <span className="opacity-80">({multiplier} CR)</span>
    </span>
  );
});

const HERO_AIRCRAFT_TELEMETRY: Record<
  HelicopterModel,
  {
    designation: string;
    codename: string;
    role: string;
    airframe: string;
    armament: string;
    avionics: string;
    powerplant: string;
    threatRating: string;
    accentColor: string;
  }
> = {
  [HelicopterModel.APACHE]: {
    designation: 'AH-64D',
    codename: 'LONGBOW',
    role: 'HEAVY ATTACK GUNSHIP',
    airframe: 'TITANIUM ARMORED AIRFRAME',
    armament: '30MM M230 CHAIN GUN · AGM-114 HELLFIRE',
    avionics: 'AN/APG-78 RADAR · TADS/PNVS',
    powerplant: 'TWIN T700-GE-701D · 3,780 SHP',
    threatRating: 'HEAVY ASSAULT CLEARANCE',
    accentColor: '#ffcc00',
  },
  [HelicopterModel.NIGHTHAWK]: {
    designation: 'AH-1Z',
    codename: 'VIPER',
    role: 'TACTICAL PENETRATION STRIKE',
    airframe: 'COMPOSITE HIGH-G MANEUVER FRAME',
    armament: '20MM M197 3-BARREL GATLING · AIM-9',
    avionics: 'TARGET SIGHT SYSTEM (TSS) · DIGITAL COCKPIT',
    powerplant: 'TWIN T700-GE-401C · 3,600 SHP',
    threatRating: 'HIGH SPEED INTERCEPT',
    accentColor: '#50ebff',
  },
  [HelicopterModel.WARLOCK]: {
    designation: 'RAH-66',
    codename: 'COMANCHE',
    role: 'STEALTH RECONNAISSANCE ASSAULT',
    airframe: 'RADAR-ABSORBENT FACETED HULL',
    armament: '20MM XM301 GATLING · INTERNAL BAY HELLFIRE',
    avionics: 'HELMET-INTEGRATED COMBAT AVIONICS',
    powerplant: 'TWIN T800-LHT-801 · 3,128 SHP · FANTAL',
    threatRating: 'STEALTH PENETRATION',
    accentColor: '#8df578',
  },
};

function HeroHelicopterViewport({ playerModel }: { playerModel: HelicopterModel }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const mousePosRef = useRef({ x: 0, y: 0 });
  const telemetry = HERO_AIRCRAFT_TELEMETRY[playerModel] ?? HERO_AIRCRAFT_TELEMETRY[HelicopterModel.APACHE];

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    const scene = new THREE.Scene();
    // 34-degree FOV for cinematic compression and hero silhouette
    const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
    // Camera placed slightly higher, looking at center-left so helicopter renders on the right (x ≈ 48% → 93%)
    camera.position.set(7.4, 3.2, 9.8);
    camera.lookAt(-0.6, -0.1, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.appendChild(renderer.domElement);

    // Rich tactical multi-point lighting
    const ambientLight = new THREE.AmbientLight(0x35442b, 1.6);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xfff5dd, 2.8);
    keyLight.position.set(12, 16, 10);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x50ebff, 2.4);
    rimLight.position.set(-14, 8, -12);
    scene.add(rimLight);

    const fillLight = new THREE.DirectionalLight(0x40ef80, 0.9);
    fillLight.position.set(0, -6, 12);
    scene.add(fillLight);

    // Tactical ground projection circles
    const ringGeo = new THREE.RingGeometry(3.6, 3.7, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x4d6633,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });
    const groundRing = new THREE.Mesh(ringGeo, ringMat);
    groundRing.position.y = -1.4;
    scene.add(groundRing);

    const innerRingGeo = new THREE.RingGeometry(1.6, 1.65, 32);
    innerRingGeo.rotateX(-Math.PI / 2);
    const innerRingMat = new THREE.MeshBasicMaterial({
      color: 0xffcc00,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
    });
    const innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
    innerRing.position.y = -1.4;
    scene.add(innerRing);

    // Build the 3D Helicopter
    const world = new CANNON.World();
    const heli = new Helicopter(scene, world, playerModel);
    // Scale hero visual size down 28% (range 25-35%) as requested
    heli.mesh.scale.set(0.72, 0.72, 0.72);
    heli.mesh.position.set(0, 0, 0);
    heli.mesh.rotation.y = -0.58; // Dynamic 3/4 combat angle facing left-forward
    heli.mesh.rotation.z = -0.04;
    heli.mesh.rotation.x = 0.03;

    let rafId = 0;
    const startTime = performance.now();

    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      mousePosRef.current = { x: ndcX, y: ndcY };
    };

    window.addEventListener('mousemove', handleMouseMove);

    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const elapsed = (performance.now() - startTime) * 0.001;

      // Rotor animations
      if (heli.mainRotor) heli.mainRotor.rotation.y += 0.42;
      if (heli.tailRotor) heli.tailRotor.rotation.x += 0.58;

      // Gentle idle hovering physics
      const hoverY = Math.sin(elapsed * 1.5) * 0.14;
      const hoverRoll = Math.sin(elapsed * 1.1) * 0.025;
      const hoverPitch = Math.cos(elapsed * 0.9) * 0.02;

      // Mouse parallax damping
      const mouse = mousePosRef.current;
      const targetRotY = -0.58 + mouse.x * 0.22;
      const targetRotX = 0.03 + hoverPitch - mouse.y * 0.10;
      const targetRotZ = -0.04 + hoverRoll + mouse.x * 0.05;

      heli.mesh.position.y = hoverY;
      heli.mesh.rotation.y += (targetRotY - heli.mesh.rotation.y) * 0.08;
      heli.mesh.rotation.x += (targetRotX - heli.mesh.rotation.x) * 0.08;
      heli.mesh.rotation.z += (targetRotZ - heli.mesh.rotation.z) * 0.08;

      groundRing.rotation.y = elapsed * 0.08;
      innerRing.rotation.y = -elapsed * 0.12;

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
      scene.clear();
    };
  }, [playerModel]);

  return (
    <div className="relative w-full h-full flex items-center justify-center pointer-events-none select-none">
      {/* 3D WebGL Canvas Container */}
      <div ref={mountRef} className="absolute inset-0 w-full h-full" />

      {/* Bottom-Right Aircraft Telemetry Card (Hero Zone) */}
      <div className="aircraft-telemetry-badge">
        <div className="flex items-center justify-between gap-3 border-b border-[#2d3822] pb-1.5 mb-1.5">
          <div className="flex items-center gap-1.5 text-[9px] font-military tracking-[0.2em] text-[#ffcc00]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#6ee740] shadow-[0_0_6px_#6ee740] animate-pulse" />
            <span>READY FOR SORTIE</span>
          </div>
          <span className="text-[9px] font-tech text-[#8e9985] tracking-widest">
            {telemetry.designation}
          </span>
        </div>

        <div className="font-display text-xl sm:text-2xl text-white tracking-wider leading-none drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
          {telemetry.codename}
        </div>
        <div className="text-[10px] font-military tracking-[0.14em] text-[#8df578] mt-0.5">
          {telemetry.role}
        </div>

        <div className="mt-2 pt-1.5 border-t border-[#2d3822] grid grid-cols-1 gap-0.5 text-[9px] font-tech text-[#8e9985]">
          <div><span className="text-[#5b6652]">ARMAMENT:</span> <span className="text-[#ded6be]">{telemetry.armament}</span></div>
          <div><span className="text-[#5b6652]">AIRFRAME:</span> <span className="text-[#ded6be]">{telemetry.airframe}</span></div>
        </div>
      </div>
    </div>
  );
}

function ThreeDMenu({
  mode,
  score,
  highScore,
  wave,
  isNewBest,
  stats,
  history,
  difficulty,
  credits,
  isNewPilot,
  playerModel = HelicopterModel.APACHE,
  onStart,
  onSettings,
  onHangar,
  onHelp,
  onMenu,
  onUiSound,
  onUiHover,
}: {
  mode: GameMode;
  score: number;
  highScore: number;
  wave: number;
  isNewBest: boolean;
  stats: RunStats | null;
  history: RunRecord[];
  difficulty: GameSettings['difficulty'];
  credits: number;
  isNewPilot: boolean;
  playerModel?: HelicopterModel;
  onStart: () => void;
  onSettings: () => void;
  onHangar: () => void;
  onHelp: () => void;
  onMenu: () => void;
  onUiSound: () => void;
  onUiHover?: () => void;
}) {
  const isGameOver = mode === 'gameover';
  const [copied, setCopied] = useState<'idle' | 'ok' | 'err'>('idle');
  const [showDetails, setShowDetails] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Keyboard navigation on main menu
  useEffect(() => {
    if (isGameOver) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'ArrowUp' || e.key === 'KeyW') {
        e.preventDefault();
        setFocusedIndex((prev) => (prev > 0 ? prev - 1 : 3));
        onUiHover?.();
      } else if (e.key === 'ArrowDown' || e.key === 'KeyS') {
        e.preventDefault();
        setFocusedIndex((prev) => (prev < 3 ? prev + 1 : 0));
        onUiHover?.();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onUiSound();
        if (focusedIndex === 0) onStart();
        else if (focusedIndex === 1) onHangar();
        else if (focusedIndex === 2) onSettings();
        else if (focusedIndex === 3) onHelp();
      } else if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        onUiSound();
        onHangar();
      } else if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        onUiSound();
        onSettings();
      } else if (e.key.toLowerCase() === 'm' || e.key === 'F1') {
        e.preventDefault();
        onUiSound();
        onHelp();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isGameOver, focusedIndex, onStart, onHangar, onSettings, onHelp, onUiSound, onUiHover]);

  // Gamepad polling on menu
  useEffect(() => {
    if (isGameOver) return;
    let prevButtons: boolean[] = [];
    let raf = 0;

    const pollGamepad = () => {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = gamepads[0] || gamepads[1];
      if (gp) {
        const dpadUp = gp.buttons[12]?.pressed || gp.axes[1] < -0.5;
        const dpadDown = gp.buttons[13]?.pressed || gp.axes[1] > 0.5;
        const btnA = gp.buttons[0]?.pressed;
        const btnStart = gp.buttons[9]?.pressed;

        if (dpadUp && !prevButtons[12]) {
          setFocusedIndex((p) => (p > 0 ? p - 1 : 3));
          onUiHover?.();
        } else if (dpadDown && !prevButtons[13]) {
          setFocusedIndex((p) => (p < 3 ? p + 1 : 0));
          onUiHover?.();
        } else if ((btnA && !prevButtons[0]) || (btnStart && !prevButtons[9])) {
          onUiSound();
          if (focusedIndex === 0) onStart();
          else if (focusedIndex === 1) onHangar();
          else if (focusedIndex === 2) onSettings();
          else if (focusedIndex === 3) onHelp();
        }

        prevButtons = [
          Boolean(btnA),
          false, false, false, false, false, false, false, false,
          Boolean(btnStart),
          false, false,
          Boolean(dpadUp),
          Boolean(dpadDown),
          false,
          false,
        ];
      }
      raf = requestAnimationFrame(pollGamepad);
    };

    raf = requestAnimationFrame(pollGamepad);
    return () => cancelAnimationFrame(raf);
  }, [isGameOver, focusedIndex, onStart, onHangar, onSettings, onHelp, onUiSound, onUiHover]);

  const copyScorecard = async () => {
    const latest = history[0];
    if (!latest) return;
    try {
      await navigator.clipboard.writeText(formatScorecard(latest, highScore));
      setCopied('ok');
    } catch {
      setCopied('err');
    }
    window.setTimeout(() => setCopied('idle'), 2400);
  };

  const runRewards = (stats?.combatPay ?? 0) + (stats?.achievementCredits ?? 0);

  const calcGrade = (s?: RunStats | null, sc: number = 0) => {
    const w = s?.wave ?? wave;
    const acc = s?.accuracy ?? 0;
    const ext = s?.status === 'EXTRACTED';
    if (ext && (w >= 6 || sc >= 20000) && acc >= 0.45) return { rank: 'S+', title: 'ACE COMMANDER', color: '#ffd700', border: 'border-[#ffcc00]', bg: 'bg-[#332205]' };
    if ((w >= 4 || sc >= 10000) && acc >= 0.35) return { rank: 'A', title: 'DISTINGUISHED', color: '#8df578', border: 'border-[#58a72b]', bg: 'bg-[#102e14]' };
    if (w >= 2 || sc >= 4000) return { rank: 'B', title: 'COMBAT QUALIFIED', color: '#50ebff', border: 'border-[#00e5ff]', bg: 'bg-[#082533]' };
    return { rank: 'C', title: 'TRAINING GRADE', color: '#ffa726', border: 'border-[#ff7700]', bg: 'bg-[#2b1404]' };
  };
  const missionGrade = isGameOver ? calcGrade(stats, score) : null;

  if (!isGameOver) {
    return (
      <div className="pointer-events-auto absolute inset-0 z-40 flex overflow-hidden select-none">
        {/* Fullscreen Backdrop Split Gradient (Left 30% dark -> Middle haze -> Right visible city) */}
        <div className="menu-backdrop-split" />

        {/* Left 25–30% Tactical Operations Console */}
        <div className="menu-left-zone">
          {/* 1. Header / Logo Block */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[10px] font-military tracking-[0.24em] text-[#ffcc00]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#ffcc00] shadow-[0_0_8px_#ffcc00] animate-pulse" />
              <span>TACTICAL AIR COMBAT</span>
            </div>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-display tracking-wider text-white drop-shadow-[0_4px_20px_rgba(0,0,0,0.9)] leading-none my-0.5">
              HELI-STRIKE
            </h1>
            <div className="text-[10px] font-military tracking-[0.18em] text-[#8e9985]">
              SURVIVAL ARCADE SHOOTER
            </div>
          </div>

          {/* 2. Vertical Menu Options */}
          <div className="flex flex-col gap-2 my-auto" role="menu" aria-label="Main Menu">
            {/* Hero Deploy CTA Button */}
            <button
              type="button"
              onClick={() => { onUiSound(); onStart(); }}
              onMouseEnter={() => { setFocusedIndex(0); onUiHover?.(); }}
              className={`mil-btn-hero ${focusedIndex === 0 ? 'is-nav-focused' : ''}`}
            >
              <span className="flex items-center gap-2.5">
                <Play size={18} className="fill-current text-[#120e00]" />
                <span>DEPLOY (ENTER)</span>
              </span>
            </button>

            {/* Integrated Threat Level */}
            <div className="flex items-center justify-between px-3 py-2 bg-[#12160f]/80 border border-[#2d3822] rounded-[3px] text-xs">
              <span className="font-hud font-bold text-[#8e9985] tracking-wider text-[10px]">
                THREAT LEVEL
              </span>
              <DifficultyChip difficulty={difficulty} />
            </div>

            {/* Secondary Navigation Rows */}
            <button
              type="button"
              onClick={() => { onUiSound(); onHangar(); }}
              onMouseEnter={() => { setFocusedIndex(1); onUiHover?.(); }}
              className={`menu-row-btn ${focusedIndex === 1 ? 'is-nav-focused' : ''}`}
            >
              <div className="flex items-center gap-2.5 text-xs font-military text-[#ded6be]">
                <Wrench size={14} className="text-[#ffcc00]" />
                <span>HANGAR & ARMORY</span>
                {isNewPilot && (
                  <span className="h-1.5 w-1.5 rounded-full bg-[#ffcc00] animate-ping" />
                )}
              </div>
              <span className="text-[9px] font-tech text-[#717d68]">[H]</span>
            </button>

            <button
              type="button"
              onClick={() => { onUiSound(); onSettings(); }}
              onMouseEnter={() => { setFocusedIndex(2); onUiHover?.(); }}
              className={`menu-row-btn ${focusedIndex === 2 ? 'is-nav-focused' : ''}`}
            >
              <div className="flex items-center gap-2.5 text-xs font-military text-[#ded6be]">
                <Sliders size={14} className="text-[#8df578]" />
                <span>SETTINGS</span>
              </div>
              <span className="text-[9px] font-tech text-[#717d68]">[O]</span>
            </button>

            <button
              type="button"
              onClick={() => { onUiSound(); onHelp(); }}
              onMouseEnter={() => { setFocusedIndex(3); onUiHover?.(); }}
              className={`menu-row-btn ${focusedIndex === 3 ? 'is-nav-focused' : ''}`}
            >
              <div className="flex items-center gap-2.5 text-xs font-military text-[#ded6be]">
                <BookOpen size={14} className="text-[#50ebff]" />
                <span>MANUAL & CONTROLS</span>
              </div>
              <span className="text-[9px] font-tech text-[#717d68]">[M]</span>
            </button>
          </div>

          {/* 3. Stats & Guidance on Grid */}
          <div className="flex flex-col gap-2">
            {isNewPilot && (
              <div className="px-3 py-1.5 rounded-[3px] flex items-center gap-2 text-[10px] font-bold tracking-wider text-[#9df578] border border-[#58a72b]/50 bg-[#142612]/80">
                <Sparkles size={11} className="text-[#ffcc00] shrink-0 animate-spin" />
                <span>Starter credits ready — open Hangar to equip</span>
              </div>
            )}

            {/* High Score / Credits / Sortie Minimalist Bar */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-[#12160f]/80 border border-[#2d3822] rounded-[3px] p-1.5 flex flex-col items-center">
                <span className="text-[8.5px] font-military tracking-wider text-[#717d68] flex items-center gap-1">
                  <Trophy size={10} className="text-[#50ebff]" /> BEST
                </span>
                <strong className="text-sm font-tech font-bold text-[#50ebff] mt-0.5">
                  {highScore.toLocaleString()}
                </strong>
              </div>

              <div className="bg-[#12160f]/80 border border-[#2d3822] rounded-[3px] p-1.5 flex flex-col items-center">
                <span className="text-[8.5px] font-military tracking-wider text-[#717d68] flex items-center gap-1">
                  <Coins size={10} className="text-[#ffd700]" /> CREDITS
                </span>
                <strong className="text-sm font-tech font-bold text-[#ffd700] mt-0.5">
                  {credits.toLocaleString()}
                </strong>
              </div>

              <div className="bg-[#12160f]/80 border border-[#2d3822] rounded-[3px] p-1.5 flex flex-col items-center">
                <span className="text-[8.5px] font-military tracking-wider text-[#717d68] flex items-center gap-1">
                  <Crosshair size={10} className="text-[#8df578]" /> SORTIE
                </span>
                <strong className="text-sm font-tech font-bold text-[#8df578] mt-0.5">
                  {wave > 0 ? `WAVE ${wave}` : '—'}
                </strong>
              </div>
            </div>

            {/* Footer Navigation Hints */}
            <div className="flex items-center justify-between text-[9px] font-tech text-[#717d68] tracking-wider pt-1 border-t border-[#1f2818]">
              <span>v1.4.0</span>
              <span>[W / S / ↑ / ↓] NAVIGATE</span>
            </div>
          </div>
        </div>

        {/* Hero Helicopter 3D Zone (Taking Right 58vw) */}
        <div className="absolute top-0 bottom-0 right-0 w-[58vw] pointer-events-none">
          <HeroHelicopterViewport playerModel={playerModel} />
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-black/80 px-3 py-4 backdrop-blur-[6px]">
      <div className="w-[min(460px,calc(100vw-32px))] bg-[#0c100a]/92 border border-[#2d3822] rounded-lg p-5 sm:p-6 shadow-[0_16px_48px_rgba(0,0,0,0.9)] animate-in fade-in zoom-in-95 duration-150">
        <div className="menu-title-block text-center">
          <div className="flex items-center justify-center gap-2 text-[10px] font-military tracking-[0.24em] text-[#ffcc00] text-center w-full">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ffcc00] shadow-[0_0_8px_#ffcc00]" />
            <span>AFTER ACTION REPORT</span>
            <span className="h-1.5 w-1.5 rounded-full bg-[#ffcc00] shadow-[0_0_8px_#ffcc00]" />
          </div>
          <h2 className={`my-1 text-center w-full text-2xl sm:text-3xl font-display tracking-wider ${stats?.status === 'EXTRACTED' ? 'text-[#8df578]' : 'text-[#ff4444]'}`}>
            {stats?.status === 'EXTRACTED' ? 'MISSION ACCOMPLISHED' : 'AIRCRAFT DESTROYED'}
          </h2>
          <div className="text-[10px] font-military tracking-[0.18em] text-[#8e9985] text-center w-full">
            {stats?.status === 'EXTRACTED' ? 'TACTICAL EXTRACTION SUCCESSFUL' : 'HULL INTEGRITY COMPROMISED'}
          </div>
        </div>

              {stats?.status === 'EXTRACTED' ? (
                <div className="mt-3 border border-[#58a72b] bg-[#1a2e10] px-3 py-1.5 text-center text-[11px] font-military tracking-[0.14em] text-[#8df578]">
                  ✔ CLEAN EXTRACTION — ALL COMBAT PAY & SALVAGE SECURED
                </div>
              ) : stats?.causeOfDeath ? (
                <div className="mt-3 border border-[#b71c1c] bg-[#3a0d0d] px-3 py-1.5 text-center">
                  <span className="text-[10px] font-military tracking-[0.2em] text-[#ff8a8a]">DESTROYED BY: </span>
                  <span className="text-xs font-military tracking-[0.12em] text-[#ffffff]">{stats.causeOfDeath}</span>
                </div>
              ) : null}

              <div className="mt-3 flex items-center justify-center gap-3">
                <div className="flex-1 text-center">
                  <div className="mil-label">FINAL SCORE</div>
                  <div className="arcade-title-lg my-0.5 text-[#ffcc00]">{score.toLocaleString()}</div>
                </div>
                {missionGrade && (
                  <div className={`px-3 py-1.5 rounded-[2px] border ${missionGrade.border} ${missionGrade.bg} flex flex-col items-center justify-center shadow-[0_0_12px_rgba(0,0,0,0.6)] min-w-[100px]`}>
                    <span className="text-[9px] font-hud font-bold text-[#ded6be] tracking-wider leading-none">RANK</span>
                    <span className="font-display text-2xl font-black leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] mt-0.5" style={{ color: missionGrade.color }}>
                      {missionGrade.rank}
                    </span>
                    <span className="text-[8px] font-military tracking-wider text-[#a89d7c] mt-0.5 whitespace-nowrap">
                      {missionGrade.title}
                    </span>
                  </div>
                )}
              </div>

              {isNewBest && (
                <div className="mt-1 border border-[#ffcc00] bg-[#3d2f05] px-4 py-1.5 text-center text-xs font-military tracking-[0.16em] text-[#ffea80] shadow-[0_0_12px_rgba(255,204,0,0.3)]">
                  ★ NEW PERSONAL RECORD ★
                </div>
              )}

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="menu-stat-card">
                  <span className="menu-stat-label">WAVE</span>
                  <strong className="menu-stat-val">{stats?.wave ?? wave}</strong>
                </div>
                <div className="menu-stat-card">
                  <span className="menu-stat-label">COMBAT TIME</span>
                  <strong className="menu-stat-val text-sm mt-1">{formatDuration(stats?.time ?? 0)}</strong>
                </div>
                <div className="menu-stat-card">
                  <span className="menu-stat-label">HOSTILES</span>
                  <strong className="menu-stat-val">{stats?.kills ?? 0}</strong>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-center">
                <div className="menu-stat-card menu-stat-card-gold">
                  <span className="menu-stat-label">CREDITS</span>
                  <strong className="menu-stat-val text-[#ffd700]">{(stats?.credits ?? credits).toLocaleString()}</strong>
                </div>
                <div className="menu-stat-card">
                  <span className="menu-stat-label">ACCURACY</span>
                  <strong className="menu-stat-val">{Math.round((stats?.accuracy ?? 0) * 100)}%</strong>
                </div>
              </div>

              {stats && runRewards > 0 && (
                <div className="mt-3 mil-panel px-3 py-2">
                  <div className="flex items-center justify-between text-[11px] font-military tracking-[0.18em] text-[#ffcc00]">
                    <span>RUN REWARDS</span>
                    <span>+{runRewards} CR</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-bold uppercase tracking-wider text-[#ded6be]">
                    <span>Combat pay +{stats.combatPay ?? 0}</span>
                    {(stats.achievementLabels ?? []).map((a) => (
                      <span key={a} className="text-[#8df578]">★ {a}</span>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex justify-center">
                <MenuButton size="lg" onClick={() => { onUiSound(); onStart(); }}>REDEPLOY (ENTER)</MenuButton>
              </div>
              <div className="mt-2.5 flex flex-wrap justify-center gap-2.5">
                <MenuButton size="sm" secondary onClick={() => { onUiSound(); onHangar(); }}>HANGAR</MenuButton>
                <MenuButton size="sm" secondary onClick={() => { onUiSound(); onMenu(); }}>MAIN MENU</MenuButton>
              </div>

              <button
                type="button"
                onClick={() => { onUiSound(); setShowDetails((v) => !v); }}
                aria-expanded={showDetails}
                className="mt-3 w-full mil-btn mil-btn-secondary py-1 text-[10px] tracking-[0.18em]"
              >
                {showDetails ? '▲ HIDE COMBAT LOG' : '▼ COMBAT LOG & STATS'}
              </button>

              {showDetails && stats && (
                <div className="mt-2">
                  <div className="grid grid-cols-3 gap-1.5 text-center sm:grid-cols-4">
                    <div className="run-stat"><span>KILLS</span><strong>{stats.kills}</strong></div>
                    <div className="run-stat"><span>ACCURACY</span><strong>{Math.round(stats.accuracy * 100)}%</strong></div>
                    <div className="run-stat"><span>MAX COMBO</span><strong>{stats.maxCombo}x</strong></div>
                    <div className="run-stat"><span>THREAT</span><strong>{stats.threatLevel ?? 1}</strong></div>
                    <div className="run-stat"><span>CARGO</span><strong>{stats.deliveries ?? 0}</strong></div>
                    <div className="run-stat"><span>SAM SITES</span><strong>{stats.samSitesDestroyed ?? 0}</strong></div>
                    <div className="run-stat"><span>RADARS</span><strong>{stats.radarSitesDestroyed ?? 0}</strong></div>
                    <div className="run-stat"><span>BOSSES</span><strong>{stats.bossesDestroyed ?? 0}</strong></div>
                    <div className="run-stat"><span>MISSIONS</span><strong>{stats.missionsCompleted ?? 0}</strong></div>
                    <div className="run-stat"><span>BONUSES</span><strong>{stats.missionBonusesCompleted ?? 0}</strong></div>
                    <div className="run-stat"><span>SALVAGE</span><strong>{stats.salvage ?? 0}</strong></div>
                    <div className="run-stat">
                      <span>{stats.status === 'EXTRACTED' ? 'BONUS GAIN' : 'BONUS LOST'}</span>
                      <strong className={stats.status === 'EXTRACTED' ? 'text-[#8df578]' : 'text-[#ff6666]'}>
                        {stats.status === 'EXTRACTED' ? stats.securedThreatBonus ?? 0 : stats.lostUnsecured ?? 0} CR
                      </strong>
                    </div>
                  </div>

                  {history.length > 0 && (
                    <div className="mt-2 mil-panel px-3 py-2">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span className="mil-label">RECENT FLIGHT RECORDS</span>
                        <button
                          type="button"
                          onClick={copyScorecard}
                          className="mil-btn mil-btn-secondary mil-btn-sm py-0.5 text-[9px]"
                        >
                          {copied === 'ok' ? 'COPIED!' : 'COPY SCORECARD'}
                        </button>
                      </div>
                      {copied === 'err' && (
                        <div role="status" className="mb-1 text-[9px] font-military tracking-wider text-[#ff8a8a]">
                          Clipboard blocked by browser
                        </div>
                      )}
                      <div className="grid grid-cols-1 gap-1">
                        {history.slice(0, 5).map((run) => (
                          <div key={run.at} className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-[#ded6be]">
                            <span className={run.victory ? 'text-[#8df578]' : 'text-[#ff6666]'}>{run.victory ? '✔ EXT' : '✖ KIA'}</span>
                            <span className="text-[#ffcc00] font-mono">{run.score.toLocaleString()}</span>
                            <span>W{run.wave}</span>
                            <span>{run.kills} K</span>
                            <span>{Math.round(run.accuracy * 100)}%</span>
                            <span>{formatDuration(run.survivalTime)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

      </div>
    </div>
  );
}

const HOW_TO_PLAY_CONTROLS: { keys: string; label: string }[] = [
  { keys: 'A / D (←/→)', label: 'Rudder yaw — rotate the heading' },
  { keys: 'W / S (↑/↓)', label: 'Thrust forward / reverse along the heading' },
  { keys: 'Q / E', label: 'Lateral cyclic strafe' },
  { keys: 'SHIFT / SPACE / CTRL', label: 'Climb / Descend (within the 2.4–26 m band)' },
  { keys: 'MOUSE', label: 'Aim the chin turret — independent of your heading' },
  { keys: 'HOLD LEFT MOUSE', label: 'Fire the machine gun' },
  { keys: 'HOLD RIGHT MOUSE', label: 'Salvo — paint up to 6 locks, release to launch' },
  { keys: 'C', label: 'Flares — break incoming missile locks' },
  { keys: '1–4 / WHEEL', label: 'Switch weapons' },
  { keys: 'R', label: 'Reload' },
  { keys: 'ESC / P', label: 'Pause' },
  { keys: 'ENTER', label: 'Quick restart from the results screen' },
];

function HowToPlayScreen({ touchDevice, onClose }: { touchDevice: boolean; onClose: () => void }) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-[#0d0f0a]/80 px-3 py-4 backdrop-blur-[2px]">
      <div className="menu-perspective">
        <div className="menu-rig">
          <div className="menu-card max-h-[86vh] w-[min(560px,calc(100vw-24px))] overflow-y-auto">
            <span className="mil-rivet mil-rivet-tl" />
            <span className="mil-rivet mil-rivet-tr" />
            <span className="mil-rivet mil-rivet-bl" />
            <span className="mil-rivet mil-rivet-br" />

            <div className="mil-hazard-strip mb-3 rounded-[1px]" />

            <div className="menu-title-slab">
              <div className="flex items-center gap-2 text-[10px] font-military tracking-[0.24em] text-[#ffcc00]">
                <span>★</span>
                <span>TACTICAL BRIEFING</span>
                <span>★</span>
              </div>
              <h2 className="arcade-title-lg my-0.5 text-center">FIELD MANUAL</h2>
              <div className="text-[10px] font-military tracking-[0.2em] text-[#a89d7c] text-center">
                FLIGHT SYSTEMS & COMBAT DOCTRINE
              </div>
            </div>

            <div className="mt-4 setting-section-header">
              <span>🕹</span>
              <span>FLIGHT & COMBAT CONTROLS</span>
              <span>🕹</span>
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              {HOW_TO_PLAY_CONTROLS.map((c) => (
                <div key={c.keys} className="flex items-center justify-between gap-3 mil-panel px-3 py-2">
                  <KeyCap>{c.keys}</KeyCap>
                  <span className="text-[11px] font-military tracking-wider text-[#ded6be] text-right">{c.label}</span>
                </div>
              ))}
            </div>

            {touchDevice && (
              <div className="mt-3 mil-panel px-3 py-2 text-center text-[11px] font-military tracking-wider text-[#ffcc00] border-[#f5ba2c]/60">
                Touch: left stick moves · right stick aims · FIRE button shoots · on-screen Flares & Super buttons
              </div>
            )}

            <div className="mt-4 setting-section-header">
              <span>🛡</span>
              <span>TACTICAL SURVIVAL DOCTRINE</span>
              <span>🛡</span>
            </div>
            <ul className="mt-2 flex flex-col gap-1.5 text-[11px] font-semibold leading-relaxed text-[#c2b697]">
              <li className="mil-panel px-3 py-2 text-center">Enemies attack in waves — the opening countdown is safe.</li>
              <li className="mil-panel px-3 py-2 text-center">Watch Hull & Fuel: fuel pickups restore energy; depots rearm/repair.</li>
              <li className="mil-panel px-3 py-2 text-center">Combat pay stays unsecured until extraction — dying forfeits it.</li>
              <li className="mil-panel px-3 py-2 text-center">SAMs lock on from distance — deploy flares (C) to break missile locks.</li>
              <li className="mil-panel px-3 py-2 text-center">Reinvest combat credits in the Hangar for permanent hull and weapon systems.</li>
            </ul>

            <div className="mt-5 flex justify-center">
              <MenuButton onClick={onClose}>RETURN TO COMMAND</MenuButton>
            </div>

            <div className="mil-hazard-strip mt-4 rounded-[1px]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function VirtualJoystick({ side, onStick }: { side: 'left' | 'right'; onStick: (v: StickPayload) => void }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const handleMove = (clientX: number, clientY: number) => {
    const rect = rectRef.current;
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const max = rect.width / 2 - 14;
    const mag = Math.hypot(dx, dy);
    if (mag > max) {
      dx = (dx / mag) * max;
      dy = (dy / mag) * max;
    }
    setKnob({ x: dx, y: dy });
    onStick({ x: dx / max, y: dy / max, active: true });
  };

  const reset = () => {
    setActiveId(null);
    rectRef.current = null;
    setKnob({ x: 0, y: 0 });
    onStick({ x: 0, y: 0, active: false });
  };

  return (
    <div
      ref={baseRef}
      className={`joystick-base absolute bottom-7 ${side === 'left' ? 'left-5' : 'right-5'}`}
      onPointerDown={(e) => {
        e.preventDefault();
        baseRef.current?.setPointerCapture?.(e.pointerId);
        rectRef.current = baseRef.current?.getBoundingClientRect() ?? null;
        setActiveId(e.pointerId);
        handleMove(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (activeId !== e.pointerId) return;
        handleMove(e.clientX, e.clientY);
      }}
      onPointerUp={reset}
      onPointerCancel={reset}
    >
      <div className="joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      <span className="joystick-label">{side === 'left' ? 'Move' : 'Aim'}</span>
    </div>
  );
}

function FireButton({ onFire }: { onFire: (active: boolean) => void }) {
  return (
    <button
      type="button"
      className="fire-button absolute bottom-[11.5rem] right-5"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onFire(true);
      }}
      onPointerUp={() => onFire(false)}
      onPointerCancel={() => onFire(false)}
      onPointerLeave={() => onFire(false)}
    >
      FIRE
    </button>
  );
}

function PauseOverlay({
  onResume,
  onRestart,
  onSettings,
  onQuit,
}: {
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  onQuit: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-black/75 px-4 backdrop-blur-[6px]">
      <div className="w-[min(380px,calc(100vw-32px))] bg-[#0d120a]/90 border border-[#2d3822] rounded-lg p-6 text-center shadow-[0_12px_40px_rgba(0,0,0,0.85)] animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-center gap-2 text-[10px] font-military tracking-[0.24em] text-[#ffcc00]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#ffcc00] shadow-[0_0_8px_#ffcc00]" />
          <span>GAME PAUSED</span>
        </div>
        <h2 className="text-3xl font-display tracking-wider text-white my-1">
          TACTICAL PAUSE
        </h2>
        <div className="text-[10px] font-military tracking-[0.16em] text-[#8e9985]">
          PRESS ESC OR P TO RESUME
        </div>

        <div className="mt-6 flex flex-col items-stretch gap-2.5">
          <MenuButton size="lg" onClick={onResume}>RESUME (ESC)</MenuButton>
          <MenuButton secondary onClick={onRestart}>RESTART WAVE</MenuButton>
          <MenuButton secondary onClick={onSettings}>SETTINGS</MenuButton>
          <MenuButton secondary onClick={onQuit}>ABORT TO MENU</MenuButton>
        </div>
      </div>
    </div>
  );
}

const Toggle = React.memo(function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`toggle-track ${checked ? 'toggle-on' : ''}`}
      aria-pressed={checked}
    >
      <span className="toggle-knob" />
    </button>
  );
});

function SettingsPanel({
  settings,
  onChange,
  onClose,
  onReplayTutorial,
  onUiSound,
}: {
  settings: GameSettings;
  onChange: (patch: Partial<GameSettings>) => void;
  onClose: () => void;
  onReplayTutorial?: () => void;
  onUiSound: () => void;
}) {
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-[#0d0f0a]/80 px-3 py-4 backdrop-blur-[2px]">
      <div className="menu-perspective">
        <div className="menu-rig">
          <div className="menu-card max-h-[88vh] w-[min(560px,calc(100vw-24px))] overflow-y-auto">
            <span className="mil-rivet mil-rivet-tl" />
            <span className="mil-rivet mil-rivet-tr" />
            <span className="mil-rivet mil-rivet-bl" />
            <span className="mil-rivet mil-rivet-br" />

            <div className="mil-hazard-strip mb-3 rounded-[1px]" />

            <div className="menu-title-slab">
              <div className="flex items-center gap-2 text-[10px] font-military tracking-[0.24em] text-[#ffcc00]">
                <span>★</span>
                <span>SWITCHBOARD INTERFACE</span>
                <span>★</span>
              </div>
              <h2 className="arcade-title-lg my-0.5 text-center">SYSTEM CONFIG</h2>
              <div className="text-[10px] font-military tracking-[0.2em] text-[#a89d7c] text-center">
                REAL-TIME HARDWARE & AUDIO TUNING
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-3">
              {/* ── Section: Threat & Difficulty ── */}
              <div className="setting-section-header">
                <span>⚔</span>
                <span>THREAT & COMBAT PARAMETERS</span>
                <span>⚔</span>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">THREAT RATING</div>
                  <div className="setting-desc">{DIFFICULTY_INFO[settings.difficulty].desc}</div>
                </div>
                <div className="flex gap-1.5">
                  {(['casual', 'normal', 'hard'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => { onUiSound(); onChange({ difficulty: d }); }}
                      aria-pressed={settings.difficulty === d}
                      className={`seg-btn ${settings.difficulty === d ? 'seg-on' : ''}`}
                    >
                      {DIFFICULTY_INFO[d].name}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Section: Flight & Controls ── */}
              <div className="setting-section-header">
                <span>🕹</span>
                <span>FLIGHT & TARGETING AVIONICS</span>
                <span>🕹</span>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">FLIGHT HANDLING</div>
                  <div className="setting-desc">Arcade = instant stick response · Simulation = realistic inertia</div>
                </div>
                <div className="flex gap-1.5">
                  {(['arcade', 'simulation'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => { onUiSound(); onChange({ movement: m }); }}
                      aria-pressed={settings.movement === m}
                      className={`seg-btn ${settings.movement === m ? 'seg-on' : ''}`}
                    >
                      {m === 'arcade' ? 'Arcade' : 'Sim'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">INVERT Y-AXIS</div>
                  <div className="setting-desc">Inverts pitch & gamepad aim direction</div>
                </div>
                <Toggle checked={settings.invertedY} onChange={(v) => { onUiSound(); onChange({ invertedY: v }); }} />
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">AUTO-AIM ASSIST</div>
                  <div className="setting-desc">Turret automatically tracks nearest hostile target</div>
                </div>
                <Toggle checked={settings.autoAim} onChange={(v) => { onUiSound(); onChange({ autoAim: v }); }} />
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">STICK SENSITIVITY</div>
                  <div className="setting-desc">Gamepad & touch response multiplier</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="setting-value">{settings.gamepadSensitivity.toFixed(1)}x</span>
                  <input
                    type="range"
                    min={0.4}
                    max={4}
                    step={0.1}
                    value={settings.gamepadSensitivity}
                    onChange={(e) => onChange({ gamepadSensitivity: Number(e.target.value) })}
                    className="slider-arcade w-28"
                    aria-label="Stick sensitivity"
                  />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">TRAILING CHASE CAMERA</div>
                  <div className="setting-desc">Tail-locked behind the heading · pulls back and rises with speed · dynamic forward lookahead</div>
                </div>
              </div>

              {/* ── Section: Graphics & Performance ── */}
              <div className="setting-section-header">
                <span>🖥</span>
                <span>GRAPHICS & VISUAL ENGINE</span>
                <span>🖥</span>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">GRAPHICS RENDER</div>
                  <div className="setting-desc">SP1 = retro low-res pixels · HD = sharp high-fidelity lighting</div>
                </div>
                <div className="flex gap-1.5">
                  {(['sp1', 'hd'] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => { onUiSound(); onChange({ graphics: g, quality: g === 'hd' ? 'high' : 'low' }); }}
                      aria-pressed={settings.graphics === g}
                      className={`seg-btn ${settings.graphics === g ? 'seg-on' : ''}`}
                    >
                      {g === 'sp1' ? 'SP1' : 'HD'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">ADAPTIVE QUALITY</div>
                  <div className="setting-desc">Dynamic LOD governor to maintain 60 FPS</div>
                </div>
                <Toggle checked={settings.adaptiveQuality} onChange={(v) => { onUiSound(); onChange({ adaptiveQuality: v }); }} />
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">SCREEN SHAKE</div>
                  <div className="setting-desc">Explosion & ballistic impact feedback</div>
                </div>
                <div className="flex gap-1.5">
                  {(['off', 'low', 'full'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => { onUiSound(); onChange({ screenShake: s }); }}
                      aria-pressed={settings.screenShake === s}
                      className={`seg-btn ${settings.screenShake === s ? 'seg-on' : ''}`}
                    >
                      {s === 'off' ? 'Off' : s === 'low' ? 'Low' : 'Full'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">REDUCE FLASHING</div>
                  <div className="setting-desc">Softens high-intensity weapon flashes</div>
                </div>
                <Toggle checked={settings.reduceFlash} onChange={(v) => { onUiSound(); onChange({ reduceFlash: v }); }} />
              </div>

              {/* ── Section: Audio Communications ── */}
              <div className="setting-section-header">
                <span>🔊</span>
                <span>AUDIO COMMUNICATIONS & SFX</span>
                <span>🔊</span>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">MASTER AUDIO</div>
                  <div className="setting-desc">Overall loudness</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="setting-value">{Math.round(settings.volume * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.volume}
                    onChange={(e) => onChange({ volume: Number(e.target.value) })}
                    className="slider-arcade w-28"
                    aria-label="Master volume"
                  />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">COMBAT MUSIC</div>
                  <div className="setting-desc">Soundtrack volume</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="setting-value">{Math.round(settings.musicVolume * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.musicVolume}
                    onChange={(e) => onChange({ musicVolume: Number(e.target.value) })}
                    className="slider-arcade w-28"
                    aria-label="Music volume"
                  />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">SFX WEAPONS</div>
                  <div className="setting-desc">Gunfire & explosion sounds</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="setting-value">{Math.round(settings.sfxVolume * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.sfxVolume}
                    onChange={(e) => onChange({ sfxVolume: Number(e.target.value) })}
                    className="slider-arcade w-28"
                    aria-label="SFX volume"
                  />
                </div>
              </div>

              {/* ── Section: System & Diagnostics ── */}
              <div className="setting-section-header">
                <span>🔧</span>
                <span>SYSTEM PROTOCOLS & RESET</span>
                <span>🔧</span>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">TACTICAL TUTORIAL</div>
                  <div className="setting-desc">Replay initial flight briefing</div>
                </div>
                <button
                  type="button"
                  onClick={() => { onUiSound(); onReplayTutorial?.(); }}
                  className="seg-btn"
                >
                  REPLAY
                </button>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">FACTORY RESET</div>
                  <div className="setting-desc">Restore all parameters to factory defaults</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onUiSound();
                    if (confirmReset) {
                      onChange({ ...DEFAULT_SETTINGS });
                      setConfirmReset(false);
                    } else {
                      setConfirmReset(true);
                      window.setTimeout(() => setConfirmReset(false), 3000);
                    }
                  }}
                  className={`seg-btn ${confirmReset ? 'border-[#d32f2f] text-[#ff6666]' : ''}`}
                >
                  {confirmReset ? 'CONFIRM?' : 'RESET'}
                </button>
              </div>
            </div>

            <div className="mt-6 flex justify-center">
              <MenuButton onClick={onClose}>SAVE & CLOSE</MenuButton>
            </div>

            <div className="mil-hazard-strip mt-4 rounded-[1px]" />
          </div>
        </div>
      </div>
    </div>
  );
}

const WEAPON_MASTERY_INFO: { name: string; altFire: string; color: string }[] = [
  { name: 'Machine Gun', altFire: 'Tracer Rounds: +25% damage', color: '#ff2a2a' },
  { name: 'Missile', altFire: 'Twin Salvo: fires a second missile', color: '#44ff44' },
  { name: 'Rocket', altFire: 'Napalm Warheads: larger blast', color: '#ffaa00' },
  { name: 'Shotgun', altFire: 'Slug Burst: +15% damage', color: '#ffdd22' },
];

const HELICOPTER_MODEL_INFO: { id: HelicopterModel; name: string; desc: string; color: string; dark: string }[] = [
  { id: HelicopterModel.APACHE, name: 'Apache', desc: 'Balanced attack helicopter', color: '#2d3a2e', dark: '#1a211a' },
  { id: HelicopterModel.NIGHTHAWK, name: 'Nighthawk', desc: 'Angular stealth gunship', color: '#242c30', dark: '#101820' },
  { id: HelicopterModel.WARLOCK, name: 'Warlock', desc: 'Heavy gunship, big payload', color: '#3a4436', dark: '#242c2a' },
];

const HelicopterCard = React.memo(function HelicopterCard({
  name,
  desc,
  color,
  dark,
  selected,
  onSelect,
}: {
  name: string;
  desc: string;
  color: string;
  dark: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex flex-col items-center gap-2 mil-panel px-3 py-4 text-center transition hover:-translate-y-0.5 ${
        selected
          ? 'border-[#ffcc00] shadow-[0_0_14px_rgba(255,204,0,0.35)]'
          : 'hover:border-[#738a5e]'
      }`}
    >
      {/* Top-down helicopter silhouette preview */}
      <div className="relative h-14 w-28" style={{ perspective: '300px' }}>
        <div className="absolute left-1/2 top-1/2 h-2 w-16 -translate-x-1/2 -translate-y-1/2 rounded-[2px]" style={{ background: '#161a18', transform: 'rotateX(70deg) rotateZ(-8deg)' }} />
        <div
          className="absolute left-1/2 top-1/2 h-4 w-12 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border border-white/30"
          style={{ background: color, boxShadow: `0 4px 0 ${color}99` }}
        />
        <div className="absolute left-1/2 top-1/2 h-2 w-7 -translate-x-1/2 -translate-y-1/2 rounded-[2px]" style={{ background: dark }} />
      </div>
      <span className={`text-sm font-military tracking-wider ${selected ? 'text-[#ffcc00]' : 'text-[#ded6be]'}`}>
        {name}
      </span>
      <span className="text-[11px] font-semibold leading-snug text-[#a89d7c]">{desc}</span>
      <span
        className={`mt-1 px-3 py-0.5 text-[10px] font-military tracking-wider rounded-[2px] ${
          selected ? 'bg-[#ffcc00] text-[#1a1202] shadow-[0_0_8px_rgba(255,204,0,0.5)]' : 'mil-recessed text-[#a89d7c]'
        }`}
      >
        {selected ? 'ACTIVE CHASSIS' : 'EQUIP'}
      </span>
    </button>
  );
});

type HangarTab = 'aircraft' | 'systems' | 'weapons' | 'mods' | 'perks';

const HANGAR_TABS: { id: HangarTab; label: string }[] = [
  { id: 'aircraft', label: 'AIRCRAFT' },
  { id: 'systems', label: 'HULL SYSTEMS' },
  { id: 'weapons', label: 'MASTERY' },
  { id: 'mods', label: 'WEAPON MODS' },
  { id: 'perks', label: 'PILOT PERKS' },
];

/** Numeric current → next preview for each permanent system rank. */
function upgradePreview(id: HangarUpgradeId, rank: number): string {
  const next = rank + 1;
  switch (id) {
    case 'armor': return `Hull ${100 + rank * 10} → ${100 + next * 10}`;
    case 'fuel': return `Fuel tank ${100 + rank * 4} → ${100 + next * 4}`;
    case 'engine': return `Fuel burn −${(rank * 2.4).toFixed(1)}% → −${(next * 2.4).toFixed(1)}%`;
    case 'rotor': return `Thrust +${(rank * 2.5).toFixed(1)}% → +${(next * 2.5).toFixed(1)}%`;
    case 'targeting': return `Aim range +${rank * 10}m → +${next * 10}m`;
    case 'weaponSystem': return `Ammo capacity +${(rank * 4.5).toFixed(1)}% → +${(next * 4.5).toFixed(1)}%`;
    case 'countermeasures': {
      const cur = countermeasureConfig(rank);
      const nxt = countermeasureConfig(next);
      return `${cur.maxCharges} → ${nxt.maxCharges} flares · ${cur.cooldown}s → ${nxt.cooldown}s`;
    }
    case 'airframe': return `Rank ${rank} → ${next} (cargo flight stability)`;
    default: return `Rank ${rank} → ${next}`;
  }
}

function HangarScreen({
  mastery,
  playerModel,
  credits,
  hangarUpgrades,
  perks,
  weaponMods,
  isNewPilot,
  onSelectModel,
  onBuyUpgrade,
  onBuyPerk,
  onSelectMod,
  onBack,
  onUiSound,
}: {
  mastery: number[];
  playerModel: HelicopterModel;
  credits: number;
  hangarUpgrades: HangarUpgrades;
  perks: PerkRanks;
  weaponMods: number[];
  isNewPilot: boolean;
  onSelectModel: (m: HelicopterModel) => void;
  onBuyUpgrade: (id: HangarUpgradeId) => void;
  onBuyPerk: (id: PerkId) => void;
  onSelectMod: (weaponIndex: number, choice: number) => void;
  onBack: () => void;
  onUiSound: () => void;
}) {
  const [tab, setTab] = useState<HangarTab>('aircraft');
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#0d0f0a]/80 px-3 py-4 backdrop-blur-[2px]">
      <div className="menu-perspective">
        <div className="menu-rig max-h-[92vh] overflow-y-auto">
          <div className="menu-card w-[min(680px,calc(100vw-24px))]">
            <span className="mil-rivet mil-rivet-tl" />
            <span className="mil-rivet mil-rivet-tr" />
            <span className="mil-rivet mil-rivet-bl" />
            <span className="mil-rivet mil-rivet-br" />

            <div className="mil-hazard-strip mb-3 rounded-[1px]" />

            <div className="menu-title-slab text-center">
              <div className="flex items-center justify-center gap-2 text-[10px] font-military tracking-[0.24em] text-[#ffcc00] text-center w-full">
                <span>★</span>
                <span>ARMORY PROTOCOLS</span>
                <span>★</span>
              </div>
              <h2 className="arcade-title-lg my-1 text-center w-full whitespace-nowrap">HANGAR & ARMORY</h2>
              <div className="text-[10px] font-military tracking-[0.2em] text-[#a89d7c] text-center w-full">
                FIELD MAINTENANCE & HARDWARE PROTOCOLS
              </div>
            </div>

            <div className="mx-auto mt-3 flex w-fit items-center gap-2 mil-panel px-4 py-1.5 border-[#ffcc00]/75 shadow-[0_0_12px_rgba(255,204,0,0.25)]">
              <CoinIcon />
              <span className="text-lg font-military text-[#ffcc00] tracking-wider">{credits.toLocaleString()} CREDITS</span>
            </div>

            <div className="mt-4 flex flex-wrap justify-center gap-1.5" role="tablist" aria-label="Hangar sections">
              {HANGAR_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => { onUiSound(); setTab(t.id); }}
                  className={`seg-btn ${tab === t.id ? 'seg-on' : ''}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {isNewPilot && (
              <div className="mt-3 mil-panel px-3 py-2 text-center text-[10px] font-bold uppercase tracking-[0.14em] text-[#9df578] border-[#58a72b]/60">
                ★ Starter credits granted — purchase Hull Armor or Flares to increase combat survivability.
              </div>
            )}

            {tab === 'aircraft' && (
              <>
                <div className="mt-3 text-center text-[10px] font-military tracking-[0.16em] text-[#a89d7c]">
                  ALL AIRCRAFT FRAMES ARE UNLOCKED — SELECT CHASSIS FOR NEXT SORTIE
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {HELICOPTER_MODEL_INFO.map((m) => (
                    <Fragment key={m.id}>
                      <HelicopterCard
                        name={m.name}
                        desc={m.desc}
                        color={m.color}
                        dark={m.dark}
                        selected={playerModel === m.id}
                        onSelect={() => { onUiSound(); onSelectModel(m.id); }}
                      />
                    </Fragment>
                  ))}
                </div>
              </>
            )}

            {tab === 'systems' && (
              <>
                <div className="mt-3 text-center text-[10px] font-military tracking-[0.16em] text-[#a89d7c]">
                  PERMANENT HULL UPGRADES — PURCHASED WITH CREDITS, ACTIVE ACROSS ALL SORTIES
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {(Object.entries(HANGAR_UPGRADE_INFO) as [HangarUpgradeId, (typeof HANGAR_UPGRADE_INFO)[HangarUpgradeId]][]).map(([id, info]) => {
                    const rank = hangarUpgrades[id];
                    const cost = info.costs[rank];
                    const maxed = cost === undefined;
                    const affordable = !maxed && credits >= cost;
                    return (
                      <div key={id} className="flex flex-col mil-panel px-3 py-3 text-center">
                        <div className="text-xs font-military tracking-wide text-[#ffcc00]">{info.name}</div>
                        <div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-[#a89d7c]">Rank {rank} / {info.costs.length}</div>
                        <div className="mt-2 flex items-center justify-center gap-1.5">
                          {info.costs.map((_, index) => index + 1).map((level) => (
                            <span key={level} className={level <= rank ? 'mil-led-on' : 'mil-led-off'} />
                          ))}
                        </div>
                        <div className="mt-2 min-h-8 text-[11px] font-semibold leading-snug text-[#ded6be]">{info.description}</div>
                        <div className="mt-1 min-h-4 text-[10px] font-military tracking-wide text-[#ffcc00]">
                          {maxed ? '★ MAX RANK' : upgradePreview(id, rank)}
                        </div>
                        <button
                          type="button"
                          disabled={!affordable}
                          onClick={() => onBuyUpgrade(id)}
                          aria-label={maxed ? `${info.name} is at max rank` : affordable ? `Upgrade ${info.name} for ${cost} credits` : `Upgrade ${info.name} — need ${cost - credits} more credits`}
                          className={`mt-2 mil-btn ${maxed ? 'mil-btn-secondary' : affordable ? 'mil-btn-primary' : 'mil-btn-secondary'} mil-btn-sm`}
                        >
                          {maxed ? 'MAXED' : affordable ? `UPGRADE · ${cost} CR` : `NEED ${(cost ?? 0) - credits} CR`}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {tab === 'weapons' && (
              <>
                <div className="mt-3 text-center text-[10px] font-military tracking-[0.16em] text-[#a89d7c]">
                  WEAPON COMBAT MASTERY — KILLS GRANT WEAPON XP. MAX RANK UNLOCKS ALT-FIRE.
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {WEAPON_MASTERY_INFO.map((w, i) => {
                    const lvl = mastery[i] ?? 1;
                    const maxed = lvl >= 5;
                    return (
                      <div
                        key={w.name}
                        className="flex items-center gap-3 mil-panel px-4 py-3"
                        style={{ borderColor: maxed ? '#ffcc00' : undefined }}
                      >
                        <div
                          className="flex h-10 w-10 shrink-0 items-center justify-center font-military text-lg font-black mil-recessed"
                          style={{ color: w.color }}
                        >
                          {i + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-military tracking-wide text-[#ded6be]">{w.name}</span>
                            <span className="text-xs font-military text-[#ffcc00]">LV.{lvl} / 5</span>
                          </div>
                          <div className="mt-1.5 flex items-center gap-1.5">
                            {[1, 2, 3, 4, 5].map((n) => (
                              <span key={n} className={n <= lvl ? 'mil-led-on' : 'mil-led-off'} />
                            ))}
                          </div>
                          <div className="mt-1.5 text-[10px] font-semibold leading-snug text-[#a89d7c]">
                            {maxed ? (
                              <span className="text-[#ffcc00]">★ {w.altFire}</span>
                            ) : (
                              <>+{(lvl - 1) * 18}% damage · score kills to reach LV.{lvl + 1}</>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {tab === 'mods' && (
              <>
                <div className="mt-3 text-center text-[10px] font-military tracking-[0.16em] text-[#a89d7c]">
                  EQUIP ONE FIELD MODIFICATION PER WEAPON FOR CUSTOM TACTICAL ADVANTAGES
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {WEAPON_MASTERY_INFO.map((w, i) => {
                    const mods = WEAPON_MODS[i];
                    const current = weaponMods[i] ?? 0;
                    if (!mods) return null;
                    const choices = [{ name: 'Standard Issue', desc: 'Factory caliber, standard ballistic profile' }, ...mods];
                    return (
                      <div key={`mod-${w.name}`} className="mil-panel px-3.5 py-3 text-center">
                        <div className="mb-2 text-xs font-military tracking-wide text-[#ffcc00]">{w.name}</div>
                        <div className="flex flex-col gap-1.5">
                          {choices.map((choice, ci) => (
                            <button
                              key={choice.name}
                              type="button"
                              aria-pressed={current === ci}
                              onClick={() => { onUiSound(); onSelectMod(i, ci); }}
                              className={`border px-3 py-2 text-center transition rounded-[2px] ${
                                current === ci
                                  ? 'border-[#ffcc00] bg-[#ffcc00]/15 shadow-[0_0_8px_rgba(255,204,0,0.2)]'
                                  : 'border-[#3d4a30] bg-[#0f130c] hover:border-[#6b8256]'
                              }`}
                            >
                              <div className={`text-[10px] font-military tracking-wide ${current === ci ? 'text-[#ffcc00]' : 'text-[#ded6be]'}`}>
                                {choice.name}{current === ci ? ' · [EQUIPPED]' : ''}
                              </div>
                              <div className="text-[10px] font-semibold leading-snug text-[#a89d7c] mt-0.5">{choice.desc}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {tab === 'perks' && (
              <>
                <div className="mt-3 text-center text-[10px] font-military tracking-[0.16em] text-[#a89d7c]">
                  PERMANENT PILOT TRAINING SPECIALIZATIONS — 3 RANKS EACH
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {(Object.keys(PERK_INFO) as PerkId[]).map((id) => {
                    const info = PERK_INFO[id];
                    const rank = perks[id];
                    const cost = info.costs[rank];
                    const maxed = cost === undefined;
                    const affordable = !maxed && credits >= cost;
                    return (
                      <div key={`perk-${id}`} className="flex flex-col mil-panel px-3 py-3 text-center">
                        <div className="text-xs font-military tracking-wide text-[#ffcc00]">{info.name}</div>
                        <div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-[#a89d7c]">Rank {rank} / {MAX_PERK_RANK}</div>
                        <div className="mt-2 flex items-center justify-center gap-1.5">
                          {[1, 2, 3, 4, 5].map((level) => (
                            <span key={level} className={level <= rank ? 'mil-led-on' : 'mil-led-off'} />
                          ))}
                        </div>
                        <div className="mt-2 min-h-10 text-[10px] font-semibold leading-snug text-[#ded6be]">{info.desc}</div>
                        <button
                          type="button"
                          disabled={!affordable}
                          onClick={() => onBuyPerk(id)}
                          aria-label={maxed ? `${info.name} is at max rank` : affordable ? `Train ${info.name} rank ${rank + 1} for ${cost} credits` : `Train ${info.name} — need ${cost - credits} more credits`}
                          className={`mt-2 mil-btn ${maxed ? 'mil-btn-secondary' : affordable ? 'mil-btn-primary' : 'mil-btn-secondary'} mil-btn-sm`}
                        >
                          {maxed ? 'MAXED' : affordable ? `TRAIN · ${cost} CR` : `NEED ${(cost ?? 0) - credits} CR`}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <div className="mt-6 flex justify-center">
              <MenuButton onClick={() => { onUiSound(); onBack(); }}>RETURN TO COMMAND</MenuButton>
            </div>

            <div className="mil-hazard-strip mt-4 rounded-[1px]" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const modeRef = useRef<GameMode>('menu');
  const [mode, setMode] = useState<GameMode>('menu');
  const [hintsKey, setHintsKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showHangar, setShowHangar] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [mastery, setMastery] = useState<number[]>(() => readMastery());
  const [credits, setCredits] = useState(() => grantStarterCreditsOnce());
  const [hangarUpgrades, setHangarUpgrades] = useState<HangarUpgrades>(() => readHangarUpgrades());
  const [playerModel, setPlayerModel] = useState<HelicopterModel>(() => {
    try {
      const n = Number(window.localStorage.getItem(STORAGE_KEYS.PLAYER_MODEL));
      return n === HelicopterModel.NIGHTHAWK || n === HelicopterModel.WARLOCK ? n : HelicopterModel.APACHE;
    } catch {
      return HelicopterModel.APACHE;
    }
  });
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [touchDevice, setTouchDevice] = useState(false);
  const [score, setScore] = useState(0);
  const [health, setHealth] = useState(100);
  const [maxHealth, setMaxHealth] = useState(100);
  const [fuel, setFuel] = useState(100);
  const [maxFuel, setMaxFuel] = useState(100);
  const [wave, setWave] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [runLevel, setRunLevel] = useState(1);
  const [runXpProgress, setRunXpProgress] = useState(0);
  const [waveMessage, setWaveMessage] = useState<string | null>(null);
  const [highScore, setHighScore] = useState(0);
  const [isNewBest, setIsNewBest] = useState(false);
  const [runStats, setRunStats] = useState<RunStats | null>(null);
  const [bossInfo, setBossInfo] = useState<{ hp: number; maxHp: number } | null>(null);
  const [weaponInfo, setWeaponInfo] = useState<{
    name: string;
    ammo: number;
    maxAmmo: number;
    type: number;
    reloading: boolean;
    reloadTimer: number;
    level?: number;
  } | null>(null);
  const [comboInfo, setComboInfo] = useState<{
    count: number;
    multiplier: number;
    timer: number;
  } | null>(null);
  const [statusInfo, setStatusInfo] = useState<{
    damageBoost: number;
    shield: number;
    speedBoost: number;
    threat: number;
    afterburner?: boolean;
    risk?: number | null;
  } | null>(null);
  const [salvoInfo, setSalvoInfo] = useState<{
    locks: number;
    cooldown: number;
    isPainting: boolean;
    ready: boolean;
  } | null>(null);
  const [countermeasureInfo, setCountermeasureInfo] = useState<{
    charges: number; maxCharges: number; cooldown: number; ready: boolean;
  } | null>(null);
  const [opening, setOpening] = useState<OpeningState | null>(null);
  const openingPhaseRef = useRef<OpeningState['phase']>('live');
  const [goFlash, setGoFlash] = useState(0);
  const [tutorial, setTutorial] = useState<TutorialState | null>(null);
  const [devDamage, setDevDamage] = useState<{
    source: string; damageType: string; amount: number; time: number; x: number; y: number; z: number;
  } | null>(null);
  const [threatInfo, setThreatInfo] = useState<{
    points: number; level: number; name: string; rewardMultiplier: number;
  } | null>(null);
  const [unsecuredCredits, setUnsecuredCredits] = useState(0);
  const [salvage, setSalvage] = useState(0);
  const [salvageCredits, setSalvageCredits] = useState(0);
  const [superInfo, setSuperInfo] = useState<{
    charge: number; ready: boolean; activeRemaining: number; cooldownRemaining: number;
  } | null>(null);
  const [perks, setPerks] = useState<PerkRanks>(() => readPerks());
  const [weaponMods, setWeaponMods] = useState<number[]>(() => readWeaponMods());
  const [runHistory, setRunHistory] = useState<RunRecord[]>([]);
  const [extraction, setExtraction] = useState<{
    distance: number; bearing: number; progress: number; active: boolean; carrying: boolean;
  } | null>(null);
  const [upgradeOffer, setUpgradeOffer] = useState<UpgradeOption[] | null>(null);
  const [announcement, setAnnouncement] = useState<{
    text: string;
    sub: string;
    color: string;
    key: number;
  } | null>(null);
  const [objectives, setObjectives] = useState<{
    sam: boolean;
    radar: boolean;
    depot: boolean;
    count: number;
  } | null>(null);
  const [samThreat, setSamThreat] = useState<{
    state: 'TRACKING' | 'LOCKING' | 'INBOUND';
    progress: number;
    distance: number;
    bearing: number;
  } | null>(null);
  const [delivery, setDelivery] = useState<DeliveryHudSnapshot | null>(null);
  const [mission, setMission] = useState<MissionHudSnapshot | null>(null);
  const [radarLinked, setRadarLinked] = useState(false);
  // Dev/debug-only perf overlay: poll engine renderer stats ~4x per second
  // (never per frame, no React churn during normal play). F2 toggles it, but
  // only in dev builds (or with localStorage STORAGE_KEYS.PERF = '1' for QA
  // on production bundles). Hidden entirely from the normal production UI.
  const perfAllowed = import.meta.env.DEV ||
    (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEYS.PERF) === '1');
  const [perfStats, setPerfStats] = useState<PerfStats | null>(null);
  // Debug overlay starts hidden everywhere — F2 (dev / QA flag) reveals it.
  const [showPerf, setShowPerf] = useState(false);
  const [hitFlash, setHitFlash] = useState(0);
  // Directional damage indicators: red edge arcs pointing toward the threat.
  const [damageArcs, setDamageArcs] = useState<{ id: number; angle: number }[]>([]);
  const [missileThreats, setMissileThreats] = useState<Array<{
    id: number;
    distance: number;
    bearing: number;
    tti: number;
    danger: "YELLOW" | "ORANGE" | "RED";
    isDecoyed: boolean;
  }>>([]);
  const [isOverdrive, setIsOverdrive] = useState(false);
  const [overdriveMultiplier, setOverdriveMultiplier] = useState(1.0);
  const [canFlare, setCanFlare] = useState(true);
  const [postBossModal, setPostBossModal] = useState<{
    open: boolean;
    credits: number;
    salvage: number;
    score: number;
    kills: number;
    wave: number;
    overdriveMultiplier: number;
  }>({
    open: false,
    credits: 0,
    salvage: 0,
    score: 0,
    kills: 0,
    wave: 10,
    overdriveMultiplier: 1.25,
  });

  const applySettings = (patch: Partial<GameSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    window.localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('helistrike:settings', { detail: next }));
  };

  // UI feedback sounds — routed through the engine's SFX bus.
  const uiClick = () => engineRef.current?.audio.playClick();
  const uiHover = () => engineRef.current?.audio.playHover();
  const uiError = () => engineRef.current?.audio.playError();
  const uiPurchase = () => engineRef.current?.audio.playPurchase();

  // Guided first purchase: a pilot with nothing bought yet is still new.
  const isNewPilot =
    Object.values(hangarUpgrades).every((v) => v === 0) &&
    Object.values(perks).every((v) => v === 0);

  // The loadout ability-card strip only earns its screen space once the
  // player has invested in at least one permanent upgrade or weapon rank.
  const hasLoadoutUpgrades =
    Object.values(hangarUpgrades).some((v) => Number(v) > 0) || (weaponInfo?.level ?? 1) > 1;

  const dispatchStick = (name: string) => (value: StickPayload) => {
    window.dispatchEvent(new CustomEvent(name, { detail: value }));
  };
  const setFire = (active: boolean) => {
    window.dispatchEvent(new CustomEvent('helistrike:fire', { detail: { active } }));
  };

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    setHighScore(readHighScore());
  }, []);

  // Refresh mastery when returning to the menu (after a run levels weapons)
  useEffect(() => {
    if (mode === 'menu') setMastery(readMastery());
  }, [mode]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new GameEngine(canvasRef.current);
    engineRef.current = engine;
    // Dev-only probe hook — stripped from production builds.
    if (import.meta.env.DEV) (window as unknown as { __engine: GameEngine | null }).__engine = engine;

    // Apply persisted settings + auto-detect touch
    const persisted = readSettings();
    const touch = detectTouch();
    const initial = { ...persisted, touchMode: persisted.touchMode || touch };
    setTouchDevice(touch);
    setSettings(initial);
    window.localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(initial));
    window.dispatchEvent(new CustomEvent('helistrike:settings', { detail: initial }));

    const handleUpdate = (e: CustomEvent) => {
      const nextScore = e.detail.score;
      setScore(nextScore);
      setWave(e.detail.wave);
      setMaxHealth(e.detail.maxHealth ?? 100);
      setElapsed(e.detail.elapsed ?? 0);
      setRunLevel(e.detail.runLevel ?? 1);
      setRunXpProgress(e.detail.runXpProgress ?? 0);
      setWaveMessage(e.detail.playing ? e.detail.message : null);
      setWeaponInfo(e.detail.weapon || null);
      setComboInfo(e.detail.combo || null);
      setStatusInfo(e.detail.status || null);
      setSalvoInfo(e.detail.salvo || null);
      setCountermeasureInfo(e.detail.countermeasures || null);
      setThreatInfo(e.detail.threatSystem || null);
      setSuperInfo(e.detail.super || null);
      setUnsecuredCredits(e.detail.unsecuredCredits ?? 0);
      setSalvage(e.detail.salvage ?? 0);
      setSalvageCredits(e.detail.salvageCredits ?? 0);
      setExtraction(e.detail.extraction || null);
      setBossInfo(e.detail.boss || null);
      setObjectives(e.detail.objectives || null);
      setSamThreat(e.detail.samThreat || null);
      setDelivery(e.detail.delivery || null);
      setMission(e.detail.mission || null);
      setRadarLinked(Boolean(e.detail.radarLinked));
      if (Number.isFinite(e.detail.credits)) setCredits(e.detail.credits);

      const storedHighScore = readHighScore();
      if (nextScore > storedHighScore) {
        window.localStorage.setItem(STORAGE_KEYS.HIGH_SCORE, String(nextScore));
        setHighScore(nextScore);
      }
    };

    const handleUpgradeOffer = (e: CustomEvent) => {
      setUpgradeOffer(e.detail?.options ?? null);
    };

    const handleAnnounce = (e: CustomEvent) => {
      const d = e.detail ?? {};
      setAnnouncement({
        text: d.text ?? '',
        sub: d.sub ?? '',
        color: d.color ?? '#ffe66d',
        key: Date.now(),
      });
      window.setTimeout(() => setAnnouncement(null), 2400);
    };

    const handleGameOver = (e: CustomEvent) => {
      const finalScore = e.detail.score;
      setMode('gameover');
      // C7: history was already persisted by the engine — refresh the list.
      setRunHistory(readRunHistory());
      setRunStats({
        time: e.detail.survivalTime ?? e.detail.time ?? 0,
        kills: e.detail.kills ?? 0,
        maxCombo: e.detail.maxCombo ?? 0,
        accuracy: e.detail.accuracy ?? 0,
        wave: e.detail.wave ?? 0,
        status: e.detail.status ?? 'DESTROYED',
        threatLevel: e.detail.threatLevel ?? 1,
        deliveries: e.detail.deliveries ?? 0,
        samSitesDestroyed: e.detail.samSitesDestroyed ?? 0,
        radarSitesDestroyed: e.detail.radarSitesDestroyed ?? 0,
        bossesDestroyed: e.detail.bossesDestroyed ?? 0,
        missionsCompleted: e.detail.missionsCompleted ?? 0,
        missionBonusesCompleted: e.detail.missionBonusesCompleted ?? 0,
        salvage: e.detail.salvage ?? 0,
        lostUnsecured: e.detail.lostUnsecured ?? 0,
        securedThreatBonus: e.detail.securedThreatBonus ?? 0,
        causeOfDeath: e.detail.causeOfDeath ?? '',
        credits: e.detail.credits ?? 0,
        combatPay: e.detail.combatPay ?? 0,
        achievementCredits: e.detail.achievementCredits ?? 0,
        achievementLabels: e.detail.achievementLabels ?? [],
      });

      const storedHighScore = readHighScore();
      setIsNewBest(finalScore >= storedHighScore && finalScore > 0);
      if (finalScore > storedHighScore) {
        window.localStorage.setItem(STORAGE_KEYS.HIGH_SCORE, String(finalScore));
        setHighScore(finalScore);
        engineRef.current?.audio.playNewBest();
      }
    };

    // Track last warning thresholds to avoid audio spam (one warning per tier)
    let lastHullWarnTier = 0;
    let lastFuelWarnTier = 0;
    const handleStats = (e: CustomEvent) => {
      const h = e.detail.currentHealth;
      const f = e.detail.currentFuel;
      setHealth(h);
      setFuel(f);
      if (Number.isFinite(e.detail.maxFuel)) setMaxFuel(e.detail.maxFuel);
      // Low-hull audio warning — fire once at each 10% tier
      const hullTier = h <= 0 ? 0 : Math.floor(h / 10);
      if (hullTier < lastHullWarnTier && modeRef.current === 'playing') {
        engineRef.current?.audio.playWarning();
      }
      lastHullWarnTier = hullTier;
      // Low-fuel audio warning — fire once below 20%
      const maxF = Number.isFinite(e.detail.maxFuel) ? e.detail.maxFuel : maxFuel;
      const fuelPct = maxF > 0 ? (f / maxF) * 100 : 100;
      const fuelTier = fuelPct <= 0 ? 0 : fuelPct <= 20 ? 1 : 2;
      if (fuelTier < lastFuelWarnTier && modeRef.current === 'playing') {
        engineRef.current?.audio.playWarning();
      }
      lastFuelWarnTier = fuelTier;
      if (e.detail.missileThreats) setMissileThreats(e.detail.missileThreats);
      if (e.detail.isOverdrive !== undefined) setIsOverdrive(Boolean(e.detail.isOverdrive));
      if (e.detail.overdriveMultiplier !== undefined) setOverdriveMultiplier(e.detail.overdriveMultiplier);
      if (e.detail.canFlare !== undefined) setCanFlare(Boolean(e.detail.canFlare));
    };

    const handleAutoPause = () => {
      if (modeRef.current === 'playing') {
        setMode('paused');
        engineRef.current?.setPaused(true);
      }
    };

    const handlePlayerHit = () => {
      setHitFlash(1);
      window.setTimeout(() => setHitFlash(0), 140);
    };

    // Damage direction: the engine sends a camera-relative angle (0° = ahead,
    // +90° = right, ±180° = behind). Each hit mints one edge arc that fades
    // out on its own timer; overlapping hits stack (capped at 6).
    const handleDamageDirection = (e: Event) => {
      const detail = (e as CustomEvent<{ angle: number; amount: number }>).detail;
      if (!detail) return;
      const id = Date.now() + Math.random();
      setDamageArcs((arcs) => [...arcs.slice(-5), { id, angle: detail.angle }]);
      window.setTimeout(() => {
        setDamageArcs((arcs) => arcs.filter((a) => a.id !== id));
      }, 700);
    };

    // Opening sequence: GET READY 3-2-1 → GO → spawn-shield countdown.
    const handleOpening = (e: CustomEvent) => {
      const d = (e.detail ?? {}) as OpeningState;
      if (d.phase === 'grace' && openingPhaseRef.current === 'countdown') {
        setGoFlash(Date.now());
        window.setTimeout(() => setGoFlash(0), 1000);
      }
      openingPhaseRef.current = d.phase ?? 'live';
      setOpening(d);
    };

    const handleTutorialEvent = (e: CustomEvent) => {
      setTutorial((e.detail ?? { active: false }) as TutorialState);
    };

    const handlePostBossDecision = (e: CustomEvent) => {
      setPostBossModal({
        open: true,
        credits: e.detail?.credits ?? 0,
        salvage: e.detail?.salvage ?? 0,
        score: e.detail?.score ?? 0,
        kills: e.detail?.kills ?? 0,
        wave: e.detail?.wave ?? 10,
        overdriveMultiplier: e.detail?.overdriveMultiplier ?? 1.25,
      });
    };

    window.addEventListener('helistrike:update', handleUpdate as EventListener);
    window.addEventListener('helistrike:stats', handleStats as EventListener);
    window.addEventListener('helistrike:gameover', handleGameOver as EventListener);
    window.addEventListener('helistrike:autopause', handleAutoPause as EventListener);
    window.addEventListener('helistrike:upgrade-offer', handleUpgradeOffer as EventListener);
    window.addEventListener('helistrike:announce', handleAnnounce as EventListener);
    window.addEventListener('helistrike:player-hit', handlePlayerHit as EventListener);
    window.addEventListener('helistrike:damage', handleDamageDirection as EventListener);
    window.addEventListener('helistrike:opening', handleOpening as EventListener);
    window.addEventListener('helistrike:tutorial', handleTutorialEvent as EventListener);
    window.addEventListener('helistrike:post-boss-decision', handlePostBossDecision as EventListener);

    return () => {
      window.removeEventListener('helistrike:update', handleUpdate as EventListener);
      window.removeEventListener('helistrike:stats', handleStats as EventListener);
      window.removeEventListener('helistrike:gameover', handleGameOver as EventListener);
      window.removeEventListener('helistrike:autopause', handleAutoPause as EventListener);
      window.removeEventListener('helistrike:upgrade-offer', handleUpgradeOffer as EventListener);
      window.removeEventListener('helistrike:announce', handleAnnounce as EventListener);
      window.removeEventListener('helistrike:player-hit', handlePlayerHit as EventListener);
      window.removeEventListener('helistrike:damage', handleDamageDirection as EventListener);
      window.removeEventListener('helistrike:opening', handleOpening as EventListener);
      window.removeEventListener('helistrike:tutorial', handleTutorialEvent as EventListener);
      window.removeEventListener('helistrike:post-boss-decision', handlePostBossDecision as EventListener);
      engine.dispose();
      engineRef.current = null;
      if (import.meta.env.DEV) (window as unknown as { __engine: GameEngine | null }).__engine = null;
    };
  }, []);

  // On-screen perf overlay (Pass 10 cleanup): poll the engine's renderer stats
  // a few times per second — cheap, zero GL cost. F2 toggles it.
  const showPerfRef = useRef(showPerf);
  showPerfRef.current = showPerf;
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!showPerfRef.current) return;
      const engine = engineRef.current;
      if (!engine) return;
      setPerfStats(engine.getPerfStats());
    }, 250);
    const onPerfKey = (e: KeyboardEvent) => {
      if (e.key === 'F2' && perfAllowed) {
        e.preventDefault();
        setShowPerf((v) => !v);
      }
    };
    window.addEventListener('keydown', onPerfKey);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('keydown', onPerfKey);
    };
  }, []);

  const pauseGame = () => {
    if (mode !== 'playing') return;
    setMode('paused');
    engineRef.current?.setPaused(true);
  };

  const resumeGame = () => {
    if (mode !== 'paused') return;
    setMode('playing');
    engineRef.current?.setPaused(false);
  };

  const startRun = () => {
    if (mode === 'playing' || mode === 'paused') return;
    setMode('playing');
    setRunStats(null);
    setIsNewBest(false);
    setShowHangar(false);
    setShowHelp(false);
    setHintsKey((k) => k + 1);
    engineRef.current?.startGame();
  };

  const restartRun = () => {
    setMode('playing');
    setRunStats(null);
    setIsNewBest(false);
    setShowHangar(false);
    setShowHelp(false);
    setHintsKey((k) => k + 1);
    engineRef.current?.startGame();
  };

  // Settings > Replay Tutorial: clear the completion flag so the next run
  // starts with the interactive briefing again.
  const replayTutorial = () => {
    try { window.localStorage.removeItem(STORAGE_KEYS.TUTORIAL_DONE); } catch { /* storage unavailable */ }
    setShowSettings(false);
    setShowHangar(false);
    restartRun();
  };

  const quitToMenu = () => {
    setMode('menu');
    setRunStats(null);
    setIsNewBest(false);
    setShowSettings(false);
    setShowHangar(false);
    setShowHelp(false);
    setUpgradeOffer(null);
    engineRef.current?.setPaused(true);
  };

  const chooseUpgrade = (id: UpgradeId) => {
    setUpgradeOffer(null);
    window.dispatchEvent(new CustomEvent('helistrike:upgrade-choice', { detail: { id } }));
  };

  const selectPlayerModel = (model: HelicopterModel) => {
    setPlayerModel(model);
    window.localStorage.setItem(STORAGE_KEYS.PLAYER_MODEL, String(model));
    window.dispatchEvent(new CustomEvent('helistrike:player-model', { detail: { model } }));
  };

  const purchaseHangarUpgrade = (id: HangarUpgradeId) => {
    const result = buyHangarUpgrade(credits, hangarUpgrades, id);
    if (!result.purchased) {
      uiError();
      return;
    }
    uiPurchase();
    setCredits(result.credits);
    setHangarUpgrades(result.upgrades);
  };

  // C5: pilot perks are bought with the shared credit bank, rank by rank.
  const purchasePerk = (id: PerkId) => {
    const rank = perks[id];
    if (rank >= MAX_PERK_RANK) return;
    const cost = PERK_INFO[id].costs[rank];
    if (credits < cost) {
      uiError();
      return;
    }
    const next = credits - cost;
    uiPurchase();
    setCredits(next);
    window.localStorage.setItem(STORAGE_KEYS.CREDITS, String(next));
    setPerks(writePerkRank(id, rank + 1));
  };

  // C6: weapon mods are a free loadout choice — persist immediately.
  const selectWeaponMod = (weaponIndex: number, choice: number) => {
    setWeaponMods(writeWeaponMod(weaponIndex, choice));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Quick upgrade card selection [1, 2, 3]
      if (upgradeOffer && upgradeOffer.length > 0) {
        if ((e.key === '1' || e.code === 'Numpad1') && upgradeOffer[0]) {
          uiClick();
          chooseUpgrade(upgradeOffer[0].id);
          return;
        }
        if ((e.key === '2' || e.code === 'Numpad2') && upgradeOffer[1]) {
          uiClick();
          chooseUpgrade(upgradeOffer[1].id);
          return;
        }
        if ((e.key === '3' || e.code === 'Numpad3') && upgradeOffer[2]) {
          uiClick();
          chooseUpgrade(upgradeOffer[2].id);
          return;
        }
      }

      // Quick restart from the game-over screen.
      if (e.key === 'Enter' && mode === 'gameover') {
        restartRun();
        return;
      }
      if (e.key !== 'Escape' && e.key.toLowerCase() !== 'p') return;
      if (showSettings) {
        setShowSettings(false);
        return;
      }
      if (upgradeOffer) return; // upgrade roulette handles its own pause
      if (mode === 'playing') pauseGame();
      else if (mode === 'paused') resumeGame();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, showSettings, upgradeOffer]);

  // DEV-only damage diagnostics: poll the engine's last recorded hit so the
  // on-screen overlay always reflects the newest damage event.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const id = window.setInterval(() => {
      setDevDamage(engineRef.current?.lastDamageInfo ?? null);
    }, 400);
    return () => window.clearInterval(id);
  }, []);

  // Readability pass: heavier drop shadow so white numbers read clean over
  // the bright low-poly sky instead of washing out.
  const textShadow = { textShadow: '0 2px 0 rgba(0,0,0,0.62), 0 3px 10px rgba(0,0,0,0.55), 0 0 16px rgba(0,0,0,0.3)' };
  const hudDim = mode !== 'playing' ? 'opacity-35' : 'opacity-100';
  const dangerOpacity = mode === 'playing' ? clampPercent(35 - health) / 100 : 0;

  return (
    <div className="font-ui relative h-screen w-screen overflow-hidden bg-[#97dff0] text-white pointer-events-auto select-none">
      <canvas
          ref={canvasRef}
          className={`absolute inset-0 block h-full w-full touch-none z-0 ${settings.graphics === 'sp1' ? '[image-rendering:pixelated]' : ''}`}
        />
      <div className="arcade-scanlines pointer-events-none absolute inset-0 z-10" />
      <div className="arcade-vignette pointer-events-none absolute inset-0 z-10" />
      <div
        className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-300"
        style={{
          opacity: dangerOpacity,
          background: 'radial-gradient(circle at center, transparent 45%, rgba(239,35,60,0.72) 100%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-100"
        style={{
          opacity: hitFlash,
          background: 'radial-gradient(circle at center, transparent 52%, rgba(255,80,64,0.58) 100%)',
          boxShadow: 'inset 0 0 26px rgba(255,220,190,0.65)',
        }}
      />
      {/* Directional damage indicators — red edge arcs marking where hits come from */}
      {mode === 'playing' && damageArcs.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-10">
          {damageArcs.map((arc) => (
            <div
              key={arc.id}
              className="damage-arc"
              style={{ '--arc-angle': `${arc.angle}deg` } as CSSProperties}
            />
          ))}
        </div>
      )}

      <div className={`pointer-events-none absolute inset-0 z-20 transition-opacity duration-300 ${hudDim}`}>
        {/* ══ TOP-CENTER: XP & Level Console + Wave Counter + Boss Health Bar ══ */}
        {mode === 'playing' && (
          <div className="pointer-events-none absolute left-1/2 top-2.5 -translate-x-1/2 flex flex-col items-center z-30 sm:top-3.5">
            <div className="hs-panel flex items-center gap-3.5 px-4 py-2 shadow-2xl">
              <span className="mil-rivet mil-rivet-tl" />
              <span className="mil-rivet mil-rivet-tr" />
              <span className="mil-rivet mil-rivet-bl" />
              <span className="mil-rivet mil-rivet-br" />

              {/* Pilot Level Badge */}
              <div className="flex flex-col items-center">
                <span className="font-hud text-[11px] font-bold text-[#a89d7c] leading-none tracking-wider">RANK</span>
                <span className="font-display text-xl sm:text-2xl text-[#ffcc00] leading-none drop-shadow-[0_2px_0_#881c0d] mt-0.5">
                  LV.{runLevel}
                </span>
              </div>

              {/* XP Progress Bar (Thicker 18-20px bar with readable % in font-tech) */}
              <div className="flex flex-col gap-1 w-36 sm:w-60">
                <div className="flex justify-between items-center text-xs font-hud font-bold text-[#ded6be]">
                  <span className="text-[#ffcc00] tracking-wide">EXPERIENCE</span>
                  <span className="font-tech font-bold text-[#ffcc00]">{Math.round(runXpProgress * 100)}%</span>
                </div>
                <div className="h-3.5 sm:h-4 hs-bar-track relative flex items-center">
                  <div
                    className="hs-bar-fill bg-gradient-to-r from-[#b37400] via-[#ffaa00] to-[#ffcc00] shadow-[0_0_10px_rgba(255,204,0,0.6)]"
                    style={{ width: `${clampPercent(runXpProgress * 100)}%` }}
                  />
                </div>
              </div>

              {/* Compact Wave badge */}
              <div className="flex flex-col items-center border-l border-[#4a593b] pl-3">
                <span className="font-hud text-[11px] font-bold text-[#a89d7c] leading-none tracking-wider">
                  {isOverdrive ? 'OVERDRIVE' : 'SECTOR'}
                </span>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`font-military text-base leading-none ${isOverdrive ? 'text-[#ffaa00]' : 'text-white'}`}>
                    {isOverdrive ? `WAVE ${wave}` : `WAVE ${wave}`}
                  </span>
                  {isOverdrive ? (
                    <span className="rounded bg-[#ffaa00]/20 px-1 py-0.5 font-tech text-[10px] font-bold text-[#ffcc00] border border-[#ffaa00]/50">
                      ×{overdriveMultiplier.toFixed(2)}
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5">
                      {Array.from({ length: Math.min(wave, 5) }).map((_, i) => (
                        <Skull key={i} size={10} className="text-[#ff3344] drop-shadow-[0_0_4px_rgba(239,35,60,0.95)]" />
                      ))}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Industrial Boss Health Bar */}
            {bossInfo && (
              <div className="mt-2 w-[min(520px,88vw)] animate-pulse">
                <div className="hs-panel hs-panel-danger px-3.5 py-2">
                  <div className="mil-hazard-strip-danger mb-1.5 rounded-[1px]" />
                  <div className="flex justify-between items-center">
                    <span className="font-military text-sm text-[#ff4747] tracking-wider">⚠ ARCHON HEAVY GUNSHIP</span>
                    <span className="font-tech text-sm font-bold text-[#ff8a8a]">
                      {Math.round((bossInfo.hp / Math.max(1, bossInfo.maxHp)) * 100)}%
                    </span>
                  </div>
                  <div className="h-4 hs-bar-track mt-1.5">
                    <div
                      className="hs-bar-fill bg-gradient-to-r from-[#8e1515] via-[#d32f2f] to-[#ff5252] shadow-[0_0_10px_rgba(211,47,47,0.8)]"
                      style={{ width: `${clampPercent((bossInfo.hp / Math.max(1, bossInfo.maxHp)) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ TOP-LEFT: Objectives & Active Mission ══ */}
        {mode === 'playing' && (
          <div className="pointer-events-none absolute left-3 top-2.5 flex w-[min(280px,46vw)] flex-col gap-2 z-30 sm:left-4 sm:top-4">
            {/* Tactical Objectives (Collapsible / Compact) */}
            <div className="hs-panel hs-panel-sm flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="hs-heading text-xs text-[#ffcc00] flex items-center gap-1.5">
                  <span>◆</span>
                  <span>OBJECTIVES</span>
                </span>
                <span className="font-tech text-xs text-[#ded6be] font-bold tabular-nums">
                  {formatDuration(elapsed)}
                </span>
              </div>

              {objectives && objectives.count > 0 ? (
                <div className="flex flex-col gap-1 text-[13px] font-hud font-semibold">
                  <div className="flex items-center justify-between">
                    <span className={objectives.sam ? 'text-[#ded6be]' : 'text-[#8df578]'}>
                      {objectives.sam ? '● SAM SITES' : '✓ SAMS'}
                    </span>
                    <span className={`font-tech text-xs font-bold ${objectives.sam ? 'text-[#ffcc00]' : 'text-[#8df578]'}`}>
                      {objectives.sam ? 'ACTIVE' : 'CLEARED'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={objectives.radar ? 'text-[#ded6be]' : 'text-[#8df578]'}>
                      {objectives.radar ? '● RADAR SITES' : '✓ RADARS'}
                    </span>
                    <span className={`font-tech text-xs font-bold ${objectives.radar ? 'text-[#ffcc00]' : 'text-[#8df578]'}`}>
                      {objectives.radar ? 'ACTIVE' : 'CLEARED'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={objectives.depot ? 'text-[#ded6be]' : 'text-[#8df578]'}>
                      {objectives.depot ? '● FUEL DEPOTS' : '✓ DEPOTS'}
                    </span>
                    <span className={`font-tech text-xs font-bold ${objectives.depot ? 'text-[#ffcc00]' : 'text-[#8df578]'}`}>
                      {objectives.depot ? 'ACTIVE' : 'CLEARED'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-[13px] font-hud font-bold text-[#8df578] flex items-center gap-1">
                  <span>✓</span>
                  <span>ALL SECTOR OBJECTIVES SECURED</span>
                </div>
              )}
            </div>

            {/* Active Mission (Dominant Visual Priority) */}
            {mission && (
              <div className="hs-panel border-[#ffcc00]/60 shadow-[0_0_12px_rgba(255,204,0,0.2)]">
                <div className="flex items-center justify-between gap-2 border-b border-[#3d4a30] pb-1">
                  <span className="hs-heading text-xs text-[#ffcc00] flex items-center gap-1">
                    <span>★</span>
                    <span>MISSION</span>
                  </span>
                  <span className="font-tech text-xs font-bold text-[#ffcc00] bg-[#2a220a] px-2 py-0.5 rounded-[2px] border border-[#ffcc00]/40">
                    +{mission.rewardCredits} CR
                  </span>
                </div>

                <div className="mt-1.5 text-base font-hud font-bold text-white tracking-wide leading-snug">
                  {mission.title}
                </div>

                <div className="mt-1.5 flex justify-between items-center text-xs font-hud">
                  <span className="text-[#a89d7c]">PROGRESS</span>
                  <span className="font-tech text-xs font-bold text-[#ded6be]">
                    {Math.min(mission.progress, mission.targetProgress)} / {mission.targetProgress}
                  </span>
                </div>

                <div className="mt-1 h-2 hs-bar-track">
                  <div
                    className="hs-bar-fill bg-gradient-to-r from-[#d48b12] to-[#ffcc00] shadow-[0_0_6px_rgba(255,204,0,0.6)]"
                    style={{ width: `${clampPercent((mission.progress / Math.max(1, mission.targetProgress)) * 100)}%` }}
                  />
                </div>

                {mission.bonus && (
                  <div className="mt-1.5 flex items-center justify-between text-xs font-hud pt-1 border-t border-[#2d3824]">
                    <span className={mission.bonus.state === 'FAILED' ? 'text-[#ff6666]' : mission.bonus.state === 'COMPLETE' ? 'text-[#8df578]' : 'text-[#e5c158]'}>
                      ★ {mission.bonus.label}
                    </span>
                    <span className="font-tech text-[11px] text-[#a89d7c]">
                      {mission.bonus.state === 'COMPLETE' ? '✓ DONE' : mission.bonus.state === 'FAILED' ? 'FAILED' : 'BONUS'}
                    </span>
                  </div>
                )}
                {radarLinked && (
                  <div className="mt-1 text-[11px] font-hud font-bold text-[#ff9900] tracking-wide">
                    RADAR LINK · SAM TRACKING ENHANCED
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Center state: spawn shield countdown */}
        <div className="pointer-events-none absolute left-1/2 top-[5.2rem] flex -translate-x-1/2 flex-col items-center gap-1.5 z-30">
          {mode === 'playing' && opening?.phase === 'grace' && (
            <div className="hs-panel hs-panel-warning px-4 py-1.5 text-center shadow-[0_0_16px_rgba(255,204,0,0.35)]">
              <div className="text-xs font-military tracking-wide text-[#ffcc00]">
                INVULNERABILITY SHIELD ACTIVE · {Math.max(0, opening.remaining ?? 0).toFixed(1)}S
              </div>
            </div>
          )}
        </div>

        {/* ══ RIGHT COLUMN: Minimap, Pause & Contextual Mission/Threat Intel (Single non-overlapping flex stack) ══ */}
        {mode === 'playing' && (
          <div className="pointer-events-none absolute right-3 top-2.5 flex flex-col items-end gap-2 z-30 sm:right-4 sm:top-4 max-h-[calc(100vh-6rem)]">
            <div className="hs-panel p-1.5 shadow-2xl">
              <span className="mil-rivet mil-rivet-tl" />
              <span className="mil-rivet mil-rivet-tr" />
              <span className="mil-rivet mil-rivet-bl" />
              <span className="mil-rivet mil-rivet-br" />
              <div className="mb-1 text-center font-military text-[10px] tracking-wider text-[#a89d7c]">
                TACTICAL RADAR
              </div>
              <MinimapPanel />
            </div>

            {!upgradeOffer && (
              <button
                type="button"
                onClick={pauseGame}
                className="pointer-events-auto mil-btn mil-btn-secondary mil-btn-sm py-1 px-3 text-xs"
              >
                PAUSE (ESC)
              </button>
            )}

            {/* Contextual SAM Threat / Cargo / Extraction / Threat Alert Card */}
            {samThreat && samThreat.state === 'INBOUND' ? (
              <div className="hs-panel hs-panel-danger w-[min(260px,44vw)] animate-pulse">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-military text-sm text-[#ff6666] tracking-wide">⚠ MISSILE INBOUND</span>
                  <span className="font-tech text-sm font-bold text-white">{samThreat.distance}M</span>
                </div>
                <div className="mt-1 h-2 hs-bar-track">
                  <div className="hs-bar-fill bg-[#d32f2f]" style={{ width: `${clampPercent(samThreat.progress * 100)}%` }} />
                </div>
                <div className="mt-1 text-center font-military text-xs text-[#ffaaaa] tracking-wider">
                  DEPLOY FLARES (C)
                </div>
              </div>
            ) : samThreat && (samThreat.state === 'LOCKING' || samThreat.state === 'TRACKING') ? (
              <div className="hs-panel hs-panel-warning w-[min(260px,44vw)]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-military text-xs text-[#ffa726] tracking-wide">⚠ SAM {samThreat.state}</span>
                  <span className="font-tech text-xs font-bold text-white">{samThreat.distance}M</span>
                </div>
                <div className="mt-1 h-1.5 hs-bar-track">
                  <div className="hs-bar-fill bg-[#ff7700]" style={{ width: `${clampPercent(samThreat.progress * 100)}%` }} />
                </div>
              </div>
            ) : delivery ? (
              <div className="hs-panel w-[min(260px,44vw)] border-[#ffcc00]/50">
                <div className="flex items-center justify-between gap-2 border-b border-[#3d4a30] pb-1">
                  <span className="font-military text-xs text-[#ffcc00] flex items-center gap-1">
                    <span>📦</span>
                    <span>CARGO CONTRACT</span>
                  </span>
                  <span className="font-hud text-[11px] font-bold px-1.5 py-0.5 rounded-[2px] bg-[#1a2014] text-[#ffcc00] border border-[#ffcc00]/30">
                    {delivery.difficulty.replace('_', ' ')}
                  </span>
                </div>

                <div className="mt-1.5 text-sm font-hud font-bold text-white tracking-wide">
                  <span className="mr-1 text-[#ffcc00]">{delivery.cargoIcon}</span>
                  {delivery.cargoName}
                </div>

                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className={`font-hud text-xs font-bold ${delivery.action === 'PICKUP' ? 'text-[#ffcc00]' : 'text-[#8df578]'}`}>
                    {delivery.action}
                  </span>
                  <span className="font-tech text-sm font-bold text-[#ded6be]">
                    {formatDistance(delivery.distance)}
                  </span>
                </div>

                <div className="mt-0.5 truncate text-xs font-hud text-[#a89d7c]">
                  → {delivery.destinationName}
                </div>

                <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-[#3d4a30] pt-1 text-xs">
                  <div>
                    <span className="font-hud text-[10px] text-[#a89d7c] block">BOUNTY</span>
                    <span className="font-tech text-xs font-bold text-[#ffcc00]">{delivery.reward} CR</span>
                  </div>
                  {delivery.timeBonusRemaining !== null && (
                    <div className="text-right">
                      <span className="font-hud text-[10px] text-[#a89d7c] block">TIME BONUS</span>
                      <span className={`font-tech text-xs font-bold ${delivery.timeBonusRemaining > 0 ? 'text-[#8df578]' : 'text-white/35'}`}>
                        {formatDuration(delivery.timeBonusRemaining)}
                      </span>
                    </div>
                  )}
                </div>

                {(delivery.state === 'PICKUP_READY' || delivery.state === 'DELIVERING') && (
                  <div className="mt-1.5">
                    <div className="flex items-center justify-between text-xs font-hud font-bold">
                      <span className={delivery.state === 'DELIVERING' ? 'text-[#8df578]' : 'text-[#ffcc00]'}>
                        HOLDING POSITION
                      </span>
                      <span className="font-tech text-xs text-[#ded6be]">{Math.round(clampPercent(delivery.progress * 100))}%</span>
                    </div>
                    <div className="mt-1 h-2 hs-bar-track">
                      <div
                        className={`hs-bar-fill ${delivery.state === 'DELIVERING' ? 'bg-[#58a72b]' : 'bg-[#ffcc00]'}`}
                        style={{ width: `${clampPercent(delivery.progress * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : extraction ? (
              <div className="hs-panel hs-panel-success w-[min(260px,44vw)]">
                <div className="font-military text-xs text-[#8df578] flex items-center gap-1">
                  <span>🚁</span>
                  <span>EXTRACTION ZONE OPEN</span>
                </div>
                <div className="mt-1 flex justify-between items-center text-xs font-hud">
                  <span className="text-[#ded6be]">DISTANCE: {formatDistance(extraction.distance)}</span>
                  <span className="font-tech font-bold text-[#ffcc00]">
                    +{(unsecuredCredits + salvageCredits).toLocaleString()} CR
                  </span>
                </div>
                {extraction.active && (
                  <div className="mt-1.5">
                    <div className="font-hud text-xs font-bold text-[#8df578]">EXTRACTING {Math.round(extraction.progress * 100)}%</div>
                    <div className="mt-0.5 h-2 hs-bar-track">
                      <div className="hs-bar-fill bg-[#58a72b]" style={{ width: `${clampPercent(extraction.progress * 100)}%` }} />
                    </div>
                  </div>
                )}
              </div>
            ) : threatInfo ? (
              <div className={`hs-panel w-[min(240px,40vw)] ${threatInfo.level >= 3 ? 'hs-panel-danger animate-pulse' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-military text-xs text-[#ffcc00]">THREAT RATING</span>
                  <span className="font-tech text-xs font-bold text-[#ded6be]">LV {threatInfo.level}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-xs font-hud font-bold">
                  <span className="text-white">{threatInfo.name}</span>
                  <span className="text-[#ffcc00] font-tech">REWARD ×{threatInfo.rewardMultiplier.toFixed(2)}</span>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Edge-style route direction waypoint */}
        {delivery && delivery.action !== 'COMPLETE' && delivery.distance > 50 && mode === 'playing' && (
          <div className="pointer-events-none absolute left-1/2 top-[18%] -translate-x-1/2 text-center z-30">
            <div
              className={`mx-auto text-3xl font-black ${delivery.action === 'PICKUP' ? 'text-[#ffcc00]' : 'text-[#8df578]'}`}
              style={{ ...textShadow, transform: `rotate(${delivery.bearing}deg)` }}
            >
              ▲
            </div>
            <div className="mt-0.5 hs-panel hs-panel-sm inline-flex items-center gap-1.5 border-[#ffcc00]/60 shadow-[0_4px_16px_rgba(0,0,0,0.7)]">
              <span className="text-base">{delivery.cargoIcon || '📦'}</span>
              <span className="font-military text-xs text-[#ffcc00] tracking-wide">{delivery.action}</span>
              <span className="font-tech text-xs font-bold text-white">· {formatDistance(delivery.distance)}</span>
            </div>
          </div>
        )}

        {/* Arcade announcement toast */}
        {announcement && mode === 'playing' && (
          <div key={announcement.key} className="arcade-announce pointer-events-none absolute left-1/2 top-[30%] -translate-x-1/2 text-center z-30">
            <div className="arcade-title-lg text-center" style={{ color: announcement.color }}>
              {announcement.text}
            </div>
            {announcement.sub && (
              <div className="mt-1 text-xs font-military tracking-[0.2em] text-[#ded6be]" style={textShadow}>
                {announcement.sub}
              </div>
            )}
          </div>
        )}

        {/* Screen-Edge Tactical SAM Missile Threat Indicators */}
        {mode === 'playing' && missileThreats.map((threat) => (
          <div
            key={`threat-${threat.id}`}
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 flex flex-col items-center"
            style={{
              transform: `translate(-50%, -50%) rotate(${threat.bearing}deg) translateY(-min(34vh, 210px)) rotate(${-threat.bearing}deg)`,
            }}
          >
            <div
              className={`text-2xl font-black transition-transform duration-75 ${
                threat.danger === 'RED'
                  ? 'text-[#ff3344] animate-ping'
                  : threat.danger === 'ORANGE'
                  ? 'text-[#ff9900] animate-pulse'
                  : 'text-[#ffd43b]'
              }`}
              style={{ transform: `rotate(${threat.bearing}deg)` }}
            >
              ▲
            </div>
            <div className="mt-0.5 rounded bg-black/80 px-1.5 py-0.5 border border-white/20 text-center shadow-lg backdrop-blur-xs">
              <span className={`font-tech text-[10px] font-bold ${threat.danger === 'RED' ? 'text-[#ff3344]' : threat.danger === 'ORANGE' ? 'text-[#ff9900]' : 'text-[#ffd43b]'}`}>
                {threat.distance}M · {threat.tti.toFixed(1)}S
              </span>
              {threat.isDecoyed && <span className="block text-[8px] font-military text-[#7df9ff]">DECOYED</span>}
            </div>
            {threat.danger === 'RED' && canFlare && (
              <div className="mt-1 rounded bg-[#ff3344] px-1.5 py-0.5 text-[9px] font-military font-bold text-white shadow-[0_0_8px_#ff3344] animate-bounce">
                [C] FLARES
              </div>
            )}
          </div>
        ))}

        {/* ══ BOTTOM-LEFT: Unified Player Status Console (Hull, Fuel, Flares, Status) ══ */}
        {mode === 'playing' && (
          <div className={`pointer-events-none absolute left-3 flex flex-col items-start gap-2 z-30 sm:left-4 ${touchDevice ? 'bottom-64' : 'bottom-4'}`}>
            <div className={`hs-panel flex w-[min(260px,44vw)] flex-col gap-2 ${health <= maxHealth * 0.3 ? 'hs-panel-danger' : ''}`}>
              {/* Hull Integrity */}
              <div>
                <div className="flex justify-between items-center font-hud">
                  <span className="font-bold text-sm text-[#ded6be] tracking-wide">HULL INTEGRITY</span>
                  <span className="font-tech text-base font-bold text-white tabular-nums">
                    {Math.round(health)} / {Math.round(maxHealth)}
                  </span>
                </div>
                <div className="h-3.5 hs-bar-track mt-1">
                  <div
                    className={`hs-bar-fill ${
                      health > maxHealth * 0.5
                        ? 'bg-gradient-to-r from-[#2b5614] to-[#58a72b] shadow-[0_0_8px_rgba(88,167,43,0.6)]'
                        : health > maxHealth * 0.25
                        ? 'bg-gradient-to-r from-[#8a6a12] to-[#d89a22] shadow-[0_0_8px_rgba(216,154,34,0.6)]'
                        : 'bg-gradient-to-r from-[#6b1e1a] to-[#d6453d] shadow-[0_0_8px_rgba(214,69,61,0.8)] animate-pulse'
                    }`}
                    style={{ width: `${clampPercent((health / maxHealth) * 100)}%` }}
                  />
                </div>
                {health <= maxHealth * 0.25 && (
                  <div className="mt-1 text-center font-military text-xs text-[#ff6666] tracking-wider animate-pulse">
                    ⚠ HULL CRITICAL
                  </div>
                )}
              </div>

              {/* Fuel Level */}
              <div>
                <div className="flex justify-between items-center font-hud">
                  <span className="font-bold text-xs text-[#a89d7c]">FUEL LEVEL</span>
                  <span className="font-tech text-xs font-bold text-[#ded6be] tabular-nums">
                    {Math.round(fuel)}%
                  </span>
                </div>
                <div className="h-2 hs-bar-track mt-0.5">
                  <div
                    className={`hs-bar-fill ${
                      fuel > 30
                        ? 'bg-gradient-to-r from-[#1d4d60] to-[#3db8d8]'
                        : 'bg-gradient-to-r from-[#6b1e1a] to-[#d6453d] animate-pulse'
                    }`}
                    style={{ width: `${clampPercent((fuel / maxFuel) * 100)}%` }}
                  />
                </div>
              </div>

              {/* Flare Charges */}
              {countermeasureInfo && (
                <div className="flex items-center justify-between pt-1.5 border-t border-[#3d4a30]">
                  <div>
                    <span className="font-hud text-xs font-bold text-[#ffcc00]">FLARES (C)</span>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      {Array.from({ length: countermeasureInfo.maxCharges }).map((_, i) => (
                        <span key={i} className={i < countermeasureInfo.charges ? 'mil-led-on' : 'mil-led-off'} />
                      ))}
                    </div>
                  </div>
                  {countermeasureInfo.cooldown > 0 ? (
                    <span className="font-tech text-xs font-bold text-[#a89d7c]">{countermeasureInfo.cooldown.toFixed(1)}s</span>
                  ) : (
                    <span className="font-military text-xs text-[#8df578]">READY</span>
                  )}
                </div>
              )}
            </div>

            {/* Active Defensive & Combat Buffs */}
            {statusInfo && (statusInfo.shield > 0 || statusInfo.damageBoost > 0 || statusInfo.speedBoost > 0 || (statusInfo as any).magnetSurge > 0 || statusInfo.afterburner) && (
              <div className="flex flex-wrap gap-1.5">
                {statusInfo.shield > 0 && (
                  <div className="hud-status flex items-center gap-1 border-[#00e5ff]/50 text-[#80f0ff] font-hud text-xs font-bold px-2 py-0.5"><Shield size={12} /> SHIELD {Math.ceil(statusInfo.shield)}S</div>
                )}
                {statusInfo.damageBoost > 0 && (
                  <div className="hud-status flex items-center gap-1 border-[#ff3344]/60 text-[#ff7788] font-hud text-xs font-bold px-2 py-0.5"><Zap size={12} /> OVERDRIVE {Math.ceil(statusInfo.damageBoost)}S</div>
                )}
                {(statusInfo as any).magnetSurge > 0 && (
                  <div className="hud-status flex items-center gap-1 border-[#00e5ff]/60 text-[#00e5ff] font-hud text-xs font-bold px-2 py-0.5"><Sparkles size={12} /> MAGNET {Math.ceil((statusInfo as any).magnetSurge)}S</div>
                )}
                {statusInfo.speedBoost > 0 && (
                  <div className="hud-status flex items-center gap-1 border-[#ff66cc]/50 text-[#ffa6e6] font-hud text-xs font-bold px-2 py-0.5"><Sparkles size={12} /> BOOST {Math.ceil(statusInfo.speedBoost)}S</div>
                )}
                {statusInfo.afterburner && (
                  <div className="hud-status flex items-center gap-1 animate-pulse border-[#ff7700]/60 text-[#ffb066] font-hud text-xs font-bold px-2 py-0.5"><Flame size={12} /> AFTERBURNER</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ══ BOTTOM-CENTER: Weapon & Combat Console + Combo Streak ══ */}
        {mode === 'playing' && (
          <div className={`pointer-events-none absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 z-30 ${touchDevice ? 'bottom-64' : 'bottom-4'}`}>
            {/* Active Combo Streak Dock */}
            {comboInfo && comboInfo.count > 1 && (
              <div className="hs-panel hs-panel-sm px-3 py-1 flex items-center gap-2.5 border-[#ffcc00]/60 shadow-[0_0_12px_rgba(255,204,0,0.35)]">
                <span className="font-display text-sm sm:text-base text-[#ffcc00] leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                  {comboInfo.count}× COMBO
                </span>
                <span className="font-tech text-xs font-bold text-white">
                  ×{comboInfo.multiplier.toFixed(1)} MULT
                </span>
                <div className="h-1.5 w-16 hs-bar-track">
                  <div
                    className="hs-bar-fill bg-gradient-to-r from-[#d48b12] to-[#ffcc00]"
                    style={{ width: `${clampPercent((comboInfo.timer / 3.0) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {weaponInfo && (
              <div className="hs-panel flex flex-col items-center px-4 py-2 shadow-2xl min-w-[240px]">
                {/* 4-Weapon Quick Select Slots */}
                <div className="flex items-center justify-between w-full mb-1.5 pb-1 border-b border-[#3d4a30] gap-1">
                  {[
                    { key: '1', name: 'MG', type: 0 },
                    { key: '2', name: 'MSL', type: 1 },
                    { key: '3', name: 'RKT', type: 2 },
                    { key: '4', name: 'SHT', type: 3 },
                  ].map((slot) => {
                    const isActive = weaponInfo.type === slot.type;
                    return (
                      <div
                        key={slot.key}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] border text-[10px] font-tech font-bold transition-all ${
                          isActive
                            ? 'border-[#ffcc00] bg-[#332205] text-[#ffcc00] shadow-[0_0_8px_rgba(255,204,0,0.35)]'
                            : 'border-[#334026] bg-[#141812] text-[#7a8c6a]'
                        }`}
                      >
                        <span className={isActive ? 'text-[#ffcc00]' : 'text-[#4a593b]'}>[{slot.key}]</span>
                        <span>{slot.name}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Weapon Name & LV */}
                <div className="flex items-center justify-between w-full gap-3 border-b border-[#3d4a30] pb-1">
                  <div className="flex items-center gap-1.5">
                    <BulletIcon />
                    <span className="font-military text-sm text-white tracking-wide">{weaponInfo.name}</span>
                  </div>
                  {(weaponInfo.level ?? 1) > 1 && (
                    <span className="px-1.5 py-0.5 font-hud text-xs font-bold rounded-[2px] bg-[#332205] border border-[#f5ba2c] text-[#ffcc00]">
                      LV.{weaponInfo.level}
                    </span>
                  )}
                </div>

              {/* Ammo (LARGE High-Contrast Numbers 24-28px) */}
              <div className="my-1.5 flex flex-col items-center">
                {weaponInfo.reloading ? (
                  <div className="flex flex-col items-center gap-1">
                    <span className="font-military text-sm text-[#ffcc00] animate-pulse">RELOADING…</span>
                    <div className="h-2 w-36 hs-bar-track">
                      <div
                        className="hs-bar-fill bg-[#ffcc00] transition-[width] duration-100"
                        style={{ width: `${clampPercent((1 - weaponInfo.reloadTimer / 2.0) * 100)}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-baseline gap-1">
                    <span className="font-tech text-2xl sm:text-3xl font-extrabold text-white tracking-tight drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                      {weaponInfo.ammo}
                    </span>
                    <span className="font-tech text-base text-[#a89d7c] font-bold">
                      / {weaponInfo.maxAmmo}
                    </span>
                  </div>
                )}
              </div>

              {/* Sub-bar: Salvo & Devastation Super */}
              <div className="flex items-center justify-between w-full pt-1.5 border-t border-[#3d4a30] gap-3 text-xs font-hud">
                {/* Multi-Salvo */}
                {salvoInfo && (
                  <div className="flex items-center gap-1.5">
                    <TargetIcon />
                    {salvoInfo.isPainting ? (
                      <span className="font-military text-xs text-[#ff6666] animate-pulse">LOCKS {salvoInfo.locks}/5</span>
                    ) : salvoInfo.cooldown > 0 ? (
                      <span className="font-tech text-xs text-[#a89d7c]">{salvoInfo.cooldown}s</span>
                    ) : (
                      <span className="font-military text-xs text-[#8df578]">SALVO READY</span>
                    )}
                  </div>
                )}

                {/* Devastation Super */}
                {superInfo && (
                  <div className="flex items-center gap-1.5 border-l border-[#3d4a30] pl-2.5">
                    <Zap size={12} className={superInfo.ready ? 'text-[#ffcc00]' : 'text-[#a89d7c]'} />
                    {superInfo.ready ? (
                      <span className="font-military text-xs text-[#ffcc00] animate-pulse">SUPER READY — CLICK</span>
                    ) : (
                      <span className="font-tech text-xs text-[#ded6be]">SUPER {Math.round(superInfo.charge)}%</span>
                    )}
                  </div>
                )}
              </div>
            </div>
            )}
          </div>
        )}

        {/* ══ BOTTOM-RIGHT: Credits, Score, Unsecured Pay ══ */}
        {mode === 'playing' && (
          <div className={`pointer-events-none absolute right-3 flex flex-col items-end gap-1.5 z-30 sm:right-4 ${touchDevice ? 'bottom-64' : 'bottom-4'}`}>
            <div className="hs-panel px-3.5 py-2 min-w-[170px] flex flex-col gap-1">
              <div className="flex justify-between items-center">
                <span className="font-hud text-xs font-bold text-[#a89d7c] tracking-wider">CREDITS</span>
                <span className="font-tech text-lg font-bold text-[#ffcc00] tabular-nums drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                  {credits.toLocaleString()} CR
                </span>
              </div>
              <div className="flex justify-between items-center border-t border-[#3d4a30] pt-1">
                <span className="font-hud text-xs font-bold text-[#a89d7c] tracking-wider">SCORE</span>
                <span className="font-tech text-sm font-bold text-white tabular-nums">
                  {score.toLocaleString()}
                </span>
              </div>
              {unsecuredCredits > 0 && (
                <div className="text-right font-hud text-xs font-bold text-[#ff9900] pt-0.5">
                  + {unsecuredCredits.toLocaleString()} UNSECURED
                </div>
              )}
            </div>
          </div>
        )}

        {/* Contextual onboarding hints (fades after 4s) */}
        {mode === 'playing' && !touchDevice && <ControlHints runId={hintsKey} />}
      </div>

      {/* Wave Transition Banner — active between combat waves; never overlaps opening countdown */}
      {mode === 'playing' && waveMessage && opening?.phase !== 'countdown' && goFlash <= 0 && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <h2 className="arcade-title-hero whitespace-pre-line text-center drop-shadow-[0_4px_12px_rgba(0,0,0,0.9)]">
            {waveMessage}
          </h2>
        </div>
      )}

      {/* Opening countdown: Single unified, high-readability countdown */}
      {mode === 'playing' && !tutorial?.active && opening?.phase === 'countdown' && (
        <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2.5 bg-black/25 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 text-xs font-military tracking-[0.3em] text-[#ffcc00]">
            <span>★</span>
            <span>SORTIE COMMENCING</span>
            <span>★</span>
          </div>
          <div className="arcade-title-hero text-center text-5xl sm:text-6xl text-white drop-shadow-[0_0_24px_rgba(80,235,255,0.7)]">
            GET READY — {opening.count ?? 3}
          </div>
          <div className="rounded border border-[#8df578]/40 bg-black/70 px-3 py-1 text-xs font-military tracking-[0.24em] text-[#8df578] shadow-lg backdrop-blur-xs">
            INVULNERABILITY SHIELD ACTIVE
          </div>
        </div>
      )}
      {mode === 'playing' && goFlash > 0 && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/20">
          <div className="arcade-title-hero text-8xl text-[#6ee740] drop-shadow-[0_0_30px_#6ee740] animate-ping">GO!</div>
        </div>
      )}

      {/* First-run interactive tutorial card */}
      {mode === 'playing' && tutorial?.active && (
        <div className="absolute bottom-24 left-1/2 z-30 w-[min(450px,90vw)] -translate-x-1/2">
          <div className="menu-card px-4 py-3 text-center">
            <div className="flex items-center justify-between">
              <span className="mil-label">
                TUTORIAL STEP {(tutorial.index ?? 0) + 1}/{tutorial.total ?? 0}
              </span>
              <button
                type="button"
                onClick={() => engineRef.current?.skipTutorial()}
                className="pointer-events-auto text-[9px] font-military text-[#a89d7c] hover:text-[#ffcc00]"
              >
                SKIP TUTORIAL
              </button>
            </div>
            <div className="arcade-title-md mt-1 text-white">
              {tutorial.title}
            </div>
            <div className="mt-1 text-xs font-semibold text-[#ded6be]">
              {tutorial.desc}
            </div>
            <div className="mt-2 flex gap-1">
              {Array.from({ length: tutorial.total ?? 0 }).map((_, i) => (
                <div key={i} className={`h-1.5 flex-1 rounded-[1px] ${i <= (tutorial.index ?? 0) ? 'bg-[#ffcc00]' : 'bg-[#0f130c]'}`} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Touch controls */}
      {mode === 'playing' && touchDevice && (
        <div className="absolute inset-0 z-30">
          <VirtualJoystick side="left" onStick={dispatchStick('helistrike:left-stick')} />
          <VirtualJoystick side="right" onStick={dispatchStick('helistrike:right-stick')} />
          <FireButton onFire={setFire} />
          <button
            type="button"
            aria-label="Deploy flares to break missile locks"
            onPointerDown={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('helistrike:countermeasure')); }}
            className="pointer-events-auto absolute bottom-36 right-8 flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-full border-2 border-[#f5ba2c] bg-[#332205]/90 text-[10px] font-military text-[#ffcc00] shadow-lg"
          >
            <span aria-hidden="true">🔥</span>
            FLARES
          </button>
          <button
            type="button"
            aria-label="Trigger Devastation super attack when meter is full"
            onPointerDown={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('helistrike:super')); }}
            className="pointer-events-auto absolute bottom-56 right-8 flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-full border-2 border-[#d32f2f] bg-[#4a0808]/90 text-[10px] font-military text-[#ff8a8a] shadow-lg"
          >
            <span aria-hidden="true">💥</span>
            SUPER
          </button>
        </div>
      )}

      {mode === 'paused' && (
        <PauseOverlay
          onResume={resumeGame}
          onRestart={restartRun}
          onSettings={() => setShowSettings(true)}
          onQuit={quitToMenu}
        />
      )}

      {/* Level-Up Upgrade Cards */}
      {upgradeOffer && mode === 'playing' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#0d0f0a]/80 px-3 py-4 backdrop-blur-[2px]">
          <div className="menu-card w-[min(720px,94vw)] p-5 sm:p-7">
            <span className="mil-rivet mil-rivet-tl" />
            <span className="mil-rivet mil-rivet-tr" />
            <span className="mil-rivet mil-rivet-bl" />
            <span className="mil-rivet mil-rivet-br" />

            <div className="mil-hazard-strip mb-3 rounded-[1px]" />

            <div className="menu-title-slab mb-4 text-center">
              <div className="flex items-center justify-center gap-1.5 text-[10px] font-military tracking-[0.26em] text-[#ffcc00] text-center w-full">
                <Zap size={12} className="text-[#ffcc00]" />
                <span>FIELD PROMOTION</span>
                <Zap size={12} className="text-[#ffcc00]" />
              </div>
              <h2 className="arcade-title-lg my-1 text-center w-full whitespace-nowrap">LEVEL UP!</h2>
              <div className="text-[10px] font-military tracking-[0.18em] text-[#a89d7c] text-center w-full">
                SELECT ONE TACTICAL UPGRADE PROTOCOL
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
              {upgradeOffer.map((opt, idx) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => { uiClick(); chooseUpgrade(opt.id); }}
                  className="group relative flex flex-col items-center gap-2 mil-panel px-4 py-5 text-center transition hover:-translate-y-1 active:translate-y-0.5 hover:border-[#ffcc00] hover:shadow-[0_0_18px_rgba(255,204,0,0.4)]"
                >
                  <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded-[2px] bg-[#141a0f] border border-[#ffcc00]/50 text-[9px] font-tech font-bold text-[#ffcc00] shadow-[0_0_6px_rgba(255,204,0,0.2)]">
                    KEY [{idx + 1}]
                  </div>
                  <span className="text-4xl transition-transform group-hover:scale-110 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)] mt-1">{opt.icon}</span>
                  <span className="text-[9px] font-military tracking-[0.2em] text-[#a89d7c] uppercase">{opt.category}</span>
                  <span className="text-sm font-military tracking-wide text-[#ffcc00]">{opt.title}</span>
                  <span className="text-xs font-semibold leading-snug text-[#ded6be] min-h-10">{opt.desc}</span>
                  <span className="mt-2 mil-btn mil-btn-primary mil-btn-sm w-full py-1 text-[10px] tracking-[0.14em]">
                    EQUIP [KEY {idx + 1}]
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-4 text-center text-[10px] font-military tracking-wider text-[#a89d7c]">
              SIMULATION PAUSED — CHOOSE PROTOCOL TO CONTINUE SORTIE
            </div>

            <div className="mil-hazard-strip mt-3 rounded-[1px]" />
          </div>
        </div>
      )}

      {/* Wave 10 Post-Boss Tactical Decision Modal */}
      {postBossModal.open && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="mil-panel flex w-full max-w-md flex-col p-6 text-center border-[#55f2a2] shadow-[0_0_30px_rgba(85,242,162,0.3)]">
            <div className="mil-hazard-strip rounded-[1px] mb-3" />
            <div className="text-xs font-military tracking-[0.25em] text-[#55f2a2]">MISSION ACCOMPLISHED</div>
            <h2 className="mt-1 text-xl font-military font-bold text-white tracking-wider">HEAVY GUNSHIP DESTROYED</h2>

            <div className="mt-4 mil-panel bg-[#12161a] p-4 text-left font-tech text-xs space-y-2">
              <div className="flex justify-between border-b border-[#2d3b45] pb-1.5">
                <span className="text-[#a89d7c]">CREDITS EARNED</span>
                <span className="font-bold text-[#ffcc00]">{postBossModal.credits.toLocaleString()} CR</span>
              </div>
              <div className="flex justify-between border-b border-[#2d3b45] pb-1.5">
                <span className="text-[#a89d7c]">SALVAGE COLLECTED</span>
                <span className="font-bold text-[#55f2a2]">{postBossModal.salvage}</span>
              </div>
              <div className="flex justify-between border-b border-[#2d3b45] pb-1.5">
                <span className="text-[#a89d7c]">AIR / GROUND KILLS</span>
                <span className="font-bold text-white">{postBossModal.kills}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#a89d7c]">FINAL SCORE</span>
                <span className="font-bold text-[#7df9ff]">{postBossModal.score.toLocaleString()}</span>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-3">
              <button
                type="button"
                onClick={() => {
                  uiClick();
                  setPostBossModal((m) => ({ ...m, open: false }));
                  engineRef.current?.handleExtractSafely(performance.now() / 1000);
                }}
                className="mil-btn mil-btn-primary py-3 text-sm font-bold tracking-wider"
              >
                EXTRACT SAFELY (BANK REWARDS)
              </button>
              <button
                type="button"
                onClick={() => {
                  uiClick();
                  setPostBossModal((m) => ({ ...m, open: false }));
                  engineRef.current?.handleChooseOverdrive(performance.now() / 1000);
                }}
                className="mil-btn mil-btn-secondary py-3 text-sm font-bold tracking-wider text-[#ffaa00] border-[#ffaa00]/60 hover:bg-[#ffaa00]/20"
              >
                ENDLESS OVERDRIVE (WAVE 11+ · ×{postBossModal.overdriveMultiplier.toFixed(2)})
              </button>
            </div>
            <div className="mil-hazard-strip rounded-[1px] mt-4" />
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onChange={applySettings}
          onClose={() => setShowSettings(false)}
          onReplayTutorial={replayTutorial}
          onUiSound={uiClick}
        />
      )}

      {showHangar && mode === 'menu' && (
        <HangarScreen
          mastery={mastery}
          playerModel={playerModel}
          credits={credits}
          hangarUpgrades={hangarUpgrades}
          perks={perks}
          weaponMods={weaponMods}
          isNewPilot={isNewPilot}
          onSelectModel={selectPlayerModel}
          onBuyUpgrade={purchaseHangarUpgrade}
          onBuyPerk={purchasePerk}
          onSelectMod={selectWeaponMod}
          onBack={() => setShowHangar(false)}
          onUiSound={uiClick}
        />
      )}

      {(mode === 'menu' || mode === 'gameover') && !showHangar && (
        <ThreeDMenu
          mode={mode}
          score={score}
          highScore={highScore}
          wave={wave}
          isNewBest={isNewBest}
          stats={runStats}
          history={runHistory}
          difficulty={settings.difficulty}
          credits={credits}
          isNewPilot={isNewPilot}
          playerModel={playerModel}
          onStart={startRun}
          onSettings={() => setShowSettings(true)}
          onHangar={() => setShowHangar(true)}
          onHelp={() => setShowHelp(true)}
          onMenu={quitToMenu}
          onUiSound={uiClick}
          onUiHover={uiHover}
        />
      )}

      {/* DEV-only damage diagnostics — last hit source, amount, time & position */}
      {import.meta.env.DEV && devDamage && mode === 'playing' && (
        <div className="pointer-events-none absolute bottom-2 right-2 z-30 rounded-[5px] border border-[#ff9b3d]/50 bg-black/60 px-2 py-1 font-mono text-[10px] font-bold leading-tight text-[#ffbd3f] shadow-[0_2px_8px_rgba(0,0,0,0.35)]">
          <div>LAST DMG: {devDamage.source} · {devDamage.damageType} · {devDamage.amount.toFixed(1)}</div>
          <div>t={devDamage.time.toFixed(1)}s · pos ({devDamage.x.toFixed(0)}, {devDamage.y.toFixed(0)}, {devDamage.z.toFixed(0)})</div>
        </div>
      )}

      {/* On-screen perf overlay (dev aid) — F2 toggles, hidden on touch devices */}
      {showPerf && perfAllowed && !touchDevice && perfStats && (
        <div className="pointer-events-none absolute bottom-2 left-2 z-30 select-none rounded-[5px] border border-white/20 bg-black/55 px-2 py-1 font-mono text-[10px] font-bold leading-tight text-[#ffe66d] shadow-[0_2px_8px_rgba(0,0,0,0.35)]" style={textShadow}>
          <div>{perfStats.fps} FPS · {perfStats.avgFrameMs}ms avg · {perfStats.p95FrameMs}ms p95 · {perfStats.worstFrameMs}ms max</div>
          <div>{perfStats.drawCalls} DC · {(perfStats.triangles / 1000).toFixed(1)}k TRI · {perfStats.graphics.toUpperCase()}{perfStats.governorLevel > 0 ? ` · G${perfStats.governorLevel}` : ''}</div>
          <div className="text-white/75">
            {perfStats.geometries} GEO · {perfStats.textures} TEX · {perfStats.programs} PROG · {perfStats.sceneObjects} OBJ
          </div>
          <div className="text-[#ffe66d]">
            {perfStats.enemies} EN · {perfStats.playerProjectiles}+{perfStats.enemyProjectiles} PROJ · {perfStats.particles} PART · {perfStats.physicsBodies} BOD
          </div>
          {perfStats.combatDirector && (
            <div className="mt-1 border-t border-white/20 pt-1 text-[9.5px]">
              <div className="text-[#38ef7d]">
                WAVE {perfStats.combatDirector.wave} · INTENSITY: {perfStats.combatDirector.combatIntensity.toFixed(2)} · POP: {perfStats.combatDirector.activeEnemies}/{perfStats.combatDirector.targetEnemies} (max 48)
              </div>
              <div className="text-[#50ebff]">
                THREAT: GND {perfStats.combatDirector.groundThreat}/{perfStats.combatDirector.targetGroundThreat} · AIR {perfStats.combatDirector.airThreat}/{perfStats.combatDirector.targetAirThreat}
              </div>
              <div className="text-[#ffd000]">
                AIR SLOTS: {perfStats.combatDirector.activeAirAttackers}/{perfStats.combatDirector.maxAirAttackSlots} · HEAVY: {perfStats.combatDirector.activeHeavyAttacks}/{perfStats.combatDirector.maxHeavyAttacks} · ROT GAP: {perfStats.combatDirector.attackRotationDelay.toFixed(2)}s
              </div>
              <div className="text-[#ff9b3d]">
                SPAWN: {perfStats.combatDirector.spawnInterval.toFixed(2)}s · QUEUE: {perfStats.combatDirector.spawnQueueLength ?? 0} · BIAS: {perfStats.combatDirector.currentDirectionalBias} ({perfStats.combatDirector.directionalMode})
                {perfStats.combatDirector.isMicroLull ? ` · [MICRO-LULL ${perfStats.combatDirector.microLullRemaining.toFixed(1)}s]` : ''}
              </div>
              <div className="text-[#e0aaff]">
                EVENTS: PRIORITY {perfStats.combatDirector.priorityTargetActive ? 'ACTIVE' : 'NONE'} · RISK {perfStats.combatDirector.pickupRiskActive ? 'ACTIVE' : 'NONE'}
              </div>
              <div className="text-white/80">
                SCALING: HP {perfStats.combatDirector.hpScale.toFixed(2)}× · DMG {perfStats.combatDirector.damageScale.toFixed(2)}× · SPD {perfStats.combatDirector.speedScale.toFixed(2)}×
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
