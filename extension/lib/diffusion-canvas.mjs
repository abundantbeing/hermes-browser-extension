import { IMAGE_ASPECT_RATIOS, normalizeImageAspectRatio } from './image-render.mjs';

const DIFFUSION_PROFILES = Object.freeze(['bloom', 'twin', 'ribbon', 'cascade']);

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0));
  return t * t * (3 - (2 * t));
}

function mix(start, end, amount) {
  return start + ((end - start) * amount);
}

function hash(x, y, seed) {
  const value = Math.sin((x * 127.1) + (y * 311.7) + (seed * 74.7)) * 43758.5453123;
  return value - Math.floor(value);
}

function fractalNoise(x, y, seed) {
  let value = 0;
  let amplitude = 0.55;
  let frequency = 1;
  let weight = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    value += hash(Math.floor(x * frequency), Math.floor(y * frequency), seed + octave) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return value / weight;
}

function seedNumber(value) {
  if (Number.isFinite(Number(value))) return (Number(value) >>> 0) || 1;
  const text = String(value || 'hermes-image').trim() || 'hermes-image';
  let result = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    result ^= text.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0) || 1;
}

function seededUnit(seed, salt) {
  let value = (seed + Math.imul(salt, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a2d97);
  value ^= value >>> 15;
  return (value >>> 0) / 4294967296;
}

export function diffusionVariantForSeed(value) {
  const seed = seedNumber(value);
  const unit = (salt) => seededUnit(seed, salt);
  const profile = DIFFUSION_PROFILES[Math.floor(unit(1) * DIFFUSION_PROFILES.length)];
  return {
    seed,
    profile,
    phase: unit(2) * Math.PI * 2,
    timeOffset: mix(0, 19, unit(28)),
    tempo: mix(0.72, 1.34, unit(29)),
    motionDirection: unit(30) > 0.5 ? 1 : -1,
    revealDuration: Number(mix(2.8, 4.9, unit(31)).toFixed(3)),
    revealSoftness: Number(mix(0.1, 0.24, unit(32)).toFixed(4)),
    colorHold: Number(mix(0.035, 0.09, unit(33)).toFixed(4)),
    colorCreepEnd: Number(mix(0.52, 0.7, unit(34)).toFixed(4)),
    detailStart: Number(mix(0.14, 0.26, unit(35)).toFixed(4)),
    colorSoftness: Number(mix(0.04, 0.1, unit(36)).toFixed(4)),
    colorSourceCount: 3 + Math.floor(unit(37) * 3),
    cellScale: Number(mix(0.82, 1.18, unit(3)).toFixed(4)),
    noiseScale: Number(mix(3.5, 5.8, unit(4)).toFixed(4)),
    densityBias: Number(mix(-0.1, 0.1, unit(5)).toFixed(4)),
    focusX: mix(0.28, 0.72, unit(6)),
    focusY: mix(0.28, 0.72, unit(7)),
    secondaryX: mix(0.2, 0.8, unit(8)),
    secondaryY: mix(0.2, 0.8, unit(9)),
    driftX: mix(0.05, 0.18, unit(10)),
    driftY: mix(0.05, 0.18, unit(11)),
    driftRateX: mix(0.22, 0.58, unit(12)),
    driftRateY: mix(0.18, 0.52, unit(13)),
    waveAngle: unit(14) * Math.PI * 2,
    waveScale: mix(0.38, 0.72, unit(15)),
    waveSpeed: mix(1.35, 2.7, unit(16)),
    cycleSeconds: mix(2.7, 4.4, unit(17)),
    scan: {
      duration: Number(mix(2.4, 4.8, unit(18)).toFixed(3)),
      bandHeight: Math.round(mix(6, 12, unit(19))),
      dropoutTop: Math.round(mix(18, 82, unit(20))),
      dropoutDuration: Number(mix(0.8, 1.75, unit(21)).toFixed(3)),
      delay: Number((-mix(0.2, 4.6, unit(22))).toFixed(3)),
      tearShift: Math.round(mix(3, 11, unit(23))) * (unit(24) > 0.5 ? 1 : -1),
      lineGap: Math.round(mix(3, 6, unit(25))),
      lumaDuration: Number(mix(1.3, 2.9, unit(26)).toFixed(3)),
      bandOpacity: Number(mix(0.14, 0.3, unit(27)).toFixed(3)),
    },
  };
}

function canvasSize(canvas) {
  const rect = canvas.getBoundingClientRect?.();
  const width = Math.max(1, Math.round(rect?.width || canvas.clientWidth || 320));
  const height = Math.max(1, Math.round(rect?.height || canvas.clientHeight || 180));
  return { width, height };
}

function paletteFor(canvas) {
  const style = globalThis.getComputedStyle?.(canvas);
  const accent = style?.getPropertyValue('--hermes-accent')?.trim() || '#e06b70';
  const ink = style?.getPropertyValue('--hermes-ink')?.trim() || '#f0ece4';
  const paper = style?.getPropertyValue('--hermes-paper')?.trim() || '#101112';
  return { accent, ink, paper };
}

function profileSignal(variant, x, y, time) {
  const focusX = variant.focusX + (Math.sin((time * variant.driftRateX) + variant.phase) * variant.driftX);
  const focusY = variant.focusY + (Math.cos((time * variant.driftRateY) + variant.phase) * variant.driftY);

  if (variant.profile === 'twin') {
    const secondaryX = variant.secondaryX + (Math.cos((time * variant.driftRateY * 0.72) - variant.phase) * variant.driftX * 0.7);
    const secondaryY = variant.secondaryY + (Math.sin((time * variant.driftRateX * 0.68) - variant.phase) * variant.driftY * 0.7);
    const first = smoothstep(0.46, 0.02, Math.hypot(x - focusX, y - focusY));
    const second = smoothstep(0.42, 0.02, Math.hypot(x - secondaryX, y - secondaryY));
    return clamp(Math.max(first, second) + (Math.min(first, second) * 0.32));
  }

  if (variant.profile === 'ribbon') {
    const ribbonY = focusY + (Math.sin((x * 7.2) + variant.phase + (time * 0.42)) * 0.16);
    const width = 0.035 + ((Math.sin((x * 4.1) - variant.phase) + 1) * 0.018);
    const ribbon = smoothstep(width * 4.8, width, Math.abs(y - ribbonY));
    const bloom = smoothstep(0.5, 0.04, Math.hypot(x - focusX, y - focusY));
    return clamp((ribbon * 0.78) + (bloom * 0.34));
  }

  if (variant.profile === 'cascade') {
    const directionX = Math.cos(variant.waveAngle);
    const directionY = Math.sin(variant.waveAngle);
    const stripe = (Math.sin((((x - focusX) * directionX) + ((y - focusY) * directionY)) * 18 + variant.phase - (time * 0.7)) + 1) * 0.5;
    const envelope = smoothstep(0.7, 0.04, Math.hypot((x - focusX) * 0.76, (y - focusY) * 1.18));
    return clamp((stripe * 0.62 * envelope) + (envelope * 0.38));
  }

  const distance = Math.hypot((x - focusX) * 0.9, (y - focusY) * 1.12);
  const bloom = smoothstep(0.6, 0.025, distance);
  const contour = (Math.sin((Math.atan2(y - focusY, x - focusX) * 3) + (distance * 18) - (time * 0.5) + variant.phase) + 1) * 0.5;
  return clamp((bloom * 0.78) + (contour * bloom * 0.22));
}

const DETACHED_CHECK_MS = 1_000;
const DETACHED_STOP_MS = 10 * 60_000;

/** Animated seeded pixel diffusion used only while image_generate is running. */
export function createDiffusionCanvas(canvas, { aspectRatio = 'landscape', seed = Date.now(), maxFps = 60 } = {}) {
  const variant = diffusionVariantForSeed(seed);
  const context = canvas?.getContext?.('2d');
  if (!canvas || !context) return { variant, start() {}, stop() {}, settle() {}, render() {}, reveal() { return Promise.resolve({ variant, cancelled: true }); } };

  const ratioName = normalizeImageAspectRatio(aspectRatio);
  const ratio = IMAGE_ASPECT_RATIOS[ratioName];
  let animationFrame = 0;
  let startedAt = 0;
  let started = false;
  let disposed = false;
  let revealImage = null;
  let revealStartedAt = 0;
  let revealProgress = 0;
  let revealOrder = null;
  let revealColumns = 0;
  let revealRows = 0;
  let colorOrder = null;
  let colorColumns = 0;
  let colorRows = 0;
  let revealComplete = null;
  let lastFrameAt = 0;
  const frameRate = clamp(Number(maxFps) || 60, 24, 120);
  const minimumFrameMs = 1000 / frameRate;
  const reduceMotion = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  canvas.dataset.visualProfile = variant.profile;
  canvas.dataset.visualSeed = String(variant.seed);

  let backingWidth = 0;
  let backingHeight = 0;
  let backingDpr = 0;
  const resize = () => {
    const { width, height } = canvasSize(canvas);
    const dpr = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio || 1)));
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (
      backingWidth === pixelWidth
      && backingHeight === pixelHeight
      && backingDpr === dpr
      && canvas.width === pixelWidth
      && canvas.height === pixelHeight
    ) return;
    backingWidth = pixelWidth;
    backingHeight = pixelHeight;
    backingDpr = dpr;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const observer = globalThis.ResizeObserver ? new globalThis.ResizeObserver(resize) : null;
  observer?.observe(canvas);

  function ensureRevealOrder(columns, rows) {
    if (revealOrder && revealColumns === columns && revealRows === rows) return revealOrder;
    revealColumns = columns;
    revealRows = rows;
    revealOrder = new Float32Array(columns * rows);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const rankNoise = hash(x, y, variant.seed + 7717);
        const rankCluster = fractalNoise((x / columns) * 5.2, (y / rows) * 5.2, variant.seed + 4129);
        revealOrder[(y * columns) + x] = clamp((rankNoise * 0.58) + (rankCluster * 0.42));
      }
    }
    return revealOrder;
  }

  function ensureColorOrder(columns, rows) {
    if (colorOrder && colorColumns === columns && colorRows === rows) return colorOrder;
    colorColumns = columns;
    colorRows = rows;
    colorOrder = new Float32Array(columns * rows);
    const colorSources = [];
    const gridDiagonal = Math.max(1, Math.hypot(columns, rows));

    for (let sourceIndex = 0; sourceIndex < variant.colorSourceCount; sourceIndex += 1) {
      let selectedSource = null;
      for (let candidateIndex = 0; candidateIndex < 10; candidateIndex += 1) {
        const candidateSalt = (sourceIndex * 19) + candidateIndex;
        const candidate = {
          x: mix(0.08, 0.92, hash(candidateSalt, sourceIndex, variant.seed + 5167)),
          y: mix(0.08, 0.92, hash(sourceIndex, candidateSalt, variant.seed + 6247)),
        };
        const nearestDistance = colorSources.length
          ? Math.min(...colorSources.map((source) => Math.hypot(
            (candidate.x - source.x) * columns,
            (candidate.y - source.y) * rows,
          ))) / gridDiagonal
          : 1;
        if (!selectedSource || nearestDistance > selectedSource.nearestDistance) {
          selectedSource = { ...candidate, nearestDistance };
        }
      }
      colorSources.push(selectedSource);
    }

    let minimumRank = Number.POSITIVE_INFINITY;
    let maximumRank = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const normalizedX = (x + 0.5) / columns;
        const normalizedY = (y + 0.5) / rows;
        const nearestDistance = Math.min(...colorSources.map((source) => Math.hypot(
          (normalizedX - source.x) * columns,
          (normalizedY - source.y) * rows,
        ))) / gridDiagonal;
        const clusterNoise = fractalNoise(normalizedX * 4.2, normalizedY * 4.2, variant.seed + 7331);
        const edgeNoise = fractalNoise(normalizedX * 9.7, normalizedY * 9.7, variant.seed + 8111);
        const rank = (nearestDistance * 0.74) + (clusterNoise * 0.18) + (edgeNoise * 0.08);
        colorOrder[(y * columns) + x] = rank;
        minimumRank = Math.min(minimumRank, rank);
        maximumRank = Math.max(maximumRank, rank);
      }
    }

    const rankRange = Math.max(0.0001, maximumRank - minimumRank);
    for (let index = 0; index < colorOrder.length; index += 1) {
      colorOrder[index] = clamp((colorOrder[index] - minimumRank) / rankRange);
    }
    return colorOrder;
  }

  function drawRevealedImage(width, height, columns, rows, progress) {
    if (!revealImage || progress <= 0) return;
    const naturalWidth = Number(revealImage.naturalWidth || revealImage.width || 0);
    const naturalHeight = Number(revealImage.naturalHeight || revealImage.height || 0);
    if (!naturalWidth || !naturalHeight) return;
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    const sourceCellWidth = naturalWidth / columns;
    const sourceCellHeight = naturalHeight / rows;
    const revealRanks = ensureRevealOrder(columns, rows);
    const colorRanks = ensureColorOrder(columns, rows);
    const colorPhase = clamp((progress - variant.colorHold) / (variant.colorCreepEnd - variant.colorHold));
    const detailPhase = clamp((progress - variant.detailStart) / (1 - variant.detailStart));
    context.globalCompositeOperation = 'source-over';
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const cellIndex = (y * columns) + x;
        const revealRank = revealRanks[cellIndex];
        const colorRank = colorRanks[cellIndex];
        const colorProgress = colorPhase <= 0 ? 0 : smoothstep(
          colorRank - variant.colorSoftness,
          colorRank,
          colorPhase,
        );
        if (colorProgress <= 0.01) continue;
        const detailRank = clamp((colorRank * 0.72) + (revealRank * 0.28));
        const rawDetailProgress = detailPhase <= 0 ? 0 : smoothstep(
          detailRank - variant.revealSoftness,
          detailRank,
          detailPhase,
        );
        const detailGate = smoothstep(0.72, 1, colorProgress);
        const localProgress = rawDetailProgress * detailGate;
        const flicker = hash(x + Math.floor(progress * 17), y, variant.seed + 9871);
        const sourceX = x * sourceCellWidth;
        const sourceY = y * sourceCellHeight;
        const sampleSourceX = clamp(sourceX + (sourceCellWidth * (0.18 + (hash(x, y, variant.seed + 1123) * 0.64))), 0, naturalWidth - 1);
        const sampleSourceY = clamp(sourceY + (sourceCellHeight * (0.18 + (hash(y, x, variant.seed + 1877) * 0.64))), 0, naturalHeight - 1);
        const destinationX = x * cellWidth;
        const destinationY = y * cellHeight;
        const destinationWidth = Math.ceil(cellWidth) + 0.5;
        const destinationHeight = Math.ceil(cellHeight) + 0.5;
        const mosaicProgress = clamp(colorProgress * (1 - (localProgress * 0.22)));

        context.imageSmoothingEnabled = false;
        context.globalAlpha = reduceMotion ? 1 : clamp(mosaicProgress * (0.88 + (flicker * 0.12)));
        context.drawImage(revealImage, sampleSourceX, sampleSourceY, 1, 1, destinationX, destinationY, destinationWidth, destinationHeight);

        if (localProgress > 0.01) {
          context.imageSmoothingEnabled = true;
          context.globalAlpha = reduceMotion ? 1 : clamp((localProgress * 1.12) - ((1 - localProgress) * flicker * 0.2));
          context.drawImage(revealImage, sourceX, sourceY, sourceCellWidth + 0.5, sourceCellHeight + 0.5, destinationX, destinationY, destinationWidth, destinationHeight);
        }
      }
    }
    context.imageSmoothingEnabled = true;
    context.globalAlpha = 1;
  }

  const render = (now = globalThis.performance?.now?.() || Date.now()) => {
    if (disposed) return;
    resize();
    const { width, height } = canvasSize(canvas);
    const { accent, ink, paper } = paletteFor(canvas);
    const elapsed = started ? (now - startedAt) : 0;
    const time = variant.timeOffset + (Math.max(0, elapsed / 1000) * variant.tempo);
    const motionTime = time * variant.motionDirection;
    const cycle = Math.floor(time / variant.cycleSeconds);
    const blend = smoothstep(0, 1, (time % variant.cycleSeconds) / variant.cycleSeconds);
    const columns = Math.max(18, Math.floor(width / (11 * variant.cellScale)));
    const rows = Math.max(12, Math.floor(height / (11 * variant.cellScale)));
    if (revealImage) {
      const revealElapsed = Math.max(0, (now - revealStartedAt) / 1000);
      revealProgress = reduceMotion ? 1 : clamp(revealElapsed / variant.revealDuration);
    }
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    const seedCycle = (variant.seed % 10007) + (cycle * 13);

    context.clearRect(0, 0, width, height);
    context.fillStyle = paper;
    context.fillRect(0, 0, width, height);

    const glowX = width * (variant.focusX + (Math.sin((motionTime * variant.driftRateX) + variant.phase) * variant.driftX));
    const glowY = height * (variant.focusY + (Math.cos((motionTime * variant.driftRateY) + variant.phase) * variant.driftY));
    const field = context.createRadialGradient(glowX, glowY, 0, glowX, glowY, Math.max(width, height) * 0.72);
    field.addColorStop(0, accent);
    field.addColorStop(0.38, ink);
    field.addColorStop(1, 'transparent');
    context.globalAlpha = reduceMotion ? 0.1 : 0.17;
    context.fillStyle = field;
    context.fillRect(0, 0, width, height);

    context.globalCompositeOperation = 'screen';
    const waveX = Math.cos(variant.waveAngle) * variant.waveScale;
    const waveY = Math.sin(variant.waveAngle) * variant.waveScale;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const normalizedX = (x + 0.5) / columns;
        const normalizedY = (y + 0.5) / rows;
        const offsetX = normalizedX - 0.5;
        const offsetY = normalizedY - 0.5;
        const rotatedX = (offsetX * Math.cos(variant.waveAngle)) - (offsetY * Math.sin(variant.waveAngle));
        const rotatedY = (offsetX * Math.sin(variant.waveAngle)) + (offsetY * Math.cos(variant.waveAngle));
        const sampleX = (rotatedX * variant.noiseScale) + (motionTime * 0.025) + (variant.phase * 0.37);
        const sampleY = (rotatedY * variant.noiseScale) - (motionTime * 0.018) - (variant.phase * 0.21);
        const before = fractalNoise(sampleX, sampleY, seedCycle);
        const after = fractalNoise(sampleX, sampleY, seedCycle + 13);
        const noise = mix(before, after, blend);
        const structure = profileSignal(variant, normalizedX, normalizedY, motionTime);
        const wave = (Math.sin((x * waveX) + (y * waveY) + (motionTime * variant.waveSpeed) + variant.phase) + 1) * 0.5;
        const signal = clamp((noise * 0.52) + (structure * 0.34) + (wave * 0.14) + variant.densityBias);
        const dropout = hash(x - (cycle * 7), y + (cycle * 11), variant.seed);
        if (dropout > 0.42 + (signal * 0.7)) continue;

        const opacity = 0.025 + (smoothstep(0.3, 0.9, signal) * 0.78);
        const inset = signal > 0.72 ? 0 : 1;
        const jitter = (1 - structure) * (1 - blend) * 1.25;
        const jitterX = (hash(x, y, seedCycle + 31) - 0.5) * jitter;
        const jitterY = (hash(y, x, seedCycle + 47) - 0.5) * jitter;
        context.globalAlpha = opacity;
        context.fillStyle = signal > 0.62 ? accent : ink;
        context.fillRect(
          (x * cellWidth) + inset + jitterX,
          (y * cellHeight) + inset + jitterY,
          Math.max(1, Math.ceil(cellWidth) - 2 - inset),
          Math.max(1, Math.ceil(cellHeight) - 2 - inset),
        );
      }
    }

    context.globalCompositeOperation = 'source-over';
    drawRevealedImage(width, height, columns, rows, revealProgress);
    const dropoutStep = Math.floor((time + variant.phase) / variant.scan.dropoutDuration);
    const dropoutPulse = hash(dropoutStep, variant.seed % 997, variant.seed);
    if (!reduceMotion && dropoutPulse > 0.58) {
      const sourceScale = canvas.width / width;
      const baseY = hash(dropoutStep, 17, variant.seed) * height;
      const stripCount = 2 + Math.floor(hash(dropoutStep, 29, variant.seed) * 3);
      context.fillStyle = accent;
      for (let strip = 0; strip < stripCount; strip += 1) {
        const stripHeight = 1 + Math.floor(hash(strip, dropoutStep, variant.seed) * 3);
        const stripY = clamp(baseY + (strip * 4) - 5, 0, Math.max(0, height - stripHeight));
        const shift = variant.scan.tearShift * (0.45 + (hash(strip, 41, variant.seed) * 0.8));
        context.globalAlpha = 0.34 + (hash(strip, 53, variant.seed) * 0.3);
        context.drawImage(
          canvas,
          0,
          stripY * sourceScale,
          canvas.width,
          stripHeight * sourceScale,
          shift,
          stripY,
          width,
          stripHeight,
        );
        context.globalAlpha = 0.08 + (hash(strip, 67, variant.seed) * 0.12);
        context.fillRect(0, stripY, width, 1);
      }
    }

    context.globalAlpha = 0.46;
    context.strokeStyle = accent;
    context.lineWidth = 1;
    context.setLineDash([2, 6]);
    context.lineDashOffset = reduceMotion ? 0 : -((motionTime * 9) + (variant.phase * 3));
    const inset = Math.max(10, Math.round(Math.min(width, height) * 0.065));
    context.strokeRect(inset, inset, width - (inset * 2), height - (inset * 2));
    context.setLineDash([]);
    context.globalAlpha = 1;
    canvas.dataset.aspectRatio = `${ratio}`;
    canvas.dataset.revealProgress = revealProgress.toFixed(4);
    if (revealImage && revealProgress >= 1 && revealComplete) {
      const complete = revealComplete;
      revealComplete = null;
      complete({ variant, naturalWidth: revealImage.naturalWidth, naturalHeight: revealImage.naturalHeight });
    }
  };

  let attached = false;
  let wake = 0;
  const stop = () => {
    disposed = true;
    if (animationFrame) globalThis.cancelAnimationFrame?.(animationFrame);
    animationFrame = 0;
    if (wake) globalThis.clearTimeout(wake);
    wake = 0;
    revealComplete?.({ variant, cancelled: true });
    revealComplete = null;
    revealImage = null;
    observer?.disconnect();
  };

  // A canvas that left the page pauses: a chat the user leaves and returns to attaches the same
  // row again, and its card picks up where it was. A reveal under way finishes at once, so a turn
  // never waits on a card nobody sees. One that stays away ten minutes is stopped.
  const pauseWhileDetached = () => {
    animationFrame = 0;
    if (revealImage) {
      revealStartedAt = -Infinity;
      render(globalThis.performance?.now?.() || Date.now());
    }
    const since = Date.now();
    const check = () => {
      wake = 0;
      if (disposed) return;
      if (canvas.isConnected) {
        lastFrameAt = 0;
        animationFrame = globalThis.requestAnimationFrame?.(tick) || 0;
        return;
      }
      if (Date.now() - since > DETACHED_STOP_MS) {
        stop();
        return;
      }
      wake = globalThis.setTimeout(check, DETACHED_CHECK_MS);
      wake?.unref?.();
    };
    wake = globalThis.setTimeout(check, DETACHED_CHECK_MS);
    wake?.unref?.();
  };

  const tick = (now) => {
    if (canvas.isConnected) attached = true;
    else if (attached && canvas.isConnected === false) {
      pauseWhileDetached();
      return;
    }
    const frameElapsed = now - lastFrameAt;
    if (!lastFrameAt || frameElapsed >= minimumFrameMs) {
      render(now);
      lastFrameAt = now - (frameElapsed % minimumFrameMs);
    }
    if (!disposed && !reduceMotion) animationFrame = globalThis.requestAnimationFrame?.(tick) || 0;
  };

  return {
    variant,
    render,
    reveal(image) {
      if (disposed || !image) return Promise.resolve({ variant, cancelled: true });
      revealImage = image;
      revealStartedAt = attached && !canvas.isConnected ? -Infinity : (globalThis.performance?.now?.() || Date.now());
      revealProgress = 0;
      revealOrder = null;
      canvas.dataset.revealState = 'revealing';
      return new Promise((resolve) => {
        revealComplete = (result) => {
          canvas.dataset.revealState = 'complete';
          resolve(result);
        };
        render(globalThis.performance?.now?.() || Date.now());
      });
    },
    start() {
      if (disposed || started) return;
      started = true;
      startedAt = globalThis.performance?.now?.() || Date.now();
      lastFrameAt = startedAt;
      render(startedAt);
      if (!reduceMotion) animationFrame = globalThis.requestAnimationFrame?.(tick) || 0;
    },
    stop,
    // Ends the animation but keeps the picture: a reveal still under way is drawn finished,
    // once, and nothing is scheduled after it.
    settle() {
      if (disposed) return;
      if (revealImage) {
        revealStartedAt = -Infinity;
        render(globalThis.performance?.now?.() || Date.now());
      }
      stop();
    },
  };
}
