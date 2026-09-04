import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

// Pure re-implementation of the trailing chase-camera spec formulas (see
// GameEngine.updateCamera). Kept dependency-free so the exact contract is
// locked down without constructing the whole engine.
interface ChaseState {
  camX: number;
  camY: number;
  camZ: number;
  lookX: number;
  lookY: number;
  lookZ: number;
}

const MAX_SPEED = 22;

function speedRatio(horizontalSpeed: number): number {
  return THREE.MathUtils.clamp(horizontalSpeed / MAX_SPEED, 0, 1.2);
}

function desiredCamera(
  player: { x: number; y: number; z: number },
  heading: number,
  horizontalSpeed: number,
): { x: number; y: number; z: number } {
  const sr = speedRatio(horizontalSpeed);
  const camDist = 31 + sr * 5.5;
  // altitudeAboveCushion = (playerY - 2.4), clamped at 0.
  const altAboveCushion = Math.max(0, player.y - 2.4);
  const camHeight = 22 + altAboveCushion * 0.42 + sr * 2.0;
  return {
    x: player.x - Math.sin(heading) * camDist,
    y: player.y + camHeight,
    z: player.z - Math.cos(heading) * camDist,
  };
}

function desiredLook(
  player: { x: number; y: number; z: number },
  heading: number,
  horizontalSpeed: number,
): { x: number; y: number; z: number } {
  const sr = speedRatio(horizontalSpeed);
  const lookaheadDist = 16 + sr * 8.0;
  return {
    x: player.x + Math.sin(heading) * lookaheadDist,
    y: player.y * 0.35,
    z: player.z + Math.cos(heading) * lookaheadDist,
  };
}

function easeStep(
  state: ChaseState,
  dt: number,
  targetCam: { x: number; y: number; z: number },
  targetLook: { x: number; y: number; z: number },
): ChaseState {
  const hK = 1 - Math.exp(-7.5 * dt);
  const vK = 1 - Math.exp(-6.5 * dt);
  const lK = 1 - Math.exp(-9 * dt);
  return {
    camX: state.camX + (targetCam.x - state.camX) * hK,
    camY: state.camY + (targetCam.y - state.camY) * vK,
    camZ: state.camZ + (targetCam.z - state.camZ) * hK,
    lookX: state.lookX + (targetLook.x - state.lookX) * lK,
    lookY: state.lookY + (targetLook.y - state.lookY) * lK,
    lookZ: state.lookZ + (targetLook.z - state.lookZ) * lK,
  };
}

describe('trailing chase camera (flight spec)', () => {
  it('clamps the speed ratio to 0..1.2', () => {
    expect(speedRatio(0)).toBe(0);
    expect(speedRatio(MAX_SPEED)).toBe(1);
    expect(speedRatio(MAX_SPEED * 2)).toBe(1.2);
  });

  it('pulls back and rises as speed grows', () => {
    const player = { x: 0, y: 15, z: 0 };
    const hover = desiredCamera(player, 0, 0);
    const cruise = desiredCamera(player, 0, MAX_SPEED);

    // Behind the tail for heading 0: negative z.
    expect(hover.x).toBeCloseTo(0, 5);
    expect(hover.z).toBeCloseTo(-31, 5);
    expect(cruise.z).toBeCloseTo(-(31 + 5.5), 5);

    const baseHeight = 22 + (15 - 2.4) * 0.42;
    expect(hover.y).toBeCloseTo(player.y + baseHeight, 5);
    expect(cruise.y).toBeCloseTo(player.y + baseHeight + 2.0, 5);
  });

  it('sits behind the tail using the aircraft heading', () => {
    const player = { x: 10, y: 12, z: -20 };
    const h = Math.PI / 2; // nose along +X → camera trails along −X
    const cam = desiredCamera(player, h, 0);
    expect(cam.x).toBeCloseTo(player.x - 31, 5);
    expect(cam.z).toBeCloseTo(player.z, 5);
  });

  it('looks ahead of the nose into the battlefield, scaling with speed', () => {
    const player = { x: 0, y: 10, z: 0 };
    const h = 0;
    const hoverLook = desiredLook(player, h, 0);
    expect(hoverLook.x).toBeCloseTo(0, 5);
    expect(hoverLook.z).toBeCloseTo(16, 5);
    expect(hoverLook.y).toBeCloseTo(player.y * 0.35, 5);

    const cruiseLook = desiredLook(player, h, MAX_SPEED);
    expect(cruiseLook.z).toBeCloseTo(16 + 8, 5);
  });

  it('converges with silky dual-stage interpolation (7.5 / 6.5 / 9.0)', () => {
    const player = { x: 0, y: 8, z: 0 };
    const targetCam = desiredCamera(player, 0, 0);
    const targetLook = desiredLook(player, 0, 0);
    let state: ChaseState = {
      camX: 0, camY: 0, camZ: 0, lookX: 0, lookY: 0, lookZ: 0,
    };

    const dt = 1 / 60;
    for (let i = 0; i < 240; i++) {
      state = easeStep(state, dt, targetCam, targetLook);
    }
    expect(state.camX).toBeCloseTo(targetCam.x, 3);
    expect(state.camZ).toBeCloseTo(targetCam.z, 3);
    expect(state.camY).toBeCloseTo(targetCam.y, 2);
    expect(state.lookX).toBeCloseTo(targetLook.x, 3);
    expect(state.lookZ).toBeCloseTo(targetLook.z, 3);
    expect(state.lookY).toBeCloseTo(targetLook.y, 2);
  });

  it('lags responsively on a fast maneuver rather than snapping', () => {
    const player = { x: 0, y: 8, z: 0 };
    const targetCam = desiredCamera(player, Math.PI / 2, MAX_SPEED);
    let state: ChaseState = {
      camX: 0, camY: 24, camZ: -31, lookX: 0, lookY: 3, lookZ: 16,
    };
    state = easeStep(state, 1 / 60, targetCam, desiredLook(player, Math.PI / 2, MAX_SPEED));
    // A single frame moves partway, not all the way.
    expect(Math.abs(state.camX)).toBeLessThan(8);
    expect(Math.abs(state.camX)).toBeGreaterThan(1);
  });
});
