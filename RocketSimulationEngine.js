/**
 * RocketSimulationEngine
 * Modular 2D aerospace telemetry & physics engine using Euler-Cromer integration
 * with SpaceX Falcon 9 VTVL (Vertical Takeoff, Vertical Landing) closed-loop guidance.
 */
class RocketSimulationEngine {
  static GRAVITY = 9.81;        // m/s²
  static DRY_MASS = 4.0;        // kg
  static BURN_RATE = 0.5;       // kg/s
  static INITIAL_THRUST = 250;  // N

  /**
   * @param {Object} [config]
   * @param {number} [config.initialFuelMass=8.45] - Initial propellant mass in kg (4.0 + 8.45 = 12.45 kg total)
   * @param {number} [config.targetAltitude=500] - User-defined target apogee height limit in meters
   * @param {number} [config.dragCoefficient=0.002] - Lumped aerodynamic drag factor (kg/m)
   */
  constructor(config = {}) {
    this.initialFuelMass = config.initialFuelMass ?? 8.45;
    this.targetAltitude = Math.max(20, Number(config.targetAltitude ?? 500));
    this.dragCoefficient = config.dragCoefficient ?? 0.002;
    this.timerId = null;
    this.reset(this.targetAltitude);
  }

  /**
   * Resets all telemetry quantities to 0.00 and prepares for launch to `targetAltitude`.
   * @param {number} [targetAltitude]
   */
  reset(targetAltitude) {
    this.stop();
    if (targetAltitude !== undefined) {
      this.targetAltitude = Math.max(20, Number(targetAltitude) || 500);
    }

    this.time = 0.0;
    this.fuelMass = this.initialFuelMass;
    this.mass = RocketSimulationEngine.DRY_MASS + this.fuelMass;
    this.thrust = 0.0;

    this.velocity_x = 0.0;
    this.velocity_y = 0.0;
    this.position_x = 0.0;
    this.position_y = 0.0;
    this.acceleration_x = 0.0;
    this.acceleration_y = 0.0;
    this.g_force = 0.0;

    this.phase = 'IDLE'; // IDLE | ASCENT | COAST | DESCENT | LANDING_BURN | LANDED
    this.legsDeployed = false;
    this.touchdownSpeed = 0.0;
    this.maxAltitudeReached = 0.0;
    this.hasLaunched = false;
    this.landed = false;
    return this.getTelemetryPayload();
  }

  /**
   * Advances the simulation by `dt` seconds using Euler-Cromer integration
   * and Falcon 9 closed-loop ascent cutoff + suicide-burn landing guidance.
   * @param {number} [dt=0.016] - Frame time delta in seconds
   * @returns {Object} Clean float telemetry payload
   */
  update(dt = 0.016) {
    if (this.landed || dt <= 0) {
      return this.getTelemetryPayload();
    }

    if (this.phase === 'IDLE') {
      this.phase = 'ASCENT';
    }

    this.time += dt;
    const g = RocketSimulationEngine.GRAVITY;
    const maxThrust = RocketSimulationEngine.INITIAL_THRUST;
    let commandedThrust = 0.0;
    let thrustAngleRad = Math.PI / 2; // Upright 90 deg

    // Scale fuel burn rate to target altitude envelope so booster retains landing reserve
    const altitudeBurnScale = 0.62 * Math.min(1.0, Math.sqrt(500 / Math.max(500, this.targetAltitude)));

    if (this.phase === 'ASCENT') {
      // Predict coast apogee given current upward velocity and average drag deceleration
      const speedY = Math.max(0, this.velocity_y);
      const avgDragDecel = (this.dragCoefficient * speedY * speedY) / (2 * this.mass);
      const predictedApogee = this.position_y + (speedY * speedY) / (2 * (g + avgDragDecel));

      if (predictedApogee >= this.targetAltitude || this.position_y >= this.targetAltitude) {
        // MECO (Main Engine Cutoff) to hit user's target height limit
        this.phase = 'COAST';
        commandedThrust = 0.0;
      } else {
        commandedThrust = maxThrust;
        thrustAngleRad = Math.PI / 2;
      }
    } else if (this.phase === 'COAST') {
      commandedThrust = 0.0;
      if (this.velocity_y <= 0) {
        this.phase = 'DESCENT';
      }
    } else if (this.phase === 'DESCENT') {
      commandedThrust = 0.0;
      // Check suicide-burn / hoverslam ignition criterion against conservative 8.5 m/s² net decel
      const vyDown = Math.max(0, -this.velocity_y);
      const altRemaining = Math.max(0.25, this.position_y);
      const reqStopAccel = (vyDown * vyDown) / (2 * altRemaining);

      if (reqStopAccel >= 8.5 || (this.position_y <= 30 && vyDown > 1.5)) {
        this.phase = 'LANDING_BURN';
      }
    }

    if (this.phase === 'LANDING_BURN') {
      const altRemaining = Math.max(0.05, this.position_y);
      // Exact closed-loop kinematic hoverslam law: a_net = vy² / (2 * y)
      const kinematicDecel = this.velocity_y < -0.35
        ? ((this.velocity_y * this.velocity_y - 0.12) / (2 * altRemaining)) * 1.03
        : 0;
      const reqAccelY = this.velocity_y < -0.35 ? g + kinematicDecel : g * 0.9;

      commandedThrust = Math.min(maxThrust, Math.max(0, this.mass * reqAccelY));
      // Retro-thrust steers out any residual horizontal drift
      const horizCorr = Math.max(-0.22, Math.min(0.22, -this.velocity_x * 0.08));
      thrustAngleRad = Math.PI / 2 + horizCorr;

      if (this.position_y <= Math.max(40, this.targetAltitude * 0.14)) {
        this.legsDeployed = true;
      }
    }

    // 1. Fuel consumption & mass update
    if (this.fuelMass > 0 && commandedThrust > 0) {
      const throttleRatio = commandedThrust / maxThrust;
      const burnStep = RocketSimulationEngine.BURN_RATE * throttleRatio * altitudeBurnScale * dt;
      this.fuelMass = Math.max(0, this.fuelMass - burnStep);
      this.thrust = this.fuelMass > 0 ? commandedThrust : 0.0;
    } else {
      this.thrust = 0.0;
    }

    this.mass = RocketSimulationEngine.DRY_MASS + this.fuelMass;

    // 2. Thrust vector components
    const thrust_x = this.thrust * Math.cos(thrustAngleRad);
    const thrust_y = this.thrust * Math.sin(thrustAngleRad);

    // 3. Aerodynamic drag opposing velocity + grid-fin horizontal damping during descent
    const speed = Math.hypot(this.velocity_x, this.velocity_y);
    const gridFinDamping = (this.phase === 'DESCENT' || this.phase === 'LANDING_BURN') ? 0.35 * this.velocity_x : 0;
    const drag_x = this.dragCoefficient * speed * this.velocity_x + gridFinDamping;
    const drag_y = this.dragCoefficient * speed * this.velocity_y;

    // 4. Net forces & accelerations
    const netForce_x = thrust_x - drag_x;
    const netForce_y = thrust_y - (this.mass * g) - drag_y;

    this.acceleration_x = netForce_x / this.mass;
    this.acceleration_y = netForce_y / this.mass;

    const totalAccelMag = Math.hypot(this.acceleration_x, this.acceleration_y);
    this.g_force = totalAccelMag / g;

    // 5. Euler-Cromer integration: update velocities first, then spatial coordinates
    this.velocity_x += this.acceleration_x * dt;
    this.velocity_y += this.acceleration_y * dt;

    this.position_x += this.velocity_x * dt;
    this.position_y += this.velocity_y * dt;

    if (this.position_y > 0) {
      this.hasLaunched = true;
      if (this.position_y > this.maxAltitudeReached) {
        this.maxAltitudeReached = this.position_y;
      }
    }

    // 6. Terminate loop execution when position_y drops to/below 0 after launching
    if (this.hasLaunched && this.position_y <= 0) {
      this.touchdownSpeed = Math.hypot(this.velocity_x, this.velocity_y);
      this.position_y = 0.0;
      this.velocity_x = 0.0;
      this.velocity_y = 0.0;
      this.acceleration_x = 0.0;
      this.acceleration_y = 0.0;
      this.g_force = 0.0;
      this.thrust = 0.0;
      this.legsDeployed = true;
      this.landed = true;
      this.phase = 'LANDED';
      this.stop();
    }

    return this.getTelemetryPayload();
  }

  /**
   * Starts a high-frequency tick loop and invokes `onTick(payload)` every step.
   */
  start(onTick, dt = 0.016) {
    this.stop();
    this.timerId = setInterval(() => {
      const payload = this.update(dt);
      if (typeof onTick === 'function') onTick(payload);
      if (this.landed) this.stop();
    }, dt * 1000);
  }

  stop() {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Returns a clean float JSON-serializable telemetry snapshot.
   */
  getTelemetryPayload() {
    const clean = (val) => Number(val.toFixed(4));
    const fuelPercent = this.initialFuelMass > 0
      ? clean((this.fuelMass / this.initialFuelMass) * 100)
      : 0.0;

    return {
      time: clean(this.time),
      mass: clean(this.mass),
      fuel_mass: clean(this.fuelMass),
      fuel_percent: fuelPercent,
      thrust: clean(this.thrust),
      velocity_x: clean(this.velocity_x),
      velocity_y: clean(this.velocity_y),
      velocity: clean(Math.hypot(this.velocity_x, this.velocity_y)),
      position_x: clean(this.position_x),
      position_y: clean(this.position_y),
      acceleration_x: clean(this.acceleration_x),
      acceleration_y: clean(this.acceleration_y),
      acceleration: clean(Math.hypot(this.acceleration_x, this.acceleration_y)),
      g_force: clean(this.g_force),
      target_altitude: clean(this.targetAltitude),
      max_altitude: clean(this.maxAltitudeReached),
      phase: this.phase,
      legs_deployed: this.legsDeployed,
      touchdown_speed: clean(this.touchdownSpeed),
      landed: this.landed
    };
  }
}

if (typeof window !== 'undefined') {
  window.RocketSimulationEngine = RocketSimulationEngine;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RocketSimulationEngine };
}

// Self-check when executed directly via Node
if (typeof require !== 'undefined' && require.main === module) {
  const assert = require('assert');
  const engine = new RocketSimulationEngine({ targetAltitude: 500 });
  const init = engine.getTelemetryPayload();
  assert(init.position_y === 0 && init.velocity === 0 && init.g_force === 0, 'Initial state must be 0');
  assert(init.fuel_percent === 100, 'Initial fuel must be 100%');

  let guard = 0;
  while (!engine.landed && guard++ < 100000) {
    engine.update(0.016);
  }
  const finalState = engine.getTelemetryPayload();
  assert(finalState.landed === true, 'Rocket must complete landing');
  assert(Math.abs(finalState.max_altitude - 500) < 15, `Apogee (${finalState.max_altitude}m) must match 500m target`);
  assert(finalState.touchdown_speed < 2.0, `Touchdown speed (${finalState.touchdown_speed} m/s) must be soft Falcon 9 landing`);
  console.log(
    'Falcon 9 Self-Landing Check Passed | Target: 500m | Apogee:',
    finalState.max_altitude.toFixed(2),
    'm | Touchdown Speed:',
    finalState.touchdown_speed.toFixed(2),
    'm/s | Fuel Remaining:',
    finalState.fuel_percent.toFixed(1) + '%'
  );
}
