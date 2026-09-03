# Changelog

All notable changes to Heli-Strike are tracked here. Entries follow the major
"Backup" commits on `main`.

## Follow-up tuning: snappier flight, handedness fix, combat visibility

- **Responsiveness & speed** — cruise cap raised 22 → 34 u/s, thrust
  acceleration 40 → 120 u/s² (cap reached in ~0.3 s), yaw cap raised to
  2.6 rad/s with faster accel/decel response, vertical response roughly
  doubled, and tilt easing quickened to `1 - exp(-12·dt)`. Drag eased slightly
  so coasting still reads as momentum without feeling floaty.
- **Left/right reversal fixed** — three.js is right-handed, so a hull whose
  nose runs along `(sin h, 0, cos h)` has its true right side at
  `(−cos h, 0, sin h)` and its nose swings right when the heading DECREASES.
  Rudder yaw, Q/E strafe and the into-turn/into-strafe banking roll were all
  mirrored to match. Unit tests now lock each direction explicitly.
- **Combat visibility** — the spawn ring was pulled in (85–165 u) and ~65% of
  air pressure (plus ground bias) now spawns in a wide arc AHEAD of the nose,
  so hostiles stream into the chase camera's view instead of engaging from
  behind it; the chase cam rides closer/lower (pull-back 26 + 4.5·ratio,
  height 20 + (alt−2.4)·0.34 + 1.6·ratio) and its look-target sits higher
  (`max(3, playerY·0.55)`) so airborne hostiles stay in frame.

## Vertical control & spawn fixes

- **Mid-band spawn** — runs now start at `FLIGHT_SPEC.spawnAltitude` (15 u
  above the surface) instead of the top of the 2.4–26 u altitude band. Spawning
  at the ceiling meant holding Space/Shift (climb) was clamped to zero motion,
  which read as "going up is broken". From 15 u both climb and descend respond
  instantly, on every deploy and wave restart.

## Backup: heading-relative flight controller + trailing chase camera

### Flight — heading-relative avionics (FLIGHT_SPEC)

- **New flight schema** — the pilot now commands an airframe, not a cursor:
  - `A/D` (←/→) rudder-yaw the heading at ~1.85 rad/s with smooth angular
    acceleration and deceleration damping;
  - `W/S` (↑/↓) cyclic thrust forward/reverse along
    `forwardVector = (sin h, 0, cos h)`; `Q/E` lateral-cyclic strafe along
    `(cos h, 0, -sin h)`; cruise caps at 22 u/s;
  - `Shift/Ctrl` collective climb/sink at 9.5 / 8.0 u/s;
  - altitude strictly clamped to a 2.4 m ground cushion / 26 m ceiling above
    the underlying surface (smoothed hover floor keeps rooftop canyons and
    roof landings working);
  - linear momentum glides on exponential drag `v *= exp(-drag·dt)` so the
    ship coasts when keys release instead of stopping dead.
- **Aerodynamic banking & pitch (visual mesh only)** — Euler order YXZ applies
  `RotationY(heading) → RotationX(pitch) → RotationZ(roll)`: nose-down ~18° on
  forward thrust, nose-up on braking/reverse; into-turn/strafe bank up to ~28°;
  both eased with `1 - exp(-10·dt)`.
- Retired by the new schema: double-tap dash, Shift afterburner, E Devastation
  keybind, Q salvo-paint (salvo stays on Right-Mouse-Button / on-screen
  button), Space/Alt vertical, camera orbit/recenter (X/V/middle-drag/R3) and
  free/soft/fixed camera modes. Gamepad & touch were remapped: left stick =
  rudder/thrust, D-pad = strafe/collective, right stick still aims the gun.

### Camera — dynamic trailing chase cam

- Heading-locked tail chase: pull-back `31 + ratio·5.5` m, height
  `22 + (alt−2.4)·0.42 + ratio·2.0` m where `ratio = clamp(speed/22, 0, 1.2)`;
  position eased `dt·7.5` horizontal / `dt·6.5` vertical.
- Forward lookahead `16 + ratio·8` m at `y = playerY·0.35`, eased `dt·9.0`.
- Subtle camera roll carries 15% of the airframe's bank; building-ghost
  occlusion, screen shake and speed FOV preserved.

### Aiming — decoupled turret gimbal

- The 30mm chin turret and reticle now track a ray cast onto the battlefield
  ground plane (Y = 0), fully independent of the flight heading — fly/strafe
  one way while gunning another. Auto-aim still snaps to locked targets.

## Backup: helicopter physics overhaul, enemy AI lead/LOS + turret aim & hit-flash, denser city, wave-scaling API, SP1/HD graphics toggle

### Graphics — SP1 / HD modes

- **New `Graphics Mode` setting** (Settings → SP1 / HD) replacing the old
  Low/Medium/High visual-quality row. Persists to `helistrike:settings`.
  - **SP1** (default): the original chunky low-res PS1-style look — low render
    resolution, no bloom, no MSAA, nearest-neighbor upscale
    (`image-rendering: pixelated`), direct rendering.
  - **HD**: crisp full-resolution render (up to 2x device pixel ratio), 4x MSAA
    via the effect composer's render targets, bloom enabled, and the PS1 color
    quantizer/dither pass disabled.
- Renderer branching (`getMaxPixelRatio`, `renderFrame`, `applyComposerQuality`,
  `applySettings`, `applyGovernorQuality`) now keys off `settings.graphics`.
- The adaptive quality governor still applies on top of either mode, shedding
  resolution/particles/bloom under load.

### Helicopter physics

- **Hover-settle spring** — a damped spring grounds the helicopter near the
  floor so landings settle instead of bouncing; spring is off above range so
  free flight is unchanged.
- **Yaw-rate limit** — nose turn is capped and lerps by speed instead of
  snapping exponentially.
- **Per-model movement profiles** — Apache (balanced), Nighthawk (fast/turny),
  Warlock (heavy/banky) each define speed, acceleration, turn, and bank ratios.
- **Climb/descend pitch** — the hull pitches with vertical velocity.
- **Wind drift** — storm wind now physically nudges the helicopter (capped).
- **Collision tuning** — roof/street landings damp vertical velocity, reduce
  landing damage, and no longer trigger the slam/explosion; wall damage scales
  with the angle of approach.

### Enemy AI

- **Aim leading** — `leadAim` solves a fixed-point intercept so gunships,
  flak tanks, interceptors, gatling heavies, drones, and standard enemies fire
  where the helicopter will be, not where it was.
- **Line-of-sight** — `hasLineOfSight` (segment vs. building AABBs) blocks shots
  through taller buildings; blocked shots don't consume the cooldown. Artillery
  and homing shots intentionally ignore LOS.

### Turrets

- **Aim pitch** — barrel tracks the player vertically, clamped to the gun's
  travel, with real-velocity lead; muzzle position respects pitch.
- **Hit-flash** — `takeDamage` triggers a brief red emissive flash on the
  turret's body that eases back to rest.

### City density

- Downtown, midtown, industrial, and residential district densities raised
  (~+0.16-0.18) and open-space chance cut, making the battlefield noticeably
  denser while staying within test-guarded ranges.

### Wave scaling — public API

- New unified wave surface wrapping the threat-budget director:
  - `waveSpawnBudget(wave, threatLevel)` — total spawn budget this wave.
  - `waveComposition(wave, remainingBudget, rng?)` — picks a wave-gated squad
    template stream, else an individual variant, budget- and wave-gated.
  - `waveStatScale(wave)` — unified `{ hp, damage, fireRate }` multipliers.
- New variants (Interceptor, Minelayer, Gatling Heavy) are fully wired end-to-end
  with tests.

## Backup: neon-arcade UI restyle + layered explosion effects with sound

- Neon-arcade UI restyle across menus/HUD.
- Layered explosion effects with sound.