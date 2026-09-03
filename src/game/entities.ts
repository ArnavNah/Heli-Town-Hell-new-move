import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as CANNON from "cannon-es";
import { createBox, createGlowBox, createGlowMaterial, createLowPolyMaterial, disposeObject3D } from "./materials";
import {
  EnemyHelicopterModelFactory,
  type EnemyHelicopterModelResult,
  type EnemyDamagePoints,
} from "./enemyHelicopterModels";
import {
  AttackPattern,
  COLLISION,
  copyPhysicsPos,
  EnemyLock,
  EnemyModifier,
  EnemyMovementClass,
  EnemyType,
  EnemyVariant,
  HelicopterModel,
  ObjectiveType,
  PowerUpType,
  type StatusEffectKind,
  DroneCombatState,
  TankCombatState,
  AttackSector,
} from "./types";
import { CombatDirector } from "./combatDirector";
import {
  BOSS_TELEGRAPH_DURATION,
  BURN_DPS,
  SHOCK_SPEED_MULT,
  STATUS_DURATIONS,
  bossPhaseForRatio,
  bossVolleyConfig,
  objectiveConfig,
  enemySpeedScale,
} from "./logic";
import { ENEMY_VARIANTS } from "./logic";
import type { CityBlock } from "./types";
import type { CityEnvironment } from "./city";
import type { GPUParticleSystem } from "./particles";

const _projPos = new THREE.Vector3();
import {
  SAM_DETECTION_RANGE,
  SAM_MAX_PITCH,
  SAM_MISSILE_LIFETIME,
  SAM_MIN_PITCH,
  SAM_PITCH_SPEED,
  SAM_YAW_SPEED,
  SamState,
  SamStateMachine,
  shortestAngleDelta,
  stepAngle,
} from "./sam";
import type { SamStateResult } from "./sam";

export class Entity {
  mesh!: THREE.Object3D;
  body!: CANNON.Body;
  active: boolean = true;
  world!: CANNON.World;
  scene!: THREE.Scene;

  constructor(scene: THREE.Scene, world: CANNON.World) {
    this.scene = scene;
    this.world = world;
  }

  update(time: number = 0) {
    if (this.active && this.mesh && this.body) {
      copyPhysicsPos(this.mesh, this.body.position);
      // We don't copy quaternion directly because we manually bank/tilt the mesh for stylized physics
    }
  }

  destroy() {
    this.active = false;
    if (this.mesh && this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
      // Phase 1: release this entity's unique GPU buffers (rotor blur discs,
      // shield bubbles, hull materials). Shared cached resources are skipped.
      disposeObject3D(this.mesh);
    }
    if (this.body && this.world) this.world.removeBody(this.body);
  }
}

const tempColor = new THREE.Color();
const tempVec3_1 = new CANNON.Vec3();
const tempVec3_2 = new CANNON.Vec3();

/** HD renders real shadows for the PLAYER only; every other entity clears
 *  castShadow so it stays out of the caster pass. receiveShadow is left
 *  intact so the player's shadow still lands on nearby surfaces. */
function disableShadowCasting(root: THREE.Object3D) {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = false;
  });
}

/**
 * Phase 2 — named, tunable arcade movement values. The helicopter is
 * velocity-controlled (not a position-target chase), so these are the single
 * source of truth for every movement constant. Units: units/second and
 * units/second². Braking is deliberately stronger than acceleration so the
 * ship settles into a hover instead of gliding across the city.
 */
export const MOVEMENT_CONFIG = {
  /** Normal cruise speed cap (u/s). */
  maxHorizontalSpeed: 68,
  /** Forward/maneuver thrust acceleration (u/s²). Reaches cruise in ~0.24s. */
  thrust: 340,
  /** In-flight drag coefficient (frame-independent baseline, per 60Hz frame). */
  flightDrag: 0.968,
  /** Active braking drag when input is released (per 60Hz frame, settles in ~0.30s). */
  brakingDrag: 0.72,
  /** Counter-thrust multiplier when reversing direction (180° turn responsiveness). */
  reverseThrustMultiplier: 1.60,
  /** Analog stick radial deadzone. */
  analogDeadzone: 0.15,
  /** Body yaw critically-damped spring dynamics (rad/s² and rad/s, zeta = 1.0). */
  bodyYawSpring: 130.0,
  bodyYawDamping: 23.0,
  maxYawSpeed: 6.80, // ~390°/sec max angular velocity
  maxYawAcceleration: 52.0, // max angular acceleration rate
  /** Max bank roll and pitch limits (radians). Roll: ~18.3° (0.32 rad), Pitch: ~9.2° (0.16 rad). */
  maxRoll: 0.32, // ~18.3° (arcade-readable bank)
  maxPitch: 0.16, // ~9.2° (subtle forward lean)
  /** Bank response speeds (/s). */
  bankResponse: 16.0,
  bankReturnResponse: 12.0,
  visualAccelerationSmoothing: 24.0,
  /** Vertical flight is deliberately a little heavier than horizontal flight. */
  maxVerticalSpeed: 32,
  verticalAcceleration: 140,
  verticalBraking: 130,
  verticalReverseAcceleration: 180,
  /** Double-tap dash is a short bounded burst, never a velocity multiplier. */
  dashSpeed: 150,
  dashDuration: 0.22,
  dashCooldown: 0.75,
  /** Afterburner increases speed cap (1.55x) and thrust (1.30x). */
  afterburnerMultiplier: 1.55,
  afterburnerThrustMultiplier: 1.30,
  /** Speed-boost power-up multiplier. */
  speedBoostMultiplier: 1.24,
  /** Minimum altitude above terrain/buildings (u). */
  hoverClearance: 7.5,
  terrainFloorEnter: 1.25,
  terrainFloorExit: 2.25,
  terrainHardCorrectionDepth: 0.8,
  /** Soft max altitude (u) — control eases out near the cap. */
  maxAltitude: 58,
  /** World half-width the player can fly across (x clamp). */
  worldBoundX: 210,
  /** Abnormal-speed safety clamp (u/s). */
  safetyMaxSpeed: 260,
} as const;

/**
 * FLIGHT_SPEC — heading-relative attack-helicopter flight controller.
 * Arcade-tuned: brisk cruise, snappy thrust and yaw, momentum glide on drag.
 *  • Rudder A/D (←/→) yaws the heading at up to ~2.6 rad/s with smooth
 *    angular acceleration and deceleration damping.
 *  • W/S thrusts along `forwardVector = (sin h, 0, cos h)`; Q/E strafes along
 *    the aircraft's TRUE right vector = (−cos h, 0, sin h) — three.js is
 *    right-handed, so the classic (cos h, 0, −sin h) is actually the LEFT
 *    side of a nose facing +Z. Cruise caps at 34 u/s.
 *  • Shift climbs at 9.5 u/s, Ctrl sinks at 8.0 u/s; altitude is clamped to
 *    a 2.4 m ground cushion / 26 m ceiling above the underlying surface.
 *  • Linear momentum glides on exponential drag `v *= exp(-drag*dt)`.
 *  • Mesh pose (Euler order YXZ = Ry→Rx→Rz): pitch = ±0.32 rad (~18°),
 *    roll = ±0.48 rad (~28°), both eased with `1 - exp(-12*dt)`.
 */
export const FLIGHT_SPEC = {
  /** Max cruise speed (u/s). */
  maxForwardSpeed: 34,
  /** Cyclic thrust / lateral-strafe acceleration (u/s²) toward the cap — the
   *  cap (not drag) is what governs cruise, so response is immediate. */
  forwardAccel: 120,
  /** Exponential drag coefficient (/s): velocity *= exp(-drag * dt). */
  drag: 1.35,
  /** Rudder turn rate cap (rad/s, ~149°/s). */
  turnRate: 2.6,
  /** Angular smoothing (/s) while yaw is held vs. after release. */
  yawAccelResponse: 14.0,
  yawDecelResponse: 10.0,
  /** Collective climb (+) / sink (−) rates (u/s). */
  climbRate: 9.5,
  sinkRate: 8.0,
  /** Vertical acceleration (u/s²) — how fast the collective rate is reached. */
  verticalAccel: 110,
  /** Strict altitude envelope above the underlying surface (u). */
  groundCushion: 2.4,
  ceiling: 26.0,
  /** Spawn altitude (u) — mid-band so climb AND descend both have room and
   *  respond the instant a run starts (spawning at `ceiling` made the
   *  collective feel dead: holding climb was clamped to nothing). */
  spawnAltitude: 15.0,
  /** Aero tilt limits (rad): nose-down ~18° max pitch, ~28° max bank. */
  maxPitch: 0.32,
  maxRoll: 0.48,
  /** Pitch/roll ease response (/s) — lerp(current, target, 1 - exp(-10dt)). */
  tiltResponse: 12.0,
} as const;

/**
 * Per-model handling profiles — the Hangar choice is more than paint. Warlock
 * flies heavy (slower, wider turns, deeper bank), Nighthawk is light and agile
 * (faster, snappier, shallower bank). Multipliers scale the shared arcade
 * controller so every model keeps the same core feel with a distinct weight.
 */
const MODEL_MOVEMENT = {
  [HelicopterModel.APACHE]: { speed: 1, accel: 1, turn: 1, bank: 1 },
  [HelicopterModel.NIGHTHAWK]: { speed: 1.08, accel: 1.12, turn: 1.2, bank: 0.92 },
  [HelicopterModel.WARLOCK]: { speed: 0.92, accel: 0.84, turn: 0.8, bank: 1.12 },
} as const;

/**
 * Hover-settle spring — when the pilot releases vertical control near the
 * terrain floor, the helicopter settles on a damped spring instead of a
 * linear stop, so landings read as weighty instead of snapping to a hover.
 * Under-damped (DAMP < 2*sqrt(K)) for a soft, readable settle, never a bounce.
 */
const HOVER_SPRING = {
  RANGE: 14, // engage within this many units above the floor + clearance
  K: 20, // stiffness
  DAMP: 6.4, // 2*sqrt(20)*~0.72 — under-damped settle
  MAX_SETTLE: 12, // settle speed cap (u/s)
} as const;

/**
 * Phase 2 — per-frame movement command from the engine. Inputs are
 * world-space and already normalized: x = strafe (A/D), z = forward (W/S,
 * -z is forward), y = vertical -1..1 (Space/Alt), afterburner = speed
 * multiplier (1 when inactive).
 */
export interface MovementCommand {
  /** Lateral cyclic strafe -1..1 (+1 = strafe right, E / gamepad stick right). */
  x: number;
  /** Cyclic thrust -1..1 (+1 = accelerate along heading, W / up; −1 = reverse, S). */
  z: number;
  /** Collective vertical -1..1 (+1 = climb, Shift; −1 = descend, Ctrl). */
  y: number;
  /** Rudder yaw -1..1 (+1 = turn right, D / →). */
  yaw: number;
  /** Subtle 0..1 load factor supplied by the cargo system (1 without cargo). */
  cargoMultiplier?: number;
}

export class Helicopter extends Entity {
  model: HelicopterModel = HelicopterModel.APACHE;
  targetPosition: THREE.Vector3;
  lastTargetPosition: THREE.Vector3;
  mainRotor: THREE.Object3D;
  tailRotor: THREE.Object3D;
  shieldMesh: THREE.Mesh | null = null;
  /** Rotating chin gun turret — tracks auto-aim targets while the body flies on. */
  /** Yaw pivot (horizontal) — child of the helicopter mesh, parent to pitch pivot. */
  gunYawPivot: THREE.Group = new THREE.Group();
  /** Pitch pivot (vertical) — child of yaw pivot, holds the gun mesh. */
  gunPitchPivot: THREE.Group = new THREE.Group();
  gunAimMode: boolean = false;
  /** World-space target the gun should track (set externally). */
  gunAimTarget: THREE.Vector3 = new THREE.Vector3();

  // Phase 3 game-feel: MG recoil kicks the barrel/muzzle back along its axis
  // and springs back — visual only, pivots (and therefore auto-aim math) are
  // untouched. firePitchImpulse adds a tiny clamped nose kick for heavy
  // weapons, applied to the visual mesh only and absorbed by the bank
  // controller (spring return).
  private gunRecoil = 0;
  private firePitchImpulse = 0;
  private gunBarrelMesh: THREE.Mesh | null = null;
  private gunMuzzleMesh: THREE.Mesh | null = null;
  /** Exact projectile origin at the open end of the procedural barrel. */
  private gunMuzzlePoint: THREE.Object3D = new THREE.Object3D();
  private gunTargetLocal: THREE.Vector3 = new THREE.Vector3();
  private gunWorldQuaternion: THREE.Quaternion = new THREE.Quaternion();
  private leftTrailPoint: THREE.Vector3 = new THREE.Vector3();
  private rightTrailPoint: THREE.Vector3 = new THREE.Vector3();
  /** Persistent gameplay state used by physics, safety checks and visual weight transfer. */
  previousVelocity: CANNON.Vec3 = new CANNON.Vec3();
  desiredVelocity: CANNON.Vec3 = new CANNON.Vec3();
  currentAcceleration: CANNON.Vec3 = new CANNON.Vec3();
  private filteredAcceleration: CANNON.Vec3 = new CANNON.Vec3();
  /** A3: external knockback velocity (explosions, heavy-weapon recoil).
   *  Folded into the desired-velocity controller and decayed exponentially,
   *  so the kick never fights player input. */
  private impulseVelocity: THREE.Vector2 = new THREE.Vector2();
  private static readonly MAX_IMPULSE = 55;
  private static readonly IMPULSE_DECAY = 2.8; // /s exponential
  private terrainSafetyActive = false;
  private trailEffectTimer = 0;
  private damageEffectTimer = 0;
  private static readonly GUN_RECOIL_MAX = 0.28;
  private static readonly GUN_RECOIL_RESPONSE = 22; // /s — fast spring back
  private static readonly FIRE_PITCH_MAX = 0.09;
  private static readonly FIRE_PITCH_RESPONSE = 10; // /s
  private tintedMaterials: Array<{ mat: THREE.MeshLambertMaterial | THREE.MeshToonMaterial; baseColor: THREE.Color }> = [];
  private lastTonedHullDamage = -1;

  // Gun turret config
  static readonly GUN_YAW_MIN: number = -2.09; // -120°
  static readonly GUN_YAW_MAX: number = 2.09;  // +120°
  static readonly GUN_PITCH_MIN: number = -0.79; // -45°
  static readonly GUN_PITCH_MAX: number = 0.44;  // +25°
  static readonly GUN_TRACKING_SPEED: number = 14; // rad/s

  // Subsystems
  rotorHealth: number = 100;
  engineHealth: number = 100;
  hoverFloor: number = 0;
  smoothedHoverFloor: number = 0;
  aimPosition: THREE.Vector3 = new THREE.Vector3(0, FLIGHT_SPEC.spawnAltitude, -30);

  // Body yaw angular velocity (rad/s)
  bodyYawVelocity: number = 0;

  // Dash variables
  dashTimer: number = 0;
  dashDuration: number = MOVEMENT_CONFIG.dashDuration;
  dashRollDirection: number = 0;
  dashPitchDirection: number = 0;

  triggerDash(dx: number, dz: number) {
    this.dashTimer = this.dashDuration;
    const cy = Math.cos(this.mesh.rotation.y);
    const sy = Math.sin(this.mesh.rotation.y);
    this.dashRollDirection = dx * cy - dz * sy;
    this.dashPitchDirection = dx * sy + dz * cy;
  }

  constructor(scene: THREE.Scene, world: CANNON.World, model: HelicopterModel = HelicopterModel.APACHE) {
    super(scene, world);
    this.model = model;
    this.targetPosition = new THREE.Vector3(0, FLIGHT_SPEC.spawnAltitude, 0);
    this.lastTargetPosition = new THREE.Vector3(0, FLIGHT_SPEC.spawnAltitude, 0);

    const baseGroup = new THREE.Group();

    // Model-tinted shared materials (Nighthawk is dark slate, Warlock olive,
    // Materials per model (Apache = vibrant military olive green matching reference diorama,
    // Nighthawk = stealth slate, Warlock = heavy twin-rotor camo green)
    const bodyMat = createLowPolyMaterial(
      model === HelicopterModel.NIGHTHAWK
        ? 0x2c3338
        : model === HelicopterModel.WARLOCK
          ? 0x3d4f2e
          : 0x4d5f36,
    );
    const darkBodyMat = createLowPolyMaterial(
      model === HelicopterModel.NIGHTHAWK
        ? 0x181c20
        : model === HelicopterModel.WARLOCK
          ? 0x26331c
          : 0x2f3c20,
    );
    const glassMat = createLowPolyMaterial(
      model === HelicopterModel.NIGHTHAWK ? 0x141e24 : 0x1c2b36,
    );
    const metalMat = createLowPolyMaterial(0x5a6368);
    const bladeMat = createLowPolyMaterial(0x1a1e20);
    const ordnanceMat = createLowPolyMaterial(0x283424);
    const accentMat = createLowPolyMaterial(0xde5932);

    if (model === HelicopterModel.NIGHTHAWK) {
      this.buildNighthawk(baseGroup, bodyMat, darkBodyMat, glassMat, metalMat, bladeMat, accentMat);
    } else if (model === HelicopterModel.WARLOCK) {
      this.buildWarlock(baseGroup, bodyMat, darkBodyMat, glassMat, metalMat, bladeMat, accentMat);
    } else {
      this.buildApache(baseGroup, bodyMat, darkBodyMat, glassMat, metalMat, bladeMat, ordnanceMat, accentMat);
    }

    // Shared rotating chin gun turret (all models): yaw pivot → pitch pivot → gun mesh
    // This ensures auto-aim rotates ONLY the gun, never the helicopter body.
    this.gunYawPivot.position.set(0, -0.95, 3.0);
    baseGroup.add(this.gunYawPivot);

    this.gunPitchPivot.position.set(0, 0, 0);
    this.gunYawPivot.add(this.gunPitchPivot);

    const gunMountBase = createBox(0.6, 0.4, 0.6, 0x161a18);
    gunMountBase.material = bladeMat;
    const gunBarrel = createBox(0.14, 0.14, 2.0, 0x22262a);
    gunBarrel.material = bladeMat;
    gunBarrel.position.set(0, 0, 1.0);
    const gunMuzzle = createGlowBox(0.3, 0.3, 0.26, 0xff4444, 0.85);
    gunMuzzle.position.set(0, 0, 2.05);
    this.gunMuzzlePoint.name = "MuzzlePoint";
    this.gunMuzzlePoint.position.set(0, 0, 2.18);
    this.gunPitchPivot.add(gunMountBase, gunBarrel, gunMuzzle, this.gunMuzzlePoint);
    this.gunBarrelMesh = gunBarrel;
    this.gunMuzzleMesh = gunMuzzle;

    // Mast & Rotor (shared)
    const mast = createBox(0.6, 1.5, 0.6, 0x5a6360);
    mast.material = metalMat;
    mast.position.set(0, 1.4, -0.2);
    baseGroup.add(mast);

    this.mainRotor = new THREE.Group();
    this.mainRotor.position.set(0, 2.1, -0.2);
    
    // Rotor hub
    const hub = createBox(1.2, 0.2, 1.2, 0x5a6360);
    hub.material = metalMat;
    this.mainRotor.add(hub);

    for (let i = 0; i < 4; i++) {
      const blade = createBox(0.35, 0.05, 11.0, 0x161a18);
      blade.material = bladeMat;
      blade.position.set(0, 0, 5.5); // Pivot at hub
      
      const bladePivot = new THREE.Group();
      bladePivot.rotation.y = (Math.PI / 2) * i;
      bladePivot.add(blade);
      this.mainRotor.add(bladePivot);
    }

    // Rotor Blur Disc (Transparent)
    const blurGeo = new THREE.RingGeometry(3.2, 11.5, 56);
    blurGeo.rotateX(-Math.PI / 2);
    const blurMat = new THREE.MeshBasicMaterial({
      color: 0xd8f6ff,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const blurDisc = new THREE.Mesh(blurGeo, blurMat);
    blurDisc.name = "rotorBlur";
    blurDisc.visible = false;
    this.mainRotor.add(blurDisc);
    baseGroup.add(this.mainRotor);

    this.tailRotor = new THREE.Group();
    this.tailRotor.position.set(0.3, 1.8, -8.5);
    
    const tailHub = createBox(0.2, 0.4, 0.4, 0x5a6360);
    tailHub.material = metalMat;
    this.tailRotor.add(tailHub);

    for (let i = 0; i < 4; i++) {
      const blade = createBox(0.05, 1.8, 0.15, 0x161a18);
      blade.material = bladeMat;
      blade.position.set(0, 0.9, 0); // Pivot at hub
      
      const bladePivot = new THREE.Group();
      bladePivot.rotation.x = (Math.PI / 2) * i;
      bladePivot.add(blade);
      this.tailRotor.add(bladePivot);
    }
    
    const tailBlurGeo = new THREE.RingGeometry(0.45, 1.9, 28);
    tailBlurGeo.rotateY(Math.PI / 2);
    const tailBlurDisc = new THREE.Mesh(tailBlurGeo, blurMat);
    tailBlurDisc.name = "tailBlur";
    tailBlurDisc.visible = false;
    this.tailRotor.add(tailBlurDisc);
    baseGroup.add(this.tailRotor);
    // Shield Bubble Mesh
    const shieldGeo = new THREE.SphereGeometry(3.6, 10, 8);
    const shieldMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.28,
      wireframe: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
    this.shieldMesh.visible = false;
    baseGroup.add(this.shieldMesh);

    this.mesh = baseGroup;
    this.mesh.rotation.order = "YXZ";
    scene.add(this.mesh);

    this.body = new CANNON.Body({
      mass: 5,
      type: CANNON.Body.DYNAMIC,
      position: new CANNON.Vec3(0, FLIGHT_SPEC.spawnAltitude, 0),
      linearDamping: 0, // The arcade controller is the sole owner of linear damping.
      angularDamping: 0.9,
      collisionFilterGroup: COLLISION.PLAYER,
      collisionFilterMask: COLLISION.PLAYER_MASK,
    });

    // Core hitbox
    const shape = new CANNON.Box(new CANNON.Vec3(1.25, 1.05, 2.35));
    this.body.addShape(shape);
    this.body.fixedRotation = true;
    this.body.updateMassProperties();
    world.addBody(this.body);

    this.mesh.rotation.y = Math.PI;

    this.mesh.traverse((child) => {
      if (
        child instanceof THREE.Mesh &&
        (child.material instanceof THREE.MeshLambertMaterial ||
          child.material instanceof THREE.MeshToonMaterial)
      ) {
        const baseColor = child.material.userData.baseColor as THREE.Color | undefined;
        if (baseColor) {
          this.tintedMaterials.push({ mat: child.material, baseColor: baseColor.clone() });
        }
      }
    });
  }

  /** Default Apache attack helicopter (original design). */
  private buildApache(
    baseGroup: THREE.Group,
    bodyMat: THREE.MeshToonMaterial,
    darkBodyMat: THREE.MeshToonMaterial,
    glassMat: THREE.MeshToonMaterial,
    metalMat: THREE.MeshToonMaterial,
    bladeMat: THREE.MeshToonMaterial,
    ordnanceMat: THREE.MeshToonMaterial,
    accentMat: THREE.MeshToonMaterial,
  ) {
    // Main Fuselage
    const fuselage = createBox(2.2, 1.6, 5.8, 0x2d3a2e);
    fuselage.material = bodyMat;
    fuselage.position.set(0, 0, -0.5);
    baseGroup.add(fuselage);

    // Nose & Sensor Pod
    const nose = createBox(1.5, 1.2, 2.2, 0x2d3a2e);
    nose.material = bodyMat;
    nose.position.set(0, -0.2, 3.5);
    baseGroup.add(nose);
    
    const sensorPod = createBox(0.8, 0.7, 1.0, 0x1a211a);
    sensorPod.material = darkBodyMat;
    sensorPod.position.set(0, -0.9, 4.0);
    baseGroup.add(sensorPod);

    // (Static chin gun replaced by the shared rotating gun turret)

    // Tandem Cockpit
    const rearCanopy = createBox(1.2, 0.8, 1.5, 0x1c2b33);
    rearCanopy.material = glassMat;
    rearCanopy.position.set(0, 0.9, 1.2);
    rearCanopy.rotation.x = -0.05;
    baseGroup.add(rearCanopy);

    const frontCanopy = createBox(1.1, 0.6, 1.4, 0x1c2b33);
    frontCanopy.material = glassMat;
    frontCanopy.position.set(0, 0.6, 2.6);
    frontCanopy.rotation.x = -0.15;
    baseGroup.add(frontCanopy);

    // Engine Intakes (Sides)
    const engineLeft = createBox(1.0, 0.9, 2.8, 0x1a211a);
    engineLeft.material = darkBodyMat;
    engineLeft.position.set(-1.4, 0.4, -0.8);
    const engineRight = engineLeft.clone();
    engineRight.position.x = 1.4;
    baseGroup.add(engineLeft, engineRight);

    // Tail Boom
    const tailBoom = createBox(0.7, 0.9, 6.2, 0x2d3a2e);
    tailBoom.material = bodyMat;
    tailBoom.position.set(0, 0.1, -6.0);
    baseGroup.add(tailBoom);

    const tailFin = createBox(0.3, 2.4, 1.4, 0x1a211a);
    tailFin.material = darkBodyMat;
    tailFin.position.set(0, 1.1, -8.4);
    tailFin.rotation.x = 0.15;
    baseGroup.add(tailFin);

    const tailStabilizer = createBox(3.0, 0.15, 0.8, 0x2d3a2e);
    tailStabilizer.material = bodyMat;
    tailStabilizer.position.set(0, 0.2, -7.8);
    baseGroup.add(tailStabilizer);

    // Stub Wings
    const stubWingLeft = createBox(3.8, 0.25, 1.4, 0x2d3a2e);
    stubWingLeft.material = bodyMat;
    stubWingLeft.position.set(-2.5, -0.1, 0.2);
    stubWingLeft.rotation.z = -0.05;
    const stubWingRight = stubWingLeft.clone();
    stubWingRight.position.x = 2.5;
    stubWingRight.rotation.z = 0.05;
    baseGroup.add(stubWingLeft, stubWingRight);

    // Pylons and Missiles
    const pylonOffsets = [-3.8, -2.6, 2.6, 3.8];
    pylonOffsets.forEach((px) => {
      const pylon = createBox(0.2, 0.5, 0.8, 0x212b25);
      pylon.material = ordnanceMat;
      pylon.position.set(px, -0.4, 0.2);
      baseGroup.add(pylon);

      // Rocket pod
      const pod = createBox(0.6, 0.6, 1.4, 0x1a211a);
      pod.material = darkBodyMat;
      pod.position.set(px, -0.8, 0.2);
      baseGroup.add(pod);

      const tip = createBox(0.2, 0.2, 0.3, 0xb33127);
      tip.material = accentMat;
      tip.position.set(px, -0.8, 0.95);
      baseGroup.add(tip);
    });

    // Landing Gear (Wheels)
    const gearStrutL = createBox(0.2, 1.2, 0.2, 0x5a6360);
    gearStrutL.material = metalMat;
    gearStrutL.position.set(-1.2, -1.2, 1.5);
    const gearStrutR = gearStrutL.clone();
    gearStrutR.position.x = 1.2;
    const gearStrutRear = createBox(0.2, 1.0, 0.2, 0x5a6360);
    gearStrutRear.material = metalMat;
    gearStrutRear.position.set(0, -0.8, -4.5);
    baseGroup.add(gearStrutL, gearStrutR, gearStrutRear);

    const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 8).toNonIndexed();
    wheelGeo.computeVertexNormals();
    const wheelMat = createLowPolyMaterial(0x111111);
    const wheelL = new THREE.Mesh(wheelGeo, wheelMat);
    wheelL.rotation.z = Math.PI / 2;
    wheelL.position.set(-1.3, -1.8, 1.5);
    const wheelR = wheelL.clone();
    wheelR.position.x = 1.3;
    const wheelRear = wheelL.clone();
    wheelRear.position.set(0, -1.3, -4.5);
    baseGroup.add(wheelL, wheelR, wheelRear);

    // Signature details: wingtip nav lights + tail beacon (Apache)
    const navRed = createGlowBox(0.22, 0.22, 0.22, 0xff2244, 0.9);
    navRed.position.set(-3.9, -0.1, 0.2);
    const navGreen = createGlowBox(0.22, 0.22, 0.22, 0x22ff66, 0.9);
    navGreen.position.set(3.9, -0.1, 0.2);
    const tailBeacon = createGlowBox(0.18, 0.18, 0.18, 0xff3344, 0.9);
    tailBeacon.position.set(0, 0.6, -8.4);
    const antenna = createBox(0.06, 0.7, 0.06, 0x5a6360);
    antenna.material = metalMat;
    antenna.position.set(0.7, 1.1, 0.6);
    baseGroup.add(navRed, navGreen, tailBeacon, antenna);
    this.registerNavLight(navRed, false);
    this.registerNavLight(navGreen, false);
    this.registerNavLight(tailBeacon, true);
  }

  /** NIGHTHAWK — angular stealth gunship with twin tails and a dark fuselage. */
  private buildNighthawk(
    baseGroup: THREE.Group,
    bodyMat: THREE.MeshToonMaterial,
    darkBodyMat: THREE.MeshToonMaterial,
    glassMat: THREE.MeshToonMaterial,
    metalMat: THREE.MeshToonMaterial,
    bladeMat: THREE.MeshToonMaterial,
    accentMat: THREE.MeshToonMaterial,
  ) {
    const hull = createBox(2.0, 1.3, 6.4, 0x242c30);
    hull.material = bodyMat;
    baseGroup.add(hull);

    // Angular faceted nose
    const noseLow = createBox(1.4, 0.7, 1.6, 0x242c30);
    noseLow.material = bodyMat;
    noseLow.position.set(0, -0.35, 3.9);
    const noseTop = createBox(1.0, 0.5, 1.2, 0x1a211a);
    noseTop.material = darkBodyMat;
    noseTop.position.set(0, 0.45, 4.0);
    baseGroup.add(noseLow, noseTop);

    // Stealth canopy (dark angular glass)
    const canopy = createBox(1.0, 0.6, 2.2, 0x101820);
    canopy.material = glassMat;
    canopy.position.set(0, 0.75, 1.6);
    canopy.rotation.x = -0.1;
    baseGroup.add(canopy);

    // Twin tail booms with vertical stabilizers
    const boomL = createBox(0.5, 0.6, 4.6, 0x242c30);
    boomL.material = bodyMat;
    boomL.position.set(-1.1, 0.3, -4.6);
    const boomR = boomL.clone();
    boomR.position.x = 1.1;
    baseGroup.add(boomL, boomR);

    const finL = createBox(0.25, 1.9, 1.1, 0x1a211a);
    finL.material = darkBodyMat;
    finL.position.set(-1.1, 1.1, -6.2);
    finL.rotation.x = 0.12;
    const finR = finL.clone();
    finR.position.x = 1.1;
    baseGroup.add(finL, finR);

    // Wide delta wings
    const wingL = createBox(3.6, 0.22, 1.6, 0x242c30);
    wingL.material = bodyMat;
    wingL.position.set(-2.4, -0.15, 0.1);
    wingL.rotation.z = 0.06;
    const wingR = wingL.clone();
    wingR.position.x = 2.4;
    wingR.rotation.z = -0.06;
    baseGroup.add(wingL, wingR);

    // Wingtip missiles (stub pylons)
    [-3.3, 3.3].forEach((px) => {
      const rail = createBox(0.16, 0.34, 1.9, 0x111111);
      rail.material = bladeMat;
      rail.position.set(px, -0.45, 0.1);
      const tip = createBox(0.22, 0.22, 0.3, 0xff3344);
      tip.material = accentMat;
      tip.position.set(px, -0.45, 1.05);
      baseGroup.add(rail, tip);
    });

    // Stealth fins under the nose
    const chinFin = createBox(0.3, 0.8, 1.4, 0x1a211a);
    chinFin.material = darkBodyMat;
    chinFin.position.set(0, -0.95, 2.4);
    baseGroup.add(chinFin);

    // Signature details: wingtip nav lights + twin tail beacons (Nighthawk)
    const navRed = createGlowBox(0.2, 0.2, 0.2, 0xff2244, 0.9);
    navRed.position.set(-3.9, -0.15, 0.1);
    const navGreen = createGlowBox(0.2, 0.2, 0.2, 0x22ff66, 0.9);
    navGreen.position.set(3.9, -0.15, 0.1);
    const beaconL = createGlowBox(0.16, 0.16, 0.16, 0xff3344, 0.9);
    beaconL.position.set(-1.1, 1.2, -6.2);
    const beaconR = beaconL.clone();
    beaconR.position.x = 1.1;
    const antenna = createBox(0.06, 0.6, 0.06, 0x5a6360);
    antenna.material = metalMat;
    antenna.position.set(0, 1.0, 0.8);
    baseGroup.add(navRed, navGreen, beaconL, beaconR, antenna);
    this.registerNavLight(navRed, false);
    this.registerNavLight(navGreen, false);
    this.registerNavLight(beaconL, true);
    this.registerNavLight(beaconR, true);
  }

  /** WARLOCK — heavy gunship: bulky hull, wide wings, dual rotor mast, heavy ordnance. */
  private buildWarlock(
    baseGroup: THREE.Group,
    bodyMat: THREE.MeshToonMaterial,
    darkBodyMat: THREE.MeshToonMaterial,
    glassMat: THREE.MeshToonMaterial,
    metalMat: THREE.MeshToonMaterial,
    bladeMat: THREE.MeshToonMaterial,
    accentMat: THREE.MeshToonMaterial,
  ) {
    const hull = createBox(2.5, 1.9, 6.6, 0x3a4436);
    hull.material = bodyMat;
    baseGroup.add(hull);

    // Armored nose
    const nose = createBox(1.8, 1.5, 2.2, 0x3a4436);
    nose.material = bodyMat;
    nose.position.set(0, -0.1, 4.2);
    baseGroup.add(nose);

    // Flat armored canopy
    const canopy = createBox(1.5, 0.7, 1.9, 0x1c2b33);
    canopy.material = glassMat;
    canopy.position.set(0, 0.9, 3.4);
    canopy.rotation.x = -0.12;
    baseGroup.add(canopy);

    // Chunky engine nacelles
    const nacelleL = createBox(1.2, 1.2, 3.2, 0x1a211a);
    nacelleL.material = darkBodyMat;
    nacelleL.position.set(-1.7, 0.4, -0.6);
    const nacelleR = nacelleL.clone();
    nacelleR.position.x = 1.7;
    baseGroup.add(nacelleL, nacelleR);

    // Broad wing spar with hardpoints
    const wingL = createBox(4.6, 0.3, 1.6, 0x3a4436);
    wingL.material = bodyMat;
    wingL.position.set(-2.8, -0.3, 0.3);
    wingL.rotation.z = 0.03;
    const wingR = wingL.clone();
    wingR.position.x = 2.8;
    wingR.rotation.z = -0.03;
    baseGroup.add(wingL, wingR);

    // Heavy rocket pods under each wing
    [-2.9, -1.7, 1.7, 2.9].forEach((px) => {
      const pod = createBox(0.7, 0.7, 2.0, 0x2a3030);
      pod.material = darkBodyMat;
      pod.position.set(px, -0.85, 0.3);
      const muzzle = createBox(0.8, 0.8, 0.3, 0xb33127);
      muzzle.material = accentMat;
      muzzle.position.set(px, -0.85, 1.35);
      baseGroup.add(pod, muzzle);
    });

    // Twin tail boom
    const tailBoom = createBox(0.8, 1.0, 6.6, 0x3a4436);
    tailBoom.material = bodyMat;
    tailBoom.position.set(0, 0.2, -6.2);
    baseGroup.add(tailBoom);

    const tailFin = createBox(0.35, 2.6, 1.5, 0x1a211a);
    tailFin.material = darkBodyMat;
    tailFin.position.set(0, 1.3, -9.0);
    tailFin.rotation.x = 0.14;
    baseGroup.add(tailFin);

    const stabilizerL = createBox(2.6, 0.2, 1.0, 0x3a4436);
    stabilizerL.material = bodyMat;
    stabilizerL.position.set(-1.6, 0.3, -8.4);
    const stabilizerR = stabilizerL.clone();
    stabilizerR.position.x = 1.6;
    baseGroup.add(stabilizerL, stabilizerR);

    // Heavy landing skids
    const skidL = createBox(0.3, 0.3, 2.6, 0x5a6360);
    skidL.material = metalMat;
    skidL.position.set(-1.6, -1.1, 0.6);
    const skidR = skidL.clone();
    skidR.position.x = 1.6;
    const skidRear = createBox(0.3, 0.3, 2.2, 0x5a6360);
    skidRear.material = metalMat;
    skidRear.position.set(0, -1.0, -4.6);
    baseGroup.add(skidL, skidR, skidRear);

    // Signature details: intake glows + wingtip nav lights + roof beacon (Warlock)
    const intakeL = createGlowBox(0.5, 0.4, 0.2, 0xff8833, 0.8);
    intakeL.position.set(-1.7, 0.9, -2.2);
    const intakeR = intakeL.clone();
    intakeR.position.x = 1.7;
    const navRed = createGlowBox(0.24, 0.24, 0.24, 0xff2244, 0.9);
    navRed.position.set(-4.9, -0.2, 0.3);
    const navGreen = createGlowBox(0.24, 0.24, 0.24, 0x22ff66, 0.9);
    navGreen.position.set(4.9, -0.2, 0.3);
    const roofBeacon = createGlowBox(0.2, 0.2, 0.2, 0xffaa33, 0.9);
    roofBeacon.position.set(0, 1.6, 0.6);
    const antenna = createBox(0.07, 0.8, 0.07, 0x5a6360);
    antenna.material = metalMat;
    antenna.position.set(-0.8, 1.3, 0.7);
    baseGroup.add(intakeL, intakeR, navRed, navGreen, roofBeacon, antenna);
    this.registerNavLight(navRed, false);
    this.registerNavLight(navGreen, false);
    this.registerNavLight(roofBeacon, true);
  }

  setTarget(x: number, y: number, z: number) {
    this.targetPosition.set(x, y, z);
  }

  setAim(x: number, z: number) {
    this.aimPosition.set(x, 26, z);
  }

  setHoverFloor(height: number) {
    this.hoverFloor = height;
  }

  /**
   * Phase 2 — vertical control, fully separate from horizontal movement.
   * Manual climb/descend input is velocity-based (own accel/brake/cap), then
   * two guards layer on top:
   *   • terrain safety floor — never descend below hoverFloor + clearance;
   *   • soft altitude cap near maxAltitude (control eases out, no hard snap).
   */
  private applyVerticalControl(
    time: number,
    delta: number,
    inputY: number,
    engineEff: number,
    rotorEff: number,
    cargoMultiplier: number = 1,
  ) {
    const cfg = MOVEMENT_CONFIG;
    this.smoothedHoverFloor +=
      (this.hoverFloor - this.smoothedHoverFloor) *
      (1 - Math.exp(-(this.hoverFloor > this.smoothedHoverFloor ? 14 : 10) * delta));

    const safetyFloorY = this.smoothedHoverFloor + cfg.hoverClearance;
    const clearance = this.body.position.y - safetyFloorY;
    if (this.terrainSafetyActive) {
      if (clearance > cfg.terrainFloorExit) this.terrainSafetyActive = false;
    } else if (clearance < cfg.terrainFloorEnter) {
      this.terrainSafetyActive = true;
    }

    let desiredVy = inputY * cfg.maxVerticalSpeed * engineEff * cargoMultiplier;

    // Hover-settle spring: with no vertical input near the floor, ease down
    // onto a damped spring so landings have weight. The safety floor below
    // still wins when penetration occurs, and the spring is capped so it
    // never feels like a vacuum suction.
    if (Math.abs(inputY) < 0.01) {
      const floorY = this.smoothedHoverFloor + cfg.hoverClearance;
      const heightAbove = this.body.position.y - floorY;
      if (heightAbove < HOVER_SPRING.RANGE && heightAbove > -3) {
        const springAccel = -HOVER_SPRING.K * heightAbove - HOVER_SPRING.DAMP * this.body.velocity.y;
        desiredVy = THREE.MathUtils.clamp(
          this.body.velocity.y + springAccel * delta,
          -HOVER_SPRING.MAX_SETTLE,
          HOVER_SPRING.MAX_SETTLE,
        );
      }
    }

    if (this.terrainSafetyActive) {
      if (desiredVy < 0) desiredVy = 0;
      const safetyCorrection = safetyFloorY - this.body.position.y;
      if (safetyCorrection > 0) {
        desiredVy = Math.max(desiredVy, Math.min(18, safetyCorrection * 12));
      }

      // Hard correction is reserved for actual roof penetration, not merely
      // entering the preferred clearance band. This avoids roof-edge altitude snaps.
      const hardFloorY = this.hoverFloor + 1.25;
      const hardPenetration = hardFloorY - this.body.position.y;
      if (hardPenetration > cfg.terrainHardCorrectionDepth) {
        this.body.position.y = hardFloorY;
        this.body.velocity.y = Math.max(0, this.body.velocity.y);
      }
    }
    if (this.body.position.y > cfg.maxAltitude - 4 && desiredVy > 0) {
      desiredVy *= Math.max(0, (cfg.maxAltitude - this.body.position.y) / 4);
    }

    const currentVy = this.body.velocity.y;
    const reversing = desiredVy * currentVy < 0;
    const slowing = Math.abs(desiredVy) < Math.abs(currentVy);
    const acceleration =
      (reversing
        ? cfg.verticalReverseAcceleration
        : slowing
          ? cfg.verticalBraking
          : cfg.verticalAcceleration) * rotorEff * cargoMultiplier;
    const maxChange = acceleration * delta;
    this.body.velocity.y += THREE.MathUtils.clamp(desiredVy - currentVy, -maxChange, maxChange);
    if (desiredVy === 0 && Math.abs(this.body.velocity.y) <= maxChange) this.body.velocity.y = 0;
    this.desiredVelocity.y = desiredVy;
  }

  takeDamage(amount: number) {
    // Randomly distribute damage to subsystems based on a threshold
    const criticalThreshold = 0.4; // 40% chance of subsystem damage per hit
    if (Math.random() < criticalThreshold) {
      if (Math.random() > 0.5) {
        this.engineHealth = Math.max(0, this.engineHealth - amount * 0.5);
      } else {
        this.rotorHealth = Math.max(0, this.rotorHealth - amount * 0.5);
      }
    }
  }

  /** Kept for the collision API; Phase 1 intentionally disables crash wobble. */
  triggerCrashTilt(_strength: number) {
    this.crashTiltTimer = 0;
  }

  /** Point the chin gun turret at a world position (auto-aim). Pass active=false to return to neutral. */
  setGunAim(x: number, y: number, z: number, active: boolean) {
    const validTarget =
      active && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
    this.gunAimMode = validTarget;
    if (validTarget) this.gunAimTarget.set(x, y, z);
  }

  /** Phase 3: MG recoil — kick the barrel/muzzle back, spring returns fast.
   *  Visual only; pivots (auto-aim yaw/pitch math) are never touched. */
  triggerRecoil(amount: number) {
    this.gunRecoil = Math.min(Helicopter.GUN_RECOIL_MAX, Math.max(this.gunRecoil, amount));
  }

  /** Phase 3: tiny clamped nose kick for heavy weapons (missiles/rockets). */
  triggerFirePitch(amount: number) {
    this.firePitchImpulse = Math.min(Helicopter.FIRE_PITCH_MAX, Math.max(this.firePitchImpulse, amount));
  }

  /**
   * A3: external knockback (explosion blasts, heavy-weapon recoil). Applies
   * an instant velocity kick and tracks it in impulseVelocity, which the
   * velocity controller folds into its desired velocity — the push decays
   * smoothly instead of being braked away. Horizontal only.
   */
  addImpulse(ix: number, iz: number) {
    if (!Number.isFinite(ix) || !Number.isFinite(iz)) return;
    const nx = this.impulseVelocity.x + ix;
    const nz = this.impulseVelocity.y + iz;
    const mag = Math.sqrt(nx * nx + nz * nz);
    const scale = mag > Helicopter.MAX_IMPULSE ? Helicopter.MAX_IMPULSE / mag : 1;
    const appliedX = nx * scale - this.impulseVelocity.x;
    const appliedZ = nz * scale - this.impulseVelocity.y;
    this.impulseVelocity.x = nx * scale;
    this.impulseVelocity.y = nz * scale;
    this.body.velocity.x += appliedX;
    this.body.velocity.z += appliedZ;
  }

  /** Advance the visual recoil/fire-pitch spring back to rest. */
  private updateFireFeedback(delta: number) {
    if (this.gunRecoil > 0.0005) {
      this.gunRecoil *= Math.exp(-Helicopter.GUN_RECOIL_RESPONSE * delta);
      if (this.gunRecoil < 0.0005) this.gunRecoil = 0;
    }
    if (this.gunBarrelMesh && this.gunMuzzleMesh) {
      this.gunBarrelMesh.position.z = 1.0 - this.gunRecoil * 0.55;
      this.gunMuzzleMesh.position.z = 2.05 - this.gunRecoil;
      this.gunMuzzlePoint.position.z = 2.18 - this.gunRecoil;
    }
    if (this.firePitchImpulse > 0.0005) {
      this.firePitchImpulse *= Math.exp(-Helicopter.FIRE_PITCH_RESPONSE * delta);
      if (this.firePitchImpulse < 0.0005) this.firePitchImpulse = 0;
    }
  }

  /** Get the current muzzle world position (fire origin for gun projectiles).
   *  Walks the pivot hierarchy: mesh → gunYawPivot → gunPitchPivot → muzzle. */
  getMuzzlePosition(target: THREE.Vector3): THREE.Vector3 {
    this.gunMuzzlePoint.updateWorldMatrix(true, false);
    return this.gunMuzzlePoint.getWorldPosition(target);
  }

  /** Read the exact world-space +Z axis of MuzzlePoint without allocating. */
  getMuzzleDirection(target: THREE.Vector3): THREE.Vector3 {
    this.gunMuzzlePoint.updateWorldMatrix(true, false);
    this.gunMuzzlePoint.getWorldQuaternion(this.gunWorldQuaternion);
    return target.set(0, 0, 1).applyQuaternion(this.gunWorldQuaternion).normalize();
  }

  repair(percent: number) {
    this.engineHealth = Math.min(100, this.engineHealth + percent);
    this.rotorHealth = Math.min(100, this.rotorHealth + percent);
  }

  reset() {
    this.active = true;
    this.rotorHealth = 100;
    this.engineHealth = 100;
    this.hoverFloor = 0;
    this.smoothedHoverFloor = 0;
    this.crashTiltTimer = 0;
    this.crashTiltStrength = 1;
    this.idleBlend = 0;
    this.idleBobY = 0;
    this.bodyYawVelocity = 0;
    this.gunAimMode = false;
    this.terrainSafetyActive = false;
    this.trailEffectTimer = 0;
    this.damageEffectTimer = 0;
    this.previousVelocity.set(0, 0, 0);
    this.desiredVelocity.set(0, 0, 0);
    this.currentAcceleration.set(0, 0, 0);
    this.filteredAcceleration.set(0, 0, 0);
    this.impulseVelocity.set(0, 0);
    this.gunYawPivot.rotation.y = 0;
    this.gunPitchPivot.rotation.x = 0;
    this.targetPosition.set(0, FLIGHT_SPEC.spawnAltitude, 0);
    this.lastTargetPosition.set(0, FLIGHT_SPEC.spawnAltitude, 0);
    this.aimPosition.set(0, FLIGHT_SPEC.spawnAltitude, -30);
    this.body.position.set(0, FLIGHT_SPEC.spawnAltitude, 0);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.force.set(0, 0, 0);
    this.body.torque.set(0, 0, 0);
    this.mesh.position.set(0, FLIGHT_SPEC.spawnAltitude, 0);
    this.mesh.rotation.set(0, 0, 0);
    this.mesh.visible = true; // the death explosion hides the wreck — restore on restart
  }

  /** Horizontal speed (u/s) reported by the flight controller — drives rotor
   *  animation and the trailing chase camera's speed ratio. */
  lastHorizSpeed: number = 0;

  /**
   * Heading-relative arcade flight core (FLIGHT_SPEC). Separates the logical
   * flight state (heading + momentum + altitude) from the visual airframe
   * pose: the mesh Euler order is YXZ, i.e. exactly
   *   RotationY(playerHeading) → RotationX(playerPitch) → RotationZ(playerRoll)
   * with pitch/roll eased toward their targets at `1 - exp(-10 * dt)`.
   */
  private applyHeadingRelativeFlight(
    time: number,
    delta: number,
    move?: MovementCommand,
    engineEff: number = 1,
    rotorEff: number = 1,
  ) {
    const S = FLIGHT_SPEC;
    const body = this.body;

    // Inputs are heading-relative: rudder +1 turns right (D/→), x +1 strafes
    // right (E), z +1 thrusts forward along heading (W/↑), y +1 climbs (Shift).
    const rudder = THREE.MathUtils.clamp(move?.yaw ?? 0, -1, 1);
    const strafe = THREE.MathUtils.clamp(move?.x ?? 0, -1, 1);
    const thrust = THREE.MathUtils.clamp(move?.z ?? 0, -1, 1);
    const vert = THREE.MathUtils.clamp(move?.y ?? 0, -1, 1);
    const cargo = move?.cargoMultiplier ?? 1;

    // Heading frame. forwardVector = (sin h, 0, cos h) matches the mesh's own
    // rotation.y, so increasing the heading swings the nose LEFT (three.js is
    // right-handed; the +Z nose's right side is −X). The aircraft's true
    // right/strafe vector is therefore (−cos h, 0, sin h).
    let heading = this.mesh.rotation.y;
    const cy = Math.cos(heading);
    const sy = Math.sin(heading);
    const fwdX = sy;
    const fwdZ = cy;
    const rightX = -cy;
    const rightZ = sy;

    // ---- Rudder yaw with smooth angular acceleration / deceleration ------
    // Rudder input is +1 = turn RIGHT (D), and heading velocity is positive
    // when turning LEFT — so the demand is negated.
    const yawDemand = -rudder * S.turnRate * rotorEff;
    const yawResp = Math.abs(rudder) > 0.001 ? S.yawAccelResponse : S.yawDecelResponse;
    this.bodyYawVelocity += (yawDemand - this.bodyYawVelocity) * (1 - Math.exp(-yawResp * delta));
    if (Math.abs(rudder) < 0.001 && Math.abs(this.bodyYawVelocity) < 0.006) {
      this.bodyYawVelocity = 0;
    }
    heading += this.bodyYawVelocity * delta;
    while (heading > Math.PI) heading -= Math.PI * 2;
    while (heading < -Math.PI) heading += Math.PI * 2;

    // ---- Cyclic propulsion + lateral strafe with linear momentum drag -----
    // demand = normalized (thrust·fwd + strafe·right) clamped to unit circle.
    let demandX = fwdX * thrust + rightX * strafe;
    let demandZ = fwdZ * thrust + rightZ * strafe;
    let demandMag = Math.hypot(thrust, strafe);
    if (demandMag > 1.0001) {
      const k = 1 / demandMag;
      demandX *= k;
      demandZ *= k;
      demandMag = 1;
    }

    let vx = body.velocity.x * Math.exp(-S.drag * delta);
    let vz = body.velocity.z * Math.exp(-S.drag * delta);
    if (demandMag > 0.001) {
      const accel = S.forwardAccel * engineEff * cargo;
      vx += demandX * accel * delta;
      vz += demandZ * accel * delta;
    }

    // External knockback (explosion blasts) rides on top and decays itself.
    if (this.impulseVelocity.x !== 0 || this.impulseVelocity.y !== 0) {
      vx += this.impulseVelocity.x * delta;
      vz += this.impulseVelocity.y * delta;
      this.impulseVelocity.multiplyScalar(Math.exp(-Helicopter.IMPULSE_DECAY * delta));
      if (Math.abs(this.impulseVelocity.x) < 0.05 && Math.abs(this.impulseVelocity.y) < 0.05) {
        this.impulseVelocity.set(0, 0);
      }
    }

    // Hard cruise clamp at the spec top speed.
    const horizSpeed = Math.hypot(vx, vz);
    if (horizSpeed > S.maxForwardSpeed) {
      const k = S.maxForwardSpeed / horizSpeed;
      vx *= k;
      vz *= k;
    }
    body.velocity.x = vx;
    body.velocity.z = vz;
    this.desiredVelocity.x = vx;
    this.desiredVelocity.z = vz;
    this.lastHorizSpeed = Math.hypot(vx, vz);

    // ---- Collective vertical lift: Shift +9.5 u/s, Ctrl −8.0 u/s ----------
    let targetVy =
      vert > 0 ? S.climbRate * vert : vert < 0 ? S.sinkRate * vert : 0;
    targetVy *= engineEff * cargo;
    const vyStep = S.verticalAccel * delta;
    body.velocity.y += THREE.MathUtils.clamp(targetVy - body.velocity.y, -vyStep, vyStep);
    if (vert === 0 && Math.abs(body.velocity.y) <= vyStep) body.velocity.y = 0;

    // Terrain-following envelope (smoothed hover floor = ground or rooftop
    // beneath the hull): strictly [floor + 2.4 m, floor + 26 m].
    this.smoothedHoverFloor +=
      (this.hoverFloor - this.smoothedHoverFloor) *
      (1 - Math.exp(-(this.hoverFloor > this.smoothedHoverFloor ? 12 : 9) * delta));
    const minY = this.smoothedHoverFloor + S.groundCushion;
    const maxY = this.smoothedHoverFloor + S.ceiling;
    let py = body.position.y;
    if (py <= minY) {
      py = minY;
      if (body.velocity.y < 0) body.velocity.y = 0;
    } else if (py >= maxY) {
      py = maxY;
      if (body.velocity.y > 0) body.velocity.y = 0;
    }
    body.position.y = py;
    this.desiredVelocity.y = body.velocity.y;

    // ---- Aerodynamic tilting (visual only; logical state stays above) -----
    // pitch: accelerating forward (+thrust) drops the nose; braking/reverse
    // raises it. roll: banks into the turn and into strafes (euler −z = right
    // bank). Heavy-weapon recoil kick (firePitchImpulse) adds a nose bob.
    const pitchTarget = THREE.MathUtils.clamp(
      thrust * S.maxPitch + this.firePitchImpulse,
      -S.maxPitch,
      S.maxPitch,
    );
    // Bank into the lateral demand: positive euler roll (z) tips the aircraft
    // up toward its OWN right side, so a right turn / right strafe banks right.
    const lateralDemand = THREE.MathUtils.clamp(rudder + strafe, -1, 1);
    const rollTarget = THREE.MathUtils.clamp(
      lateralDemand * S.maxRoll,
      -S.maxRoll,
      S.maxRoll,
    );
    const tiltK = 1 - Math.exp(-S.tiltResponse * delta);
    this.mesh.rotation.x += (pitchTarget - this.mesh.rotation.x) * tiltK;
    this.mesh.rotation.z += (rollTarget - this.mesh.rotation.z) * tiltK;
    this.mesh.rotation.y = heading;

    // Sync the presentation root to the kinematic body before world.step.
    this.mesh.position.set(body.position.x, body.position.y, body.position.z);

    // ---- Rotating chin gun turret (decoupled gimbal) ----------------------
    // Tracks gunAimTarget (auto-aim / mouse ground cursor) while the airframe
    // keeps flying its own heading — pilot flies one way, fires another.
    const trackingSpeed = Helicopter.GUN_TRACKING_SPEED * delta;
    if (this.gunAimMode) {
      this.mesh.updateWorldMatrix(true, false);
      this.gunTargetLocal.copy(this.gunAimTarget);
      this.mesh.worldToLocal(this.gunTargetLocal);
      this.gunTargetLocal.sub(this.gunYawPivot.position);
      let yawTarget = Math.max(
        Helicopter.GUN_YAW_MIN,
        Math.min(Helicopter.GUN_YAW_MAX, Math.atan2(this.gunTargetLocal.x, this.gunTargetLocal.z)),
      );
      let yawDiff = yawTarget - this.gunYawPivot.rotation.y;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      this.gunYawPivot.rotation.y += Math.min(Math.abs(yawDiff), trackingSpeed) * Math.sign(yawDiff);

      this.gunYawPivot.updateWorldMatrix(true, false);
      this.gunTargetLocal.copy(this.gunAimTarget);
      this.gunYawPivot.worldToLocal(this.gunTargetLocal);
      const gHoriz = Math.max(0.001, Math.hypot(this.gunTargetLocal.x, this.gunTargetLocal.z));
      const pitchTargetGun = THREE.MathUtils.clamp(
        -Math.atan2(this.gunTargetLocal.y, gHoriz),
        Helicopter.GUN_PITCH_MIN,
        Helicopter.GUN_PITCH_MAX,
      );
      const pitchDiff = pitchTargetGun - this.gunPitchPivot.rotation.x;
      this.gunPitchPivot.rotation.x +=
        Math.min(Math.abs(pitchDiff), trackingSpeed * 0.8) * Math.sign(pitchDiff);
    } else {
      const yawReturnSpeed = trackingSpeed * 0.6;
      this.gunYawPivot.rotation.y +=
        Math.min(Math.abs(this.gunYawPivot.rotation.y), yawReturnSpeed) *
        -Math.sign(this.gunYawPivot.rotation.y);
      this.gunPitchPivot.rotation.x +=
        Math.min(Math.abs(this.gunPitchPivot.rotation.x), yawReturnSpeed * 0.8) *
        -Math.sign(this.gunPitchPivot.rotation.x);
    }

    // Visual recoil springs (MG barrel kick, heavy-weapon nose bob).
    this.updateFireFeedback(delta);
  }

  update(
    time: number = 0,
    delta: number = 0.016,
    windForce?: CANNON.Vec3,
    particles?: GPUParticleSystem,
    shieldActive: boolean = false,
    speedBoostActive: boolean = false,
    hasInput: boolean = false,
    move?: MovementCommand,
  ) {
    if (!this.active) return;

    // The world has zero gravity: vertical motion belongs exclusively to the
    // explicit arcade climb/settle controller while CANNON resolves contacts.

    // Toggle and animate shield bubble
    if (this.shieldMesh) {
      this.shieldMesh.visible = shieldActive;
      if (shieldActive) {
        this.shieldMesh.rotation.y = time * 2;
        this.shieldMesh.rotation.x = time * 0.5;
        const scale = 1.0 + Math.sin(time * 6) * 0.05;
        this.shieldMesh.scale.set(scale, scale, scale);
      }
    }

    this.trailEffectTimer = Math.max(0, this.trailEffectTimer - delta);
    this.damageEffectTimer = Math.max(0, this.damageEffectTimer - delta);

    // Fixed-cadence trails avoid frame-rate-dependent random work in movement.
    if (particles && speedBoostActive && this.trailEffectTimer === 0) {
      this.trailEffectTimer = 0.05;
      const leftTip = this.leftTrailPoint.set(-1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
      const rightTip = this.rightTrailPoint.set(1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
      particles.spawnSmoke(leftTip.x, leftTip.y, leftTip.z, time);
      particles.spawnSmoke(rightTip.x, rightTip.y, rightTip.z, time);
    }

    if (this.dashTimer > 0) {
      this.dashTimer -= delta;

      // Visual rotation during dash
      const progress = 1.0 - (this.dashTimer / this.dashDuration);
      if (this.dashTimer <= 0) {
        // Dash finished: snap the pose back to identity (2π ≡ 0) so the tilt
        // controller resumes from a clean baseline instead of unwinding a full turn.
        this.mesh.rotation.x = 0;
        this.mesh.rotation.z = 0;
      } else {
        const dashPose = Math.sin(progress * Math.PI);
        this.mesh.rotation.z = dashPose * 0.38 * -this.dashRollDirection;
        this.mesh.rotation.x = dashPose * 0.24 * this.dashPitchDirection;
      }

      copyPhysicsPos(this.mesh, this.body.position);

      if (particles && this.trailEffectTimer === 0) {
        this.trailEffectTimer = 0.04;
        const leftTip = this.leftTrailPoint.set(-1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
        const rightTip = this.rightTrailPoint.set(1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
        particles.spawnSmoke(leftTip.x, leftTip.y, leftTip.z, time);
        particles.spawnSmoke(rightTip.x, rightTip.y, rightTip.z, time);
      }

      // Dash keeps altitude control active (climb/descend still works mid-dash)
      this.applyVerticalControl(time, delta, move?.y ?? 0, 1, 1, move?.cargoMultiplier ?? 1);
      this.updateAccelerationState(delta);

      this.animateRotors(80, 60, delta);
      return;
    }

    // Subsystem Penalties
    const engineEff = 0.5 + (this.engineHealth / 100) * 0.5; // Up to 50% thrust loss
    const rotorEff = 0.4 + (this.rotorHealth / 100) * 0.6; // Up to 60% agility loss

    // Hull Damage Visuals (cached fast update on threshold change)
    const hullDamage =
      1.0 - (this.rotorHealth * 0.3 + this.engineHealth * 0.7) / 100;
    if (Math.abs(hullDamage - this.lastTonedHullDamage) > 0.008) {
      this.lastTonedHullDamage = hullDamage;
      for (let i = 0; i < this.tintedMaterials.length; i++) {
        const item = this.tintedMaterials[i];
        tempColor.setHex(0x4d171a);
        item.mat.color.copy(item.baseColor).lerp(tempColor, hullDamage * 0.75);
      }
    }

    // Damage effects use a stable cadence and never perturb player transforms.
    if (
      particles &&
      this.damageEffectTimer === 0 &&
      (this.engineHealth < 60 || this.rotorHealth < 50)
    ) {
      this.damageEffectTimer = 0.12;
      if (this.engineHealth < 60) {
        particles.spawnSmoke(
          this.mesh.position.x,
          this.mesh.position.y - 0.5,
          this.mesh.position.z,
          time,
        );
      }
      if (this.rotorHealth < 50) {
        particles.spawnSparks(
          this.mesh.position.x,
          this.mesh.position.y + 1.2,
          this.mesh.position.z,
          time,
        );
      }
    }

    // ---- Heading-relative arcade flight controller (FLIGHT_SPEC) ---------
    this.applyHeadingRelativeFlight(time, delta, move, engineEff, rotorEff);

    // Rotor / nav-light animation always follows the live flight path.
    this.animateRotors(this.lastHorizSpeed, FLIGHT_SPEC.maxForwardSpeed, delta);
    this.updateNavLights(time);

    /* ---------------------------------------------------------------------
     * Legacy Phase-2 model (camera-relative velocity-drag momentum + spring
     * auto-heading yaw, Space/Alt vertical) — replaced by the heading-
     * relative FLIGHT_SPEC controller above. Kept compiled as reference;
     * the guard below never evaluates to true.
     * ------------------------------------------------------------------- */
    if (false) {
    const cfg = MOVEMENT_CONFIG;
    const profile = MODEL_MOVEMENT[this.model];
    const moveX = move?.x ?? 0;
    const moveZ = move?.z ?? 0;
    const moveY = move?.y ?? 0;
    const cargoMultiplier = move?.cargoMultiplier ?? 1;
    const isAfterburner = false; // retired by the FLIGHT_SPEC schema

    let vx = this.body.velocity.x;
    let vz = this.body.velocity.z;
    const inputMag = Math.hypot(moveX, moveZ);

    // 1. Direct Input Thrust
    if (inputMag > 0.001) {
      const normInputX = moveX / inputMag;
      const normInputZ = moveZ / inputMag;
      const inputIntensity = Math.min(1.0, inputMag);

      // Boost multiplies thrust
      const thrustScale = (isAfterburner ? cfg.afterburnerThrustMultiplier : 1) * engineEff * cargoMultiplier * profile.accel;
      let effectiveThrust = cfg.thrust * thrustScale;

      // Reversal counter-thrust boost: when actively turning around (input opposes current velocity),
      // apply counter-acceleration for snappy arcade 180° responsiveness
      const currentSpeed = Math.hypot(vx, vz);
      if (currentSpeed > 2.0) {
        const dot = (vx * normInputX + vz * normInputZ) / currentSpeed;
        if (dot < -0.1) {
          const reversalFactor = THREE.MathUtils.clamp(-dot, 0, 1);
          effectiveThrust *= THREE.MathUtils.lerp(1.0, cfg.reverseThrustMultiplier, reversalFactor);
        }
      }

      vx += normInputX * effectiveThrust * inputIntensity * delta;
      vz += normInputZ * effectiveThrust * inputIntensity * delta;
    }

    // 2. Frame-Independent Directional Drag
    if (inputMag > 0.01) {
      const normInputX = moveX / inputMag;
      const normInputZ = moveZ / inputMag;
      // Parallel velocity (along input thrust vector)
      const vParallel = vx * normInputX + vz * normInputZ;
      // Perpendicular velocity (orthogonal drift to be damped during turns)
      const vPerpX = vx - vParallel * normInputX;
      const vPerpZ = vz - vParallel * normInputZ;

      const fwdDrag = Math.pow(cfg.flightDrag, delta * 60);
      const turnDamp = Math.pow(0.88, delta * 60);

      vx = vParallel * fwdDrag * normInputX + vPerpX * turnDamp;
      vz = vParallel * fwdDrag * normInputZ + vPerpZ * turnDamp;
    } else {
      const brakeDrag = Math.pow(cfg.brakingDrag, delta * 60);
      vx *= brakeDrag;
      vz *= brakeDrag;
    }

    // External knockback / storm wind impulse (sustained aerodynamic drift)
    if (windForce && (windForce.x !== 0 || windForce.z !== 0)) {
      const targetWindVx = THREE.MathUtils.clamp(windForce.x * 0.055, -9, 9);
      const targetWindVz = THREE.MathUtils.clamp(windForce.z * 0.055, -9, 9);
      if (inputMag <= 0.01) {
        vx += targetWindVx * (1 - Math.pow(cfg.brakingDrag, delta * 60));
        vz += targetWindVz * (1 - Math.pow(cfg.brakingDrag, delta * 60));
      } else {
        vx += targetWindVx * 4.0 * delta;
        vz += targetWindVz * 4.0 * delta;
      }
    }
    if (this.impulseVelocity.x !== 0 || this.impulseVelocity.y !== 0) {
      vx += this.impulseVelocity.x * 6.0 * delta;
      vz += this.impulseVelocity.y * 6.0 * delta;
      this.impulseVelocity.multiplyScalar(Math.exp(-Helicopter.IMPULSE_DECAY * delta));
      if (Math.abs(this.impulseVelocity.x) < 0.05 && Math.abs(this.impulseVelocity.y) < 0.05) {
        this.impulseVelocity.set(0, 0);
      }
    }

    // 3. Max Speed Cap (preserving analog magnitude scaling)
    const maxSpeed =
      cfg.maxHorizontalSpeed *
      (isAfterburner ? cfg.afterburnerMultiplier : 1) *
      (speedBoostActive ? cfg.speedBoostMultiplier : 1) *
      engineEff *
      cargoMultiplier *
      profile.speed;

    const targetMaxSpeed = inputMag > 0.01 ? maxSpeed * Math.min(1.0, inputMag) : maxSpeed;
    const speed = Math.hypot(vx, vz);
    if (speed > targetMaxSpeed && inputMag > 0.01) {
      const s = targetMaxSpeed / speed;
      vx *= s;
      vz *= s;
    }

    // Settle cleanly near zero when no input is given
    if (inputMag <= 0.01 && speed < 0.05) {
      vx = 0;
      vz = 0;
    }

    this.body.velocity.x = vx;
    this.body.velocity.z = vz;
    this.desiredVelocity.x = vx;
    this.desiredVelocity.z = vz;

    // Vertical flight control (climb/descend & terrain safety)
    this.applyVerticalControl(time, delta, moveY, engineEff, rotorEff, cargoMultiplier);
    this.updateAccelerationState(delta);

    const newVx = this.body.velocity.x;
    const newVz = this.body.velocity.z;
    const newVy = this.body.velocity.y;
    const currentHorizSpeed = Math.hypot(newVx, newVz);

    // Step 19 movement safety: abnormal speed ⇒ corrupted body — clamp and log
    // instead of letting it fly off the map and corrupt the whole sim.
    const totalSpeed = Math.hypot(currentHorizSpeed, newVy);
    if (totalSpeed > cfg.safetyMaxSpeed) {
      if (import.meta.env.DEV) {
        console.warn(
          "[Heli-Strike] abnormal player speed — clamping",
          totalSpeed.toFixed(1),
        );
      }
      const s = cfg.safetyMaxSpeed / Math.max(totalSpeed, 0.001);
      this.body.velocity.x *= s;
      this.body.velocity.y *= s;
      this.body.velocity.z *= s;
    }

    const isIdle = !hasInput && currentHorizSpeed < 3.0; // Player resting?
    // Idle hover: ease in/out of a breathing bob so a parked aircraft visibly
    // "hangs" in its own rotor wash instead of freezing mid-air.
    const idleTarget = isIdle ? 1 : 0;
    this.idleBlend += (idleTarget - this.idleBlend) * (1 - Math.exp(-2.2 * delta));

    // Body heading: physical heading blend based on speed & actual movement
    // - Low speed / stationary: follow input direction
    // - High speed: follow actual velocity vector with subtle anticipation blend
    // - Zero speed & no input: hold current heading
    let targetAngle = this.mesh.rotation.y;
    if (currentHorizSpeed > 1.5 || inputMag > 0.05) {
      if (currentHorizSpeed < 4.0 && inputMag > 0.05) {
        // Low speed start-up: follow input direction
        targetAngle = Math.atan2(moveX, moveZ);
      } else if (currentHorizSpeed >= 4.0) {
        const velHeading = Math.atan2(newVx, newVz);
        if (inputMag > 0.05) {
          const inputHeading = Math.atan2(moveX, moveZ);
          let hDiff = inputHeading - velHeading;
          while (hDiff < -Math.PI) hDiff += Math.PI * 2;
          while (hDiff > Math.PI) hDiff -= Math.PI * 2;
          // Velocity dominates heading at speed, with subtle anticipation from stick
          const inputWeight = THREE.MathUtils.lerp(
            0.30,
            0.12,
            THREE.MathUtils.clamp((currentHorizSpeed - 4.0) / 30.0, 0, 1),
          );
          targetAngle = velHeading + hDiff * inputWeight;
        } else {
          targetAngle = velHeading;
        }
      } else if (currentHorizSpeed > 1.5) {
        targetAngle = Math.atan2(newVx, newVz);
      }
    }

    // Wrap target angle to [-PI, PI]
    while (targetAngle < -Math.PI) targetAngle += Math.PI * 2;
    while (targetAngle > Math.PI) targetAngle -= Math.PI * 2;

    // Shortest-angle error
    let yawError = targetAngle - this.mesh.rotation.y;
    while (yawError < -Math.PI) yawError += Math.PI * 2;
    while (yawError > Math.PI) yawError -= Math.PI * 2;

    // Critically damped second-order angular dynamics with acceleration limits
    const springK = cfg.bodyYawSpring * profile.turn * rotorEff;
    const dampingC = cfg.bodyYawDamping * Math.sqrt(profile.turn * rotorEff);
    let angularAcceleration = yawError * springK - this.bodyYawVelocity * dampingC;

    // Clamp angular acceleration
    const maxAngularAccel = cfg.maxYawAcceleration * profile.turn;
    angularAcceleration = THREE.MathUtils.clamp(
      angularAcceleration,
      -maxAngularAccel,
      maxAngularAccel,
    );

    this.bodyYawVelocity += angularAcceleration * delta;

    // Clamp max angular velocity
    const maxYawSpeed = cfg.maxYawSpeed * profile.turn;
    this.bodyYawVelocity = THREE.MathUtils.clamp(
      this.bodyYawVelocity,
      -maxYawSpeed,
      maxYawSpeed,
    );

    // If near target and low angular speed, settle cleanly
    if (Math.abs(yawError) < 0.001 && Math.abs(this.bodyYawVelocity) < 0.01) {
      this.bodyYawVelocity = 0;
      this.mesh.rotation.y = targetAngle;
    } else {
      this.mesh.rotation.y += this.bodyYawVelocity * delta;
    }

    while (this.mesh.rotation.y < -Math.PI) this.mesh.rotation.y += Math.PI * 2;
    while (this.mesh.rotation.y > Math.PI) this.mesh.rotation.y -= Math.PI * 2;

    // Synchronize the visual root before converting world aim into turret-local space.
    copyPhysicsPos(this.mesh, this.body.position);

    // Visual-only idle bob layered on top of the physics-synced position —
    // two offset sines read as breathing, not a metronome. The physics body
    // stays authoritative; collisions and aim never see this offset. The
    // offset is cached so syncBodyTransform() can re-apply it after the
    // post-physics re-sync would otherwise wipe it.
    if (this.idleBlend > 0.001) {
      const bobT = time * 1.9 + this.idlePhase;
      this.idleBobY =
        (Math.sin(bobT) * 0.42 + Math.sin(bobT * 0.53 + 1.7) * 0.13) * this.idleBlend;
      this.mesh.position.y += this.idleBobY;
    } else {
      this.idleBobY = 0;
    }

    // Rotating chin gun turret (separate yaw/pitch pivots) — tracks the auto-aim
    // target, or eases to neutral. ONLY the gun moves; the helicopter body stays
    // on its flight course. Yaw rotates gunYawPivot (horizontal), pitch rotates
    // gunPitchPivot (vertical, child of yaw). Limits prevent the gun from
    // pointing through the cockpit.
    const H = Helicopter;
    const trackingSpeed = H.GUN_TRACKING_SPEED * delta;

    if (this.gunAimMode) {
      // Convert the target through the complete visual parent transform. This
      // keeps turret aim correct while the helicopter is banked or pitched.
      this.mesh.updateWorldMatrix(true, false);
      this.gunTargetLocal.copy(this.gunAimTarget);
      this.mesh.worldToLocal(this.gunTargetLocal);
      this.gunTargetLocal.sub(this.gunYawPivot.position);
      let yawTarget = Math.atan2(this.gunTargetLocal.x, this.gunTargetLocal.z);
      yawTarget = Math.max(H.GUN_YAW_MIN, Math.min(H.GUN_YAW_MAX, yawTarget));
      // Shortest-path angle wrapping
      let yawDiff = yawTarget - this.gunYawPivot.rotation.y;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      this.gunYawPivot.rotation.y += Math.min(Math.abs(yawDiff), trackingSpeed) * Math.sign(yawDiff);

      // Evaluate pitch in the live yaw-pivot frame, not world space.
      this.gunYawPivot.updateWorldMatrix(true, false);
      this.gunTargetLocal.copy(this.gunAimTarget);
      this.gunYawPivot.worldToLocal(this.gunTargetLocal);
      const gHoriz = Math.max(0.001, Math.hypot(this.gunTargetLocal.x, this.gunTargetLocal.z));
      const pitchTarget = THREE.MathUtils.clamp(
        -Math.atan2(this.gunTargetLocal.y, gHoriz),
        H.GUN_PITCH_MIN,
        H.GUN_PITCH_MAX,
      );
      const pitchDiff = pitchTarget - this.gunPitchPivot.rotation.x;
      this.gunPitchPivot.rotation.x += Math.min(Math.abs(pitchDiff), trackingSpeed * 0.8) * Math.sign(pitchDiff);
    } else {
      // No target — ease back to neutral forward position
      const yawReturnSpeed = trackingSpeed * 0.6;
      this.gunYawPivot.rotation.y += Math.min(Math.abs(this.gunYawPivot.rotation.y), yawReturnSpeed) * -Math.sign(this.gunYawPivot.rotation.y);
      this.gunPitchPivot.rotation.x += Math.min(Math.abs(this.gunPitchPivot.rotation.x), yawReturnSpeed * 0.8) * -Math.sign(this.gunPitchPivot.rotation.x);
    }

    // Phase 3: visual recoil + heavy-weapon nose kick — barrel/muzzle only and
    // a tiny clamped mesh pitch, both springing back to rest.
    this.updateFireFeedback(delta);

    const cy = Math.cos(this.mesh.rotation.y);
    const sy = Math.sin(this.mesh.rotation.y);

    // Transform filtered acceleration into helicopter local space (Z forward, X right)
    const accelX = this.filteredAcceleration.x;
    const accelZ = this.filteredAcceleration.z;
    const localAx = accelX * cy - accelZ * sy;
    const localAz = accelX * sy + accelZ * cy;

    const ROLL_LIMIT = cfg.maxRoll;
    const PITCH_LIMIT = cfg.maxPitch;

    // Auto-Stabilization: Suppress tilt if idling to gently correct rotation
    const tiltMultiplier = isIdle ? 0.22 : 1.0;

    // Lateral acceleration + centrifugal turn angular velocity creates deep dynamic banking
    const turnCentrifugalRoll = -this.bodyYawVelocity * 0.055;
    let targetTiltZ = -THREE.MathUtils.clamp(
      (localAx * 0.0022 + turnCentrifugalRoll) * tiltMultiplier,
      -ROLL_LIMIT,
      ROLL_LIMIT,
    );

    // Longitudinal acceleration creates pitch (nose-down on forward thrust, nose-up on braking)
    const targetTiltX = THREE.MathUtils.clamp(
      localAz * 0.00175 * tiltMultiplier,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );

    const climbPitch = THREE.MathUtils.clamp(-newVy * 0.0022, -0.09, 0.09);

    // Gentle figure-eight sway while hovering idle — the hull drifts a few
    // degrees in roll/pitch like a real helicopter holding station.
    if (this.idleBlend > 0.001) {
      targetTiltZ = THREE.MathUtils.clamp(
        targetTiltZ + Math.sin(time * 0.9 + this.idlePhase * 1.3) * 0.022 * this.idleBlend,
        -ROLL_LIMIT,
        ROLL_LIMIT,
      );
    }

    const targetPitch = THREE.MathUtils.clamp(
      targetTiltX + climbPitch + this.firePitchImpulse +
        Math.sin(time * 0.7 + this.idlePhase) * 0.012 * this.idleBlend,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );

    // Asymmetric bank response: faster lean-in (~0.12s), smoother return to neutral (~0.20s)
    const bankRespX =
      Math.abs(targetPitch) >= Math.abs(this.mesh.rotation.x)
        ? cfg.bankResponse
        : cfg.bankReturnResponse;
    const bankRespZ =
      Math.abs(targetTiltZ) >= Math.abs(this.mesh.rotation.z)
        ? cfg.bankResponse
        : cfg.bankReturnResponse;

    this.mesh.rotation.x +=
      (targetPitch - this.mesh.rotation.x) * (1 - Math.exp(-bankRespX * profile.bank * delta));
    this.mesh.rotation.z +=
      (targetTiltZ - this.mesh.rotation.z) * (1 - Math.exp(-bankRespZ * profile.bank * delta));

    // Rotor animation never perturbs the helicopter transform.
    this.mainRotor.position.y = 2.1;

    this.animateRotors(currentHorizSpeed, 80, delta);
    this.updateNavLights(time);
    } // -- end legacy Phase-2 (unreachable) block --
  }

  /**
   * Detach a glow light from the shared material cache so its opacity can be
   * pulsed without affecting other glow boxes of the same color.
   */
  private registerNavLight(mesh: THREE.Mesh, beacon: boolean) {
    mesh.material = (mesh.material as THREE.Material).clone();
    (beacon ? this.beaconMeshes : this.navLightMeshes).push(mesh);
  }

  /** Nav lights breathe softly; beacons fire a double-flash anti-collision strobe. */
  updateNavLights(time: number) {
    for (const light of this.navLightMeshes) {
      const breathe = 0.5 + Math.sin(time * 2.4 + this.idlePhase) * 0.5;
      (light.material as THREE.MeshBasicMaterial).opacity = 0.62 + breathe * 0.28;
    }
    for (const beacon of this.beaconMeshes) {
      const cycle = (time * 1.25 + this.idlePhase * 0.15) % 1;
      const flashing = cycle < 0.06 || (cycle > 0.14 && cycle < 0.2);
      (beacon.material as THREE.MeshBasicMaterial).opacity = flashing ? 0.95 : 0.18;
    }
  }

  /** Synchronize the presentation root after CANNON integrates the player body. */
  syncBodyTransform() {
    if (this.active) {
      copyPhysicsPos(this.mesh, this.body.position);
      // Restore the visual-only idle bob that the raw copy just erased.
      if (this.idleBobY !== 0) this.mesh.position.y += this.idleBobY;
    }
  }

  private updateAccelerationState(delta: number) {
    if (delta <= 0 || !Number.isFinite(delta)) return;
    const invDelta = 1 / delta;
    const rawX = THREE.MathUtils.clamp(
      (this.body.velocity.x - this.previousVelocity.x) * invDelta,
      -450,
      450,
    );
    const rawY = THREE.MathUtils.clamp(
      (this.body.velocity.y - this.previousVelocity.y) * invDelta,
      -300,
      300,
    );
    const rawZ = THREE.MathUtils.clamp(
      (this.body.velocity.z - this.previousVelocity.z) * invDelta,
      -450,
      450,
    );
    this.currentAcceleration.set(rawX, rawY, rawZ);
    const alpha = 1 - Math.exp(-MOVEMENT_CONFIG.visualAccelerationSmoothing * delta);
    this.filteredAcceleration.x += (rawX - this.filteredAcceleration.x) * alpha;
    this.filteredAcceleration.y += (rawY - this.filteredAcceleration.y) * alpha;
    this.filteredAcceleration.z += (rawZ - this.filteredAcceleration.z) * alpha;
    this.previousVelocity.copy(this.body.velocity);
  }

  rotorSpeed: number = 0;
  crashTiltTimer: number = 0;
  crashTiltStrength: number = 1;

  // Idle hover: blend factor eases the breathing bob in/out; the random phase
  // keeps multiple lifetimes from bobbing in lockstep. idleBobY caches the
  // last visual offset so post-physics re-syncs can re-apply it.
  private idleBlend: number = 0;
  private idleBobY: number = 0;
  private readonly idlePhase: number = Math.random() * Math.PI * 2;
  /** Wingtip nav lights (steady pulse) and anti-collision beacons (strobe). */
  private navLightMeshes: THREE.Mesh[] = [];
  private beaconMeshes: THREE.Mesh[] = [];

  animateRotors(forceMag: number, maxForce: number, delta: number) {
    const rotorEff = this.rotorHealth / 100;
    
    // Store angular speed in radians per second so animation is independent of frame rate.
    const load = THREE.MathUtils.clamp(forceMag / Math.max(maxForce, 1), 0, 1);
    const targetSpeed = (42 + load * 24) * rotorEff;
    const spool = 1 - Math.exp(-delta * 8.0);
    this.rotorSpeed = THREE.MathUtils.lerp(this.rotorSpeed, targetSpeed, spool);

    // Limit visual speed to prevent severe strobe/wagon-wheel effect at 60fps
    // 25 rad/s = ~23 degrees per frame, which is safely under the 45 degree Nyquist limit for a 4-blade rotor.
    const visualSpeed = Math.min(this.rotorSpeed, 25);
    this.mainRotor.rotation.y -= visualSpeed * delta;
    this.tailRotor.rotation.x -= visualSpeed * 1.35 * delta;

    // Fade the blur discs in smoothly as rotor speed rises (no binary pop).
    // Main and tail discs share one material, so one opacity write covers both.
    const blurT = THREE.MathUtils.clamp((this.rotorSpeed - 20) / 10, 0, 1);
    const blurDisc = this.mainRotor.getObjectByName("rotorBlur") as THREE.Mesh | undefined;
    const tailBlurDisc = this.tailRotor.getObjectByName("tailBlur");

    if (blurDisc) {
      blurDisc.visible = blurT > 0.02;
      (blurDisc.material as THREE.MeshBasicMaterial).opacity = 0.24 * blurT;
    }
    if (tailBlurDisc) tailBlurDisc.visible = blurT > 0.02;

    // Do not hide blades, let them spin inside the blur disc for a better visual effect
    this.mainRotor.children.forEach(c => {
      if (c.name !== "rotorBlur" && c.type === "Group") c.visible = true;
    });
    this.tailRotor.children.forEach(c => {
      if (c.name !== "tailBlur" && c.type === "Group") c.visible = true;
    });
  }
}


export class Enemy extends Entity {
  private static _nextEnemyId = 1;
  readonly id: number = Enemy._nextEnemyId++;
  ring: THREE.Object3D;
  hp: number;
  maxHp: number;
  type: EnemyType;
  variant: EnemyVariant = EnemyVariant.STANDARD;
  modifier: EnemyModifier = EnemyModifier.NONE;
  pattern: AttackPattern = AttackPattern.CHASE;
  isElite: boolean = false;
  isPriorityTarget: boolean = false;
  priorityMarkerMesh: THREE.Group | null = null;
  missionTargetId?: string;
  flankDir: number = 1;

  setPriorityTarget(active: boolean) {
    this.isPriorityTarget = active;
    if (active) {
      if (!this.priorityMarkerMesh) {
        const markerGroup = new THREE.Group();
        markerGroup.name = "PriorityTargetMarker";

        // Animated golden octahedron / diamond marker
        const diamondGeo = new THREE.OctahedronGeometry(1.2, 0);
        const diamondMat = new THREE.MeshBasicMaterial({
          color: 0xffd43b,
          wireframe: true,
          transparent: true,
          opacity: 0.95,
        });
        const diamond = new THREE.Mesh(diamondGeo, diamondMat);
        diamond.position.y = 3.6;
        markerGroup.add(diamond);

        // Ground/underneath priority ring
        const ringGeo = new THREE.RingGeometry(2.2, 2.8, 16);
        ringGeo.rotateX(-Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffaa00,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.7,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.y = 0.25;
        markerGroup.add(ring);

        this.mesh.add(markerGroup);
        this.priorityMarkerMesh = markerGroup;
      }
      this.priorityMarkerMesh.visible = true;
    } else if (this.priorityMarkerMesh) {
      this.priorityMarkerMesh.visible = false;
    }
  }

  // Variant system: role-driven behavior + telegraphs + support effects.
  /** Multiplied into incoming damage; shield drones set this on their allies. */
  incomingDamageMult: number = 1;
  /** 0 idle / 1 telegraph / 2 active (firing or diving) / 3 cooldown. */
  variantPhase: number = 0;
  variantTimer: number = 0;
  /** Flat telegraph ring under the unit (kamikaze / rocket / missile / siege). */
  variantTelegraph: THREE.Mesh | null = null;
  /** World-space marker — siege tank artillery impact ring. */
  variantMarker: THREE.Mesh | null = null;
  /** Drone → ally support beam (shield blue / repair green). */
  supportLine: THREE.Line | null = null;
  supportLineColor: number = 0x55eeff;
  supportTarget: Enemy | null = null;
  /** Missile carrier: announce MISSILE LOCK once per lock. */
  lockAnnounced: boolean = false;
  private burstShotCount = 0;
  private burstIsRockets = false;
  lastShotTime: number = 0;
  basePoints: number = 50;
  radius: number = 2.2;

  // Shield (SHIELDED modifier)
  shieldHp: number = 0;
  shieldMaxHp: number = 0;
  shieldMesh: THREE.Mesh | null = null;

  // Regeneration (REGENERATING modifier)
  lastDamageTime: number = -999;
  regenPerSecond: number = 0;
  regenMesh: THREE.Mesh | null = null;

  // B1: status effects — burn (DoT), EMP (can't fire), shock (slowed).
  // Timestamps are game seconds; enemies are constructed fresh per spawn,
  // so no reset path is needed.
  statusBurnUntil = 0;
  statusEmpUntil = 0;
  statusShockUntil = 0;
  private burnAccum = 0;
  private statusTime = 0;
  /** Burn finished this enemy off — the engine routes it through the normal
   *  kill pipeline (score/drops/affixes) instead of the silent sweep. */
  diedFromStatus = false;

  // Hit feedback: a brief emissive/color flash after taking damage. Shared
  // cached materials are cloned lazily on the first hit (clone-on-write), so
  // flashing one enemy never tints every enemy sharing the same material. The
  // per-enemy clones carry no `shared` flag, so destroy() disposes them.
  private hitFlashTimer = 0;
  private flashClones: { material: THREE.Material; baseColor: THREE.Color }[] | null = null;
  private static readonly HIT_FLASH_DURATION = 0.14;
  private static readonly HIT_FLASH_COLOR = new THREE.Color(1.0, 0.9, 0.68);
  private static readonly STATUS_TINT_BURN = new THREE.Color(1.0, 0.42, 0.08);
  private static readonly STATUS_TINT_EMP = new THREE.Color(0.35, 0.72, 1.0);
  private static readonly STATUS_TINT_SHOCK = new THREE.Color(1.0, 0.95, 0.35);

  // Attack pattern state
  patternTimer: number = 0;
  patternCooldown: number = 0;

  // Boss phases & telegraphs
  phase: 1 | 2 | 3 = 1;
  phaseTimer: number = 0;
  telegraphTimer: number = 0;
  telegraphActive: boolean = false;
  telegraphStartTime: number = 0;
  telegraphMesh: THREE.Mesh | null = null;

  // Procedural wave scaling (set by the engine at spawn)
  waveDamageMult: number = 1;
  waveFireRateMult: number = 1;
  /** Aim skill 0..1 (set by the engine from enemyAimAccuracy(wave)); tighter
   *  shot cones at higher waves. Default 1 keeps tests deterministic. */
  aimAccuracy: number = 1;
  /** Difficulty multipliers (set by the engine at spawn). */
  projSpeedMult: number = 1;
  homingMult: number = 1;

  personalityOffset: number;
  evadeTimer: number = 0;
  lastDecisionTime: number = 0;
  movementClass: EnemyMovementClass = EnemyMovementClass.GROUND;
  turretYawPivot: THREE.Group | null = null;
  gunYawPivot: THREE.Group | null = null;
  cannonPitchPivot: THREE.Group | null = null;
  muzzlePoint: THREE.Object3D | null = null;
  tankTelegraphMesh: THREE.Mesh | null = null;
  droneTelegraphMesh: THREE.Mesh | null = null;
  tankAimTimer: number = 0;
  tankState: 'MOVE' | 'STOP' | 'AIM' | 'REPOSITION' = 'MOVE';
  tankStateTimer: number = 0;
  tankCombatState: TankCombatState = TankCombatState.MOVE_TO_LANE;
  tankChosenLaneX: number = 0;
  tankChosenLaneZ: number = 0;

  // Drone 3-Layer Combat State Machine
  droneState: DroneCombatState = DroneCombatState.SPAWN_ENTRY;
  droneStateTimer: number = 0;
  assignedSectorAngle: number = 0;
  attackVectorX: number = 0;
  attackVectorZ: number = 0;
  attackRunDuration: number = 0;
  attackBurstTimer: number = 0;
  attackBurstShotsFired: number = 0;
  attackTelegraphTimer: number = 0;
  stuckCheckTimer: number = 0;
  lastStuckCheckPos: { x: number; z: number } = { x: 0, z: 0 };

  // Infantry Squad Burst Stagger
  infantryBurstRemaining: number = 0;
  infantryBurstTimer: number = 0;
  infantryBurstStagger: number = Math.random() * 0.35;

  smoothVelX: number = 0;
  smoothVelY: number = 0;
  smoothVelZ: number = 0;
  altitudeOffset: number = 0;
  airBankAngle: number = 0;
  droneCosmeticVariant: 0 | 1 = 0;
  lastObstacleCheckTime: number = 0;
  cachedSafeAltitude: number = 18;
  bossReinforcementTriggeredPhases = new Set<number>();
  heliModelData: EnemyHelicopterModelResult | null = null;
  damagePoints: EnemyDamagePoints | null = null;
  targetPoint: THREE.Object3D | null = null;
  coreGlowMesh: THREE.Mesh | null = null;
  enemyRotor: THREE.Group | null = null;
  enemyTailRotor: THREE.Group | null = null;
  aiDebugGroup: THREE.Group | null = null;
  isDying: boolean = false;
  deathSpiralTimer: number = 0;
  deathSpiralMaxTime: number = 2.2;
  deathSpiralYawRate: number = 0;
  deathSpiralRollRate: number = 0;
  deathSpiralVelY: number = 0;
  readyForRemoval: boolean = false;
  bossDamageFxTimer: number = 0;
  flybyTriggered: boolean = false;

  constructor(
    scene: THREE.Scene,
    world: CANNON.World,
    x: number,
    z: number,
    type: EnemyType = EnemyType.BASIC,
    y: number = 18,
    options: {
      modifier?: EnemyModifier;
      pattern?: AttackPattern;
      isElite?: boolean;
      variant?: EnemyVariant;
    } = {},
  ) {
    super(scene, world);
    this.type = type;
    this.modifier = options.modifier ?? EnemyModifier.NONE;
    this.pattern = options.pattern ?? AttackPattern.CHASE;
    this.isElite = Boolean(options.isElite);
    this.variant = options.variant ?? EnemyVariant.STANDARD;
    this.personalityOffset = Math.random() * Math.PI * 2;
    this.flankDir = Math.random() > 0.5 ? 1 : -1;
    this.altitudeOffset = (Math.random() - 0.5) * 6; // +/- 3m role offset
    this.droneCosmeticVariant = Math.random() > 0.5 ? 1 : 0;

    const baseGroup = new THREE.Group();

    let radius = 2.2;
    let coreHex = 0xffd92e;
    let accentHex = 0xff3b22;

    if (type === EnemyType.TANK) {
      radius = 3.0;
      coreHex = 0xffb51f;
      accentHex = 0xff2a1d;
      this.maxHp = 100;
      this.basePoints = 200;
      this.movementClass = EnemyMovementClass.GROUND;
    } else if (type === EnemyType.SHOOTER) {
      radius = 2.0;
      coreHex = 0xffe85b;
      accentHex = 0xff3b22;
      this.maxHp = 30;
      this.basePoints = 100;
      this.movementClass = EnemyMovementClass.FLYING;
    } else if (type === EnemyType.DRONE) {
      radius = 1.8;
      coreHex = 0x2e3440;
      accentHex = 0xff3344;
      this.maxHp = 22;
      this.basePoints = 150;
      this.movementClass = EnemyMovementClass.FLYING;
    } else if (type === EnemyType.BOSS) {
      radius = 4.1;
      coreHex = 0xd84cff;
      accentHex = 0x6b1fc2;
      this.maxHp = 260;
      this.basePoints = 500;
      this.movementClass = EnemyMovementClass.FLYING;
    } else {
      this.maxHp = 25; // Basic Infantry Cluster
      this.movementClass = EnemyMovementClass.GROUND;
    }

    // Elite miniboss scaling (minibosses every 5th wave)
    if (this.isElite && type !== EnemyType.BOSS) {
      this.maxHp = Math.round(this.maxHp * 1.7);
      this.basePoints = Math.round(this.basePoints * 2.2);
      radius *= 1.25;
      coreHex = 0xffdd55;
      accentHex = 0xff7722;
    }

    // Variant role on top of the base hull: hp/speed/damage/points + accent.
    if (this.variant !== EnemyVariant.STANDARD) {
      const v = ENEMY_VARIANTS[this.variant];
      this.maxHp = Math.max(4, Math.round(this.maxHp * v.hpMult));
      this.basePoints = Math.round(this.basePoints * v.pointsMult);
      accentHex = v.accent;
      if (this.variant === EnemyVariant.SCOUT_DRONE || this.variant === EnemyVariant.KAMIKAZE_DRONE) radius *= 0.85;
      if (this.variant === EnemyVariant.HEAVY_GUNSHIP) radius *= 1.35;
      if (this.variant === EnemyVariant.SIEGE_TANK) radius *= 1.15;
      if (this.variant === EnemyVariant.INTERCEPTOR) radius *= 0.85;
      if (this.variant === EnemyVariant.GATLING_HEAVY) radius *= 1.2;
    }

    this.hp = this.maxHp;
    this.radius = radius;

    // Bosses start in phase 3 (full HP ratio > 0.66) so spawn never trips a phase change
    if (type === EnemyType.BOSS) this.phase = 3;

    // Shielded modifier grants an energy shield that absorbs the first hits
    if ((this.modifier & EnemyModifier.SHIELDED) !== 0) {
      const shieldScale =
        type === EnemyType.BOSS || this.isElite ? 2.2 : type === EnemyType.TANK ? 1.6 : 1.0;
      this.shieldMaxHp = Math.round(this.maxHp * shieldScale);
      this.shieldHp = this.shieldMaxHp;
      this.basePoints += type === EnemyType.TANK ? 75 : 50;
    }

    // Regenerating modifier heals slowly when untouched
    if ((this.modifier & EnemyModifier.REGENERATING) !== 0) {
      this.regenPerSecond = Math.max(2, this.maxHp * 0.05);
    }

    if (type === EnemyType.BOSS) {
      const bossModel = EnemyHelicopterModelFactory.create({
        family: "boss",
        isElite: this.isElite,
        coreColor: coreHex,
        accentColor: accentHex,
      });
      this.heliModelData = bossModel;
      this.ring = bossModel.visualRoot;
      this.enemyRotor = bossModel.mainRotorPivot;
      this.enemyTailRotor = bossModel.tailRotorPivot;
      this.gunYawPivot = bossModel.gunYawPivot;
      this.cannonPitchPivot = bossModel.gunPitchPivot;
      this.muzzlePoint = bossModel.muzzlePoint;
      this.targetPoint = bossModel.targetPoint;
      this.damagePoints = bossModel.damagePoints;
      this.coreGlowMesh = bossModel.coreGlowMesh ?? null;

      // Telegraph beam volley geometry
      const telegraphGeo = new THREE.CylinderGeometry(0.3, 0.3, 70, 6);
      telegraphGeo.rotateX(Math.PI / 2);
      telegraphGeo.translate(0, 0, 35);
      const telegraphMat = new THREE.MeshBasicMaterial({
        color: 0xff2255,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.telegraphMesh = new THREE.Mesh(telegraphGeo, telegraphMat);
      this.telegraphMesh.visible = false;
      this.ring.add(this.telegraphMesh);

      baseGroup.add(bossModel.root);

    } else if (type === EnemyType.TANK) {
      // Tank — tracked chassis + independent TurretYawPivot + CannonPitchPivot
      this.movementClass = EnemyMovementClass.GROUND;
      this.ring = new THREE.Group();

      // Chassis group (tracks, road wheels, belly, sloped hull, skirts, exhausts)
      const chassis = new THREE.Group();
      chassis.name = "TankChassis";

      // Tracked chassis with road wheels
      [-1.5, 1.5].forEach((tx) => {
        const track = createBox(1.1, 0.8, 4.2, 0x151515);
        track.position.set(tx, 0.35, 0);
        chassis.add(track);
        for (let i = 0; i < 5; i++) {
          const wheel = createBox(0.5, 0.5, 0.22, 0x2a2a2a);
          wheel.position.set(tx, 0.35, -1.5 + i * 0.75);
          chassis.add(wheel);
        }
      });
      const belly = createBox(2.1, 0.25, 3.4, 0x111111);
      belly.position.set(0, 0.4, 0);
      chassis.add(belly);

      // Sloped hull + glacis plate + side skirts
      const hull = createBox(2.4, 0.85, 3.6, coreHex);
      hull.position.set(0, 0.85, 0);
      chassis.add(hull);
      const glacis = createBox(2.2, 0.65, 0.95, coreHex);
      glacis.position.set(0, 1.15, 1.6);
      glacis.rotation.x = -0.52;
      chassis.add(glacis);
      [-1.4, 1.4].forEach((sx) => {
        const skirt = createBox(0.12, 0.65, 3.8, 0x222222);
        skirt.position.set(sx, 0.6, 0);
        chassis.add(skirt);
      });

      // Rear engine exhaust + fuel tanks
      [-0.7, 0.7].forEach((fx) => {
        const fuelDrum = createBox(0.55, 0.55, 0.8, 0x4a4538);
        fuelDrum.position.set(fx, 0.95, -1.9);
        chassis.add(fuelDrum);
      });

      this.ring.add(chassis);

      // Decoupled Turret Yaw Pivot (mounted on top of chassis)
      this.turretYawPivot = new THREE.Group();
      this.turretYawPivot.name = "TurretYawPivot";
      this.turretYawPivot.position.set(0, 1.45, -0.2);

      // Turret main armor box + commander cupola
      const turretBody = createBox(2.1, 0.72, 2.3, accentHex);
      turretBody.position.set(0, 0.36, 0);
      this.turretYawPivot.add(turretBody);

      const cupola = createBox(0.65, 0.35, 0.65, 0x222222);
      cupola.position.set(0.55, 0.85, -0.3);
      this.turretYawPivot.add(cupola);

      // Radar dish on turret rear
      const radarPole = createBox(0.12, 0.7, 0.12, 0x333333);
      radarPole.position.set(-0.65, 0.9, -0.85);
      this.turretYawPivot.add(radarPole);
      const radarDish = createBox(0.55, 0.08, 0.7, 0x99ccdd);
      radarDish.position.set(-0.65, 1.25, -0.85);
      radarDish.rotation.x = 0.45;
      this.turretYawPivot.add(radarDish);

      // Cannon Pitch Pivot (elevates to aim up at helicopter)
      this.cannonPitchPivot = new THREE.Group();
      this.cannonPitchPivot.name = "CannonPitchPivot";
      this.cannonPitchPivot.position.set(0, 0.36, 1.15);

      // Mantlet
      const mantlet = createBox(0.95, 0.6, 0.5, 0x333333);
      this.cannonPitchPivot.add(mantlet);

      // Heavy Cannon Barrel
      const barrel = createBox(0.24, 0.24, 3.2, 0x222222);
      barrel.position.set(0, 0, 1.6);
      this.cannonPitchPivot.add(barrel);

      // Muzzle brake & flash glow
      const muzzleBrake = createBox(0.42, 0.38, 0.45, 0x111111);
      muzzleBrake.position.set(0, 0, 3.2);
      this.cannonPitchPivot.add(muzzleBrake);

      const muzzlePoint = new THREE.Object3D();
      muzzlePoint.position.set(0, 0, 3.5);
      this.cannonPitchPivot.add(muzzlePoint);
      this.muzzlePoint = muzzlePoint;

      // Telegraph aiming laser / glow box
      const muzzleGlow = createGlowBox(0.5, 0.5, 0.5, 0xff5522, 0.0);
      muzzleGlow.position.set(0, 0, 3.4);
      this.cannonPitchPivot.add(muzzleGlow);
      this.tankTelegraphMesh = muzzleGlow;

      this.turretYawPivot.add(this.cannonPitchPivot);
      this.ring.add(this.turretYawPivot);

      baseGroup.add(this.ring);

    } else if (type === EnemyType.DRONE) {
      this.movementClass = EnemyMovementClass.FLYING;
      // Light Attack Helicopter
      const lightModel = EnemyHelicopterModelFactory.create({
        family: "light",
        variant: this.droneCosmeticVariant,
        isElite: this.isElite,
        coreColor: coreHex,
        accentColor: accentHex,
      });
      this.heliModelData = lightModel;
      this.ring = lightModel.visualRoot;
      this.enemyRotor = lightModel.mainRotorPivot;
      this.enemyTailRotor = lightModel.tailRotorPivot;
      this.gunYawPivot = lightModel.gunYawPivot;
      this.cannonPitchPivot = lightModel.gunPitchPivot;
      this.muzzlePoint = lightModel.muzzlePoint;
      this.targetPoint = lightModel.targetPoint;
      this.damagePoints = lightModel.damagePoints;

      // Attack warning telegraph glow
      const noseTelegraph = createGlowBox(0.4, 0.4, 0.4, 0xff3344, 0.0);
      noseTelegraph.position.set(0, -0.1, 1.8);
      noseTelegraph.visible = false;
      this.ring.add(noseTelegraph);
      this.droneTelegraphMesh = noseTelegraph;

      baseGroup.add(lightModel.root);

    } else if (type === EnemyType.BASIC) {
      // INFANTRY CLUSTER — 4 visible low-poly soldiers in tactical formation
      this.movementClass = EnemyMovementClass.GROUND;
      this.ring = new THREE.Group();

      const soldierOffsets = [
        { x: 0.0, z: 0.8, variant: 0 },   // Squad leader (front)
        { x: -1.3, z: -0.5, variant: 1 },  // Rifleman left
        { x: 1.2, z: -0.4, variant: 2 },   // Support right (backpack)
        { x: 0.1, z: -1.3, variant: 1 },   // Rear guard
      ];

      soldierOffsets.forEach((s) => {
        const soldier = new THREE.Group();
        soldier.position.set(s.x, 0, s.z);

        // Boots/Legs
        const legs = createBox(0.42, 0.45, 0.35, 0x2e2924);
        legs.position.set(0, 0.22, 0);
        soldier.add(legs);

        // Torso / tactical vest
        const torso = createBox(0.55, 0.52, 0.38, s.variant === 2 ? 0x6e7855 : 0x8a7f66);
        torso.position.set(0, 0.65, 0);
        soldier.add(torso);

        // Head / Helmet
        const head = createBox(0.38, 0.35, 0.38, 0x585340);
        head.position.set(0, 1.05, 0);
        soldier.add(head);

        // Helmet brim
        const brim = createBox(0.44, 0.08, 0.44, 0x484332);
        brim.position.set(0, 1.14, 0.02);
        soldier.add(brim);

        // Rifle / weapon
        const rifle = createBox(0.12, 0.12, 0.85, 0x1a1a1a);
        rifle.position.set(0.24, 0.68, 0.35);
        soldier.add(rifle);

        // Cosmetic variant accents
        if (s.variant === 2) {
          // Backpack
          const backpack = createBox(0.38, 0.42, 0.22, 0x3d4230);
          backpack.position.set(0, 0.66, -0.26);
          soldier.add(backpack);
        } else if (s.variant === 0) {
          // Leader radio antenna
          const radio = createBox(0.12, 0.32, 0.12, 0x222222);
          radio.position.set(-0.24, 0.78, -0.15);
          soldier.add(radio);
        }

        this.ring.add(soldier);
      });

      baseGroup.add(this.ring);

    } else {
      // SHOOTER / Medium Attack Gunship
      this.movementClass = EnemyMovementClass.FLYING;
      const mediumModel = EnemyHelicopterModelFactory.create({
        family: "medium",
        variant: Math.abs(Math.round(x + z)) % 4,
        isElite: this.isElite,
        coreColor: coreHex,
        accentColor: accentHex,
      });
      this.heliModelData = mediumModel;
      this.ring = mediumModel.visualRoot;
      this.enemyRotor = mediumModel.mainRotorPivot;
      this.enemyTailRotor = mediumModel.tailRotorPivot;
      this.gunYawPivot = mediumModel.gunYawPivot;
      this.cannonPitchPivot = mediumModel.gunPitchPivot;
      this.muzzlePoint = mediumModel.muzzlePoint;
      this.targetPoint = mediumModel.targetPoint;
      this.damagePoints = mediumModel.damagePoints;

      baseGroup.add(mediumModel.root);
    }

    this.mesh = baseGroup;
    scene.add(this.mesh);

    // Shield bubble visual (SHIELDED modifier)
    if ((this.modifier & EnemyModifier.SHIELDED) !== 0) {
      const shieldGeo = new THREE.SphereGeometry(radius * 1.35, 10, 8);
      const shieldMat = new THREE.MeshBasicMaterial({
        color: 0x55eeff,
        transparent: true,
        opacity: 0.22,
        wireframe: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
      this.mesh.add(this.shieldMesh);
    }

    // Regeneration is never a hidden stat: a green energy cage breathes around
    // the hull and brightens while repair is actually ticking.
    if ((this.modifier & EnemyModifier.REGENERATING) !== 0) {
      const regenGeo = new THREE.IcosahedronGeometry(radius * 1.42, 1);
      const regenMat = new THREE.MeshBasicMaterial({
        color: 0x55ff88,
        transparent: true,
        opacity: 0.12,
        wireframe: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.regenMesh = new THREE.Mesh(regenGeo, regenMat);
      this.mesh.add(this.regenMesh);
    }

    // Telegraph beam visual (boss phase 3 telegraphed attacks)
    if (type === EnemyType.BOSS) {
      const beamGeo = new THREE.BoxGeometry(0.5, 0.5, 30);
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xff2244,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.telegraphMesh = new THREE.Mesh(beamGeo, beamMat);
      this.telegraphMesh.position.z = -15;
      this.telegraphMesh.visible = false;
      this.mesh.add(this.telegraphMesh);
    }

    this.body = new CANNON.Body({
      mass: type === EnemyType.TANK ? 100 : 0,
      type: CANNON.Body.KINEMATIC,
      position: new CANNON.Vec3(x, y, z),
      collisionFilterGroup: COLLISION.ENEMY,
      collisionFilterMask: COLLISION.ENEMY_MASK,
    });

    const shape = new CANNON.Box(
      new CANNON.Vec3(radius, radius * 0.75, radius),
    );
    this.body.addShape(shape);
    world.addBody(this.body);

    if (this.variant !== EnemyVariant.STANDARD) {
      this.buildVariantVisuals(this.variant, radius, accentHex);
      this.buildVariantTelegraph(accentHex);
    }
    this.buildThreatSignature(radius, accentHex, type);
    // HD real shadows are player-only — keep enemy hulls out of the caster pass.
    disableShadowCasting(this.mesh);
  }

  /**
   * Enemy redesign: color-coded emissive flank strips + a dorsal sensor node
   * so every hull reads its threat role at a glance. Variant units use their
   * signature accent; standard units use the base-hull accent.
   */
  private buildThreatSignature(r: number, accent: number, type: EnemyType) {
    if (type === EnemyType.BOSS || type === EnemyType.BASIC || type === EnemyType.TANK) return;
    const ring = this.ring;
    for (const s of [-1, 1]) {
      const strip = createGlowBox(r * 0.1, r * 0.14, r * 1.4, accent, 0.7);
      strip.position.set(s * r * 0.92, 0, 0);
      ring.add(strip);
    }
    const node = createGlowBox(r * 0.22, r * 0.22, r * 0.22, accent, 0.9);
    node.position.set(0, r * 0.75, -r * 0.2);
    ring.add(node);
  }

  /** Extra silhouette parts that identify the combat role at a glance. */
  private buildVariantVisuals(variant: EnemyVariant, r: number, accent: number) {
    const ring = this.ring;
    switch (variant) {
      case EnemyVariant.SCOUT_DRONE: {
        // Thin swept wings + red nav accents — reads fast and fragile
        for (const s of [-1, 1]) {
          const wing = createBox(r * 1.3, 0.1, r * 0.5, 0x222222);
          wing.position.set(s * r * 0.95, -0.15, -0.3);
          wing.rotation.y = -s * 0.35;
          ring.add(wing);
          const stripe = createGlowBox(r * 0.5, 0.06, 0.12, accent, 0.75);
          stripe.position.set(s * r * 1.35, -0.15, -0.3);
          ring.add(stripe);
        }
        break;
      }
      case EnemyVariant.KAMIKAZE_DRONE: {
        // Bright red warhead nose + tail flare
        const nose = createGlowBox(r * 0.7, r * 0.7, r * 0.7, 0xff2244, 0.95);
        nose.position.set(0, 0, r * 1.3);
        ring.add(nose);
        const flare = createGlowBox(r * 0.3, r * 0.3, r * 0.3, 0xffaa33, 0.9);
        flare.position.set(0, 0, -r * 1.1);
        ring.add(flare);
        break;
      }
      case EnemyVariant.ATTACK_GUNSHIP: {
        // Twin chin cannon pods (replaces the single chin cannon look)
        for (const s of [-1, 1]) {
          const pod = createBox(r * 0.3, r * 0.28, r * 0.9, 0x222222);
          pod.position.set(s * r * 0.5, -r * 0.5, r * 1.4);
          ring.add(pod);
          const tip = createGlowBox(r * 0.2, r * 0.18, r * 0.2, accent, 0.9);
          tip.position.set(s * r * 0.5, -r * 0.5, r * 1.9);
          ring.add(tip);
        }
        break;
      }
      case EnemyVariant.ROCKET_GUNSHIP: {
        // Side rocket pods — 2 tubes each, orange launch glow
        for (const s of [-1, 1]) {
          const pod = createBox(r * 0.42, r * 0.6, r * 1.3, 0x1a1a1a);
          pod.position.set(s * r * 1.35, -0.1, 0);
          ring.add(pod);
          for (let i = 0; i < 2; i++) {
            const tube = createBox(r * 0.16, r * 0.16, r * 1.2, 0x333333);
            tube.position.set(s * r * 1.35, -0.1 + (i - 0.5) * r * 0.3, 0);
            ring.add(tube);
          }
          const glow = createGlowBox(r * 0.2, r * 0.2, r * 0.2, accent, 0.85);
          glow.position.set(s * r * 1.35, -0.1, -r * 0.85);
          ring.add(glow);
        }
        break;
      }
      case EnemyVariant.FLAK_TANK: {
        // Twin flanking AA barrels + wider muzzle glow
        for (const s of [-1, 1]) {
          const barrel = createBox(0.14, 0.14, 2.2, 0x333333);
          barrel.position.set(s * 0.95, 1.3, 1.6);
          ring.add(barrel);
        }
        const muzzle = createGlowBox(1.1, 0.3, 0.24, accent, 0.9);
        muzzle.position.set(0, 1.2, 3.0);
        ring.add(muzzle);
        break;
      }
      case EnemyVariant.MISSILE_CARRIER: {
        // 2×2 missile rack + amber targeting lamp
        for (let i = 0; i < 4; i++) {
          const tube = createBox(0.42, 0.42, 1.6, 0x222222);
          tube.position.set((i % 2 === 0 ? -0.55 : 0.55), 1.9, (i < 2 ? -0.4 : 0.5));
          ring.add(tube);
        }
        const lamp = createGlowBox(0.5, 0.3, 0.5, accent, 0.95);
        lamp.position.set(0, 2.3, 0.1);
        ring.add(lamp);
        break;
      }
      case EnemyVariant.SHIELD_DRONE: {
        // Electric-blue support ring + pulsing core
        const holo = createGlowBox(r * 2.4, 0.14, r * 2.4, 0x55eeff, 0.5);
        ring.add(holo);
        const core = createGlowBox(r * 0.8, r * 0.5, r * 0.8, 0x55eeff, 0.95);
        core.position.set(0, 0.2, 0);
        ring.add(core);
        break;
      }
      case EnemyVariant.REPAIR_DRONE: {
        // Green medic glow + twin supply pods
        const core = createGlowBox(r * 0.9, r * 0.5, r * 0.9, 0x55ff99, 0.95);
        core.position.set(0, 0.15, 0);
        ring.add(core);
        for (const s of [-1, 1]) {
          const pod = createBox(r * 0.4, r * 0.5, r * 0.7, 0x2a3a2a);
          pod.position.set(s * r * 1.0, 0, 0.2);
          ring.add(pod);
          const lamp = createGlowBox(r * 0.16, r * 0.16, r * 0.16, 0x55ff99, 0.9);
          lamp.position.set(s * r * 1.0, 0, 0.6);
          ring.add(lamp);
        }
        break;
      }
      case EnemyVariant.HEAVY_GUNSHIP: {
        // Armored slab: thick wing, twin nacelles, purple command stripe
        const wing = createBox(r * 3.2, r * 0.22, r * 1.0, 0x7a2f1f);
        wing.position.set(0, -0.1, -0.2);
        ring.add(wing);
        for (const s of [-1, 1]) {
          const pod = createBox(r * 0.7, r * 0.6, r * 1.6, accent);
          pod.position.set(s * r * 1.1, 0.1, -0.3);
          ring.add(pod);
          const intake = createGlowBox(r * 0.5, r * 0.4, r * 0.2, 0xff8833, 0.9);
          intake.position.set(s * r * 1.1, 0.1, -1.15);
          ring.add(intake);
        }
        const stripe = createGlowBox(r * 0.16, r * 0.18, r * 1.6, accent, 0.8);
        stripe.position.set(0, 0.35, -0.2);
        ring.add(stripe);
        break;
      }
      case EnemyVariant.SIEGE_TANK: {
        // Long artillery barrel + heavier chassis + deployment feet
        const barrel = createBox(0.3, 0.3, 3.6, 0x2a2a2a);
        barrel.position.set(0, 1.0, 2.6);
        ring.add(barrel);
        const breach = createBox(0.9, 0.7, 1.0, accent);
        breach.position.set(0, 1.2, 1.0);
        ring.add(breach);
        const muzzle = createGlowBox(0.7, 0.7, 0.3, accent, 0.95);
        muzzle.position.set(0, 1.0, 4.4);
        ring.add(muzzle);
        break;
      }
      case EnemyVariant.INTERCEPTOR: {
        // Delta wings + twin tail fins + blue afterburner — reads fast jet
        for (const s of [-1, 1]) {
          const wing = createBox(r * 1.7, 0.09, r * 0.85, 0x1d2733);
          wing.position.set(s * r * 1.1, -0.1, -r * 0.35);
          wing.rotation.y = -s * 0.5;
          ring.add(wing);
          const fin = createBox(0.1, r * 0.8, r * 0.5, 0x1d2733);
          fin.position.set(s * r * 0.45, r * 0.4, -r * 1.0);
          fin.rotation.z = s * 0.28;
          ring.add(fin);
          const edge = createGlowBox(r * 0.7, 0.05, 0.1, accent, 0.8);
          edge.position.set(s * r * 1.5, -0.1, -r * 0.35);
          ring.add(edge);
        }
        const burner = createGlowBox(r * 0.5, r * 0.5, r * 0.4, accent, 0.95);
        burner.position.set(0, 0, -r * 1.35);
        ring.add(burner);
        break;
      }
      case EnemyVariant.MINELAYER: {
        // Belly mine rack (3 orbs) + blinking pink arming lamps
        const rack = createBox(r * 1.6, 0.16, r * 0.9, 0x241a22);
        rack.position.set(0, -r * 0.65, 0);
        ring.add(rack);
        for (let i = -1; i <= 1; i++) {
          const orb = createGlowBox(r * 0.42, r * 0.42, r * 0.42, accent, 0.9);
          orb.position.set(i * r * 0.62, -r * 0.95, 0);
          ring.add(orb);
        }
        for (const s of [-1, 1]) {
          const lamp = createGlowBox(r * 0.18, r * 0.18, r * 0.18, 0xff88cc, 0.95);
          lamp.position.set(s * r * 0.9, 0.1, r * 0.7);
          ring.add(lamp);
        }
        break;
      }
      case EnemyVariant.GATLING_HEAVY: {
        // Rotary gatling drum + triple barrels + yellow ammo feed stripes
        const drum = createBox(r * 0.9, r * 0.9, r * 1.1, 0x1a1a1a);
        drum.position.set(0, 1.15, 0.9);
        ring.add(drum);
        for (let i = -1; i <= 1; i++) {
          const barrel = createBox(0.13, 0.13, 2.6, 0x333333);
          barrel.position.set(i * 0.32, 1.15, 2.5);
          ring.add(barrel);
        }
        const muzzle = createGlowBox(0.9, 0.5, 0.24, accent, 0.9);
        muzzle.position.set(0, 1.15, 3.85);
        ring.add(muzzle);
        for (const s of [-1, 1]) {
          const belt = createGlowBox(r * 0.12, r * 0.12, r * 1.5, accent, 0.75);
          belt.position.set(s * r * 0.75, 1.15, 0.6);
          ring.add(belt);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Flat pulsing telegraph ring under the unit for strong attacks. */
  private buildVariantTelegraph(accent: number) {
    const geo = new THREE.RingGeometry(1.6, 2.4, 28);
    const mat = new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ringMesh = new THREE.Mesh(geo, mat);
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.position.y = 0.15;
    ringMesh.visible = false;
    this.mesh.add(ringMesh);
    this.variantTelegraph = ringMesh;
  }

  /**
   * Apply damage. Returns 'destroyed' | 'shield-broken' | 'hit'.
   * Shield absorbs damage first; when the shield breaks the overkill
   * carries into hull HP.
   */
  takeDamage(amt: number, now: number): "destroyed" | "shield-broken" | "hit" {
    this.lastDamageTime = now;
    this.hitFlashTimer = Enemy.HIT_FLASH_DURATION;
    if (this.shieldHp > 0) {
      if (amt >= this.shieldHp) {
        const overkill = amt - this.shieldHp;
        this.shieldHp = 0;
        if (this.shieldMesh) this.shieldMesh.visible = false;
        if (overkill > 0) {
          this.hp -= overkill;
        }
        if (this.hp <= 0) {
          const isFlying = (this.type === EnemyType.DRONE || this.movementClass === EnemyMovementClass.FLYING) && this.type !== EnemyType.BOSS;
          if (isFlying && !this.isDying) {
            this.isDying = true;
            this.active = false;
            this.deathSpiralYawRate = (Math.random() > 0.5 ? 1 : -1) * (5.5 + Math.random() * 3.5);
            this.deathSpiralRollRate = (Math.random() > 0.5 ? 1 : -1) * (4.5 + Math.random() * 3.0);
            this.deathSpiralVelY = -2.0;
            this.deathSpiralTimer = 0;
            return "destroyed";
          }
          this.active = false;
          return "destroyed";
        }
        return "shield-broken";
      }
      this.shieldHp -= amt;
      return "hit";
    }
    this.hp -= amt;
    if (this.hp <= 0) {
      const isFlying = (this.type === EnemyType.DRONE || this.movementClass === EnemyMovementClass.FLYING) && this.type !== EnemyType.BOSS;
      if (isFlying && !this.isDying) {
        this.isDying = true;
        this.active = false;
        this.deathSpiralYawRate = (Math.random() > 0.5 ? 1 : -1) * (5.5 + Math.random() * 3.5);
        this.deathSpiralRollRate = (Math.random() > 0.5 ? 1 : -1) * (4.5 + Math.random() * 3.0);
        this.deathSpiralVelY = -2.0;
        this.deathSpiralTimer = 0;
        return "destroyed";
      }
      this.active = false;
      return "destroyed";
    }
    return "hit";
  }

  /**
   * Controlled physics-free death spiral for Combat Drones.
   * Pitches down, rotates yaw & roll, descends into terrain/roof, and triggers crash blast.
   */
  updateDeathSpiral(
    delta: number,
    city: { getHeightAt(x: number, z: number, r?: number): number } | null | undefined,
    time: number,
    particles?: GPUParticleSystem | null,
  ): boolean {
    this.deathSpiralTimer += delta;
    this.deathSpiralVelY -= 22.0 * delta;

    this.body.position.y += this.deathSpiralVelY * delta;
    this.body.position.x += this.smoothVelX * 0.6 * delta;
    this.body.position.z += this.smoothVelZ * 0.6 * delta;

    this.mesh.rotation.y += this.deathSpiralYawRate * delta;
    this.mesh.rotation.x = Math.min(0.85, this.mesh.rotation.x + delta * 1.8);
    this.ring.rotation.z += this.deathSpiralRollRate * delta;
    this.ring.rotation.y = 0;
    this.ring.rotation.x = this.mesh.rotation.x;

    copyPhysicsPos(this.mesh, this.body.position);
    this.ring.position.set(0, 0, 0);

    if (particles) {
      let smokeX = this.body.position.x;
      let smokeY = this.body.position.y;
      let smokeZ = this.body.position.z;
      if (this.damagePoints?.engineLeft) {
        this.damagePoints.engineLeft.getWorldPosition(_projPos);
        smokeX = _projPos.x;
        smokeY = _projPos.y;
        smokeZ = _projPos.z;
      }
      particles.spawnSmoke(smokeX, smokeY, smokeZ, time);
      if (Math.random() < 0.35) {
        particles.spawnSparks(smokeX, smokeY, smokeZ, time, 2, 9);
      }
    }

    const floor = city ? city.getHeightAt(this.body.position.x, this.body.position.z, 0.8) : 0;
    if (this.body.position.y <= floor + 0.6 || this.deathSpiralTimer >= this.deathSpiralMaxTime) {
      this.body.position.y = Math.max(floor, this.body.position.y);
      this.readyForRemoval = true;
      return true;
    }
    return false;
  }

  /** B1: apply a status effect. Bosses shrug off EMP (volleys are telegraphed). */
  applyStatus(kind: StatusEffectKind, now: number) {
    const until = now + STATUS_DURATIONS[kind];
    if (kind === "burn") {
      this.statusBurnUntil = Math.max(this.statusBurnUntil, until);
    } else if (kind === "emp") {
      if (this.type === EnemyType.BOSS) return;
      this.statusEmpUntil = Math.max(this.statusEmpUntil, until);
    } else {
      this.statusShockUntil = Math.max(this.statusShockUntil, until);
    }
  }

  isBurning(now: number) {
    return now < this.statusBurnUntil;
  }

  isEmpSuppressed(now: number) {
    return now < this.statusEmpUntil;
  }

  isShocked(now: number) {
    return now < this.statusShockUntil;
  }

  /**
   * B1: per-frame status tick. Must run EVERY frame for every enemy — it
   * keeps statusTime fresh for the shock-slow check. Burn DoT is applied
   * directly to shield/hull in whole-point chunks (bypasses takeDamage so it
   * never spams the hit flash); a burn kill flags diedFromStatus so the
   * engine still runs the full kill pipeline (score, drops, affixes).
   */
  tickStatusEffects(time: number, delta: number) {
    this.statusTime = time;
    if (!this.active || time >= this.statusBurnUntil) return;
    this.burnAccum += BURN_DPS * delta;
    if (this.burnAccum < 1) return;
    const dmg = Math.floor(this.burnAccum);
    this.burnAccum -= dmg;
    this.lastDamageTime = time; // burning keeps regen suppressed
    if (this.shieldHp > 0) {
      const absorbed = Math.min(this.shieldHp, dmg);
      this.shieldHp -= absorbed;
      if (this.shieldHp <= 0 && this.shieldMesh) this.shieldMesh.visible = false;
      const over = dmg - absorbed;
      if (over > 0) this.hp -= over;
    } else {
      this.hp -= dmg;
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.active = false;
      this.diedFromStatus = true;
    }
  }

  /**
   * Variant combat behaviors — every non-standard enemy routes through here so
   * each role owns its movement, fire and telegraphs. Support drones (shield /
   * repair) recompute their targets from `allEnemies` every frame, so killing
   * Specialized support, kamikaze, tank, infantry, and aerial combat methods.
   */
  private updateKamikazeDroneAI(
    targetPos: CANNON.Vec3,
    time: number,
    dist: number,
    dirX: number,
    dirZ: number,
    repelForceX: number,
    repelForceZ: number,
    avoidForceX: number,
    avoidForceZ: number,
    delta: number,
    targetVel: CANNON.Vec3 | null,
  ): boolean {
    const kamikazeSpeed = this.type === EnemyType.TANK ? 42 : 72;
    this.variantTimer -= delta;

    let desiredX = 0;
    let desiredZ = 0;
    let turnRate = 8.0;

    if (this.variantPhase === 0) {
      // Approach phase: curve toward player
      desiredX = dirX * 35 + repelForceX + avoidForceX;
      desiredZ = dirZ * 35 + repelForceZ + avoidForceZ;
      if (dist < 110 && dist > 14) {
        this.variantPhase = 1;
        this.variantTimer = 0.65;
      }
    } else if (this.variantPhase === 1) {
      // Telegraph phase: lock in place and warn player with bright red glow
      desiredX = 0;
      desiredZ = 0;
      turnRate = 4.0;
      if (this.variantTimer <= 0) {
        this.variantPhase = 2;
        this.variantTimer = 2.0;
      }
    } else {
      // Dive phase: high-speed committed ramming run
      turnRate = 3.2; // Reduced steering so dodge causes miss
      desiredX = dirX * kamikazeSpeed + avoidForceX;
      desiredZ = dirZ * kamikazeSpeed + avoidForceZ;
      if (this.variantTimer <= 0 || dist < 6) {
        this.variantPhase = 0;
      }
    }

    this.applySmoothMovement(desiredX, desiredZ, delta, turnRate);

    const horizSpeed = Math.hypot(this.smoothVelX, this.smoothVelZ);
    if (horizSpeed > 0.5) {
      const moveHeading = Math.atan2(this.smoothVelX, this.smoothVelZ);
      this.mesh.rotation.y = stepAngle(this.mesh.rotation.y, moveHeading, turnRate, delta);
      this.ring.rotation.y = 0;
      this.ring.rotation.z = Math.sin(time * 6) * 0.08;
      this.ring.rotation.x = Math.min(0.25, (horizSpeed / kamikazeSpeed) * 0.2);
    }

    this.showTelegraph(time, this.variantPhase === 1, 0xff2244);
    copyPhysicsPos(this.mesh, this.body.position);
    return false;
  }

  private updateSupportDroneAI(
    targetPos: CANNON.Vec3,
    time: number,
    dist: number,
    dirX: number,
    dirZ: number,
    pool: ProjectilePool,
    repelForceX: number,
    repelForceZ: number,
    avoidForceX: number,
    avoidForceZ: number,
    delta: number,
    allEnemies: Enemy[],
    playerBody: CANNON.Body | null,
    city: CityEnvironment,
  ): boolean {
    const v = ENEMY_VARIANTS[this.variant];

    if (this.variant === EnemyVariant.SHIELD_DRONE) {
      this.hoverBehindGroup(dirX, dirZ, dist, repelForceX, repelForceZ, avoidForceX, avoidForceZ, delta, 55);
      let support: Enemy | null = null;
      for (const ally of allEnemies) {
        if (ally === this || !ally.active || ally.variant === EnemyVariant.SHIELD_DRONE) continue;
        const ax = ally.body.position.x - this.body.position.x;
        const az = ally.body.position.z - this.body.position.z;
        if (ax * ax + az * az < 110 * 110) {
          ally.incomingDamageMult = 0.55;
          if (!support) support = ally;
        }
      }
      this.supportTarget = support;
      this.supportLineColor = 0x55eeff;
      this.pulseSupport(time, 0x55eeff);
    } else if (this.variant === EnemyVariant.REPAIR_DRONE) {
      this.hoverBehindGroup(dirX, dirZ, dist, repelForceX, repelForceZ, avoidForceX, avoidForceZ, delta, 65);
      let best: Enemy | null = null;
      let bestDist = Infinity;
      for (const ally of allEnemies) {
        if (ally === this || !ally.active || ally.hp >= ally.maxHp) continue;
        const ax = ally.body.position.x - this.body.position.x;
        const az = ally.body.position.z - this.body.position.z;
        const d = Math.sqrt(ax * ax + az * az);
        if (d < 100 && d < bestDist) {
          bestDist = d;
          best = ally;
        }
      }
      if (best) best.hp = Math.min(best.maxHp, best.hp + best.maxHp * 0.05 * delta);
      this.supportTarget = best;
      this.supportLineColor = 0x55ff99;
      this.pulseSupport(time, 0x55ff99);
    } else if (this.variant === EnemyVariant.MINELAYER) {
      this.hoverBehindGroup(dirX, dirZ, dist, repelForceX, repelForceZ, avoidForceX, avoidForceZ, delta, 110);
      this.variantTimer -= delta;
      if (this.variantPhase === 0 && this.variantTimer <= 0 && dist < 220) {
        this.variantPhase = 1;
        this.variantTimer = 0.8;
      } else if (this.variantPhase === 1 && this.variantTimer <= 0) {
        this.variantPhase = 2;
        this.burstShotCount = 0;
        this.variantTimer = 0;
      } else if (this.variantPhase === 2) {
        if (this.variantTimer <= 0 && this.burstShotCount < 3) {
          pool.spawn(
            this.body.position.x,
            this.body.position.y - 0.8,
            this.body.position.z,
            dirX,
            dirZ,
            time,
            14,
            Math.round(12 * (v?.damageMult ?? 1) * this.waveDamageMult),
            10,
            0xff44aa,
            playerBody ? { body: playerBody, active: true } : null,
            1.1 * this.homingMult,
            0,
            0,
            this.waveDamageMult,
          );
          this.burstShotCount++;
          this.variantTimer = 0.35;
        }
        if (this.burstShotCount >= 3) {
          this.variantPhase = 0;
          this.variantTimer = 4.0;
        }
      }
      this.showTelegraph(time, this.variantPhase === 1, 0xff44aa);
    }

    const horizSpeed = Math.hypot(this.smoothVelX, this.smoothVelZ);
    if (horizSpeed > 0.4) {
      const moveHeading = Math.atan2(this.smoothVelX, this.smoothVelZ);
      this.mesh.rotation.y = stepAngle(this.mesh.rotation.y, moveHeading, 5.0, delta);
      this.ring.rotation.y = 0;
    }
    if (this.enemyRotor) this.enemyRotor.rotation.y += 30 * delta;
    if (this.enemyTailRotor) this.enemyTailRotor.rotation.x += 36 * delta;

    copyPhysicsPos(this.mesh, this.body.position);
    return false;
  }

  private updateTankAI(
    targetPos: CANNON.Vec3,
    time: number,
    dist: number,
    dirX: number,
    dirZ: number,
    pool: ProjectilePool,
    repelForceX: number,
    repelForceZ: number,
    avoidForceX: number,
    avoidForceZ: number,
    fireRateMult: number,
    delta: number,
    city: CityEnvironment,
    targetVel: CANNON.Vec3 | null,
    combatDirector?: CombatDirector | null,
    currentWave: number = 1,
    isBossActive: boolean = false,
    playerBody: CANNON.Body | null = null,
  ): boolean {
    let fired = false;
    const v = this.variant !== EnemyVariant.STANDARD ? ENEMY_VARIANTS[this.variant] : null;
    let tankSpeed = 13 * (v ? v.speedMult : 1.0);

    const isFlak = this.variant === EnemyVariant.FLAK_TANK;
    const isMissile = this.variant === EnemyVariant.MISSILE_CARRIER;
    const isSiege = this.variant === EnemyVariant.SIEGE_TANK;

    // Ground clearance clamp
    const clearance = 2.5;
    const groundY = city ? city.getHeightAt(this.body.position.x, this.body.position.z, clearance) : 0;
    this.body.position.y = Math.max(1.2, groundY + 1.2);
    this.body.velocity.y = 0;

    const dx = targetPos.x - this.body.position.x;
    const dy = targetPos.y - this.body.position.y;
    const dz = targetPos.z - this.body.position.z;
    const horizDist = Math.max(1, Math.hypot(dx, dz));
    const hasLOS = this.hasLineOfSight(city, targetPos);

    let desiredX = 0;
    let desiredZ = 0;

    this.tankStateTimer += delta;

    // Tank Tactical State Machine
    if (this.tankCombatState === TankCombatState.MOVE_TO_LANE) {
      desiredX = dirX * tankSpeed + repelForceX * 1.2 + avoidForceX;
      desiredZ = dirZ * tankSpeed + repelForceZ * 1.2 + avoidForceZ;

      const readyRange = isMissile ? 175 : isSiege ? 160 : 85;
      if (hasLOS && dist < readyRange && dist > 18) {
        this.tankCombatState = TankCombatState.AIM;
        this.tankStateTimer = 0;
      }
    } else if (this.tankCombatState === TankCombatState.AIM) {
      tankSpeed = 3;
      desiredX = dirX * tankSpeed + repelForceX + avoidForceX;
      desiredZ = dirZ * tankSpeed + repelForceZ + avoidForceZ;

      const canShoot = combatDirector
        ? combatDirector.requestHeavyAttackSlot(this.id, "TANK", time, currentWave, isBossActive, 2.0) &&
          combatDirector.requestGroundAttackSlot(this.id, time, currentWave, isBossActive)
        : time - this.lastShotTime > (isFlak ? 2.4 : isMissile ? 4.0 : 3.2) * fireRateMult;

      if (canShoot && hasLOS && time - this.lastShotTime > 2.5 * fireRateMult) {
        this.tankCombatState = TankCombatState.FIRE;
        this.tankAimTimer = isMissile ? 0.9 : isSiege ? 1.0 : 0.35;
        this.tankStateTimer = 0;
        this.burstShotCount = 0;
        if (isSiege) this.placeSiegeMarker(dirX, dirZ);
      } else if (!hasLOS || dist > 190) {
        this.tankCombatState = TankCombatState.MOVE_TO_LANE;
        this.tankStateTimer = 0;
      }
    } else if (this.tankCombatState === TankCombatState.FIRE) {
      desiredX = 0;
      desiredZ = 0;

      if (this.tankAimTimer > 0) {
        this.tankAimTimer -= delta;
        if (this.tankTelegraphMesh) {
          (this.tankTelegraphMesh.material as THREE.MeshBasicMaterial).opacity = 0.88;
        }
      } else {
        if (this.tankTelegraphMesh) {
          (this.tankTelegraphMesh.material as THREE.MeshBasicMaterial).opacity = 0.0;
        }

        let muzzleX = this.body.position.x;
        let muzzleY = this.body.position.y + 1.8;
        let muzzleZ = this.body.position.z;
        if (this.muzzlePoint) {
          this.muzzlePoint.getWorldPosition(_projPos);
          muzzleX = _projPos.x;
          muzzleY = _projPos.y;
          muzzleZ = _projPos.z;
        }

        if (isFlak) {
          // Flak burst
          const aim = this.applyAimError(this.leadAim(targetPos, targetVel, 150), dist);
          pool.spawn(
            muzzleX,
            muzzleY,
            muzzleZ,
            aim.x,
            aim.z,
            time,
            150 * this.projSpeedMult,
            Math.round(3 * (v?.damageMult ?? 1) * this.waveDamageMult),
            0,
            0xffaa33,
            null,
            0,
            (aim.y ?? 0) * 150,
            0,
            this.waveDamageMult,
          );
          this.burstShotCount++;
          if (this.burstShotCount >= 5) {
            this.finishTankShot(time, combatDirector);
          } else {
            this.tankAimTimer = 0.11;
          }
          fired = true;
        } else if (isMissile) {
          // Missile lock fire
          pool.spawn(
            muzzleX,
            muzzleY + 0.3,
            muzzleZ,
            dirX,
            dirZ,
            time,
            130 * this.projSpeedMult,
            Math.round(12 * (v?.damageMult ?? 1) * this.waveDamageMult),
            6,
            0xffc23f,
            playerBody ? { body: playerBody, active: true } : null,
            2.5 * this.homingMult,
            0,
            0,
            this.waveDamageMult,
          );
          this.finishTankShot(time, combatDirector);
          fired = true;
        } else if (isSiege) {
          // Lobbed artillery shell
          pool.spawn(
            muzzleX,
            muzzleY,
            muzzleZ,
            dirX,
            dirZ,
            time,
            150,
            Math.round(16 * (v?.damageMult ?? 1) * this.waveDamageMult),
            8,
            0xff7744,
            null,
            0,
            46,
            95,
            this.waveDamageMult,
          );
          this.hideSiegeMarker();
          this.finishTankShot(time, combatDirector);
          fired = true;
        } else {
          // Standard Tank Cannon
          const aim = this.applyAimError(this.leadAim(targetPos, targetVel, 110), dist);
          pool.spawn(
            muzzleX,
            muzzleY,
            muzzleZ,
            aim.x,
            aim.z,
            time,
            110 * this.projSpeedMult,
            18 * this.waveDamageMult,
            0,
            0xff8833,
            null,
            0,
            (aim.y ?? 0) * 110,
            0,
            this.waveDamageMult,
          );
          this.finishTankShot(time, combatDirector);
          fired = true;
        }
      }
    } else if (this.tankCombatState === TankCombatState.REPOSITION) {
      const tangentX = -dirZ * this.flankDir;
      const tangentZ = dirX * this.flankDir;
      desiredX = (tangentX * 1.1 + dirX * 0.2) * tankSpeed + repelForceX + avoidForceX;
      desiredZ = (tangentZ * 1.1 + dirZ * 0.2) * tankSpeed + repelForceZ + avoidForceZ;

      if (this.tankStateTimer > 2.2 || time - this.lastShotTime > 3.2) {
        this.tankCombatState = TankCombatState.AIM;
        this.tankStateTimer = 0;
      }
    }

    this.applySmoothMovement(desiredX, desiredZ, delta, 5.0);

    // Chassis faces movement heading
    const horizSpeed = Math.hypot(this.smoothVelX, this.smoothVelZ);
    if (horizSpeed > 0.4) {
      const moveHeading = Math.atan2(this.smoothVelX || desiredX, this.smoothVelZ || desiredZ);
      this.mesh.rotation.y = moveHeading;
    }

    // Independent Turret Yaw
    if (this.turretYawPivot) {
      const playerYaw = Math.atan2(dx, dz);
      const chassisYaw = this.mesh.rotation.y;
      let relYaw = playerYaw - chassisYaw;
      while (relYaw < -Math.PI) relYaw += Math.PI * 2;
      while (relYaw > Math.PI) relYaw -= Math.PI * 2;
      this.turretYawPivot.rotation.y = stepAngle(this.turretYawPivot.rotation.y, relYaw, 3.4, delta);
    }

    // Independent Cannon Pitch
    if (this.cannonPitchPivot) {
      const targetPitch = THREE.MathUtils.clamp(-Math.atan2(dy, horizDist), -0.75, 0.15);
      this.cannonPitchPivot.rotation.x = stepAngle(this.cannonPitchPivot.rotation.x, targetPitch, 2.6, delta);
    }

    copyPhysicsPos(this.mesh, this.body.position);
    return fired;
  }

  private finishTankShot(time: number, combatDirector?: CombatDirector | null) {
    this.lastShotTime = time;
    if (combatDirector) {
      combatDirector.releaseGroundAttackSlot(this.id, time, 3.2);
      combatDirector.releaseHeavyAttackSlot(this.id, time, 3.2);
    }
    this.tankCombatState = TankCombatState.REPOSITION;
    this.tankStateTimer = 0;
  }

  private updateInfantryAI(
    targetPos: CANNON.Vec3,
    time: number,
    dist: number,
    dirX: number,
    dirZ: number,
    pool: ProjectilePool,
    repelForceX: number,
    repelForceZ: number,
    avoidForceX: number,
    avoidForceZ: number,
    fireRateMult: number,
    delta: number,
    city: CityEnvironment,
    targetVel: CANNON.Vec3 | null,
  ): boolean {
    let fired = false;
    const speed = 14;

    const tangentX = -dirZ * this.flankDir;
    const tangentZ = dirX * this.flankDir;
    let desiredX: number;
    let desiredZ: number;

    if (dist > 45) {
      desiredX = dirX * speed + repelForceX + avoidForceX;
      desiredZ = dirZ * speed + repelForceZ + avoidForceZ;
    } else if (dist < 18) {
      desiredX = (-dirX + tangentX * 1.2) * speed * 0.7 + repelForceX + avoidForceX;
      desiredZ = (-dirZ + tangentZ * 1.2) * speed * 0.7 + repelForceZ + avoidForceZ;
    } else {
      desiredX = (tangentX + dirX * 0.2) * speed * 0.6 + repelForceX + avoidForceX;
      desiredZ = (tangentZ + dirZ * 0.2) * speed * 0.6 + repelForceZ + avoidForceZ;
    }

    this.applySmoothMovement(desiredX, desiredZ, delta, 6.0);

    const groundY = city ? city.getHeightAt(this.body.position.x, this.body.position.z, 1.0) : 0;
    this.body.position.y = Math.max(0.6, groundY + 0.6);
    this.body.velocity.y = 0;

    const horizSpeed = Math.hypot(this.smoothVelX, this.smoothVelZ);
    if (horizSpeed > 0.3) {
      this.mesh.rotation.y = stepAngle(this.mesh.rotation.y, Math.atan2(this.smoothVelX, this.smoothVelZ), 5.0, delta);
    }

    // Staggered 3-round rifle bursts
    if (this.infantryBurstRemaining > 0) {
      this.infantryBurstTimer -= delta;
      if (this.infantryBurstTimer <= 0) {
        const aim = this.applyAimError(this.leadAim(targetPos, targetVel, 140), dist);
        pool.spawn(
          this.body.position.x + (Math.random() - 0.5) * 1.2,
          this.body.position.y + 0.8,
          this.body.position.z + (Math.random() - 0.5) * 1.2,
          aim.x,
          aim.z,
          time,
          140 * this.projSpeedMult,
          3,
          0,
          0xffd92e,
          null,
          0,
          (aim.y ?? 0) * 140,
          0,
          this.waveDamageMult,
        );
        this.infantryBurstRemaining--;
        this.infantryBurstTimer = 0.12;
        fired = true;
      }
    } else if (
      dist < 65 &&
      time - this.lastShotTime > (2.5 + this.infantryBurstStagger) * fireRateMult &&
      this.hasLineOfSight(city, targetPos)
    ) {
      this.lastShotTime = time;
      this.infantryBurstRemaining = 3;
      this.infantryBurstTimer = 0;
    }

    copyPhysicsPos(this.mesh, this.body.position);
    return fired;
  }

  private updateAirCombatAI(
    targetPos: CANNON.Vec3,
    time: number,
    dist: number,
    dirX: number,
    dirZ: number,
    pool: ProjectilePool,
    repelForceX: number,
    repelForceZ: number,
    avoidForceX: number,
    avoidForceZ: number,
    fireRateMult: number,
    delta: number,
    city: CityEnvironment,
    targetVel: CANNON.Vec3 | null,
    combatDirector?: CombatDirector | null,
    currentWave: number = 1,
    threatLevel: number = 1,
    isOverdrive: boolean = false,
    overdriveMultiplier: number = 1.0,
    isBossActive: boolean = false,
  ): boolean {
    let fired = false;
    const v = this.variant !== EnemyVariant.STANDARD ? ENEMY_VARIANTS[this.variant] : null;

    // Role profile determination
    const isInterceptor = this.variant === EnemyVariant.INTERCEPTOR;
    const isRocket = this.variant === EnemyVariant.ROCKET_GUNSHIP;
    const isHeavy = this.variant === EnemyVariant.HEAVY_GUNSHIP;
    const isGatling = this.variant === EnemyVariant.GATLING_HEAVY;
    const isAttackGunship = this.variant === EnemyVariant.ATTACK_GUNSHIP || this.type === EnemyType.SHOOTER;

    // Standoff & Speed Configuration
    let approachStandoff = 48.0;
    let cruiseSpeed = 36;
    let attackSpeed = 50;
    let breakawaySpeed = 40;
    let attackRunDuration = 1.35;
    let attackTelegraphDuration = 0.22;
    let smoothTurnRate = 7.5;
    let attackSteerRate = 2.4;
    let maxBank = 0.30;
    let burstTotalShots = 2;
    let burstShotInterval = 0.09;
    let bulletSpeed = 160;
    let bulletDamage = 4;
    let bulletColor = 0xff3b22;
    let isRockets = false;
    let blastRadius = 0;
    let personalCooldown = 2.6 + Math.random() * 0.8;

    if (isInterceptor) {
      approachStandoff = 52.0;
      cruiseSpeed = 42;
      attackSpeed = 62;
      breakawaySpeed = 48;
      attackRunDuration = 1.1;
      attackTelegraphDuration = 0.18;
      smoothTurnRate = 9.0;
      attackSteerRate = 2.2;
      maxBank = 0.45;
      burstTotalShots = 3;
      burstShotInterval = 0.08;
      bulletSpeed = 175;
      bulletDamage = 4;
      bulletColor = 0x55aaff;
      personalCooldown = 2.0 + Math.random() * 0.6;
    } else if (isRocket) {
      approachStandoff = 65.0;
      cruiseSpeed = 28;
      attackSpeed = 38;
      breakawaySpeed = 34;
      attackRunDuration = 1.6;
      attackTelegraphDuration = 0.35;
      smoothTurnRate = 5.0;
      attackSteerRate = 1.8;
      maxBank = 0.30;
      burstTotalShots = 3;
      burstShotInterval = 0.22;
      bulletSpeed = 105;
      bulletDamage = 10;
      bulletColor = 0xffaa33;
      isRockets = true;
      blastRadius = 5;
      personalCooldown = 3.2 + Math.random() * 0.8;
    } else if (isHeavy) {
      approachStandoff = 58.0;
      cruiseSpeed = 26;
      attackSpeed = 34;
      breakawaySpeed = 30;
      attackRunDuration = 1.8;
      attackTelegraphDuration = 0.30;
      smoothTurnRate = 4.2;
      attackSteerRate = 1.6;
      maxBank = 0.26;
      burstTotalShots = 4;
      burstShotInterval = 0.14;
      bulletSpeed = 140;
      bulletDamage = 7;
      bulletColor = 0xff4455;
      personalCooldown = 3.4 + Math.random() * 0.8;
    } else if (isGatling) {
      approachStandoff = 56.0;
      cruiseSpeed = 26;
      attackSpeed = 34;
      breakawaySpeed = 30;
      attackRunDuration = 1.8;
      attackTelegraphDuration = 0.32;
      smoothTurnRate = 4.2;
      attackSteerRate = 1.6;
      maxBank = 0.26;
      burstTotalShots = 8;
      burstShotInterval = 0.065;
      bulletSpeed = 175;
      bulletDamage = 3;
      bulletColor = 0xffd92e;
      personalCooldown = 3.4 + Math.random() * 0.8;
    } else if (isAttackGunship) {
      approachStandoff = 54.0;
      cruiseSpeed = 32;
      attackSpeed = 44;
      breakawaySpeed = 36;
      attackRunDuration = 1.5;
      attackTelegraphDuration = 0.25;
      smoothTurnRate = 5.8;
      attackSteerRate = 2.0;
      maxBank = 0.32;
      burstTotalShots = 3;
      burstShotInterval = 0.12;
      bulletSpeed = 145;
      bulletDamage = 5;
      bulletColor = 0xff5533;
      personalCooldown = 2.8 + Math.random() * 0.8;
    }

    if (v) {
      bulletDamage = Math.round(bulletDamage * v.damageMult);
      cruiseSpeed *= v.speedMult;
      attackSpeed *= v.speedMult;
      breakawaySpeed *= v.speedMult;
    }

    // 1. Altitude calculation & safe height / building avoidance
    const roleAltitudeOffset = this.altitudeOffset || 0;
    let desiredAltitude = targetPos.y + roleAltitudeOffset;

    if (time - this.lastObstacleCheckTime > 0.16) {
      this.lastObstacleCheckTime = time;
      const forwardSpeed = Math.hypot(this.smoothVelX, this.smoothVelZ);
      const lookAheadDist = Math.max(14, forwardSpeed * 0.65);
      const heading = this.mesh.rotation.y;
      const aheadX = this.body.position.x + Math.sin(heading) * lookAheadDist;
      const aheadZ = this.body.position.z + Math.cos(heading) * lookAheadDist;
      const groundHere = city ? city.getHeightAt(this.body.position.x, this.body.position.z, 2.0) : 0;
      const groundAhead = city ? city.getHeightAt(aheadX, aheadZ, 2.0) : 0;
      this.cachedSafeAltitude = Math.max(groundHere, groundAhead) + 5.5;
    }
    if (desiredAltitude < this.cachedSafeAltitude) {
      desiredAltitude = this.cachedSafeAltitude;
    }

    // Vertical smoothing
    const altitudeDiff = desiredAltitude - this.body.position.y;
    const desiredVerticalVel = THREE.MathUtils.clamp(altitudeDiff * 3.5, -16, 18);
    this.smoothVelY = THREE.MathUtils.lerp(this.smoothVelY, desiredVerticalVel, Math.min(1, delta * 5.0));
    this.body.position.y += this.smoothVelY * delta;
    this.body.velocity.y = this.smoothVelY;

    // 2. Predictive interception coordinates
    const predTime = THREE.MathUtils.clamp(dist / Math.max(1, attackSpeed), 0.3, 1.25);
    const predPlayerX = targetPos.x + (targetVel ? targetVel.x * predTime * 0.65 : 0);
    const predPlayerZ = targetPos.z + (targetVel ? targetVel.z * predTime * 0.65 : 0);
    const predDx = predPlayerX - this.body.position.x;
    const predDz = predPlayerZ - this.body.position.z;
    const predDist = Math.max(1, Math.hypot(predDx, predDz));
    const predDirX = predDx / predDist;
    const predDirZ = predDz / predDist;

    // 3. Stuck detection safety net
    this.stuckCheckTimer += delta;
    if (this.stuckCheckTimer > 2.0) {
      this.stuckCheckTimer = 0;
      const movedDist = Math.hypot(
        this.body.position.x - this.lastStuckCheckPos.x,
        this.body.position.z - this.lastStuckCheckPos.z,
      );
      if (movedDist < 3.0 && this.droneState !== DroneCombatState.SPAWN_ENTRY) {
        if (combatDirector) {
          combatDirector.releaseAirAttackSlot(this.id, time, personalCooldown);
          this.assignedSectorAngle = combatDirector.getAssignedApproachAngle(this.id, this.personalityOffset);
        }
        this.droneState = DroneCombatState.BREAK_AWAY;
        this.droneStateTimer = 0;
        this.altitudeOffset = (Math.random() - 0.5) * 8;
      }
      this.lastStuckCheckPos = { x: this.body.position.x, z: this.body.position.z };
    }

    // 4. Air Combat State Machine
    this.droneStateTimer += delta;
    let desiredHorizontalX = 0;
    let desiredHorizontalZ = 0;
    let targetWaypointX: number | undefined;
    let targetWaypointZ: number | undefined;
    let currentSteerTurnRate = smoothTurnRate;

    switch (this.droneState) {
      case DroneCombatState.SPAWN_ENTRY: {
        desiredHorizontalX = dirX * cruiseSpeed + repelForceX * 0.8 + avoidForceX;
        desiredHorizontalZ = dirZ * cruiseSpeed + repelForceZ * 0.8 + avoidForceZ;
        targetWaypointX = targetPos.x;
        targetWaypointZ = targetPos.z;
        if (dist <= 75 || this.droneStateTimer > 3.5) {
          if (combatDirector) {
            this.assignedSectorAngle = combatDirector.getAssignedApproachAngle(this.id, this.personalityOffset);
          } else {
            this.assignedSectorAngle = Math.atan2(dirX, dirZ) + (this.flankDir * 0.6);
          }
          this.droneState = DroneCombatState.APPROACH;
          this.droneStateTimer = 0;
        }
        break;
      }

      case DroneCombatState.APPROACH: {
        targetWaypointX = predPlayerX + Math.sin(this.assignedSectorAngle) * approachStandoff;
        targetWaypointZ = predPlayerZ + Math.cos(this.assignedSectorAngle) * approachStandoff;
        const wpDx = targetWaypointX - this.body.position.x;
        const wpDz = targetWaypointZ - this.body.position.z;
        const wpDist = Math.max(1, Math.hypot(wpDx, wpDz));

        desiredHorizontalX = (wpDx / wpDist) * cruiseSpeed + repelForceX * 0.8 + avoidForceX;
        desiredHorizontalZ = (wpDz / wpDist) * cruiseSpeed + repelForceZ * 0.8 + avoidForceZ;

        if (wpDist < 16.0 || (dist < approachStandoff + 12 && this.hasLineOfSight(city, targetPos)) || this.droneStateTimer > 3.5) {
          this.droneState = DroneCombatState.ATTACK_SETUP;
          this.droneStateTimer = 0;
        }
        break;
      }

      case DroneCombatState.ATTACK_SETUP: {
        targetWaypointX = predPlayerX;
        targetWaypointZ = predPlayerZ;
        const tangentX = -dirZ * this.flankDir;
        const tangentZ = dirX * this.flankDir;
        desiredHorizontalX = (predDirX * 0.45 + tangentX * 0.65) * (cruiseSpeed * 0.85) + repelForceX + avoidForceX;
        desiredHorizontalZ = (predDirZ * 0.45 + tangentZ * 0.65) * (cruiseSpeed * 0.85) + repelForceZ + avoidForceZ;

        const hasLOS = this.hasLineOfSight(city, targetPos);
        const inRange = dist < approachStandoff + 25 && dist > 18;

        const canAttack = combatDirector
          ? combatDirector.requestAirAttackSlot(
              this.id,
              time,
              currentWave,
              threatLevel,
              isOverdrive,
              overdriveMultiplier,
              isBossActive,
              attackRunDuration + 0.8,
            )
          : time - this.lastShotTime > personalCooldown;

        if (canAttack && hasLOS && inRange) {
          this.droneState = DroneCombatState.ATTACK_RUN;
          this.droneStateTimer = 0;
          this.attackRunDuration = attackRunDuration;
          this.attackTelegraphTimer = attackTelegraphDuration;
          this.attackBurstTimer = 0;
          this.attackBurstShotsFired = 0;
          this.attackVectorX = predDirX;
          this.attackVectorZ = predDirZ;
        } else if (this.droneStateTimer > 4.0) {
          if (combatDirector) combatDirector.releaseAirAttackSlot(this.id, time, 1.5);
          this.droneState = DroneCombatState.REPOSITION;
          this.droneStateTimer = 0;
        }
        break;
      }

      case DroneCombatState.ATTACK_RUN: {
        targetWaypointX = targetPos.x;
        targetWaypointZ = targetPos.z;
        currentSteerTurnRate = attackSteerRate; // Committed steering - reduced agility allows player dodge!

        desiredHorizontalX = this.attackVectorX * attackSpeed + repelForceX * 0.4 + avoidForceX * 0.8;
        desiredHorizontalZ = this.attackVectorZ * attackSpeed + repelForceZ * 0.4 + avoidForceZ * 0.8;

        // Attack telegraph (muzzle glow)
        if (this.attackTelegraphTimer > 0) {
          this.attackTelegraphTimer -= delta;
          if (this.droneTelegraphMesh) {
            this.droneTelegraphMesh.visible = true;
            (this.droneTelegraphMesh.material as THREE.MeshBasicMaterial).opacity = 0.95;
          }
        } else {
          if (this.droneTelegraphMesh) {
            this.droneTelegraphMesh.visible = false;
          }

          // Controlled burst fire along weapon orientation
          this.attackBurstTimer -= delta;
          if (this.attackBurstShotsFired < burstTotalShots && this.attackBurstTimer <= 0) {
            this.attackBurstTimer = burstShotInterval;
            this.attackBurstShotsFired++;
            this.lastShotTime = time;

            // Calculate world aim from gun orientation & muzzle
            const aim = this.applyAimError(this.leadAim(targetPos, targetVel, bulletSpeed), dist);

            let muzzleX = this.body.position.x;
            let muzzleY = this.body.position.y - 0.2;
            let muzzleZ = this.body.position.z;

            if (this.muzzlePoint) {
              this.muzzlePoint.getWorldPosition(_projPos);
              muzzleX = _projPos.x;
              muzzleY = _projPos.y;
              muzzleZ = _projPos.z;
            }

            // Weapon alignment check: ensure bullet aligns with gun barrel forward
            const barrelHeading = this.mesh.rotation.y + (this.gunYawPivot ? this.gunYawPivot.rotation.y : 0);
            const barrelFwdX = Math.sin(barrelHeading);
            const barrelFwdZ = Math.cos(barrelHeading);
            const alignmentDot = barrelFwdX * aim.x + barrelFwdZ * aim.z;

            if (alignmentDot > 0.65 || dist < 25) {
              pool.spawn(
                muzzleX,
                muzzleY,
                muzzleZ,
                aim.x,
                aim.z,
                time,
                bulletSpeed * this.projSpeedMult,
                bulletDamage * this.waveDamageMult,
                blastRadius,
                bulletColor,
                null,
                0,
                (aim.y ?? 0) * bulletSpeed,
                0,
                this.waveDamageMult,
              );
              fired = true;
            }
          }
        }

        this.attackRunDuration -= delta;
        const dotWithPlayer =
          (this.body.position.x - targetPos.x) * this.attackVectorX +
          (this.body.position.z - targetPos.z) * this.attackVectorZ;

        if (this.attackRunDuration <= 0 || (dist < 18 && dotWithPlayer > 0)) {
          if (combatDirector) {
            combatDirector.releaseAirAttackSlot(this.id, time, personalCooldown);
          }
          this.droneState = DroneCombatState.BREAK_AWAY;
          this.droneStateTimer = 0;
          this.flankDir = Math.random() > 0.5 ? 1 : -1;
        }
        break;
      }

      case DroneCombatState.BREAK_AWAY: {
        currentSteerTurnRate = 8.5; // Agile bank away

        if (this.droneTelegraphMesh) this.droneTelegraphMesh.visible = false;

        const awayX = -dirX * 0.85 + (-dirZ * this.flankDir) * 0.95;
        const awayZ = -dirZ * 0.85 + (dirX * this.flankDir) * 0.95;
        const awayLen = Math.max(1, Math.hypot(awayX, awayZ));

        desiredHorizontalX = (awayX / awayLen) * breakawaySpeed + repelForceX + avoidForceX;
        desiredHorizontalZ = (awayZ / awayLen) * breakawaySpeed + repelForceZ + avoidForceZ;

        if (dist > 45 || this.droneStateTimer > 1.3) {
          this.droneState = DroneCombatState.REPOSITION;
          this.droneStateTimer = 0;
          if (combatDirector) {
            this.assignedSectorAngle = combatDirector.getAssignedApproachAngle(this.id, this.personalityOffset);
          }
        }
        break;
      }

      case DroneCombatState.REPOSITION: {
        targetWaypointX = targetPos.x + Math.sin(this.assignedSectorAngle) * (approachStandoff + 6);
        targetWaypointZ = targetPos.z + Math.cos(this.assignedSectorAngle) * (approachStandoff + 6);
        const wpDx = targetWaypointX - this.body.position.x;
        const wpDz = targetWaypointZ - this.body.position.z;
        const wpDist = Math.max(1, Math.hypot(wpDx, wpDz));

        desiredHorizontalX = (wpDx / wpDist) * (cruiseSpeed * 0.9) + repelForceX * 0.9 + avoidForceX;
        desiredHorizontalZ = (wpDz / wpDist) * (cruiseSpeed * 0.9) + repelForceZ * 0.9 + avoidForceZ;

        if (wpDist < 18.0 || this.droneStateTimer > 2.8) {
          this.droneState = DroneCombatState.ATTACK_SETUP;
          this.droneStateTimer = 0;
        }
        break;
      }
    }

    // 5. Apply horizontal smoothed movement
    this.applySmoothMovement(desiredHorizontalX, desiredHorizontalZ, delta, currentSteerTurnRate);

    // 6. Orientation & Aerial Banking
    const horizSpeed = Math.hypot(this.smoothVelX, this.smoothVelZ);
    if (horizSpeed > 0.5) {
      const moveHeading = Math.atan2(this.smoothVelX, this.smoothVelZ);
      this.mesh.rotation.y = stepAngle(this.mesh.rotation.y, moveHeading, currentSteerTurnRate, delta);
      this.ring.rotation.y = 0;

      const currentHeading = this.mesh.rotation.y;
      const targetHeading = Math.atan2(desiredHorizontalX, desiredHorizontalZ);
      const headingDiff = shortestAngleDelta(currentHeading, targetHeading);
      const targetBank = THREE.MathUtils.clamp(-headingDiff * 0.85, -maxBank, maxBank);
      this.airBankAngle = THREE.MathUtils.lerp(this.airBankAngle, targetBank, Math.min(1, delta * 9.0));
      this.ring.rotation.z = this.airBankAngle;

      const pitchMult = this.droneState === DroneCombatState.ATTACK_RUN ? 0.15 : 0.09;
      const targetPitch = THREE.MathUtils.clamp((horizSpeed / attackSpeed) * pitchMult, -0.2, 0.2);
      this.ring.rotation.x = THREE.MathUtils.lerp(this.ring.rotation.x, targetPitch, Math.min(1, delta * 6.0));
    } else {
      this.ring.rotation.y = 0;
      this.ring.rotation.z = THREE.MathUtils.lerp(this.ring.rotation.z, 0, delta * 4.0);
      this.ring.rotation.x = THREE.MathUtils.lerp(this.ring.rotation.x, 0, delta * 4.0);
    }

    // 7. Independent chin gun tracking
    if (this.gunYawPivot) {
      const dAimX = targetPos.x - this.body.position.x;
      const dAimY = targetPos.y - this.body.position.y;
      const dAimZ = targetPos.z - this.body.position.z;
      const dHoriz = Math.max(1, Math.hypot(dAimX, dAimZ));
      const dPlayerYaw = Math.atan2(dAimX, dAimZ);
      const dBodyYaw = this.mesh.rotation.y;
      let dRelYaw = dPlayerYaw - dBodyYaw;
      while (dRelYaw < -Math.PI) dRelYaw += Math.PI * 2;
      while (dRelYaw > Math.PI) dRelYaw -= Math.PI * 2;
      dRelYaw = THREE.MathUtils.clamp(dRelYaw, -1.15, 1.15);
      this.gunYawPivot.rotation.y = stepAngle(this.gunYawPivot.rotation.y, dRelYaw, 5.5, delta);

      if (this.cannonPitchPivot) {
        const dPitch = THREE.MathUtils.clamp(-Math.atan2(dAimY, dHoriz), -0.65, 0.45);
        this.cannonPitchPivot.rotation.x = stepAngle(this.cannonPitchPivot.rotation.x, dPitch, 4.5, delta);
      }
    }

    if (this.enemyRotor) this.enemyRotor.rotation.y += 34.0 * delta;
    if (this.enemyTailRotor) this.enemyTailRotor.rotation.x += 38.0 * delta;

    copyPhysicsPos(this.mesh, this.body.position);
    if (typeof window !== "undefined" && (window as any).__HELI_AI_DEBUG__) {
      this.updateAiDebug(
        this.scene,
        true,
        desiredHorizontalX,
        desiredHorizontalZ,
        targetWaypointX,
        targetWaypointZ,
      );
    } else if (this.aiDebugGroup) {
      this.updateAiDebug(this.scene, false, 0, 0);
    }
    return fired;
  }

  /** Hold a support position near the group (behind it, slightly orbiting). */
  private hoverBehindGroup(
    dirX: number,
    dirZ: number,
    dist: number,
    repelForceX: number,
    repelForceZ: number,
    avoidForceX: number,
    avoidForceZ: number,
    delta: number,
    holdRange: number,
  ) {
    const tangentX = -dirZ * this.flankDir;
    const tangentZ = dirX * this.flankDir;
    let mx: number;
    let mz: number;
    if (dist > holdRange + 25) {
      mx = dirX * 40;
      mz = dirZ * 40;
    } else if (dist < holdRange - 25) {
      mx = (-dirX + tangentX * 0.6) * 30;
      mz = (-dirZ + tangentZ * 0.6) * 30;
    } else {
      mx = tangentX * 16;
      mz = tangentZ * 16;
    }
    this.applySmoothMovement(mx + repelForceX + avoidForceX, mz + repelForceZ + avoidForceZ, delta, 8);
  }

  /** Pulse the flat telegraph ring (support aura or attack warning). */
  private showTelegraph(time: number, show: boolean, color: number) {
    if (!this.variantTelegraph) return;
    this.variantTelegraph.visible = show;
    if (show) {
      const m = this.variantTelegraph.material as THREE.MeshBasicMaterial;
      m.color.setHex(color);
      m.opacity = 0.3 + Math.sin(time * 18) * 0.25;
      this.variantTelegraph.scale.setScalar(1 + Math.sin(time * 18) * 0.2);
      this.variantTelegraph.rotation.z = time * 3;
    }
  }

  /** Drone → ally support beam (mutated in place, no per-frame allocation). */
  private pulseSupport(time: number, color: number) {
    if (this.supportTarget && this.supportTarget.active) {
      if (!this.supportLine) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
        this.supportLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.55,
        }));
        this.scene.add(this.supportLine);
      }
      const arr = this.supportLine.geometry.attributes.position.array as Float32Array;
      arr[0] = this.body.position.x;
      arr[1] = this.body.position.y + 0.6;
      arr[2] = this.body.position.z;
      arr[3] = this.supportTarget.body.position.x;
      arr[4] = this.supportTarget.body.position.y + 0.6;
      arr[5] = this.supportTarget.body.position.z;
      this.supportLine.geometry.attributes.position.needsUpdate = true;
      this.supportLine.visible = true;
      const m = this.supportLine.material as THREE.LineBasicMaterial;
      m.color.setHex(color);
      m.opacity = 0.35 + Math.sin(time * 8) * 0.25;
    } else if (this.supportLine) {
      this.supportLine.visible = false;
    }
    if (this.variantTelegraph) {
      this.variantTelegraph.visible = true;
      const m = this.variantTelegraph.material as THREE.MeshBasicMaterial;
      m.color.setHex(color);
      m.opacity = 0.25 + Math.sin(time * 6) * 0.15;
    }
  }

  /** Place the siege artillery impact marker at the predicted shell landing. */
  private placeSiegeMarker(dirX: number, dirZ: number) {
    if (!this.variantMarker) {
      const geo = new THREE.RingGeometry(5, 7.5, 26);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff7744,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.variantMarker = new THREE.Mesh(geo, mat);
      this.variantMarker.rotation.x = -Math.PI / 2;
      this.scene.add(this.variantMarker);
    }
    const landX = this.body.position.x + dirX * 145;
    const landZ = this.body.position.z + dirZ * 145;
    this.variantMarker.position.set(landX, 0.3, landZ);
    this.variantMarker.visible = true;
  }

  private hideSiegeMarker() {
    if (this.variantMarker) this.variantMarker.visible = false;
  }

  override destroy() {
    this.supportTarget = null;
    if (this.supportLine) {
      this.supportLine.parent?.remove(this.supportLine);
      this.supportLine.geometry.dispose();
      (this.supportLine.material as THREE.Material).dispose();
      this.supportLine = null;
    }
    if (this.variantMarker) {
      this.variantMarker.parent?.remove(this.variantMarker);
      this.variantMarker.geometry.dispose();
      (this.variantMarker.material as THREE.Material).dispose();
      this.variantMarker = null;
    }
    if (this.priorityMarkerMesh) {
      this.priorityMarkerMesh.parent?.remove(this.priorityMarkerMesh);
      this.priorityMarkerMesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry?.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material?.dispose();
          }
        }
      });
      this.priorityMarkerMesh = null;
    }
    if (this.aiDebugGroup) {
      this.aiDebugGroup.traverse((child) => {
        if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
          child.geometry?.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material?.dispose();
          }
        }
      });
      this.aiDebugGroup.parent?.remove(this.aiDebugGroup);
      this.aiDebugGroup = null;
    }
    super.destroy();
  }

  /** Development-only AI visualization (green: desired, blue: actual, red: aim, yellow: waypoint). */
  updateAiDebug(
    scene: THREE.Scene,
    showDebug: boolean,
    desiredX: number,
    desiredZ: number,
    targetWaypointX?: number,
    targetWaypointZ?: number,
  ) {
    if (!showDebug) {
      if (this.aiDebugGroup) {
        this.aiDebugGroup.traverse((c) => {
          if (c instanceof THREE.Line || c instanceof THREE.Mesh) {
            c.geometry?.dispose();
            if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
            else c.material?.dispose();
          }
        });
        scene.remove(this.aiDebugGroup);
        this.aiDebugGroup = null;
      }
      return;
    }

    if (!this.aiDebugGroup) {
      this.aiDebugGroup = new THREE.Group();
      this.aiDebugGroup.name = `AIDebug_${this.id}`;
      scene.add(this.aiDebugGroup);
    }

    while (this.aiDebugGroup.children.length > 0) {
      const child = this.aiDebugGroup.children[0];
      this.aiDebugGroup.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material?.dispose();
      }
    }

    const px = this.body.position.x;
    const py = this.body.position.y;
    const pz = this.body.position.z;

    // 1. GREEN = Desired movement vector
    const desiredLen = Math.hypot(desiredX, desiredZ);
    if (desiredLen > 0.1) {
      const gDirX = (desiredX / desiredLen) * Math.min(14, desiredLen * 0.4);
      const gDirZ = (desiredZ / desiredLen) * Math.min(14, desiredLen * 0.4);
      const greenGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(px, py, pz),
        new THREE.Vector3(px + gDirX, py, pz + gDirZ),
      ]);
      const greenMat = new THREE.LineBasicMaterial({ color: 0x55ff55 });
      this.aiDebugGroup.add(new THREE.Line(greenGeo, greenMat));
    }

    // 2. BLUE = Actual velocity vector
    const actualLen = Math.hypot(this.smoothVelX, this.smoothVelZ);
    if (actualLen > 0.1) {
      const bDirX = (this.smoothVelX / actualLen) * Math.min(14, actualLen * 0.4);
      const bDirZ = (this.smoothVelZ / actualLen) * Math.min(14, actualLen * 0.4);
      const blueGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(px, py, pz),
        new THREE.Vector3(px + bDirX, py, pz + bDirZ),
      ]);
      const blueMat = new THREE.LineBasicMaterial({ color: 0x3399ff });
      this.aiDebugGroup.add(new THREE.Line(blueGeo, blueMat));
    }

    // 3. RED = Gun aim direction
    const aimHeading = this.mesh.rotation.y + (this.gunYawPivot ? this.gunYawPivot.rotation.y : 0);
    const redGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(px, py - 0.2, pz),
      new THREE.Vector3(px + Math.sin(aimHeading) * 12, py - 0.2, pz + Math.cos(aimHeading) * 12),
    ]);
    const redMat = new THREE.LineBasicMaterial({ color: 0xff3333 });
    this.aiDebugGroup.add(new THREE.Line(redGeo, redMat));

    // 4. YELLOW = Target Waypoint line
    if (targetWaypointX !== undefined && targetWaypointZ !== undefined) {
      const yellowGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(px, py, pz),
        new THREE.Vector3(targetWaypointX, py, targetWaypointZ),
      ]);
      const yellowMat = new THREE.LineBasicMaterial({ color: 0xffff33 });
      this.aiDebugGroup.add(new THREE.Line(yellowGeo, yellowMat));
    }
  }

  /** Tangent (orbit) velocity components around a direction vector. */
  private tangentX(dx: number, dz: number, scale: number): number {
    return -dz * this.flankDir * scale;
  }

  private tangentZ(dx: number, dz: number, scale: number): number {
    return dx * this.flankDir * scale;
  }

  /** First-order smoothing toward a desired velocity, then write it to the body. */
  private applySmoothMovement(desiredX: number, desiredZ: number, delta: number, rate: number) {
    const k = Math.min(1, delta * rate);
    this.smoothVelX += (desiredX - this.smoothVelX) * k;
    this.smoothVelZ += (desiredZ - this.smoothVelZ) * k;
    // B1: shock slow scales only the written velocity — the smoothed state
    // stays at full speed, so recovery is instant when the effect expires.
    const slow = this.statusTime < this.statusShockUntil ? SHOCK_SPEED_MULT : 1;
    this.body.velocity.set(this.smoothVelX * slow, 0, this.smoothVelZ * slow);
  }

  /** Lazily clone shared materials so the flash never mutates a shared cache. */
  private ensureHitFlashClones() {
    if (this.flashClones) return;
    const clones: { material: THREE.Material; baseColor: THREE.Color }[] = [];
    this.mesh.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const material = child.material;
      if (Array.isArray(material) || !material || !material.userData?.shared) return;
      const clone = material.clone();
      clone.userData = { ...(clone.userData ?? {}), shared: false };
      child.material = clone;
      if (clone instanceof THREE.MeshLambertMaterial || clone instanceof THREE.MeshToonMaterial) {
        clone.emissive.setHex(0x000000);
        clones.push({ material: clone, baseColor: new THREE.Color(0x000000) });
      } else if (clone instanceof THREE.MeshBasicMaterial) {
        clones.push({ material: clone, baseColor: new THREE.Color(clone.color) });
      }
    });
    this.flashClones = clones;
  }

  /** Decay the hit flash and apply/restore the per-enemy material state. */
  private updateHitFlash(delta: number) {
    if (this.hitFlashTimer > 0) {
      this.hitFlashTimer -= delta;
      this.ensureHitFlashClones();
      if (!this.flashClones) return;
      const strength = Math.max(0, Math.min(1, this.hitFlashTimer / Enemy.HIT_FLASH_DURATION));
      for (const entry of this.flashClones) {
        if (entry.material instanceof THREE.MeshLambertMaterial || entry.material instanceof THREE.MeshToonMaterial) {
          entry.material.emissive.copy(Enemy.HIT_FLASH_COLOR).multiplyScalar(strength * 0.85);
        } else if (entry.material instanceof THREE.MeshBasicMaterial) {
          entry.material.color.copy(entry.baseColor).lerp(Enemy.HIT_FLASH_COLOR, strength);
        }
      }
    } else if (this.statusTime < this.statusBurnUntil || this.statusTime < this.statusEmpUntil || this.statusTime < this.statusShockUntil) {
      // B1: status tint while no hit flash is running (burn > EMP > shock).
      this.ensureHitFlashClones();
      if (!this.flashClones) return;
      const burning = this.statusTime < this.statusBurnUntil;
      const emped = !burning && this.statusTime < this.statusEmpUntil;
      const tint = burning
        ? Enemy.STATUS_TINT_BURN
        : emped
          ? Enemy.STATUS_TINT_EMP
          : Enemy.STATUS_TINT_SHOCK;
      for (const entry of this.flashClones) {
        if (entry.material instanceof THREE.MeshLambertMaterial || entry.material instanceof THREE.MeshToonMaterial) {
          entry.material.emissive.copy(tint).multiplyScalar(0.5);
        } else if (entry.material instanceof THREE.MeshBasicMaterial) {
          entry.material.color.copy(entry.baseColor).lerp(tint, 0.45);
        }
      }
    } else if (this.flashClones) {
      for (const entry of this.flashClones) {
        if (entry.material instanceof THREE.MeshLambertMaterial || entry.material instanceof THREE.MeshToonMaterial) {
          entry.material.emissive.setHex(0x000000);
        } else if (entry.material instanceof THREE.MeshBasicMaterial) {
          entry.material.color.copy(entry.baseColor);
        }
      }
      this.flashClones = null;
    }
  }

  /** How responsively this enemy type tracks its desired velocity. */
  private smoothRate(): number {
    if (this.type === EnemyType.TANK) return 5;
    if (this.type === EnemyType.BOSS) return 6;
    return 8;
  }

  /**
   * Aim lead: predict where the target will be when a straight bullet arrives
   * so shots track a moving player instead of firing at a stale position.
   * The intercept is solved with fixed-point iteration on bullet travel time.
   */
  private leadAim(
    targetPos: CANNON.Vec3,
    targetVel: CANNON.Vec3 | null,
    projectileSpeed: number,
  ): { x: number; y: number; z: number } {
    let t = Math.hypot(targetPos.x - this.body.position.x, targetPos.z - this.body.position.z) / Math.max(1, projectileSpeed);
    t = Math.min(t, 3.0);
    if (targetVel) {
      for (let i = 0; i < 3; i++) {
        const px = targetPos.x + targetVel.x * t;
        const pz = targetPos.z + targetVel.z * t;
        t = Math.hypot(px - this.body.position.x, pz - this.body.position.z) / Math.max(1, projectileSpeed);
        t = Math.min(t, 3.0);
      }
    }
    const ax = targetPos.x + (targetVel ? targetVel.x * t : 0) - this.body.position.x;
    const ay = targetPos.y + (targetVel ? targetVel.y * t : 0) - this.body.position.y;
    const az = targetPos.z + (targetVel ? targetVel.z * t : 0) - this.body.position.z;
    const len = Math.hypot(ax, az) + 0.001;
    const len3d = Math.hypot(ax, ay, az) + 0.001;
    return { x: ax / len, y: ay / len3d, z: az / len };
  }

  /**
   * Angular aim error applied to an already-lead shot — the piece that makes
   * enemy AI "more accurate" over time. High aimAccuracy (later waves / hard
   * difficulty) collapses the cone so shots land tighter; early waves leave a
   * readable spread so it isn't an aimbot. Shots also spread a little more at
   * range (harder to hold a read on a distant target).
   */
  private applyAimError(aim: { x: number; y?: number; z: number }, dist: number): { x: number; y: number; z: number } {
    const skill = THREE.MathUtils.clamp(Number.isFinite(this.aimAccuracy) ? this.aimAccuracy : 1, 0, 1);
    // ~0.09 rad (~5.2°) of sway at skill 0.6 → ~0.03 rad (~1.7°) at skill 1.
    const baseRad = THREE.MathUtils.lerp(0.09, 0.03, skill);
    const rangeScale = THREE.MathUtils.clamp(dist / 90, 0.8, 1.8);
    let err = (Math.random() * 2 - 1) * baseRad * rangeScale;
    // Slight counter-bias when leading fast targets so close-in shots feel fair.
    err *= 0.88;
    const c = Math.cos(err);
    const s = Math.sin(err);
    return { x: aim.x * c - aim.z * s, y: aim.y ?? 0, z: aim.x * s + aim.z * c };
  }

  /**
   * Line-of-sight: does a straight bullet line from the enemy to the target
   * pass through any standing building? Only blocks taller than the shooter
   * can occlude — rooftop gunners and high fliers shoot over buildings, which
   * mirrors the movement avoidance's "flying above the roof" rule.
   */
  private hasLineOfSight(city: CityEnvironment, targetPos: CANNON.Vec3): boolean {
    const x1 = this.body.position.x;
    const y1 = this.body.position.y + 0.35;
    const z1 = this.body.position.z;
    const x2 = targetPos.x;
    const y2 = targetPos.y;
    const z2 = targetPos.z;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    const minX = Math.min(x1, x2) - 10;
    const maxX = Math.max(x1, x2) + 10;
    const minZ = Math.min(z1, z2) - 10;
    const maxZ = Math.max(z1, z2) + 10;
    const candidateBlocks = city && typeof city.getBlocksInAABB === "function"
      ? city.getBlocksInAABB(minX, maxX, minZ, maxZ)
      : (city?.blocks ?? []);

    for (let i = 0; i < candidateBlocks.length; i++) {
      const block = candidateBlocks[i];
      if (block.destroyed) continue;
      if (block.height <= y1 - 0.5) continue;
      const minX = block.x - block.width / 2;
      const maxX = block.x + block.width / 2;
      const maxY = block.height;
      const minZ = block.z - block.depth / 2;
      const maxZ = block.z + block.depth / 2;

      // Slab test for segment-vs-AABB intersection (t in [0,1]).
      let tmin = 0;
      let tmax = 1;
      let blocked = true;

      if (Math.abs(dx) < 1e-6) {
        if (x1 < minX || x1 > maxX) blocked = false;
      } else {
        let t1 = (minX - x1) / dx;
        let t2 = (maxX - x1) / dx;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) blocked = false;
      }
      if (!blocked) continue;

      if (Math.abs(dy) < 1e-6) {
        if (y1 < 0 || y1 > maxY) blocked = false;
      } else {
        let t1 = (0 - y1) / dy;
        let t2 = (maxY - y1) / dy;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) blocked = false;
      }
      if (!blocked) continue;

      if (Math.abs(dz) < 1e-6) {
        if (z1 < minZ || z1 > maxZ) blocked = false;
      } else {
        let t1 = (minZ - z1) / dz;
        let t2 = (maxZ - z1) / dz;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) blocked = false;
      }
      if (blocked) return false;
    }
    return true;
  }

  updateDirection(
    targetPos: CANNON.Vec3,
    time: number,
    enemyProjectilePool: ProjectilePool,
    playerBullets: Projectile[],
    allEnemies: Enemy[],
    city: CityEnvironment,
    fireRateMult: number = 1.0,
    delta: number = 0.016,
    playerBody: CANNON.Body | null = null,
    targetVel: CANNON.Vec3 | null = null,
    combatDirector?: CombatDirector | null,
    currentWave: number = 1,
    threatLevel: number = 1,
    isOverdrive: boolean = false,
    overdriveMultiplier: number = 1.0,
    isBossActive: boolean = false,
  ) {
    if (!this.active) {
      if (this.isDying) {
        this.updateDeathSpiral(delta, city, time);
      }
      return false;
    }

    this.updateHitFlash(delta);
    if (this.priorityMarkerMesh && this.isPriorityTarget) {
      this.priorityMarkerMesh.rotation.y += delta * 2.2;
    }

    // B1: EMP silences weapons — pinning the shot clock keeps every existing
    // interval gate (time - lastShotTime > rate) closed while suppressed.
    if (time < this.statusEmpUntil) this.lastShotTime = time;

    // Boids horizontal repulsion force to prevent enemies from stacking
    let repelForceX = 0;
    let repelForceZ = 0;
    if (Array.isArray(allEnemies)) {
      for (const other of allEnemies) {
        if (other === this || !other.active) continue;
        const dxOther = this.body.position.x - other.body.position.x;
        const dzOther = this.body.position.z - other.body.position.z;
        const distOther = Math.sqrt(dxOther * dxOther + dzOther * dzOther);
        const minDist = (this.radius + other.radius) * 1.35;
        if (distOther < minDist && distOther > 0.001) {
          const force = (1.0 - distOther / minDist) * 16.0;
          repelForceX += (dxOther / distOther) * force;
          repelForceZ += (dzOther / distOther) * force;
        }
      }
    }

    // Steering-based building avoidance: curve around block faces BEFORE touching
    // them (the overlap push below stays as a safety net).
    let avoidForceX = 0;
    let avoidForceZ = 0;
    const avoidRange = this.radius * 2 + 3;
    const nearbyBlocks = city && typeof city.getBlocksNear === "function"
      ? city.getBlocksNear(this.body.position.x, this.body.position.z, avoidRange + 30)
      : (city?.blocks ?? []);

    if (nearbyBlocks.length > 0) {
      for (let i = 0; i < nearbyBlocks.length; i++) {
        const block = nearbyBlocks[i];
        if (block.destroyed) continue;
        // Flying above the roof? No need to steer around it (mirrors the 3D overlap check).
        if (this.body.position.y - this.radius * 0.75 > block.height) continue;
        const bx = this.body.position.x;
        const bz = this.body.position.z;
        if (
          Math.abs(bx - block.x) > block.width / 2 + avoidRange ||
          Math.abs(bz - block.z) > block.depth / 2 + avoidRange
        ) {
          continue;
        }
        const closestX = THREE.MathUtils.clamp(bx, block.x - block.width / 2, block.x + block.width / 2);
        const closestZ = THREE.MathUtils.clamp(bz, block.z - block.depth / 2, block.z + block.depth / 2);
        const dxA = bx - closestX;
        const dzA = bz - closestZ;
        const dA = Math.sqrt(dxA * dxA + dzA * dzA);
        if (dA < avoidRange && dA > 0.001) {
          const strength = (1 - dA / avoidRange) * (this.radius * 6);
          avoidForceX += (dxA / dA) * strength;
          avoidForceZ += (dzA / dA) * strength;
        }
      }

      // AABB Building Collision Resolution
      for (let i = 0; i < nearbyBlocks.length; i++) {
        const block = nearbyBlocks[i];
        if (block.destroyed) continue;

        const dxBlock = this.body.position.x - block.x;
        const dzBlock = this.body.position.z - block.z;
        const rangeX = block.width / 2 + this.radius + 5;
        const rangeZ = block.depth / 2 + this.radius + 5;

        if (Math.abs(dxBlock) > rangeX || Math.abs(dzBlock) > rangeZ) {
          continue;
        }

        const enemyMinX = this.body.position.x - this.radius;
        const enemyMaxX = this.body.position.x + this.radius;
        const enemyMinY = this.body.position.y - this.radius * 0.75;
        const enemyMaxY = this.body.position.y + this.radius * 0.75;
        const enemyMinZ = this.body.position.z - this.radius;
        const enemyMaxZ = this.body.position.z + this.radius;

        const blockMinX = block.x - block.width / 2;
        const blockMaxX = block.x + block.width / 2;
        const blockMinY = 0;
        const blockMaxY = block.height;
        const blockMinZ = block.z - block.depth / 2;
        const blockMaxZ = block.z + block.depth / 2;

        const overlapX = Math.min(enemyMaxX, blockMaxX) - Math.max(enemyMinX, blockMinX);
        const overlapY = Math.min(enemyMaxY, blockMaxY) - Math.max(enemyMinY, blockMinY);
        const overlapZ = Math.min(enemyMaxZ, blockMaxZ) - Math.max(enemyMinZ, blockMinZ);

        if (overlapX > 0 && overlapY > 0 && overlapZ > 0) {
          // We have an intersection! Find the minimum penetration axis
          if (overlapY < overlapX && overlapY < overlapZ) {
            // Push upwards onto the roof
            this.body.position.y += overlapY;
            this.body.velocity.y = Math.max(0, this.body.velocity.y);
          } else if (overlapX < overlapZ) {
            // Push along X axis and bias the smoothed velocity away so the enemy
            // doesn't instantly re-stick against the wall.
            const pushDir = this.body.position.x < block.x ? -1 : 1;
            this.body.position.x += pushDir * overlapX;
            this.smoothVelX = pushDir * Math.min(Math.max(Math.abs(this.smoothVelX), 6), 36);
            this.body.velocity.x = this.smoothVelX;
          } else {
            // Push along Z axis and bias the smoothed velocity away
            const pushDir = this.body.position.z < block.z ? -1 : 1;
            this.body.position.z += pushDir * overlapZ;
            this.smoothVelZ = pushDir * Math.min(Math.max(Math.abs(this.smoothVelZ), 6), 36);
            this.body.velocity.z = this.smoothVelZ;
          }
        }
      }
    }

    const dx = targetPos.x - this.body.position.x;
    const dz = targetPos.z - this.body.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz) + 0.001;

    const dirX = dx / dist;
    const dirZ = dz / dist;

    // --- Regeneration (REGENERATING modifier) ---
    const regenerating = this.regenPerSecond > 0 && this.hp > 0 && this.hp < this.maxHp && time - this.lastDamageTime > 3.0;
    if (regenerating) {
      this.hp = Math.min(this.maxHp, this.hp + this.regenPerSecond * Math.max(0, delta));
    }
    if (this.regenMesh) {
      const pulse = 1 + Math.sin(time * 4.5) * 0.08;
      this.regenMesh.scale.setScalar(pulse);
      this.regenMesh.rotation.y = time * 0.9;
      (this.regenMesh.material as THREE.MeshBasicMaterial).opacity = regenerating ? 0.32 : 0.12;
    }

    let fired = false;

    // 1. BOSS — Phased heavy gunship with telegraphed volleys
    if (this.type === EnemyType.BOSS) {
      fired = this.updateBoss(
        targetPos,
        time,
        dist,
        dirX,
        dirZ,
        enemyProjectilePool,
        repelForceX,
        repelForceZ,
        fireRateMult,
        delta,
        avoidForceX,
        avoidForceZ,
        combatDirector,
        currentWave,
      );
      copyPhysicsPos(this.mesh, this.body.position);
      if (this.telegraphMesh) {
        this.telegraphMesh.visible = this.telegraphTimer > 0;
        if (this.telegraphTimer > 0) {
          const pulse = 0.35 + Math.sin(time * 24) * 0.2;
          (this.telegraphMesh.material as THREE.MeshBasicMaterial).opacity = pulse;
        }
      }
      if (this.enemyRotor) this.enemyRotor.rotation.y += 22.0 * delta;
      if (this.enemyTailRotor) this.enemyTailRotor.rotation.x += 32.0 * delta;
      return fired;
    }

    // 2. KAMIKAZE DRONE — High-speed ramming dive
    if (this.variant === EnemyVariant.KAMIKAZE_DRONE || this.pattern === AttackPattern.KAMIKAZE) {
      return this.updateKamikazeDroneAI(
        targetPos,
        time,
        dist,
        dirX,
        dirZ,
        repelForceX,
        repelForceZ,
        avoidForceX,
        avoidForceZ,
        delta,
        targetVel,
      );
    }

    // 3. SUPPORT DRONES & MINELAYERS — Shield, Repair, Proximity Mine support
    if (
      this.variant === EnemyVariant.SHIELD_DRONE ||
      this.variant === EnemyVariant.REPAIR_DRONE ||
      this.variant === EnemyVariant.MINELAYER
    ) {
      return this.updateSupportDroneAI(
        targetPos,
        time,
        dist,
        dirX,
        dirZ,
        enemyProjectilePool,
        repelForceX,
        repelForceZ,
        avoidForceX,
        avoidForceZ,
        delta,
        allEnemies,
        playerBody,
        city,
      );
    }

    // 4. FLYING COMBAT UNITS — Drones, Shooters, Attack Gunships, Rocket Gunships, Heavy Gunships, Interceptors
    if (this.movementClass === EnemyMovementClass.FLYING) {
      return this.updateAirCombatAI(
        targetPos,
        time,
        dist,
        dirX,
        dirZ,
        enemyProjectilePool,
        repelForceX,
        repelForceZ,
        avoidForceX,
        avoidForceZ,
        fireRateMult,
        delta,
        city,
        targetVel,
        combatDirector,
        currentWave,
        threatLevel,
        isOverdrive,
        overdriveMultiplier,
        isBossActive,
      );
    }

    // 5. INFANTRY CLUSTERS — Ground tactical squads
    if (this.type === EnemyType.BASIC) {
      return this.updateInfantryAI(
        targetPos,
        time,
        dist,
        dirX,
        dirZ,
        enemyProjectilePool,
        repelForceX,
        repelForceZ,
        avoidForceX,
        avoidForceZ,
        fireRateMult,
        delta,
        city,
        targetVel,
      );
    }

    // 6. GROUND ARMOR — Tanks, Flak Tanks, Siege Artillery, Missile Carriers
    return this.updateTankAI(
      targetPos,
      time,
      dist,
      dirX,
      dirZ,
      enemyProjectilePool,
      repelForceX,
      repelForceZ,
      avoidForceX,
      avoidForceZ,
      fireRateMult,
      delta,
      city,
      targetVel,
      combatDirector,
      currentWave,
      isBossActive,
      playerBody,
    );
  }

  /**
   * Phased boss behavior:
   *  - Phase 3 (100%-66%): 5-round spread
   *  - Phase 2 (66%-33%): 7-round spread, faster
   *  - Phase 1 (<33%): telegraph a 9-round beam volley
   */
  private updateBoss(
    targetPos: CANNON.Vec3,
    time: number,
    dist: number,
    dirX: number,
    dirZ: number,
    enemyProjectilePool: ProjectilePool,
    repelForceX: number,
    repelForceZ: number,
    fireRateMult: number = 1.0,
    delta: number = 0.016,
    avoidForceX: number = 0,
    avoidForceZ: number = 0,
    combatDirector?: CombatDirector | null,
    currentWave: number = 1,
  ): boolean {
    const ratio = this.hp / this.maxHp;
    const newPhase = bossPhaseForRatio(ratio);
    if (newPhase !== this.phase) {
      this.phase = newPhase;
      this.phaseTimer = time + 0.6; // brief pivot pause on phase change
    }

    const speed = 10;
    const tangentX = -dirZ * this.flankDir;
    const tangentZ = dirX * this.flankDir;
    let desiredX: number;
    let desiredZ: number;
    if (dist > 40) {
      desiredX = dirX * speed * 0.9 + repelForceX + avoidForceX;
      desiredZ = dirZ * speed * 0.9 + repelForceZ + avoidForceZ;
    } else {
      desiredX = (tangentX + dirX * 0.15) * speed + repelForceX + avoidForceX;
      desiredZ = (tangentZ + dirZ * 0.15) * speed + repelForceZ + avoidForceZ;
    }
    this.applySmoothMovement(desiredX, desiredZ, delta, 6);

    // Boss banking & independent gun aiming & reactor core pulse
    if (this.coreGlowMesh) {
      this.coreGlowMesh.scale.setScalar(1 + Math.sin(time * 6) * 0.08);
    }

    const bHorizSpeed = Math.hypot(this.smoothVelX, this.smoothVelZ);
    if (bHorizSpeed > 0.4) {
      const bMoveHeading = Math.atan2(this.smoothVelX, this.smoothVelZ);
      this.mesh.rotation.y = stepAngle(this.mesh.rotation.y, bMoveHeading, 3.5, delta);
      this.ring.rotation.y = 0;
      const bTargetHeading = Math.atan2(desiredX, desiredZ);
      const bHeadingDiff = shortestAngleDelta(this.mesh.rotation.y, bTargetHeading);
      const bTargetBank = THREE.MathUtils.clamp(-bHeadingDiff * 0.5, -0.22, 0.22);
      this.airBankAngle = THREE.MathUtils.lerp(this.airBankAngle, bTargetBank, Math.min(1, delta * 5.0));
      this.ring.rotation.z = this.airBankAngle;
      const bTargetPitch = THREE.MathUtils.clamp((bHorizSpeed / 10) * 0.08, -0.12, 0.12);
      this.ring.rotation.x = THREE.MathUtils.lerp(this.ring.rotation.x, bTargetPitch, Math.min(1, delta * 4.0));
    } else {
      this.mesh.rotation.y = stepAngle(this.mesh.rotation.y, Math.atan2(dirX, dirZ), 2.5, delta);
      this.ring.rotation.y = 0;
      this.ring.rotation.z = THREE.MathUtils.lerp(this.ring.rotation.z, 0, delta * 3.0);
      this.ring.rotation.x = THREE.MathUtils.lerp(this.ring.rotation.x, 0, delta * 3.0);
    }

    if (this.gunYawPivot) {
      const bdx = targetPos.x - this.body.position.x;
      const bdy = targetPos.y - this.body.position.y;
      const bdz = targetPos.z - this.body.position.z;
      const bHorizDist = Math.max(1, Math.hypot(bdx, bdz));
      const bPlayerYaw = Math.atan2(bdx, bdz);
      const bBodyYaw = this.mesh.rotation.y;
      let bRelYaw = bPlayerYaw - bBodyYaw;
      while (bRelYaw < -Math.PI) bRelYaw += Math.PI * 2;
      while (bRelYaw > Math.PI) bRelYaw -= Math.PI * 2;
      bRelYaw = THREE.MathUtils.clamp(bRelYaw, -0.95, 0.95);
      this.gunYawPivot.rotation.y = stepAngle(this.gunYawPivot.rotation.y, bRelYaw, 3.2, delta);

      if (this.cannonPitchPivot) {
        const bPitch = THREE.MathUtils.clamp(-Math.atan2(bdy, bHorizDist), -0.55, 0.35);
        this.cannonPitchPivot.rotation.x = stepAngle(this.cannonPitchPivot.rotation.x, bPitch, 2.5, delta);
      }
    }

    let muzzleX = this.body.position.x;
    let muzzleY = this.body.position.y + 0.35;
    let muzzleZ = this.body.position.z;
    if (this.muzzlePoint) {
      this.muzzlePoint.getWorldPosition(_projPos);
      muzzleX = _projPos.x;
      muzzleY = _projPos.y;
      muzzleZ = _projPos.z;
    }

    let fired = false;

    // Telegraph attack (phase 1/2): beam warns the player, then fires
    if (this.phase <= 2 && this.telegraphActive) {
      this.smoothVelX = 0;
      this.smoothVelZ = 0;
      this.body.velocity.set(0, 0, 0);
      if (time - this.telegraphStartTime >= BOSS_TELEGRAPH_DURATION) {
        this.telegraphActive = false;
        this.lastShotTime = time; // cooldown AFTER the telegraph volley
        if (combatDirector) {
          combatDirector.releaseHeavyAttackSlot(this.id, time, 2.0);
        }
        // Fire the beam volley along the telegraph line
        const cfg = bossVolleyConfig(this.phase);
        for (let i = 0; i < cfg.shots; i++) {
          const angle = (i - (cfg.shots - 1) / 2) * cfg.spread;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          enemyProjectilePool.spawn(
            muzzleX,
            muzzleY,
            muzzleZ,
            dirX * cos - dirZ * sin,
            dirX * sin + dirZ * cos,
            time,
            cfg.speed,
            8,
            0,
            0xff3366,
            null,
            0,
            0,
            0,
            this.waveDamageMult,
          );
        }
        fired = true;
      }
    } else if (time - this.lastShotTime > (this.phase === 3 ? 2.2 : this.phase === 2 ? 1.7 : 1.2) * fireRateMult) {
      // Start telegraph before firing in phase 1/2 (only when no telegraph is queued)
      if (this.phase <= 2 && time - this.lastShotTime > (this.phase === 2 ? 2.4 : 1.8)) {
        if (combatDirector && !combatDirector.requestHeavyAttackSlot(this.id, "BOSS", time, currentWave, true, 3.0)) {
          return false;
        }
        this.telegraphActive = true;
        this.telegraphStartTime = time;
        return false;
      }

      this.lastShotTime = time + Math.random() * 0.3;
      // Regular volleys stay WEAKER than the telegraphed one (the tell is a
      // bigger attack). Phase 1 telegraphs 9 shots; its regular volley is 5.
      const cfg = bossVolleyConfig(this.phase);
      const regularShots = Math.min(cfg.shots, 5);
      for (let i = 0; i < regularShots; i++) {
        const angle = (i - (regularShots - 1) / 2) * cfg.spread;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        enemyProjectilePool.spawn(
          muzzleX,
          muzzleY,
          muzzleZ,
          dirX * cos - dirZ * sin,
          dirX * sin + dirZ * cos,
          time,
          cfg.speed,
          5,
          0,
          0xffd92e,
          null,
          0,
          0,
          0,
          this.waveDamageMult,
        );
      }
      // Phase 2/1 also throws a radial ring burst
      if (this.phase <= 2) {
        const ringCount = 10;
        for (let i = 0; i < ringCount; i++) {
          const angle = (i / ringCount) * Math.PI * 2;
          enemyProjectilePool.spawn(
            muzzleX,
            muzzleY,
            muzzleZ,
            Math.sin(angle),
            Math.cos(angle),
            time,
            90,
            5,
            0,
            0xffd92e,
            null,
            0,
            0,
            0,
            this.waveDamageMult,
          );
        }
      }
      fired = true;
    }

    return fired;
  }
}

// ---------------------------------------------------------------------------
// Instanced projectile rendering: every pool draws its whole bullet set with
// three InstancedMeshes (tracer core, additive glow, SAM fins) instead of one
// mesh group per bullet. Projectile instances are sim-state only.
// ---------------------------------------------------------------------------
let projectileCoreGeom: THREE.BufferGeometry | null = null;
let projectileGlowGeom: THREE.BufferGeometry | null = null;
let projectileFinsGeom: THREE.BufferGeometry | null = null;

function getProjectileCoreGeometry(): THREE.BufferGeometry {
  if (!projectileCoreGeom) {
    const g = new THREE.CylinderGeometry(0.035, 0.32, 8.8, 6).toNonIndexed();
    g.rotateX(Math.PI / 2); // Align with Z axis
    g.computeVertexNormals();
    projectileCoreGeom = g;
  }
  return projectileCoreGeom;
}

function getProjectileGlowGeometry(): THREE.BufferGeometry {
  if (!projectileGlowGeom) {
    const g = new THREE.CylinderGeometry(0.2, 0.82, 11.6, 6).toNonIndexed();
    g.rotateX(Math.PI / 2);
    g.computeVertexNormals();
    projectileGlowGeom = g;
  }
  return projectileGlowGeom;
}

function getProjectileFinsGeometry(): THREE.BufferGeometry {
  if (!projectileFinsGeom) {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.BoxGeometry(0.08, 0.75, 1.15);
      fin.rotateZ((i * Math.PI) / 2);
      fin.translate(0, 0, 2.8);
      parts.push(fin);
    }
    projectileFinsGeom = mergeGeometries(parts) ?? parts[0];
  }
  return projectileFinsGeom;
}

const _projEuler = new THREE.Euler();
const _projQuat = new THREE.Quaternion();
const _projScale = new THREE.Vector3();
const _projMatrix = new THREE.Matrix4();
const _projHiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const _projColor = new THREE.Color();

export class Projectile {
  active = false;
  pos: CANNON.Vec3 = new CANNON.Vec3();
  prevPos: CANNON.Vec3 = new CANNON.Vec3();
  vel: CANNON.Vec3 = new CANNON.Vec3();
  spawnTime = 0;
  damage = 10;
  blastRadius = 0;
  target: EnemyLock | null = null;
  homingStrength = 0;
  lifetime = 1.35;
  vy = 0;
  gravity = 0;
  /** Wave-scaled damage multiplier carried on the shot (set by the engine/spawner). */
  waveDamageMult: number = 1;
  kind: "STANDARD" | "SAM_MISSILE" = "STANDARD";
  targetType: "PLAYER" | "DECOY" | "NONE" = "NONE";
  /** B1/C6: weapon-mod tags carried with this shot (reset on every spawn). */
  procKind: StatusEffectKind | null = null;
  procChance = 0;
  cluster = false;
  piercing = false;
  shaped = false;
  sourceObjective: Objective | null = null;
  acceleration = 0;
  maxSpeed = Infinity;
  nearMissTriggered = false;
  /** Rendering color; written into the pool's instanceColor on spawn. */
  colorHex: number;

  constructor(
    private pool: ProjectilePool,
    readonly index: number,
    colorHex: number,
  ) {
    this.colorHex = colorHex;
  }

  spawn(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    now: number,
    speed: number,
    damage: number = 10,
    blastRadius: number = 0,
    color?: number,
    target: EnemyLock | null = null,
    homingStrength: number = 0,
    vy: number = 0,
    gravity: number = 0,
    waveDamageMult: number = 1,
  ) {
    this.active = true;
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);

    this.vel.set(dx * speed, vy, dz * speed);
    this.spawnTime = now;
    this.damage = damage;
    this.waveDamageMult = waveDamageMult;
    this.blastRadius = blastRadius;
    this.target = target;
    this.targetType = target ? "PLAYER" : "NONE";
    this.homingStrength = homingStrength;
    this.vy = vy;
    this.gravity = gravity;
    this.kind = "STANDARD";
    this.procKind = null;
    this.procChance = 0;
    this.cluster = false;
    this.piercing = false;
    this.shaped = false;
    this.sourceObjective = null;
    this.acceleration = 0;
    this.maxSpeed = Infinity;
    this.nearMissTriggered = false;
    this.lifetime = Math.max(1.1, Math.min(2.2, 390 / Math.max(speed, 1)));

    if (color !== undefined) this.colorHex = color;
    this.pool.setInstanceColor(this.index, this.colorHex);
  }

  configureSamMissile(source: Objective) {
    this.kind = "SAM_MISSILE";
    this.sourceObjective = source;
    this.lifetime = SAM_MISSILE_LIFETIME;
    this.acceleration = 48;
    this.maxSpeed = 178;
  }

  retargetToDecoy(decoy: EnemyLock) {
    if (!this.active || this.homingStrength <= 0) return false;
    this.target = decoy;
    this.targetType = "DECOY";
    return true;
  }

  update(now: number, delta: number, particles?: GPUParticleSystem) {
    this.prevPos.copy(this.pos);

    if (this.acceleration > 0) {
      const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
      if (speed > 0.001 && speed < this.maxSpeed) {
        const nextSpeed = Math.min(this.maxSpeed, speed + this.acceleration * delta);
        const scale = nextSpeed / speed;
        this.vel.scale(scale, this.vel);
      }
    }

    if (this.targetType === "DECOY" && this.target && !this.target.active) {
      this.target = null;
      this.targetType = "NONE";
    }
    if (this.homingStrength > 0 && this.target?.active) {
      const dx = this.target.body.position.x - this.pos.x;
      const dz = this.target.body.position.z - this.pos.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
      if (len > 0.001 && speed > 0.001) {
        const turn = Math.min(1, this.homingStrength * delta);
        const nextX = THREE.MathUtils.lerp(this.vel.x / speed, dx / len, turn);
        const nextZ = THREE.MathUtils.lerp(this.vel.z / speed, dz / len, turn);
        const nextLen = Math.sqrt(nextX * nextX + nextZ * nextZ) || 1;
        this.vel.x = (nextX / nextLen) * speed;
        this.vel.z = (nextZ / nextLen) * speed;
        this.vel.y +=
          (this.target.body.position.y + 0.4 - this.pos.y) *
          this.homingStrength *
          0.2 *
          delta;
        this.vel.y = THREE.MathUtils.clamp(this.vel.y, -60, 60);
      }
    }

    if (this.gravity > 0) {
      this.vel.y -= this.gravity * delta;
      this.pos.y += this.vel.y * delta;
      if (this.pos.y < 1.2) {
        // Shell lands: splash burst on impact
        if (particles) {
          particles.spawnExplosion(this.pos.x, 1.4, this.pos.z, 22, now, 8);
        }
        this.deactivate();
        return;
      }
      this.pos.x += this.vel.x * delta;
      this.pos.z += this.vel.z * delta;
    } else {
      this.pos.x += this.vel.x * delta;
      this.pos.y += this.vel.y * delta;
      this.pos.z += this.vel.z * delta;
    }

    if (particles && this.active && this.blastRadius > 0) {
      // Missile / Rocket Trails (Smoke and Engine Flame)
      if (Math.random() < 0.6) {
        particles.spawnSmoke(this.pos.x, this.pos.y, this.pos.z, now);
      }
      if (Math.random() < 0.25) {
        particles.spawnSparks(this.pos.x, this.pos.y, this.pos.z, now);
        particles.spawnSparks(this.pos.x, this.pos.y, this.pos.z, now); // Double sparks for engine flame
      }
    }

    if (now - this.spawnTime > this.lifetime) {
      this.deactivate();
    }
  }

  deactivate() {
    this.active = false;
    this.target = null;
    this.targetType = "NONE";
    this.kind = "STANDARD";
    this.pool.hideInstance(this.index);
  }
}

function distancePointToProjectileSegmentSq(
  point: CANNON.Vec3,
  from: CANNON.Vec3,
  to: CANNON.Vec3,
) {
  const sx = to.x - from.x;
  const sz = to.z - from.z;
  const lenSq = sx * sx + sz * sz;
  if (lenSq < 0.0001) {
    const dx = point.x - to.x;
    const dz = point.z - to.z;
    return dx * dx + dz * dz;
  }

  const t = THREE.MathUtils.clamp(
    ((point.x - from.x) * sx + (point.z - from.z) * sz) /
      lenSq,
    0,
    1,
  );
  const closestX = from.x + sx * t;
  const closestZ = from.z + sz * t;
  const dx = point.x - closestX;
  const dz = point.z - closestZ;
  return dx * dx + dz * dz;
}

// --- POWERUP CLASS ---

export class PowerUp {
  mesh: THREE.Group;
  type: PowerUpType;
  active: boolean = true;
  position: THREE.Vector3;
  velocity: THREE.Vector3 = new THREE.Vector3();
  spawnTime: number = 0;
  lifetime: number = 22; // 22 seconds lifetime standard (12s for SALVAGE_CACHE)
  value: number = 1; // XP amount for XP_GEM pickups / Salvage amount
  /** Spinning ground ring so the pickup reads clearly from the air. */
  groundRing: THREE.Mesh | null = null;

  constructor(
    scene: THREE.Scene,
    x: number,
    y: number,
    z: number,
    type: PowerUpType,
  ) {
    this.type = type;
    this.position = new THREE.Vector3(x, y, z);
    this.mesh = new THREE.Group();
    if (type === PowerUpType.SALVAGE_CACHE) {
      this.lifetime = 12.0; // 12 seconds high-value cache window
      this.value = 8;
    }

    // Create powerup visual based on type
    const colors: Record<PowerUpType, number> = {
      [PowerUpType.HEALTH]: 0x22ff44,
      [PowerUpType.DAMAGE_BOOST]: 0xff4422,
      [PowerUpType.SHIELD]: 0x4488ff,
      [PowerUpType.AMMO]: 0xffdd22,
      [PowerUpType.SPEED_BOOST]: 0xff88ff,
      [PowerUpType.BOMB]: 0xff6600,
      [PowerUpType.FUEL]: 0x37ffb8,
      [PowerUpType.XP_GEM]: 0x56e6ff,
      [PowerUpType.SALVAGE]: 0xffa632,
      [PowerUpType.COUNTERMEASURE]: 0xffdc62,
      [PowerUpType.SALVAGE_CACHE]: 0xffbb00,
      [PowerUpType.MAGNET_SURGE]: 0x00e5ff,
      [PowerUpType.EMP_PULSE]: 0xaa44ff,
    };

    const color = colors[type] ?? 0xffffff;

    // Classic arcade pickup indicator: a flat ring on the ground that spins
    // around the pickup so it's visible from the air.
    const isSpecialPayoff = type === PowerUpType.BOMB || type === PowerUpType.SALVAGE_CACHE;
    const groundRingGeo = new THREE.RingGeometry(isSpecialPayoff ? 3.0 : 2.0, isSpecialPayoff ? 3.8 : 2.5, 28);
    groundRingGeo.rotateX(-Math.PI / 2);
    const groundRingMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: isSpecialPayoff ? 0.95 : 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.groundRing = new THREE.Mesh(groundRingGeo, groundRingMat);
    // Ring hovers just below the pickup so it stays visible on rooftops and in the air
    this.groundRing.position.set(x, Math.max(0.12, y - 1.2), z);
    scene.add(this.groundRing);

    // Bombs & Salvage Caches get a tall light pillar so the payoff pickup is unmissable
    if (isSpecialPayoff) {
      const beamGeo = new THREE.CylinderGeometry(0.9, 2.4, 46, 10, 1, true);
      beamGeo.translate(0, 23, 0);
      const beamMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: type === PowerUpType.SALVAGE_CACHE ? 0.45 : 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(x, Math.max(1, y - 1), z);
      scene.add(beam);
      this.groundRing.userData.beam = beam;
    }

    if (type === PowerUpType.XP_GEM) {
      // VS-style XP gem: small spinning cyan crystal with a bright core
      const gemGeom = new THREE.OctahedronGeometry(0.7, 0);
      const gemMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
      });
      const gem = new THREE.Mesh(gemGeom, gemMat);
      gem.scale.set(1, 1.5, 1);
      this.mesh.add(gem);

      const inner = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.3, 0),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
        }),
      );
      inner.scale.set(1, 1.5, 1);
      this.mesh.add(inner);

      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 10, 8),
        createGlowMaterial(color, 0.3),
      );
      this.mesh.add(halo);

      this.mesh.position.copy(this.position);
      scene.add(this.mesh);
      disableShadowCasting(this.mesh);
      return;
    }

    if (type === PowerUpType.SALVAGE) {
      for (let i = 0; i < 3; i++) {
        const scrap = createBox(0.35 + i * 0.12, 0.22, 1.1 - i * 0.16, i === 1 ? 0xffc257 : 0xc56a24);
        scrap.rotation.set(i * 0.7, i * 1.1, i * 0.45);
        scrap.position.set((i - 1) * 0.45, (i % 2) * 0.3, (1 - i) * 0.2);
        this.mesh.add(scrap);
      }
      const halo = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.12, 6, 12), createGlowMaterial(0xffa632, 0.45));
      halo.rotation.x = Math.PI / 2;
      this.mesh.add(halo);
      this.mesh.position.copy(this.position);
      scene.add(this.mesh);
      disableShadowCasting(this.mesh);
      return;
    }

    if (type === PowerUpType.SALVAGE_CACHE) {
      // High-Value Salvage Cache: Heavy reinforced armored crate with glowing gold edges
      const crate = createBox(1.8, 1.4, 1.8, 0x8b6508);
      this.mesh.add(crate);
      const goldTrim = createBox(1.9, 0.3, 1.9, 0xffd700);
      this.mesh.add(goldTrim);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 8), createGlowMaterial(0xffbb00, 0.35));
      this.mesh.add(halo);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.4, 0.18, 6, 16),
        new THREE.MeshBasicMaterial({ color: 0xffe600, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending }),
      );
      ring.rotation.x = Math.PI / 2;
      this.mesh.add(ring);
      this.mesh.position.copy(this.position);
      scene.add(this.mesh);
      disableShadowCasting(this.mesh);
      return;
    }

    if (type === PowerUpType.MAGNET_SURGE) {
      // Electromagnetic Surge: Double orbiting energy toruses around bright cyan spark core
      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.2, 1),
        new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending }),
      );
      this.mesh.add(core);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(2.2, 10, 8), createGlowMaterial(0x00e5ff, 0.4));
      this.mesh.add(halo);
      const ringA = new THREE.Mesh(
        new THREE.TorusGeometry(2.0, 0.14, 6, 16),
        new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }),
      );
      ringA.rotation.x = Math.PI / 3;
      this.mesh.add(ringA);
      const ringB = new THREE.Mesh(
        new THREE.TorusGeometry(2.0, 0.14, 6, 16),
        new THREE.MeshBasicMaterial({ color: 0x55ffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }),
      );
      ringB.rotation.y = Math.PI / 3;
      this.mesh.add(ringB);
      this.mesh.position.copy(this.position);
      scene.add(this.mesh);
      disableShadowCasting(this.mesh);
      return;
    }

    if (type === PowerUpType.EMP_PULSE) {
      // EMP Pulse Core: Pulsing purple orb with shockwave energy arcs
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.3, 1),
        new THREE.MeshBasicMaterial({ color: 0xee88ff, blending: THREE.AdditiveBlending }),
      );
      this.mesh.add(core);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(2.2, 10, 8), createGlowMaterial(0xaa44ff, 0.4));
      this.mesh.add(halo);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.2, 0.16, 6, 16),
        new THREE.MeshBasicMaterial({ color: 0xaa44ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }),
      );
      ring.rotation.x = Math.PI / 2;
      this.mesh.add(ring);
      this.mesh.position.copy(this.position);
      scene.add(this.mesh);
      disableShadowCasting(this.mesh);
      return;
    }

    // Floating diamond shape (Default power-ups: Health, Ammo, Damage, Shield, Fuel, Bomb)
    const geom = new THREE.OctahedronGeometry(1.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(geom, mat);
    this.mesh.add(core);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(2.0, 10, 6),
      createGlowMaterial(color, 0.18),
    );
    this.mesh.add(halo);

    // Outer glow ring
    const ringGeom = new THREE.TorusGeometry(2.2, 0.15, 6, 12);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = Math.PI / 2;
    this.mesh.add(ring);

    const verticalRing = new THREE.Mesh(ringGeom, ringMat.clone());
    verticalRing.rotation.y = Math.PI / 2;
    this.mesh.add(verticalRing);

    this.mesh.position.copy(this.position);
    scene.add(this.mesh);
    disableShadowCasting(this.mesh);
  }

  update(time: number, delta: number) {
    if (!this.active) return;

    // Rotate and bob
    this.mesh.rotation.y += delta * 2;
    this.mesh.rotation.x += delta * 0.5;
    this.mesh.rotation.z += delta * 0.35;
    this.mesh.position.x = this.position.x;
    this.mesh.position.z = this.position.z;
    this.mesh.position.y = this.position.y + Math.sin(time * 3) * 0.5;
    const pulse = 1 + Math.sin(time * 6) * 0.08;
    this.mesh.scale.setScalar(pulse);

    // Spin + pulse the ground indicator ring, keeping it under the pickup
    if (this.groundRing) {
      this.groundRing.rotation.y += delta * 3.2;
      this.groundRing.position.x = this.position.x;
      this.groundRing.position.z = this.position.z;
      this.groundRing.position.y = Math.max(0.12, this.position.y - 1.2);
      const pulse = 1 + Math.sin(time * 5) * 0.12;
      this.groundRing.scale.set(pulse, pulse, 1);
      const beam = this.groundRing.userData.beam as THREE.Mesh | undefined;
      if (beam) {
        beam.position.x = this.position.x;
        beam.position.z = this.position.z;
      }
    }

    // Check lifetime and expiry feedback
    const age = time - this.spawnTime;
    const timeLeft = this.lifetime - age;
    if (timeLeft <= 0) {
      this.active = false;
      return;
    }

    // High-value salvage cache urgency indicator: flashes faster as time expires
    if (this.type === PowerUpType.SALVAGE_CACHE && timeLeft < 3.5 && this.groundRing) {
      const flash = Math.sin(time * 18) > 0;
      (this.groundRing.material as THREE.MeshBasicMaterial).opacity = flash ? 0.95 : 0.2;
    }
  }


  destroy(scene: THREE.Scene) {
    this.active = false;
    scene.remove(this.mesh);
    // Phase 1: release the pickup's unique buffers (core/halo/rings). Shared
    // cached geometries/materials are skipped by disposeObject3D.
    disposeObject3D(this.mesh);
    if (this.groundRing) {
      const beam = this.groundRing.userData.beam as THREE.Mesh | undefined;
      if (beam) {
        scene.remove(beam);
        beam.geometry.dispose();
        (beam.material as THREE.Material).dispose();
      }
      scene.remove(this.groundRing);
      this.groundRing.geometry.dispose();
      (this.groundRing.material as THREE.Material).dispose();
      this.groundRing = null;
    }
  }

  checkCollection(playerPos: THREE.Vector3): boolean {
    if (!this.active) return false;
    // For arcade shooter feel, ignore the height (Y) difference and use a generous radius
    const dx = this.mesh.position.x - playerPos.x;
    const dz = this.mesh.position.z - playerPos.z;
    const distSq = dx * dx + dz * dz;
    return distSq < 196; // Radius of 14 for easier collection
  }
}

export class ProjectilePool {
  pool: Projectile[] = [];
  private nextIndex = 0;
  private coreMesh: THREE.InstancedMesh;
  private glowMesh: THREE.InstancedMesh;
  private finsMesh: THREE.InstancedMesh;

  constructor(scene: THREE.Scene, count: number, colorHex: number = 0x55ff55) {
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.95,
    });
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const finsMat = new THREE.MeshLambertMaterial({ color: 0x3a4248 });

    this.coreMesh = new THREE.InstancedMesh(getProjectileCoreGeometry(), coreMat, count);
    this.glowMesh = new THREE.InstancedMesh(getProjectileGlowGeometry(), glowMat, count);
    this.finsMesh = new THREE.InstancedMesh(getProjectileFinsGeometry(), finsMat, count);
    for (const mesh of [this.coreMesh, this.glowMesh, this.finsMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // bullets span the whole battlefield
    }
    this.finsMesh.visible = false;

    for (let i = 0; i < count; i++) {
      this.pool.push(new Projectile(this, i, colorHex));
      this.hideInstance(i);
      _projColor.setHex(colorHex);
      this.coreMesh.setColorAt(i, _projColor);
      this.glowMesh.setColorAt(i, _projColor);
    }
    scene.add(this.coreMesh, this.glowMesh, this.finsMesh);
  }

  /** Write a spawn color into the per-instance color buffers. */
  setInstanceColor(index: number, hex: number) {
    _projColor.setHex(hex);
    this.coreMesh.setColorAt(index, _projColor);
    this.glowMesh.setColorAt(index, _projColor);
    if (this.coreMesh.instanceColor) this.coreMesh.instanceColor.needsUpdate = true;
    if (this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
  }

  /** Immediately zero-scale an instance (called on deactivate). */
  hideInstance(index: number) {
    this.coreMesh.setMatrixAt(index, _projHiddenMatrix);
    this.glowMesh.setMatrixAt(index, _projHiddenMatrix);
    this.finsMesh.setMatrixAt(index, _projHiddenMatrix);
  }

  spawn(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    now: number,
    speed: number = 250,
    damage: number = 10,
    blastRadius: number = 0,
    color?: number,
    target: EnemyLock | null = null,
    homingStrength: number = 0,
    vy: number = 0,
    gravity: number = 0,
    waveDamageMult: number = 1,
  ): Projectile | null {
    const len = this.pool.length;
    let p = null;
    for (let i = 0; i < len; i++) {
      const idx = (this.nextIndex + i) % len;
      if (!this.pool[idx].active) {
        p = this.pool[idx];
        this.nextIndex = (idx + 1) % len;
        break;
      }
    }
    if (p) {
      p.spawn(x, y, z, dx, dz, now, speed, damage, blastRadius, color, target, homingStrength, vy, gravity, waveDamageMult);
      return p;
    }
    return null;
  }

  deactivateAll() {
    for (const p of this.pool) {
      p.deactivate();
    }
  }

  updatePositions(now: number, delta: number, particles?: GPUParticleSystem) {
    let anyFins = false;
    for (const p of this.pool) {
      if (p.active) {
        p.update(now, delta, particles);
      }
      if (p.active) {
        const rotY = Math.atan2(p.vel.x, p.vel.z);
        const rotX = -Math.atan2(p.vel.y, Math.max(0.001, Math.hypot(p.vel.x, p.vel.z)));
        let scale = p.kind === "SAM_MISSILE" ? 0.52 : 1;
        // Lifetime taper over the final 15% (replaces per-material opacity fade).
        const lifeRatio = (now - p.spawnTime) / p.lifetime;
        if (lifeRatio > 0.85) scale *= Math.max(0, (1 - lifeRatio) / 0.15);
        _projEuler.set(rotX, rotY, 0);
        _projQuat.setFromEuler(_projEuler);
        _projPos.set(p.pos.x, p.pos.y, p.pos.z);
        _projScale.setScalar(scale);
        _projMatrix.compose(_projPos, _projQuat, _projScale);
        this.coreMesh.setMatrixAt(p.index, _projMatrix);
        this.glowMesh.setMatrixAt(p.index, _projMatrix);
        if (p.kind === "SAM_MISSILE") {
          anyFins = true;
          this.finsMesh.setMatrixAt(p.index, _projMatrix);
        } else {
          this.finsMesh.setMatrixAt(p.index, _projHiddenMatrix);
        }
      } else {
        this.coreMesh.setMatrixAt(p.index, _projHiddenMatrix);
        this.glowMesh.setMatrixAt(p.index, _projHiddenMatrix);
        this.finsMesh.setMatrixAt(p.index, _projHiddenMatrix);
      }
    }
    this.coreMesh.instanceMatrix.needsUpdate = true;
    this.glowMesh.instanceMatrix.needsUpdate = true;
    this.finsMesh.instanceMatrix.needsUpdate = true;
    this.finsMesh.visible = anyFins;
  }

  /**
   * Check projectile hits against static objectives (SAM sites, radar towers, depots).
   */
  checkObjectiveHits(
    objectives: Objective[],
    onHit: (p: Projectile, o: Objective) => void,
  ) {
    for (const p of this.pool) {
      if (!p.active) continue;
      const pMinX = (p.pos.x < p.prevPos.x ? p.pos.x : p.prevPos.x) - 14;
      const pMaxX = (p.pos.x > p.prevPos.x ? p.pos.x : p.prevPos.x) + 14;
      const pMinZ = (p.pos.z < p.prevPos.z ? p.pos.z : p.prevPos.z) - 14;
      const pMaxZ = (p.pos.z > p.prevPos.z ? p.pos.z : p.prevPos.z) + 14;

      for (const o of objectives) {
        if (!o.active || o.hp <= 0) continue;
        const tp = o.targetPoint;
        if (tp.x < pMinX || tp.x > pMaxX || tp.z < pMinZ || tp.z > pMaxZ) continue;

        const distSq = distancePointToProjectileSegmentSq(
          tp,
          p.prevPos,
          p.pos,
        );
        const hitRadius = o.radius + 4.5;
        if (distSq < hitRadius * hitRadius) {
          onHit(p, o);
          p.deactivate();
          break;
        }
      }
    }
  }

  /**
   * Check projectile hits against rooftop turrets (destroyable, block-mounted).
   */
  checkTurretHits(turrets: Turret[], onHit: (p: Projectile, t: Turret) => void) {
    for (const p of this.pool) {
      if (!p.active) continue;
      const pMinX = (p.pos.x < p.prevPos.x ? p.pos.x : p.prevPos.x) - 8;
      const pMaxX = (p.pos.x > p.prevPos.x ? p.pos.x : p.prevPos.x) + 8;
      const pMinZ = (p.pos.z < p.prevPos.z ? p.pos.z : p.prevPos.z) - 8;
      const pMaxZ = (p.pos.z > p.prevPos.z ? p.pos.z : p.prevPos.z) + 8;

      for (const t of turrets) {
        if (t.isGone() || t.hp <= 0) continue;
        const tp = t.position;
        if (tp.x < pMinX || tp.x > pMaxX || tp.z < pMinZ || tp.z > pMaxZ) continue;

        const distSq = distancePointToProjectileSegmentSq(
          tp,
          p.prevPos,
          p.pos,
        );
        const hitRadius = 3.2;
        if (distSq < hitRadius * hitRadius) {
          onHit(p, t);
          p.deactivate();
          break;
        }
      }
    }
  }

  checkEnemyHits(enemies: Enemy[], onHit: (p: Projectile, e: Enemy) => void) {
    for (const p of this.pool) {
      if (!p.active) continue;
      const pMinX = (p.pos.x < p.prevPos.x ? p.pos.x : p.prevPos.x) - 9;
      const pMaxX = (p.pos.x > p.prevPos.x ? p.pos.x : p.prevPos.x) + 9;
      const pMinZ = (p.pos.z < p.prevPos.z ? p.pos.z : p.prevPos.z) - 9;
      const pMaxZ = (p.pos.z > p.prevPos.z ? p.pos.z : p.prevPos.z) + 9;
      const pMinY = (p.pos.y < p.prevPos.y ? p.pos.y : p.prevPos.y) - 14;
      const pMaxY = (p.pos.y > p.prevPos.y ? p.pos.y : p.prevPos.y) + 14;

      for (const e of enemies) {
        if (!e.active) continue;
        const ep = e.body.position;
        // Fast AABB pre-rejection (filters 90%+ pairs before segment math)
        if (ep.x < pMinX || ep.x > pMaxX || ep.z < pMinZ || ep.z > pMaxZ || ep.y < pMinY || ep.y > pMaxY) {
          continue;
        }

        const hitRadius =
          e.type === EnemyType.BOSS
            ? 7.2
            : e.type === EnemyType.TANK
              ? 6.2
              : e.type === EnemyType.DRONE
                ? 4.7
                : 5.1;
        const distSq = distancePointToProjectileSegmentSq(
          ep,
          p.prevPos,
          p.pos,
        );
        if (distSq < hitRadius * hitRadius) {
          onHit(p, e);
          p.deactivate();
          break;
        }
      }
    }
  }

  checkPlayerHits(playerPos: CANNON.Vec3, onHit: (p: Projectile) => void) {
    const px = playerPos.x;
    const py = playerPos.y;
    const pz = playerPos.z;
    for (const p of this.pool) {
      if (!p.active) continue;
      // Fast broadphase distance rejection
      if (Math.abs(p.pos.x - px) > 16 || Math.abs(p.pos.z - pz) > 16 || Math.abs(p.pos.y - py) > 16) {
        continue;
      }
      const distSq = distancePointToProjectileSegmentSq(playerPos, p.prevPos, p.pos);
      if (distSq < 16) {
        onHit(p);
        p.deactivate();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// OBJECTIVES — destroyable battlefield targets
// ---------------------------------------------------------------------------

export class Objective {
  private static _nextObjectiveId = 50000;
  readonly id: number = Objective._nextObjectiveId++;
  missionTargetId?: string;
  type: ObjectiveType;
  active: boolean = true;
  hp: number;
  maxHp: number;
  radius: number = 4;
  basePoints: number;
  position: CANNON.Vec3;
  mesh: THREE.Group;
  body: CANNON.Body;
  scene: THREE.Scene;
  world: CANNON.World;
  spawnTime: number = 0;
  bobSeed: number;
  beacon: THREE.Mesh | null = null;
  labelSprite: THREE.Sprite | null = null;
  /** Countdown for the collapse-out animation after destruction. */
  deathTimer: number = 0;
  isDying: boolean = false;
  /** Light military prop ring around ground objectives (city group child). */
  propGroup: THREE.Object3D | null = null;
  /** Dedicated hostile aim point above the pad, never inside the roof/floor. */
  targetPoint: CANNON.Vec3;
  samStateMachine: SamStateMachine | null = null;
  samVariant: 0 | 1 | 2 = 0;
  radarYawPivot: THREE.Group | null = null;
  radarDishMesh: THREE.Group | null = null;
  turretYawPivot: THREE.Group | null = null;
  launcherPitchPivot: THREE.Group | null = null;
  missileLaunchPoints: THREE.Object3D[] = [];
  missileCanisters: THREE.Object3D[] = [];
  warningLights: THREE.Mesh[] = [];
  samHealthBar: THREE.Group | null = null;
  samHealthFill: THREE.Mesh | null = null;
  samHitFlash: THREE.Mesh | null = null;
  recentHitTimer = 0;
  targeted = false;
  damageFxTimer = 0;
  private samLaunchIndex = 0;
  private samLaunchScratch = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    world: CANNON.World,
    x: number,
    y: number,
    z: number,
    type: ObjectiveType,
  ) {
    this.scene = scene;
    this.world = world;
    this.type = type;
    this.position = new CANNON.Vec3(x, y, z);
    this.targetPoint = new CANNON.Vec3(x, y + (type === ObjectiveType.SAM_SITE ? 5.2 : type === ObjectiveType.RADAR_TOWER ? 4.2 : 3.5), z);
    this.bobSeed = Math.random() * Math.PI * 2;

    const cfg = objectiveConfig(type);
    this.maxHp = cfg.hp;
    this.basePoints = cfg.points;
    this.radius = cfg.radius;
    this.hp = this.maxHp;

    this.mesh = new THREE.Group();

    if (type === ObjectiveType.SAM_SITE) {
      this.samStateMachine = new SamStateMachine();
      this.samVariant = (Math.abs(Math.floor(x * 7 + z * 3)) % 3) as 0 | 1 | 2;

      // Fortified concrete base and wide mechanical support platform.
      const concrete = createBox(this.samVariant === 2 ? 9.2 : 7.8, 0.65, this.samVariant === 2 ? 8.5 : 7.2, 0x596069);
      concrete.position.y = 0.32;
      const inset = createBox(6.4, 0.38, 6.1, 0x263038);
      inset.position.y = 0.82;
      const pedestal = createBox(3.9, 1.15, 3.9, 0x39483b);
      pedestal.position.y = 1.45;
      this.mesh.add(concrete, inset, pedestal);

      // Independent radar: large dish silhouette with a bright central receiver.
      this.radarYawPivot = new THREE.Group();
      this.radarYawPivot.name = "RadarYawPivot";
      this.radarYawPivot.position.set(this.samVariant === 1 ? -3.1 : -2.5, 2.0, -2.1);
      const radarMast = createBox(0.45, 3.6, 0.45, 0x232a30);
      radarMast.position.y = 1.8;
      const dish = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 2.35, 0.62, 12, 1, false),
        createLowPolyMaterial(0x718994),
      );
      dish.rotation.x = Math.PI / 2;
      dish.position.set(0, 3.7, 0.35);
      const receiver = createGlowBox(0.48, 0.48, 0.48, 0xff5a4f, 0.8);
      receiver.position.set(0, 3.7, 1.0);
      this.radarYawPivot.add(radarMast, dish, receiver);
      this.mesh.add(this.radarYawPivot);

      // Heavy launcher hierarchy: yaw pivot -> pitch pivot -> oversized 2x2 tubes.
      this.turretYawPivot = new THREE.Group();
      this.turretYawPivot.name = "TurretYawPivot";
      this.turretYawPivot.position.set(0.75, 2.1, 0.35);
      const turretBase = new THREE.Mesh(
        new THREE.CylinderGeometry(2.5, 2.8, 0.85, 10),
        createLowPolyMaterial(0x28352d),
      );
      turretBase.position.y = 0.1;
      this.turretYawPivot.add(turretBase);
      this.launcherPitchPivot = new THREE.Group();
      this.launcherPitchPivot.name = "LauncherPitchPivot";
      this.launcherPitchPivot.position.y = 0.8;
      const rack = createBox(this.samVariant === 2 ? 6.8 : 5.8, 1.0, 2.3, 0x202930);
      rack.position.z = 0.65;
      this.launcherPitchPivot.add(rack);
      for (let i = 0; i < (this.samVariant === 2 ? 8 : 4); i++) {
        const column = i % (this.samVariant === 2 ? 4 : 2);
        const row = Math.floor(i / (this.samVariant === 2 ? 4 : 2));
        const tube = createBox(1.08, 0.92, 4.5, 0x303b3d);
        tube.position.set((column - (this.samVariant === 2 ? 1.5 : 0.5)) * 1.45, (row - 0.5) * 1.15, 2.1);
        const nose = createBox(0.72, 0.66, 0.65, 0x8f3028);
        nose.position.set(tube.position.x, tube.position.y, 4.65);
        const launchPoint = new THREE.Object3D();
        launchPoint.name = `MissileLaunchPoint_${i}`;
        launchPoint.position.set(tube.position.x, tube.position.y, 5.0);
        this.launcherPitchPivot.add(tube, nose, launchPoint);
        this.missileCanisters.push(nose);
        this.missileLaunchPoints.push(launchPoint);
      }
      this.turretYawPivot.add(this.launcherPitchPivot);
      this.mesh.add(this.turretYawPivot);

      // Cabinets, generator, antenna, and warning beacons make the site read as a battery.
      const cabinet = createBox(1.8, 2.2, 1.45, 0x44515a);
      cabinet.position.set(3.0, 1.55, -2.45);
      const generator = createBox(2.1, 1.25, 1.5, 0x4a5537);
      generator.position.set(3.15, 1.08, 2.7);
      const antenna = createBox(0.18, 4.8, 0.18, 0x22292f);
      antenna.position.set(-3.1, 2.75, 2.5);
      this.mesh.add(cabinet, generator, antenna);
      for (const sx of [-1, 1]) {
        const light = createGlowBox(0.5, 0.5, 0.5, 0xff3344, 0.48);
        light.material = (light.material as THREE.MeshBasicMaterial).clone();
        light.position.set(sx * 3.25, 1.2, 3.0);
        this.warningLights.push(light);
        this.mesh.add(light);
      }

      // Engagement confirmation: compact bar appears while targeted/recently hit.
      this.samHealthBar = new THREE.Group();
      this.samHealthBar.name = "SAMHealthBar";
      this.samHealthBar.position.set(0, 8.6, 0);
      const healthBack = createBox(7.0, 0.28, 0.45, 0x161a20);
      this.samHealthFill = createBox(6.6, 0.36, 0.5, 0xff4f5e);
      this.samHealthFill.position.z = -0.03;
      this.samHealthBar.add(healthBack, this.samHealthFill);
      this.samHealthBar.visible = false;
      this.mesh.add(this.samHealthBar);
      this.samHitFlash = createGlowBox(6.2, 4.3, 6.2, 0xffd36a, 0.28);
      this.samHitFlash.position.y = 3.2;
      this.samHitFlash.visible = false;
      this.mesh.add(this.samHitFlash);
    } else if (type === ObjectiveType.RADAR_TOWER) {
      // DESERT MILITARY RADAR STATION INSTALLATION
      // 1. Concrete foundation & fortified bunker building (TechnicalBuilding)
      const bunker = createBox(8.4, 2.8, 8.4, 0xbda77e); // Desert tan concrete
      bunker.name = "TechnicalBuilding";
      bunker.position.y = 1.4;
      
      const foundation = createBox(10.2, 0.6, 10.2, 0x4a4d52); // Dark reinforced base
      foundation.position.y = 0.3;

      const roofEquipment = createBox(4.2, 0.8, 4.2, 0x3d4448);
      roofEquipment.position.set(0, 3.2, 0);

      // Access door & intake vents
      const door = createBox(1.2, 2.0, 0.2, 0x22262a);
      door.position.set(0, 1.0, 4.25);
      const vent1 = createBox(1.8, 0.6, 0.2, 0x1f2326);
      vent1.position.set(-2.6, 1.8, 4.25);
      const vent2 = createBox(1.8, 0.6, 0.2, 0x1f2326);
      vent2.position.set(2.6, 1.8, 4.25);

      this.mesh.add(foundation, bunker, roofEquipment, door, vent1, vent2);

      // 2. Rotating Radar Mast & Large Curved Dish (RadarYawPivot -> LargeRadarDish)
      this.radarYawPivot = new THREE.Group();
      this.radarYawPivot.name = "RadarYawPivot";
      this.radarYawPivot.position.set(0, 3.6, 0);

      const mast = createBox(0.8, 4.5, 0.8, 0x2a3036);
      mast.position.y = 2.25;
      this.radarYawPivot.add(mast);

      // Lattice support arm
      const crossBeam = createBox(4.8, 0.4, 0.6, 0x3d4750);
      crossBeam.position.set(0, 4.6, 0);
      this.radarYawPivot.add(crossBeam);

      // Large Radar Dish (Concave cylinder / parabolic curved reflector)
      this.radarDishMesh = new THREE.Group();
      this.radarDishMesh.name = "LargeRadarDish";
      this.radarDishMesh.position.set(0, 4.8, 0);

      const dishReflector = new THREE.Mesh(
        new THREE.CylinderGeometry(1.2, 4.2, 1.1, 14, 1, false, 0, Math.PI),
        createLowPolyMaterial(0x526068),
      );
      dishReflector.rotation.x = Math.PI / 2;
      dishReflector.rotation.z = -Math.PI / 2;
      this.radarDishMesh.add(dishReflector);

      // Feed horn receiver boom & focal point
      const feedBoom = createBox(0.2, 0.2, 2.6, 0x22262a);
      feedBoom.position.set(0, 0, 1.6);
      const feedHorn = createGlowBox(0.6, 0.6, 0.6, 0xff3344, 0.8);
      feedHorn.position.set(0, 0, 2.8);
      this.radarDishMesh.add(feedBoom, feedHorn);

      // Counterweight rear box
      const counterWeight = createBox(1.8, 1.2, 1.0, 0x283038);
      counterWeight.position.set(0, 0, -1.0);
      this.radarDishMesh.add(counterWeight);

      this.radarYawPivot.add(this.radarDishMesh);
      this.mesh.add(this.radarYawPivot);

      // 3. Secondary Communications & Telemetry Array (SecondaryAntenna)
      const secTower = createBox(0.35, 7.2, 0.35, 0x242b30);
      secTower.name = "SecondaryAntenna";
      secTower.position.set(-3.2, 3.6, -3.2);
      const secGrid = createBox(1.6, 1.6, 0.15, 0x485560);
      secGrid.position.set(-3.2, 6.8, -3.2);
      secGrid.rotation.y = 0.6;
      this.mesh.add(secTower, secGrid);

      // 4. Auxiliary Equipment Cabinets (EquipmentCabinet01 & 02)
      const cabinet1 = createBox(1.6, 2.4, 1.4, 0x4e5843); // Olive green
      cabinet1.name = "EquipmentCabinet01";
      cabinet1.position.set(4.8, 1.2, -1.5);
      const cabinet2 = createBox(1.4, 2.0, 1.8, 0x3b4432);
      cabinet2.name = "EquipmentCabinet02";
      cabinet2.position.set(4.8, 1.0, 1.5);
      this.mesh.add(cabinet1, cabinet2);

      // 5. Diesel Generator & Fuel Tank (Generator)
      const generator = createBox(2.6, 1.6, 2.2, 0x3d4348);
      generator.name = "Generator";
      generator.position.set(-4.6, 0.8, 1.8);
      const exhaustPipe = createBox(0.2, 2.2, 0.2, 0x1f2226);
      exhaustPipe.position.set(-4.6, 2.2, 1.8);
      this.mesh.add(generator, exhaustPipe);

      // 6. Perimeter Sandbag Barriers (SandBarriers)
      const sandBarriers = new THREE.Group();
      sandBarriers.name = "SandBarriers";
      [-1, 1].forEach((sx) => {
        const sandbag = createBox(0.8, 0.9, 10.8, 0x9e8c67);
        sandbag.position.set(sx * 5.6, 0.45, 0);
        sandBarriers.add(sandbag);
      });
      [-1, 1].forEach((sz) => {
        const sandbag = createBox(10.8, 0.9, 0.8, 0x9e8c67);
        sandbag.position.set(0, 0.45, sz * 5.6);
        sandBarriers.add(sandbag);
      });
      this.mesh.add(sandBarriers);

      // 7. Hostile Warning Lights (WarningLights)
      for (const [lx, lz] of [[-4.0, -4.0], [4.0, -4.0], [-4.0, 4.0], [4.0, 4.0]]) {
        const light = createGlowBox(0.45, 0.45, 0.45, 0xff3344, 0.55);
        light.material = (light.material as THREE.MeshBasicMaterial).clone();
        light.position.set(lx, 2.9, lz);
        this.warningLights.push(light);
        this.mesh.add(light);
      }

      // 8. Health Bar & Hit Flash for Radar
      this.samHealthBar = new THREE.Group();
      this.samHealthBar.name = "RadarHealthBar";
      this.samHealthBar.position.set(0, 10.8, 0);
      const healthBack = createBox(7.6, 0.32, 0.45, 0x161a20);
      this.samHealthFill = createBox(7.2, 0.42, 0.5, 0xff4f5e);
      this.samHealthFill.position.z = -0.03;
      this.samHealthBar.add(healthBack, this.samHealthFill);
      this.samHealthBar.visible = false;
      this.mesh.add(this.samHealthBar);

      this.samHitFlash = createGlowBox(9.0, 6.0, 9.0, 0xffd36a, 0.28);
      this.samHitFlash.position.y = 3.5;
      this.samHitFlash.visible = false;
      this.mesh.add(this.samHitFlash);
    } else {
      // AMMO_DEPOT: stacked crates
      const crateMat = createLowPolyMaterial(0xc9a35a);
      const lidMat = createLowPolyMaterial(0x7a5c2e);
      for (let i = 0; i < 6; i++) {
        const size = 1.6 + (i % 3) * 0.3;
        const crate = createBox(size, size, size, 0xc9a35a);
        crate.material = crateMat;
        crate.position.set(
          (i % 2 === 0 ? -1.4 : 1.4),
          size / 2 + Math.floor(i / 2) * 1.7,
          (i % 3 === 0 ? -1 : i % 3 === 1 ? 1 : 0),
        );
        this.mesh.add(crate);
        const lid = createBox(size * 0.7, 0.25, size * 0.7, 0x7a5c2e);
        lid.material = lidMat;
        lid.position.set(crate.position.x, crate.position.y + size / 2 + 0.15, crate.position.z);
        this.mesh.add(lid);
      }
    }

    // Glow marker ring on the ground so players can spot objectives
    const markerMat = createGlowMaterial(type === ObjectiveType.AMMO_DEPOT ? 0xffaa33 : 0xff3366, 0.35);
    const marker = new THREE.Mesh(new THREE.RingGeometry(3.4, 4.0, 24), markerMat);
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = 0.15;
    this.mesh.add(marker);

    // Vertical beacon beam + floating label so objectives read from the air
    const beaconColor = type === ObjectiveType.AMMO_DEPOT ? 0xffaa33 : 0xff3366;
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 1.4, 55, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: beaconColor,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.beacon.position.y = 28;
    this.beacon.visible = true; // tall light pillar so objectives read from the air
    this.mesh.add(this.beacon);

    // Canvas label sprite (billboarded, always faces camera)
    if (typeof document !== 'undefined') {
      const label = this.type === ObjectiveType.SAM_SITE ? 'SAM' : this.type === ObjectiveType.RADAR_TOWER ? 'RADAR' : 'DEPOT';
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(6, 16, 30, 0.85)';
        ctx.roundRect ? ctx.roundRect(8, 8, 240, 112, 18) : ctx.fillRect(8, 8, 240, 112);
        ctx.fill();
        ctx.strokeStyle = '#' + beaconColor.toString(16).padStart(6, '0');
        ctx.lineWidth = 6;
        ctx.strokeRect(8, 8, 240, 112);
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 64px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 128, 64);
      }
      const labelTex = new THREE.CanvasTexture(canvas);
      labelTex.colorSpace = THREE.SRGBColorSpace;
      const labelMat = new THREE.SpriteMaterial({
        map: labelTex,
        transparent: true,
        depthTest: false,
      });
      this.labelSprite = new THREE.Sprite(labelMat);
      this.labelSprite.position.y = 34;
      this.labelSprite.scale.set(22, 11, 1);
      this.labelSprite.visible = true;
      this.mesh.add(this.labelSprite);
    }

    this.mesh.position.set(x, y, z);
    scene.add(this.mesh);
    // HD real shadows are player-only — objectives only RECEIVE the shadow.
    disableShadowCasting(this.mesh);

    this.body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      position: new CANNON.Vec3(x, y, z),
    });
    const shape = new CANNON.Box(new CANNON.Vec3(this.radius, this.radius * 0.8, this.radius));
    this.body.addShape(shape);
    world.addBody(this.body);
  }

  update(time: number, delta: number = 1 / 60) {
    if (!this.active || this.isDying) {
      // Collapse-out: shrink + fade over ~0.35s, THEN the depot is gone
      if (this.deathTimer > 0) {
        this.deathTimer -= delta;
        const k = Math.max(0, this.deathTimer / 0.35);
        this.mesh.scale.setScalar(Math.max(0.01, k));
        this.mesh.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
            child.material.opacity = Math.max(0, k * 0.7);
          }
        });
        if (this.deathTimer <= 0) {
          this.deathTimer = 0;
          this.destroy();
        }
      }
      return;
    }
    if (this.type === ObjectiveType.SAM_SITE) {
      // A fortified pad never bobs or spins. Only its mechanical pivots move.
      this.mesh.position.y = this.position.y;
      this.recentHitTimer = Math.max(0, this.recentHitTimer - delta);
      this.damageFxTimer = Math.max(0, this.damageFxTimer - delta);
      if (this.samHitFlash) this.samHitFlash.visible = this.recentHitTimer > 0.12;
      if (this.samHealthBar) this.samHealthBar.visible = this.targeted || this.recentHitTimer > 0;
      if (this.samHealthFill) {
        const ratio = THREE.MathUtils.clamp(this.hp / Math.max(1, this.maxHp), 0, 1);
        this.samHealthFill.scale.x = ratio;
        this.samHealthFill.position.x = -(1 - ratio) * 3.3;
      }
      this.targeted = false; // engine must refresh this every frame
    } else if (this.type === ObjectiveType.RADAR_TOWER) {
      // Radar Station: sits firmly on terrain ground, dish rotates continuously
      this.mesh.position.y = this.position.y;
      this.recentHitTimer = Math.max(0, this.recentHitTimer - delta);
      this.damageFxTimer = Math.max(0, this.damageFxTimer - delta);
      if (this.radarYawPivot) {
        this.radarYawPivot.rotation.y += delta * 1.5;
      }
      if (this.samHitFlash) this.samHitFlash.visible = this.recentHitTimer > 0.12;
      if (this.samHealthBar) this.samHealthBar.visible = this.targeted || this.recentHitTimer > 0;
      if (this.samHealthFill) {
        const ratio = THREE.MathUtils.clamp(this.hp / Math.max(1, this.maxHp), 0, 1);
        this.samHealthFill.scale.x = ratio;
        this.samHealthFill.position.x = -(1 - ratio) * 3.6;
      }
      // Pulsing clearance warning lights
      for (const light of this.warningLights) {
        const mat = light.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.45 + Math.sin(time * 5.0) * 0.35;
      }
      this.targeted = false;
    } else {
      this.mesh.position.y = this.position.y + Math.sin(time * 1.8 + this.bobSeed) * 0.35;
      this.mesh.rotation.y += 0.004;
    }
    // Damage flash
    if (this.hp < this.maxHp * 0.5) {
      this.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
          child.material.opacity = 0.55 + Math.sin(time * 10) * 0.35;
        }
      });
    }
    // Beacon beam pulses toward the sky so players can spot objectives
    if (this.beacon) {
      const pulse = 0.5 + Math.sin(time * 4 + this.bobSeed) * 0.3;
      (this.beacon.material as THREE.MeshBasicMaterial).opacity = Math.max(0.12, pulse);
    }
  }

  get samState(): SamState | null {
    return this.samStateMachine?.state ?? null;
  }

  get samLockProgress(): number {
    return this.samStateMachine?.lockProgress ?? 0;
  }

  setTargeted(on: boolean) {
    if (this.type === ObjectiveType.SAM_SITE || this.type === ObjectiveType.RADAR_TOWER) {
      this.targeted = on;
    }
  }

  /** Track the player with radar/launcher pivots and advance the deterministic lock state. */
  updateSam(
    target: CANNON.Vec3,
    time: number,
    delta: number,
    wave: number,
    options: boolean | { radarSupported?: boolean; lockSpeedMultiplier?: number } = false,
  ): SamStateResult | null {
    if (!this.samStateMachine || !this.radarYawPivot || !this.turretYawPivot || !this.launcherPitchPivot) return null;
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const dy = target.y - this.targetPoint.y;
    const horizontal = Math.max(0.001, Math.hypot(dx, dz));
    const targetYaw = Math.atan2(dx, dz);

    if (horizontal <= SAM_DETECTION_RANGE) {
      this.radarYawPivot.rotation.y = stepAngle(
        this.radarYawPivot.rotation.y,
        targetYaw,
        SAM_YAW_SPEED * 1.35,
        delta,
      );
      this.turretYawPivot.rotation.y = stepAngle(
        this.turretYawPivot.rotation.y,
        targetYaw,
        SAM_YAW_SPEED,
        delta,
      );
      const targetPitch = THREE.MathUtils.clamp(Math.atan2(dy, horizontal), SAM_MIN_PITCH, SAM_MAX_PITCH);
      this.launcherPitchPivot.rotation.x = THREE.MathUtils.lerp(
        this.launcherPitchPivot.rotation.x,
        -targetPitch,
        Math.min(1, SAM_PITCH_SPEED * delta),
      );
    } else {
      this.radarYawPivot.rotation.y += delta * 0.42;
      this.turretYawPivot.rotation.y = stepAngle(this.turretYawPivot.rotation.y, 0, SAM_YAW_SPEED * 0.35, delta);
      this.launcherPitchPivot.rotation.x = THREE.MathUtils.lerp(this.launcherPitchPivot.rotation.x, -0.25, delta * 0.6);
    }

    const radarSupported = typeof options === "boolean" ? options : Boolean(options.radarSupported);
    const lockSpeedMultiplier = typeof options === "boolean" ? 1 : Math.max(0.1, options.lockSpeedMultiplier ?? 1);
    const aligned = Math.abs(shortestAngleDelta(targetYaw, this.turretYawPivot.rotation.y)) < 0.13;
    const result = this.samStateMachine.update(delta, {
      distance: horizontal,
      aligned,
      active: this.active,
      wave,
      detectionMultiplier: radarSupported ? 1.08 : 1,
      lockSpeedMultiplier: (radarSupported ? 1.2 : 1) * lockSpeedMultiplier,
    });
    const state = this.samStateMachine.state;
    const lockIntensity = state === SamState.LOCKING ? 0.55 + this.samStateMachine.lockProgress * 0.45 : 0.28;
    for (const light of this.warningLights) {
      light.visible = state !== SamState.DESTROYED;
      const material = light.material as THREE.MeshBasicMaterial;
      material.opacity = state === SamState.LOCKING
        ? lockIntensity * (0.7 + Math.abs(Math.sin(time * (5 + this.samStateMachine.lockProgress * 8))) * 0.3)
        : state === SamState.FIRING
          ? 1
          : lockIntensity;
    }
    if (state === SamState.RELOADING && this.samStateMachine.reloadRemaining < 0.25) {
      for (const canister of this.missileCanisters) canister.visible = true;
    }
    return result;
  }

  /** Physical launch point at the front of the currently loaded missile rack. */
  getSamLaunchPosition(target = this.samLaunchScratch): THREE.Vector3 {
    const point = this.missileLaunchPoints[this.samLaunchIndex % Math.max(1, this.missileLaunchPoints.length)];
    if (!point) return target.set(this.position.x, this.position.y + 5, this.position.z);
    point.updateWorldMatrix(true, false);
    point.getWorldPosition(target);
    const canister = this.missileCanisters[this.samLaunchIndex % this.missileCanisters.length];
    if (canister) canister.visible = false;
    this.samLaunchIndex = (this.samLaunchIndex + 1) % Math.max(1, this.missileLaunchPoints.length);
    return target;
  }

  getDamageStage(): 0 | 1 | 2 {
    const ratio = this.hp / Math.max(1, this.maxHp);
    return ratio < 0.33 ? 2 : ratio < 0.66 ? 1 : 0;
  }

  /** Distance from a world position to the objective, in units. */
  distanceTo(px: number, pz: number): number {
    const dx = px - this.position.x;
    const dz = pz - this.position.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  takeDamage(amt: number): boolean {
    if (!this.active) return false;
    this.hp -= amt;
    this.recentHitTimer = 2.4;
    if (this.hp <= 0) {
      // Defer removal: play the collapse-out animation in update() before the
      // depot truly disappears.
      this.active = false;
      this.isDying = true;
      this.samStateMachine?.disable(true);
      this.deathTimer = 0.35;
      return true;
    }
    return false;
  }

  destroy() {
    if (!this.mesh.parent) return; // idempotent: already destroyed (cull/reset can double-call)
    this.active = false;
    this.mesh.parent.remove(this.mesh);
    // Phase 1: release the objective's unique buffers (marker ring, beacon
    // beam, label sprite). Shared cached resources are skipped.
    disposeObject3D(this.mesh);
    // Detach the objective's prop ring (Pass 5) — shared materials/geometries
    // stay cached, so removal is just a scene-graph detach.
    if (this.propGroup?.parent) this.propGroup.parent.remove(this.propGroup);
    this.world.removeBody(this.body);
    if (this.labelSprite?.material instanceof THREE.SpriteMaterial) {
      this.labelSprite.material.map?.dispose();
      this.labelSprite.material.dispose();
    }
    if (this.beacon) {
      this.beacon.geometry.dispose();
      if (Array.isArray(this.beacon.material)) {
        this.beacon.material.forEach((m) => m.dispose());
      } else {
        this.beacon.material.dispose();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TURRET — destroyable rooftop gun emplacement that tracks and shoots the player
// ---------------------------------------------------------------------------
export class Turret {
  active: boolean = true;
  hp: number;
  maxHp: number = 26;
  position: CANNON.Vec3;
  mesh: THREE.Group;
  head: THREE.Group;
  /** Pitch pivot for the barrel — lets the gun track the player vertically. */
  gunPivot: THREE.Group;
  yaw: number = 0;
  pitch: number = 0;
  block: CityBlock | null;
  chunkId: number;
  // +Infinity = never fired; the engine sets it on first encounter so turrets
  // spawned mid-run don't fire on their very first frame
  lastShotTime: number = Number.POSITIVE_INFINITY;
  fireInterval: number;
  range: number = 200;
  basePoints: number = 75;
  seed: number;
  static readonly PITCH_MIN = -0.6; // rad — barrel can depress this far
  static readonly PITCH_MAX = 0.9; // rad — enough to hit the player at cruise altitude
  static readonly HIT_FLASH_DURATION = 0.14;
  /** Brief emissive flash after taking damage — mirrors the enemy hit-flash. */
  private hitFlashTimer = 0;

  constructor(
    chunkGroup: THREE.Group,
    x: number,
    y: number,
    z: number,
    chunkId: number,
    block: CityBlock | null,
  ) {
    this.position = new CANNON.Vec3(x, y, z);
    this.block = block;
    this.chunkId = chunkId;
    this.hp = this.maxHp;
    this.seed = Math.random();
    this.fireInterval = 1.0 + Math.random() * 0.9;

    this.mesh = new THREE.Group();
    this.mesh.position.set(x, y, z);

    const baseMat = createLowPolyMaterial(0x2b3540);
    const metalMat = createLowPolyMaterial(0x4a5560);
    const darkMat = createLowPolyMaterial(0x1d2530);
    const eyeMat = createLowPolyMaterial(0xff3344);

    // Base plate bolted to the roof
    const base = createBox(2.4, 0.5, 2.4, 0x2b3540);
    base.material = baseMat;
    base.position.y = 0.25;
    this.mesh.add(base);

    // Rotating head: body + glowing eye; the barrel sits on its own pitch
    // pivot so the turret tracks the player vertically as well as in yaw.
    this.head = new THREE.Group();
    this.head.position.y = 0.7;
    this.mesh.add(this.head);

    const body = createBox(1.5, 0.9, 1.5, 0x4a5560);
    body.material = metalMat;
    body.position.y = 0.55;
    this.head.add(body);

    this.gunPivot = new THREE.Group();
    this.gunPivot.position.y = 0.72;
    this.head.add(this.gunPivot);

    const barrel = createBox(0.34, 0.34, 2.6, 0x1d2530);
    barrel.material = darkMat;
    barrel.position.set(0, 0, 1.7);
    this.gunPivot.add(barrel);

    const eye = createBox(0.55, 0.45, 0.45, 0xff3344);
    eye.material = eyeMat;
    eye.position.set(0, 0.85, 0.85);
    this.head.add(eye);

    // Muzzle flash glow tip
    const tip = createGlowBox(0.4, 0.4, 0.4, 0xffaa44, 0.9);
    tip.position.set(0, 0, 3.0);
    this.gunPivot.add(tip);

    chunkGroup.add(this.mesh);
  }

  /** Host building destroyed → the turret is dead too. */
  isGone(): boolean {
    return !this.active || (this.block !== null && this.block.destroyed);
  }

  /** Rotate the head to track the player in yaw and the barrel in pitch. */
  aimAt(px: number, py: number, pz: number, time: number) {
    const dx = px - this.position.x;
    const dz = pz - this.position.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz < 0.01) return;
    const targetYaw = Math.atan2(dx, dz);
    let diff = targetYaw - this.yaw;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    // Smooth-yaw tracking (≈0.4 of the remaining angle per frame)
    this.yaw += diff * 0.4;
    this.head.rotation.y = this.yaw;

    // Barrel pitch: aim at the player's altitude, clamped to the gun's travel.
    const dy = py - (this.position.y + 1.42);
    const targetPitch = Math.atan2(dy, horiz);
    const clamped = Math.max(Turret.PITCH_MIN, Math.min(Turret.PITCH_MAX, targetPitch));
    this.pitch += (clamped - this.pitch) * 0.35;
    this.gunPivot.rotation.x = -this.pitch;

    // Barrel bob while tracking
    this.head.rotation.x = Math.sin(time * 2.2 + this.seed * 6.28) * 0.03;
  }

  getMuzzle() {
    const cy = Math.cos(this.pitch);
    return {
      x: this.position.x + Math.sin(this.yaw) * 3.0 * cy,
      y: this.position.y + 1.42 + Math.sin(this.pitch) * 3.0,
      z: this.position.z + Math.cos(this.yaw) * 3.0 * cy,
    };
  }

  takeDamage(amt: number): boolean {
    this.hp -= amt;
    if (this.hp <= 0) {
      this.active = false;
      this.mesh.visible = false;
      return true;
    }
    this.hitFlashTimer = Turret.HIT_FLASH_DURATION;
    return false;
  }

  /** Decay the hit flash — a red emissive kick that eases back to rest.
   *  The turret's body materials are per-instance (created fresh in the
   *  constructor), so tinting them never affects a shared material cache. */
  updateHitFlash(delta: number) {
    if (this.hitFlashTimer > 0) {
      this.hitFlashTimer -= delta;
    }
    const strength = this.hitFlashTimer > 0
      ? Math.max(0, Math.min(1, this.hitFlashTimer / Turret.HIT_FLASH_DURATION))
      : 0;
    this.mesh.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.material instanceof THREE.MeshToonMaterial) {
        if (strength > 0.001) {
          m.material.emissive.setRGB(1, 0.13, 0.2).multiplyScalar(strength * 0.9);
        } else {
          const base = m.material.userData.baseColor as THREE.Color | undefined;
          if (base) m.material.emissive.copy(base).multiplyScalar(0.025);
        }
      }
    });
  }
}
