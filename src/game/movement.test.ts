import { afterEach, describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { FLIGHT_SPEC, Helicopter, type MovementCommand } from './entities';
import { HelicopterModel } from './types';

// Heading-relative command schema:
//   x = lateral strafe (+1 right), z = cyclic thrust (+1 forward along heading),
//   y = collective (+1 climb), yaw = rudder (+1 turn right).
const NEUTRAL: MovementCommand = { x: 0, y: 0, z: 0, yaw: 0 };
const FORWARD: MovementCommand = { x: 0, y: 0, z: 1, yaw: 0 };
const TURN_RIGHT: MovementCommand = { x: 0, y: 0, z: 0, yaw: 1 };
const TURN_LEFT: MovementCommand = { x: 0, y: 0, z: 0, yaw: -1 };
const CLIMB: MovementCommand = { x: 0, y: 1, z: 0, yaw: 0 };
const DESCEND: MovementCommand = { x: 0, y: -1, z: 0, yaw: 0 };

interface TestRig {
  scene: THREE.Scene;
  world: CANNON.World;
  helicopter: Helicopter;
  time: number;
}

const rigs: TestRig[] = [];

function createRig(model: HelicopterModel = HelicopterModel.APACHE): TestRig {
  const scene = new THREE.Scene();
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
  world.defaultContactMaterial.friction = 0;
  world.defaultContactMaterial.restitution = 0;
  const rig = {
    scene,
    world,
    helicopter: new Helicopter(scene, world, model),
    time: 0,
  };
  rigs.push(rig);
  return rig;
}

function step(rig: TestRig, dt: number, move: MovementCommand, hasInput = true) {
  rig.time += dt;
  rig.helicopter.setHoverFloor(0);
  rig.helicopter.update(
    rig.time,
    dt,
    undefined,
    undefined,
    false,
    false,
    hasInput,
    move,
  );
  rig.world.step(1 / 60, dt, 3);
  rig.helicopter.syncBodyTransform();
}

function simulate(rig: TestRig, seconds: number, hz: number, move: MovementCommand) {
  const dt = 1 / hz;
  const frames = Math.round(seconds * hz);
  for (let i = 0; i < frames; i++) step(rig, dt, move, move !== NEUTRAL);
}

afterEach(() => {
  for (const rig of rigs.splice(0)) rig.helicopter.destroy();
});

describe('flight spec constants', () => {
  it('encodes the tuned arcade values', () => {
    expect(FLIGHT_SPEC.turnRate).toBeCloseTo(2.6, 2);
    expect(FLIGHT_SPEC.maxForwardSpeed).toBeCloseTo(34, 2);
    expect(FLIGHT_SPEC.climbRate).toBeCloseTo(9.5, 2);
    expect(FLIGHT_SPEC.sinkRate).toBeCloseTo(8.0, 2);
    expect(FLIGHT_SPEC.groundCushion).toBeCloseTo(2.4, 2);
    expect(FLIGHT_SPEC.ceiling).toBeCloseTo(26.0, 2);
    expect(FLIGHT_SPEC.maxPitch).toBeCloseTo(0.32, 3);
    expect(FLIGHT_SPEC.maxRoll).toBeCloseTo(0.48, 3);
    expect(FLIGHT_SPEC.tiltResponse).toBeCloseTo(12, 3);
  });
});

describe('heading-relative flight (FLIGHT_SPEC)', () => {
  it('holds a stable idle hover with no drift or heading creep', () => {
    const rig = createRig();
    simulate(rig, 3, 60, NEUTRAL);

    expect(rig.helicopter.body.position.x).toBeCloseTo(0, 4);
    expect(rig.helicopter.body.position.y).toBeCloseTo(FLIGHT_SPEC.spawnAltitude, 3);
    expect(rig.helicopter.body.position.z).toBeCloseTo(0, 4);
    expect(rig.helicopter.body.velocity.length()).toBeCloseTo(0, 4);
    expect(rig.helicopter.bodyYawVelocity).toBeCloseTo(0, 4);
  });

  it('yaws the heading right with D at the spec turn rate', () => {
    const rig = createRig();
    // Warm the rudder to steady-state angular velocity.
    simulate(rig, 1.0, 60, TURN_RIGHT);
    expect(rig.helicopter.bodyYawVelocity).toBeLessThan(-(FLIGHT_SPEC.turnRate - 0.5));
    expect(rig.helicopter.bodyYawVelocity).toBeGreaterThanOrEqual(-(FLIGHT_SPEC.turnRate + 0.05));

    // Over the next second the heading sweeps right at ~turnRate rad/s.
    const start = rig.helicopter.mesh.rotation.y;
    simulate(rig, 1.0, 60, TURN_RIGHT);
    const sweep = rig.helicopter.mesh.rotation.y - start;
    expect(sweep).toBeLessThan(-(FLIGHT_SPEC.turnRate - 0.5));
    expect(sweep).toBeGreaterThan(-(FLIGHT_SPEC.turnRate + 0.5));
  });

  it('yaws left with A, opposite to D', () => {
    const rig = createRig();
    simulate(rig, 1.0, 60, TURN_LEFT);
    expect(rig.helicopter.bodyYawVelocity).toBeGreaterThan(FLIGHT_SPEC.turnRate - 0.5);
  });

  it('damps the yaw rate back to zero after the rudder is released', () => {
    const rig = createRig();
    simulate(rig, 1.0, 60, TURN_RIGHT);
    expect(Math.abs(rig.helicopter.bodyYawVelocity)).toBeGreaterThan(1.5);

    simulate(rig, 1.2, 60, NEUTRAL);
    expect(Math.abs(rig.helicopter.bodyYawVelocity)).toBeLessThan(0.06);
  });

  it('accelerates forward along the heading and caps cruise at maxForwardSpeed', () => {
    const rig = createRig();
    // Constructor spawns the nose at heading PI (forward = -Z).
    expect(rig.helicopter.mesh.rotation.y).toBeCloseTo(Math.PI, 3);

    simulate(rig, 2.5, 60, FORWARD);
    const speed = Math.hypot(
      rig.helicopter.body.velocity.x,
      rig.helicopter.body.velocity.z,
    );
    expect(speed).toBeCloseTo(FLIGHT_SPEC.maxForwardSpeed, 0);
    // Velocity follows forwardVector = (sin h, 0, cos h).
    expect(rig.helicopter.body.velocity.x).toBeCloseTo(0, 1);
    expect(rig.helicopter.body.velocity.z).toBeLessThan(-(FLIGHT_SPEC.maxForwardSpeed - 2));
  });

  it('responds immediately — a single frame already shows strong thrust', () => {
    const rig = createRig();
    step(rig, 1 / 60, FORWARD);
    expect(rig.helicopter.body.velocity.z).toBeLessThan(-1.5);
  });

  it('glides on exponential drag when keys are released (no abrupt stop)', () => {
    const rig = createRig();
    simulate(rig, 2.5, 60, FORWARD);
    expect(Math.abs(rig.helicopter.body.velocity.z)).toBeGreaterThan(30);

    simulate(rig, 0.4, 60, NEUTRAL);
    const remaining = Math.abs(rig.helicopter.body.velocity.z);
    expect(remaining).toBeGreaterThan(11);
    expect(remaining).toBeLessThan(31);

    simulate(rig, 2.0, 60, NEUTRAL);
    expect(Math.abs(rig.helicopter.body.velocity.z)).toBeLessThan(3);
  });

  it('strafes right with E — along the true right of the heading', () => {
    const rig = createRig();
    // Heading PI: nose along -Z; true right = (cos(PI),0,-sin(PI)) negated =
    // (+1, 0, 0). E (+1 strafe) must move the hull toward +X.
    simulate(rig, 1.2, 60, { x: 1, y: 0, z: 0, yaw: 0 });
    expect(rig.helicopter.body.velocity.x).toBeGreaterThan(14);
    expect(Math.abs(rig.helicopter.body.velocity.z)).toBeLessThan(3);
  });

  it('strafes left with Q — mirror of E', () => {
    const rig = createRig();
    simulate(rig, 1.2, 60, { x: -1, y: 0, z: 0, yaw: 0 });
    expect(rig.helicopter.body.velocity.x).toBeLessThan(-14);
    expect(Math.abs(rig.helicopter.body.velocity.z)).toBeLessThan(3);
  });

  it('climbs at ~9.5 m/s with Shift and sinks at ~8.0 m/s with Ctrl', () => {
    const climber = createRig();
    climber.helicopter.body.position.y = 10;
    simulate(climber, 0.9, 60, CLIMB);
    expect(climber.helicopter.body.velocity.y).toBeCloseTo(
      FLIGHT_SPEC.climbRate,
      1,
    );

    const diver = createRig();
    diver.helicopter.body.position.y = 20;
    simulate(diver, 0.9, 60, DESCEND);
    expect(diver.helicopter.body.velocity.y).toBeCloseTo(
      -FLIGHT_SPEC.sinkRate,
      1,
    );
  });

  it('clamps altitude strictly to the ground cushion / ceiling band', () => {
    const low = createRig();
    low.helicopter.body.position.y = 2.0;
    low.helicopter.body.velocity.y = -6;
    simulate(low, 0.2, 60, NEUTRAL);
    expect(low.helicopter.body.position.y).toBeGreaterThanOrEqual(
      FLIGHT_SPEC.groundCushion - 0.01,
    );
    expect(low.helicopter.body.velocity.y).toBeGreaterThanOrEqual(-0.01);

    const high = createRig();
    high.helicopter.body.position.y = 27;
    high.helicopter.body.velocity.y = 8;
    simulate(high, 0.2, 60, NEUTRAL);
    expect(high.helicopter.body.position.y).toBeLessThanOrEqual(
      FLIGHT_SPEC.ceiling + 0.01,
    );
    expect(high.helicopter.body.velocity.y).toBeLessThanOrEqual(0.01);
  });

  it('tilts the nose down when accelerating forward and up when reversing', () => {
    const accel = createRig();
    simulate(accel, 0.6, 60, FORWARD);
    // Euler order YXZ: positive rotation.x = nose down.
    expect(accel.helicopter.mesh.rotation.x).toBeGreaterThan(
      FLIGHT_SPEC.maxPitch * 0.9,
    );

    const reverse = createRig();
    simulate(reverse, 0.6, 60, { x: 0, y: 0, z: -1, yaw: 0 });
    expect(reverse.helicopter.mesh.rotation.x).toBeLessThan(
      -FLIGHT_SPEC.maxPitch * 0.9,
    );
  });

  it('banks into right turns and right strafes; mirrors for the left side', () => {
    const turner = createRig();
    simulate(turner, 0.7, 60, TURN_RIGHT);
    // Positive euler roll tips the hull up toward its right → right bank.
    expect(turner.helicopter.mesh.rotation.z).toBeGreaterThan(
      FLIGHT_SPEC.maxRoll * 0.85,
    );

    const straferRight = createRig();
    simulate(straferRight, 0.7, 60, { x: 1, y: 0, z: 0, yaw: 0 }); // E — strafe right
    expect(straferRight.helicopter.mesh.rotation.z).toBeGreaterThan(
      FLIGHT_SPEC.maxRoll * 0.85,
    );

    const straferLeft = createRig();
    simulate(straferLeft, 0.7, 60, { x: -1, y: 0, z: 0, yaw: 0 }); // Q — strafe left
    expect(straferLeft.helicopter.mesh.rotation.z).toBeLessThan(
      -FLIGHT_SPEC.maxRoll * 0.85,
    );
  });

  it('eases tilt back to level when input stops', () => {
    const rig = createRig();
    simulate(rig, 1.0, 60, TURN_RIGHT);
    expect(rig.helicopter.mesh.rotation.z).toBeGreaterThan(0.4);

    simulate(rig, 0.6, 60, NEUTRAL);
    expect(Math.abs(rig.helicopter.mesh.rotation.z)).toBeLessThan(0.03);
  });
});

describe('per-model airframes keep the spec envelope', () => {
  it.each([HelicopterModel.APACHE, HelicopterModel.NIGHTHAWK, HelicopterModel.WARLOCK])(
    'reaches the same cruise cap for model %i',
    (model) => {
      const rig = createRig(model);
      simulate(rig, 2.5, 60, FORWARD);
      const speed = Math.hypot(
        rig.helicopter.body.velocity.x,
        rig.helicopter.body.velocity.z,
      );
      expect(speed).toBeCloseTo(FLIGHT_SPEC.maxForwardSpeed, 0);
    },
  );
});
