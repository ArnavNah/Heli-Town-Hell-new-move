import * as THREE from "three";
import * as CANNON from "cannon-es";
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** PS1-style post pass: quantizes the final image to a coarse palette with a
 *  4x4 ordered (Bayer-ish) dither, recreating the console's limited color
 *  depth and characteristic dithered gradients. Runs after OutputPass. */
const RetroDitherShader = {
  name: 'RetroDitherShader',
  uniforms: {
    tDiffuse: { value: null },
    uLevels: { value: 24 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uLevels;
    varying vec2 vUv;

    // 16-value ordered dither pattern built from two nested 2x2 patterns.
    float orderedDither(vec2 p) {
      p = floor(mod(p, 4.0));
      float base = mod(p.x, 2.0) + 2.0 * mod(p.y, 2.0);        // 0..3
      float quad = floor(p.x / 2.0) + 2.0 * floor(p.y / 2.0);  // 0..3
      return fract(base / 4.0 + quad / 16.0);
    }

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float n = orderedDither(gl_FragCoord.xy) - 0.5;
      vec3 col = floor(c.rgb * uLevels + n + 0.5) / uLevels;
      gl_FragColor = vec4(col, c.a);
    }`,
};

/** Per-wave-theme color grade: tint multiply + exposure bias + saturation
 *  shift. Sits BEFORE OutputPass so the grade happens in linear working
 *  space, and eases toward its target (~1.5s) whenever the wave theme rolls.
 *  FRENZY warms the frame into an orange haze; NIGHT_SURGE cools and
 *  desaturates it into a steel-blue night. */
const ThemeGradeShader = {
  name: 'ThemeGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uExposure: { value: 1 },
    uSaturation: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uTint;
    uniform float uExposure;
    uniform float uSaturation;
    varying vec2 vUv;

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb * uTint * uExposure;
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(luma), col, uSaturation);
      gl_FragColor = vec4(col, c.a);
    }`,
};

/** Neutral grade (no theme) — tint white, exposure/saturation untouched. */
const NEUTRAL_GRADE = { r: 1, g: 1, b: 1, exposure: 1, saturation: 1 };

import { AudioManager } from "../audio";
import { createBlobShadow, createGlowMaterial, createSkyDome, disposeObject3D } from "./materials";
import { Enemy, FLIGHT_SPEC, Helicopter, MOVEMENT_CONFIG, Objective, PowerUp, Projectile, ProjectilePool } from "./entities";
import { CityEnvironment } from "./city";
import {
  DeliveryState,
  DeliverySystem,
  cargoMovementMultiplier,
  readHangarUpgrades,
} from "./delivery";
import type { HangarUpgrades } from "./delivery";
import { MissionManager, MissionType, convoyPositionAt, type Mission, type MissionRuntimeSnapshot } from "./mission";
import { canUseDepotService, collectSalvage, rollLoot } from "./loot";
import { CombatDirector, PERFORMANCE_CAPS } from "./combatDirector";
import {
  SAM_DETECTION_RANGE,
  SAM_MIN_SPACING,
  SAM_MISSILE_TURN_RATE,
  SamState,
} from "./sam";
import { GPUParticleSystem, RainSystem, ShockwaveRings, VolumetricExplosions, WeatherSystem } from "./particles";
import { DebrisSystem } from "./debris";
import {
  AttackPattern,
  EnemyModifier,
  copyPhysicsPos,
  EnemyMovementClass,
  EnemyType,
  EnemyVariant,
  FOG_CLEAR_COLOR,
  FOG_NEAR,
  FOG_FAR,
  GameSettings,
  HelicopterModel,
  MAX_RENDER_PIXEL_RATIO,
  ObjectiveType,
  SKY_CLEAR_COLOR,
  StickInput,
  WEAPON_CONFIGS,
  WeaponConfig,
  WeaponType,
  PowerUpType,
  type MinimapSnapshot,
  type PriorityTargetInfo,
} from "./types";
import {
  accuracyFor,
  BOSS_TELEGRAPH_DURATION,
  bossPhaseForRatio,
  bossVolleyConfig,
  comboMultiplier,
  DIFFICULTIES,
  ENEMY_VARIANTS,
  GROUND_THREAT_COSTS,
  AIR_THREAT_COSTS,
  pickGroundComposition,
  pickMixedComposition,
  MAX_RUN_LEVEL,
  MAX_WEAPON_LEVEL,
  objectiveConfig,
  pickEnemyVariant,
  pickSquadForWave,
  pickUpgrades,
  riskMultiplier,
  variantAtCap,
  waveEnemyCount,
  waveEnemyDamage,
  waveEnemyFireRate,
  waveEnemyPower,
  waveDuration,
  waveThemeBanner,
  waveThemeFor,
  WAVE_THEMES,
  weaponLevelBonus,
  weaponLevelForXp,
  multikillTier,
  runLevelForXp,
  runXpForLevel,
  xpForEnemyType,
  writeMastery,
  compositionFitsBudget,
  computeCombatPay,
  FIRST_TIME_ACHIEVEMENTS,
  SPAWN_CONFIG,
  waveThreatBudget,
  affixChancesForWave,
  canOfferExtraction,
  createQualityGovernor,
  defaultPerks,
  enemyAimAccuracy,
  EXPLOSIVE_AFFIX_DAMAGE,
  EXPLOSIVE_AFFIX_RADIUS,
  EXTRACTION_HOLD_SECONDS,
  governorBloomAllowed,
  governorParticleScale,
  governorPixelScale,
  nightOpForWave,
  perkEffect,
  calculateDamageAffinity,
  readPerks,
  readProgress,
  readWeaponMods,
  recordRun,
  SPLITTER_DRONE_COUNT,
  statusProcChance,
  SUPER_COOLDOWN,
  SUPER_DURATION,
  SUPER_MAX_CHARGE,
  superChargeForKill,
  updateQualityGovernor,
  VAMPIRIC_HEAL_FRACTION,
  WAVE1_CONFIG,
  writeProgress,
  calculateCombatIntensity,
  enemyPopulationTarget,
  groundThreatTarget,
  airThreatTarget,
  calculateSpawnInterval,
  enemyHPScale,
  enemyDamageScale,
  enemySpeedScale,
  PRIORITY_TARGET_WAVE_CHANCE,
  PRIORITY_TARGET_OVERDRIVE_CHANCE,
  priorityTargetReward,
} from "./logic";
import type { Difficulty as DifficultySetting, PerkRanks, QualityGovernorState, TargetCategory, UpgradeId, UpgradeOption, WaveThemeConfig } from "./logic";
import { armorMitigation, resolvePlayerDamage, resolveRepair, type PlayerDamageType } from "./combat";
import { FloatingCombatTextManager, type CombatTextType } from "./floatingText";
import {
  CountermeasureState,
  countermeasureConfig,
  settleExtraction,
  salvageCreditsFor,
  salvageForObjective,
  securedEnemyBounty,
  securedObjectiveReward,
  THREAT_NAMES,
  threatDirectorConfig,
  threatBonusFor,
  threatLevelForPoints,
  threatRewardMultiplier,
  type ThreatLevel,
} from "./mechanics";

type DashState = "READY" | "DASHING" | "COOLDOWN";

/** Circular deadzone for the touch virtual-left-stick (mirrors the gamepad's).
 *  Below this travel magnitude no movement command is emitted, and response
 *  above it follows a gentle power curve so small deflections feel deliberate. */
const TOUCH_DEADZONE = 0.15;

/** First-run tutorial beats — one action at a time, each with a generous
 *  auto-advance so the tutorial can never soft-lock a run. */
const TUTORIAL_STEPS: { id: string; title: string; desc: string; autoSeconds: number }[] = [
  { id: "move", title: "MOVE", desc: "Fly with A/D yaw, W/S thrust and Q/E strafe", autoSeconds: 16 },
  { id: "aim", title: "AIM", desc: "Move the mouse to aim the chin gun", autoSeconds: 10 },
  { id: "fire", title: "FIRE", desc: "Hold LEFT MOUSE to fire the machine gun", autoSeconds: 12 },
  { id: "climb", title: "CLIMB", desc: "Hold SHIFT or SPACE to climb", autoSeconds: 8 },
  { id: "descend", title: "DESCEND", desc: "Hold CTRL to descend", autoSeconds: 8 },
  { id: "dodge", title: "EVADE", desc: "Incoming fire — dodge the tracer!", autoSeconds: 7 },
  { id: "flares", title: "FLARES", desc: "Press C to deploy countermeasure flares", autoSeconds: 10 },
  { id: "salvo", title: "LOCK SALVO", desc: "Hold RIGHT MOUSE to paint locks, release to fire", autoSeconds: 12 },
  { id: "devastation", title: "DEVASTATION", desc: "Trigger the Devastation super when the meter is full", autoSeconds: 6 },
  { id: "pause", title: "PAUSE", desc: "Press ESC or P to pause", autoSeconds: 8 },
];

const TUTORIAL_DONE_KEY = "helistrike:tutorialDone";

export class GameEngine {
  private static readonly MAX_SIMULATION_DT = 0.05;

  private static readonly _scratchFrustum = new THREE.Frustum();
  private static readonly _scratchMatrix = new THREE.Matrix4();
  private static readonly _scratchVec3 = new THREE.Vector3();
  private static readonly _scratchCamFwd = new THREE.Vector3();
  private static readonly _scratchCamRight = new THREE.Vector3();

  floatingCombatText: FloatingCombatTextManager;
  private overlayCanvas: HTMLCanvasElement | null = null;

  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cameraLookAtTarget: THREE.Vector3 = new THREE.Vector3();
  skyDome: THREE.Mesh;
  /** Layered sun disc (core + halo) used to frame the desert sun. */
  sunDisc: THREE.Group;
  renderer: THREE.WebGLRenderer;
  private canvas: HTMLCanvasElement;
  private contextLost = false;
  private tickErrorCount = 0;
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
    retroPass: ShaderPass;
  /** Wave-theme color grading pass (FRENZY warm haze, NIGHT_SURGE cool blue). */
  gradePass: ShaderPass;
  private gradeTarget = { ...NEUTRAL_GRADE };
  private gradeCurrent = { ...NEUTRAL_GRADE };
  /** Throttle for rotor-downwash dust spawning while hovering low. */
  private downwashTimer: number = 0;
  world: CANNON.World;
  city: CityEnvironment;
  delivery: DeliverySystem;
  missionManager = new MissionManager();
  hangarUpgrades: HangarUpgrades = readHangarUpgrades();

  helicopter: Helicopter;
  enemies: Enemy[] = [];
  combatDirector = new CombatDirector();

  playerProjectiles: ProjectilePool;
  enemyProjectiles: ProjectilePool;

  particles: GPUParticleSystem;
  volumetricExplosions: VolumetricExplosions;
  rain: RainSystem;
  weather: WeatherSystem;
  audio: AudioManager;
  lastTime: number = 0;

  settings: GameSettings = {
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
    cameraSensitivity: 1.0,
    cameraFollowMode: 'free',
  };

  get difficulty() {
    return DIFFICULTIES[this.settings.difficulty];
  }

  gamepadIndex: number | null = null;
  isMouseActive: boolean = true;
  playerModel: HelicopterModel = HelicopterModel.APACHE;
  movementKeys: Set<string> = new Set();
  leftStick: StickInput = { x: 0, y: 0, active: false };
  rightStick: StickInput = { x: 0, y: 0, active: false };
  movementTarget: THREE.Vector3 = new THREE.Vector3(0, FLIGHT_SPEC.spawnAltitude, 0);
  keyboardVelocity: THREE.Vector2 = new THREE.Vector2(0, 0);
  hasInputThisFrame: boolean = false;

  /** HUD feedback state — previous ready flags for transition cues and
   *  one-shot low-resource warnings (re-armed when resources recover). */
  private prevSalvoReady = true;
  private prevCountermeasuresReady = true;
  private prevSuperReady = false;
  private lowFuelWarned = false;
  private lowHullWarned = false;

  // Heading-relative flight input: yawInput = rudder (+1 right), keyboardVelocity
  // x/y = lateral strafe / cyclic thrust (+1 right / forward), verticalInput =
  // collective (+1 climb Shift / −1 descend Ctrl). Pad/touch analogs merge in
  // updateKeyboardMovement; gamepadMove x/z hold analog rudder/thrust, and
  // gamepadStrafe / gamepadVert carry D-pad strafe and collective.
  yawInput: number = 0;
  verticalInput: number = 0;
  gamepadMove: { x: number; z: number } = { x: 0, z: 0 };
  gamepadStrafe: number = 0;
  gamepadVert: number = 0;
  aimPoint: THREE.Vector3 = new THREE.Vector3(0, FLIGHT_SPEC.spawnAltitude, -35);
  mouseAimPoint: THREE.Vector3 = new THREE.Vector3(0, FLIGHT_SPEC.spawnAltitude, -55);
  mouseAimValid: boolean = false;
  autoAimTarget: Enemy | Objective | null = null;
  lastCollisionDamageTime = 0;

  // --- Opening sequence & spawn protection --------------------------------
  // countdown → grace → live. During countdown enemies hold fire, SAM sites
  // stay cold and collision damage is off; grace keeps the spawn shield up for
  // a few extra seconds after GO so the opening is never a damage race.
  openingPhase: "countdown" | "grace" | "live" = "live";
  private openingTimer = 0;
  private graceTimer = 0;
  private openingCountSent = 99;
  /** Seconds remaining of the wave-1 post-GO enemy fire silence. */
  private waveFireSilenceTimer = 0;
  /** True while any spawn protection is active (countdown + grace). */
  get openingProtected(): boolean {
    return this.openingPhase !== "live";
  }

  // --- First-run tutorial ---------------------------------------------------
  tutorialActive = false;
  tutorialStep = 0;
  private tutorialAutoTimer = 0;
  private tutorialDodgeTimer = 0;
  private tutorialShotsAtStart = 0;
  private tutorialAimOrigin = new THREE.Vector3();
  private tutorialPausedOnce = false;
  private tutorialFlareUsed = false;

  // --- Damage diagnostics & cause of death ----------------------------------
  lastDamageSource = "";
  lastDamageInfo: {
    source: string;
    damageType: PlayerDamageType;
    amount: number;
    time: number;
    x: number;
    y: number;
    z: number;
  } | null = null;
  /** Casual-only one-time auto repair (consumed at critical hull). */
  private emergencyRepairUsed = false;

  // Trailing smoke column after a hard building crash
  crashSmokeTimer: number = 0;
  crashSmokePos: { x: number; y: number; z: number } | null = null;

  raycaster: THREE.Raycaster = new THREE.Raycaster();
  mousePlane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -26);
  mouseNDC: THREE.Vector2 = new THREE.Vector2(0, 0);
  private worldUp = new THREE.Vector3(0, 1, 0);
  private mouseAimScratch = new THREE.Vector3();
  private muzzlePositionScratch = new THREE.Vector3();
  private muzzleDirectionScratch = new THREE.Vector3();

  targetGroup: THREE.Group;
  innerRing: THREE.Mesh;
  outerRing: THREE.Mesh;

  private animationFrameId: number | null = null;
  private frameCount = 0;
  private running = false;
  lightningTimeout: number | null = null;
  disposed = false;
  isPlaying = false;
  isPaused = false;
  gameOverDispatched = false;

  // Perf overlay support: a cheap rolling FPS counter and a public
  // getPerfStats() so the HUD can show renderer.info without polling GL.
  // FPS is measured from RAW frame deltas (never the clamped simulation
  // delta) so a hitched frame reports its true cost.
  fpsFrames = 0;
  fpsAccum = 0;
  fps = 60;
  /** Ring buffer of recent raw frame times (ms) for avg/p95/worst stats. */
  private frameMsRing = new Float32Array(240);
  private frameMsCount = 0;
  private frameMsIndex = 0;

  // A1/A2: rigid-body destruction debris + pooled dust shockwave rings.
  private debris: DebrisSystem | null = null;
  private shockwaves: ShockwaveRings | null = null;

  // Fake blob shadows (shadowMap stays disabled for perf): one decal under the
  // player, one pooled per active enemy. They sit ALONG the sun's shadow axis
  // (offset opposite the key light ~ (-48,86,54)) so they read as cast contact
  // shadows that spread with altitude instead of static discs stuck underfoot.
  private playerShadow: THREE.Mesh;
  private enemyShadows = new Map<Enemy, THREE.Mesh>();
  private shadowSeenSet = new Set<Enemy>();
  // Horizontal shadow-cast direction, normalized (the key light sits roughly SW
  // of the scene, so cast shadows fall toward +x / -z).
  private readonly sunShadowDir = new THREE.Vector3(0.66, 0, -0.75).normalize();
  private readonly sunShadowOffsetPerU = 0.09;

  // A4: adaptive quality governor — degrades pixel ratio/bloom/particles in
  // 1.5s FPS windows, never above the user's chosen quality preset.
  private governor: QualityGovernorState = createQualityGovernor();
  private governorWindowFrames = 0;
  private governorWindowTime = 0;

  // C3: Night ops — wave-scoped palette swap. The blend eases between the
  // desert-day baseline and a deep-navy night rig over a couple of seconds.
  private ambientLight!: THREE.HemisphereLight;
  private keyLight!: THREE.DirectionalLight;
  private nightOpsActive = false;
  private nightBlend = 0;
  private nightBlendTarget = 0;
  private nightSeed = Math.floor(Math.random() * 0x7fffffff);
  private nightBeams: THREE.Group | null = null;
  private readonly dayFogColor = new THREE.Color(FOG_CLEAR_COLOR);
  private readonly nightFogColor = new THREE.Color(0x0b1226);
  private readonly daySkyColor = new THREE.Color(SKY_CLEAR_COLOR);
  private readonly nightSkyColor = new THREE.Color(0x070d1c);
  private readonly dayHemiSky = new THREE.Color(0xf6ecd8);
  private readonly nightHemiSky = new THREE.Color(0x22314f);
  private readonly dayHemiGround = new THREE.Color(0x8a7a58);
  private readonly nightHemiGround = new THREE.Color(0x0d1220);
  private readonly dayKeyColor = new THREE.Color(0xffe3b0);
  private readonly nightKeyColor = new THREE.Color(0x7f9fd8);

  // B3: Devastation super meter — kills/combos charge it; F unleashes a 5s overcharge.
  superCharge = 0;
  private superActiveUntil = 0;
  private superCooldownUntil = 0;

  // C5/C6: persistent pilot perks + per-weapon mod choices (loaded from storage).
  private perks: PerkRanks = defaultPerks();
  private weaponMods: number[] = [0, 0, 0, 0];

  // 6d: speed lines — thin streaks that appear at screen edges during afterburner.
  private speedLines: THREE.Mesh[] = [];
  private speedLineTimer = 0;

  // C1: extraction gating — objectives destroyed this run + once-per-run offer.
  objectivesDestroyedThisRun = 0;
  private extractionOfferedThisRun = false;

  // Phase 1: reused wind vector — was allocated every frame in tick().
  private windCannon = new CANNON.Vec3();

  // Phase 1: dev-only memory monitor (Step 9). Opt-in via
  // localStorage 'helistrike:memmon' = '1'; compile-time stripped in prod
  // builds. Logs a resource snapshot every 2s.
  private memMon = import.meta.env.DEV
    && typeof localStorage !== "undefined"
    && localStorage.getItem("helistrike:memmon") === "1";
  private memMonTimer = 0;
  isFiringMouse = false;
  isFiringGamepad = false;
  score = 0;
  totalKills = 0;
  shotsFired = 0;
  shotsHit = 0;
  health = 100;
  maxHealth = 100;
  currentFuel = 100;
  maxFuel = 100;
  fuelDrainPerSecond = 0.85;

  // Stable camera state. No random or impulse offset is ever composed onto it.
  private baseCamPos = new THREE.Vector3(0, 62, 46);
  private smoothedLookAhead = new THREE.Vector2(0, 0);
  private cameraTargetPosScratch = new THREE.Vector3();
  cameraFollowError: number = 0;

  // Free 360° Camera Orbit System
  cameraYaw: number = 0;
  targetCameraYawVelocity: number = 0;
  currentCameraYawVelocity: number = 0;
  isRecenteringCamera: boolean = false;
  private recenterStartYaw: number = 0;
  private recenterTargetYaw: number = 0;
  private recenterTimer: number = 0;
  readonly recenterDuration: number = 0.30;
  lastCameraInputTime: number = 0;
  cameraBoomFraction: number = 1.0;
  isMiddleMouseOrbiting: boolean = false;
  lastPointerX: number = 0;
  lastPointerY: number = 0;
  private prevR3Pressed: boolean = false;
  lastStatsHealth = -1;
  lastStatsFuel = -1;
  lastUiUpdateTime = -Infinity;
  survivalTime = 0;
  combatIntensity = 0;
  directorTimer = 0;
  battlefieldEventTimer = 18;
  lastSpawnSoundTime = 0;
  lastBuildingHitSoundTime = 0;
  /** Cooldown for volatile-prop explosion audio — prevents clipping during chain reactions. */
  private lastPropExplosionSoundTime = 0;
  lastEnemyFireSoundTime = 0;

  // Wave System
  currentWave: number = 0;
  enemiesSpawnedInWave: number = 0;
  totalEnemiesInWave: number = 0;
  spawnTimer: number = 0;
  waveTransitionTimer: number = 3.0; // Wait 3s before starting wave 1
  waveTimer: number = 0; // Seconds elapsed in the current time-driven wave
  waveMessage: string = "";
  /** Procedural theme ("hand") for the current non-milestone wave, or null on a
   *  milestone (boss/miniboss) wave. Rolls in startNextWave and reshapes the
   *  horde, hulls, cadence, elite chance, weather, and banner. */
  currentWaveTheme: WaveThemeConfig | null = null;
  minibossSpawnedThisWave: boolean = false;

  // Phase 3: bounded spawn queue — horde bursts drain ONE enemy per cadence
  // tick (frame budget = 1) so large groups stream in instead of constructing
  // several full procedural models in a single frame.
  private pendingSpawns = 0;
  private waveThreatBudgetRemaining = 0;
  private processedEnemyDeaths = new WeakSet<Enemy>();
  /** Variant requests queued for the current burst — squads push several,
   *  drained one per cadence tick (bounded, cleared on restart). */
  private pendingVariantQueue: EnemyVariant[] = [];
  /** Phase 3: lightweight event/escort spawn descriptors (no Enemy is
   *  constructed until drained) so convoy ambushes, air raids and boss escorts
   *  stagger across frames instead of spiking one frame. */
  private pendingEventSpawns: Array<{
    type: EnemyType;
    x: number;
    z: number;
    y: number;
    modifier?: EnemyModifier;
    pattern?: AttackPattern;
    variant?: EnemyVariant;
  }> = [];

  // Destroyable combat objectives. Cargo depots live in DeliverySystem instead.
  objectives: Objective[] = [];
  samSuppressionTimer: number = 0; // enemy fire-rate debuff while > 0
  samActive: boolean = false; // any SAM site alive boosts enemy fire rate
  radarActive: boolean = false; // modest enemy acquisition + nearby SAM uplink
  samSiteAnnouncedThisRun: boolean = false;
  radarSiteAnnouncedThisRun: boolean = false;
  airThreatAnnouncedThisRun: boolean = false;
  desiredGroundThreat: number = 0;
  desiredAirThreat: number = 0;
  currentGroundThreat: number = 0;
  currentAirThreat: number = 0;
  isOverdrive: boolean = false;
  overdriveMultiplier: number = 1.0;
  postBossDecisionPending: boolean = false;
  postBossDecisionTimer: number = 0;
  postBossDecisionAvailable: boolean = false;
  private microLullTimer: number = 28.0;
  private microLullActiveTimer: number = 0;

  // Priority Target & Pickup-Risk systems
  priorityTargetEnemy: Enemy | null = null;
  private priorityTargetCooldown: number = 18.0;
  private priorityTargetAnnouncedAt: number = 0;
  private priorityTargetInfo: PriorityTargetInfo | null = null;
  pickupRiskActive: boolean = false;
  private pickupRiskTimer: number = 0;

  // Weapon XP & levels
  weaponXp: Map<WeaponType, number> = new Map();
  weaponLevels: Map<WeaponType, number> = new Map();
  lastFiredWeapon: WeaponType = WeaponType.MACHINE_GUN;
  lastFireTimestamp: number = 0;

  // Permanent run upgrades (from the roulette)
  runUpgrades: Record<UpgradeId, number> = {
    damage: 0,
    fireRate: 0,
    ammo: 0,
    reload: 0,
    salvoCooldown: 0,
    maxHealth: 0,
    fuelEfficiency: 0,
    shield: 0,
    speed: 0,
    armor: 0,
    repair: 0,
    xpMagnet: 0,
    dashCooldown: 0,
    bomb: 0,
    incendiary: 0,
    empPayload: 0,
    shockCoils: 0,
  };
  pendingUpgradeOffer: UpgradeOption[] = [];
  upgradePaused: boolean = false;

  // Kill streaks & announcements
  killStreakCount: number = 0;
  lastKillTime: number = 0;
  announceQueue: { text: string; sub: string; color: string }[] = [];

  // Afterburner (risk/reward)
  afterburnerActive: boolean = false;
  afterburnerDrainPerSecond: number = 3.2;
  private afterburnerEffectTimer = 0;

  // 2m: per-frame particle budget — prevents frame spikes during chain reactions.
  private particleBudgetThisFrame = 0;
  private static readonly PARTICLE_BUDGET_PER_FRAME = 180;



  // Run-scoped tactical systems. These never round-trip through React per frame.
  countermeasures = new CountermeasureState(countermeasureConfig(0));
  private decoyTarget: { body: CANNON.Body; active: boolean } | null = null;
  private flareEffectTimer = 0;
  private lastMissileWarningTime = -Infinity;
  threatPoints = 0;
  threatLevel: ThreatLevel = 1;
  unsecuredCredits = 0;
  runSalvage = 0;
  deliveriesCompleted = 0;
  samSitesDestroyed = 0;
  radarSitesDestroyed = 0;
  bossesDestroyed = 0;
  missionsCompleted = 0;
  missionBonusesCompleted = 0;
  private extractionMarker: THREE.Group | null = null;
  private extractionPosition: THREE.Vector3 | null = null;
  private extractionProgress = 0;
  private extractionOfferLevel = 1;
  private extractionOfferTime = 0;
  private extractionPressure = false;
  /** Brief green radar-sweep rings that ping outward when the LZ offer
   *  appears, so the pad draws the eye from far away. Owned by the marker
   *  group (disposed by clearExtraction); this array just drops the refs. */
  private extractionPulseRings: THREE.Mesh[] = [];
  private extractionPulseTimer = 0;
  private depotServiceCooldown = 0;
  private static readonly EXTRACTION_PULSE_DURATION = 2.0;
  private static readonly EXTRACTION_PULSE_RADIUS = 130;
  /** Horizontal radius of the extraction zone (must match the inside check). */
  private static readonly EXTRACTION_ZONE_RADIUS = 26;

  // Power-up System
  powerups: PowerUp[] = [];
  powerupSpawnTimer: number = 0;

  spawnPeriodicPowerUp() {
    let type: PowerUpType;
    const rand = Math.random();
    
    const weapon = this.weapons.get(this.currentWeapon);
    const lowHealth = this.health < 40;
    const lowFuel = this.currentFuel < 35;
    const lowAmmo = weapon && (weapon.ammo / weapon.maxAmmo) < 0.25;
    
    if (lowHealth && Math.random() < 0.55) {
      type = PowerUpType.HEALTH;
    } else if (lowFuel && Math.random() < 0.55) {
      type = PowerUpType.FUEL;
    } else if (lowAmmo && Math.random() < 0.55) {
      type = PowerUpType.AMMO;
    } else {
      if (rand < 0.22) type = PowerUpType.HEALTH;
      else if (rand < 0.38) type = PowerUpType.FUEL;
      else if (rand < 0.52) type = PowerUpType.AMMO;
      else if (rand < 0.68) type = PowerUpType.DAMAGE_BOOST;
      else if (rand < 0.82) type = PowerUpType.SHIELD;
      else if (rand < 0.92) type = PowerUpType.SPEED_BOOST;
      else type = PowerUpType.BOMB;
    }
    
    const player = this.helicopter.body.position;
    const lanes = [-52, -24, 0, 24, 52];
    const laneX = lanes[Math.floor(Math.random() * lanes.length)] + (Math.random() - 0.5) * 8;
    const spawnZ = player.z - 75 - Math.random() * 45;
    const spawnY = Math.max(3.0, this.city.getHeightAt(laneX, spawnZ, 3) + 2.0);
    
    const pu = new PowerUp(this.scene, laneX, spawnY, spawnZ, type);
    pu.spawnTime = performance.now() / 1000;
    this.powerups.push(pu);
  }

  // Combo System
  comboCount: number = 0;
  comboTimer: number = 0;
  comboMultiplier: number = 1;
  maxCombo: number = 0;

  // Run-level XP (Vampire-Survivors style): collect XP gems dropped by enemies
  // to fill a run level bar; each level-up opens the 1-of-3 upgrade roulette.
  runLevel: number = 1;
  runXp: number = 0;
  /** Level-ups queued when one gem crosses several thresholds (boss gems). */
  pendingLevelUps: number = 0;

  // Damage Boost, Shield, Speed Boost & Magnet Surge
  damageBoostTimer: number = 0;
  shieldTimer: number = 0;
  speedBoostTimer: number = 0;
  magnetSurgeTimer: number = 0;

  // Time dilation & Hit-Stop
  timeScale: number = 1.0;
  hitStopTimer: number = 0;

  triggerHitStop(duration: number, scale: number = 0.05) {
    this.hitStopTimer = duration;
    this.timeScale = scale;
  }

  // Dash variables
  dashState: DashState = "READY";
  dashCooldownTimer: number = 0;
  dashActiveTimer: number = 0;
  dashDirection: CANNON.Vec3 = new CANNON.Vec3();
  lastTapTime: { [key: string]: number } = {};

  // Hit marker for visual feedback
  hitMarkerTimer: number = 0;
  hitMarkerPosition: THREE.Vector3 = new THREE.Vector3();

  // Weapon System
  currentWeapon: WeaponType = WeaponType.MACHINE_GUN;
  weapons: Map<WeaponType, WeaponConfig> = new Map();
  lastFireTime: number = 0;
  muzzleFlip: number = 1;
  reloadTimer: number = 0;
  isReloading: boolean = false;
  isPaintingLocks: boolean = false;
  salvoLocks: Enemy[] = [];
  salvoCooldownTimer: number = 0;
  lastLockPaintTime: number = 0;
  salvoCooldown: number = 5.0;
  lockPaintInterval: number = 0.18;
  lockSearchRadius: number = 38;
  salvoLockIndicators: Map<Enemy, THREE.Group> = new Map();

  getEffectiveSalvoCooldown() {
    return Math.max(1.5, this.salvoCooldown * (1 - this.runUpgrades.salvoCooldown * 0.35));
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_RENDER_PIXEL_RATIO));
    this.renderer.setClearColor(SKY_CLEAR_COLOR);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Low-poly pass: ACES filmic tone mapping was crushing the muted city
    // palette into a dark night haze. Stylized low-poly art wants flat colors
    // to stay flat and bright, so tone mapping is off (NoToneMapping).
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_CLEAR_COLOR);
    this.scene.fog = new THREE.Fog(FOG_CLEAR_COLOR, FOG_NEAR, FOG_FAR);
    this.skyDome = createSkyDome();
    this.scene.add(this.skyDome);

    // far must exceed FOG_FAR (440) and the sky dome radius (340), otherwise
    // the horizon band is clipped to the clear color instead of the haze.
    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      0.1,
      500,
    );
    this.camera.position.set(0, 62, 46);
    this.camera.lookAt(0, 0, 0);

    // EffectComposer Setup
    this.composer = new EffectComposer(this.renderer);
    
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    // Toned-down bloom: subtler glow so the scene doesn't wash out.
    this.bloomPass.threshold = 0.88;
    this.bloomPass.strength = 0.32;
    this.bloomPass.radius = 0.35;
    this.bloomPass.enabled = this.settings.graphics === 'hd';
    this.composer.addPass(this.bloomPass);

    // Wave-theme color grading — before OutputPass so it grades in linear
    // space; targets are swapped in startNextWave and eased in updateThemeGrading.
    this.gradePass = new ShaderPass(ThemeGradeShader);
    this.composer.addPass(this.gradePass);

    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    // WebGL context loss recovery — prevents permanent crash on GPU reset,
    // tab sleep, or mobile background/foreground cycles.
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    // PS1-style finish: quantize colors to a coarse palette with ordered
    // (Bayer) dithering, mimicking the console's limited color depth.
    this.retroPass = new ShaderPass(RetroDitherShader);
    this.composer.addPass(this.retroPass);

    this.world = new CANNON.World();
    // Player altitude is controlled explicitly; zero world gravity keeps hover
    // deterministic across Cannon's variable number of fixed substeps.
    this.world.gravity.set(0, 0, 0);
    // NaiveBroadphase recomputes AABB pairs every step, so it never misses
    // contacts between the heli and static bodies added mid-run (chunks) or
    // teleported (debris pool). SAPBroadphase's sorted-axis cache goes stale
    // in exactly those cases and the heli phased through buildings.
    this.world.broadphase = new CANNON.NaiveBroadphase();
    this.world.defaultContactMaterial.friction = 0;
    this.world.defaultContactMaterial.restitution = 0;

    // Sunny coastal warzone lighting: crisp warm key + vibrant sky hemisphere fill
    // so low-poly faceted toon bands pop with high contrast and tabletop clarity.
    const ambient = new THREE.HemisphereLight(0x88c8f8, 0xdcb880, 1.35);
    this.ambientLight = ambient;
    this.scene.add(ambient);

    const softKey = new THREE.DirectionalLight(0xfff2d4, 1.9);
    this.keyLight = softKey;
    softKey.position.set(-48, 86, 54);
    softKey.castShadow = true;
    // Player-only real shadows (HD preset): a tight frustum trailing the helicopter
    softKey.shadow.camera.left = -42;
    softKey.shadow.camera.right = 42;
    softKey.shadow.camera.top = 42;
    softKey.shadow.camera.bottom = -42;
    softKey.shadow.camera.near = 0.5;
    softKey.shadow.camera.far = 260;
    softKey.shadow.mapSize.width = 1024;
    softKey.shadow.mapSize.height = 1024;
    softKey.shadow.bias = -0.00018;
    this.scene.add(softKey);
    this.scene.add(softKey.target);

    const rimLight = new THREE.DirectionalLight(0xaad8ff, 0.5);
    rimLight.position.set(65, 50, -85);
    this.scene.add(rimLight);

    // Layered sun disc: bright white-hot core inside warm glowing halo
    this.sunDisc = new THREE.Group();
    const sunPos = new THREE.Vector3(-116, 118, -178);
    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(8, 10, 6),
      createGlowMaterial(0xfffae6, 0.8),
    );
    const sunHalo = new THREE.Mesh(
      new THREE.SphereGeometry(22, 14, 8),
      createGlowMaterial(0xffdeb0, 0.2),
    );
    sunHalo.renderOrder = -2;
    sunCore.renderOrder = -3;
    this.sunDisc.add(sunHalo, sunCore);
    this.sunDisc.position.copy(sunPos);
    this.scene.add(this.sunDisc);

    this.city = new CityEnvironment(this.scene, this.world);
    this.city.onHonk = () => {
      if (this.audio) this.audio.playHonk();
    };
    this.city.onBuildingDestroyed = (x, y, z) => {
      const now = performance.now() / 1000;
      // Building collapse — dust cloud + debris chunks + fireball at the base
      // (the collapsed block sits at ground level, so the burst hugs the ground).
      if (this.volumetricExplosions) {
        this.volumetricExplosions.spawn(x, y, z, 28, 8.0);
      }
      if (this.particles) {
        this.particles.spawnExplosion(x, y, z, 70, now, 26);
        this.particles.spawnDebris(x, y, z, now, 30, 36);
        this.particles.spawnSmoke(x, y + 1, z, now);
        this.particles.spawnSmoke(x + 2, y + 3, z - 1, now);
        this.particles.spawnSmoke(x - 2, y + 5, z + 1, now);
        this.particles.spawnSparks(x, y, z, now, 12, 30);
      }
      if (this.audio) {
        this.audio.playBigExplosion(1.2);
      }
      // Major building collapse — allowed heavy impulse.
      this.addCameraImpulse(3.5);
      this.addExplosionImpulse(x, y, z, 3.5, 110);
      this.score += Math.floor(50 * this.comboMultiplier);
      this.triggerHitStop(0.12, 0.04); // Crunchy freeze on building collapse
    };

    this.playerModel = this.readPlayerModel();
    this.helicopter = new Helicopter(this.scene, this.world, this.playerModel);
    this.helicopter.body.addEventListener("collide", this.onHelicopterCollide);

    this.playerProjectiles = new ProjectilePool(this.scene, 150, 0xff2a2a);
    this.enemyProjectiles = new ProjectilePool(this.scene, 100, 0xffe94a);

    this.particles = new GPUParticleSystem(5000);
    this.scene.add(this.particles.mesh);
    this.city.particles = this.particles;
    
    this.volumetricExplosions = new VolumetricExplosions(this.scene);

    // A1/A2: physical debris chunks (single InstancedMesh) + shockwave rings.
    // Debris bodies are collision-filtered away from gameplay (groups 4/8).
    this.debris = new DebrisSystem(this.scene);
    this.debris.attachWorld(this.world);
    this.shockwaves = new ShockwaveRings(this.scene);
    this.city.debris = this.debris;
    this.city.shockwaves = this.shockwaves;
    // C4: volatile street props detonate through the engine for fx + damage.
    this.city.onPropExplosion = (x, z) => this.explodeVolatileProp(x, z);

    // C5/C6: load persistent pilot perks and weapon mod choices.
    this.perks = readPerks();
    this.weaponMods = readWeaponMods();

    this.rain = new RainSystem(5000);
    this.scene.add(this.rain.mesh);
    this.rain.mesh.visible = false;

    this.weather = new WeatherSystem();
    this.audio = new AudioManager();
    this.applySettings();

    this.delivery = new DeliverySystem(
      this.scene,
      this.city.chunkDepth,
      (chunkId) => this.city.getDepotHub(chunkId),
      {
        announce: (text, sub, color) => this.announce(text, sub, color),
        creditsChanged: () => this.updateUI(performance.now() / 1000),
        settleRewards: (contract, earnedTimeBonus) => {
          const extras = (earnedTimeBonus ? contract.bonusReward : 0) + contract.samRiskBonus;
          return {
            secured: contract.rewardCredits,
            unsecured: extras + threatBonusFor(contract.rewardCredits, this.threatLevel),
          };
        },
        completed: (contract, _secured, unsecured) => {
          this.unsecuredCredits += unsecured;
          this.deliveriesCompleted++;
          this.addThreat(contract.difficulty === "HIGH_VALUE" ? 14 : contract.difficulty === "RISKY" ? 9 : 6);
          if (contract.cargoType === "AMMUNITION") this.countermeasures.replenish(1);
          this.missionManager.reportDeliveryComplete(
            contract.id,
            performance.now() / 1000,
            this.getMissionRuntimeSnapshot(),
          );
        },
      },
    );
    this.delivery.setCarrierRoot(this.helicopter.mesh);

    // Dynamic Crosshair Reticle
    this.targetGroup = new THREE.Group();
    this.targetGroup.position.set(this.aimPoint.x, FLIGHT_SPEC.spawnAltitude + 0.2, this.aimPoint.z);
    this.targetGroup.visible = false;

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.58,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.innerRing = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.3, 16),
      ringMat,
    );
    this.innerRing.rotation.x = -Math.PI / 2;
    this.outerRing = new THREE.Mesh(
      new THREE.RingGeometry(1.8, 2.0, 32),
      ringMat,
    );
    this.outerRing.rotation.x = -Math.PI / 2;

    const pipMat = createGlowMaterial(0xffffff, 0.58);
    for (let i = 0; i < 4; i++) {
      const pip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 1.5), pipMat);
      pip.position.z = 2.9;
      const pivot = new THREE.Group();
      pivot.rotation.y = (Math.PI / 2) * i;
      pivot.add(pip);
      this.targetGroup.add(pivot);
    }

    this.targetGroup.add(this.innerRing, this.outerRing);
    this.scene.add(this.targetGroup);
    this.renderer.domElement.style.cursor = "crosshair";

    // Fake blob shadow under the player so the hull reads grounded in the
    // desert light (real shadowMap stays disabled for perf).
    this.playerShadow = createBlobShadow(7);
    this.scene.add(this.playerShadow);

    // 6d: speed lines — thin white streaks pooled at the edges of the screen.
    const lineGeo = new THREE.BoxGeometry(0.06, 0.06, 4.5);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    for (let i = 0; i < 18; i++) {
      const line = new THREE.Mesh(lineGeo, lineMat.clone());
      line.visible = false;
      this.scene.add(line);
      this.speedLines.push(line);
    }

    this.floatingCombatText = new FloatingCombatTextManager();
    if (this.canvas && this.canvas.parentElement) {
      this.overlayCanvas = document.createElement("canvas");
      this.overlayCanvas.className = "pointer-events-none absolute inset-0 block h-full w-full z-20";
      this.canvas.parentElement.appendChild(this.overlayCanvas);
      this.floatingCombatText.attachCanvas(this.overlayCanvas);
      this.syncOverlayCanvasSize();
    }

    window.addEventListener("resize", this.onResize);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("helistrike:left-stick", this.onLeftStick);
    window.addEventListener("helistrike:right-stick", this.onRightStick);
    window.addEventListener("gamepadconnected", this.onGamepadConnected);
    window.addEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.addEventListener("helistrike:settings", this.onSettingsChanged);
    window.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("helistrike:fire", this.onFireChange);
    window.addEventListener("helistrike:upgrade-choice", this.onUpgradeChosen);
    window.addEventListener("helistrike:player-model", this.onPlayerModelChanged);
    window.addEventListener("helistrike:env-debug", this.onEnvDebug);
    window.addEventListener("helistrike:ai-debug", this.onAiDebug);
    window.addEventListener("helistrike:countermeasure", this.onCountermeasureEvent);
    window.addEventListener("helistrike:super", this.onSuperEvent);

    this.lastTime = performance.now() / 1000;

    // Initialize weapon system
    this.resetWeaponsFromHangar();

    this.cameraLookAtTarget.set(0, 28, -9);
    this.updateUI(this.lastTime); // Init UI
    this.start();
  }

  private resetWeaponsFromHangar(damageBoost = false) {
    const weaponRank = this.hangarUpgrades.weaponSystem ?? 0;
    const ammoMult = 1 + weaponRank * 0.045;
    const reloadMult = Math.max(0.86, 1 - weaponRank * 0.028);
    for (const wt of Object.values(WeaponType).filter((v) => typeof v === "number") as WeaponType[]) {
      const base = WEAPON_CONFIGS[wt];
      const config = {
        ...base,
        damage: base.damage * (damageBoost ? 2 : 1),
        maxAmmo: Math.round(base.maxAmmo * ammoMult),
        ammo: Math.round(base.maxAmmo * ammoMult),
        reloadTime: base.reloadTime * reloadMult,
      };
      this.weapons.set(wt, config);
    }
  }

  /** Start the one authoritative RAF loop. Safe under React StrictMode/remounts. */
  start() {
    if (this.disposed || this.running) return;
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.animationFrameId = requestAnimationFrame(this.tick);
  }

  startGame() {
    this.resetGame();
    this.isPaused = false;
    this.isPlaying = true;
    this.helicopter.mesh.visible = true;
    // First run only: teach the controls before the countdown begins.
    let tutorialDone = true;
    try {
      tutorialDone = window.localStorage.getItem(TUTORIAL_DONE_KEY) === "1";
    } catch {
      tutorialDone = true; // storage unavailable — never block the run
    }
    if (!tutorialDone) {
      this.tutorialActive = true;
      this.tutorialStep = 0;
      this.tutorialAutoTimer = 0;
      this.dispatchTutorialStep();
    }
    // Safe spawn: start above the terrain/rooftop hover floor with zero
    // velocity so the run can never begin inside geometry or mid-fall.
    const floor = this.city.getHeightAt(0, 0, 0.5);
    const heliBody = this.helicopter.body;
    if (heliBody.position.y < floor + 8) {
      heliBody.position.y = floor + 12;
      copyPhysicsPos(this.helicopter.mesh, heliBody.position);
    }
    heliBody.velocity.set(0, 0, 0);
    heliBody.angularVelocity.set(0, 0, 0);
    try {
      this.audio.resume();
      this.audio.startMusic();
    } catch {
      // Some browsers delay audio startup until the first canvas press.
    }
    this.lastTime = performance.now() / 1000;
    this.updateUI(this.lastTime);
    this.emitStatsIfChanged(true);
  }

  setPaused(paused: boolean) {
    if (paused && this.tutorialActive) this.tutorialPausedOnce = true;
    this.isPaused = paused;
    this.isPlaying = !paused;
    this.helicopter.mesh.visible = true;
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.movementKeys.clear();
    this.keyboardVelocity.set(0, 0);
    this.verticalInput = 0;
    this.afterburnerActive = false;
    this.lastTime = performance.now() / 1000;
    this.updateUI(this.lastTime);
    if (paused) {
      this.audio.stopMusic();
    } else {
      this.audio.startMusic();
    }
  }

  resetGame() {
    this.clearExtraction();
    if (this.decoyTarget) this.decoyTarget.active = false;
    this.delivery.reset();
    this.missionManager.reset();
    this.combatDirector.reset();
    this.city.reset(this.world);
    for (const enemy of this.enemies) {
      enemy.destroy();
    }
    this.enemies = [];
    this.priorityTargetEnemy = null;
    this.priorityTargetInfo = null;
    this.priorityTargetCooldown = 18.0;
    this.priorityTargetAnnouncedAt = 0;
    this.pickupRiskActive = false;
    this.pickupRiskTimer = 0;
    for (const shadow of this.enemyShadows.values()) {
      this.scene.remove(shadow);
      shadow.geometry.dispose();
      (shadow.material as THREE.Material).dispose();
    }
    this.enemyShadows.clear();
    if (this.playerShadow) this.scene.remove(this.playerShadow);
    for (const pu of this.powerups) {
      pu.destroy(this.scene);
    }
    this.powerups = [];
    for (const obj of this.objectives) {
      obj.destroy();
    }
    this.objectives = [];
    this.playerProjectiles.deactivateAll();
    this.enemyProjectiles.deactivateAll();
    this.floatingCombatText.clear();

    this.helicopter.reset();
    this.movementTarget.set(0, FLIGHT_SPEC.spawnAltitude, 0);
    this.keyboardVelocity.set(0, 0);
    this.hasInputThisFrame = false;
    this.aimPoint.set(0, FLIGHT_SPEC.spawnAltitude, -35);
    this.mouseAimPoint.set(0, FLIGHT_SPEC.spawnAltitude, -55);
    this.mouseAimValid = false;
    this.targetGroup.position.set(this.aimPoint.x, FLIGHT_SPEC.spawnAltitude + 0.2, this.aimPoint.z);
    this.targetGroup.visible = false;
    this.autoAimTarget = null;
    this.movementKeys.clear();
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.baseCamPos.set(0, 62, 46);
    this.camera.position.copy(this.baseCamPos);
    this.cameraLookAtTarget.set(0, 28, -9);
    this.cameraYaw = 0;
    this.targetCameraYawVelocity = 0;
    this.currentCameraYawVelocity = 0;
    this.isRecenteringCamera = false;
    this.cameraBoomFraction = 1.0;
    this.isMiddleMouseOrbiting = false;
    this.hangarUpgrades = readHangarUpgrades();
    this.resetWeaponsFromHangar();
    this.countermeasures = new CountermeasureState(
      countermeasureConfig(this.hangarUpgrades.countermeasures),
    );
    this.decoyTarget = null;
    this.flareEffectTimer = 0;
    this.lastMissileWarningTime = -Infinity;
    this.threatPoints = 0;
    this.threatLevel = 1;
    this.unsecuredCredits = 0;
    this.runSalvage = 0;
    this.depotServiceCooldown = 0;
    this.deliveriesCompleted = 0;
    this.samSitesDestroyed = 0;
    this.radarSitesDestroyed = 0;
    this.bossesDestroyed = 0;
    this.missionsCompleted = 0;
    this.missionBonusesCompleted = 0;
    this.extractionProgress = 0;
    this.extractionOfferLevel = 1;
    this.extractionOfferTime = 0;
    this.extractionPressure = false;
    this.maxHealth = 100 + this.hangarUpgrades.armor * 10;
    this.maxFuel = 100 + this.hangarUpgrades.fuel * 4;
    this.score = 0;
    this.totalKills = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.health = this.maxHealth;
    this.currentFuel = this.maxFuel;
    this.lastStatsHealth = -1;
    this.lastStatsFuel = -1;
    // Fresh-run feedback state: systems that start ready stay silent until
    // they actually cycle; warnings re-arm once resources recover.
    this.prevSalvoReady = true;
    this.prevCountermeasuresReady = true;
    this.prevSuperReady = false;
    this.lowFuelWarned = false;
    this.lowHullWarned = false;
    this.cameraShakeAmp = 0;
    this.survivalTime = 0;
    this.combatIntensity = 0;
    this.directorTimer = 0.6;
    this.battlefieldEventTimer = 16;
    this.lastSpawnSoundTime = 0;
    this.lastBuildingHitSoundTime = 0;
    this.lastPropExplosionSoundTime = 0;
    this.crashSmokeTimer = 0;
    this.crashSmokePos = null;
    this.lastEnemyFireSoundTime = 0;
    this.currentWave = 0;
    this.enemiesSpawnedInWave = 0;
    this.totalEnemiesInWave = 0;
    this.spawnTimer = 0;
    this.waveTimer = 0;
    this.waveTransitionTimer = 0;
    this.waveMessage = "";
    this.samSiteAnnouncedThisRun = false;
    this.radarSiteAnnouncedThisRun = false;
    this.airThreatAnnouncedThisRun = false;
    this.isOverdrive = false;
    this.overdriveMultiplier = 1.0;
    this.postBossDecisionPending = false;
    this.postBossDecisionTimer = 0;
    this.postBossDecisionAvailable = false;
    this.microLullTimer = 28.0;
    this.microLullActiveTimer = 0;
    // Opening sequence: every run starts behind the 3-2-1 countdown and the
    // spawn shield — no damage, no enemy fire, no stale protection state.
    this.openingPhase = "countdown";
    this.openingTimer = 3;
    this.graceTimer = this.difficulty.openingGraceSeconds;
    this.openingCountSent = 99;
    this.waveFireSilenceTimer = 0;
    this.emergencyRepairUsed = false;
    this.lastDamageSource = "";
    this.lastDamageInfo = null;
    this.tutorialActive = false;
    this.tutorialStep = 0;
    this.tutorialAutoTimer = 0;
    this.tutorialDodgeTimer = 0;
    this.tutorialPausedOnce = false;
    this.tutorialFlareUsed = false;
    // Phase 3: pending spawns must not survive a restart.
    this.pendingSpawns = 0;
    this.waveThreatBudgetRemaining = 0;
    this.processedEnemyDeaths = new WeakSet<Enemy>();
    this.pendingVariantQueue.length = 0;
    this.pendingEventSpawns.length = 0;
    this.weather.stormIntensity = 0;
    this.weather.targetIntensity = 0;
    this.rain.mesh.visible = false;
    this.gameOverDispatched = false;
    this.isPlaying = false;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.comboMultiplier = 1;
    this.maxCombo = 0;
    this.runLevel = 1;
    this.runXp = 0;
    this.pendingLevelUps = 0;
    this.muzzleFlip = 1;
    this.damageBoostTimer = 0;
    this.shieldTimer = 0;
    this.speedBoostTimer = 0;
    this.magnetSurgeTimer = 0;
    this.hitMarkerTimer = 0;
    this.powerupSpawnTimer = 0;
    this.verticalInput = 0;
    this.gamepadMove.x = 0;
    this.gamepadMove.z = 0;
    this.dashState = "READY";
    this.dashCooldownTimer = 0;
    this.dashActiveTimer = 0;
    this.dashDirection.set(0, 0, 0);
    this.lastTapTime = {};

    this.isPaintingLocks = false;
    this.salvoLocks = [];
    this.salvoCooldownTimer = 0;
    this.lastLockPaintTime = 0;
    this.clearSalvoIndicators();

    // Reset progression systems
    this.minibossSpawnedThisWave = false;
    this.samSuppressionTimer = 0;
    this.samActive = false;
    this.radarActive = false;
    this.weaponXp = new Map();
    this.weaponLevels = new Map();
    this.lastFiredWeapon = WeaponType.MACHINE_GUN;
    this.runUpgrades = {
      damage: 0,
      fireRate: 0,
      ammo: 0,
      reload: 0,
      salvoCooldown: 0,
      maxHealth: 0,
      fuelEfficiency: 0,
      shield: 0,
      speed: 0,
      armor: 0,
      repair: 0,
      xpMagnet: 0,
      dashCooldown: 0,
      bomb: 0,
      incendiary: 0,
      empPayload: 0,
      shockCoils: 0,
    };
    this.pendingUpgradeOffer = [];
    this.upgradePaused = false;
    this.killStreakCount = 0;
    this.lastKillTime = 0;
    this.announceQueue = [];
    this.afterburnerActive = false;
    this.afterburnerEffectTimer = 0;
    this.bossIntroActive = false;
    this.bossIntroStage = 0;

    // Mega-pack run state: super meter, governor, extraction gate, fresh perks/mods.
    this.superCharge = 0;
    this.superActiveUntil = 0;
    this.superCooldownUntil = 0;
    this.governor = createQualityGovernor();
    this.governorWindowFrames = 0;
    this.governorWindowTime = 0;
    this.objectivesDestroyedThisRun = 0;
    this.extractionOfferedThisRun = false;
    this.perks = readPerks();
    this.weaponMods = readWeaponMods();
    this.applyGovernorQuality();

    // C3: every run starts in daylight with a fresh night-op seed.
    this.nightOpsActive = false;
    this.nightBlend = 0;
    this.nightBlendTarget = 0;
    this.nightSeed = Math.floor(Math.random() * 0x7fffffff);
    this.applyNightPalette(0);
    if (this.nightBeams) this.nightBeams.visible = false;
    // Clear debris pool so old chunks don't persist into the new run.
    this.debris?.reset();

    this.updateUI(performance.now() / 1000);
    this.emitStatsIfChanged(true);
  }

  dispose() {
    this.destroy();
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("helistrike:left-stick", this.onLeftStick);
    window.removeEventListener("helistrike:right-stick", this.onRightStick);
    window.removeEventListener("gamepadconnected", this.onGamepadConnected);
    window.removeEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.removeEventListener("helistrike:settings", this.onSettingsChanged);
    window.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("helistrike:fire", this.onFireChange);
    window.removeEventListener("helistrike:upgrade-choice", this.onUpgradeChosen);
    window.removeEventListener("helistrike:player-model", this.onPlayerModelChanged);
    window.removeEventListener("helistrike:env-debug", this.onEnvDebug);
    window.removeEventListener("helistrike:ai-debug", this.onAiDebug);
    window.removeEventListener("helistrike:countermeasure", this.onCountermeasureEvent);
    window.removeEventListener("helistrike:super", this.onSuperEvent);
    this.clearExtraction();
    this.clearSalvoIndicators();
    this.helicopter.body.removeEventListener(
      "collide",
      this.onHelicopterCollide,
    );
    if (this.lightningTimeout !== null) {
      window.clearTimeout(this.lightningTimeout);
      this.lightningTimeout = null;
    }
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.renderer.setAnimationLoop(null);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.audio.dispose();
    this.city.onHonk = null;
    this.city.onBuildingDestroyed = null;
    for (const enemy of this.enemies) enemy.destroy();
    for (const objective of this.objectives) objective.destroy();
    for (const powerup of this.powerups) powerup.destroy(this.scene);
    this.delivery.dispose();
    this.helicopter.destroy();
    this.debris?.dispose();
    this.debris = null;
    this.nightBeams = null;
    if (this.sunDisc) {
      disposeObject3D(this.sunDisc);
      this.sunDisc.clear();
    }
    disposeObject3D(this.scene);
    this.scene.clear();
    this.composer.dispose();
    this.renderer.dispose();
    if (this.overlayCanvas && this.overlayCanvas.parentElement) {
      this.overlayCanvas.parentElement.removeChild(this.overlayCanvas);
      this.overlayCanvas = null;
    }
    this.floatingCombatText.clear();
  }

  syncOverlayCanvasSize = () => {
    if (!this.overlayCanvas) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = this.getEffectivePixelRatio();
    this.overlayCanvas.width = Math.floor(width * dpr);
    this.overlayCanvas.height = Math.floor(height * dpr);
    this.overlayCanvas.style.width = `${width}px`;
    this.overlayCanvas.style.height = `${height}px`;
  };

  onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.getEffectivePixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.syncOverlayCanvasSize();
    this.applyComposerQuality();
  };

  private onContextLost = (e: Event) => {
    e.preventDefault(); // allows restore to fire
    this.contextLost = true;
    console.warn('[HeliStrike] WebGL context lost — pausing render loop');
    if (this.isPlaying) {
      window.dispatchEvent(new CustomEvent('helistrike:autopause'));
    }
  };

  private onContextRestored = () => {
    this.contextLost = false;
    console.info('[HeliStrike] WebGL context restored — resuming');
    // Three.js WebGLRenderer handles internal state reset on context restore.
    // Re-apply renderer settings to ensure they're in sync.
    this.renderer.setPixelRatio(this.getEffectivePixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.applyComposerQuality();
  };

  getMaxPixelRatio() {
    const dpr = window.devicePixelRatio;
    // HD: crisp full-resolution render (adaptive governor sheds pixels under load).
    if (this.settings.graphics === 'hd') return Math.min(dpr, 2);
    // SP1: PS1-style — render at a fraction of display resolution; the canvas CSS
    // upscales with nearest-neighbor (image-rendering: pixelated) for the
    // chunky-pixel console look.
    return Math.min(dpr, MAX_RENDER_PIXEL_RATIO) * 0.34;
  }

  /** A4: user preset ceiling scaled by the adaptive governor's degradation level. */
  getEffectivePixelRatio() {
    return this.getMaxPixelRatio() * governorPixelScale(this.governor.level);
  }

  /** Particle counts scale down with the governor (heavy FX shed first). */
  private fxCount(count: number): number {
    const scaled = Math.max(1, Math.round(count * governorParticleScale(this.governor.level)));
    // 2m: enforce per-frame particle budget — if we're already over, cap hard.
    if (this.particleBudgetThisFrame <= 0) return Math.min(scaled, 4);
    const allowed = Math.min(scaled, this.particleBudgetThisFrame);
    this.particleBudgetThisFrame -= allowed;
    return allowed;
  }

  /** A4: push the governor's current level into renderer settings. */
  private applyGovernorQuality() {
    this.renderer.setPixelRatio(this.getEffectivePixelRatio());
    this.bloomPass.enabled = governorBloomAllowed(this.governor.level, this.settings.graphics === 'hd');
    this.applyComposerQuality();
  }

  /** Re-anchors the composer's pixel ratio so governor changes apply there.
   *  SP1 keeps 0 MSAA (the console had none — the low-res pixelated upscale is
   *  the aesthetic); HD enables 4x MSAA for a clean, crisp image. */
  private applyComposerQuality() {
    const samples = this.settings.graphics === 'hd' ? 4 : 0;
    if (this.composer.renderTarget1.samples !== samples) {
      this.composer.renderTarget1.samples = samples;
      this.composer.renderTarget2.samples = samples;
    }
    this.composer.setPixelRatio(this.getEffectivePixelRatio());
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Live renderer stats for the on-screen perf overlay (zero GL cost —
   *  reads three's counters; the heavier counts are only sampled at the
   *  overlay's ~4 Hz poll cadence, never per frame). */
  getPerfStats() {
    const info = this.renderer.info;
    // Frame-time stats from the raw-delta ring (small in-place sort buffer).
    const n = this.frameMsCount;
    let avg = 0;
    let worst = 0;
    if (n > 0) {
      const sorted = this.perfSortBuffer;
      for (let i = 0; i < n; i++) sorted[i] = this.frameMsRing[i];
      const slice = sorted.subarray(0, n);
      slice.sort();
      for (let i = 0; i < n; i++) avg += slice[i];
      avg /= n;
      worst = slice[n - 1];
    }
    const p95 = n > 0 ? this.perfSortBuffer[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
    let playerProj = 0;
    let enemyProj = 0;
    for (const p of this.playerProjectiles.pool) if (p.active) playerProj++;
    for (const p of this.enemyProjectiles.pool) if (p.active) enemyProj++;
    let particles = 0;
    const startAttr = this.particles.startTimeAttr;
    for (let i = 0; i < this.particles.maxParticles; i++) {
      if (startAttr.getX(i) > -9000) particles++;
    }
    let sceneObjects = 0;
    this.scene.traverse(() => sceneObjects++);
    return {
      fps: this.fps,
      avgFrameMs: +avg.toFixed(1),
      p95FrameMs: +p95.toFixed(1),
      worstFrameMs: Math.round(worst),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      graphics: this.settings.graphics,
      governorLevel: this.governor.level,
      enemies: this.enemies.length,
      playerProjectiles: playerProj,
      enemyProjectiles: enemyProj,
      particles,
      physicsBodies: this.world.bodies.length,
      sceneObjects,
      powerups: this.powerups.length,
      objectives: this.objectives.length,
      activeDamageTexts: this.floatingCombatText.getActiveCount(),
      inputLatency: {
        rawInputX: +this.gamepadMove.x.toFixed(2),
        rawInputZ: +this.gamepadMove.z.toFixed(2),
        desiredSpeed: +Math.hypot(this.helicopter.desiredVelocity.x, this.helicopter.desiredVelocity.z).toFixed(1),
        actualSpeed: +Math.hypot(this.helicopter.body.velocity.x, this.helicopter.body.velocity.z).toFixed(1),
        cameraFollowError: +this.cameraFollowError.toFixed(2),
        orbitVelocity: +this.currentCameraYawVelocity.toFixed(2),
      },
      combatDirector: this.combatDirector.getSnapshot(
        this.enemies.filter((e) => (e.type === EnemyType.DRONE || e.type === EnemyType.SHOOTER) && e.active).length,
        this.enemies.filter((e) => e.active).length,
        this.currentGroundThreat,
        this.currentAirThreat,
        this.combatIntensity,
        this.currentWave,
        this.threatLevel,
        this.isOverdrive,
        this.overdriveMultiplier,
        this.enemies.some((e) => e.type === EnemyType.BOSS && e.active),
        this.settings.difficulty,
        Boolean(this.priorityTargetEnemy?.active),
        this.pickupRiskActive,
        this.pendingVariantQueue.length + this.pendingSpawns,
      ),
    };
  }
  /** Reused by getPerfStats — no per-poll allocation. */
  private perfSortBuffer = new Float32Array(240);

  /**
   * Phase 1 dev memory monitor (Step 9). Called at a 2s cadence from tick()
   * when enabled (DEV + localStorage 'helistrike:memmon'). Counts active
   * runtime objects and reads renderer.info to spot unbounded growth while
   * flying/streaming. Objects/geometries should plateau, never climb forever.
   */
  private monitorMemory(time: number) {
    const info = this.renderer.info;
    let sceneObjects = 0;
    this.scene.traverse(() => {
      sceneObjects++;
    });
    let traffic = 0;
    for (const cars of this.city.chunkTraffic.values()) traffic += cars.length;
    let playerProj = 0;
    let enemyProj = 0;
    for (const p of this.playerProjectiles.pool) if (p.active) playerProj++;
    for (const p of this.enemyProjectiles.pool) if (p.active) enemyProj++;
    let particles = 0;
    const startAttr = this.particles.startTimeAttr;
    for (let i = 0; i < this.particles.maxParticles; i++) {
      if (startAttr.getX(i) > -9000) particles++;
    }
    const damageTexts = this.floatingCombatText.getActiveCount();
    console.info(
      `[Heli-Strike mem] t=${time.toFixed(1)}s fps=${this.fps} ` +
        `chunks=${this.city.chunks.size} sceneObj=${sceneObjects} blocks=${this.city.blocks.length} ` +
        `enemies=${this.enemies.length} proj=${playerProj}/${enemyProj} particles=${particles} ` +
        `dmgTexts=${damageTexts} powerups=${this.powerups.length} traffic=${traffic} turrets=${this.city.turrets.length} ` +
        `geoms=${info.memory.geometries} textures=${info.memory.textures} ` +
        `calls=${info.render.calls} tris=${info.render.triangles}`,
    );
  }

  applySettings() {
    // Manual quality change re-anchors the governor at the new ceiling.
    this.governor = createQualityGovernor();
    this.renderer.setPixelRatio(this.getEffectivePixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.applyComposerQuality();
    if (this.bloomPass) {
      this.bloomPass.enabled = governorBloomAllowed(0, this.settings.graphics === 'hd');
    }
    // HD is a clean, modern render: skip the PS1 color quantizer/dither entirely.
    if (this.retroPass) this.retroPass.enabled = false;
    // Player-only real shadows are an HD-preset feature (SP1 keeps the cheap
    // blob decals). The frustum hugs the player — see updateShadowRig().
    this.renderer.shadowMap.enabled = this.settings.graphics === 'hd';
    this.renderer.shadowMap.needsUpdate = true;
    this.audio.setVolume(this.settings.volume);
    this.audio.setMusicVolume(this.settings.musicVolume);
    this.audio.setSfxVolume(this.settings.sfxVolume);
  }

  private renderFrame() {
    // Skip rendering if WebGL context was lost — the browser will fire
    // 'webglcontextrestored' when GPU resources are available again.
    if (this.contextLost) return;
    // Keep the horizon centered on the player so the dome never strands
    // behind the streaming city chunks.
    this.skyDome.position.set(this.camera.position.x, 0, this.camera.position.z);
    // Feed the sky shader's slow halo breathe (safe no-op if the uniform is
    // absent — the weather system owns horizonColor separately).
    if (this.skyDome.material instanceof THREE.ShaderMaterial && this.skyDome.material.uniforms?.uTime) {
      this.skyDome.material.uniforms.uTime.value += 0.016;
    }
    if (this.settings.graphics === 'sp1') {
      this.renderer.render(this.scene, this.camera);
    } else {
      this.composer.render();
    }
    this.floatingCombatText.render(
      this.camera,
      this.renderer.domElement.clientWidth || window.innerWidth,
      this.renderer.domElement.clientHeight || window.innerHeight,
      this.getEffectivePixelRatio(),
      this.hitMarkerTimer,
      this.hitMarkerPosition,
    );
  }

  /** Position the fake blob shadows under the player and every active enemy,
   *  fading them out with altitude. Shadows are pooled per enemy instance. */
  private syncBlobShadows() {
    const hp = this.helicopter.body.position;
    const groundY = this.helicopter.smoothedHoverFloor;
    const alt = Math.max(0, hp.y - groundY);
    const playerFade = THREE.MathUtils.clamp(1 - alt / 140, 0, 1);
    // HD draws the player's real cast shadow, so hide the fake decal there to
    // avoid a doubled shadow. Enemies keep their decals in both presets.
    this.playerShadow.visible = playerFade > 0.03 && !this.renderer.shadowMap.enabled;
    (this.playerShadow.material as THREE.MeshBasicMaterial).opacity = 0.85 * playerFade;
    // Spread + drift the shadow along the sun's cast axis as altitude rises.
    const spread = 1 + alt * 0.014;
    this.playerShadow.scale.set(spread * 1.35, spread * 1.35, 1);
    this.playerShadow.position.set(
      hp.x + this.sunShadowDir.x * alt * this.sunShadowOffsetPerU,
      groundY + 0.08,
      hp.z + this.sunShadowDir.z * alt * this.sunShadowOffsetPerU,
    );

    this.shadowSeenSet.clear();
    for (const e of this.enemies) {
      if (!e.active) continue;
      this.shadowSeenSet.add(e);
      let shadow = this.enemyShadows.get(e);
      if (!shadow) {
        shadow = createBlobShadow(Math.max(3, e.radius * 1.6));
        this.enemyShadows.set(e, shadow);
        this.scene.add(shadow);
      }
      const p = e.body.position;
      const eAlt = Math.max(0, p.y);
      const fade = THREE.MathUtils.clamp(1 - eAlt / 120, 0, 1) * 0.8;
      shadow.visible = fade > 0.03;
      (shadow.material as THREE.MeshBasicMaterial).opacity = fade;
      const eSpread = 1 + eAlt * 0.012;
      shadow.scale.set(eSpread * 1.3, eSpread * 1.3, 1);
      shadow.position.set(
        p.x + this.sunShadowDir.x * eAlt * this.sunShadowOffsetPerU,
        0.06,
        p.z + this.sunShadowDir.z * eAlt * this.sunShadowOffsetPerU,
      );
    }
    for (const [e, shadow] of this.enemyShadows) {
      if (this.shadowSeenSet.has(e)) continue;
      this.scene.remove(shadow);
      shadow.geometry.dispose();
      (shadow.material as THREE.Material).dispose();
      this.enemyShadows.delete(e);
    }
  }

  /** HD-preset real shadows: drag the key light + its tight shadow frustum
   *  along with the helicopter so the 1024px map only covers the patch of
   *  world around the player. Only the player mesh casts (city/enemies keep
   *  castShadow=false), so the pass stays dirt cheap. No-op in SP1. */
  private updateShadowRig() {
    if (!this.renderer.shadowMap.enabled) return;
    const hp = this.helicopter.body.position;
    if (!Number.isFinite(hp.x) || !Number.isFinite(hp.z)) return;
    this.keyLight.position.set(hp.x - 48, hp.y + 86, hp.z + 54);
    this.keyLight.target.position.set(hp.x, hp.y, hp.z);
    this.keyLight.target.updateMatrixWorld();
  }

  /** Ease the grade pass toward the current wave theme's look. delta <= 0
   *  only refreshes the target (wave start); the per-frame call blends. */
  private updateThemeGrading(delta: number) {
    if (!this.gradePass) return;
    const theme = this.currentWaveTheme;
    if (!theme) {
      this.gradeTarget = NEUTRAL_GRADE;
    } else if (theme.key === "FRENZY") {
      // Hot orange haze — the frame itself feels aggro.
      this.gradeTarget = { r: 1.12, g: 0.93, b: 0.72, exposure: 1.06, saturation: 1.14 };
    } else if (theme.key === "NIGHT_SURGE") {
      // Steel-blue night — complement (don't fight) the night-ops palette.
      this.gradeTarget = { r: 0.78, g: 0.88, b: 1.18, exposure: 1.0, saturation: 0.82 };
    } else {
      this.gradeTarget = NEUTRAL_GRADE;
    }
    if (delta <= 0) return;
    const k = 1 - Math.exp(-delta / 0.45);
    const c = this.gradeCurrent;
    const t = this.gradeTarget;
    c.r += (t.r - c.r) * k;
    c.g += (t.g - c.g) * k;
    c.b += (t.b - c.b) * k;
    c.exposure += (t.exposure - c.exposure) * k;
    c.saturation += (t.saturation - c.saturation) * k;
    const u = this.gradePass.uniforms;
    (u.uTint.value as THREE.Color).setRGB(c.r, c.g, c.b);
    u.uExposure.value = c.exposure;
    u.uSaturation.value = c.saturation;
  }

  private getFallbackFireDirection() {
    if (this.mouseAimValid) {
      const dx = this.mouseAimPoint.x - this.helicopter.body.position.x;
      const dz = this.mouseAimPoint.z - this.helicopter.body.position.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.001) return { x: dx / len, z: dz / len };
    }
    return { x: 0, z: -1 };
  }

  private autoAimPosition(target: Enemy | Objective) {
    return target instanceof Objective ? target.targetPoint : target.body.position;
  }

  private findAutoAimTarget(maxDistance = 245, useMouseCone = false) {
    let bestTarget: Enemy | Objective | null = null;
    let bestScore = Infinity;
    const origin = this.helicopter.body.position;
    const forward = this.getFallbackFireDirection();

    for (const enemy of this.enemies) {
      if (
        !enemy.active ||
        !Number.isFinite(enemy.body.position.x) ||
        !Number.isFinite(enemy.body.position.y) ||
        !Number.isFinite(enemy.body.position.z)
      ) continue;
      const dx = enemy.body.position.x - origin.x;
      const dz = enemy.body.position.z - origin.z;
      const dy = Math.abs(enemy.body.position.y - origin.y);
      const distSq = dx * dx + dz * dz;
      if (distSq < 12 || distSq > maxDistance * maxDistance) continue;

      const dist = Math.sqrt(distSq);
      const aheadBias = (dx / dist) * forward.x + (dz / dist) * forward.z;
      if (useMouseCone && aheadBias < 0.28) continue;
      const lateralDistance = Math.abs(dx * forward.z - dz * forward.x);
      if (useMouseCone && lateralDistance > 46 + dist * 0.12) continue;
      const lanePenalty = useMouseCone ? lateralDistance * 14 : Math.abs(dx) * 1.9;
      const behindPenalty = aheadBias < -0.25 ? 9000 : 0;
      const typeBonus =
        enemy.type === EnemyType.DRONE
          ? 1800
          : enemy.type === EnemyType.SHOOTER
            ? 1200
            : enemy.type === EnemyType.TANK
              ? 700
              : 0;
      const cursorDistance =
        this.mouseAimValid
          ? Math.hypot(enemy.body.position.x - this.mouseAimPoint.x, enemy.body.position.z - this.mouseAimPoint.z)
          : 0;
      const score =
        distSq * (useMouseCone ? 0.3 : 1) +
        lanePenalty +
        cursorDistance * (useMouseCone ? 4.5 : 0) +
        behindPenalty -
        typeBonus;

      if (score < bestScore) {
        bestScore = score;
        bestTarget = enemy;
      }
    }

    // SAM sites are deliberate high-value targets, but normal enemies retain
    // priority unless the launcher is actively tracking or locking the player.
    for (const objective of this.objectives) {
      if (!objective.active || (objective.type !== ObjectiveType.SAM_SITE && objective.type !== ObjectiveType.RADAR_TOWER)) continue;
      const targetPos = objective.targetPoint;
      const dx = targetPos.x - origin.x;
      const dz = targetPos.z - origin.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 12 || distSq > maxDistance * maxDistance) continue;
      const dist = Math.sqrt(distSq);
      const aheadBias = (dx / dist) * forward.x + (dz / dist) * forward.z;
      if (useMouseCone && aheadBias < 0.28) continue;
      const lateralDistance = Math.abs(dx * forward.z - dz * forward.x);
      if (useMouseCone && lateralDistance > 46 + dist * 0.12) continue;
      const cursorDistance = this.mouseAimValid
        ? Math.hypot(targetPos.x - this.mouseAimPoint.x, targetPos.z - this.mouseAimPoint.z)
        : 0;
      const threatening = objective.type === ObjectiveType.SAM_SITE && (objective.samState === SamState.LOCKING || objective.samState === SamState.TRACKING);
      const score = distSq * (useMouseCone ? 0.3 : 1)
        + lateralDistance * (useMouseCone ? 14 : 1.9)
        + cursorDistance * (useMouseCone ? 4.5 : 0)
        + (aheadBias < -0.25 ? 9000 : 0)
        + (threatening ? -2600 : objective.type === ObjectiveType.RADAR_TOWER ? 1400 : 1800);
      if (score < bestScore) {
        bestScore = score;
        bestTarget = objective;
      }
    }

    return bestTarget;
  }

  private isAutoAimTargetValid(enemy: Enemy | Objective | null, maxDistance: number, useMouseCone: boolean) {
    const targetPos = enemy ? this.autoAimPosition(enemy) : null;
    if (
      !enemy?.active ||
      !targetPos ||
      !Number.isFinite(targetPos.x) ||
      !Number.isFinite(targetPos.y) ||
      !Number.isFinite(targetPos.z)
    ) return false;
    const dx = targetPos.x - this.helicopter.body.position.x;
    const dz = targetPos.z - this.helicopter.body.position.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return false;
    const distSq = dx * dx + dz * dz;
    const retainedRange = maxDistance * 1.08;
    if (distSq < 12 || distSq > retainedRange * retainedRange) return false;
    if (!useMouseCone) return true;
    const distance = Math.sqrt(distSq);
    const forward = this.getFallbackFireDirection();
    const aheadBias = (dx / distance) * forward.x + (dz / distance) * forward.z;
    const lateralDistance = Math.abs(dx * forward.z - dz * forward.x);
    return aheadBias >= 0.12 && lateralDistance <= 60 + distance * 0.16;
  }

  private updateAutoAim() {
    const aimHeight = this.helicopter.body.position.y;
    const targetingBonus = (this.hangarUpgrades.targeting ?? 0) * 10;
    const maxDistance = (this.settings.autoAim ? 255 : this.mouseAimValid ? 225 : 235) + targetingBonus;
    const useMouseCone = !this.settings.autoAim && this.mouseAimValid;
    if (!this.isAutoAimTargetValid(this.autoAimTarget, maxDistance, useMouseCone)) {
      this.autoAimTarget = this.findAutoAimTarget(maxDistance, useMouseCone);
    }

    if (this.autoAimTarget) {
      const targetPos = this.autoAimPosition(this.autoAimTarget);
      if (this.autoAimTarget instanceof Objective) this.autoAimTarget.setTargeted(true);
      this.aimPoint.set(targetPos.x, aimHeight, targetPos.z);
      this.helicopter.setGunAim(targetPos.x, targetPos.y, targetPos.z, true);
      this.targetGroup.visible = true;
      this.targetGroup.position.set(targetPos.x, targetPos.y + 1.2, targetPos.z);
      const scale = this.autoAimTarget instanceof Objective
        ? 1.35
        : this.autoAimTarget.type === EnemyType.TANK || this.autoAimTarget.type === EnemyType.BOSS ? 1.5 : 1.0;
      this.targetGroup.scale.setScalar(scale);
    } else if (this.mouseAimValid) {
      // No enemy in range — the chin gun physically tracks the mouse aim
      // point instead of the body swinging around twin-stick style.
      this.aimPoint.copy(this.mouseAimPoint);
      this.aimPoint.y = aimHeight;
      this.helicopter.setGunAim(this.aimPoint.x, aimHeight, this.aimPoint.z, true);
      this.targetGroup.visible = true;
      this.targetGroup.position.set(this.aimPoint.x, aimHeight + 0.3, this.aimPoint.z);
      this.targetGroup.scale.setScalar(0.82);
    } else {
      // No aim source at all — gun eases back to neutral, fire falls back to
      // the travel direction.
      this.helicopter.setGunAim(0, 0, 0, false);
      const fallback = this.getFallbackFireDirection();
      this.aimPoint.set(
        this.helicopter.body.position.x + fallback.x * 65,
        aimHeight,
        this.helicopter.body.position.z + fallback.z * 65,
      );
      this.targetGroup.visible = true;
      this.targetGroup.position.set(this.aimPoint.x, aimHeight + 0.3, this.aimPoint.z);
      this.targetGroup.scale.setScalar(0.78);
    }
  }

  private updateMouseAimFromEvent(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    this.mouseNDC.set(
      THREE.MathUtils.clamp(x, 0, 1) * 2 - 1,
      -(THREE.MathUtils.clamp(y, 0, 1) * 2 - 1),
    );

    // The 30mm chin turret & reticle track a ground-plane cursor: the mouse ray
    // lands on the battlefield plane Y = 0, fully decoupled from the airframe's
    // own heading — fly or strafe one way while gunning another.
    this.mousePlane.set(this.worldUp, 0);
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);

    const target = this.mouseAimScratch;
    if (!this.raycaster.ray.intersectPlane(this.mousePlane, target)) return;

    let dx = target.x - this.helicopter.body.position.x;
    let dz = target.z - this.helicopter.body.position.z;
    let distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.001) return;

    const minAimDistance = 22;
    const maxAimDistance = 280;
    const clampedDistance = THREE.MathUtils.clamp(distance, minAimDistance, maxAimDistance);
    dx /= distance;
    dz /= distance;
    this.mouseAimPoint.set(
      this.helicopter.body.position.x + dx * clampedDistance,
      0,
      this.helicopter.body.position.z + dz * clampedDistance,
    );
    this.mouseAimValid = true;
    this.isMouseActive = true;
    this.updateAutoAim();
  }

  recenterCamera(time?: number) {
    const velocity = this.helicopter.body.velocity;
    const speed = Math.hypot(velocity.x, velocity.z);
    let targetYaw = 0;
    if (speed > 3.5) {
      // Align behind flight direction
      targetYaw = Math.atan2(-velocity.x, -velocity.z);
    } else if (this.helicopter.mesh) {
      targetYaw = this.helicopter.mesh.rotation.y + Math.PI;
    }

    let diff = targetYaw - this.cameraYaw;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    this.recenterStartYaw = this.cameraYaw;
    this.recenterTargetYaw = this.cameraYaw + diff;
    this.recenterTimer = 0;
    this.isRecenteringCamera = true;
    this.targetCameraYawVelocity = 0;
    this.currentCameraYawVelocity = 0;
  }

  private updateStickAim() {
    if (!this.rightStick.active) return;

    const mag = Math.sqrt(
      this.rightStick.x * this.rightStick.x + this.rightStick.y * this.rightStick.y,
    );
    if (mag < 0.15) {
      this.isFiringMouse = false;
      return;
    }

    const aimDistance = 55;
    const rNormX = this.rightStick.x / mag;
    const rScreenY = -this.rightStick.y / mag; // Screen UP is -Y on touch stick

    const camFwd = GameEngine._scratchCamFwd;
    this.camera.getWorldDirection(camFwd);
    camFwd.y = 0;
    if (camFwd.lengthSq() < 0.0001) camFwd.set(0, 0, -1);
    else camFwd.normalize();

    const camRight = GameEngine._scratchCamRight;
    camRight.crossVectors(camFwd, this.worldUp).normalize();

    const aimWorldX = camRight.x * rNormX + camFwd.x * rScreenY;
    const aimWorldZ = camRight.z * rNormX + camFwd.z * rScreenY;

    const aimHeight = this.helicopter.body.position.y;
    this.aimPoint.set(
      this.helicopter.body.position.x + aimWorldX * aimDistance,
      aimHeight,
      this.helicopter.body.position.z + aimWorldZ * aimDistance,
    );
    // The chin gun tracks the stick aim — the body flies on course and never
    // swings toward where the player is aiming.
    this.helicopter.setGunAim(this.aimPoint.x, aimHeight, this.aimPoint.z, true);
    this.targetGroup.visible = false;
    this.isFiringMouse = true;
  }

  onPointerMove = (e: PointerEvent) => {
    if (e.target !== this.renderer.domElement) return;
    if (this.settings.touchMode && e.pointerType === 'touch') return;
    this.updateMouseAimFromEvent(e);
  };

  onPointerDown = (e: PointerEvent) => {
    if (!this.isPlaying) return;
    if (e.target !== this.renderer.domElement) return;
    if (this.settings.touchMode && e.pointerType === 'touch') return;
    e.preventDefault();
    this.audio.resume();

    if (e.button === 2) {
      this.startPaintingLocks();
    } else {
      this.isFiringMouse = true;
      this.isMouseActive = true;
      this.updateMouseAimFromEvent(e);
      this.updateAutoAim();
      if (this.health > 0) {
        this.fireWeapons(performance.now() / 1000);
      }
    }
  };

  onPointerUp = (e: PointerEvent) => {
    if (e.button === 2 || this.isPaintingLocks) {
      this.releaseSalvo();
    } else {
      this.isFiringMouse = false;
    }
  };

  onWheel = (e: WheelEvent) => {
    if (!this.isPlaying) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    const weaponTypes = [
      WeaponType.MACHINE_GUN,
      WeaponType.MISSILE,
      WeaponType.ROCKET,
      WeaponType.SHOTGUN,
    ];
    const currentIdx = weaponTypes.indexOf(this.currentWeapon);
    const nextIdx =
      (currentIdx + delta + weaponTypes.length) % weaponTypes.length;
    this.switchWeapon(weaponTypes[nextIdx]);
  };

  private resetTransientInput() {
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.isPaintingLocks = false;
    this.movementKeys.clear();
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.keyboardVelocity.set(0, 0);
    this.yawInput = 0;
    this.verticalInput = 0;
    this.gamepadMove.x = 0;
    this.gamepadMove.z = 0;
    this.gamepadStrafe = 0;
    this.gamepadVert = 0;
    this.afterburnerActive = false;
  }

  onWindowBlur = () => {
    this.resetTransientInput();
    this.lastTime = performance.now() / 1000;
    if (this.isPlaying) window.dispatchEvent(new CustomEvent("helistrike:autopause"));
  };

  onVisibilityChange = () => {
    this.resetTransientInput();
    this.lastTime = performance.now() / 1000;
    if (document.hidden && this.isPlaying) {
      window.dispatchEvent(new CustomEvent("helistrike:autopause"));
    }
  };

  onCountermeasureEvent = () => {
    if (this.isPlaying) this.deployCountermeasure(performance.now() / 1000);
  };

  private deployCountermeasure(time: number) {
    if (!this.countermeasures.deploy(time)) {
      this.announce(
        this.countermeasures.charges <= 0 ? "FLARES EMPTY" : "FLARES RECHARGING",
        this.countermeasures.charges <= 0 ? "Find ammunition supplies" : `${this.countermeasures.cooldownRemaining.toFixed(1)}s`,
        "#ffbd3f",
      );
      return false;
    }

    const player = this.helicopter.body.position;
    const velocity = this.helicopter.body.velocity;
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    const backX = horizontalSpeed > 2 ? -velocity.x / horizontalSpeed : Math.sin(this.helicopter.mesh.rotation.y);
    const backZ = horizontalSpeed > 2 ? -velocity.z / horizontalSpeed : Math.cos(this.helicopter.mesh.rotation.y);
    const body = new CANNON.Body({ mass: 0 });
    body.position.set(player.x + backX * 9, player.y - 2.5, player.z + backZ * 9);
    if (this.decoyTarget) this.decoyTarget.active = false;
    this.decoyTarget = { body, active: true };
    this.flareEffectTimer = this.countermeasures.config.activeWindow;

    let decoyed = 0;
    for (const missile of this.enemyProjectiles.pool) {
      if (!missile.active || missile.homingStrength <= 0 || missile.target?.body !== this.helicopter.body) continue;
      const distance = Math.hypot(missile.pos.x - player.x, missile.pos.y - player.y, missile.pos.z - player.z);
      if (distance > 190) continue; // an early flare does not guarantee safety
      const closeEnough = distance <= 135;
      const outerChance = this.countermeasures.config.effectiveness * (1 - (distance - 135) / 55);
      if (closeEnough || Math.random() < outerChance) {
        if (missile.retargetToDecoy(this.decoyTarget)) decoyed++;
      }
    }
    this.audio.playCountermeasure();
    this.tutorialFlareUsed = true;
    if (decoyed > 0) {
      this.announce("MISSILE DECOYED", decoyed > 1 ? `${decoyed} threats diverted` : "Lock broken", "#55f2c2");
      this.audio.playLockBreak();
    }
    return true;
  }

  private updateCountermeasures(delta: number, time: number) {
    this.countermeasures.update(delta);
    if (!this.decoyTarget) return;
    if (this.countermeasures.activeTimer <= 0) this.decoyTarget.active = false;
    if (!this.decoyTarget.active) return;
    this.decoyTarget.body.position.y -= 4.5 * delta;
    this.flareEffectTimer = Math.max(0, this.flareEffectTimer - delta);
    if (this.frameCount % 2 === 0) {
      const p = this.decoyTarget.body.position;
      this.particles.spawnSparks(p.x + (Math.random() - 0.5) * 5, p.y, p.z + (Math.random() - 0.5) * 5, time);
      if (this.frameCount % 6 === 0) this.particles.spawnSmoke(p.x, p.y, p.z, time);
    }
  }

  private addThreat(points: number) {
    const previous = this.threatLevel;
    this.threatPoints = Math.max(0, this.threatPoints + Math.max(0, points));
    this.threatLevel = threatLevelForPoints(this.threatPoints);
    if (this.threatLevel > previous) {
      this.announce("THREAT LEVEL INCREASED", THREAT_NAMES[this.threatLevel - 1], this.threatLevel >= 4 ? "#ff3344" : "#ff9f43");
      this.audio.playThreatLevel();
    }
  }

  private addUnsecuredCredits(amount: number) {
    const award = Math.max(0, Math.round(amount));
    if (award > 0) this.unsecuredCredits += award;
  }

  private addSalvage(amount: number) {
    // C5 perk: salvageLuck multiplies every pickup's scrap yield.
    const boosted = amount * (1 + perkEffect("salvageLuck", this.perks.salvageLuck));
    this.runSalvage = collectSalvage(this.runSalvage, boosted);
  }

  private getMissionRuntimeSnapshot(): MissionRuntimeSnapshot {
    const player = this.helicopter.body.position;
    return {
      player: { x: player.x, y: player.y, z: player.z },
      healthRatio: this.health / Math.max(1, this.maxHealth),
      carryingCargo: this.delivery.isCarrying(),
    };
  }

  private objectiveMissionId(objective: Objective) {
    if (!objective.missionTargetId) {
      objective.missionTargetId = `objective-${objective.type}-${Math.round(objective.position.x)}-${Math.round(objective.position.z)}`;
    }
    return objective.missionTargetId;
  }

  private spawnMissionElite(mission: Mission, time: number) {
    if (!mission.targetId || !mission.destination) return;
    const target = new Enemy(
      this.scene,
      this.world,
      mission.destination.x,
      mission.destination.z,
      this.currentWave >= 5 ? EnemyType.SHOOTER : EnemyType.DRONE,
      Math.max(18, mission.destination.y ?? this.helicopter.body.position.y),
      {
        isElite: true,
        modifier: this.currentWave % 2 === 0 ? EnemyModifier.REGENERATING : EnemyModifier.SHIELDED,
        pattern: AttackPattern.CIRCLE,
      },
    );
    target.missionTargetId = mission.targetId;
    this.scaleEnemyForDifficulty(target);
    if (mission.type === MissionType.BOUNTY) {
      // C2: bounty targets are named aces — thicker hull plus a volatile affix.
      target.maxHp = Math.round(target.maxHp * 1.6);
      target.hp = target.maxHp;
      target.modifier |= EnemyModifier.EXPLOSIVE;
    }
    this.enemies.push(target);
    this.particles.spawnExplosion(target.body.position.x, target.body.position.y, target.body.position.z, 42, time, 18);
    this.announce(mission.type === MissionType.BOUNTY ? "BOUNTY TARGET" : "HIGH VALUE TARGET", "Elite contact marked", "#ff9b43");
  }

  private grantMissionReward(mission: Mission, time: number) {
    const claimed = this.missionManager.claimReward(mission);
    if (!claimed) return;
    const credits = claimed.main.credits + claimed.bonus.credits;
    const xp = claimed.main.xp + claimed.bonus.xp;
    const salvage = claimed.main.salvage + claimed.bonus.salvage;
    const countermeasures = (claimed.main.countermeasures ?? 0) + (claimed.bonus.countermeasures ?? 0);
    const repair = (claimed.main.repair ?? 0) + (claimed.bonus.repair ?? 0);
    this.delivery.awardCredits(credits);
    if (xp > 0) this.grantRunXp(xp, time);
    this.addSalvage(salvage);
    if (countermeasures > 0) this.countermeasures.replenish(countermeasures);
    if (repair > 0) {
      this.health = Math.min(this.maxHealth, this.health + repair);
      this.helicopter.repair(repair);
    }
    const bonusEarned = mission.bonusObjectives.some((item) => item.state === "COMPLETE");
    this.missionsCompleted++;
    this.missionBonusesCompleted += mission.bonusObjectives.filter((item) => item.state === "COMPLETE").length;
    this.announce(
      "MISSION COMPLETE",
      `+${credits} CR · +${salvage} salvage${bonusEarned ? " · BONUS" : ""}`,
      "#55f2c2",
    );
  }

  private updateMissions(time: number, delta: number) {
    const contract = this.delivery.activeContract;
    const generated = this.missionManager.tryGenerate(time, {
      wave: this.currentWave,
      threat: this.threatLevel,
      player: this.getMissionRuntimeSnapshot().player,
      sams: this.objectives.filter((o) => o.active && o.type === ObjectiveType.SAM_SITE).map((o) => ({
        id: this.objectiveMissionId(o), x: o.position.x, y: o.position.y, z: o.position.z,
      })),
      radars: this.objectives.filter((o) => o.active && o.type === ObjectiveType.RADAR_TOWER).map((o) => ({
        id: this.objectiveMissionId(o), x: o.position.x, y: o.position.y, z: o.position.z,
      })),
      delivery: contract && contract.state !== DeliveryState.COMPLETED && contract.state !== DeliveryState.FAILED
        ? { id: contract.id, x: contract.destinationPosition.x, y: contract.destinationPosition.y, z: contract.destinationPosition.z }
        : null,
    });
    if (generated) {
      if (generated.type === MissionType.HIGH_VALUE_TARGET || generated.type === MissionType.BOUNTY) this.spawnMissionElite(generated, time);
      this.announce("NEW MISSION", generated.title, "#ffe66d");
    }
    this.missionManager.update(time, delta, this.getMissionRuntimeSnapshot());
    let completed = this.missionManager.takeCompleted();
    while (completed) {
      this.grantMissionReward(completed, time);
      completed = this.missionManager.takeCompleted();
    }
  }

  private updateDepotService(delta: number) {
    this.depotServiceCooldown = Math.max(0, this.depotServiceCooldown - delta);
    const contract = this.delivery.activeContract;
    if (!contract) return;
    const player = this.helicopter.body.position;
    const distance = Math.min(
      Math.hypot(player.x - contract.originPosition.x, player.z - contract.originPosition.z),
      Math.hypot(player.x - contract.destinationPosition.x, player.z - contract.destinationPosition.z),
    );
    const weapon = this.weapons.get(this.currentWeapon);
    const needsService = this.health < this.maxHealth || this.currentFuel < this.maxFuel || Boolean(weapon && weapon.ammo < weapon.maxAmmo);
    if (!canUseDepotService(distance, this.depotServiceCooldown, needsService)) return;
    this.health = Math.min(this.maxHealth, this.health + this.maxHealth * 0.18);
    this.currentFuel = Math.min(this.maxFuel, this.currentFuel + this.maxFuel * 0.2);
    this.helicopter.repair(18);
    if (weapon) weapon.ammo = Math.min(weapon.maxAmmo, weapon.ammo + Math.ceil(weapon.maxAmmo * 0.25));
    this.depotServiceCooldown = 16;
    this.announce("DEPOT SERVICE", "Hull, fuel and ammunition restored", "#55f2c2");
  }

  /** Animate the extraction spawn ping: staggered rings expand outward and
   *  fade. Purely visual — never touches the pad's collision/zone logic. */
  private updateExtractionPulse(delta: number) {
    if (this.extractionPulseRings.length === 0) return;
    this.extractionPulseTimer += delta;
    let allDone = true;
    for (const ring of this.extractionPulseRings) {
      const local = this.extractionPulseTimer - ((ring.userData.pulseDelay as number) ?? 0);
      if (local < 0) continue;
      const t = Math.min(1, local / GameEngine.EXTRACTION_PULSE_DURATION);
      if (t >= 1) {
        ring.visible = false;
        continue;
      }
      allDone = false;
      const ease = 1 - Math.pow(1 - t, 3); // fast start, slow settle
      ring.scale.setScalar(1 + ease * (GameEngine.EXTRACTION_PULSE_RADIUS - 1));
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
    }
    if (allDone) this.extractionPulseRings.length = 0;
  }

  private updateThreatAndExtraction(delta: number, time: number) {
    this.updateExtractionPulse(delta);
    this.addThreat(delta * 0.18);
    if (!this.extractionPosition &&
        canOfferExtraction(this.currentWave, this.objectivesDestroyedThisRun, this.extractionOfferedThisRun)) {
      // C1: one LZ offer per run, gated by wave + objectives instead of raw time.
      this.extractionOfferedThisRun = true;
      this.spawnExtraction();
      this.extractionOfferLevel = this.threatLevel;
    }
    if (!this.extractionPosition) return;
    const player = this.helicopter.body.position;
    if (!this.extractionPressure && (time - this.extractionOfferTime > 90 || this.extractionPosition.z > player.z + 350)) {
      this.clearExtraction();
      return;
    }
    const dx = player.x - this.extractionPosition.x;
    const dz = player.z - this.extractionPosition.z;
    const inside =
      dx * dx + dz * dz <= GameEngine.EXTRACTION_ZONE_RADIUS * GameEngine.EXTRACTION_ZONE_RADIUS &&
      Math.abs(player.y - this.extractionPosition.y) < 48;
    if (inside) {
      if (!this.extractionPressure) {
        this.extractionPressure = true;
        this.announce("EXTRACTING", this.delivery.isCarrying() ? "ACTIVE DELIVERY WILL BE ABANDONED" : "Hold position", "#55f2c2");
        // C1: threat lock + spawn surge — the final hold-out is supposed to hurt.
        if (this.threatLevel < 3) this.threatLevel = 3;
        this.pendingSpawns = Math.min(this.pendingSpawns + 3, 6);
      }
      this.extractionProgress = Math.min(1, this.extractionProgress + (delta * this.difficulty.extractionHold) / EXTRACTION_HOLD_SECONDS);
      if (this.extractionProgress >= 1) this.completeExtraction(time);
    } else {
      this.extractionPressure = false;
      this.extractionProgress = Math.max(0, this.extractionProgress - delta * 0.18);
    }
  }

  private spawnExtraction() {
    this.clearExtraction();
    const player = this.helicopter.body.position;
    // Prefer a real rooftop LZ (helipad-tower deck, then a flat rooftop the
    // pad is painted on); fall back to the lowest open surface on the usual
    // lanes (waterfront / yards). Distance/safety rules are unchanged.
    const spot = this.city.findExtractionSpot(player.z);
    this.extractionPosition = new THREE.Vector3(spot.x, Math.max(1, spot.height + 1), spot.z);
    this.extractionOfferTime = performance.now() / 1000;
    const group = new THREE.Group();
    group.position.copy(this.extractionPosition);
    // Compact pad on rooftops, full-size pad on open ground.
    const rooftop = spot.kind !== "ground";
    const scale = rooftop ? 0.42 : 1;
    const ring = new THREE.Mesh(new THREE.RingGeometry(20 * scale, 23 * scale, 32), createGlowMaterial(0x55f2a2, 0.72));
    ring.rotation.x = -Math.PI / 2;
    const barA = new THREE.Mesh(new THREE.BoxGeometry(3 * scale, 0.25, 18 * scale), createGlowMaterial(0x55f2a2, 0.9));
    const barB = barA.clone();
    barA.position.x = -7 * scale;
    barB.position.x = 7 * scale;
    const cross = new THREE.Mesh(new THREE.BoxGeometry(14 * scale, 0.25, 3 * scale), createGlowMaterial(0x55f2a2, 0.9));
    group.add(ring, barA, barB, cross);
    if (rooftop) {
      // Painted landing deck + H marking so the roof reads as a real helipad.
      const deck = new THREE.Mesh(new THREE.BoxGeometry(9, 0.22, 9), new THREE.MeshLambertMaterial({ color: 0x1b2740 }));
      deck.position.y = -1.15;
      group.add(deck);
      // Vertical beacon so the rooftop LZ reads from street level.
      const beam = new THREE.Mesh(new THREE.BoxGeometry(1.6 * scale, 30, 1.6 * scale), createGlowMaterial(0x55f2a2, 0.16));
      beam.position.y = -12;
      group.add(beam);
    }
    // Brief green light-pulse sweep: two staggered rings ping outward from
    // the pad and fade, telegraphing the offer from far away. Fresh materials
    // (createGlowMaterial) so opacity animation never touches a shared cache.
    this.extractionPulseRings.length = 0;
    for (let i = 0; i < 2; i++) {
      const pulseRing = new THREE.Mesh(
        new THREE.RingGeometry(0.72, 1.0, 48),
        createGlowMaterial(0x55f2a2, 0.85),
      );
      pulseRing.rotation.x = -Math.PI / 2;
      pulseRing.position.y = 1.6 + i * 0.06;
      pulseRing.userData.pulseDelay = i * 0.35;
      group.add(pulseRing);
      this.extractionPulseRings.push(pulseRing);
    }
    this.extractionPulseTimer = 0;
    this.scene.add(group);
    this.extractionMarker = group;
    this.announce(
      "EXTRACTION AVAILABLE",
      rooftop ? `Rooftop LZ · Secure +${this.unsecuredCredits} CR` : `Secure +${this.unsecuredCredits} CR`,
      "#55f2c2",
    );
  }

  private clearExtraction() {
    if (this.extractionMarker) {
      this.extractionMarker.parent?.remove(this.extractionMarker);
      disposeObject3D(this.extractionMarker);
    }
    this.extractionMarker = null;
    this.extractionPulseRings.length = 0;
    this.extractionPosition = null;
    this.extractionProgress = 0;
    this.extractionPressure = false;
  }

  private completeExtraction(time: number) {
    const before = this.unsecuredCredits;
    const extractedSalvage = this.runSalvage;
    const salvageCredits = salvageCreditsFor(this.runSalvage);
    const settlement = settleExtraction(this.delivery.credits, before, this.runSalvage);
    this.delivery.awardCredits(settlement.securedBonus);
    this.unsecuredCredits = settlement.unsecured;
    this.runSalvage = 0;
    this.delivery.fail("EXTRACTED");
    this.clearExtraction();
    this.announce("EXTRACTION SUCCESSFUL", `+${settlement.securedBonus} CR secured${salvageCredits > 0 ? ` · ${salvageCredits} salvage` : ""}`, "#55f2c2");
    this.dispatchGameOver(time, "EXTRACTED", before + salvageCredits, extractedSalvage);
  }

  /** Safe post-boss victory extraction: banks all rewards and finishes run as Victory. */
  handleExtractSafely(time: number) {
    this.postBossDecisionAvailable = false;
    this.postBossDecisionPending = false;
    this.completeExtraction(time);
  }

  /** Post-boss Endless Overdrive choice: continues into Wave 11+ with escalating multipliers. */
  handleChooseOverdrive(time: number) {
    this.postBossDecisionAvailable = false;
    this.postBossDecisionPending = false;
    this.isOverdrive = true;
    this.overdriveMultiplier = 1.25;
    this.currentWave = 10; // startNextWave will increment to 11
    this.startNextWave();
    this.announce("ENDLESS OVERDRIVE ENGAGED", "Wave 11 · Multiplier ×1.25", "#ffaa33");
    this.audio.playWaveStart();
  }

  onSuperEvent = () => {
    this.activateDevastation(performance.now() / 1000);
  };

  /** B3: unleash the Devastation overcharge when the meter is full. */
  private activateDevastation(time: number) {
    if (!this.isPlaying || this.health <= 0) return;
    if (this.superActiveUntil > time || this.superCooldownUntil > time) return;
    if (this.superCharge < SUPER_MAX_CHARGE) return;
    this.superCharge = 0;
    this.superActiveUntil = time + SUPER_DURATION;
    this.superCooldownUntil = this.superActiveUntil + SUPER_COOLDOWN;
    this.announce("DEVASTATION", "Overcharge engaged — invulnerable", "#ff5d3a");
    this.triggerHitStop(0.18, 0.1);
    // Radial shockwave: stagger every enemy within 240u with falloff damage.
    const hx = this.helicopter.body.position.x;
    const hy = this.helicopter.body.position.y;
    const hz = this.helicopter.body.position.z;
    this.shockwaves?.spawn(hx, 0.5, hz, time, 240, 0xff5d3a, 1.2);
    this.volumetricExplosions.spawn(hx, hy, hz, 30, 10);
    this.audio.playExplosion(1.6);
    for (const e of this.enemies) {
      if (!e.active) continue;
      const dx = e.body.position.x - hx;
      const dz = e.body.position.z - hz;
      const distSq = dx * dx + dz * dz;
      if (distSq <= 240 * 240) {
        const falloff = 1 - Math.sqrt(distSq) / 240;
        if (e.takeDamage(8 + 52 * falloff, time) === "destroyed") this.onEnemyDestroyed(e, time);
      }
    }
    this.updateUI(time);
  }

  onKeyDown = (e: KeyboardEvent) => {
    if (!this.isPlaying) return;
    const key = e.key.toLowerCase();

    // Heading-relative flight schema:
    //   A/D (←/→)    rudder yaw — rotates the heading
    //   W/S (↑/↓)    cyclic thrust along the heading (forward / reverse)
    //   Q/E          lateral cyclic strafe
    //   Shift/Ctrl   collective climb / descend
    if (
      [
        "w",
        "a",
        "s",
        "d",
        "q",
        "e",
        "arrowup",
        "arrowleft",
        "arrowdown",
        "arrowright",
        "shift",
        "control",
        " ",
        "spacebar",
      ].includes(key)
    ) {
      e.preventDefault();
      this.movementKeys.add(key);
    }
    // Weapon switching (1-4 keys)
    if (key === "1") this.switchWeapon(WeaponType.MACHINE_GUN);
    if (key === "2") this.switchWeapon(WeaponType.MISSILE);
    if (key === "3") this.switchWeapon(WeaponType.ROCKET);
    if (key === "4") this.switchWeapon(WeaponType.SHOTGUN);
    if (key === "r") this.startReload();
    if (key === "c" && !e.repeat) this.deployCountermeasure(performance.now() / 1000);
    // Double-tap dash, Devastation (E), camera-recenter (X/V) and Q-salvo were
    // retired with the heading-relative schema — Q/E are strafe now, and salvo
    // painting lives on the Right-Mouse-Button.
  };

  onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    this.movementKeys.delete(key);
  };

  triggerDash(dx?: number, dz?: number) {
    if (this.dashState !== "READY") return;
    let targetX = dx ?? 0;
    let targetZ = dz ?? 0;

    if (Math.hypot(targetX, targetZ) < 0.01) {
      if (this.keyboardVelocity.lengthSq() > 0.01) {
        targetX = this.keyboardVelocity.x;
        targetZ = this.keyboardVelocity.y;
      } else if (Math.hypot(this.helicopter.body.velocity.x, this.helicopter.body.velocity.z) > 3.0) {
        targetX = this.helicopter.body.velocity.x;
        targetZ = this.helicopter.body.velocity.z;
      } else {
        const yaw = this.helicopter.mesh.rotation.y;
        targetX = Math.sin(yaw);
        targetZ = Math.cos(yaw);
      }
    }

    const mag = Math.hypot(targetX, targetZ);
    if (mag < 0.001) return;
    targetX /= mag;
    targetZ /= mag;

    this.dashState = "DASHING";
    this.dashCooldownTimer = 0;
    this.dashActiveTimer = MOVEMENT_CONFIG.dashDuration;
    this.dashDirection.set(targetX, 0, targetZ);
    this.helicopter.body.velocity.x = this.dashDirection.x * MOVEMENT_CONFIG.dashSpeed;
    this.helicopter.body.velocity.z = this.dashDirection.z * MOVEMENT_CONFIG.dashSpeed;
    this.helicopter.triggerDash(targetX, targetZ);
  }

  onLeftStick = (event: Event) => {
    const detail = (event as CustomEvent<StickInput>).detail;
    this.leftStick = {
      x: THREE.MathUtils.clamp(detail?.x ?? 0, -1, 1),
      y: THREE.MathUtils.clamp(detail?.y ?? 0, -1, 1),
      active: Boolean(detail?.active),
    };
    if (this.leftStick.active) this.audio.resume();
  };

  onRightStick = (event: Event) => {
    const detail = (event as CustomEvent<StickInput>).detail;
    this.rightStick = {
      x: THREE.MathUtils.clamp(detail?.x ?? 0, -1, 1),
      y: THREE.MathUtils.clamp(detail?.y ?? 0, -1, 1),
      active: Boolean(detail?.active),
    };
    this.isFiringMouse = this.rightStick.active;
    this.isMouseActive = !this.rightStick.active;
    if (this.rightStick.active) this.audio.resume();
  };

  private repairPlayer(amount: number) {
    const efficiency = 1 + this.runUpgrades.repair * 0.15;
    const before = this.health;
    this.health = resolveRepair(this.health, this.maxHealth, amount, efficiency);
    const applied = this.health - before;
    if (applied > 0) this.helicopter.repair(applied);
    return applied;
  }

  private applyPlayerDamage(
    amount: number,
    source: string,
    damageType: PlayerDamageType,
    time: number,
    feedback = true,
    /** World-space XZ direction the hit came FROM — drives the screen-edge
     *  damage arcs (helistrike:damage). Omitted for directionless sources
     *  (fuel starvation, lightning EMP). */
    fromDirection?: { x: number; z: number },
  ) {
    if (this.health <= 0 || this.gameOverDispatched) return 0;
    // Opening spawn protection: nothing hurts the player before the shield lifts.
    if (this.openingProtected) return 0;
    // B3: invulnerable during Devastation overcharge
    if (this.superActiveUntil > time) return 0;
    const blocked = this.shieldTimer > 0 || this.dashActiveTimer > 0;
    const rotorArmorBonus = perkEffect("crashResist", this.perks.crashResist);
    const mitigation = armorMitigation(this.hangarUpgrades.armor, this.runUpgrades.armor) + rotorArmorBonus;
    const result = resolvePlayerDamage(this.health, this.maxHealth, amount, mitigation, blocked);
    if (result.applied <= 0) return 0;
    this.health = result.health;
    this.lastDamageSource = source;
    this.recordDamageDiagnostics(source, damageType, result.applied, time);
    this.missionManager.reportPlayerDamage(source === "SAM MISSILE" ? "SAM_MISSILE" : "OTHER");
    this.helicopter.takeDamage(result.applied);
    if (feedback) this.audio.playHit();
    if ((damageType === "MISSILE" || damageType === "EXPLOSIVE" || damageType === "COLLISION") && result.applied >= 12) {
      this.addCameraImpulse(1.2);
    }
    if (feedback) {
      window.dispatchEvent(new CustomEvent("helistrike:player-hit", {
        detail: { amount: result.applied, source, damageType },
      }));
      if (fromDirection) {
        window.dispatchEvent(new CustomEvent("helistrike:damage", {
          detail: {
            angle: this.screenAngleFromDirection(fromDirection),
            amount: result.applied,
          },
        }));
      }
    }
    // Casual safety net: one automatic emergency repair the first time the
    // hull drops into the critical band — a second chance, not a heal loop.
    if (
      this.health > 0 &&
      this.difficulty.emergencyRepair &&
      !this.emergencyRepairUsed &&
      this.health <= this.maxHealth * 0.3
    ) {
      this.emergencyRepairUsed = true;
      const target = Math.round(this.maxHealth * 0.55);
      const healed = target - this.health;
      this.health = target;
      if (healed > 0) this.helicopter.repair(healed);
      this.announce("EMERGENCY REPAIR", "Auto-sealant engaged — hull stabilized", "#55f2c2");
    }
    this.updateUI(time);
    return result.applied;
  }

  /** DEV-only damage diagnostics: last hit source, amount, time and player
   *  position. Exposed on window + console in development builds only —
   *  production gameplay never shows technical debug data. */
  private recordDamageDiagnostics(source: string, damageType: PlayerDamageType, amount: number, time: number) {
    const p = this.helicopter.body.position;
    this.lastDamageInfo = { source, damageType, amount, time, x: p.x, y: p.y, z: p.z };
    if (import.meta.env.DEV) {
      (window as unknown as { __helistrikeLastDamage?: unknown }).__helistrikeLastDamage = this.lastDamageInfo;
      console.debug("[Heli-Strike] player damage", this.lastDamageInfo);
    }
  }

  /** Turn a world XZ direction (where the damage came from) into a
   *  screen-space angle relative to the camera view: 0° = dead ahead,
   *  +90° = right, ±180° = behind, -90° = left. The HUD rotates its edge
   *  arcs by this angle. */
  private screenAngleFromDirection(dir: { x: number; z: number }): number {
    const fwd = this.camera.getWorldDirection(GameEngine._scratchVec3);
    const fLen = Math.hypot(fwd.x, fwd.z) || 1;
    const fx = fwd.x / fLen;
    const fz = fwd.z / fLen;
    const dLen = Math.hypot(dir.x, dir.z) || 1;
    const dx = dir.x / dLen;
    const dz = dir.z / dLen;
    // Screen-right = forward × up in a y-up world.
    const forwardAmt = dx * fx + dz * fz;
    const rightAmt = dx * -fz + dz * fx;
    return Math.atan2(rightAmt, forwardAmt) * (180 / Math.PI);
  }

  // --- Opening sequence (GET READY — 3 — 2 — 1 — GO → grace shield) --------

  private dispatchOpening(detail: { phase: "countdown" | "grace" | "live"; count?: number; remaining?: number }) {
    window.dispatchEvent(new CustomEvent("helistrike:opening", { detail }));
  }

  /** Advance the countdown / grace spawn-protection sequence. Player movement
   *  and aiming stay live the whole time — only hostile pressure is gated. */
  private updateOpeningSequence(delta: number) {
    if (this.openingPhase === "countdown") {
      if (this.tutorialActive) {
        this.updateTutorial(delta);
        return;
      }
      this.openingTimer -= delta;
      const count = Math.ceil(Math.max(0, this.openingTimer));
      if (count !== this.openingCountSent) {
        this.openingCountSent = count;
        this.dispatchOpening({ phase: "countdown", count });
      }
      if (this.openingTimer <= 0) {
        this.openingPhase = "grace";
        this.graceTimer = this.difficulty.openingGraceSeconds;
        this.waveFireSilenceTimer = WAVE1_CONFIG.fireDelaySeconds;
        // Top the tank back up so whatever the tutorial/countdown burned
        // never follows the player into the live run.
        this.currentFuel = this.maxFuel;
        this.dispatchOpening({ phase: "grace", remaining: this.graceTimer });
      }
      return;
    }
    if (this.openingPhase === "grace") {
      this.graceTimer -= delta;
      // Fade the shield bubble over the final 0.6s so the protection visibly
      // lifts instead of popping off mid-frame.
      const mat = this.helicopter.shieldMesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.28 * THREE.MathUtils.clamp(this.graceTimer / 0.6, 0, 1);
      if (this.graceTimer <= 0) {
        this.openingPhase = "live";
        mat.opacity = 0.28;
        this.dispatchOpening({ phase: "live" });
      } else if (this.frameCount % 15 === 0) {
        this.dispatchOpening({ phase: "grace", remaining: this.graceTimer });
      }
    }
  }

  /** Are enemy weapons silenced right now (opening protection or the wave-1
   *  onboarding quiet window)? */
  private enemyFireSilenced(): boolean {
    return this.openingProtected || (this.currentWave === 1 && this.waveFireSilenceTimer > 0);
  }

  // --- First-run tutorial ---------------------------------------------------

  private dispatchTutorialStep() {
    const step = TUTORIAL_STEPS[this.tutorialStep];
    window.dispatchEvent(new CustomEvent("helistrike:tutorial", {
      detail: step
        ? { active: true, index: this.tutorialStep, total: TUTORIAL_STEPS.length, ...step }
        : { active: false },
    }));
  }

  /** Advance the tutorial one beat when the player performs the action (or an
   *  auto-advance timer expires so nothing can block the run). Runs while the
   *  countdown is frozen — full control, zero hostile pressure. */
  private updateTutorial(delta: number) {
    if (!this.tutorialActive) return;
    const step = TUTORIAL_STEPS[this.tutorialStep];
    if (!step) {
      this.finishTutorial();
      return;
    }
    this.tutorialAutoTimer += delta;
    if (step.id === "dodge") this.tutorialDodgeTimer -= delta;
    if (!this.tutorialStepDone(step.id) && this.tutorialAutoTimer < step.autoSeconds) return;
    this.tutorialStep++;
    this.tutorialAutoTimer = 0;
    this.onTutorialStepEnter();
    if (this.tutorialStep >= TUTORIAL_STEPS.length) {
      this.finishTutorial();
    } else {
      this.dispatchTutorialStep();
    }
  }

  private onTutorialStepEnter() {
    const step = TUTORIAL_STEPS[this.tutorialStep];
    if (!step) return;
    if (step.id === "fire") this.tutorialShotsAtStart = this.shotsFired;
    if (step.id === "aim") this.tutorialAimOrigin.copy(this.aimPoint);
    if (step.id === "dodge") this.spawnTutorialProjectile();
  }

  private tutorialStepDone(id: string): boolean {
    switch (id) {
      case "move":
        return this.keyboardVelocity.lengthSq() > 0.04;
      case "aim":
        return this.aimPoint.distanceTo(this.tutorialAimOrigin) > 8;
      case "fire":
        return this.shotsFired > this.tutorialShotsAtStart;
      case "climb":
        return this.verticalInput > 0.3;
      case "descend":
        return this.verticalInput < -0.3;
      case "dodge":
        return this.tutorialDodgeTimer <= 0;
      case "flares":
        return this.tutorialFlareUsed;
      case "salvo":
        return this.isPaintingLocks || this.salvoCooldownTimer > 0;
      case "devastation":
        return this.superActiveUntil > performance.now() / 1000;
      case "pause":
        return this.tutorialPausedOnce;
      default:
        return false;
    }
  }

  /** A slow, brightly-colored zero-damage tracer flies straight at the player
   *  so the EVADE beat has a real (but harmless) projectile to dodge. */
  private spawnTutorialProjectile() {
    this.tutorialDodgeTimer = 6;
    const p = this.helicopter.body.position;
    this.enemyProjectiles.spawn(
      p.x, p.y + 2, p.z - 130,
      0, 1,
      performance.now() / 1000,
      42, 0, 0, 0xffe066,
    );
  }

  private finishTutorial() {
    if (!this.tutorialActive) return;
    this.tutorialActive = false;
    try {
      window.localStorage.setItem(TUTORIAL_DONE_KEY, "1");
    } catch {
      // storage unavailable — the tutorial simply replays next run
    }
    window.dispatchEvent(new CustomEvent("helistrike:tutorial", { detail: { active: false } }));
    // Fresh 3-2-1 so the countdown always plays in full after the tutorial.
    this.openingTimer = 3;
    this.openingCountSent = 99;
  }

  /** Public hook for the HUD's "Skip Tutorial" button. */
  skipTutorial() {
    this.finishTutorial();
  }

  onHelicopterCollide = (e: { body?: CANNON.Body; contact?: CANNON.ContactEquation }) => {
    // Objectives are destructible targets, not obstacles.
    const isObjective =
      e.body && this.objectives.some((o) => o.active && o.body === e.body);
    if (isObjective) return;

    const body = this.helicopter.body;
    const velocity = body.velocity;
    const isBuilding = e.body && e.body.type === CANNON.Body.STATIC;
    let outwardX = 0;
    let outwardY = 0;
    let outwardZ = 0;
    let hasContactNormal = false;

    if (e.contact) {
      const normal = e.contact.ni;
      const direction = e.contact.bi === body ? -1 : 1;
      outwardX = normal.x * direction;
      outwardY = normal.y * direction;
      outwardZ = normal.z * direction;
      hasContactNormal =
        Number.isFinite(outwardX) &&
        Number.isFinite(outwardY) &&
        Number.isFinite(outwardZ);
    } else if (isBuilding && e.body) {
      const dx = body.position.x - e.body.position.x;
      const dz = body.position.z - e.body.position.z;
      const length = Math.hypot(dx, dz);
      if (length > 0.001) {
        outwardX = dx / length;
        outwardZ = dz / length;
        hasContactNormal = true;
      }
    }

    const outwardSpeed = hasContactNormal
      ? velocity.x * outwardX + velocity.y * outwardY + velocity.z * outwardZ
      : 0;
    const impact = hasContactNormal
      ? Math.max(0, -outwardSpeed)
      : Math.hypot(velocity.x, velocity.z);

    // Angle-aware severity: headOn is the fraction of total speed driven INTO
    // the surface (1 = dead-on slam, ~0 = glancing scrape). Clipping a wall
    // corner reads as a scrape — higher damage gate, reduced damage, sparks
    // only — while head-on hits keep their full penalty.
    const speedMag = Math.sqrt(
      velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
    );
    const headOn = speedMag > 0.001 ? impact / speedMag : 1;
    const isScrape = headOn < 0.35;

    if (isBuilding) {
      // Resolve every wall contact, not only damage ticks. Remove the inward
      // normal component while preserving tangential speed for controlled slides.
      const horizontalNormalLength = Math.hypot(outwardX, outwardZ);
      if (horizontalNormalLength > 0.1 && outwardSpeed < 0) {
        const nx = outwardX / horizontalNormalLength;
        const nz = outwardZ / horizontalNormalLength;
        const inwardHorizontalSpeed = velocity.x * nx + velocity.z * nz;
        if (inwardHorizontalSpeed < 0) {
          velocity.x -= nx * inwardHorizontalSpeed;
          velocity.z -= nz * inwardHorizontalSpeed;
        }
        body.position.x += nx * 0.025;
        body.position.z += nz * 0.025;
      }

      if (this.dashState === "DASHING") {
        this.dashState = "COOLDOWN";
        this.dashActiveTimer = 0;
        this.dashCooldownTimer = MOVEMENT_CONFIG.dashCooldown * Math.max(0.45, 1 - this.runUpgrades.dashCooldown * 0.15) * (1 - perkEffect("dash", this.perks.dash));
        this.helicopter.dashTimer = 0;
      }

      // Rooftop/street landings: damp the downward velocity so the hull
      // settles onto the pad instead of bouncing off the top of a building.
      if (Math.abs(outwardY) > 0.85 && velocity.y < 0) {
        velocity.y *= 0.25;
      }
    }

    const now = performance.now() / 1000;
    if (
      impact <= (isScrape ? 9 : 3.5) ||
      // Global collision-damage cooldown: one crash may hurt and push, but a
      // sustained contact never drains the hull tick by tick.
      now - this.lastCollisionDamageTime <= 1.0 ||
      this.openingProtected ||
      this.health <= 0
    ) return;

    // Glancing hits scale down with approach angle; head-on hits (~0.7+ of
    // speed into the surface) take the full severity.
    const angleFactor = isScrape ? 0.4 : 0.55 + 0.45 * Math.min(1, headOn / 0.7);
    const severity = impact * angleFactor;
    let dmg = Math.min(14, Math.max(3, severity * 1.1));
    if (isBuilding) {
      const isRoofContact = Math.abs(outwardY) > 0.85 && Math.abs(outwardX) < 0.5 && Math.abs(outwardZ) < 0.5;
      const isSlam = severity >= 12;
      dmg = isSlam
        ? Math.min(28, Math.round(10 + severity * 0.8))
        : Math.min(12, Math.round(3 + severity * 0.7));

      const horizontalNormalLength = Math.hypot(outwardX, outwardZ);
      const nx = horizontalNormalLength > 0.1 ? outwardX / horizontalNormalLength : 0;
      const nz = horizontalNormalLength > 0.1 ? outwardZ / horizontalNormalLength : 0;
      const spawnX = body.position.x + nx * 3.0;
      const spawnY = body.position.y;
      const spawnZ = body.position.z + nz * 3.0;

      if (isRoofContact) {
        // Hard rooftop/street landing: sparks + a thud, never an explosion or
        // slam shake — you're meant to land on LZ pads, and the damage is a
        // hard-landing penalty, not a crash.
        dmg = Math.min(8, Math.round(1 + impact * 0.35));
        this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
        this.audio.playHit();
      } else if (isSlam) {
        this.particles.spawnExplosion(spawnX, spawnY, spawnZ, 170, now, 48);
        this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
        this.particles.spawnSmoke(spawnX, spawnY, spawnZ, now);
        this.volumetricExplosions.spawn(spawnX, spawnY, spawnZ, 26, 8);
        this.audio.playExplosion(1.3);
        this.triggerHitStop(0.12, 0.2);
        this.crashSmokeTimer = 1.1;
        this.crashSmokePos = { x: spawnX, y: spawnY, z: spawnZ };
      } else if (isScrape) {
        // Corner scrape: sparks only, no smoke thump — it should feel minor.
        this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
      } else {
        this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
        this.particles.spawnSmoke(spawnX, spawnY, spawnZ, now);
        this.audio.playHit();
      }
    } else {
      this.audio.playHit();
    }

    // C5 perk: crashResist softens wall-slam and collision damage; the
    // difficulty's collisionDamage multiplier applies exactly once, here.
    const resistedDmg = dmg * (1 - perkEffect("crashResist", this.perks.crashResist)) * this.difficulty.collisionDamage;
    this.applyPlayerDamage(resistedDmg, isBuilding ? "BUILDING" : "COLLISION", "COLLISION", now, false);
    this.lastCollisionDamageTime = now;
    this.updateUI(now);
  };

  onGamepadConnected = (e: GamepadEvent) => {
    this.gamepadIndex = e.gamepad.index;
  };

  onGamepadDisconnected = () => {
    this.gamepadIndex = null;
    this.isFiringGamepad = false;
    this.isMouseActive = true;
  };

  onFireChange = (event: Event) => {
    const detail = (event as CustomEvent<{ active: boolean }>).detail;
    this.isFiringMouse = Boolean(detail?.active);
    if (this.isFiringMouse) this.audio.resume();
  };

  onSettingsChanged = (e: Event) => {
    const detail = (e as CustomEvent<Partial<GameSettings>>).detail;
    if (!detail) return;
    const next: GameSettings = { ...this.settings };
    if (detail.invertedY !== undefined) next.invertedY = detail.invertedY;
    if (detail.gamepadSensitivity !== undefined)
      next.gamepadSensitivity = THREE.MathUtils.clamp(detail.gamepadSensitivity, 0.4, 4);
    if (detail.quality !== undefined)
      next.quality =
        detail.quality === 'high'
          ? 'high'
          : detail.quality === 'medium'
            ? 'medium'
            : 'low';
    if (detail.graphics !== undefined)
      next.graphics = detail.graphics === 'hd' ? 'hd' : 'sp1';
    if (detail.volume !== undefined)
      next.volume = THREE.MathUtils.clamp(detail.volume, 0, 1);
    if (detail.musicVolume !== undefined)
      next.musicVolume = THREE.MathUtils.clamp(detail.musicVolume, 0, 1);
    if (detail.sfxVolume !== undefined)
      next.sfxVolume = THREE.MathUtils.clamp(detail.sfxVolume, 0, 1);
    if (detail.touchMode !== undefined) next.touchMode = detail.touchMode;
    if (detail.autoAim !== undefined) next.autoAim = detail.autoAim;
    if (detail.movement !== undefined)
      next.movement = detail.movement === 'simulation' ? 'simulation' : 'arcade';
    if (detail.screenShake !== undefined)
      next.screenShake =
        detail.screenShake === 'off' || detail.screenShake === 'low'
          ? detail.screenShake
          : 'full';
    if (detail.reduceFlash !== undefined) next.reduceFlash = detail.reduceFlash;
    if (detail.adaptiveQuality !== undefined) next.adaptiveQuality = detail.adaptiveQuality;
    if (detail.difficulty !== undefined) {
      next.difficulty =
        detail.difficulty === 'casual' || detail.difficulty === 'hard'
          ? detail.difficulty
          : 'normal';
    }
    this.settings = next;
    this.applySettings();
  };

  /** Toggle the environment debug overlay (chunk/road/combat/landmark cells). */
  onEnvDebug = (e: Event) => {
    const detail = (e as CustomEvent<{ on?: boolean }>).detail;
    this.city.setEnvDebug(Boolean(detail?.on));
  };

  /** Toggle the AI debug visualization overlay. */
  onAiDebug = (e: Event) => {
    const detail = (e as CustomEvent<{ on?: boolean }>).detail;
    if (typeof window !== "undefined") {
      (window as any).__HELI_AI_DEBUG__ = Boolean(detail?.on);
    }
  };

  /** Development telemetry metrics (Step 67) */
  getDebugMetrics() {
    let infantryCount = 0;
    let tankCount = 0;
    let airCount = 0;
    let bossActive = false;
    let currentGroundThreat = 0;
    let currentAirThreat = 0;

    for (const e of this.enemies) {
      if (e.active) {
        if (e.type === EnemyType.BASIC) {
          infantryCount++;
          currentGroundThreat += GROUND_THREAT_COSTS.INFANTRY;
        } else if (e.type === EnemyType.TANK) {
          tankCount++;
          currentGroundThreat += GROUND_THREAT_COSTS.TANK;
        } else if (e.type === EnemyType.DRONE) {
          airCount++;
          currentAirThreat += AIR_THREAT_COSTS.COMBAT_DRONE;
        } else if (e.type === EnemyType.BOSS) {
          bossActive = true;
        }
      }
    }

    const samCount = this.objectives.filter((o) => o.active && o.type === ObjectiveType.SAM_SITE).length;
    const radarActive = this.objectives.some((o) => o.active && o.type === ObjectiveType.RADAR_TOWER);
    currentGroundThreat += samCount * GROUND_THREAT_COSTS.SAM;

    return {
      wave: this.currentWave,
      currentGroundThreat,
      desiredGroundThreat: this.desiredGroundThreat || 0,
      currentAirThreat,
      desiredAirThreat: this.desiredAirThreat || 0,
      infantryCount,
      tankCount,
      samCount,
      radarActive,
      airCount,
      bossActive,
      spawnQueue: this.pendingSpawns + this.pendingVariantQueue.length + this.pendingEventSpawns.length,
      projectiles:
        this.playerProjectiles.pool.filter((p) => p.active).length +
        this.enemyProjectiles.pool.filter((p) => p.active).length,
    };
  }

  readPlayerModel(): HelicopterModel {
    try {
      const raw = window.localStorage.getItem('helistrike:playerModel');
      const n = Number(raw);
      return n === HelicopterModel.NIGHTHAWK || n === HelicopterModel.WARLOCK
        ? n
        : HelicopterModel.APACHE;
    } catch {
      return HelicopterModel.APACHE;
    }
  }

  onPlayerModelChanged = (e: Event) => {
    const detail = (e as CustomEvent<{ model: HelicopterModel }>).detail;
    if (detail?.model === undefined || detail.model === this.playerModel) return;
    this.playerModel = detail.model;
    try {
      window.localStorage.setItem('helistrike:playerModel', String(detail.model));
    } catch {
      // storage unavailable
    }
    // Rebuild only in the menu (wave 0, not playing) — never mid-run, not even paused
    if (this.currentWave === 0 && !this.isPlaying) {
      this.rebuildHelicopter();
    }
  };

  private rebuildHelicopter() {
    // Entity.destroy skips cached shared buffers, preventing remount/model-switch crashes.
    this.helicopter.body.removeEventListener("collide", this.onHelicopterCollide);
    this.helicopter.destroy();
    // Build the newly selected model
    this.helicopter = new Helicopter(this.scene, this.world, this.playerModel);
    this.helicopter.body.addEventListener("collide", this.onHelicopterCollide);
    this.delivery.setCarrierRoot(this.helicopter.mesh);
    this.movementTarget.set(0, FLIGHT_SPEC.spawnAltitude, 0);
    this.updateUI(performance.now() / 1000);
  }

  onUpgradeChosen = (e: Event) => {
    const detail = (e as CustomEvent<{ id: UpgradeId }>).detail;
    if (!detail || !this.upgradePaused) return;
    this.applyRunUpgrade(detail.id);
    this.upgradePaused = false;
    this.isPlaying = true;
    if (!this.gameOverDispatched && this.health > 0) {
      this.helicopter.mesh.visible = true;
    }
    // If a boss gem queued several level-ups, immediately offer the next pick
    this.offerNextLevelUp();
    this.updateUI(performance.now() / 1000);
  };

  /** Grant a picked upgrade and resume play. */
  private applyRunUpgrade(id: UpgradeId) {
    this.runUpgrades[id]++;
    switch (id) {
      case 'maxHealth':
        this.maxHealth += 20;
        this.repairPlayer(20);
        break;
      case 'repair':
        this.repairPlayer(25);
        break;
      case 'ammo':
        for (const [wt, cfg] of this.weapons.entries()) {
          cfg.maxAmmo = Math.round(cfg.maxAmmo * 1.3);
          cfg.ammo = cfg.maxAmmo;
        }
        break;
      case 'shield':
        this.shieldTimer = 8.0;
        break;
      case 'speed':
        this.speedBoostTimer = 12.0;
        break;
      case 'bomb':
        this.applyPowerUp(PowerUpType.BOMB, performance.now() / 1000);
        break;
      default:
        break; // multiplicative upgrades are applied at use-site
    }
    this.audio.playUpgrade();
  }

  /** Open the upgrade roulette: pause gameplay, dispatch 3 options. */
  private offerUpgrade() {
    this.pendingUpgradeOffer = pickUpgrades(3);
    this.upgradePaused = true;
    this.isPlaying = false;
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    window.dispatchEvent(
      new CustomEvent("helistrike:upgrade-offer", {
        detail: { options: this.pendingUpgradeOffer },
      }),
    );
  }

  /** Emit a transient arcade announcement (kill streaks, objectives, boss phases). */
  private announce(text: string, sub: string = "", color: string = "#ffe66d") {
    this.announceQueue.push({ text, sub, color });
  }

  private findLockTarget(dirX: number, dirZ: number, maxDistance = 190) {
    let bestEnemy: Enemy | null = null;
    let bestScore = Infinity;
    const origin = this.helicopter.body.position;

    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const dx = enemy.body.position.x - origin.x;
      const dz = enemy.body.position.z - origin.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 16 || distSq > maxDistance * maxDistance) continue;

      const dist = Math.sqrt(distSq);
      const dot = (dx / dist) * dirX + (dz / dist) * dirZ;
      if (dot < 0.55) continue;

      const score = distSq * (1.45 - dot);
      if (score < bestScore) {
        bestScore = score;
        bestEnemy = enemy;
      }
    }

    return bestEnemy;
  }

  fireWeapons = (time: number) => {
    if (this.isReloading) return;

    const weapon = this.weapons.get(this.currentWeapon);
    if (!weapon) return;

    // Weapon level bonuses (permanent XP progression)
    const level = this.weaponLevels.get(this.currentWeapon) ?? 1;
    const lvlBonus = weaponLevelBonus(level);

    // Run upgrade multipliers
    const dmgUp = 1 + this.runUpgrades.damage * 0.25;
    // B3: Devastation overcharge doubles fire rate while active
    const rateUp = (1 + this.runUpgrades.fireRate * 0.18) * (this.superActiveUntil > time ? 2.2 : 1);
    const afterburnerDmg = this.afterburnerActive ? 1.35 : 1.0;

    // Check ammo
    if (weapon.ammo <= 0) {
      this.startReload();
      return;
    }

    // Check fire rate (level + upgrade + afterburner all apply)
    if (time - this.lastFireTime < weapon.fireRate * lvlBonus.fireRateMult / rateUp) return;
    this.lastFireTime = time;

    // Deduct ammo
    weapon.ammo--;
    this.shotsFired++;
    this.lastFiredWeapon = this.currentWeapon;
    this.lastFireTimestamp = time;

    // Machine-gun rounds always leave the rotating chin turret's real muzzle
    // and fly exactly where the physical barrel points. Missiles, rockets, and
    // shotgun payloads keep their existing wing/nose spawn behavior.
    const usingGun = this.currentWeapon === WeaponType.MACHINE_GUN;
    let originX: number, originY: number, originZ: number;
    let hDirX: number, hDirZ: number;
    let dirY = 0;
    if (usingGun) {
      const muzzlePos = this.helicopter.getMuzzlePosition(this.muzzlePositionScratch);
      const muzzleDir = this.helicopter.getMuzzleDirection(this.muzzleDirectionScratch);
      originX = muzzlePos.x;
      originY = muzzlePos.y;
      originZ = muzzlePos.z;
      hDirX = muzzleDir.x;
      dirY = muzzleDir.y;
      hDirZ = muzzleDir.z;
    } else {
      originX = this.helicopter.body.position.x;
      originY = this.helicopter.body.position.y -
        (this.currentWeapon === WeaponType.MISSILE || this.currentWeapon === WeaponType.ROCKET ? -0.75 : -0.45);
      originZ = this.helicopter.body.position.z;
      hDirX = this.aimPoint.x - originX;
      hDirZ = this.aimPoint.z - originZ;
    }
    const aimLen = Math.sqrt(hDirX * hDirX + hDirZ * hDirZ);
    if (!usingGun && aimLen > 0.001) {
      hDirX /= aimLen;
      hDirZ /= aimLen;
    } else if (
      !Number.isFinite(hDirX) || !Number.isFinite(dirY) || !Number.isFinite(hDirZ) ||
      aimLen <= 0.001
    ) {
      const fallback = this.getFallbackFireDirection();
      hDirX = fallback.x;
      dirY = 0;
      hDirZ = fallback.z;
    }
    const heading = Math.atan2(hDirX, hDirZ);
    const cursorLock =
      this.currentWeapon === WeaponType.MACHINE_GUN
        ? null
        : this.autoAimTarget?.active
          ? this.autoAimTarget
          : this.findAutoAimTarget(this.mouseAimValid ? 225 : 235, this.mouseAimValid);
    // Machine-gun rounds are ballistic along the physical barrel. Homing and
    // projectile steering remain exclusive to the existing non-MG weapon paths.
    const lockTarget =
      this.currentWeapon === WeaponType.MACHINE_GUN
        ? null
        : cursorLock ?? this.findLockTarget(hDirX, hDirZ, weapon.homing ? 230 : 170);
    const projectileAssist =
      weapon.homing
        ? 7.4
        : lockTarget
          ? this.currentWeapon === WeaponType.SHOTGUN
            ? 1.2
            : 2.8
          : 0;

    // Play appropriate sound
    switch (this.currentWeapon) {
      case WeaponType.MISSILE:      this.audio.playMissileLaunch();
      this.helicopter.triggerFirePitch(0.05); // salvo launch — tiny nose kick


        break;
      case WeaponType.ROCKET:
        this.audio.playRocketLaunch();
        // A3: backblast shove — heavy launches kick the hull backwards
        this.helicopter.addImpulse(-hDirX * 7, -hDirZ * 7);
        this.helicopter.triggerFirePitch(0.07);
        break;
      case WeaponType.SHOTGUN:
        this.audio.playShotgun(this.helicopter.body.position.x);
        this.helicopter.addImpulse(-hDirX * 3.5, -hDirZ * 3.5);
        break;
      default:
        this.audio.playMachineGun(this.helicopter.body.position.x);
    }

    const rightUnitX = Math.cos(heading);
    const rightUnitZ = -Math.sin(heading);
    const noseOffset = this.currentWeapon === WeaponType.SHOTGUN ? 3.1 : 2.55;
    const podSpacing =
      this.currentWeapon === WeaponType.MACHINE_GUN
        ? 0.0
        : this.currentWeapon === WeaponType.SHOTGUN
          ? 0.42
          : 3.0;
    const muzzleY =
      this.helicopter.body.position.y +
      (this.currentWeapon === WeaponType.MISSILE || this.currentWeapon === WeaponType.ROCKET ? -0.75 : -0.45);

    // Rank-5 signature alt-fires
    const mastered = level >= MAX_WEAPON_LEVEL;
    const altCountBonus =
      mastered && this.currentWeapon === WeaponType.MISSILE ? 1 : 0;

    // C6: hangar-selected weapon mod for this weapon (0 = factory config).
    const modChoice = this.weaponMods[this.currentWeapon] ?? 0;

    // Fire projectiles based on weapon config (level adds projectiles at rank 4+)
    const totalCount = weapon.count + lvlBonus.extraProjectiles + altCountBonus;
    for (let i = 0; i < totalCount; i++) {
      let dirX = hDirX;
      let dirZ = hDirZ;
      const side =
        totalCount === 1
          ? this.muzzleFlip
          : i - (totalCount - 1) / 2;

      // Apply spread for shotgun (and widened spread for leveled weapons)
      if (weapon.spread > 0) {
        // C6: Slug Barrel tightens the shotgun pattern
        const slugTighten = this.currentWeapon === WeaponType.SHOTGUN && modChoice === 2 ? 0.55 : 1;
        const spreadMul = (1 + (level - 1) * 0.1) * slugTighten;
        const angle = (i - (totalCount - 1) / 2) * weapon.spread * spreadMul;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        dirX = hDirX * cos - hDirZ * sin;
        dirZ = hDirX * sin + hDirZ * cos;
      }

      // Rank-5 alt-fire per weapon:
      // MG: tracer rounds ignore shields · Missile: double volley · Rocket: napalm blast
      // Shotgun: slug burst (tighter spread handled via spreadMul at max level)
      let damage = weapon.damage * lvlBonus.damageMult * dmgUp * afterburnerDmg;
      let blast = weapon.blastRadius;
      if (mastered) {
        if (this.currentWeapon === WeaponType.MACHINE_GUN) damage *= 1.25;
        if (this.currentWeapon === WeaponType.ROCKET) blast = Math.max(blast, 40);
        if (this.currentWeapon === WeaponType.SHOTGUN) damage *= 1.15;
      }
      // C6: weapon-mod stat changes (Slug +30% dmg, Napalm +30% blast)
      if (this.currentWeapon === WeaponType.SHOTGUN && modChoice === 2) damage *= 1.3;
      if (this.currentWeapon === WeaponType.ROCKET && modChoice === 1) blast *= 1.3;

      const spawnOffset = usingGun ? 0 : noseOffset;
      const shot = this.playerProjectiles.spawn(
        originX + hDirX * spawnOffset + rightUnitX * side * podSpacing,
        originY,
        originZ + hDirZ * spawnOffset + rightUnitZ * side * podSpacing,
        dirX,
        dirZ,
        time,
        weapon.speed,
        damage,
        blast,
        weapon.color,
        lockTarget,
        projectileAssist,
        usingGun ? dirY * weapon.speed : 0,
      );
      if (shot) this.tagProjectileWithMod(shot, modChoice);
    }
    if (totalCount === 1) this.muzzleFlip *= -1;

    // Weapon specific muzzle flash & shake (flash from the same origin as the bullets)
    const fxOffset = usingGun ? 0 : noseOffset;
    const fxX = originX + hDirX * fxOffset;
    const fxY = usingGun ? originY : muzzleY;
    const fxZ = originZ + hDirZ * fxOffset;
    
    // NOTE: MACHINE_GUN carries a small spread value (0.015 bullet spread), so
    // the shotgun branch must be keyed on the weapon TYPE, not spread > 0.
    if (this.currentWeapon === WeaponType.SHOTGUN) {
      // Shotgun Flash — no camera shake
      this.particles.spawnExplosion(fxX, fxY, fxZ, 15, time, 12);
    } else if (weapon.blastRadius > 0) {
      // Missile / Rocket backblast — tiny visual nose kick, no camera shake
      this.particles.spawnExplosion(fxX, fxY, fxZ, 8, time, 6);
      this.helicopter.triggerFirePitch(0.06);
    } else {
      // Machine Gun Sparks + barrel recoil (visual only — no camera shake)
      for(let s=0; s<2; s++) this.particles.spawnSparks(fxX, fxY, fxZ, time);
      this.helicopter.triggerRecoil(0.22);
    }

    // Auto-reload if out of ammo
    if (weapon.ammo <= 0) {
      this.startReload();
    }
  };

  /** C6/B1: stamp the active weapon mod onto a freshly spawned shot. */
  private tagProjectileWithMod(proj: Projectile, modChoice: number) {
    switch (this.currentWeapon) {
      case WeaponType.MACHINE_GUN:
        if (modChoice === 1) { proj.procKind = "burn"; proj.procChance = 0.18; } // Incendiary Rounds
        else if (modChoice === 2) proj.piercing = true;                            // Piercing Rounds
        break;
      case WeaponType.MISSILE:
        if (modChoice === 1) { proj.procKind = "emp"; proj.procChance = 1; }       // EMP Warheads
        else if (modChoice === 2) proj.cluster = true;                             // Cluster Warheads
        break;
      case WeaponType.ROCKET:
        if (modChoice === 1) { proj.procKind = "burn"; proj.procChance = 0.5; }    // Napalm Payload
        else if (modChoice === 2) proj.shaped = true;                              // Shaped Charge
        break;
      case WeaponType.SHOTGUN:
        if (modChoice === 1) { proj.procKind = "shock"; proj.procChance = 0.25; }  // Shock Shells
        break;
    }
  }

  /** B1/C6: roll a status proc for a hit. Mod-tagged shots roll their own
   *  chance; untagged shots can still proc from upgrade-pool picks. The
   *  procChance perk adds a bonus to every roll. */
  private tryApplyStatusProc(proj: Projectile, enemy: Enemy, time: number) {
    if (!enemy.active) return;
    const perkBonus = perkEffect("procChance", this.perks.procChance);
    if (proj.procKind && proj.procChance > 0) {
      const stacks = proj.procKind === "burn" ? this.runUpgrades.incendiary
        : proj.procKind === "emp" ? this.runUpgrades.empPayload
          : this.runUpgrades.shockCoils;
      if (Math.random() < statusProcChance(proj.procChance, perkBonus + stacks * 0.06)) {
        enemy.applyStatus(proj.procKind, time);
      }
      return;
    }
    if (this.runUpgrades.incendiary > 0 && Math.random() < statusProcChance(this.runUpgrades.incendiary * 0.06, perkBonus)) {
      enemy.applyStatus("burn", time);
    } else if (this.runUpgrades.shockCoils > 0 && Math.random() < statusProcChance(this.runUpgrades.shockCoils * 0.05, perkBonus)) {
      enemy.applyStatus("shock", time);
    } else if (this.runUpgrades.empPayload > 0 && proj.blastRadius > 0 && Math.random() < statusProcChance(this.runUpgrades.empPayload * 0.07, perkBonus)) {
      enemy.applyStatus("emp", time);
    }
  }

  /** C6: cluster warheads — 3 mini-blasts scatter around the impact point. */
  private spawnClusterBlasts(x: number, y: number, z: number, damage: number, time: number) {
    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 10 + Math.random() * 8;
      const cx = x + Math.cos(angle) * dist;
      const cz = z + Math.sin(angle) * dist;
      this.particles.spawnExplosion(cx, y, cz, this.fxCount(45), time, 16);
      this.volumetricExplosions.spawn(cx, y, cz, 7, 4);
      this.shockwaves?.spawn(cx, 0.5, cz, time, 16, 0xffcc66, 0.5);
      for (const e of this.enemies) {
        if (!e.active) continue;
        const dx = e.body.position.x - cx;
        const dz = e.body.position.z - cz;
        if (dx * dx + dz * dz < 400) {
          if (e.takeDamage(damage * 0.4, time) === "destroyed") this.onEnemyDestroyed(e, time);
        }
      }
      this.city.damageNearby(cx, cz, 14, damage * 0.4);
    }
    this.audio.playExplosion(0.5);
  }

  /** B2: the nearest live VAMPIRIC enemy heals a fraction of confirmed damage. */
  private healVampiricEnemies(damageDealt: number, time: number) {
    let best: Enemy | null = null;
    let bestDistSq = 70 * 70;
    for (const e of this.enemies) {
      if (!e.active || !(e.modifier & EnemyModifier.VAMPIRIC)) continue;
      const d = e.body.position.distanceSquared(this.helicopter.body.position);
      if (d < bestDistSq) {
        bestDistSq = d;
        best = e;
      }
    }
    if (!best) return;
    best.hp = Math.min(best.maxHp, best.hp + damageDealt * VAMPIRIC_HEAL_FRACTION);
    this.particles.spawnSparks(best.body.position.x, best.body.position.y, best.body.position.z, time, 2, 12);
  }

  /** B2: EXPLOSIVE affix — death detonation that hurts everything nearby
   *  (enemies, the player, and the city around the blast). */
  private detonateExplosiveAffix(enemy: Enemy, time: number) {
    const x = enemy.body.position.x;
    const y = enemy.body.position.y;
    const z = enemy.body.position.z;
    this.particles.spawnExplosion(x, y, z, this.fxCount(90), time, 28);
    this.volumetricExplosions.spawn(x, y, z, 14, 7);
    this.shockwaves?.spawn(x, 0.5, z, time, EXPLOSIVE_AFFIX_RADIUS * 1.5, 0xff7733, 0.6);
    this.audio.playExplosion(1.1);
    this.addExplosionImpulse(x, y, z, 2.2, EXPLOSIVE_AFFIX_RADIUS * 2.4);
    for (const other of this.enemies) {
      if (!other.active || other === enemy) continue;
      const d = Math.hypot(other.body.position.x - x, other.body.position.z - z);
      if (d < EXPLOSIVE_AFFIX_RADIUS) {
        const dmg = EXPLOSIVE_AFFIX_DAMAGE * (1 - d / EXPLOSIVE_AFFIX_RADIUS);
        if (other.takeDamage(dmg, time) === "destroyed") this.onEnemyDestroyed(other, time);
      }
    }
    const pdx = this.helicopter.body.position.x - x;
    const pdz = this.helicopter.body.position.z - z;
    const pd = Math.hypot(pdx, pdz);
    if (pd < EXPLOSIVE_AFFIX_RADIUS) {
      this.applyPlayerDamage(
        Math.round(EXPLOSIVE_AFFIX_DAMAGE * 0.5 * (1 - pd / EXPLOSIVE_AFFIX_RADIUS)),
        "EXPLOSIVE AFFIX", "EXPLOSIVE", time, true,
        pd > 0.001 ? { x: pdx / pd, z: pdz / pd } : undefined,
      );
    }
    this.city.damageNearby(x, z, EXPLOSIVE_AFFIX_RADIUS, 60);
  }

  /** B2: SPLITTER affix — death releases a ring of fragile kamikaze drones. */
  private spawnSplitterDrones(parent: Enemy) {
    const now = performance.now() / 1000;
    for (let i = 0; i < SPLITTER_DRONE_COUNT; i++) {
      const angle = (i / SPLITTER_DRONE_COUNT) * Math.PI * 2;
      const x = parent.body.position.x + Math.cos(angle) * 6;
      const z = parent.body.position.z + Math.sin(angle) * 6;
      const drone = new Enemy(
        this.scene,
        this.world,
        x,
        z,
        EnemyType.DRONE,
        Math.max(8, parent.body.position.y),
        { modifier: EnemyModifier.NONE, pattern: AttackPattern.KAMIKAZE, variant: EnemyVariant.STANDARD, isElite: false },
      );
      this.scaleEnemyForDifficulty(drone);
      drone.hp *= 0.5;
      drone.maxHp *= 0.5;
      this.enemies.push(drone);
      this.particles.spawnExplosion(x, drone.body.position.y, z, 20, now, 12);
    }
    this.announce("SPLITTER", "Drone swarm released", "#ffb84d");
  }

  /**
   * Full kill processing: XP, kill streaks, risk multiplier scoring,
   * hit-stop, power-up drops, and the death explosion.
   */
  private onEnemyDestroyed(enemy: Enemy, time: number, source: "WEAPON" | "BOMB" | "ENVIRONMENT" = "WEAPON") {
    if (this.processedEnemyDeaths.has(enemy)) return;
    this.processedEnemyDeaths.add(enemy);
    enemy.active = false;
    this.totalKills++;
    // B3: kills charge the Devastation meter (combo tiers accelerate it)
    if (this.superCooldownUntil <= time) {
      const chargeGain = superChargeForKill(this.comboCount, enemy.isElite, enemy.type === EnemyType.BOSS)
        * (1 + perkEffect("superCharge", this.perks.superCharge));
      this.superCharge = Math.min(SUPER_MAX_CHARGE, this.superCharge + chargeGain);
    }
    this.missionManager.reportEnemyDestroyed(
      enemy.missionTargetId,
      enemy.isElite,
      time,
      this.getMissionRuntimeSnapshot(),
      { x: enemy.body.position.x, y: enemy.body.position.y, z: enemy.body.position.z },
    );
    this.addThreat(enemy.type === EnemyType.BOSS ? 28 : enemy.isElite ? 7 : enemy.variant !== EnemyVariant.STANDARD ? 1.2 : 0.35);
    const bounty = securedEnemyBounty(enemy.type, enemy.isElite);
    if (bounty > 0) {
      this.delivery.awardCredits(bounty);
      this.addUnsecuredCredits(threatBonusFor(bounty, this.threatLevel));
    }
    if (enemy.type === EnemyType.BOSS) {
      this.bossesDestroyed++;
      this.delivery.awardCredits(1000);
      this.addSalvage(10);
      this.repairPlayer(40);
      this.announce("HEAVY GUNSHIP DESTROYED", "Airspace liberated · +1000 CR", "#55f2a2");
      this.postBossDecisionPending = true;
      this.postBossDecisionTimer = time + 1.5;
    }
    this.grantWeaponXp(this.lastFiredWeapon);

    // Kill streaks -> arcade announcements + slow-mo on multi-kills
    const now = time;
    if (now - this.lastKillTime < 1.4) {
      this.killStreakCount++;
    } else {
      this.killStreakCount = 1;
    }
    this.lastKillTime = now;
    const tier = multikillTier(this.killStreakCount);
    if (tier) {
      this.announce(tier.label, "", tier.color);
      this.audio.playKillCombo(Math.min(this.killStreakCount, 5));
      if (this.killStreakCount >= 3) {
        this.triggerHitStop(0.3, 0.35); // slow-mo on multi-kills
        this.combatDirector.triggerMicroLull(3.0); // 3-second breathing window to collect XP
      }
    }

    // Risky Rendezvous: low health multiplies score (difficulty-scaled ceiling)
    const risk = riskMultiplier(this.health, this.maxHealth, this.difficulty.maxRisk);
    const overdriveMult = this.isOverdrive ? this.overdriveMultiplier : 1.0;
    this.score += Math.floor(enemy.basePoints * this.comboMultiplier * risk * overdriveMult);
    if (this.isOverdrive && Math.random() < (this.overdriveMultiplier - 1.0) * 0.35) {
      this.addSalvage(1);
    }
    this.updateUI(time);

    // Trigger Hit-Stop for enemy kills to give a crunchy impact feel
    const stopDuration = enemy.type === EnemyType.BOSS ? 0.32 : enemy.type === EnemyType.TANK ? 0.12 : 0.06;
    const stopScale = enemy.type === EnemyType.BOSS ? 0.02 : 0.05;
    if (source !== "BOMB") this.triggerHitStop(stopDuration, stopScale);

    const isSpiralAirKill =
      (enemy.type === EnemyType.DRONE || enemy.movementClass === EnemyMovementClass.FLYING) &&
      enemy.isDying &&
      source !== "BOMB" &&
      enemy.type !== EnemyType.BOSS;
    const enemyXp = xpForEnemyType(enemy.type, enemy.isElite, enemy.variant);

    if (isSpiralAirKill) {
      this.audio.playAirDeathSpiral();
      // Initial lethal strike pop on the aircraft
      this.particles.spawnExplosion(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z, 28, time, 10);
      this.particles.spawnSparks(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z, time, 4, 14);
    } else {
      // Vampire-Survivors style: immediate kill drops XP gem and loot
      this.dropXpGem(
        enemy.body.position.x,
        enemy.body.position.y,
        enemy.body.position.z,
        enemyXp,
      );
      this.dropEnemyLoot(enemy);
    }

    if (enemy.type === EnemyType.BOSS) {
      this.floatingCombatText.spawnGroupedKill(
        enemy.id,
        enemy.body.position,
        "BOSS DESTROYED",
        `+${enemyXp} XP   +${bounty} CR`,
        "#ff3366",
        time,
      );
      this.announce("BOSS DESTROYED", `+${bounty} CR`, "#d78cff");
    } else if (enemy.isElite) {
      this.floatingCombatText.spawnGroupedKill(
        enemy.id,
        enemy.body.position,
        "ELITE DESTROYED",
        `+${enemyXp} XP   +${bounty} CR`,
        "#ffd000",
        time,
      );
      this.announce("ELITE DESTROYED", `+${bounty} CR`, "#ffdd55");
    } else if (enemy.type === EnemyType.TANK) {
      this.floatingCombatText.spawnGroupedKill(
        enemy.id,
        enemy.body.position,
        "TANK DESTROYED",
        `+${enemyXp} XP`,
        "#ff9f43",
        time,
      );
    } else {
      // Basic enemy kill: show XP reward while keeping killing damage number visible
      this.floatingCombatText.spawnReward(enemy.body.position, `+${enemyXp} XP`, "XP", undefined, enemyXp, time);
    }

    if (!isSpiralAirKill) {
      // Bigger explosion for enemies based on type
      const explosionSize = enemy.type === EnemyType.BOSS ? 200 : enemy.isElite ? 150 : enemy.type === EnemyType.TANK ? 120 : 80;
      const volumetricScale = enemy.type === EnemyType.BOSS ? 30 : enemy.isElite ? 24 : enemy.type === EnemyType.TANK ? 18 : 12;

      this.particles.spawnExplosion(
        enemy.body.position.x,
        enemy.body.position.y,
        enemy.body.position.z,
        explosionSize,
        time,
        explosionSize * 0.4,
      );
      // Debris chunks + smoke + sparks make each kill read as a real detonation
      // (boss/elites throw more debris, tanks kick up extra sparks).
      this.particles.spawnDebris(
        enemy.body.position.x,
        enemy.body.position.y,
        enemy.body.position.z,
        time,
        enemy.type === EnemyType.BOSS ? 30 : enemy.isElite ? 22 : enemy.type === EnemyType.TANK ? 16 : 8,
        enemy.type === EnemyType.BOSS ? 40 : 28,
      );
      this.particles.spawnSmoke(enemy.body.position.x, enemy.body.position.y + 1, enemy.body.position.z, time);
      this.particles.spawnSparks(
        enemy.body.position.x,
        enemy.body.position.y,
        enemy.body.position.z,
        time,
        enemy.type === EnemyType.TANK ? 6 : 3,
        enemy.type === EnemyType.BOSS ? 40 : 24,
      );
      this.volumetricExplosions.spawn(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z, volumetricScale, volumetricScale * 0.6);
      this.city.damageNearby(enemy.body.position.x, enemy.body.position.z, enemy.type === EnemyType.BOSS ? 40 : 22, 95);
      this.audio.playExplosion(enemy.type === EnemyType.BOSS ? 2.5 : 1.5);
    }

    // B2: elite-affix death behaviors
    if (enemy.modifier & EnemyModifier.EXPLOSIVE) this.detonateExplosiveAffix(enemy, time);
    if (enemy.modifier & EnemyModifier.SPLITTER) this.spawnSplitterDrones(enemy);

    // A1/A3: heavy hulls shed rigid-body debris that tumbles and bounces
    if (enemy.type === EnemyType.TANK || enemy.type === EnemyType.BOSS) {
      this.debris?.spawn(
        enemy.body.position.x,
        enemy.body.position.y,
        enemy.body.position.z,
        time,
        this.fxCount(enemy.type === EnemyType.BOSS ? 10 : 6),
        20,
        0x3a4238,
        0.9,
      );
    }
  }

  /**
   * Grant weapon XP for a kill. Weapon levels persist to meta-progression
   * (hangar mastery) and passively buff that weapon — but they no longer open
   * the upgrade roulette. Run-level XP (collected gems) drives the roulette.
   */
  private grantWeaponXp(weapon: WeaponType) {
    const xp = (this.weaponXp.get(weapon) ?? 0) + 1;
    this.weaponXp.set(weapon, xp);
    const before = this.weaponLevels.get(weapon) ?? 1;
    const after = weaponLevelForXp(xp, MAX_WEAPON_LEVEL);
    if (after > before) {
      this.weaponLevels.set(weapon, after);
      // Persist to meta-progression (hangar screen)
      writeMastery(weapon, after);
      const altFire = after === MAX_WEAPON_LEVEL;
      this.announce(
        altFire ? `WEAPON MAXED` : `WEAPON LV.${after}`,
        altFire
          ? "Signature alt-fire unlocked"
          : `+${Math.round((after - 1) * 18)}% DMG`,
        "#7ee0ff",
      );
      if (altFire) {
        // Rank 5 is the cap — reward instead of a roulette
        this.maxHealth += 10;
        this.repairPlayer(10);
      }
      this.audio.playUpgrade();
    }
  }

  /**
   * Grant run-level XP from a collected gem. Each level crossed queues an
   * upgrade roulette — a big gem can queue several, offered one after another
   * so the player never skips a pick (VS boss-gem behavior).
   */
  private grantRunXp(amount: number, time: number) {
    // C5 perk: xpGain boosts every gem's XP yield.
    this.runXp += amount * (1 + perkEffect("xpGain", this.perks.xpGain));
    const nextLevel = runLevelForXp(this.runXp, MAX_RUN_LEVEL);
    if (nextLevel > this.runLevel) {
      this.pendingLevelUps += nextLevel - this.runLevel;
      this.runLevel = nextLevel;
      this.audio.playUpgrade();
      this.offerNextLevelUp();
    }
  }

  /** Open a roulette for one queued level-up (if any). */
  private offerNextLevelUp() {
    if (this.pendingLevelUps <= 0 || this.upgradePaused) return;
    this.pendingLevelUps--;
    this.announce("LEVEL UP!", `LV.${this.runLevel} — choose an upgrade`, "#7ee0ff");
    this.offerUpgrade();
  }

  switchWeapon = (weaponType: WeaponType) => {
    if (this.currentWeapon === weaponType) return;
    this.currentWeapon = weaponType;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.updateUI(performance.now() / 1000);
  };

  startReload = () => {
    const weapon = this.weapons.get(this.currentWeapon);
    if (!weapon || weapon.ammo === weapon.maxAmmo || weapon.reloadTime === 0) return;
    this.isReloading = true;
    const level = this.weaponLevels.get(this.currentWeapon) ?? 1;
    const lvlBonus = weaponLevelBonus(level);
    const reloadUp = Math.max(0.4, 1 - this.runUpgrades.reload * 0.25);
    this.reloadTimer = weapon.reloadTime * lvlBonus.reloadMult * reloadUp;
    this.audio.playReload();
  };

  onContextMenu = (e: Event) => {
    e.preventDefault();
  };

  findSalvoTarget(centerPoint: THREE.Vector3, radius: number): Enemy | null {
    let closestEnemy: Enemy | null = null;
    let minDist = radius;
    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const dx = enemy.body.position.x - centerPoint.x;
      const dz = enemy.body.position.z - centerPoint.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < minDist) {
        minDist = dist;
        closestEnemy = enemy;
      }
    }
    return closestEnemy;
  }

  updateSalvoIndicators(enemy: Enemy) {
    let group = this.salvoLockIndicators.get(enemy);
    if (!group) {
      group = new THREE.Group();
      group.position.copy(enemy.mesh.position);
      this.scene.add(group);
      this.salvoLockIndicators.set(enemy, group);
    }

    // Clear old rings in group
    while (group.children.length > 0) {
      const child = group.children[0] as THREE.Mesh;
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
      group.remove(child);
    }

    const lockCount = this.salvoLocks.filter((e) => e === enemy).length;

    const mat = new THREE.MeshBasicMaterial({
      color: 0xff3344,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < lockCount; i++) {
      const r = 2.0 + i * 0.85;
      const geom = new THREE.RingGeometry(r, r + 0.15, 4); // Spinning diamond
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2;
      group.add(mesh);
    }
  }

  clearSalvoIndicators() {
    for (const group of this.salvoLockIndicators.values()) {
      group.children.forEach((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m: THREE.Material) => m.dispose());
          } else {
            mesh.material.dispose();
          }
        }
      });
      this.scene.remove(group);
    }
    this.salvoLockIndicators.clear();
  }

  startPaintingLocks() {
    if (!this.isPlaying || this.salvoCooldownTimer > 0) return;
    this.isPaintingLocks = true;
  }

  releaseSalvo() {
    if (!this.isPaintingLocks) return;
    this.isPaintingLocks = false;

    if (this.salvoLocks.length > 0) {
      const now = performance.now() / 1000;
      this.salvoLocks.forEach((enemy, index) => {
        const offsetAngle = (index / this.salvoLocks.length) * Math.PI * 2;
        const spawnX = this.helicopter.body.position.x + Math.sin(offsetAngle) * 4.5;
        const spawnZ = this.helicopter.body.position.z + Math.cos(offsetAngle) * 4.5;
        const spawnY = this.helicopter.body.position.y - 1;

        const dx = enemy.body.position.x - spawnX;
        const dz = enemy.body.position.z - spawnZ;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;

        // Spawn homing salvo missile
        this.playerProjectiles.spawn(
          spawnX,
          spawnY,
          spawnZ,
          dx / len,
          dz / len,
          now,
          265, // speed
          55,  // damage
          12,  // blastRadius
          0xff3344, // colorHex
          enemy, // target
          8.0 // homingStrength
        );
      });

      this.audio.playMissileLaunch();
      this.helicopter.triggerFirePitch(0.05); // salvo launch — tiny nose kick
      this.salvoCooldownTimer = this.getEffectiveSalvoCooldown();
      this.salvoLocks = [];
      this.clearSalvoIndicators();
      this.updateUI(now);
    }
  }

  dropPowerUp = (x: number, y: number, z: number) => {
    let type: PowerUpType;
    const rand = Math.random();
    
    const weapon = this.weapons.get(this.currentWeapon);
    const lowHealth = this.health < 40;
    const lowFuel = this.currentFuel < 35;
    const lowAmmo = weapon && (weapon.ammo / weapon.maxAmmo) < 0.25;
    
    if (lowHealth && Math.random() < 0.5) {
      type = PowerUpType.HEALTH;
    } else if (lowFuel && Math.random() < 0.5) {
      type = PowerUpType.FUEL;
    } else if (lowAmmo && Math.random() < 0.5) {
      type = PowerUpType.AMMO;
    } else {
      if (rand < 0.22) type = PowerUpType.HEALTH;
      else if (rand < 0.38) type = PowerUpType.FUEL;
      else if (rand < 0.52) type = PowerUpType.AMMO;
      else if (rand < 0.68) type = PowerUpType.DAMAGE_BOOST;
      else if (rand < 0.82) type = PowerUpType.SHIELD;
      else if (rand < 0.92) type = PowerUpType.SPEED_BOOST;
      else type = PowerUpType.BOMB;
    }

    const pu = new PowerUp(this.scene, x, y + 2, z, type);
    pu.spawnTime = performance.now() / 1000;
    this.powerups.push(pu);
  };

  /** Drop a small XP gem worth `value` run XP (VS-style upgrade currency). */
  dropXpGem = (x: number, y: number, z: number, value: number) => {
    const pu = new PowerUp(this.scene, x, y + 2, z, PowerUpType.XP_GEM);
    pu.value = value;
    pu.spawnTime = performance.now() / 1000;
    this.powerups.push(pu);
  };

  private dropLootPickup(x: number, y: number, z: number, type: PowerUpType, value = 1, scatter = 1.6) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * scatter;
    const spawnX = x + Math.cos(angle) * r;
    const spawnZ = z + Math.sin(angle) * r;
    const pickup = new PowerUp(this.scene, spawnX, y + 2, spawnZ, type);
    pickup.spawnTime = performance.now() / 1000;
    pickup.value = value;
    this.powerups.push(pickup);
  }

  private dropEnemyLoot(enemy: Enemy) {
    const tier = enemy.type === EnemyType.BOSS
      ? "BOSS" as const
      : enemy.isElite
        ? "ELITE" as const
        : enemy.variant !== EnemyVariant.STANDARD || enemy.type === EnemyType.TANK
          ? "SPECIAL" as const
          : "BASIC" as const;
    const plan = rollLoot(tier, Math.random(), Math.random());
    const { x, y, z } = enemy.body.position;
    if (plan.salvage > 0) this.dropLootPickup(x - 1.2, y, z, PowerUpType.SALVAGE, plan.salvage, 1.8);
    if (plan.salvageCache) this.dropLootPickup(x, y, z, PowerUpType.SALVAGE_CACHE, 8, 1.2);
    if (plan.powerup !== null) this.dropLootPickup(x + 1.2, y, z, plan.powerup, 1, 1.8);
    if (plan.countermeasure) this.dropLootPickup(x, y, z + 1.5, PowerUpType.COUNTERMEASURE, 1, 1.8);
  }

  applyPowerUp = (type: PowerUpType, time: number) => {
    switch (type) {
      case PowerUpType.HEALTH:
        // Field Repair: restores 35 Hull
        this.repairPlayer(35);
        this.audio.playPowerUpSting('FIELD_REPAIR');
        this.announce('🔧 FIELD REPAIR', '+35 HULL RESTORED', '#22ff44');
        break;
      case PowerUpType.AMMO:
        // Ammo Pack: restocks all weapon systems
        for (const [, config] of this.weapons.entries()) {
          config.ammo = config.maxAmmo;
        }
        this.audio.playPowerUpSting('AMMO_PACK');
        this.announce('📦 AMMO PACK', 'ORDNANCE RESTOCKED', '#ffdd22');
        break;
      case PowerUpType.DAMAGE_BOOST:
        // Overdrive: 8 seconds of doubled firepower
        for (const [wType, config] of this.weapons.entries()) {
          config.damage = WEAPON_CONFIGS[wType].damage * 2;
        }
        this.damageBoostTimer = 8.0;
        this.audio.playPowerUpSting('OVERDRIVE');
        this.announce('⚡ OVERDRIVE', '8 SEC FIREPOWER SURGE', '#ff3344');
        break;
      case PowerUpType.MAGNET_SURGE:
        // Magnet Surge: 8 seconds of wide-radius item suction
        this.magnetSurgeTimer = 8.0;
        this.audio.playPowerUpSting('MAGNET_SURGE');
        this.announce('🧲 MAGNET SURGE', '8 SEC XP VACUUM', '#00e5ff');
        break;
      case PowerUpType.EMP_PULSE: {
        // EMP Pulse: 4s disruption of all nearby enemies + cancel incoming missile locks
        const px = this.helicopter.body.position.x;
        const py = this.helicopter.body.position.y;
        const pz = this.helicopter.body.position.z;
        for (const e of this.enemies) {
          if (!e.active) continue;
          const dx = e.body.position.x - px;
          const dz = e.body.position.z - pz;
          if (dx * dx + dz * dz <= 4225) { // 65m
            e.applyStatus("emp", time);
          }
        }
        for (const proj of this.enemyProjectiles.pool) {
          if (proj.active && proj.homingStrength > 0) {
            proj.targetType = "DECOY";
          }
        }
        this.particles.spawnExplosion(px, py, pz, 75, time, 30);
        this.particles.spawnElectricalArc(px, py, pz, time, 18, 24);
        this.audio.playPowerUpSting('EMP_PULSE');
        this.announce('⚡ EMP PULSE', 'SURROUNDING THREATS DISABLED', '#aa44ff');
        break;
      }
      case PowerUpType.SALVAGE_CACHE: {
        this.addSalvage(8);
        this.score += 250;
        this.audio.playPowerUpSting('SALVAGE_CACHE');
        this.floatingCombatText.spawnReward(this.helicopter.body.position, '+8 CACHE SALVAGE', 'SALVAGE', '#ffd700', 8, time);
        this.announce('🏆 SALVAGE CACHE', '+8 HIGH-VALUE SALVAGE', '#ffd700');
        break;
      }
      case PowerUpType.SHIELD:
        this.shieldTimer = 8.0;
        this.audio.playPickup();
        break;
      case PowerUpType.SPEED_BOOST:
        this.speedBoostTimer = 6.0;
        this.audio.playPickup();
        break;
      case PowerUpType.FUEL:
        this.currentFuel = Math.min(this.maxFuel, this.currentFuel + 35);
        this.audio.playPickup();
        break;
      case PowerUpType.BOMB:
        // Every damage source uses the same idempotent enemy-death pipeline.
        let bombKills = 0;
        for (const e of this.enemies) {
          if (!e.active) continue;
          bombKills++;
          this.onEnemyDestroyed(e, time, "BOMB");
        }
        // One combined streak announcement + hit-stop for the whole nuke
        if (bombKills > 0) {
          const tier = multikillTier(this.killStreakCount);
          if (tier) {
            this.announce(tier.label, "", tier.color);
            this.audio.playKillCombo(Math.min(this.killStreakCount, 5));
            if (this.killStreakCount >= 3) this.triggerHitStop(0.25, 0.2);
          }
        }
        this.score += 150;
        // Mega payoff at the player: big blast + shockwave so the bomb always reads
        const bx = this.helicopter.body.position.x;
        const by = this.helicopter.body.position.y;
        const bz = this.helicopter.body.position.z;
        this.particles.spawnExplosion(bx, by, bz, 160, time, 60);
        this.volumetricExplosions.spawn(bx, by, bz, 26, 10);
        this.shockwaves?.spawn(bx, 0.5, bz, time, 90, 0xffaa44, 1.0);
        this.addExplosionImpulse(bx, by, bz, 2.0, 110);
        this.audio.playExplosion(2.0);
        this.addCameraImpulse(4.5); // BOMB payoff at the player
        this.announce(
          '💥 BOMB AWAY!',
          bombKills > 0 ? `Wiped out ${bombKills} enemies` : '+150 PTS — no enemies in range',
          '#ff8800',
        );
        break;
      case PowerUpType.SALVAGE:
      case PowerUpType.COUNTERMEASURE:
      case PowerUpType.XP_GEM:
        break;
    }
    this.updateUI(time);
  };

  /** 0..1 progress toward the next run level (for the HUD XP bar). */
  runXpProgress(): number {
    if (this.runLevel >= MAX_RUN_LEVEL) return 1;
    const current = runXpForLevel(this.runLevel);
    const next = runXpForLevel(this.runLevel + 1);
    return Math.min(1, Math.max(0, (this.runXp - current) / (next - current)));
  }

  updateUI(time: number) {
    this.emitStatsIfChanged();
    if (this.isPlaying && time - this.lastUiUpdateTime < 1 / 12) return;
    this.lastUiUpdateTime = time;

    const weapon = this.weapons.get(this.currentWeapon);
    const boss =
      this.enemies.find((e) => e.active && e.type === EnemyType.BOSS) ?? null;

    // Flush pending arcade announcements (kill streaks, objectives, phases)
    if (this.announceQueue.length > 0) {
      const next = this.announceQueue.shift()!;
      window.dispatchEvent(
        new CustomEvent("helistrike:announce", { detail: next }),
      );
    }

    const risk = riskMultiplier(this.health, this.maxHealth, this.difficulty.maxRisk);
    const objectives = {
      sam: this.objectives.some((o) => o.active && o.type === ObjectiveType.SAM_SITE),
      radar: this.objectives.some((o) => o.active && o.type === ObjectiveType.RADAR_TOWER),
      depot: this.objectives.some((o) => o.active && o.type === ObjectiveType.AMMO_DEPOT),
      count: this.objectives.filter((o) => o.active).length,
    };
    const delivery = this.delivery.getHudSnapshot(this.helicopter.body.position, time);

    // Ready-cue transitions: a soft blip when salvo / flares / Devastation
    // finish their cooldowns (tracked at the ~12 Hz HUD cadence).
    const salvoReady = this.salvoCooldownTimer <= 0 && this.isPlaying;
    const countermeasuresReady =
      this.countermeasures.charges > 0 && this.countermeasures.cooldownRemaining <= 0;
    const superReady =
      this.superCharge >= SUPER_MAX_CHARGE && time >= this.superCooldownUntil && this.superActiveUntil <= time;
    if (this.isPlaying) {
      if (salvoReady && !this.prevSalvoReady) this.audio.playReady();
      if (countermeasuresReady && !this.prevCountermeasuresReady) this.audio.playReady();
      if (superReady && !this.prevSuperReady) this.audio.playReady();
    }
    this.prevSalvoReady = salvoReady;
    this.prevCountermeasuresReady = countermeasuresReady;
    this.prevSuperReady = superReady;

    window.dispatchEvent(
      new CustomEvent("helistrike:update", {
        detail: {
          score: this.score,
          health: this.health,
          maxHealth: this.maxHealth,
          fuel: this.currentFuel,
          rotorHealth: this.helicopter.rotorHealth,
          engineHealth: this.helicopter.engineHealth,
          wave: this.currentWave,
          elapsed: this.survivalTime,
          message: (this.waveTransitionTimer > 0 && this.openingPhase !== "countdown" && Boolean(this.waveMessage)) ? this.waveMessage : null,
          playing: this.isPlaying,
          runLevel: this.runLevel,
          runXpProgress: this.runXpProgress(),
          weapon: weapon ? {
            name: weapon.name,
            ammo: weapon.ammo,
            maxAmmo: weapon.maxAmmo,
            type: this.currentWeapon,
            reloading: this.isReloading,
            reloadTimer: this.reloadTimer,
            level: this.weaponLevels.get(this.currentWeapon) ?? 1,
          } : null,
          combo: {
            count: this.comboCount,
            multiplier: this.comboMultiplier,
            timer: this.comboTimer,
          },
          salvo: {
            locks: this.salvoLocks.length,
            cooldown: Math.ceil(this.salvoCooldownTimer),
            isPainting: this.isPaintingLocks,
            ready: salvoReady,
          },
          status: {
            damageBoost: this.damageBoostTimer,
            shield: this.shieldTimer,
            speedBoost: this.speedBoostTimer,
            magnetSurge: this.magnetSurgeTimer,
            threat: this.combatIntensity,
            afterburner: this.afterburnerActive,
            risk: risk > 1 ? risk : null,
          },
          boss: boss ? { hp: Math.max(0, boss.hp), maxHp: boss.maxHp, phase: boss.phase } : null,
          objectives,
          samThreat: this.getSamThreat(),
          countermeasures: {
            charges: this.countermeasures.charges,
            maxCharges: this.countermeasures.maxCharges,
            cooldown: this.countermeasures.cooldownRemaining,
            ready: countermeasuresReady,
          },
          threatSystem: {
            points: this.threatPoints,
            level: this.threatLevel,
            name: THREAT_NAMES[this.threatLevel - 1],
            rewardMultiplier: threatRewardMultiplier(this.threatLevel),
          },
          super: {
            charge: this.superCharge,
            ready: superReady,
            activeRemaining: Math.max(0, this.superActiveUntil - time),
            cooldownRemaining: Math.max(0, this.superCooldownUntil - time),
          },
          unsecuredCredits: this.unsecuredCredits,
          mission: this.missionManager.getHudSnapshot(),
          radarLinked: this.radarActive && this.samActive,
          salvage: this.runSalvage,
          salvageCredits: salvageCreditsFor(this.runSalvage),
          extraction: this.extractionPosition ? {
            distance: Math.round(Math.hypot(this.extractionPosition.x - this.helicopter.body.position.x, this.extractionPosition.z - this.helicopter.body.position.z)),
            bearing: Math.atan2(this.extractionPosition.x - this.helicopter.body.position.x, -(this.extractionPosition.z - this.helicopter.body.position.z)) * 180 / Math.PI,
            progress: this.extractionProgress,
            active: this.extractionPressure,
            carrying: this.delivery.isCarrying(),
          } : null,
          delivery,
          credits: this.delivery.credits,
          missileThreats: this.getMissileThreats(),
          isOverdrive: this.isOverdrive,
          overdriveMultiplier: this.overdriveMultiplier,
          canFlare: this.countermeasures.canDeploy(),
        },
      }),
    );
    this.emitMinimap(time);
  }

  /**
   * Tactical radar snapshot for the minimap HUD. Piggybacks on updateUI's
   * ~12 Hz cadence and carries only positions — never entity objects. Regular
   * enemies are filtered to the radar radius; the boss stays visible anywhere.
   */
  private emitMinimap(time: number) {
    if (!this.isPlaying) return;
    const range = 430;
    const rangeSq = range * range;
    const playerPos = this.helicopter.body.position;

    const enemies: MinimapSnapshot["enemies"] = [];
    for (const e of this.enemies) {
      if (!e.active) continue;
      const isBoss = e.type === EnemyType.BOSS;
      const dx = e.body.position.x - playerPos.x;
      const dz = e.body.position.z - playerPos.z;
      if (!isBoss && dx * dx + dz * dz > rangeSq) continue;
      enemies.push({
        x: e.body.position.x,
        z: e.body.position.z,
        type: e.type,
        variant: e.variant,
        elite: e.isElite,
        boss: isBoss,
        priority: Boolean(e.isPriorityTarget),
      });
    }

    const contract = this.delivery.activeContract;
    let delivery: MinimapSnapshot["delivery"] = null;
    if (contract && contract.state !== DeliveryState.FAILED) {
      delivery = {
        origin: { x: contract.originPosition.x, z: contract.originPosition.z },
        destination: { x: contract.destinationPosition.x, z: contract.destinationPosition.z },
        carrying:
          contract.state === DeliveryState.CARRYING ||
          contract.state === DeliveryState.DELIVERING,
        state: contract.state,
      };
    }

    const objectives: MinimapSnapshot["objectives"] = [];
    for (const o of this.objectives) {
      if (!o.active) continue;
      objectives.push({
        type: o.type,
        x: o.position.x,
        z: o.position.z,
        samState: o.samState ?? undefined,
        detectionRange: o.type === ObjectiveType.SAM_SITE ? SAM_DETECTION_RANGE : undefined,
      });
    }

    const threats: MinimapSnapshot["threats"] = [];
    for (const projectile of this.enemyProjectiles.pool) {
      if (!projectile.active || projectile.homingStrength <= 0) continue;
      threats.push({ x: projectile.pos.x, z: projectile.pos.z, kind: "HOMING_MISSILE", target: projectile.targetType });
    }

    const activeMission = this.missionManager.activeMission;
    let mission: MinimapSnapshot["mission"] = null;
    if (activeMission) {
      let target = activeMission.destination ?? activeMission.origin;
      if (activeMission.targetKind === "ELITE" && activeMission.targetId) {
        const elite = this.enemies.find((enemy) => enemy.active && enemy.missionTargetId === activeMission.targetId);
        if (elite) target = { x: elite.body.position.x, y: elite.body.position.y, z: elite.body.position.z };
      }
      if (activeMission.type === MissionType.ESCORT) {
        // C2: pin the escort marker to the moving convoy, not the route end.
        target = convoyPositionAt(activeMission, time);
      }
      if (target) mission = { x: target.x, z: target.z, type: activeMission.type, targetKind: activeMission.targetKind };
    }

    window.dispatchEvent(
      new CustomEvent("helistrike:minimap", {
        detail: {
          player: {
            x: playerPos.x,
            y: playerPos.y,
            z: playerPos.z,
            heading: this.helicopter.mesh.rotation.y,
            cameraYaw: this.cameraYaw,
          },
          enemies,
          delivery,
          objectives,
          threats,
          extraction: this.extractionPosition
            ? {
                x: this.extractionPosition.x,
                z: this.extractionPosition.z,
                active: this.extractionPressure,
                radius: GameEngine.EXTRACTION_ZONE_RADIUS,
                elevation: this.extractionPosition.y,
              }
            : null,
          mission,
          range,
        } as MinimapSnapshot,
      }),
    );
  }

  emitStatsIfChanged(force = false) {
    const nextHealth = Math.round(THREE.MathUtils.clamp(this.health, 0, this.maxHealth));
    const nextFuel = Math.round(THREE.MathUtils.clamp(this.currentFuel, 0, this.maxFuel));

    if (
      !force &&
      nextHealth === this.lastStatsHealth &&
      nextFuel === this.lastStatsFuel
    ) {
      return;
    }

    this.lastStatsHealth = nextHealth;
    this.lastStatsFuel = nextFuel;
    window.dispatchEvent(
      new CustomEvent("helistrike:stats", {
        detail: {
          currentHealth: nextHealth,
          maxHealth: this.maxHealth,
          currentFuel: nextFuel,
          maxFuel: this.maxFuel,
        },
      }),
    );
  }

  dispatchGameOver(time: number, status: "DESTROYED" | "EXTRACTED" = "DESTROYED", securedThreatBonus = 0, extractedSalvage = 0) {
    if (this.gameOverDispatched) return;
    this.gameOverDispatched = true;
    // C7: every finished run lands in the persisted run history.
    recordRun({
      score: this.score,
      wave: this.currentWave,
      kills: this.totalKills,
      accuracy: accuracyFor(this.shotsHit, this.shotsFired),
      survivalTime: this.survivalTime,
      victory: status === "EXTRACTED",
      at: Date.now(),
    });
    const lostUnsecured = status === "DESTROYED" ? this.unsecuredCredits : 0;
    const lostSalvage = status === "DESTROYED" ? this.runSalvage : 0;
    // Final-pass progression: combat pay + one-time first achievements so a
    // sincere early run never ends with zero credits. Achievements pay once
    // per profile, so restarting can't farm them.
    const progress = readProgress();
    const newlyEarned: { label: string; credits: number }[] = [];
    const earnOnce = (id: string, condition: boolean) => {
      if (!condition || progress.achievements.includes(id)) return;
      const info = FIRST_TIME_ACHIEVEMENTS.find((a) => a.id === id);
      if (!info) return;
      progress.achievements.push(id);
      newlyEarned.push({ label: info.label, credits: info.credits });
    };
    earnOnce("firstKill", this.totalKills > 0);
    earnOnce("firstWaveClear", this.currentWave > 1);
    earnOnce("firstDelivery", this.deliveriesCompleted > 0);
    earnOnce("firstSam", this.samSitesDestroyed > 0);
    earnOnce("firstExtraction", status === "EXTRACTED");
    writeProgress(progress);
    const combatPay = computeCombatPay({
      kills: this.totalKills,
      wave: this.currentWave,
      objectives: this.samSitesDestroyed + this.radarSitesDestroyed,
      survivalTime: this.survivalTime,
    });
    const achievementCredits = newlyEarned.reduce((sum, a) => sum + a.credits, 0);
    if (combatPay + achievementCredits > 0) this.delivery.awardCredits(combatPay + achievementCredits);
    if (status === "DESTROYED") {
      this.delivery.fail("PLAYER DOWN");
      this.unsecuredCredits = 0;
      this.runSalvage = 0;
      this.spawnPlayerExplosion();
    }
    this.clearExtraction();
    this.isPlaying = false;
    this.audio.stopMusic();
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.movementKeys.clear();
    window.dispatchEvent(
      new CustomEvent("helistrike:gameover", {
        detail: {
          score: this.score,
          wave: this.currentWave,
          time,
          kills: this.totalKills,
          maxCombo: this.maxCombo,
          survivalTime: this.survivalTime,
          accuracy: accuracyFor(this.shotsHit, this.shotsFired),
          status,
          threatLevel: this.threatLevel,
          deliveries: this.deliveriesCompleted,
          samSitesDestroyed: this.samSitesDestroyed,
          radarSitesDestroyed: this.radarSitesDestroyed,
          bossesDestroyed: this.bossesDestroyed,
          missionsCompleted: this.missionsCompleted,
          missionBonusesCompleted: this.missionBonusesCompleted,
          salvage: status === "EXTRACTED" ? extractedSalvage : lostSalvage,
          lostUnsecured,
          securedThreatBonus,
          credits: this.delivery.credits,
          combatPay,
          achievementCredits,
          achievementLabels: newlyEarned.map((a) => a.label),
          causeOfDeath: status === "DESTROYED" ? (this.lastDamageSource || "UNKNOWN") : "",
        },
      }),
    );
    this.updateUI(time);
  }

  /** Player destruction — big layered explosion at the wreck: fireball
   *  particles, debris chunks, smoke, sparks, volumetric fire, camera impulse
   *  and the big boom sound. The helicopter mesh is hidden so the wreck doesn't
   *  linger, and `Helicopter.reset()` restores visibility on restart. */
  private spawnPlayerExplosion() {
    const p = this.helicopter.body.position;
    const now = performance.now() / 1000;
    this.particles.spawnExplosion(p.x, p.y, p.z, 220, now, 46);
    this.particles.spawnDebris(p.x, p.y, p.z, now, 26, 34);
    this.particles.spawnSmoke(p.x, p.y + 2, p.z, now);
    this.particles.spawnSparks(p.x, p.y, p.z, now, 10, 26);
    this.volumetricExplosions.spawn(p.x, p.y, p.z, 36, 22);
    this.city.damageNearby(p.x, p.z, 30, 120);
    this.addCameraImpulse(6.0);
    if (this.audio) this.audio.playBigExplosion(1.6);
    this.helicopter.mesh.visible = false;
  }

  startNextWave() {
    if (this.currentWave > 0) {
      this.announce("WAVE COMPLETE", `Wave ${this.currentWave + 1} incoming`, "#7ee0ff");
      this.audio.playWaveComplete();
    }
    this.currentWave++;
    // C3: seeded night-op roll per wave — the palette eases in and back out.
    const night = nightOpForWave(this.currentWave, this.nightSeed);
    if (night !== this.nightOpsActive) {
      this.nightOpsActive = night;
      this.nightBlendTarget = night ? 1 : 0;
      if (night) this.announce("NIGHT OPS", "Low visibility — lights on", "#8fb7ff");
    }
    this.totalEnemiesInWave = waveEnemyCount(this.currentWave);
    this.enemiesSpawnedInWave = 0;
    this.spawnTimer = 1.2;
    this.minibossSpawnedThisWave = false;
    this.waveThreatBudgetRemaining = Math.round(waveThreatBudget(this.currentWave, this.threatLevel) * this.difficulty.threatBudget);
    this.pendingVariantQueue.length = 0;

    // Roll this wave's procedural theme ("hand"). Milestone waves (boss +
    // miniboss on every 5th) stay null so those battles read distinct; wave 3
    // deliberately opens the first storm.
    if (this.currentWave % 5 === 0) {
      this.currentWaveTheme = null;
    } else if (this.currentWave === 3) {
      this.currentWaveTheme = WAVE_THEMES["STORM"];
    } else {
      this.currentWaveTheme = waveThemeFor(this.currentWave);
    }
    const theme = this.currentWaveTheme;
    // Refresh the color-grade target; the per-frame pass eases toward it.
    this.updateThemeGrading(0);

    // Determine wave banner — milestones keep their iconic lines, the rest use
    // the rolled theme so roguelite variety shows up on the screen.
    if (this.currentWave === 1) {
      this.waveMessage = "WAVE 1\nLIGHT AIR PATROL";
    } else if (this.currentWave === 2) {
      this.waveMessage = "WAVE 2\nAIR ASSAULT & INFANTRY";
    } else if (this.currentWave === 3) {
      this.waveMessage = "WAVE 3\nAIR STRIKE & ARMORED FLANK";
    } else if (this.currentWave === 4) {
      this.waveMessage = "WAVE 4\nHEAVY AIR SQUADRON & TANKS";
    } else if (this.currentWave === 5) {
      this.waveMessage = "WAVE 5\nAIR-HEAVY RADAR ASSAULT";
    } else if (this.currentWave === 6) {
      this.waveMessage = "WAVE 6\nCOMBAT GUNSHIPS & REINFORCEMENTS";
      if (!this.airThreatAnnouncedThisRun) {
        this.airThreatAnnouncedThisRun = true;
        this.announce("TACTICAL AIR SQUADRON", "Heavy combat gunships inbound", "#ff3344");
      }
    } else if (this.currentWave === 7) {
      this.waveMessage = "WAVE 7\nCOMBINED AIR & ARMORED OFFENSIVE";
    } else if (this.currentWave === 8) {
      this.waveMessage = "WAVE 8\nTACTICAL AIR & SAM BATTERY";
    } else if (this.currentWave === 9) {
      this.waveMessage = "WAVE 9\nMAXIMUM AIR COMBAT PRESSURE";
    } else if (this.currentWave === 10) {
      this.waveMessage = "WAVE 10\n⚠ HEAVY GUNSHIP BOSS INBOUND ⚠";
      this.startBossBattle(performance.now() / 1000);
    } else if (this.currentWave % 10 === 0) {
      this.waveMessage = `WAVE ${this.currentWave}\n⚠ HEAVY GUNSHIP BOSS INBOUND ⚠`;
      this.startBossBattle(performance.now() / 1000);
    } else if (this.currentWave % 5 === 0) {
      this.waveMessage = `WAVE ${this.currentWave}\nAIR-HEAVY RADAR ASSAULT`;
    } else {
      this.waveMessage = waveThemeBanner(theme, this.currentWave);
    }
    this.audio.playWaveStart();

    // Theme reshapes the horde head-count for this wave.
    if (theme) this.totalEnemiesInWave = Math.round(this.totalEnemiesInWave * theme.enemyCountMult);

    // Destroyable objectives: spawn on the battlefield based on wave progression
    if (this.currentWave >= 5) {
      const activeRadars = this.objectives.filter((o) => o.active && o.type === ObjectiveType.RADAR_TOWER).length;
      if (activeRadars === 0) {
        this.spawnObjective(ObjectiveType.RADAR_TOWER);
      }
    }
    if (this.currentWave >= 8) {
      const activeSams = this.objectives.filter((o) => o.active && o.type === ObjectiveType.SAM_SITE).length;
      if (activeSams === 0) {
        this.spawnObjective(ObjectiveType.SAM_SITE);
      }
    }

    // Dynamic Weather based on wave + the wave's storm theme bonus.
    if (this.currentWave >= 3) {
      this.weather.targetIntensity = Math.min(
        1.0,
        (this.currentWave - 2) * 0.25 + (theme?.stormBonus ?? 0),
      );
      this.rain.mesh.visible = true;
    }

    // Time-driven waves never "clear", so the milestone reward is a modest
    // heal rather than a full wave-clear top-up.
    const healing = 10 + this.currentWave; // More healing on higher waves
    this.repairPlayer(healing);

    this.waveTransitionTimer = 2.0; // Brief breather before the next horde surge
    this.updateUI(performance.now() / 1000);
  }

  /**
   * Ambient rooftop turrets: track the player, fire tracer shots,
   * and die with their host building.
   */
  /** Billowing smoke + embers linger at the impact site after a hard crash. */
  private updateCrashSmoke(delta: number, time: number) {
    if (this.crashSmokeTimer > 0 && this.crashSmokePos) {
      this.crashSmokeTimer -= delta;
      const p = this.crashSmokePos;
      if (Math.random() < 0.85) {
        this.particles.spawnSmoke(
          p.x + (Math.random() - 0.5) * 2.5,
          p.y + Math.random() * 3,
          p.z + (Math.random() - 0.5) * 2.5,
          time,
        );
      }
      if (Math.random() < 0.3) {
        this.particles.spawnSparks(
          p.x + (Math.random() - 0.5) * 2,
          p.y + Math.random() * 2,
          p.z + (Math.random() - 0.5) * 2,
          time,
        );
      }
    } else {
      this.crashSmokePos = null;
    }
  }

  private updateTurrets(time: number, delta: number) {
    const px = this.helicopter.body.position.x;
    const pz = this.helicopter.body.position.z;
    const py = this.helicopter.body.position.y;
    const silenced = this.enemyFireSilenced();
    const shotSpeed = 185 * this.difficulty.enemyProjectileSpeed;

    for (const t of this.city.turrets) {
      t.updateHitFlash(delta);
      // Host building destroyed (or turret destroyed) → hide the ghost mesh
      if (t.isGone()) {
        t.mesh.visible = false;
        continue;
      }
      const dx = t.position.x - px;
      const dz = t.position.z - pz;
      const distSq = dx * dx + dz * dz;
      // Hide far-away turrets (they cull with their chunk anyway)
      if (distSq > 300 * 300) {
        t.mesh.visible = false;
        continue;
      }
      t.mesh.visible = true;
      if (distSq > t.range * t.range) continue;

      // Opening protection / wave-1 quiet window: pin the shot clock so every
      // interval gate stays closed until the player is fair game.
      if (silenced) {
        t.lastShotTime = time;
        continue;
      }

      // First frame this turret is in range: arm its fire timer (no instant fire)
      if (t.lastShotTime === Number.POSITIVE_INFINITY) {
        t.lastShotTime = time;
        continue;
      }
      t.aimAt(px, py, pz, time);
      const altDiff = Math.abs(py - t.position.y);
      if (altDiff > 42 || time - t.lastShotTime < t.fireInterval * this.difficulty.enemyFireInterval) continue;

      t.lastShotTime = time;
      const m = t.getMuzzle();
      // Lead the player using their REAL velocity over the round's flight time
      // (~0.3s) — the old constant 28 u/s scroll assumption mis-led every shot.
      const LEAD_T = 0.3;
      const hv = this.helicopter.body.velocity;
      const ax = px + hv.x * LEAD_T - m.x;
      const ay = py + hv.y * LEAD_T - m.y;
      const az = pz + hv.z * LEAD_T - m.z;
      const len3 = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      const dirY = (ay / len3) * shotSpeed; // vertical velocity component
      const hlen = Math.hypot(ax, az) || 1;
      const spreadX = (Math.random() - 0.5) * 0.09;
      const spreadZ = (Math.random() - 0.5) * 0.09;
      this.enemyProjectiles.spawn(
        m.x,
        m.y,
        m.z,
        ax / hlen + spreadX,
        az / hlen + spreadZ,
        time,
        shotSpeed,
        6,
        0,
        0xffaa44,
        null,
        0,
        dirY,
        0,
        waveEnemyDamage(this.currentWave),
      );
      this.particles.spawnSparks(m.x, m.y, m.z, time);
      if (time - this.lastEnemyFireSoundTime >= 0.15) {
        this.audio.playEnemyFire();
        this.lastEnemyFireSoundTime = time;
      }
    }
  }

  private launchSamMissile(sam: Objective, time: number) {
    const isBossActive = this.enemies.some((e) => e.active && e.type === EnemyType.BOSS);
    const canLaunch = this.combatDirector.requestHeavyAttackSlot(
      sam.id,
      "SAM",
      time,
      this.currentWave,
      isBossActive,
      3.0,
    );
    if (!canLaunch) return;

    const launch = sam.getSamLaunchPosition();
    const player = this.helicopter.body.position;
    const dx = player.x - launch.x;
    const dz = player.z - launch.z;
    const horizontal = Math.max(0.001, Math.hypot(dx, dz));
    const speed = 112 * this.difficulty.enemyProjectileSpeed;
    const projectile = this.enemyProjectiles.spawn(
      launch.x, launch.y, launch.z,
      dx / horizontal, dz / horizontal,
      time, speed, 15, 8, 0xff4938,
      { body: this.helicopter.body, active: true },
      SAM_MISSILE_TURN_RATE * this.difficulty.homingStrength,
      ((player.y - launch.y) / horizontal) * speed,
      0,
      waveEnemyDamage(this.currentWave),
    );
    if (!projectile) {
      this.combatDirector.releaseHeavyAttackSlot(sam.id, time, 1.0);
      return;
    }
    projectile.configureSamMissile(sam);
    this.combatDirector.releaseHeavyAttackSlot(sam.id, time, 4.0);
    this.particles.spawnSmoke(launch.x, launch.y, launch.z, time);
    this.particles.spawnSparks(launch.x, launch.y, launch.z, time);
    this.audio.playSamMissileLaunch();
  }

  private getSamThreat() {
    const player = this.helicopter.body.position;
    const camFwd = GameEngine._scratchCamFwd;
    this.camera.getWorldDirection(camFwd);
    camFwd.y = 0;
    if (camFwd.lengthSq() < 0.0001) camFwd.set(0, 0, -1);
    else camFwd.normalize();

    const camRight = GameEngine._scratchCamRight;
    camRight.crossVectors(camFwd, this.worldUp).normalize();

    let nearestMissile: Projectile | null = null;
    let missileDistance = Infinity;
    for (const projectile of this.enemyProjectiles.pool) {
      if (
        !projectile.active ||
        projectile.homingStrength <= 0 ||
        projectile.target?.body !== this.helicopter.body
      ) continue;
      const distance = Math.hypot(projectile.pos.x - player.x, projectile.pos.z - player.z);
      if (distance < missileDistance) {
        missileDistance = distance;
        nearestMissile = projectile;
      }
    }
    if (nearestMissile) {
      const dx = nearestMissile.pos.x - player.x;
      const dz = nearestMissile.pos.z - player.z;
      const screenRelX = camRight.x * dx + camRight.z * dz;
      const screenRelY = camFwd.x * dx + camFwd.z * dz;
      return {
        state: "INBOUND" as const,
        progress: 1,
        distance: Math.round(missileDistance),
        bearing: Math.atan2(screenRelX, screenRelY) * 180 / Math.PI,
      };
    }
    let best: Objective | null = null;
    for (const objective of this.objectives) {
      if (!objective.active || objective.type !== ObjectiveType.SAM_SITE) continue;
      if (objective.samState !== SamState.LOCKING && objective.samState !== SamState.TRACKING) continue;
      if (!best || objective.samLockProgress > best.samLockProgress) best = objective;
    }
    if (!best) return null;
    const samDx = best.position.x - player.x;
    const samDz = best.position.z - player.z;
    const samScreenRelX = camRight.x * samDx + camRight.z * samDz;
    const samScreenRelY = camFwd.x * samDx + camFwd.z * samDz;
    return {
      state: best.samState === SamState.LOCKING ? "LOCKING" as const : "TRACKING" as const,
      progress: best.samLockProgress,
      distance: Math.round(best.distanceTo(player.x, player.z)),
      bearing: Math.atan2(samScreenRelX, samScreenRelY) * 180 / Math.PI,
    };
  }

  /**
   * Screen-edge missile threat indicators (TTI, bearing, danger level).
   * Supports up to 3 nearest homing missiles targeting the helicopter.
   */
  getMissileThreats(): Array<{
    id: number;
    distance: number;
    bearing: number;
    tti: number;
    danger: "YELLOW" | "ORANGE" | "RED";
    isDecoyed: boolean;
  }> {
    const player = this.helicopter.body.position;
    const threats: Array<{
      id: number;
      distance: number;
      bearing: number;
      tti: number;
      danger: "YELLOW" | "ORANGE" | "RED";
      isDecoyed: boolean;
    }> = [];

    const camFwd = GameEngine._scratchCamFwd;
    this.camera.getWorldDirection(camFwd);
    camFwd.y = 0;
    if (camFwd.lengthSq() < 0.0001) camFwd.set(0, 0, -1);
    else camFwd.normalize();

    const camRight = GameEngine._scratchCamRight;
    camRight.crossVectors(camFwd, this.worldUp).normalize();

    for (const proj of this.enemyProjectiles.pool) {
      if (!proj.active || proj.homingStrength <= 0) continue;
      const isTargetingPlayer = proj.target?.body === this.helicopter.body;
      const isDecoyed = proj.targetType === "DECOY";
      if (!isTargetingPlayer && !isDecoyed) continue;

      const dx = proj.pos.x - player.x;
      const dz = proj.pos.z - player.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.001 || distance > 280) continue;

      const toPlayerX = -dx / distance;
      const toPlayerZ = -dz / distance;
      // Closing velocity along line of sight toward player
      const closingVel = proj.vel ? (proj.vel.x * toPlayerX + proj.vel.z * toPlayerZ) : 95;

      let danger: "YELLOW" | "ORANGE" | "RED";
      let tti: number;

      // If missile is moving away or decoyed: downgrade immediately
      if (isDecoyed || closingVel <= 2) {
        danger = "YELLOW";
        tti = Math.max(9.9, distance / Math.max(10, Math.abs(closingVel)));
      } else {
        tti = distance / Math.max(15, closingVel);
        danger = tti < 1.4 ? "RED" : (tti < 2.8 ? "ORANGE" : "YELLOW");
      }

      const screenRelX = camRight.x * dx + camRight.z * dz;
      const screenRelY = camFwd.x * dx + camFwd.z * dz;
      const bearing = Math.atan2(screenRelX, screenRelY) * 180 / Math.PI;

      threats.push({
        id: proj.index,
        distance: Math.round(distance),
        bearing,
        tti: +tti.toFixed(1),
        danger,
        isDecoyed,
      });
    }

    threats.sort((a, b) => a.tti - b.tti);
    return threats.slice(0, 3);
  }

  /** Spawn a spaced rooftop or ground emplacement ahead of the player. */
  private spawnObjective(forcedType?: ObjectiveType, nearX?: number, nearZ?: number): Objective | null {
    const player = this.helicopter.body.position;
    const lanes = [-120, -78, -48, -24, 0, 24, 48, 78, 120];
    const samCap = this.currentWave >= 14 ? 2 : 1;
    const radarCap = 1;
    const activeSams = this.objectives.filter((o) => o.active && o.type === ObjectiveType.SAM_SITE).length;
    const activeRadars = this.objectives.filter((o) => o.active && o.type === ObjectiveType.RADAR_TOWER).length;

    // SAM sites should NEVER spawn before Wave 8 (occasional high-priority threat).
    // Radar towers appear in Wave 5 (or when forced by mission).
    let type = forcedType;
    if (!type) {
      if (this.currentWave >= 5 && activeRadars === 0 && Math.random() < 0.6) {
        type = ObjectiveType.RADAR_TOWER;
      } else if (this.currentWave >= 8 && activeSams < samCap && Math.random() < 0.4) {
        type = ObjectiveType.SAM_SITE;
      } else {
        return null;
      }
    }
    if (type === ObjectiveType.SAM_SITE && (this.currentWave < 8 || activeSams >= samCap)) {
      return null;
    }
    if (type === ObjectiveType.RADAR_TOWER && activeRadars >= radarCap) {
      return null;
    }

    let laneX = nearX ?? 0;
    let z = nearZ ?? (player.z - 160);
    let y = 2;
    let placed = false;
    for (let attempt = 0; attempt < 12 && !placed; attempt++) {
      if (nearX !== undefined && nearZ !== undefined) {
        laneX = nearX;
        z = nearZ;
        y = this.city.getHeightAt(laneX, z, 4);
        placed = true;
        break;
      }
      const rooftop = type === ObjectiveType.SAM_SITE && Math.random() < 0.35
        ? this.city.rooftopSpots.filter((spot) =>
            spot.y >= 8 &&
            spot.z < player.z - 105 &&
            spot.z > player.z - 245 &&
            Math.abs(spot.x) < 145)
        : [];
      if (rooftop.length > 0) {
        const spot = rooftop[Math.floor(Math.random() * rooftop.length)];
        laneX = spot.x;
        z = spot.z;
        y = spot.y;
      } else {
        laneX = lanes[Math.floor(Math.random() * lanes.length)] + (Math.random() - 0.5) * 14;
        z = player.z - 130 - Math.random() * 110;
        y = this.city.getHeightAt(laneX, z, 4);
        if (y < 3) y = 2;
      }
      placed = this.objectives.every((o) => !o.active || Math.hypot(o.position.x - laneX, o.position.z - z) >= SAM_MIN_SPACING);
    }
    if (!placed) return null;

    const obj = new Objective(this.scene, this.world, laneX, y, z, type);
    this.objectiveMissionId(obj);
    obj.spawnTime = performance.now() / 1000;
    // Ground-level objectives get a type-aware emplacement (Pass 7): military
    // pad for SAM sites, technical layout for radar towers, supply yard for
    // depots. The group is detached automatically when the objective dies.
    if (y <= 3.5) obj.propGroup = this.city.addObjectiveProps(laneX, z, obj.type);
    // Difficulty-scaled objective hull (capped so objectives never become sponges)
    const hpMult = Math.min(1.2, this.difficulty.objectiveHp);
    if (hpMult !== 1) {
      obj.maxHp = Math.max(40, Math.round(obj.maxHp * hpMult));
      obj.hp = obj.maxHp;
    }
    this.objectives.push(obj);
    if (type === ObjectiveType.SAM_SITE && !this.samSiteAnnouncedThisRun) {
      this.samSiteAnnouncedThisRun = true;
      this.announce("ANTI-AIR BATTERY DETECTED", "Surface-to-air threat in sector", "#ff5566");
    } else if (type === ObjectiveType.RADAR_TOWER && !this.radarSiteAnnouncedThisRun) {
      this.radarSiteAnnouncedThisRun = true;
      this.announce("RADAR STATION DETECTED", "Destroy it to weaken enemy reinforcement and SAM tracking", "#ffaa33");
    }
    return obj;
  }

  /** Apply a destroyable objective's battlefield effect. */
  private destroyObjective(obj: Objective, time: number) {
    if (obj.type === ObjectiveType.SAM_SITE || obj.type === ObjectiveType.RADAR_TOWER) {
      this.missionManager.reportObjectiveDestroyed(
        this.objectiveMissionId(obj),
        obj.type === ObjectiveType.SAM_SITE ? "SAM" : "RADAR",
        time,
        this.getMissionRuntimeSnapshot(),
      );
    }
    // C1: objectives feed the extraction offer gate.
    this.objectivesDestroyedThisRun++;
    this.score += Math.floor(obj.basePoints * this.comboMultiplier);
    this.particles.spawnExplosion(obj.position.x, obj.position.y, obj.position.z, 160, time, 50);
    this.volumetricExplosions.spawn(obj.position.x, obj.position.y, obj.position.z, 22, 9);
    this.addExplosionImpulse(obj.position.x, obj.position.y, obj.position.z, 4.5);
    
    if (obj.type === ObjectiveType.RADAR_TOWER) {
      this.audio.playRadarDestruction();
      this.particles.spawnDebris(obj.position.x, obj.position.y + 3, obj.position.z, time, 18, 26);
      this.particles.spawnSparks(obj.position.x, obj.position.y + 3, obj.position.z, time, 8, 16);
      this.dropLootPickup(obj.position.x, obj.position.y, obj.position.z, PowerUpType.SALVAGE_CACHE, 8, 2.0);
    } else if (obj.type === ObjectiveType.SAM_SITE) {
      this.audio.playExplosion(2.0);
      this.audio.playSamCookOff();
      this.particles.spawnDebris(obj.position.x, obj.position.y + 1, obj.position.z, time, 18, 26);
      this.particles.spawnCookOff(obj.position.x, obj.position.y, obj.position.z, time, 6);
      this.dropLootPickup(obj.position.x, obj.position.y, obj.position.z, PowerUpType.SALVAGE_CACHE, 8, 2.0);
      // Immediately cancel any active lock or decoy incoming SAM missiles
      for (const proj of this.enemyProjectiles.pool) {
        if (proj.active && proj.homingStrength > 0 && Math.hypot(proj.pos.x - obj.position.x, proj.pos.z - obj.position.z) < 40) {
          proj.targetType = "DECOY";
        }
      }
    } else {
      this.audio.playExplosion(2.0);
    }
    this.triggerHitStop(0.24, 0.05);
    const securedReward = securedObjectiveReward(obj.type);
    this.delivery.awardCredits(securedReward);
    this.addUnsecuredCredits(threatBonusFor(securedReward, this.threatLevel));
    this.addSalvage(salvageForObjective(obj.type));
    this.floatingCombatText.spawnReward(obj.position, `+${securedReward} CR`, "CREDITS");

    if (obj.type === ObjectiveType.SAM_SITE) {
      this.samSitesDestroyed++;
      this.addThreat(8);
      this.samSuppressionTimer = 18; // enemies fire slower for 18s
      this.announce("SAM DESTROYED", `+${securedReward} CR - airspace safer`, "#35e66d");
    } else if (obj.type === ObjectiveType.RADAR_TOWER) {
      this.radarSitesDestroyed++;
      this.addThreat(7);
      // EMP: damage all enemies
      for (const e of this.enemies) {
        if (e.active) {
          e.takeDamage(30, time);
        }
      }
      this.announce("RADAR DESTROYED", `+${securedReward} CR · enemy detection reduced`, "#7ee0ff");
    } else {
      // AMMO_DEPOT: guaranteed bomb power-up (as advertised) + ammo refill
      const bomb = new PowerUp(
        this.scene,
        obj.position.x,
        obj.position.y + 2,
        obj.position.z,
        PowerUpType.BOMB,
      );
      bomb.spawnTime = time;
      this.powerups.push(bomb);
      const weapon = this.weapons.get(this.currentWeapon);
      if (weapon) weapon.ammo = weapon.maxAmmo;
      this.announce("AMMO DEPOT SECURED", `+${securedReward} CR - bomb drop`, "#ffaa33");
    }
    this.updateUI(time);
  }

  spawnEnemy() {
    // --- Two-Budget Director Spawning ---
    // Spawns Combat Drone (DRONE), Tank (TANK), and Infantry Cluster (BASIC)
    let type = EnemyType.DRONE;
    let variant = EnemyVariant.STANDARD;
    const directorConfig = threatDirectorConfig(this.threatLevel);
    const directorWave = Math.max(this.currentWave, this.threatLevel * 2 - 1) + directorConfig.directorWaveBonus;
    
    if (this.pendingVariantQueue.length > 0) {
      const v = this.pendingVariantQueue.shift()!;
      variant = v;
      if (
        v === EnemyVariant.ATTACK_GUNSHIP ||
        v === EnemyVariant.ROCKET_GUNSHIP ||
        v === EnemyVariant.HEAVY_GUNSHIP ||
        v === EnemyVariant.MINELAYER
      ) {
        type = EnemyType.SHOOTER;
      } else if (
        v === EnemyVariant.FLAK_TANK ||
        v === EnemyVariant.MISSILE_CARRIER ||
        v === EnemyVariant.SIEGE_TANK ||
        v === EnemyVariant.GATLING_HEAVY
      ) {
        type = EnemyType.TANK;
      } else if (v === EnemyVariant.STANDARD && directorWave >= 2 && Math.random() < 0.25) {
        type = EnemyType.BASIC;
      } else {
        type = EnemyType.DRONE;
      }
    } else {
      const mixedComp = pickMixedComposition(directorWave);
      if (mixedComp) {
        if (mixedComp.sam > 0 && directorWave >= 8) {
          const activeSams = this.objectives.filter((o) => o.active && o.type === ObjectiveType.SAM_SITE).length;
          if (activeSams === 0) {
            this.spawnObjective(ObjectiveType.SAM_SITE);
          }
        }
        const total = mixedComp.air + mixedComp.tanks + mixedComp.infantry;
        const roll = Math.random() * (total || 1);
        if (roll < mixedComp.air) {
          // Select Air Archetype according to wave flow
          if (directorWave >= 8 && Math.random() < 0.12) {
            variant = EnemyVariant.KAMIKAZE_DRONE;
            type = EnemyType.DRONE;
          } else if (directorWave >= 7 && Math.random() < 0.22) {
            variant = EnemyVariant.ROCKET_GUNSHIP;
            type = EnemyType.SHOOTER;
          } else if (directorWave >= 6 && Math.random() < 0.28) {
            variant = EnemyVariant.ATTACK_GUNSHIP;
            type = EnemyType.SHOOTER;
          } else if (Math.random() < 0.40) {
            variant = EnemyVariant.SCOUT_DRONE;
            type = EnemyType.DRONE;
          } else {
            variant = EnemyVariant.STANDARD;
            type = EnemyType.DRONE;
          }
        } else if (roll < mixedComp.air + mixedComp.tanks && directorWave >= 3) {
          variant = EnemyVariant.FLAK_TANK;
          type = EnemyType.TANK;
        } else {
          variant = EnemyVariant.STANDARD;
          type = EnemyType.BASIC;
        }

        // Queue remaining members of mixed squadron
        for (let i = 0; i < mixedComp.air - (type === EnemyType.DRONE || type === EnemyType.SHOOTER ? 1 : 0); i++) {
          if (directorWave >= 7 && Math.random() < 0.2) this.pendingVariantQueue.push(EnemyVariant.ROCKET_GUNSHIP);
          else if (directorWave >= 6 && Math.random() < 0.25) this.pendingVariantQueue.push(EnemyVariant.ATTACK_GUNSHIP);
          else if (Math.random() < 0.4) this.pendingVariantQueue.push(EnemyVariant.SCOUT_DRONE);
          else this.pendingVariantQueue.push(EnemyVariant.STANDARD);
        }
        for (let i = 0; i < mixedComp.tanks - (type === EnemyType.TANK ? 1 : 0); i++) {
          this.pendingVariantQueue.push(EnemyVariant.FLAK_TANK);
        }
        for (let i = 0; i < mixedComp.infantry - (type === EnemyType.BASIC ? 1 : 0); i++) {
          this.pendingVariantQueue.push(EnemyVariant.STANDARD);
        }
      } else {
        // Wave 1-5 Early Game Progression:
        // Wave 1: 100% Air (Light Helis / Combat Drones)
        // Wave 2: ~80% Air + ~20% Infantry
        // Wave 3: ~75% Air + ~25% Tank (FLAK_TANK)
        // Wave 4: ~70% Air + ~20% Tank + ~10% Infantry
        // Wave 5: ~70% Air + ~20% Tank + ~10% Infantry
        const groundRoll = Math.random();
        if (directorWave >= 3 && groundRoll < (directorWave >= 4 ? 0.25 : 0.20)) {
          variant = EnemyVariant.FLAK_TANK;
          type = EnemyType.TANK;
        } else if (directorWave >= 2 && groundRoll < 0.35) {
          variant = EnemyVariant.STANDARD;
          type = EnemyType.BASIC;
        } else {
          type = EnemyType.DRONE;
          if (directorWave >= 2 && Math.random() < 0.35) {
            variant = EnemyVariant.SCOUT_DRONE;
          } else {
            variant = EnemyVariant.STANDARD;
          }
        }
      }
      if (this.pendingVariantQueue.length > PERFORMANCE_CAPS.MAX_SPAWN_QUEUE) {
        this.pendingVariantQueue.length = PERFORMANCE_CAPS.MAX_SPAWN_QUEUE;
      }
    }

    const modifier = EnemyModifier.NONE;
    const pattern = AttackPattern.CHASE;

    let spot;
    let attempts = 0;
    this.camera.updateMatrixWorld();
    const frustum = GameEngine._scratchFrustum;
    frustum.setFromProjectionMatrix(GameEngine._scratchMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const playerPos = this.helicopter.body.position;

    // Safe Ground Spawn Validation (on roads/open lots, outside close camera view)
    while (attempts < 8) {
      spot = this.getArcadeSpawnPoint(type, 0, 1);
      
      const point = GameEngine._scratchVec3.set(spot.x, spot.y, spot.z);
      if (frustum.containsPoint(point)) {
        const distSq = (spot.x - playerPos.x) ** 2 + (spot.z - playerPos.z) ** 2;
        if (distSq < 3600) {
          attempts++;
          continue; 
        }
      }
      
      // Avoid spawn overlap
      let overlap = false;
      for (const enemy of this.enemies) {
         if (enemy.active) {
            const eDistSq = (spot.x - enemy.mesh.position.x) ** 2 + (spot.z - enemy.mesh.position.z) ** 2;
            if (eDistSq < SPAWN_CONFIG.separation * SPAWN_CONFIG.separation) {
               overlap = true;
               break;
            }
         }
      }
      if (overlap) {
         attempts++;
         continue;
      }

      break;
    }

    if (!spot) spot = this.getArcadeSpawnPoint(type, 0, 1);

    const enemy = new Enemy(
      this.scene,
      this.world,
      spot.x,
      spot.z,
      type,
      spot.y,
      { modifier, pattern, variant, isElite: false },
    );
    this.scaleEnemyForDifficulty(enemy);
    this.enemies.push(enemy);
    
    // Spawn arrival dust / effect
    this.particles.spawnExplosion(spot.x, spot.y, spot.z, 20, performance.now() / 1000, 10);
    
    this.enemiesSpawnedInWave++;
    this.playSpawnCue(performance.now() / 1000);
    return true;
  }

  /**
   * Scale an enemy for the selected difficulty AND the procedural wave curve:
   * every wave raises HP (+18%), damage (+7%) and fire rate (+4%) so the
   * battlefield is measurably harder on wave 20 than wave 2.
   */
  private scaleEnemyForDifficulty(enemy: Enemy) {
    const mult = this.difficulty.enemyHp * waveEnemyPower(this.currentWave);
    if (mult !== 1) {
      enemy.maxHp = Math.max(5, Math.round(enemy.maxHp * mult));
      enemy.hp = enemy.maxHp;
    }
    if (enemy.shieldMaxHp > 0) {
      enemy.shieldMaxHp = Math.max(5, Math.round(enemy.shieldMaxHp * mult));
      enemy.shieldHp = enemy.shieldMaxHp;
      if (enemy.shieldMesh) enemy.shieldMesh.visible = true;
    }
    // Wave-scaled enemy weapon damage (stored for the player-hit callback)
    enemy.waveDamageMult = waveEnemyDamage(this.currentWave);
    enemy.waveFireRateMult = waveEnemyFireRate(this.currentWave);
    // Difficulty projectile speed / homing — applied once, here at spawn.
    enemy.projSpeedMult = this.difficulty.enemyProjectileSpeed;
    enemy.homingMult = this.difficulty.homingStrength;
    // Enemy aim skill tracks the wave: later waves land tighter shots.
    enemy.aimAccuracy = enemyAimAccuracy(this.currentWave);
    // The rolling wave theme can also thicken hulls (ARMORED / NIGHT_SURGE).
    const themeHp = this.currentWaveTheme?.enemyHpMult ?? 1;
    if (themeHp !== 1) {
      enemy.maxHp = Math.max(5, Math.round(enemy.maxHp * themeHp));
      enemy.hp = enemy.maxHp;
      if (enemy.shieldMaxHp > 0) {
        enemy.shieldMaxHp = Math.max(5, Math.round(enemy.shieldMaxHp * themeHp));
        enemy.shieldHp = enemy.shieldMaxHp;
      }
    }
  }

  /** Spawn the elite miniboss for wave % 5 === 0 waves. */
  private spawnMiniboss(time: number) {
    const scale = 1 + Math.floor(this.currentWave / 5) * 0.35;
    const type = EnemyType.TANK;
    const spot = this.getArcadeSpawnPoint(type, 0, 1);
    const elite = new Enemy(
      this.scene,
      this.world,
      spot.x,
      spot.z,
      type,
      spot.y,
      {
        isElite: true,
        modifier: EnemyModifier.SHIELDED,
        pattern: AttackPattern.CHASE,
      },
    );
    elite.maxHp = Math.max(5, Math.round(elite.maxHp * scale));
    elite.hp = elite.maxHp;
    if (elite.shieldMaxHp > 0) {
      elite.shieldMaxHp = Math.max(5, Math.round(elite.shieldMaxHp * scale));
      elite.shieldHp = elite.shieldMaxHp;
    }
    this.scaleEnemyForDifficulty(elite);
    this.enemies.push(elite);
    this.particles.spawnExplosion(spot.x, spot.y, spot.z, 50, time, 20);
    this.audio.playEnemySpawn();
    this.addCameraImpulse(2.5);
    this.announce("ELITE HEAVY TANK", "Heavy armor incoming", "#ffdd55");
  }

  /**
   * Wave-10 boss presentation: a short staged intro (warning → name → spawn)
   * so the fight lands like an event instead of a pop-in.
   */
  private bossIntroActive = false;
  private bossIntroStage = 0;
  private bossIntroNextTime = 0;

  private startBossBattle(time: number) {
    if (this.bossIntroActive) return;
    this.bossIntroActive = true;
    this.bossIntroStage = 1;
    this.bossIntroNextTime = time + 0.9;
    this.announce("⚠ WARNING ⚠", "Heavy Gunship Inbound", "#ff3366");
    this.audio.playBossIntro(1);
  }

  private updateBossIntro(time: number) {
    if (!this.bossIntroActive || time < this.bossIntroNextTime) return;
    if (this.bossIntroStage === 1) {
      this.bossIntroStage = 2;
      this.bossIntroNextTime = time + 0.9;
      this.announce("HEAVY GUNSHIP", "Archon Airborne Command", "#d84cff");
      this.audio.playBossIntro(2);
    } else if (this.bossIntroStage === 2) {
      this.bossIntroStage = 3;
      this.bossIntroNextTime = time + 0.9;
      this.spawnBossBattle(time);
    } else {
      this.bossIntroActive = false;
    }
  }

  /**
   * Boss battle: Heavy Gunship (EnemyType.BOSS) + controlled ground escorts.
   */
  private spawnBossBattle(time: number) {
    const spot = this.getArcadeSpawnPoint(EnemyType.BOSS, 0, 1);
    const boss = new Enemy(
      this.scene,
      this.world,
      spot.x,
      spot.z,
      EnemyType.BOSS,
      spot.y,
      {
        isElite: false,
        modifier: EnemyModifier.NONE,
        pattern: AttackPattern.CHASE,
      },
    );
    this.scaleEnemyForDifficulty(boss);
    this.enemies.push(boss);

    // Escort squad (1 Tank + 1 Infantry Squad)
    const escortTypes = [EnemyType.TANK, EnemyType.BASIC];
    for (let i = 0; i < escortTypes.length; i++) {
      const escortType = escortTypes[i];
      const eSpot = this.getArcadeSpawnPoint(escortType, i, 2);
      this.pendingEventSpawns.push({
        type: escortType,
        x: eSpot.x + (Math.random() - 0.5) * 16,
        z: eSpot.z + i * 14,
        y: eSpot.y,
        modifier: EnemyModifier.NONE,
        pattern: AttackPattern.CHASE,
      });
    }

    this.particles.spawnExplosion(spot.x, spot.y, spot.z, 80, time, 35);
    this.audio.playBossIntro(3);
    this.audio.playEnemySpawn();
    this.addCameraImpulse(4.0);
    this.triggerHitStop(0.35, 0.05);
    this.announce("⚠ HEAVY GUNSHIP ONLINE ⚠", "Airspace contested", "#ff3366");
  }

  private getArcadeSpawnPoint(type: EnemyType, index: number, formationSize: number) {
    const player = this.helicopter.body.position;

    // Survival spawn ring: spawn just beyond the visible field, then stream in.
    // The chase camera faces the heading, so pressure is biased AHEAD of the
    // nose — otherwise everything engages from behind the camera and the pilot
    // only ever sees incoming tracers.
    const SPAWN_INNER_RADIUS = 85;
    const SPAWN_OUTER_RADIUS = 165;

    // World angle that points exactly along forwardVector = (sin h, 0, cos h).
    const heading = this.helicopter.mesh.rotation.y;
    const noseAngle = Math.atan2(Math.cos(heading), Math.sin(heading));

    let angle: number;
    if (type === EnemyType.DRONE || type === EnemyType.SHOOTER || type === EnemyType.BOSS) {
      if (Math.random() < 0.65) {
        // ~65% of air pressure arrives in a wide front arc ahead of the nose.
        angle = noseAngle + (Math.random() - 0.5) * 2.2;
      } else {
        const sectorAngle = this.combatDirector.getSectorSpawnAngle(
          Math.floor(Math.random() * 10000) + index * 17,
          this.currentWave,
          this.isOverdrive,
        );
        angle = sectorAngle + (Math.random() - 0.5) * 0.35;
      }
    } else {
      angle = Math.random() * Math.PI * 2;
      if (Math.random() < 0.55) {
        // Ground units favor the same nose-front arc so they appear ahead too.
        angle = noseAngle + (Math.random() - 0.5) * 1.9;
      }
    }
    
    const stagger = (index - (formationSize - 1) / 2) * 14;
    const distance = SPAWN_INNER_RADIUS + Math.random() * (SPAWN_OUTER_RADIUS - SPAWN_INNER_RADIUS) + Math.abs(stagger);
    
    const targetX = player.x + Math.cos(angle) * distance;
    const targetZ = player.z + Math.sin(angle) * distance;

    let baseX = THREE.MathUtils.clamp(targetX, -170, 170);
    let baseZ = targetZ;

    if (type === EnemyType.DRONE || type === EnemyType.BOSS || type === EnemyType.SHOOTER) {
      const minSafeHeight = this.city.getHeightAt(baseX, baseZ, 2.0) + 6.0;
      const desiredY = player.y + (type === EnemyType.BOSS ? 4.0 : (Math.random() - 0.5) * 6.0);
      const y = Math.max(minSafeHeight, Math.max(15, desiredY));
      return { x: baseX, y, z: baseZ };
    }

    const clearance = type === EnemyType.TANK ? 2.5 : 1.0;
    let height = this.city.getHeightAt(baseX, baseZ, clearance);

    // If placed on top of a building or roof, redirect to the nearest street / open ground lot
    if (height > 2.2) {
      const ambush = this.city.getAmbushSpot(player, SPAWN_INNER_RADIUS, SPAWN_OUTER_RADIUS);
      baseX = THREE.MathUtils.clamp(ambush.x + (Math.random() - 0.5) * 8, -170, 170);
      baseZ = ambush.z + (Math.random() - 0.5) * 8;
      height = this.city.getHeightAt(baseX, baseZ, clearance);
    }

    const y = Math.max(clearance === 2.5 ? 1.2 : 0.6, height + (clearance === 2.5 ? 1.2 : 0.6));

    return {
      x: baseX,
      y,
      z: baseZ,
    };
  }

  private playSpawnCue(time: number) {
    if (time - this.lastSpawnSoundTime < 0.4) return;
    this.lastSpawnSoundTime = time;
    this.audio.playEnemySpawn();
  }

  /**
   * Drain the bounded event/escort spawn queue. Constructs at most one model
   * per call so ground convoys arrive as a staggered stream.
   */
  private drainEventSpawns(time: number) {
    let drained = 0;
    while (drained < SPAWN_CONFIG.maxPerTick && this.pendingEventSpawns.length > 0) {
      const d = this.pendingEventSpawns.shift()!;
      const groundType = d.type === EnemyType.TANK ? EnemyType.TANK : EnemyType.BASIC;
      const enemy = new Enemy(this.scene, this.world, d.x, d.z, groundType, d.y, {
        modifier: d.modifier ?? EnemyModifier.NONE,
        pattern: d.pattern ?? AttackPattern.CHASE,
        variant: groundType === EnemyType.TANK ? EnemyVariant.FLAK_TANK : EnemyVariant.STANDARD,
      });
      this.scaleEnemyForDifficulty(enemy);
      this.enemies.push(enemy);
      this.particles.spawnExplosion(d.x, d.y, d.z, 20, time, 10);
      this.playSpawnCue(time);
      if (this.isPlaying) this.enemiesSpawnedInWave++;
      drained++;
      if (groundType === EnemyType.TANK) break;
    }
  }

  private trySpawnPriorityTarget(time: number) {
    if (this.currentWave < 4 || this.priorityTargetEnemy?.active || this.currentWave % 5 === 0) {
      return;
    }
    if (this.priorityTargetCooldown > 0) {
      return;
    }

    const waveChance = this.isOverdrive
      ? PRIORITY_TARGET_OVERDRIVE_CHANCE
      : (PRIORITY_TARGET_WAVE_CHANCE[this.currentWave] ?? 0.12);

    if (Math.random() > waveChance) {
      this.priorityTargetCooldown = 6.0;
      return;
    }

    const candidates = this.enemies.filter(
      (e) => e.active && !e.isElite && e.type !== EnemyType.BOSS && !e.isDying,
    );
    if (candidates.length === 0) {
      this.priorityTargetCooldown = 5.0;
      return;
    }

    // Prefer air gunships/drones or heavy tanks
    candidates.sort((a, b) => {
      const weightA = a.type === EnemyType.SHOOTER ? 3 : a.type === EnemyType.DRONE ? 2 : 1;
      const weightB = b.type === EnemyType.SHOOTER ? 3 : b.type === EnemyType.DRONE ? 2 : 1;
      return weightB - weightA;
    });

    const target = candidates[0];
    target.setPriorityTarget(true);
    target.maxHp = Math.round(target.maxHp * 1.30);
    target.hp = target.maxHp;
    this.priorityTargetEnemy = target;
    this.priorityTargetAnnouncedAt = time;
    this.priorityTargetCooldown = 28.0 + Math.random() * 8.0;

    const label =
      target.variant === EnemyVariant.ATTACK_GUNSHIP
        ? "GUNSHIP COMMANDER"
        : target.variant === EnemyVariant.FLAK_TANK
        ? "ARMORED FLAK LEADER"
        : target.variant === EnemyVariant.ROCKET_GUNSHIP
        ? "ROCKET GUNSHIP ACE"
        : "HIGH-VALUE TARGET";

    this.announce("⚡ PRIORITY TARGET DETECTED ⚡", `${label} marked · High value bounty`, "#ffd43b");
    this.audio.playEnemySpawn();
  }

  private updatePriorityTarget(time: number, delta: number) {
    if (this.priorityTargetCooldown > 0) {
      this.priorityTargetCooldown = Math.max(0, this.priorityTargetCooldown - delta);
    }

    if (this.priorityTargetEnemy) {
      if (this.priorityTargetEnemy.active) {
        this.priorityTargetInfo = {
          enemyId: this.priorityTargetEnemy.id,
          variant: this.priorityTargetEnemy.variant,
          announcedAt: this.priorityTargetAnnouncedAt,
          x: this.priorityTargetEnemy.mesh.position.x,
          y: this.priorityTargetEnemy.mesh.position.y + 2.5,
          z: this.priorityTargetEnemy.mesh.position.z,
          hp: this.priorityTargetEnemy.hp,
          maxHp: this.priorityTargetEnemy.maxHp,
          hpRatio: this.priorityTargetEnemy.hp / Math.max(1, this.priorityTargetEnemy.maxHp),
          active: true,
        };
      } else {
        // Target was destroyed
        const reward = priorityTargetReward(this.currentWave);
        this.delivery.awardCredits(reward.credits);
        this.addSalvage(reward.salvage);
        this.grantRunXp(reward.xp, time);
        this.floatingCombatText.spawnReward(
          this.priorityTargetEnemy.mesh.position,
          `+${reward.credits} CR [PRIORITY]`,
          "CREDITS",
        );
        this.announce(
          "PRIORITY TARGET ELIMINATED",
          `+${reward.credits} CR · +${reward.salvage} Salvage · Pressure Reduced`,
          "#55f2a2",
        );
        // Grant temporary pressure relief: trigger a micro-lull
        this.combatDirector.triggerMicroLull(3.0);

        this.priorityTargetEnemy.setPriorityTarget(false);
        this.priorityTargetEnemy = null;
        this.priorityTargetInfo = null;
      }
    } else {
      this.priorityTargetInfo = null;
      this.trySpawnPriorityTarget(time);
    }

    // Pickup risk timer
    if (this.pickupRiskActive) {
      this.pickupRiskTimer -= delta;
      if (this.pickupRiskTimer <= 0) {
        this.pickupRiskActive = false;
      }
    }
  }

  updateAIDirector(time: number, delta: number) {
    this.survivalTime += delta;
    this.updatePriorityTarget(time, delta);
    if (this.waveFireSilenceTimer > 0) {
      this.waveFireSilenceTimer = Math.max(0, this.waveFireSilenceTimer - delta);
    }

    const isBossActive = this.enemies.some((e) => e.active && e.type === EnemyType.BOSS);
    const targetPop = enemyPopulationTarget(
      this.currentWave,
      this.threatLevel,
      this.isOverdrive,
      this.overdriveMultiplier,
      isBossActive,
    );

    // Dynamic combat intensity calculation
    this.combatIntensity = calculateCombatIntensity({
      elapsedRunTime: this.survivalTime,
      wave: this.currentWave,
      threatLevel: this.threatLevel,
      healthRatio: this.maxHealth > 0 ? this.health / this.maxHealth : 1.0,
      activeEnemiesCount: this.enemies.filter((e) => e.active).length,
      targetEnemiesCount: targetPop,
      isBossActive,
      isOverdrive: this.isOverdrive,
      overdriveMultiplier: this.overdriveMultiplier,
    });

    // Initial start — wave 1 waits for the countdown to finish (GO)
    if (this.currentWave === 0) {
      if (this.waveTransitionTimer <= 0 && this.openingPhase !== "countdown" && !this.tutorialActive) {
        this.startNextWave();
      }
      return;
    }

    // Periodic power-up spawning check
    this.powerupSpawnTimer -= delta;
    if (this.powerupSpawnTimer <= 0) {
      this.spawnPeriodicPowerUp();
      this.powerupSpawnTimer = 8.0 + Math.random() * 4.0;
    }

    // Pause spawning during transitions
    if (this.waveTransitionTimer > 0) {
      return;
    }

    // Wave advances on clock — survival time is the score
    this.waveTimer += delta;
    if (this.waveTimer >= waveDuration(this.currentWave)) {
      this.waveTimer = 0;
      this.startNextWave();
      return;
    }

    // Elite heavy tank miniboss every 5th wave
    this.updateBossIntro(time);
    if (this.currentWave % 5 === 0 && !this.minibossSpawnedThisWave) {
      this.minibossSpawnedThisWave = true;
      this.spawnMiniboss(time);
    }

    // Evaluate active Ground Threat and Air Threat separately
    let currentGroundThreat = 0;
    let currentAirThreat = 0;

    for (const e of this.enemies) {
      if (e.active) {
        if (e.type === EnemyType.DRONE) {
          currentAirThreat +=
            e.variant === EnemyVariant.KAMIKAZE_DRONE
              ? AIR_THREAT_COSTS.KAMIKAZE_DRONE
              : AIR_THREAT_COSTS.COMBAT_DRONE;
        } else if (e.type === EnemyType.SHOOTER) {
          currentAirThreat +=
            e.variant === EnemyVariant.ROCKET_GUNSHIP
              ? AIR_THREAT_COSTS.ROCKET_GUNSHIP
              : AIR_THREAT_COSTS.ATTACK_GUNSHIP;
        } else if (e.type === EnemyType.TANK) {
          currentGroundThreat += GROUND_THREAT_COSTS.TANK;
        } else if (e.type === EnemyType.BASIC) {
          currentGroundThreat += GROUND_THREAT_COSTS.INFANTRY;
        }
      }
    }
    for (const o of this.objectives) {
      if (o.active && o.type === ObjectiveType.SAM_SITE) {
        currentGroundThreat += GROUND_THREAT_COSTS.SAM;
      }
    }

    this.currentGroundThreat = currentGroundThreat;
    this.currentAirThreat = currentAirThreat;

    // Compute decoupled threat targets from central curves
    this.desiredGroundThreat =
      groundThreatTarget(this.currentWave, this.threatLevel, this.isOverdrive, isBossActive) *
      this.difficulty.spawnRate;
    this.desiredAirThreat =
      airThreatTarget(this.currentWave, this.threatLevel, this.isOverdrive, isBossActive) *
      this.difficulty.spawnRate;

    const maxActiveEnemies = Math.min(PERFORMANCE_CAPS.MAX_ACTIVE_ENEMIES, targetPop);
    const radarHordeBoost = this.radarActive ? 0.82 : 1.0;
    const hordeInterval = calculateSpawnInterval(
      this.currentWave,
      this.difficulty.spawnRate,
      radarHordeBoost * threatDirectorConfig(this.threatLevel).spawnIntervalMult,
      this.combatIntensity,
      this.combatDirector.isMicroLull(),
    );

    // Continuous Horde Spawning
    this.spawnTimer -= delta;
    if (this.combatDirector.isMicroLull()) {
      // During micro-lull, let the player breathe and scoop drops / maneuver
      this.spawnTimer = Math.max(this.spawnTimer, 0.45);
    } else if (this.spawnTimer <= 0) {
      if (this.pendingEventSpawns.length > 0) {
        this.drainEventSpawns(time);
        this.spawnTimer = 0.18;
      } else if (this.pendingSpawns > 0) {
        this.spawnEnemy();
        this.pendingSpawns--;
        this.spawnTimer = hordeInterval;
      } else {
        const groundDeficit = this.desiredGroundThreat - currentGroundThreat;
        const airDeficit = this.desiredAirThreat - currentAirThreat;
        const totalDeficit = Math.max(0, groundDeficit) + Math.max(0, airDeficit);

        if (totalDeficit > 0.5 && this.enemies.length < maxActiveEnemies) {
          if (airDeficit >= 1.5) {
            if (this.currentWave >= 8 && Math.random() < 0.14) {
              this.pendingVariantQueue.push(EnemyVariant.KAMIKAZE_DRONE);
            } else if (this.currentWave >= 7 && Math.random() < 0.22) {
              this.pendingVariantQueue.push(EnemyVariant.ROCKET_GUNSHIP);
            } else if (this.currentWave >= 6 && Math.random() < 0.28) {
              this.pendingVariantQueue.push(EnemyVariant.ATTACK_GUNSHIP);
            } else if (this.currentWave >= 2 && Math.random() < 0.38) {
              this.pendingVariantQueue.push(EnemyVariant.SCOUT_DRONE);
            } else {
              this.pendingVariantQueue.push(EnemyVariant.STANDARD);
            }
          } else if (groundDeficit >= 1.5 && this.currentWave >= 3) {
            if (this.currentWave >= 5 && Math.random() < 0.25) {
              this.pendingVariantQueue.push(EnemyVariant.MISSILE_CARRIER);
            } else {
              this.pendingVariantQueue.push(EnemyVariant.FLAK_TANK);
            }
          }
          this.pendingSpawns = Math.min(
            maxActiveEnemies - this.enemies.length,
            Math.max(1, Math.ceil(totalDeficit / 1.5)),
            PERFORMANCE_CAPS.MAX_SPAWN_QUEUE,
          );
          this.spawnTimer = hordeInterval;
        } else {
          this.spawnTimer = 0.35;
        }
      }
    }

    // Trigger battlefield events at intervals during the wave if not in transition.
    // Wave 1 stays event-free — no missile storms or ambushes while learning.
    this.battlefieldEventTimer -= delta;
    if (this.battlefieldEventTimer <= 0) {
      if (this.currentWave <= 1) {
        this.battlefieldEventTimer = 14;
      } else {
        this.triggerBattlefieldEvent(time);
        this.battlefieldEventTimer = Math.max(12, 28 - this.combatIntensity * 12);
      }
    }
  }

  spawnDirectedEnemy(time = performance.now() / 1000, index = 0, formationSize = 1) {
    // Legacy callers feed the same bounded queue as the wave director. Keeping
    // construction in spawnEnemy guarantees one normal enemy per simulation tick.
    void time;
    void index;
    this.pendingSpawns = Math.min(
      SPAWN_CONFIG.maxQueue,
      this.pendingSpawns + Math.max(1, Math.floor(formationSize)),
    );
    this.spawnTimer = Math.min(this.spawnTimer, 0.05);
  }

  /** Count of active enemies of a given variant (used for event cap checks). */
  private variantActiveCount(variant: EnemyVariant): number {
    let count = 0;
    for (const e of this.enemies) if (e.active && e.variant === variant) count++;
    return count;
  }

  /**
   * When a shield drone leaves the battlefield, clear its damage-reduction
   * aura from every remaining enemy. Surviving shield drones re-apply their
   * own aura on the next tick, so support never leaks across a death.
   */
  private releaseShieldAuras(removed: Enemy) {
    if (removed.variant !== EnemyVariant.SHIELD_DRONE) return;
    for (const other of this.enemies) {
      if (other !== removed && other.active && other.incomingDamageMult < 1) {
        other.incomingDamageMult = 1;
      }
    }
  }

  triggerBattlefieldEvent(time: number) {
    const player = this.helicopter.body.position;
    const eventRoll = Math.random();
    const eventZ = player.z - 95 - Math.random() * 80;

    if (eventRoll < 0.25 && this.currentWave >= 2) {
      // ⚡ TACTICAL SALVAGE DROP (Pickup-Risk Tactical Event)
      this.waveMessage = "SALVAGE DROP DETECTED";
      this.waveTransitionTimer = 1.4;
      this.pickupRiskActive = true;
      this.pickupRiskTimer = 16.0;

      // Spawn high-value salvage cache 70-95m away
      const cacheX = player.x + (Math.random() < 0.5 ? -1 : 1) * (55 + Math.random() * 30);
      const cacheZ = player.z - (70 + Math.random() * 25);
      const cacheY = Math.max(2, this.city.getHeightAt(cacheX, cacheZ, 2.0));
      this.dropLootPickup(cacheX, cacheY, cacheZ, PowerUpType.SALVAGE_CACHE, 10, 3.0);

      // Queue 2-3 aggressive Air attackers setting up in that sector
      for (let i = 0; i < 3; i++) {
        this.pendingVariantQueue.push(
          this.currentWave >= 6 && Math.random() < 0.35
            ? EnemyVariant.ATTACK_GUNSHIP
            : this.currentWave >= 2 && Math.random() < 0.45
            ? EnemyVariant.SCOUT_DRONE
            : EnemyVariant.STANDARD,
        );
      }
      this.pendingSpawns += 3;
      this.announce("⚡ SALVAGE CACHE DETECTED ⚡", "Contested zone · Air attackers moving in", "#ffd43b");
    } else if (eventRoll < 0.50) {
      this.waveMessage = "MISSILE STORM";
      this.waveTransitionTimer = 1.4;
      for (let i = 0; i < 7 + this.combatIntensity * 6; i++) {
        const x = player.x + (Math.random() - 0.5) * 130;
        const z = player.z - 50 - Math.random() * 150;
        const dx = player.x - x;
        const dz = player.z - z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        this.enemyProjectiles.spawn(x, player.y + 8 + Math.random() * 12, z, dx / len, dz / len, time, (115 + this.combatIntensity * 85) * this.difficulty.enemyProjectileSpeed);
      }
    } else if (eventRoll < 0.75) {
      this.waveMessage = "CONVOY AMBUSH";
      this.waveTransitionTimer = 1.4;
      // Queue the convoy — tanks/shooters construct and arrive over the next
      // few seconds instead of 4-8 full models in this single frame. Variants
      // respect their battlefield caps so events never stack rare units.
      const flakCapped = this.variantActiveCount(EnemyVariant.FLAK_TANK) >= (ENEMY_VARIANTS[EnemyVariant.FLAK_TANK].maxActive ?? 6);
      const carrierCapped = this.variantActiveCount(EnemyVariant.MISSILE_CARRIER) >= (ENEMY_VARIANTS[EnemyVariant.MISSILE_CARRIER].maxActive ?? 2);
      let carrierQueued = false;
      for (let i = 0; i < 4 + this.combatIntensity * 4; i++) {
        const isTank = i % 2 === 0;
        let variant: EnemyVariant | undefined;
        if (isTank) {
          if (!carrierCapped && !carrierQueued && this.currentWave >= 5) {
            variant = EnemyVariant.MISSILE_CARRIER;
            carrierQueued = true;
          } else if (!flakCapped && this.currentWave >= 4) {
            variant = EnemyVariant.FLAK_TANK;
          }
        } else if (this.currentWave >= 3) {
          variant = pickEnemyVariant(this.currentWave);
        }
        this.pendingEventSpawns.push({
          type: isTank ? EnemyType.TANK : EnemyType.SHOOTER,
          x: -70 + i * 35,
          z: eventZ - i * 12,
          y: 7,
          variant,
        });
        if (this.isPlaying) this.totalEnemiesInWave++;
      }
    } else {
      this.waveMessage = "AIR RAID";
      this.waveTransitionTimer = 1.4;
      // Queue the raid — drones trickle in rather than an 8-14 model spike.
      const kamikazeCapped = this.variantActiveCount(EnemyVariant.KAMIKAZE_DRONE) >= (ENEMY_VARIANTS[EnemyVariant.KAMIKAZE_DRONE].maxActive ?? 6);
      let kamikazeQueued = 0;
      for (let i = 0; i < 8 + this.combatIntensity * 6; i++) {
        // ~25% of a raid are kamikaze divers (capped); the rest are scouts/standard.
        let variant: EnemyVariant | undefined;
        if (this.currentWave >= 3 && !kamikazeCapped && kamikazeQueued < 2 && Math.random() < 0.25) {
          variant = EnemyVariant.KAMIKAZE_DRONE;
          kamikazeQueued++;
        } else if (this.currentWave >= 2 && Math.random() < 0.5) {
          variant = EnemyVariant.SCOUT_DRONE;
        }
        this.pendingEventSpawns.push({
          type: EnemyType.DRONE,
          x: player.x + (Math.random() - 0.5) * 160,
          z: eventZ - Math.random() * 130,
          y: player.y + 2 + Math.random() * 14,
          variant,
        });
        if (this.isPlaying) this.totalEnemiesInWave++;
      }
    }
  }

  pollGamepad(time: number, delta: number) {
    if (!this.isPlaying) return;
    if (this.gamepadIndex === null) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) {
      this.onGamepadDisconnected();
      return;
    }

    const DEADZONE = MOVEMENT_CONFIG.analogDeadzone;
    // Left stick: X = rudder yaw (+right), Y = cyclic thrust (+forward when up).
    const lx = gp.axes[0] ?? 0;
    const ly = gp.axes[1] ?? 0; // Standard pad: negative is up
    const rawUp = -ly;
    const lMag = Math.hypot(lx, rawUp);

    if (lMag > DEADZONE) {
      this.hasInputThisFrame = true;
      const normX = lx / lMag;
      const normUp = rawUp / lMag;
      // Linear radial deadzone remapping (0..1) with immediate input response
      const clampedMag = Math.min(1, (lMag - DEADZONE) / (1 - DEADZONE));

      this.gamepadMove.x = normX * clampedMag;   // rudder
      this.gamepadMove.z = normUp * clampedMag;  // thrust

      this.audio.resume();
    } else {
      this.gamepadMove.x = 0;
      this.gamepadMove.z = 0;
    }

    // D-pad: left/right = lateral strafe, up/down = collective (Shift/Ctrl).
    this.gamepadStrafe =
      (gp.buttons[14]?.pressed ? -1 : 0) + (gp.buttons[15]?.pressed ? 1 : 0);
    this.gamepadVert =
      (gp.buttons[12]?.pressed ? 1 : 0) + (gp.buttons[13]?.pressed ? -1 : 0);
    if (this.gamepadStrafe !== 0 || this.gamepadVert !== 0) {
      this.hasInputThisFrame = true;
    }

    // Right stick: decoupled chin-gun aiming — the gimbal tracks the stick
    // while the airframe keeps its own heading (auto-fire while deflected).
    const rx = gp.axes[2] ?? 0;
    const ry = gp.axes[3] ?? 0;
    const rMag = Math.hypot(rx, ry);

    if (rMag > DEADZONE) {
      this.audio.resume();
      this.isMouseActive = false;
      this.mouseAimValid = false;

      const aimDist = 65;
      const aimHeight = this.helicopter.body.position.y;

      const camFwd = GameEngine._scratchCamFwd;
      this.camera.getWorldDirection(camFwd);
      camFwd.y = 0;
      if (camFwd.lengthSq() < 0.0001) camFwd.set(0, 0, -1);
      else camFwd.normalize();

      const camRight = GameEngine._scratchCamRight;
      camRight.crossVectors(camFwd, this.worldUp).normalize();

      const rNormX = rx / rMag;
      const rScreenY = this.settings.invertedY ? ry / rMag : -ry / rMag;

      const aimWorldX = camRight.x * rNormX + camFwd.x * rScreenY;
      const aimWorldZ = camRight.z * rNormX + camFwd.z * rScreenY;

      this.aimPoint.set(
        this.helicopter.body.position.x + aimWorldX * aimDist,
        aimHeight,
        this.helicopter.body.position.z + aimWorldZ * aimDist,
      );
      this.helicopter.setGunAim(this.aimPoint.x, aimHeight, this.aimPoint.z, true);
      this.targetGroup.visible = false;
    }

    // Gamepad buttons
    this.isFiringGamepad =
      gp.buttons[0]?.pressed ||
      gp.buttons[7]?.pressed ||
      (gp.buttons[7] && gp.buttons[7].value > 0.1) ||
      gp.buttons[5]?.pressed ||
      rMag > DEADZONE;
    if (this.isFiringGamepad) {
      this.audio.resume();
    }

    // X button (2) = Reload
    if (gp.buttons[2]?.pressed) {
      this.startReload();
    }

    // LB (4) = Countermeasure
    if (gp.buttons[4]?.pressed) {
      this.deployCountermeasure(performance.now() / 1000);
    }
    // B-button dash and R3 camera-recenter were retired with the heading-
    // relative schema (dash fights the momentum model; the camera is now a
    // speed-reactive tail-chase cam locked to the heading).
  }

  updateKeyboardMovement(delta: number) {
    // Heading-relative flight schema. Digital keys are the primary source;
    // touch joystick > gamepad analog override them when active.

    // 1. Keyboard digital flight inputs.
    let kbRudder = 0; // +1 turn right (D / →)
    let kbThrust = 0; // +1 accelerate forward along heading (W / ↑)
    let kbStrafe = 0; // +1 strafe right (E)
    if (this.movementKeys.has("a") || this.movementKeys.has("arrowleft")) kbRudder -= 1;
    if (this.movementKeys.has("d") || this.movementKeys.has("arrowright")) kbRudder += 1;
    if (this.movementKeys.has("w") || this.movementKeys.has("arrowup")) kbThrust += 1;
    if (this.movementKeys.has("s") || this.movementKeys.has("arrowdown")) kbThrust -= 1;
    if (this.movementKeys.has("q")) kbStrafe -= 1;
    if (this.movementKeys.has("e")) kbStrafe += 1;

    // 2. Touch left stick (heading-relative analog): push up = thrust forward,
    //    push left/right = rudder yaw.
    let touchRudder = 0;
    let touchThrust = 0;
    if (this.leftStick.active) {
      const lx = THREE.MathUtils.clamp(this.leftStick.x, -1, 1);
      const ly = THREE.MathUtils.clamp(this.leftStick.y, -1, 1);
      const rawUp = -ly; // Screen up is positive
      const lMag = Math.hypot(rawUp, lx);
      const TOUCH_DEADZONE = 0.12;
      if (lMag > TOUCH_DEADZONE) {
        const clamped = Math.min(1, (lMag - TOUCH_DEADZONE) / (1 - TOUCH_DEADZONE));
        touchRudder = (lx / lMag) * clamped;
        touchThrust = (rawUp / lMag) * clamped;
      }
    }

    // 3. Select the active horizontal source (touch > gamepad > keyboard).
    const padActive =
      this.gamepadIndex !== null &&
      (Math.abs(this.gamepadMove.x) > 0.005 ||
        Math.abs(this.gamepadMove.z) > 0.005 ||
        this.gamepadStrafe !== 0 ||
        this.gamepadVert !== 0);

    let yaw = kbRudder;
    let thrust = kbThrust;
    let strafe = kbStrafe;
    if (this.leftStick.active) {
      yaw = touchRudder;
      thrust = touchThrust;
      strafe = 0;
    } else if (padActive) {
      yaw = this.gamepadMove.x;
      thrust = this.gamepadMove.z;
      strafe = this.gamepadStrafe;
    }

    this.yawInput = THREE.MathUtils.clamp(yaw, -1, 1);
    this.keyboardVelocity.x = THREE.MathUtils.clamp(strafe, -1, 1);
    this.keyboardVelocity.y = THREE.MathUtils.clamp(thrust, -1, 1);

    // 4. Collective vertical: Shift climbs, Ctrl descends (+ pad D-pad).
    let moveY = 0;
    if (
      this.movementKeys.has("shift") ||
      this.movementKeys.has(" ") ||
      this.movementKeys.has("spacebar")
    )
      moveY += 1;
    if (this.movementKeys.has("control")) moveY -= 1;
    if (this.gamepadIndex !== null) moveY += this.gamepadVert;
    this.verticalInput = THREE.MathUtils.clamp(moveY, -1, 1);

    // Afterburner was retired by the new schema — Shift is collective now.
    this.afterburnerActive = false;

    if (
      Math.abs(this.yawInput) > 0.001 ||
      Math.abs(this.keyboardVelocity.x) > 0.001 ||
      Math.abs(this.keyboardVelocity.y) > 0.001 ||
      Math.abs(this.verticalInput) > 0.001
    ) {
      this.hasInputThisFrame = true;
    }
  }



  tick = () => {
    if (this.disposed || !this.running) return;
    this.animationFrameId = requestAnimationFrame(this.tick);

    try {
    this.frameCount++;
    // 2m: reset per-frame particle budget.
    this.particleBudgetThisFrame = GameEngine.PARTICLE_BUDGET_PER_FRAME;

    const time = performance.now() / 1000;
    // Phase 1: clamp frame spikes so a 0.2–2s hitch (tab switch, GC, driver
    // stall) can't launch entities across the world. 0.05s = exactly the 3
    // fixed substeps of world.step(1/60, dt, 3), so physics stays in sync up
    // to the clamp. Negative/NaN deltas (clock jumps) are treated as 0.
    let realDelta = time - this.lastTime;
    this.lastTime = time;
    if (!Number.isFinite(realDelta) || realDelta < 0) realDelta = 0;

    // Rolling FPS + frame-time ring on the RAW delta (pre-clamp) so the perf
    // overlay reports true frame cost, including hitches.
    this.fpsFrames++;
    this.fpsAccum += realDelta;
    if (this.fpsAccum >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsFrames = 0;
      this.fpsAccum = 0;
    }
    this.frameMsRing[this.frameMsIndex] = realDelta * 1000;
    this.frameMsIndex = (this.frameMsIndex + 1) % this.frameMsRing.length;
    if (this.frameMsCount < this.frameMsRing.length) this.frameMsCount++;

    realDelta = Math.min(realDelta, GameEngine.MAX_SIMULATION_DT);

    // A4: adaptive quality governor — one measurement window every 1.5s.
    this.governorWindowFrames++;
    this.governorWindowTime += realDelta;
    if (this.governorWindowTime >= 1.5) {
      const windowFps = this.governorWindowFrames / this.governorWindowTime;
      this.governorWindowFrames = 0;
      this.governorWindowTime = 0;
      const before = this.governor.level;
      this.governor = updateQualityGovernor(this.governor, windowFps, time);
      if (this.governor.level !== before) this.applyGovernorQuality();
    }

    // Phase 1 dev memory monitor (Step 9) — every 2s, DEV only, opt-in.
    if (this.memMon) {
      this.memMonTimer += realDelta;
      if (this.memMonTimer >= 2.0) {
        this.memMonTimer = 0;
        this.monitorMemory(time);
      }
    }

    // Process Hit-Stop timer using real unscaled time
    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= realDelta;
      if (this.hitStopTimer <= 0) {
        this.timeScale = 1.0;
      }
    }

    const delta = realDelta * this.timeScale;

    if (!this.isPlaying) {
      this.innerRing.rotation.z += 0.025;
      this.outerRing.rotation.z -= 0.01;
      const isAlive = !this.gameOverDispatched && this.health > 0;
      const showHeli = (this.isPaused || this.upgradePaused) && isAlive;
      this.helicopter.mesh.visible = showHeli;
      if (showHeli) {
        this.helicopter.animateRotors(0, 60, delta);
        this.helicopter.updateNavLights(time);
        // Hangar/pause/upgrade idle bob
        this.helicopter.mesh.position.y =
          this.helicopter.body.position.y + Math.sin(time * 1.6) * 0.22;
      }
      this.updateShadowRig();
      this.updateCamera(delta);
      this.syncBlobShadows();
      this.renderFrame();
      return;
    }

    if (!this.gameOverDispatched && this.health > 0) {
      this.helicopter.mesh.visible = true;
    }

    this.hasInputThisFrame = false;
    this.pollGamepad(time, delta);
    this.updateKeyboardMovement(delta);
    // GET READY → 3-2-1-GO → grace shield (and the first-run tutorial, which
    // freezes the countdown until the beats are done or skipped).
    this.updateOpeningSequence(delta);

    // Explicit READY → DASHING → COOLDOWN state machine.
    if (this.dashState === "DASHING") {
      this.dashActiveTimer = Math.max(0, this.dashActiveTimer - delta);
      if (this.dashActiveTimer === 0) {
        this.dashState = "COOLDOWN";
        this.dashCooldownTimer = MOVEMENT_CONFIG.dashCooldown * Math.max(0.45, 1 - this.runUpgrades.dashCooldown * 0.15) * (1 - perkEffect("dash", this.perks.dash));
      } else {
        const progress = 1 - this.dashActiveTimer / MOVEMENT_CONFIG.dashDuration;
        const speedBoost = this.speedBoostTimer > 0 ? MOVEMENT_CONFIG.speedBoostMultiplier : 1;
        const dashSpeed = THREE.MathUtils.lerp(
          MOVEMENT_CONFIG.dashSpeed,
          MOVEMENT_CONFIG.maxHorizontalSpeed * 1.05,
          progress,
        ) * speedBoost;
        this.helicopter.body.velocity.x = this.dashDirection.x * dashSpeed;
        this.helicopter.body.velocity.z = this.dashDirection.z * dashSpeed;
        this.hasInputThisFrame = true;
      }
    } else if (this.dashState === "COOLDOWN") {
      this.dashCooldownTimer = Math.max(0, this.dashCooldownTimer - delta);
      if (this.dashCooldownTimer === 0) this.dashState = "READY";
    }

    // Phase 2: no idle-decay or position-target clamp — movement is
    // velocity-controlled; the body is the source of truth.

    // Fuel drain (afterburner burns much faster; fuel-efficiency upgrade slows it)
    const permanentFuelMult = Math.max(0.7, 1 - this.hangarUpgrades.fuel * 0.06);
    const engineBurnMult = Math.max(0.88, 1 - this.hangarUpgrades.engine * 0.024);
    const fuelEfficiencyMult = Math.max(0.4, 1 - this.runUpgrades.fuelEfficiency * 0.3) * permanentFuelMult * (1 - perkEffect("fuelSaver", this.perks.fuelSaver));
    const burnRate =
      this.fuelDrainPerSecond * fuelEfficiencyMult * engineBurnMult * (this.afterburnerActive ? this.afterburnerDrainPerSecond : 1);
    // Spawn protection (tutorial / countdown / grace) idles the rotors for
    // free — the run must always begin at GO with a full tank.
    if (!this.openingProtected) {
      this.currentFuel = Math.max(0, this.currentFuel - burnRate * delta);
    }
    // One-shot low-resource warnings, re-armed once the resource recovers.
    if (this.isPlaying && this.health > 0) {
      const fuelPct = this.maxFuel > 0 ? this.currentFuel / this.maxFuel : 0;
      if (fuelPct <= 0.2 && !this.lowFuelWarned) {
        this.lowFuelWarned = true;
        this.announce("LOW FUEL", "Find a fuel pickup or extract soon", "#ffbd3f");
        this.audio.playWarning();
      } else if (fuelPct > 0.3) {
        this.lowFuelWarned = false;
      }
      const hullPct = this.maxHealth > 0 ? this.health / this.maxHealth : 0;
      if (hullPct <= 0.3 && !this.lowHullWarned) {
        this.lowHullWarned = true;
        this.announce("HULL CRITICAL", "Evasive action — find repairs", "#ff5d5d");
        this.audio.playWarning();
      } else if (hullPct > 0.45) {
        this.lowHullWarned = false;
      }
    }
    this.afterburnerEffectTimer = Math.max(0, this.afterburnerEffectTimer - delta);
    if (this.afterburnerActive && this.health > 0 && this.afterburnerEffectTimer === 0) {
      this.afterburnerEffectTimer = 0.05;
      const wingX = this.helicopter.body.position.x;
      this.particles.spawnSmoke(wingX - 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
      this.particles.spawnSmoke(wingX + 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
      this.particles.spawnSparks(wingX - 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
      this.particles.spawnSparks(wingX + 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
    }
    // 6d: speed lines — streaks that flash past during afterburner / high speed.
    this.updateSpeedLines(delta, time);
    if (this.currentFuel <= 0 && this.health > 0) {
      this.applyPlayerDamage(8 * delta, "FUEL STARVATION", "COLLISION", time, false);
    }
    this.emitStatsIfChanged();
    this.city.update(this.helicopter.body.position, this.world, delta);
    this.delivery.update(time, delta, this.helicopter.body.position, this.currentWave);
    this.updateMissions(time, delta);
    this.updateDepotService(delta);
    this.updateCountermeasures(delta, time);
    this.updateThreatAndExtraction(delta, time);
    this.updateTurrets(time, delta);
    this.updateCrashSmoke(delta, time);

    // --- Destroyable objectives ---
    const playerX = this.helicopter.body.position.x;
    const playerZ = this.helicopter.body.position.z;
    for (let i = this.objectives.length - 1; i >= 0; i--) {
      const obj = this.objectives[i];
      obj.update(time, delta);
      // Show beacon + label only when near (avoids clutter at distance)
      const dist = obj.distanceTo(playerX, playerZ);
      const showMarker = dist < 260;
      if (obj.beacon) obj.beacon.visible = showMarker;
      if (obj.labelSprite) obj.labelSprite.visible = showMarker;
      if (obj.active && obj.type === ObjectiveType.SAM_SITE) {
        // Spawn protection: SAM sites stay cold (no lock, no launch) until the
        // shield lifts.
        if (!this.openingProtected) {
          const radarSupported = this.objectives.some((radar) =>
            radar.active &&
            radar.type === ObjectiveType.RADAR_TOWER &&
            Math.hypot(radar.position.x - obj.position.x, radar.position.z - obj.position.z) <= 300);
          const result = obj.updateSam(this.helicopter.body.position, time, delta, this.currentWave, {
            radarSupported,
            lockSpeedMultiplier: 1 / this.difficulty.samLock,
          });
          if (result?.beep) this.audio.playSamLockBeep(obj.samLockProgress);
          if (result?.fired) this.launchSamMissile(obj, time);
        }
        if (this.delivery.isCarrying() && dist <= SAM_DETECTION_RANGE) this.delivery.markSamExposure();
        const damageStage = obj.getDamageStage();
        if (damageStage > 0 && obj.damageFxTimer <= 0) {
          const target = obj.targetPoint;
          this.particles.spawnSmoke(target.x, target.y, target.z, time);
          if (damageStage === 2) this.particles.spawnSparks(target.x, target.y, target.z, time);
          obj.damageFxTimer = damageStage === 2 ? 0.16 : 0.38;
        }
      }
      // Cull objectives far behind the player
      if (obj.position.z > playerZ + 120) {
        if (obj.missionTargetId) this.missionManager.reportTargetLost(obj.missionTargetId);
        obj.destroy();
        this.objectives.splice(i, 1);
      }
    }
    // Preserve the battlefield-wide suppression hook while each site now owns
    // its targeting, lock, launch, and reload cadence.
    this.samActive = this.objectives.some((o) => o.active && o.type === ObjectiveType.SAM_SITE);
    this.radarActive = this.objectives.some((o) => o.active && o.type === ObjectiveType.RADAR_TOWER);
    /* Legacy global SAM cadence replaced by per-site state machines.
    if (this.samActive) {
      this.samFireTimer -= delta;
      if (this.samFireTimer <= 0) {
        this.samFireTimer = 2.6;
        const sam = this.objectives.find((o) => o.active && o.type === ObjectiveType.SAM_SITE);
        if (sam) {
          const p = this.helicopter.body.position;
          const dx = p.x - sam.position.x;
          const dz = p.z - sam.position.z;
          const hDist = Math.sqrt(dx * dx + dz * dz) || 1;
          // Range gate: a site hundreds of units away shouldn't lob blind
          // shots across the map — engage inside a useful envelope only.
          if (hDist < 460) {
            const speed = 210;
            const dy = p.y - (sam.position.y + 4);
            this.enemyProjectiles.spawn(
              sam.position.x,
              sam.position.y + 4,
              sam.position.z,
              dx / hDist,
              dz / hDist,
              time,
              speed,
              8,
              0,
              0xff5544,
              { body: this.helicopter.body, active: true }, // homing target
              2.2, // homing strength — tracks, but stays dodgeable
              (dy / hDist) * speed, // initial vertical aim at the player
              0,
            );
            this.audio.playEnemyFire();
          }
        }
      }
    }
    */
    if (this.samSuppressionTimer > 0) {
      this.samSuppressionTimer = Math.max(0, this.samSuppressionTimer - delta);
    }

    this.updateAIDirector(time, delta);

    // Step CombatDirector for attack slot coordination and directional pressure
    const activeEnemyIds = new Set<number>();
    for (const e of this.enemies) {
      if (e.active) activeEnemyIds.add(e.id);
    }
    for (const obj of this.objectives) {
      if (obj.active) activeEnemyIds.add(obj.id);
    }
    this.combatDirector.update(delta, time, this.currentWave, activeEnemyIds, this.isOverdrive);

    // Twin-stick aim has priority on mobile; desktop mouse fire uses auto-lock.
    if (this.rightStick.active) {
      this.updateStickAim();
    } else {
      this.updateAutoAim();
    }
    this.innerRing.rotation.z += 0.05;
    this.outerRing.rotation.z -= 0.02;

    // --- Salvo Cooldown Timer ---
    if (this.salvoCooldownTimer > 0) {
      this.salvoCooldownTimer = Math.max(0, this.salvoCooldownTimer - delta);
    }

    // --- Active Salvo Target Locking ---
    if (this.isPaintingLocks && this.salvoCooldownTimer <= 0) {
      if (time - this.lastLockPaintTime >= this.lockPaintInterval) {
        const target = this.findSalvoTarget(this.aimPoint, this.lockSearchRadius);
        if (target && this.salvoLocks.length < 6) {
          const currentTargetLocks = this.salvoLocks.filter((e) => e === target).length;
          if (currentTargetLocks < 3) {
            this.salvoLocks.push(target);
            this.lastLockPaintTime = time;
            this.audio.playLockBeep();
            this.updateSalvoIndicators(target);
            this.updateUI(time);
          }
        }
      }
    }

    // --- Clean Up Dead Enemies in Salvo Locks (zero-allocation in-place) ---
    let activeLockCount = 0;
    for (let r = 0; r < this.salvoLocks.length; r++) {
      if (this.salvoLocks[r].active) {
        this.salvoLocks[activeLockCount++] = this.salvoLocks[r];
      }
    }
    this.salvoLocks.length = activeLockCount;

    // --- Update Salvo Lock Indicator Visual Positions & Rotations ---
    for (const [enemy, group] of this.salvoLockIndicators.entries()) {
      if (!enemy.active) {
        group.children.forEach((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) {
            if (Array.isArray(mesh.material)) {
              mesh.material.forEach((m) => m.dispose());
            } else {
              mesh.material.dispose();
            }
          }
        });
        this.scene.remove(group);
        this.salvoLockIndicators.delete(enemy);
      } else {
        group.position.copy(enemy.mesh.position);
        group.children.forEach((child, index: number) => {
          const rotationSpeed = 0.06 + index * 0.025;
          const direction = index % 2 === 0 ? 1 : -1;
          child.rotation.z += rotationSpeed * direction;
        });
      }
    }

    // --- Crosshair styling/pulsing during salvo painting ---
    if (this.isPaintingLocks) {
      (this.innerRing.material as THREE.MeshBasicMaterial).color.setHex(0xff3344);
      (this.outerRing.material as THREE.MeshBasicMaterial).color.setHex(0xff3344);
      const scale = 1.0 + Math.sin(time * 15) * 0.15;
      this.targetGroup.scale.set(scale, scale, scale);
    } else {
      (this.innerRing.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      (this.outerRing.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      this.targetGroup.scale.set(1, 1, 1);
    }

    // --- Survival encounter messaging ---
    if (this.waveTransitionTimer > 0) {
      this.waveTransitionTimer -= delta;
      if (this.frameCount % 30 === 0) this.updateUI(time);
    }

    // --- Reload Timer ---
    if (this.isReloading) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) {
        const weapon = this.weapons.get(this.currentWeapon);
        if (weapon) {
          weapon.ammo = weapon.maxAmmo;
          this.isReloading = false;
        }
      }
    }

    // Keep the last finite player position as the NaN-recovery anchor.
    const playerBodyPosition = this.helicopter.body.position;
    if (
      Number.isFinite(playerBodyPosition.x) &&
      Number.isFinite(playerBodyPosition.y) &&
      Number.isFinite(playerBodyPosition.z)
    ) {
      this.movementTarget.set(
        playerBodyPosition.x,
        playerBodyPosition.y,
        playerBodyPosition.z,
      );
    }
    this.helicopter.setAim(this.aimPoint.x, this.aimPoint.z);

    // --- Weather & Environment ---
    this.weather.update(time, delta, this.scene);
    this.rain.update(time, this.helicopter.mesh.position);
    (this.rain.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value =
      time; // redundancy check
    // Pass 8: rain keeps a visibility floor at any storm strength so weather
    // reads, while the cap protects player/enemy silhouettes (additive rain
    // washes contrast fast).
    (this.rain.mesh.material as THREE.ShaderMaterial).opacity =
      0.12 + this.weather.stormIntensity * 0.25;

    if (this.weather.isLightning) {
      this.renderer.setClearColor(0xffffff);

      this.audio.playExplosion(2.0); // Thunder

      // Small EMP damage chance
      if (Math.random() < 0.2) {
        this.applyPlayerDamage(5, "LIGHTNING EMP", "EXPLOSIVE", time);
      }

      if (this.lightningTimeout !== null) {
        window.clearTimeout(this.lightningTimeout);
      }
      this.lightningTimeout = window.setTimeout(() => {
        if (!this.disposed) {
          const fogColor = (this.scene.fog as THREE.FogExp2).color;
          this.renderer.setClearColor(fogColor);
        }
        this.lightningTimeout = null;
      }, 50);
    } else {
      if (this.lightningTimeout === null) {
        const fogColor = (this.scene.fog as THREE.FogExp2).color;
        this.renderer.setClearColor(fogColor);
      }
    }

    // Phase 1 NaN guard: one invalid Vector3 propagates into every body, mesh
    // and camera in the scene and the run is unrecoverable — recover to a safe
    // state (movement target, zero velocity) instead of corrupting the sim.
    const hp = this.helicopter.body.position;
    const hv = this.helicopter.body.velocity;
    if (
      !Number.isFinite(hp.x) || !Number.isFinite(hp.y) || !Number.isFinite(hp.z) ||
      !Number.isFinite(hv.x) || !Number.isFinite(hv.y) || !Number.isFinite(hv.z)
    ) {
      if (import.meta.env.DEV) {
        console.warn(
          "[Heli-Strike] NaN in helicopter body — recovering",
          { pos: [hp.x, hp.y, hp.z], vel: [hv.x, hv.y, hv.z], dt: delta, time },
        );
      }
      hp.set(this.movementTarget.x, this.movementTarget.y, this.movementTarget.z);
      hv.set(0, 0, 0);
      this.helicopter.body.angularVelocity.set(0, 0, 0);
      copyPhysicsPos(this.helicopter.mesh, hp);
    }

    // Apply the controller before the fixed physics step so key presses affect
    // this frame's integration and collision callbacks get the final say on
    // inward wall velocity.
    this.windCannon.set(this.weather.windForce.x, 0, this.weather.windForce.z);
    const hoverFloor = this.city.getHeightAt(
      this.helicopter.body.position.x,
      this.helicopter.body.position.z,
      0.5,
    );
    this.helicopter.setHoverFloor(hoverFloor);
    this.helicopter.update(
      time, delta, this.windCannon, this.particles,
      this.shieldTimer > 0 || this.openingProtected, this.speedBoostTimer > 0, this.hasInputThisFrame,
      {
        // Heading-relative command: x = strafe, z = thrust along heading,
        // y = collective, yaw = rudder (see MovementCommand / FLIGHT_SPEC).
        x: this.keyboardVelocity.x,
        z: this.keyboardVelocity.y,
        y: this.verticalInput,
        yaw: this.yawInput,
        cargoMultiplier: this.delivery.isCarrying()
          ? cargoMovementMultiplier(this.hangarUpgrades.airframe)
          : 1,
      },
    );

    // Rotor downwash kicks dust when flying low over the terrain — height-based
    // vortex scales with ground clearance, and vehicle speed adds trailing drag.
    this.downwashTimer += delta;
    if (this.downwashTimer >= 0.05) {
      this.downwashTimer = 0;
      const heliAlt = hp.y - hoverFloor;
      if (this.health > 0 && heliAlt < 24.0) {
        const strength = THREE.MathUtils.clamp(1.0 - (heliAlt - 6.0) / 18.0, 0.12, 1.0);
        const puffs = heliAlt < 8.0 ? 3 : (heliAlt < 16.0 ? 2 : 1);
        this.particles.spawnRotorDownwash(
          hp.x,
          hoverFloor,
          hp.z,
          hv.x,
          hv.z,
          5.5,
          strength,
          time,
          puffs,
        );
      }

      // Aerial enemy downwash — bounded to nearest low-altitude aircraft
      let droneWashCount = 0;
      for (const e of this.enemies) {
        if (!e.active || (e.type !== EnemyType.DRONE && e.movementClass !== EnemyMovementClass.FLYING) || droneWashCount >= 3) continue;
        const dx = e.body.position.x - hp.x;
        const dz = e.body.position.z - hp.z;
        if (dx * dx + dz * dz > 7200) continue; // within ~85m
        const droneFloor = this.city.getHeightAt(e.body.position.x, e.body.position.z, 0.5);
        const droneAlt = e.body.position.y - droneFloor;
        if (droneAlt < 16.0) {
          droneWashCount++;
          const dStrength = THREE.MathUtils.clamp(1.0 - droneAlt / 16.0, 0.1, 0.55);
          this.particles.spawnRotorDownwash(
            e.body.position.x,
            droneFloor,
            e.body.position.z,
            e.smoothVelX,
            e.smoothVelZ,
            2.6,
            dStrength,
            time,
            1,
          );
        }
      }
    }

    // Aim pivots are now current, so machine-gun shots leave the live muzzle.
    if (
      (this.isFiringMouse || this.isFiringGamepad) &&
      this.health > 0
    ) {
      this.fireWeapons(time);
    }

    this.world.step(1 / 60, delta, 3);

    // Catch solver/contact corruption before enemies, projectiles, or the camera
    // can consume it in this frame.
    const steppedPosition = this.helicopter.body.position;
    const steppedVelocity = this.helicopter.body.velocity;
    if (
      !Number.isFinite(steppedPosition.x) ||
      !Number.isFinite(steppedPosition.y) ||
      !Number.isFinite(steppedPosition.z) ||
      !Number.isFinite(steppedVelocity.x) ||
      !Number.isFinite(steppedVelocity.y) ||
      !Number.isFinite(steppedVelocity.z)
    ) {
      steppedPosition.set(
        this.movementTarget.x,
        this.movementTarget.y,
        this.movementTarget.z,
      );
      steppedVelocity.set(0, 0, 0);
      this.helicopter.body.angularVelocity.set(0, 0, 0);
    }

    // World-bound clamp (the city scrolls forever in z; x has a hard boundary).
    const bx = this.helicopter.body.position.x;
    const bound = MOVEMENT_CONFIG.worldBoundX;
    if (bx > bound) {
      this.helicopter.body.position.x = bound;
      if (this.helicopter.body.velocity.x > 0) this.helicopter.body.velocity.x = 0;
    } else if (bx < -bound) {
      this.helicopter.body.position.x = -bound;
      if (this.helicopter.body.velocity.x < 0) this.helicopter.body.velocity.x = 0;
    }
    // Strict altitude envelope after the physics step (ground cushion 2.4 m /
    // ceiling 26 m above the underlying surface — see FLIGHT_SPEC).
    const heliY = this.helicopter.body.position.y;
    const yMin = hoverFloor + FLIGHT_SPEC.groundCushion;
    const yMax = hoverFloor + FLIGHT_SPEC.ceiling;
    if (heliY < yMin) {
      this.helicopter.body.position.y = yMin;
      if (this.helicopter.body.velocity.y < 0) this.helicopter.body.velocity.y = 0;
    } else if (heliY > yMax) {
      this.helicopter.body.position.y = yMax;
      if (this.helicopter.body.velocity.y > 0) this.helicopter.body.velocity.y = 0;
    }
    this.helicopter.syncBodyTransform();

    // --- Procedural Rotor Downwash (Desert Dust) ---
    if (this.city && this.particles) {
      const pPos = this.helicopter.body.position;
      const pVel = this.helicopter.body.velocity;
      const pFloor = this.city.getHeightAt(pPos.x, pPos.z, 1.2);
      const pAltitudeAGL = pPos.y - pFloor;
      if (pAltitudeAGL > 0 && pAltitudeAGL <= 14.0) {
        const pStrength = Math.min(1.0, Math.max(0.0, 1.0 - pAltitudeAGL / 14.0));
        const pCount = Math.ceil(pStrength * 2);
        this.particles.spawnRotorDownwash(
          pPos.x,
          pFloor,
          pPos.z,
          pVel.x,
          pVel.z,
          3.2,
          pStrength,
          time,
          pCount,
        );
      }

      // Air Enemies downwash (up to 2 nearest within 80u)
      let enemyEmitters = 0;
      for (const e of this.enemies) {
        if (!e.active || e.type !== EnemyType.DRONE || e.isDying) continue;
        const eDistSq = (e.body.position.x - pPos.x) ** 2 + (e.body.position.z - pPos.z) ** 2;
        if (eDistSq > 6400) continue; // 80u max
        const eFloor = this.city.getHeightAt(e.body.position.x, e.body.position.z, 1.0);
        const eAlt = e.body.position.y - eFloor;
        if (eAlt > 0 && eAlt <= 14.0) {
          const eStrength = Math.min(1.0, Math.max(0.0, 1.0 - eAlt / 14.0));
          this.particles.spawnRotorDownwash(
            e.body.position.x,
            eFloor,
            e.body.position.z,
            e.smoothVelX,
            e.smoothVelZ,
            2.6,
            eStrength * 0.85,
            time,
            1,
          );
          enemyEmitters++;
          if (enemyEmitters >= 2) break;
        }
      }
    }

    // Engine sound based on speed
    const currentSpeed = Math.sqrt(
      this.helicopter.body.velocity.x ** 2 +
        this.helicopter.body.velocity.z ** 2,
    );
    this.audio.updateEngine(Math.min(1.0, currentSpeed / 60), 10);

    // --- Enemy Logic ---
    const fireSilenced = this.enemyFireSilenced();
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.active) {
        this.releaseShieldAuras(e);
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }
      // Phase 1 NaN guard: an invalid enemy body corrupts every system that
      // reads it (boids, homing missiles, avoidance) — drop it cleanly.
      if (
        !Number.isFinite(e.body.position.x) ||
        !Number.isFinite(e.body.position.y) ||
        !Number.isFinite(e.body.position.z) ||
        !Number.isFinite(e.body.velocity.x) ||
        !Number.isFinite(e.body.velocity.y) ||
        !Number.isFinite(e.body.velocity.z)
      ) {
        if (import.meta.env.DEV) {
          console.warn(
            "[Heli-Strike] NaN in enemy body — removing",
            { type: e.type, pos: [e.body.position.x, e.body.position.y, e.body.position.z] },
          );
        }
        if (e.missionTargetId) this.missionManager.reportTargetLost(e.missionTargetId);
        this.releaseShieldAuras(e);
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }
      if (
        e.body.position.z > this.helicopter.body.position.z + 165 ||
        e.body.position.z < this.helicopter.body.position.z - 320
      ) {
        if (e.missionTargetId) this.missionManager.reportTargetLost(e.missionTargetId);
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }

      // B1: burn DoT + status timestamps tick every frame for every enemy.
      e.tickStatusEffects(time, delta);
      if (!e.active) {
        if (e.isDying) {
          const finished = e.updateDeathSpiral(delta, this.city, time, this.particles);
          if (finished || e.readyForRemoval) {
            const crashFloor = this.city ? this.city.getHeightAt(e.body.position.x, e.body.position.z, 0.8) : 0;
            const crashY = Math.max(crashFloor, e.body.position.y);
            this.particles.spawnExplosion(e.body.position.x, crashY, e.body.position.z, 75, time, 28);
            this.particles.spawnDebris(e.body.position.x, crashY, e.body.position.z, time, 12, 22);
            this.particles.spawnSparks(e.body.position.x, crashY, e.body.position.z, time, 6, 16);
            this.particles.spawnRotorDownwash(e.body.position.x, crashFloor, e.body.position.z, 0, 0, 4.5, 1.4, time, 4);
            this.volumetricExplosions.spawn(e.body.position.x, crashY, e.body.position.z, 16, 6);
            this.audio.playExplosion(1.1);

            // Drop crash loot at the ground impact location
            const enemyXp = xpForEnemyType(e.type, e.isElite, e.variant);
            this.dropXpGem(e.body.position.x, crashY, e.body.position.z, enemyXp);
            this.dropEnemyLoot(e);

            this.releaseShieldAuras(e);
            e.destroy();
            this.enemies.splice(i, 1);
          }
          continue;
        }
        if (e.diedFromStatus) {
          this.onEnemyDestroyed(e, time);
        } else {
          this.releaseShieldAuras(e);
          e.destroy();
          this.enemies.splice(i, 1);
        }
        continue;
      }

      // Air enemy close fly-by feedback (play both turbine whine & whoosh, reset on separation)
      if ((e.type === EnemyType.DRONE || e.movementClass === EnemyMovementClass.FLYING) && !e.flybyTriggered) {
        const eSpeed = Math.hypot(e.smoothVelX, e.smoothVelZ);
        if (eSpeed >= 28) {
          const pDist = Math.hypot(e.body.position.x - this.helicopter.body.position.x, e.body.position.z - this.helicopter.body.position.z);
          if (pDist < 18.0) {
            e.flybyTriggered = true;
            const pan = (e.body.position.x - this.helicopter.body.position.x) / 18.0;
            this.audio.playFlyby(eSpeed, pan);
            this.audio.playDroneFlyby(pDist);
          }
        }
      } else if (e.flybyTriggered) {
        const pDist = Math.hypot(e.body.position.x - this.helicopter.body.position.x, e.body.position.z - this.helicopter.body.position.z);
        if (pDist > 32.0) {
          e.flybyTriggered = false;
        }
      }

      // 3d: distance-based culling — skip expensive AI/visual updates for
      // enemies far from the player. They still exist (collision, death)
      // but don't run direction updates, status-drip particles, or firing.
      const eDx = e.body.position.x - this.helicopter.body.position.x;
      const eDz = e.body.position.z - this.helicopter.body.position.z;
      const eDistSq = eDx * eDx + eDz * eDz;
      if (eDistSq > 280 * 280) {
        // Far away — skip the expensive updateDirection + visual effects.
        // Bosses always update (they have unique phase logic).
        if (e.type !== EnemyType.BOSS) continue;
      }
      // B1: status drips — sparks while burning, smoke crackle while shocked.
      if (this.frameCount % 6 === 0) {
        if (e.isBurning(time)) {
          this.particles.spawnSparks(e.body.position.x, e.body.position.y, e.body.position.z, time, 1, 14);
        } else if (e.isShocked(time)) {
          this.particles.spawnSmoke(e.body.position.x, e.body.position.y + 1, e.body.position.z, time);
        }
      }

      // SAM sites boost enemy fire rate; destruction suppresses it. The
      // difficulty fire-interval multiplier applies exactly once, here.
      const radarAcquisitionMult = this.radarActive ? 0.9 : 1;
      const enemyFireRateMult = (this.samActive && !this.samSuppressionTimer
        ? 0.72
        : this.samSuppressionTimer > 0
          ? 1.7
          : 1.0) * radarAcquisitionMult * this.difficulty.enemyFireInterval;
      // Opening protection / wave-1 quiet window: pin the shot clock so every
      // enemy weapon gate stays closed until the player is fair game.
      if (fireSilenced) e.lastShotTime = time;
      const prevPhase = e.phase;
      const fired = e.updateDirection(
        this.helicopter.body.position,
        time,
        this.enemyProjectiles,
        this.playerProjectiles.pool,
        this.enemies,
        this.city,
        enemyFireRateMult,
        delta,
        undefined,
        this.helicopter.body.velocity,
        this.combatDirector,
        this.currentWave,
        this.threatLevel,
        this.isOverdrive,
        this.overdriveMultiplier,
        this.enemies.some((en) => en.type === EnemyType.BOSS && en.active),
      );
      // Only announce when the boss LOSES a phase (never on spawn)
      if (e.type === EnemyType.BOSS && e.phase < prevPhase) {
        this.announce(
          e.phase === 2 ? "PHASE 2" : "FINAL PHASE",
          e.phase === 2 ? "New attack pattern" : "Telegraphed beam volleys",
          "#ff3366",
        );
        this.audio.playUpgrade();
        this.addCameraImpulse(2.0); // boss phase slam
        this.triggerHitStop(0.2, 0.4);
      }
      // Boss progressive visual damage feedback (100-66% clean, 66-33% left engine, <33% critical)
      if (e.type === EnemyType.BOSS && e.active) {
        const hpRatio = e.hp / Math.max(1, e.maxHp);
        // 66% - 33%: Left engine smoking and sparking
        if (hpRatio <= 0.66 && e.damagePoints?.engineLeft && this.frameCount % 4 === 0) {
          const pt = GameEngine._scratchVec3;
          e.damagePoints.engineLeft.getWorldPosition(pt);
          this.particles.spawnSmoke(pt.x, pt.y, pt.z, time);
          if (Math.random() < 0.35) {
            this.particles.spawnSparks(pt.x, pt.y, pt.z, time, 2, 10);
          }
        }
        // < 33%: Both engines heavily smoking + hull electrical arcs + core instability
        if (hpRatio <= 0.33) {
          if (e.damagePoints?.engineRight && this.frameCount % 4 === 2) {
            const pt = GameEngine._scratchVec3;
            e.damagePoints.engineRight.getWorldPosition(pt);
            this.particles.spawnSmoke(pt.x, pt.y, pt.z, time);
            if (Math.random() < 0.45) {
              this.particles.spawnSparks(pt.x, pt.y, pt.z, time, 3, 12);
            }
          }
          if (e.damagePoints?.hull && this.frameCount % 5 === 0) {
            const pt = GameEngine._scratchVec3;
            e.damagePoints.hull.getWorldPosition(pt);
            this.particles.spawnSparks(pt.x, pt.y, pt.z, time, 3, 14);
            this.particles.spawnElectricalArc(pt.x, pt.y, pt.z, time, 2, 16);
          }
          if (e.coreGlowMesh) {
            const flicker = 0.3 + (Math.sin(time * 30) > 0 ? 0.7 : 0.1) * (Math.random() > 0.3 ? 1 : 0.3);
            (e.coreGlowMesh.material as THREE.MeshBasicMaterial).opacity = flicker;
          }
        } else if (e.coreGlowMesh) {
          (e.coreGlowMesh.material as THREE.MeshBasicMaterial).opacity = 0.75 + Math.sin(time * 4) * 0.2;
        }
      }
      if (fired && time - this.lastEnemyFireSoundTime >= 0.15) {
        if (e.type === EnemyType.TANK) {
          const pan = (e.body.position.x - this.helicopter.body.position.x) / 40.0;
          this.audio.playTankCannon(pan);
        } else {
          this.audio.playEnemyFire();
        }
        this.lastEnemyFireSoundTime = time;
      }

      // Ramming Check (Kamikaze) — never while spawn protection is up.
      if (
        e.body.position.distanceSquared(this.helicopter.body.position) < 25 &&
        this.health > 0 &&
        !this.openingProtected
      ) {
        e.active = false;
        this.particles.spawnExplosion(
          e.body.position.x,
          this.helicopter.body.position.y,
          e.body.position.z,
          80,
          time,
          30,
        );
        this.audio.playExplosion(1.5);
        this.addCameraImpulse(2.5); // kamikaze ram — heavy hit

        // Tanks do massive ram damage
        const dmg = e.type === EnemyType.TANK ? 30 : 10;
        if (this.dashActiveTimer <= 0) {
          const rdx = this.helicopter.body.position.x - e.body.position.x;
          const rdz = this.helicopter.body.position.z - e.body.position.z;
          const rdl = Math.hypot(rdx, rdz);
          this.applyPlayerDamage(
            dmg,
            e.variant === EnemyVariant.KAMIKAZE_DRONE ? "KAMIKAZE" : "RAM",
            "COLLISION", time, true,
            rdl > 0.001 ? { x: rdx / rdl, z: rdz / rdl } : undefined,
          );
        }
        this.updateUI(time);
      }
    }

    // --- Projectile Physics ---
    this.playerProjectiles.updatePositions(time, delta, this.particles);
    this.enemyProjectiles.updatePositions(time, delta, this.particles);

    for (const proj of this.playerProjectiles.pool) {
      if (!proj.active) continue;
      const hitBlock = this.city.damageProjectilePath(
        proj.prevPos,
        proj.pos,
        proj.damage * (proj.blastRadius > 0 ? 1.2 : 0.55),
      );
      if (!hitBlock) continue;

      if (proj.blastRadius === 0) {
        // Machine gun ricochet sparks
        for (let s = 0; s < 3; s++) this.particles.spawnSparks(proj.pos.x, proj.pos.y, proj.pos.z, time);
      } else {
        // High explosive detonation
        this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 38, time, 22);
        this.volumetricExplosions.spawn(proj.pos.x, proj.pos.y, proj.pos.z, 8, proj.blastRadius * 0.35);
        this.city.damageNearby(proj.pos.x, proj.pos.z, proj.blastRadius, proj.damage * 0.85);
      }
      if (proj.blastRadius > 0 || time - this.lastBuildingHitSoundTime >= 0.20) {
        this.audio.playExplosion(proj.blastRadius > 0 ? 0.65 : 0.16);
        if (proj.blastRadius <= 0) {
          this.lastBuildingHitSoundTime = time;
        }
      }
      proj.deactivate();
    }

    const playerProjPos = this.helicopter.body.position;
    const camFwd = GameEngine._scratchCamFwd;
    this.camera.getWorldDirection(camFwd);
    camFwd.y = 0;
    if (camFwd.lengthSq() < 0.0001) camFwd.set(0, 0, -1);
    else camFwd.normalize();
    const camRight = GameEngine._scratchCamRight;
    camRight.crossVectors(camFwd, this.worldUp).normalize();

    for (const proj of this.enemyProjectiles.pool) {
      if (!proj.active) continue;

      // Near-Miss Detection: triggers subtle whoosh & vapor streak when high-danger projectile narrowly misses
      if (!proj.nearMissTriggered) {
        const dx = proj.pos.x - playerProjPos.x;
        const dy = proj.pos.y - playerProjPos.y;
        const dz = proj.pos.z - playerProjPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        // Detection bubble: 5.5u to 14.0u (30.25 to 196 sq)
        if (distSq > 30.25 && distSq <= 196.0) {
          proj.nearMissTriggered = true;
          const pan = (camRight.x * dx + camRight.z * dz) / 14.0;
          this.audio.playNearMiss(pan);
          if (proj.vel) {
            this.particles.spawnNearMissStreak(proj.pos.x, proj.pos.y, proj.pos.z, proj.vel.x, proj.vel.y, proj.vel.z, time);
          }
        }
      }

      const hitBlock = this.city.damageProjectilePath(
        proj.prevPos,
        proj.pos,
        18,
      );
      if (!hitBlock) continue;
      this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 10, time, 8);
      this.volumetricExplosions.spawn(proj.pos.x, proj.pos.y, proj.pos.z, 3, 2.0);
      proj.deactivate();
    }

    // --- Objective hits ---
    this.playerProjectiles.checkObjectiveHits(this.objectives, (proj, obj) => {
      this.shotsHit++;
      const affinityDmg = calculateDamageAffinity(this.currentWeapon, 'STRUCTURE', proj.damage);
      const objDmg = affinityDmg * (proj.blastRadius > 0 ? 1.1 : 1.0);
      const destroyed = obj.takeDamage(objDmg);
      this.floatingCombatText.spawnDamage(obj.id, proj.pos, objDmg, 'NORMAL', time);
      this.hitMarkerTimer = 0.12;
      this.hitMarkerPosition.set(obj.targetPoint.x, obj.targetPoint.y, obj.targetPoint.z);
      this.particles.spawnSparks(proj.pos.x, proj.pos.y, proj.pos.z, time);
      if (proj.blastRadius > 0) this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 14, time, 9);
      this.audio.playHit();
      if (destroyed) {
        this.destroyObjective(obj, time);
      }
    });

    // --- Rooftop turret hits ---
    this.playerProjectiles.checkTurretHits(this.city.turrets, (proj, turret) => {
      this.shotsHit++;
      const turretDmg = calculateDamageAffinity(this.currentWeapon, 'STRUCTURE', proj.damage);
      const destroyed = turret.takeDamage(turretDmg);
      this.floatingCombatText.spawnDamage(null, proj.pos, turretDmg, 'NORMAL', time);
      this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 14, time, 9);
      if (destroyed) {
        this.score += Math.floor(turret.basePoints * this.comboMultiplier);
        this.particles.spawnExplosion(
          turret.position.x,
          turret.position.y + 1,
          turret.position.z,
          90,
          time,
          26,
        );
        this.volumetricExplosions.spawn(turret.position.x, turret.position.y + 1, turret.position.z, 10, 4);
        this.audio.playExplosion(0.7);
        this.updateUI(time);
      }
    });

    this.playerProjectiles.checkEnemyHits(this.enemies, (proj, enemy) => {
      this.shotsHit++;
      // C6: mod damage bonuses against favored hull types + damage affinities
      const targetCategory: TargetCategory = enemy.type === EnemyType.BOSS
        ? 'BOSS_CORE'
        : enemy.type === EnemyType.DRONE
        ? 'AIR'
        : enemy.type === EnemyType.TANK
        ? 'ARMORED'
        : 'LIGHT';
      const affinityDmg = calculateDamageAffinity(this.currentWeapon, targetCategory, proj.damage);
      let totalDmg = affinityDmg * this.comboMultiplier;
      if (proj.piercing && (enemy.type === EnemyType.TANK || enemy.type === EnemyType.BOSS)) totalDmg *= 1.35;
      if (proj.shaped && (enemy.type === EnemyType.BOSS || enemy.isElite)) totalDmg *= 1.45;
      const isShielded = enemy.shieldHp > 0;
      const result = enemy.takeDamage(totalDmg, time);
      const died = result === "destroyed";
      // B1/C6: status procs from mods + run upgrades + proc perks
      this.tryApplyStatusProc(proj, enemy, time);

      let dmgType: CombatTextType = 'NORMAL';
      if (isShielded || result === 'shield-broken') {
        dmgType = 'SHIELD';
      } else if (totalDmg >= 75 || proj.blastRadius > 0) {
        dmgType = 'HEAVY';
      } else if (proj.piercing || proj.shaped || this.comboMultiplier >= 3) {
        dmgType = 'CRITICAL';
      }
      this.floatingCombatText.spawnDamage(enemy.id, proj.pos, totalDmg, dmgType, time);
      this.hitMarkerTimer = 0.10;
      this.hitMarkerPosition.set(proj.pos.x, proj.pos.y, proj.pos.z);

      if (proj.blastRadius > 0) {
        this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 16, time, 10);
        this.volumetricExplosions.spawn(proj.pos.x, proj.pos.y, proj.pos.z, 6, 3.5);
        this.audio.playExplosion(0.3);
      } else {
        // Bullet hit on enemy: sparks + lightweight audio feedback
        this.particles.spawnSparks(proj.pos.x, proj.pos.y, proj.pos.z, time);
        this.audio.playHit();
      }

      if (result === "shield-broken") {
        this.particles.spawnExplosion(
          enemy.body.position.x,
          enemy.body.position.y,
          enemy.body.position.z,
          50,
          time,
          18,
        );
        this.audio.playUpgrade();
      }

      if (proj.blastRadius > 0) {
        for (const nearby of this.enemies) {
          if (!nearby.active || nearby === enemy) continue;
          const dx = nearby.body.position.x - proj.pos.x;
          const dz = nearby.body.position.z - proj.pos.z;
          const dy = Math.abs(nearby.body.position.y - proj.pos.y);
          const radiusSq = proj.blastRadius * proj.blastRadius;
          if (dx * dx + dz * dz < radiusSq && dy < 32) {
            // B1: guaranteed-proc mods (EMP warheads) disable everything in the blast
            if (proj.procKind && proj.procChance >= 1) nearby.applyStatus(proj.procKind, time);
            const r = nearby.takeDamage(totalDmg * 0.55, time);
            this.floatingCombatText.spawnDamage(nearby.id, nearby.body.position, totalDmg * 0.55, 'HEAVY', time);
            if (r === "destroyed") {
              this.onEnemyDestroyed(nearby, time);
            }
          }
        }
        this.city.damageNearby(proj.pos.x, proj.pos.z, proj.blastRadius * 0.9, totalDmg);
        // C6: cluster warheads split into 3 mini-blasts around the impact
        if (proj.cluster) this.spawnClusterBlasts(proj.pos.x, proj.pos.y, proj.pos.z, totalDmg, time);
        // A3: explosion knockback shoves the helicopter away from the blast
        this.addExplosionImpulse(proj.pos.x, proj.pos.y, proj.pos.z, 1.2, proj.blastRadius * 2.5);
      }

      // Update combo
      this.comboCount++;
      this.comboTimer = 3.0;
      this.comboMultiplier = comboMultiplier(this.comboCount); // Cap at 6x
      this.maxCombo = Math.max(this.maxCombo, this.comboCount);

      if (died) {
        this.onEnemyDestroyed(enemy, time);
      }
    });

    this.enemyProjectiles.checkPlayerHits(
      this.helicopter.body.position,
      (proj) => {
        if (this.health > 0) {
          // Shield, dash or spawn protection blocks damage through the central
          // pipeline — the shot still splashes visibly on the bubble.
          if (this.shieldTimer > 0 || this.dashActiveTimer > 0 || this.openingProtected) {
            this.particles.spawnExplosion(
              proj.pos.x,
              proj.pos.y,
              proj.pos.z,
              20,
              time,
              15,
            );
            return;
          }
          // Respect each shot's real damage (turret 6, boss volley 8, artillery 16)
          const dmg = Math.round(proj.damage * this.difficulty.enemyDamage * (proj.waveDamageMult ?? 1));
          const damageType: PlayerDamageType = proj.kind === "SAM_MISSILE"
            ? "MISSILE"
            : proj.blastRadius > 0 ? "EXPLOSIVE" : "BULLET";
          // The shot flies AT the player, so the shooter sits opposite its velocity.
          const vLen = Math.hypot(proj.vel.x, proj.vel.z);
          const applied = this.applyPlayerDamage(
            dmg,
            proj.kind === "SAM_MISSILE" ? "SAM MISSILE" : "ENEMY PROJECTILE",
            damageType, time, true,
            vLen > 0.001 ? { x: -proj.vel.x / vLen, z: -proj.vel.z / vLen } : undefined,
          );
          // B2: vampiric enemies feed on confirmed damage
          if (applied > 0) this.healVampiricEnemies(applied, time);
          this.particles.spawnExplosion(
            proj.pos.x,
            proj.pos.y,
            proj.pos.z,
            30,
            time,
            20,
          );
        }
      },
    );

    // --- Combo Timer ---
    if (this.comboTimer > 0) {
      this.comboTimer -= delta;
      if (this.comboTimer <= 0) {
        this.comboCount = 0;
        this.comboMultiplier = 1;
      }
    }

    // B3: Devastation overcharge expiry announcement
    if (this.superActiveUntil > 0 && time >= this.superActiveUntil) {
      this.superActiveUntil = 0;
      this.announce("OVERCHARGE SPENT", "Devastation recharging", "#ff88aa");
    }

    // --- Update Power-ups ---
    const playerPos = this.helicopter.mesh.position;
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pu = this.powerups[i];

      // Magnet: XP gems, Salvage, Flares & Caches drift toward the player with distance-based acceleration
      if (
        pu.type === PowerUpType.XP_GEM ||
        pu.type === PowerUpType.SALVAGE ||
        pu.type === PowerUpType.COUNTERMEASURE ||
        pu.type === PowerUpType.SALVAGE_CACHE
      ) {
        const dx = playerPos.x - pu.mesh.position.x;
        const dz = playerPos.z - pu.mesh.position.z;
        const dist = Math.hypot(dx, dz);
        const isMagnetSurge = this.magnetSurgeTimer > 0;
        const baseMagnetRadius = 24 * (1 + this.runUpgrades.xpMagnet * 0.3) * (1 + perkEffect("magnet", this.perks.magnet));
        const magnetRadius = isMagnetSurge ? Math.max(75, baseMagnetRadius * 2.8) : baseMagnetRadius;

        if (dist > 0.1 && dist < magnetRadius) {
          const t = Math.max(0, 1 - dist / magnetRadius);
          // Distance-accelerated velocity: builds speed from 38 up to 140 u/s smoothly
          const targetSpeed = 38 + t * t * 115;
          const targetVx = (dx / dist) * targetSpeed;
          const targetVz = (dz / dist) * targetSpeed;
          const accelAlpha = 1 - Math.exp(-9.0 * delta);
          pu.velocity.x += (targetVx - pu.velocity.x) * accelAlpha;
          pu.velocity.z += (targetVz - pu.velocity.z) * accelAlpha;

          pu.position.x += pu.velocity.x * delta;
          pu.position.z += pu.velocity.z * delta;
        } else {
          pu.velocity.multiplyScalar(Math.exp(-4.0 * delta));
          pu.position.x += pu.velocity.x * delta;
          pu.position.z += pu.velocity.z * delta;
        }
      }

      pu.update(time, delta);

      const tooFar = Math.hypot(pu.mesh.position.x - playerPos.x, pu.mesh.position.z - playerPos.z) > 520;

      if (!pu.active || tooFar) {
        pu.destroy(this.scene);
        this.powerups.splice(i, 1);
        continue;
      }

      // Check collection
      if (pu.checkCollection(playerPos)) {
        if (pu.type === PowerUpType.XP_GEM) {
          this.grantRunXp(pu.value, time);
          this.floatingCombatText.spawnReward(playerPos, `+${pu.value} XP`, 'XP', undefined, pu.value, time);
          this.audio.playPickup();
        } else if (pu.type === PowerUpType.SALVAGE) {
          this.addSalvage(pu.value);
          this.floatingCombatText.spawnReward(playerPos, `+${pu.value} SALVAGE`, 'SALVAGE', undefined, pu.value, time);
          this.audio.playPickup();
        } else if (pu.type === PowerUpType.COUNTERMEASURE) {
          this.countermeasures.replenish(1);
          this.floatingCombatText.spawnReward(playerPos, "+1 FLARE", "CREDITS", "#ffe66d", 1, time);
          this.audio.playPickup();
        } else if (pu.type === PowerUpType.SALVAGE_CACHE) {
          const val = pu.value || 8;
          this.addSalvage(val);
          this.score += 250;
          this.floatingCombatText.spawnReward(playerPos, `+${val} CACHE SALVAGE`, 'SALVAGE', '#ffd700', val, time);
          this.audio.playPowerUpSting('SALVAGE_CACHE');
        } else {
          this.applyPowerUp(pu.type, time);
        }
        pu.destroy(this.scene);
        this.powerups.splice(i, 1);
      }
    }

    // --- Power-up Timers ---
    if (this.damageBoostTimer > 0) {
      this.damageBoostTimer -= delta;
      if (this.damageBoostTimer <= 0) {
        for (const [wType, config] of this.weapons.entries()) {
          config.damage = WEAPON_CONFIGS[wType].damage;
        }
      }
    }
    if (this.shieldTimer > 0) {
      this.shieldTimer -= delta;
    }
    if (this.speedBoostTimer > 0) {
      this.speedBoostTimer -= delta;
      if (this.speedBoostTimer <= 0) {
        // Reset speed - handled in helicopter update
      }
    }
    if (this.magnetSurgeTimer > 0) {
      this.magnetSurgeTimer -= delta;
    }

    if (this.health <= 0) {
      this.dispatchGameOver(time);
    }

    if (this.postBossDecisionPending && time >= this.postBossDecisionTimer) {
      this.postBossDecisionPending = false;
      this.postBossDecisionAvailable = true;
      window.dispatchEvent(
        new CustomEvent("helistrike:post-boss-decision", {
          detail: {
            credits: this.delivery.credits,
            salvage: this.runSalvage,
            score: this.score,
            kills: this.totalKills,
            wave: this.currentWave,
            overdriveMultiplier: 1.25,
          },
        }),
      );
    }

    this.particles.update(time);
    this.volumetricExplosions.update(delta);
    this.debris?.update(time);
    this.shockwaves?.update(time);
    this.floatingCombatText.update(delta);
    this.updateNightOps(time, delta);
    this.updateThemeGrading(delta);

    // Update UI every and radar every frame for smoothness
    this.updateUI(time);

    this.updateShadowRig();
    this.updateCamera(delta);

    this.syncBlobShadows();
    this.tickErrorCount = 0; // reset on successful frame
    this.renderFrame();

    } catch (err) {
      // Error boundary: log the exception but keep the rAF loop alive so the
      // game doesn't permanently freeze from a transient runtime error.
      // Track consecutive errors to prevent infinite error-spam loops.
      this.tickErrorCount = (this.tickErrorCount ?? 0) + 1;
      console.error('[HeliStrike] Tick error:', err);
      if (this.tickErrorCount > 60) {
        console.error('[HeliStrike] Too many consecutive tick errors — stopping render loop');
        this.running = false;
      }
    }
  };

  /** Bounded camera-shake impulse — the settings-gated jitter is applied
   *  around baseCamPos in updateCamera and decays quickly. */
  private cameraShakeAmp = 0;

  addCameraImpulse(strength: number) {
    if (this.settings.screenShake === 'off') return;
    this.cameraShakeAmp = Math.min(1.6, this.cameraShakeAmp + Math.max(0, strength) * 0.22);
  }

  /** 6d: speed lines — thin white streaks that spawn at the screen edges and
   *  rush past the camera during afterburner or high speed. */
  private updateSpeedLines(delta: number, _time: number) {
    const speed = Math.hypot(this.helicopter.body.velocity.x, this.helicopter.body.velocity.z);
    const active = this.afterburnerActive || speed > 55;
    this.speedLineTimer = Math.max(0, this.speedLineTimer - delta);
    // Spawn a new line every ~40ms when active.
    if (active && this.speedLineTimer <= 0 && this.health > 0) {
      this.speedLineTimer = 0.04;
      // Find an inactive line to recycle.
      for (const line of this.speedLines) {
        if (line.visible) continue;
        line.visible = true;
        const mat = line.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.55 + Math.random() * 0.35;
        // Spawn in a ring around the camera, slightly ahead.
        const angle = Math.random() * Math.PI * 2;
        const radius = 12 + Math.random() * 20;
        line.position.set(
          this.camera.position.x + Math.cos(angle) * radius,
          this.camera.position.y - 4 + Math.random() * 8,
          this.camera.position.z - 15 + Math.sin(angle) * radius,
        );
        // Orient line to point backward (along -Z of camera).
        line.rotation.set(0, 0, 0);
        // Store spawn time in userData for fade.
        line.userData.life = 0.3 + Math.random() * 0.2;
        line.userData.maxLife = line.userData.life;
        break;
      }
    }
    // Update visible lines: fade out and move backward.
    for (const line of this.speedLines) {
      if (!line.visible) continue;
      line.userData.life -= delta;
      if (line.userData.life <= 0) {
        line.visible = false;
        continue;
      }
      const mat = line.material as THREE.MeshBasicMaterial;
      const lifeRatio = line.userData.life / line.userData.maxLife;
      mat.opacity = lifeRatio * 0.6;
      // Streak backward relative to camera.
      line.position.z -= (55 + speed * 0.4) * delta;
    }
  }

  /** C4: a volatile street prop cooked off — blast hurts enemies and the hull.
   *  During chain-reactions multiple props detonate in one frame; audio is
   *  deduplicated and the UI update is skipped (the tick loop handles it). */
  private explodeVolatileProp(x: number, z: number) {
    const time = performance.now() / 1000;
    this.particles.spawnExplosion(x, 3, z, this.fxCount(70), time, 24);
    this.volumetricExplosions.spawn(x, 3, z, 14, 6);
    this.shockwaves?.spawn(x, 0.5, z, time, 26, 0xff9a3d, 0.7);
    // Dedup audio: only play if no prop explosion sound in the last 0.08s.
    if (time - this.lastPropExplosionSoundTime >= 0.08) {
      this.audio.playExplosion(1.2);
      this.lastPropExplosionSoundTime = time;
    }
    this.addExplosionImpulse(x, 3, z, 2.2, 48);
    const radiusSq = 22 * 22;
    for (const e of this.enemies) {
      if (!e.active) continue;
      const dx = e.body.position.x - x;
      const dz = e.body.position.z - z;
      const distSq = dx * dx + dz * dz;
      if (distSq > radiusSq) continue;
      const falloff = 1 - Math.sqrt(distSq) / 22;
      if (e.takeDamage(34 * falloff, time) === "destroyed") this.onEnemyDestroyed(e, time);
    }
    // The hull isn't immune to friendly infrastructure cooking off nearby.
    const pdx = this.helicopter.body.position.x - x;
    const pdz = this.helicopter.body.position.z - z;
    const pDistSq = pdx * pdx + pdz * pdz;
    if (pDistSq <= radiusSq && this.isPlaying && this.health > 0 && this.superActiveUntil <= time) {
      const falloff = 1 - Math.sqrt(pDistSq) / 22;
      this.applyPlayerDamage(10 * falloff, "VOLATILE PROP", "EXPLOSIVE", time, false);
    }
    // No per-detonation updateUI — the tick loop calls it every frame.
  }

  /** C3: ease the world between day and the deep-navy night rig. */
  private updateNightOps(time: number, delta: number) {
    if (this.nightBlend !== this.nightBlendTarget) {
      const step = delta / 2.4; // ~2.4s full transition
      this.nightBlend = this.nightBlendTarget > this.nightBlend
        ? Math.min(this.nightBlendTarget, this.nightBlend + step)
        : Math.max(this.nightBlendTarget, this.nightBlend - step);
      this.applyNightPalette(this.nightBlend);
    }
    if (this.nightBeams) {
      const visible = this.nightBlend > 0.4;
      this.nightBeams.visible = visible;
      if (visible) {
        // Keep the sweep anchored ahead of the player as the city streams by.
        const heli = this.helicopter.body.position;
        this.nightBeams.position.set(0, 0, heli.z - 120);
        for (let i = 0; i < this.nightBeams.children.length; i++) {
          this.nightBeams.children[i].rotation.y = time * (0.35 + i * 0.09) + i * 2.1;
        }
      }
    }
  }

  private applyNightPalette(t: number) {
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.dayFogColor).lerp(this.nightFogColor, t);
    (this.scene.background as THREE.Color).copy(this.daySkyColor).lerp(this.nightSkyColor, t);
    this.renderer.setClearColor(fog.color);
    this.ambientLight.color.copy(this.dayHemiSky).lerp(this.nightHemiSky, t);
    this.ambientLight.groundColor.copy(this.dayHemiGround).lerp(this.nightHemiGround, t);
    this.ambientLight.intensity = THREE.MathUtils.lerp(1.25, 0.62, t);
    this.keyLight.color.copy(this.dayKeyColor).lerp(this.nightKeyColor, t);
    this.keyLight.intensity = THREE.MathUtils.lerp(1.7, 0.72, t);
    if (t > 0.5) this.ensureNightBeams();
  }

  /** C3: three slow-sweeping searchlight cones anchored ahead of the player. */
  private ensureNightBeams() {
    if (this.nightBeams) return;
    const group = new THREE.Group();
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x9fc4ff,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 3; i++) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 7, 130, 8, 1, true), beamMat);
      beam.position.set((i - 1) * 95, 64, (i - 1) * 26);
      beam.rotation.z = 0.22 - i * 0.08;
      group.add(beam);
    }
    group.visible = false;
    this.scene.add(group);
    this.nightBeams = group;
  }

  /** Distance-falloff explosion impulse: far → none, nearby → small, very
   *  close + large → stronger but capped. */
  addExplosionImpulse(x: number, y: number, z: number, strength: number, radius = 90) {
    const dx = this.helicopter.body.position.x - x;
    const dz = this.helicopter.body.position.z - z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= radius) return;
    const falloff = 1 - dist / radius;
    this.addCameraImpulse(strength * falloff * falloff);
    // A3: knockback — shove the hull away from the blast (1/distance falloff)
    if (dist > 0.001 && this.isPlaying && this.health > 0) {
      const push = Math.min(32, (10 + strength * 5) * falloff);
      this.helicopter.addImpulse((dx / dist) * push, (dz / dist) * push);
    }
  }

  /** Slow cinematic yaw used by the menu/pause idle camera (rad). */
  private menuCameraYaw: number = 0;

  /**
   * Dynamic third-person trailing chase camera (heading-locked).
   *  • speedRatio = clamp(horizontalSpeed / maxSpeed, 0, 1.2)
   *  • pull-back 26 m + ratio*4.5, height 20 m + (alt-2.4)*0.34 + ratio*1.6
   *  • position eased dt*10 horizontal / dt*8 vertical (snappy)
   *  • forward lookahead 18 m + ratio*6 at y = max(3, playerY*0.55), eased dt*12
   *  • subtle camera roll = 15% of the aircraft's bank roll
   */
  updateCamera(delta: number) {
    const heli = this.helicopter.body.position;
    const velocity = this.helicopter.body.velocity;
    if (
      !Number.isFinite(heli.x) || !Number.isFinite(heli.y) || !Number.isFinite(heli.z) ||
      !Number.isFinite(velocity.x) || !Number.isFinite(velocity.z)
    ) return;

    if (!this.isPlaying) {
      // Menu / pause backdrop: slow drift around the parked airframe.
      this.menuCameraYaw += 0.02 * delta;
      const s = Math.sin(this.menuCameraYaw);
      const c = Math.cos(this.menuCameraYaw);
      this.baseCamPos.set(heli.x + s * 34, heli.y + 24, heli.z + c * 34);
      this.camera.position.copy(this.baseCamPos);
      this.cameraLookAtTarget.set(heli.x, heli.y + 2, heli.z);
      this.camera.lookAt(this.cameraLookAtTarget);
      return;
    }

    // --- Speed-dependent pull-back & height -------------------------------
    const heading = this.helicopter.mesh.rotation.y;
    const horizSpeed =
      this.helicopter.lastHorizSpeed > 0.001
        ? this.helicopter.lastHorizSpeed
        : Math.hypot(velocity.x, velocity.z);
    const speedRatio = THREE.MathUtils.clamp(
      horizSpeed / FLIGHT_SPEC.maxForwardSpeed,
      0,
      1.2,
    );
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    const floor = this.helicopter.smoothedHoverFloor;
    const altAboveCushion = Math.max(0, heli.y - (floor + FLIGHT_SPEC.groundCushion));

    // Pull back 26-30 m and ride lower so aircraft stay large in frame while
    // still seeing the ground battlefield.
    const camDist = 26 + speedRatio * 4.5;
    const camHeight = 20 + altAboveCushion * 0.34 + speedRatio * 1.6;
    const camTargetX = heli.x - sinH * camDist;
    const camTargetZ = heli.z - cosH * camDist;
    const camTargetY = heli.y + camHeight;

    // Dual-stage interpolation — snappy dt*10 horizontal, dt*8 vertical so
    // the camera stops smearing behind quick maneuvers.
    const hK = 1 - Math.exp(-10.0 * delta);
    const vK = 1 - Math.exp(-8.0 * delta);
    this.baseCamPos.x += (camTargetX - this.baseCamPos.x) * hK;
    this.baseCamPos.z += (camTargetZ - this.baseCamPos.z) * hK;
    this.baseCamPos.y += (camTargetY - this.baseCamPos.y) * vK;
    this.cameraFollowError = Math.hypot(
      camTargetX - this.baseCamPos.x,
      camTargetY - this.baseCamPos.y,
      camTargetZ - this.baseCamPos.z,
    );

    // --- Dynamic forward lookahead (ahead of the nose, into the field) ----
    // Aim higher (y = max(2.5, playerY * 0.5)) so airborne enemies at cruise
    // altitude sit near frame-center instead of hugging the top edge.
    const lookaheadDist = 18 + speedRatio * 6.0;
    const lookK = 1 - Math.exp(-12.0 * delta);
    // Aim high enough that airborne hostiles at cruise altitude stay in frame.
    const lookTargetY = Math.max(3, heli.y * 0.55);
    this.cameraLookAtTarget.x += (heli.x + sinH * lookaheadDist - this.cameraLookAtTarget.x) * lookK;
    this.cameraLookAtTarget.y += (lookTargetY - this.cameraLookAtTarget.y) * lookK;
    this.cameraLookAtTarget.z += (heli.z + cosH * lookaheadDist - this.cameraLookAtTarget.z) * lookK;

    // Mild speed FOV for readability (feel only; geometry is per spec).
    const targetFov = 52 + Math.min(horizSpeed * 0.12, 5);
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-6 * delta));
    this.camera.updateProjectionMatrix();

    this.camera.position.copy(this.baseCamPos);

    // Settings-gated screen shake.
    if (this.cameraShakeAmp > 0.02) {
      const shakeScale = this.settings.screenShake === 'low' ? 0.45 : 1;
      const amp = this.cameraShakeAmp * shakeScale;
      this.camera.position.x += (Math.random() - 0.5) * amp;
      this.camera.position.y += (Math.random() - 0.5) * amp * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * amp;
    }
    this.cameraShakeAmp = Math.max(0, this.cameraShakeAmp - delta * (2.5 + this.cameraShakeAmp));

    // Building occlusion / ghosting between the trailing camera and the hull.
    this.city.updateOcclusion(
      this.baseCamPos.x,
      this.baseCamPos.y,
      this.baseCamPos.z,
      heli.x,
      heli.y,
      heli.z,
      delta,
      this.isPlaying,
    );

    if (
      Number.isFinite(this.camera.position.x) &&
      Number.isFinite(this.camera.position.y) &&
      Number.isFinite(this.camera.position.z) &&
      Number.isFinite(this.cameraLookAtTarget.x) &&
      Number.isFinite(this.cameraLookAtTarget.y) &&
      Number.isFinite(this.cameraLookAtTarget.z)
    ) {
      this.camera.lookAt(this.cameraLookAtTarget);
      // 15% of the airframe's bank rolled into the view for high-G immersion.
      this.camera.rotateZ(this.helicopter.mesh.rotation.z * 0.15);
    }
  }

  /** Superseded orbit camera (free/soft/fixed yaw modes). Kept compiled only. */
  private legacyOrbitCamera(delta: number) {
    const heli = this.helicopter.body.position;
    const velocity = this.helicopter.body.velocity;
    if (
      !Number.isFinite(heli.x) || !Number.isFinite(heli.y) || !Number.isFinite(heli.z) ||
      !Number.isFinite(velocity.x) || !Number.isFinite(velocity.z)
    ) return;

    const speed = Math.hypot(velocity.x, velocity.z);

    // 1. Angular Yaw Velocity Integration (Immediate responsiveness: <0.08s start, ~0.10s stop)
    const accelRate = 28;
    const dampingRate = 32;
    if (Math.abs(this.targetCameraYawVelocity) > 0.001) {
      this.currentCameraYawVelocity += (this.targetCameraYawVelocity - this.currentCameraYawVelocity) * (1 - Math.exp(-accelRate * delta));
      this.lastCameraInputTime = performance.now() / 1000;
      this.isRecenteringCamera = false;
    } else {
      this.currentCameraYawVelocity += (0 - this.currentCameraYawVelocity) * (1 - Math.exp(-dampingRate * delta));
    }

    if (this.isRecenteringCamera) {
      this.recenterTimer += delta;
      const t = Math.min(1, this.recenterTimer / this.recenterDuration);
      const smoothT = t * t * (3 - 2 * t); // Smoothstep
      this.cameraYaw = this.recenterStartYaw + (this.recenterTargetYaw - this.recenterStartYaw) * smoothT;
      if (t >= 1) {
        this.isRecenteringCamera = false;
        this.cameraYaw = this.recenterTargetYaw;
      }
    } else {
      this.cameraYaw += this.currentCameraYawVelocity * delta;

      if (!this.isPlaying && !this.isMiddleMouseOrbiting) {
        // Menu cinematic background drift
        this.cameraYaw += 0.032 * delta;
      } else if (this.settings.cameraFollowMode === 'soft' && !this.isMiddleMouseOrbiting) {
        const timeSinceInput = (performance.now() / 1000) - this.lastCameraInputTime;
        if (timeSinceInput > 2.5 && speed > 8.0) {
          const targetYaw = Math.atan2(-velocity.x, -velocity.z);
          let diff = targetYaw - this.cameraYaw;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          this.cameraYaw += Math.sign(diff) * Math.min(Math.abs(diff), 0.45 * delta);
        }
      } else if (this.settings.cameraFollowMode === 'fixed') {
        this.cameraYaw = 0;
      }
    }

    // Keep cameraYaw cleanly wrapped in [-PI, PI]
    while (this.cameraYaw > Math.PI) this.cameraYaw -= Math.PI * 2;
    while (this.cameraYaw < -Math.PI) this.cameraYaw += Math.PI * 2;

    const sinYaw = Math.sin(this.cameraYaw);
    const cosYaw = Math.cos(this.cameraYaw);

    // 2. Base Radial Distance & Height (Strictly preserving original camera geometry & pitch invariants)
    const pullback = Math.min(speed * 0.12, 9);
    const baseDistance = 36 + pullback + this.combatIntensity * 6;
    const baseHeight = 28 + Math.min(speed * 0.08, 6) + this.combatIntensity * 4;

    // Smooth, subtle velocity look-ahead (avoids target jumping lag while providing natural preview)
    const targetLookAheadX = THREE.MathUtils.clamp(velocity.x * 0.08, -3.5, 3.5);
    const targetLookAheadZ = THREE.MathUtils.clamp(velocity.z * 0.08, -3.5, 3.5);
    const lookAheadAlpha = 1 - Math.exp(-12.0 * delta);
    this.smoothedLookAhead.x += (targetLookAheadX - this.smoothedLookAhead.x) * lookAheadAlpha;
    this.smoothedLookAhead.y += (targetLookAheadZ - this.smoothedLookAhead.y) * lookAheadAlpha;

    const offsetX = sinYaw * baseDistance;
    const offsetZ = cosYaw * baseDistance;

    // 3. Camera Boom Collision Compression (Fast in on obstruction, smooth fast out on clear)
    const testCamX = heli.x + offsetX + this.smoothedLookAhead.x;
    const testCamZ = heli.z + offsetZ + this.smoothedLookAhead.y;
    const buildingHeight = this.city ? this.city.getHeightAt(testCamX, testCamZ, 1.8) : 0;
    let targetBoom = 1.0;
    const minCamY = heli.y + baseHeight;
    if (buildingHeight > minCamY - 3.5) {
      targetBoom = 0.65;
    }
    const boomAlpha = 1 - Math.exp(-(targetBoom < this.cameraBoomFraction ? 16 : 10) * delta);
    this.cameraBoomFraction += (targetBoom - this.cameraBoomFraction) * boomAlpha;

    // 4. Target Camera Position (Single Fast Damping Layer: sharpness = 14.0 uniform across X, Y, Z)
    const camTargetX = heli.x + offsetX * this.cameraBoomFraction + this.smoothedLookAhead.x;
    const camTargetY = heli.y + baseHeight * Math.max(0.85, this.cameraBoomFraction);
    const camTargetZ = heli.z + offsetZ * this.cameraBoomFraction + this.smoothedLookAhead.y;

    this.cameraTargetPosScratch.set(camTargetX, camTargetY, camTargetZ);

    const followSharpness = this.isPlaying ? 14.0 : 4.0;
    const camAlpha = 1 - Math.exp(-followSharpness * delta);
    this.baseCamPos.x += (camTargetX - this.baseCamPos.x) * camAlpha;
    this.baseCamPos.y += (camTargetY - this.baseCamPos.y) * camAlpha;
    this.baseCamPos.z += (camTargetZ - this.baseCamPos.z) * camAlpha;

    this.cameraFollowError = Math.hypot(
      camTargetX - this.baseCamPos.x,
      camTargetY - this.baseCamPos.y,
      camTargetZ - this.baseCamPos.z,
    );

    // 5. FOV (Unchanged)
    const targetFov = 52 + Math.min(speed * 0.07, 6) + this.combatIntensity * 4;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-6 * delta));
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(this.baseCamPos);

    // 6. Settings-Gated Screen Shake
    if (this.cameraShakeAmp > 0.02) {
      const shakeScale = this.settings.screenShake === 'low' ? 0.45 : 1;
      const amp = this.cameraShakeAmp * shakeScale;
      this.camera.position.x += (Math.random() - 0.5) * amp;
      this.camera.position.y += (Math.random() - 0.5) * amp * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * amp;
    }
    this.cameraShakeAmp = Math.max(0, this.cameraShakeAmp - delta * (2.5 + this.cameraShakeAmp));

    // 7. 3D Building Occlusion / Ghosting (Calculated from actual 3D orbital camera position)
    this.city.updateOcclusion(
      this.baseCamPos.x,
      this.baseCamPos.y,
      this.baseCamPos.z,
      heli.x,
      heli.y,
      heli.z,
      delta,
      this.isPlaying,
    );

    // 8. LookAt Target (Forward along yaw direction with unified smoothed look-ahead)
    const lookDist = 9;
    const lookOffsetX = -sinYaw * lookDist;
    const lookOffsetZ = -cosYaw * lookDist;

    const desiredLookX = heli.x + lookOffsetX + this.smoothedLookAhead.x;
    const desiredLookY = Math.max(8, Math.min(70, heli.y + 2));
    const desiredLookZ = heli.z + lookOffsetZ + this.smoothedLookAhead.y;

    const lookAlpha = 1 - Math.exp(-16.0 * delta);
    this.cameraLookAtTarget.x += (desiredLookX - this.cameraLookAtTarget.x) * lookAlpha;
    this.cameraLookAtTarget.y += (desiredLookY - this.cameraLookAtTarget.y) * lookAlpha;
    this.cameraLookAtTarget.z += (desiredLookZ - this.cameraLookAtTarget.z) * lookAlpha;

    if (
      Number.isFinite(this.camera.position.x) &&
      Number.isFinite(this.camera.position.y) &&
      Number.isFinite(this.camera.position.z) &&
      Number.isFinite(this.cameraLookAtTarget.x) &&
      Number.isFinite(this.cameraLookAtTarget.y) &&
      Number.isFinite(this.cameraLookAtTarget.z)
    ) {
      this.camera.lookAt(this.cameraLookAtTarget);
    }
  }
}
