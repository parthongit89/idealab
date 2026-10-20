/**
 * app.js
 * Lead Frontend Orchestration Layer connecting HTML5 Canvas, Telemetry DOM,
 * RocketSimulationEngine, Chart Overlay Views, and Web Audio API Synthesizer.
 */

class TelemetryAudioSynthesizer {
  constructor() {
    this.ctx = null;
    this.rumbleOsc = null;
    this.rumbleSubOsc = null;
    this.rumbleGain = null;
    this.isRumbling = false;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * 1. Crisp ignition sound sequence on launch trigger
   */
  playIgnition() {
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.09);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.28);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.32, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.31);
  }

  /**
   * 2. Continuous low-frequency thrust rumble modulated by velocity
   */
  updateThrustRumble(active, velocityMag = 0) {
    if (!this.ctx) return;

    if (!active) {
      this.stopThrustRumble();
      return;
    }

    const now = this.ctx.currentTime;
    if (!this.isRumbling) {
      this.rumbleOsc = this.ctx.createOscillator();
      this.rumbleSubOsc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      this.rumbleGain = this.ctx.createGain();

      this.rumbleOsc.type = 'sawtooth';
      this.rumbleSubOsc.type = 'triangle';

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(190, now);

      this.rumbleGain.gain.setValueAtTime(0.001, now);
      this.rumbleGain.gain.exponentialRampToValueAtTime(0.18, now + 0.12);

      this.rumbleOsc.connect(filter);
      this.rumbleSubOsc.connect(filter);
      filter.connect(this.rumbleGain);
      this.rumbleGain.connect(this.ctx.destination);

      this.rumbleOsc.start(now);
      this.rumbleSubOsc.start(now);
      this.isRumbling = true;
    }

    // Modulate pitch dynamically proportional to velocity changes
    const baseFreq = 48 + Math.min(95, velocityMag * 0.28);
    this.rumbleOsc.frequency.setTargetAtTime(baseFreq, now, 0.04);
    this.rumbleSubOsc.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.04);
  }

  stopThrustRumble() {
    if (!this.isRumbling || !this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      this.rumbleGain.gain.setTargetAtTime(0.0001, now, 0.05);
      this.rumbleOsc.stop(now + 0.18);
      this.rumbleSubOsc.stop(now + 0.18);
    } catch (_) {
      // Ignore already-stopped oscillator state
    }
    this.rumbleOsc = null;
    this.rumbleSubOsc = null;
    this.rumbleGain = null;
    this.isRumbling = false;
  }

  /**
   * 3. Short impact alert frequency burst when returning to altitude 0
   */
  playImpactAlert() {
    this.stopThrustRumble();
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(58, now + 0.24);

    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.27);
  }
}

(() => {
  const canvas = document.getElementById('simulation-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // DOM References
  const playBtn = document.getElementById('play-btn');
  const controlPanel = document.getElementById('control-panel');
  const chartPanel = document.getElementById('chart-panel');
  const openLeftDrawer = document.getElementById('open-left-drawer');
  const openRightDrawer = document.getElementById('open-right-drawer');
  const chartTabs = Array.from(document.querySelectorAll('.chart-tab'));

  const elAltitude = document.getElementById('val-altitude');
  const elDistance = document.getElementById('val-distance');
  const elVelocity = document.getElementById('val-velocity');
  const elAcceleration = document.getElementById('val-acceleration');
  const elGForce = document.getElementById('val-gforce');
  const elMass = document.getElementById('val-mass');
  const elThrust = document.getElementById('val-thrust');
  const elFuel = document.getElementById('val-fuel');
  const elFuelBar = document.getElementById('fuel-bar');
  const inputTargetAltitude = document.getElementById('input-target-altitude');

  // Core instances & orchestration state
  const engine = new RocketSimulationEngine();
  const audio = new TelemetryAudioSynthesizer();

  const VIEW_MODES = ['trajectory', 'velocity', 'gforce'];
  const SKY_SHADES = ['#CAF0F8', '#0077B6', '#023E8A', '#03045E'];
  let activeViewMode = 'trajectory';
  let flightHistory = [];
  let currentState = engine.getTelemetryPayload();
  let currentAngleRad = Math.PI / 2; // 90 deg upright on pad
  let cameraZoom = 1.0;
  let animId = null;
  let isRunning = false;

  // Optional Figma image assets with clean vector fallback
  const assetPaths = {
    nose: 'Resorces/Rectangle 112.png',
    nozzle: 'Resorces/image 9.png',
    flame: 'Resorces/Ellipse 41.png'
  };
  const images = {};
  Object.keys(assetPaths).forEach((key) => {
    const img = new Image();
    img.src = assetPaths[key];
    img.onload = () => renderFrame();
    images[key] = img;
  });

  /**
   * Computes camera zoom, ground Y boundary, and world-to-screen coordinate mapping.
   * As the rocket gains altitude, cameraZoom decreases smoothly so the launchpad,
   * landing site, and rocket zoom out proportionally.
   */
  function getViewportMetrics() {
    const alt = Math.max(0, currentState.position_y);
    const targetZoom = Math.max(0.18, 1 / (1 + alt / 260));
    cameraZoom += (targetZoom - cameraZoom) * 0.15;

    document.documentElement.style.setProperty('--camera-zoom', cameraZoom.toFixed(4));

    const baseGroundHeight = Math.max(85, canvas.height * 0.105);
    const groundHeight = baseGroundHeight * cameraZoom;
    const groundY = canvas.height - groundHeight;
    const launchX = canvas.width * 0.51;

    // World meters-to-pixels scales smoothly with cameraZoom and user's target altitude
    const targetAlt = Math.max(100, currentState.target_altitude || 500);
    let maxSpanY = Math.max(220, alt * 1.35, targetAlt * 1.18);
    let maxSpanX = Math.max(220, Math.abs(currentState.position_x) * 1.35);
    for (let i = 0; i < flightHistory.length; i++) {
      if (flightHistory[i].position_y * 1.18 > maxSpanY) maxSpanY = flightHistory[i].position_y * 1.18;
    }

    const usableHeight = Math.max(180, groundY - 210);
    const metersToPixels = usableHeight / maxSpanY;

    return {
      groundY,
      launchX,
      cameraZoom,
      metersToPixels,
      toScreenX: (xMeters) => launchX + xMeters * metersToPixels,
      toScreenY: (yMeters) => groundY - yMeters * metersToPixels
    };
  }

  /**
   * Renders atmospheric color shade progression (#CAF0F8 -> #0077B6 -> #023E8A -> #03045E)
   * shifting dynamically as the rocket climbs higher.
   */
  function drawAtmosphereShades(metrics) {
    const alt = Math.max(0, currentState.position_y);
    // Normalized altitude progression (0 at pad -> 1 at high altitude)
    const progress = Math.min(1, alt / 2500);

    const grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
    // Shift stops downward as altitude increases so higher shades dominate as rocket climbs
    const stop1 = Math.max(0.0, 0.28 - progress * 0.22);
    const stop2 = Math.max(0.15, 0.58 - progress * 0.28);
    const stop3 = Math.max(0.38, 0.85 - progress * 0.30);

    grad.addColorStop(0, SKY_SHADES[0]);     // #CAF0F8 (Low altitude / Troposphere)
    grad.addColorStop(stop1, SKY_SHADES[0]); // #CAF0F8
    grad.addColorStop(stop2, SKY_SHADES[1]); // #0077B6 (Mid altitude)
    grad.addColorStop(stop3, SKY_SHADES[2]); // #023E8A (High altitude / Stratosphere)
    grad.addColorStop(1, SKY_SHADES[3]);     // #03045E (Upper atmosphere / Deep space shade)

    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw subtle altitude band labels on the right edge matching the 4 color shades
    const bandAltitudes = [
      { label: '0 m — #CAF0F8', yMeters: 0, color: SKY_SHADES[0] },
      { label: '500 m — #0077B6', yMeters: 500, color: SKY_SHADES[1] },
      { label: '1500 m — #023E8A', yMeters: 1500, color: SKY_SHADES[2] },
      { label: '3000 m — #03045E', yMeters: 3000, color: SKY_SHADES[3] }
    ];

    ctx.font = '600 11px Inter, Segoe UI, sans-serif';
    ctx.textAlign = 'right';
    bandAltitudes.forEach((band) => {
      const sy = metrics.toScreenY(band.yMeters);
      if (sy > 140 && sy < metrics.groundY - 8) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.fillText(band.label, canvas.width - 18, sy - 6);
      }
    });

    // Draw Target Height Limit marker line & Falcon 9 Flight Phase HUD
    const targetAlt = currentState.target_altitude || 500;
    const targetY = metrics.toScreenY(targetAlt);
    if (targetY > 130 && targetY < metrics.groundY - 10) {
      ctx.strokeStyle = 'rgba(255, 192, 30, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(canvas.width * 0.28, targetY);
      ctx.lineTo(canvas.width * 0.74, targetY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffc01e';
      ctx.textAlign = 'left';
      ctx.fillText(`TARGET HEIGHT LIMIT: ${targetAlt.toFixed(0)} m`, canvas.width * 0.28 + 8, targetY - 6);
    }

    // Flight Phase Telemetry Status Pill
    const phaseLabels = {
      IDLE: 'PAD STANDBY — READY FOR LAUNCH',
      ASCENT: 'FALCON 9 ASCENT — MAIN ENGINE BURN',
      COAST: 'MECO — COASTING TO TARGET APOGEE',
      DESCENT: 'GRID-FIN VERTICAL DESCENT',
      LANDING_BURN: 'SUICIDE BURN — HOVERSLAM ACTIVE',
      LANDED: `LANDED SAFELY (TOUCHDOWN: ${(currentState.touchdown_speed || 0).toFixed(2)} m/s)`
    };
    const statusText = phaseLabels[currentState.phase] || 'STANDBY';
    ctx.textAlign = 'center';
    ctx.font = '700 12px Inter, Segoe UI, sans-serif';
    ctx.fillStyle = currentState.phase === 'LANDED' ? '#4ade80' : '#ffffff';
    ctx.fillText(statusText, canvas.width * 0.51, 162);

    ctx.restore();
  }

  /**
   * Renders the continuous blue trajectory trace for 'trajectory' mode
   */
  function drawTrajectoryTrace(metrics) {
    if (flightHistory.length < 2) return;

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < flightHistory.length; i++) {
      const pt = flightHistory[i];
      const sx = metrics.toScreenX(pt.position_x);
      const sy = metrics.toScreenY(pt.position_y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }

    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0, 229, 255, 0.55)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Renders the translucent time-series overlay box for 'velocity' or 'gforce'
   */
  function drawMetricOverlayChart(mode) {
    const isVelocity = mode === 'velocity';
    const title = isVelocity ? 'VELOCITY VS. TIME (M/S)' : 'G-FORCE VS. TIME (G)';
    const metricKey = isVelocity ? 'velocity' : 'g_force';
    const strokeColor = isVelocity ? '#ffc01e' : '#ff7034';

    const boxW = Math.min(520, canvas.width * 0.42);
    const boxH = 230;
    const boxX = canvas.width - boxW - 36;
    const boxY = 155;
    const padL = 54;
    const padR = 24;
    const padT = 44;
    const padB = 34;

    ctx.save();

    // Translucent overlay window box
    ctx.fillStyle = 'rgba(6, 36, 44, 0.82)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 14);
    ctx.fill();
    ctx.stroke();

    // Header label
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 13px Inter, Segoe UI, sans-serif';
    ctx.fillText(title, boxX + 20, boxY + 26);

    const plotX = boxX + padL;
    const plotY = boxY + padT;
    const plotW = boxW - padL - padR;
    const plotH = boxH - padT - padB;

    // Axes
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, plotY);
    ctx.lineTo(plotX, plotY + plotH);
    ctx.lineTo(plotX + plotW, plotY + plotH);
    ctx.stroke();

    let maxTime = 10;
    let maxVal = isVelocity ? 150 : 5;
    for (let i = 0; i < flightHistory.length; i++) {
      if (flightHistory[i].time > maxTime) maxTime = flightHistory[i].time;
      if (flightHistory[i][metricKey] > maxVal) maxVal = flightHistory[i][metricKey];
    }
    maxVal *= 1.1;

    // Axis labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.font = '600 11px Inter, Segoe UI, sans-serif';
    ctx.fillText(maxVal.toFixed(1), boxX + 12, plotY + 8);
    ctx.fillText('0.0', boxX + 22, plotY + plotH);
    ctx.fillText('0s', plotX, plotY + plotH + 18);
    ctx.fillText(maxTime.toFixed(1) + 's', plotX + plotW - 28, plotY + plotH + 18);

    // Data curve
    if (flightHistory.length > 1) {
      ctx.beginPath();
      for (let i = 0; i < flightHistory.length; i++) {
        const pt = flightHistory[i];
        const px = plotX + (pt.time / maxTime) * plotW;
        const py = plotY + plotH - (pt[metricKey] / maxVal) * plotH;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Renders the rocket sprite using a 2D canvas translation + rotation matrix
   * aligned to the velocity direction vector and scaled by cameraZoom.
   */
  function drawRocketSprite(screenX, screenY, angleRad, thrustActive, zoom) {
    const scale = zoom;

    ctx.save();
    ctx.translate(screenX, screenY);
    // Sprite local -Y axis points toward nose; rotate by (Math.PI / 2 - angleRad)
    ctx.rotate(Math.PI / 2 - angleRad);
    ctx.scale(scale, scale);

    // Exhaust plume
    if (thrustActive) {
      if (images.flame && images.flame.complete && images.flame.naturalWidth) {
        ctx.drawImage(images.flame, -78, -28, 156, 250);
      } else {
        const grad = ctx.createRadialGradient(0, 80, 5, 0, 80, 90);
        grad.addColorStop(0, 'rgba(255, 200, 49, 0.95)');
        grad.addColorStop(0.6, 'rgba(255, 135, 49, 0.5)');
        grad.addColorStop(1, 'rgba(255, 135, 49, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(0, 85, 42, 95, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Engine Nozzle
    if (images.nozzle && images.nozzle.complete && images.nozzle.naturalWidth) {
      ctx.save();
      ctx.translate(0, -52);
      ctx.scale(1, -1);
      ctx.drawImage(images.nozzle, -53, -65, 106, 131);
      ctx.restore();
    } else {
      ctx.fillStyle = '#1f1f1f';
      ctx.beginPath();
      ctx.moveTo(-18, -26);
      ctx.lineTo(18, -26);
      ctx.lineTo(24, 0);
      ctx.lineTo(-24, 0);
      ctx.closePath();
      ctx.fill();
    }

    // Aerodynamic Fins
    ctx.fillStyle = '#036980';
    ctx.beginPath();
    ctx.moveTo(-35, -240);
    ctx.lineTo(-56, -40);
    ctx.lineTo(-35, -40);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(35, -240);
    ctx.lineTo(56, -40);
    ctx.lineTo(35, -40);
    ctx.closePath();
    ctx.fill();

    // SpaceX Falcon 9 Deployable Landing Legs (deploy during landing burn & touchdown)
    if (currentState.legs_deployed) {
      ctx.strokeStyle = '#1d2122';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      // Left landing leg + strut
      ctx.moveTo(-35, -75);
      ctx.lineTo(-78, 2);
      ctx.moveTo(-35, -45);
      ctx.lineTo(-62, -18);
      // Right landing leg + strut
      ctx.moveTo(35, -75);
      ctx.lineTo(78, 2);
      ctx.moveTo(35, -45);
      ctx.lineTo(62, -18);
      ctx.stroke();
    }

    // Cylindrical Fuselage
    const bodyGrad = ctx.createLinearGradient(-35, 0, 35, 0);
    bodyGrad.addColorStop(0, '#5a5a5a');
    bodyGrad.addColorStop(0.5, '#b8b8b8');
    bodyGrad.addColorStop(1, '#5a5a5a');
    ctx.fillStyle = bodyGrad;
    ctx.fillRect(-35, -388, 70, 362);

    // Nose Cone
    if (images.nose && images.nose.complete && images.nose.naturalWidth) {
      ctx.drawImage(images.nose, -40, -563, 80, 178);
    } else {
      const noseGrad = ctx.createRadialGradient(0, -450, 5, 0, -450, 80);
      noseGrad.addColorStop(0, '#d8d8d8');
      noseGrad.addColorStop(1, '#686868');
      ctx.fillStyle = noseGrad;
      ctx.beginPath();
      ctx.moveTo(-40, -388);
      ctx.lineTo(-40, -475);
      ctx.quadraticCurveTo(-5, -563, 0, -563);
      ctx.quadraticCurveTo(5, -563, 40, -475);
      ctx.lineTo(40, -388);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Updates DOM telemetry readouts
   */
  function updateTelemetryDOM(state) {
    if (elAltitude) elAltitude.textContent = state.position_y.toFixed(2);
    if (elDistance) elDistance.textContent = state.position_x.toFixed(2);
    if (elVelocity) elVelocity.textContent = state.velocity.toFixed(2);
    if (elAcceleration) elAcceleration.textContent = state.acceleration.toFixed(2);
    if (elGForce) elGForce.textContent = state.g_force.toFixed(2);
    if (elMass) elMass.textContent = state.mass.toFixed(2) + ' kg';
    if (elThrust) elThrust.textContent = state.thrust.toFixed(2) + ' N';
    if (elFuel) elFuel.textContent = Math.round(state.fuel_percent) + '%';
    if (elFuelBar) elFuelBar.value = state.fuel_percent;
  }

  /**
   * Main Canvas Render Pass
   */
  function renderFrame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const metrics = getViewportMetrics();

    drawAtmosphereShades(metrics);

    if (activeViewMode === 'trajectory') {
      drawTrajectoryTrace(metrics);
    }

    const rocketScreenX = metrics.toScreenX(currentState.position_x);
    const rocketScreenY = metrics.toScreenY(currentState.position_y);
    const thrustActive = isRunning && currentState.thrust > 0 && !currentState.landed;

    drawRocketSprite(rocketScreenX, rocketScreenY, currentAngleRad, thrustActive, metrics.cameraZoom);

    if (activeViewMode === 'velocity' || activeViewMode === 'gforce') {
      drawMetricOverlayChart(activeViewMode);
    }
  }

  /**
   * Real-time Animation Ticker
   */
  function tickSimulation() {
    // Advance physics (2 sub-steps per frame for brisk visual pacing at 60fps)
    for (let i = 0; i < 2; i++) {
      currentState = engine.update(0.016);
      flightHistory.push(currentState);
      if (currentState.landed) break;
    }

    // Keep Falcon 9 booster oriented vertically (upright) for VTVL ascent & propulsive landing
    const tiltTarget = Math.PI / 2 - (currentState.velocity_x * 0.015);
    currentAngleRad += (tiltTarget - currentAngleRad) * 0.2;

    updateTelemetryDOM(currentState);
    audio.updateThrustRumble(currentState.thrust > 0 && !currentState.landed, currentState.velocity);
    renderFrame();

    if (!currentState.landed) {
      animId = requestAnimationFrame(tickSimulation);
    } else {
      isRunning = false;
      audio.playImpactAlert();
      renderFrame();
    }
  }

  // 1. Orange Chart Panel Button Handlers ('trajectory', 'velocity', 'gforce')
  chartTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      chartTabs.forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      activeViewMode = tab.dataset.mode || VIEW_MODES[index] || 'trajectory';
      renderFrame();
    });
  });

  // 2. Play Simulation Trigger
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      controlPanel?.classList.add('is-hidden');
      chartPanel?.classList.add('is-hidden');
      openLeftDrawer?.classList.remove('is-hidden');
      openRightDrawer?.classList.remove('is-hidden');

      cancelAnimationFrame(animId);
      const userHeightLimit = Math.max(50, Number(inputTargetAltitude?.value) || 500);
      currentState = engine.reset(userHeightLimit);
      flightHistory = [currentState];
      currentAngleRad = Math.PI / 2;
      cameraZoom = 1.0;
      isRunning = true;

      updateTelemetryDOM(currentState);
      audio.playIgnition();
      animId = requestAnimationFrame(tickSimulation);
    });
  }

  // Drawer Toggle Handlers
  openLeftDrawer?.addEventListener('click', () => {
    controlPanel?.classList.remove('is-hidden');
    openLeftDrawer.classList.add('is-hidden');
  });

  openRightDrawer?.addEventListener('click', () => {
    chartPanel?.classList.remove('is-hidden');
    openRightDrawer.classList.add('is-hidden');
  });

  function handleResize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    renderFrame();
  }

  window.addEventListener('resize', handleResize);
  handleResize();
})();
