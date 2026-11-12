let sourceCanvas, sourceCtx;
let overlayCanvas, overlayCtx;

let isPlaying = false;
let animationFrameId = null;
let scanPos = 0;
let bpm = 120;
let lastTimestamp = 0;

let isDrawMode = false;
let isDrawing = false;
let detectedPoints = [];

let audioCtx = null;
let masterGain = null;
let voiceBus = null;
let delayNode = null;

const pluckCache = new Map();
const lastNoteTime = {};
const MAX_VOICES_PER_STEP = 4;

const SCALES = {
  pentatonic: [
    130.81, 146.83, 164.81, 196.0, 220.0, 261.63, 293.66, 329.63, 392.0, 440.0,
    523.25, 587.33, 659.25,
  ],
  minor: [
    130.81, 155.56, 174.61, 196.0, 233.08, 261.63, 311.13, 349.23, 392.0,
    466.16, 523.25, 622.25, 698.46,
  ],
  major: [
    130.81, 146.83, 164.81, 174.61, 196.0, 220.0, 246.94, 261.63, 293.66,
    329.63, 349.23, 392.0, 440.0,
  ],
};

window.onload = function () {
  sourceCanvas = document.getElementById("sourceCanvas");
  sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });

  overlayCanvas = document.getElementById("overlayCanvas");
  overlayCtx = overlayCanvas.getContext("2d");

  clearCanvas();
  setupDrawingEvents();
};

/* ---------- AUDIO ---------- */

function initAudio() {
  if (audioCtx) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext();

  const compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.25;
  compressor.connect(audioCtx.destination);

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.6;
  masterGain.connect(compressor);

  voiceBus = audioCtx.createGain();
  voiceBus.connect(masterGain); // señal seca

  const reverb = audioCtx.createConvolver();
  reverb.buffer = createImpulseResponse(3.2, 2.8);
  const reverbWet = audioCtx.createGain();
  reverbWet.gain.value = 0.5;
  voiceBus.connect(reverb);
  reverb.connect(reverbWet);
  reverbWet.connect(masterGain);

  delayNode = audioCtx.createDelay(2.0);
  delayNode.delayTime.value = delayTimeForBPM(bpm);
  const delayFilter = audioCtx.createBiquadFilter();
  delayFilter.type = "lowpass";
  delayFilter.frequency.value = 2200;
  const feedback = audioCtx.createGain();
  feedback.gain.value = 0.35;
  const delayWet = audioCtx.createGain();
  delayWet.gain.value = 0.22;

  voiceBus.connect(delayNode);
  delayNode.connect(delayFilter);
  delayFilter.connect(feedback);
  feedback.connect(delayNode);
  delayFilter.connect(delayWet);
  delayWet.connect(masterGain);
  delayWet.connect(reverb);
}

function delayTimeForBPM(b) {
  return (60 / b) * 0.75;
}

function createImpulseResponse(duration, decay) {
  const rate = audioCtx.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = audioCtx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function getPluck(freq) {
  if (pluckCache.has(freq)) return pluckCache.get(freq);

  const rate = audioCtx.sampleRate;
  const period = Math.max(2, Math.round(rate / freq));
  const length = Math.floor(rate * 2.5);
  const buffer = audioCtx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);

  let prev = 0,
    sum = 0;
  for (let i = 0; i < period; i++) {
    prev = prev * 0.5 + (Math.random() * 2 - 1) * 0.5;
    data[i] = prev;
    sum += prev;
  }
  const mean = sum / period;
  for (let i = 0; i < period; i++) data[i] -= mean;

  const damping = 0.996;
  for (let i = period; i < length; i++) {
    const a = data[i - period];
    const b = i - period - 1 >= 0 ? data[i - period - 1] : 0;
    data[i] = damping * 0.5 * (a + b);
  }

  const fade = Math.floor(rate * 0.1);
  for (let i = 0; i < fade; i++) {
    data[length - 1 - i] *= i / fade;
  }

  const realFreq = rate / (period + 0.5);
  const pluck = { buffer, rate: freq / realFreq };
  pluckCache.set(freq, pluck);
  return pluck;
}

function getScale() {
  const scaleName = document.getElementById("scaleSelect").value;
  return SCALES[scaleName] || SCALES.pentatonic;
}

function noteIndexFor(yNormalized, scale) {
  const index = Math.floor((1 - yNormalized) * scale.length);
  return Math.max(0, Math.min(scale.length - 1, index));
}

function playNote(freq, velocity = 1) {
  if (!audioCtx) initAudio();
  if (audioCtx.state === "suspended") audioCtx.resume();

  const now = audioCtx.currentTime;

  const pluck = getPluck(freq);
  const src = audioCtx.createBufferSource();
  src.buffer = pluck.buffer;
  src.playbackRate.value = pluck.rate;

  const tone = audioCtx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(8000, freq * 6);
  tone.Q.value = 0.5;

  const body = audioCtx.createOscillator();
  body.type = "sine";
  body.frequency.value = freq;
  const bodyGain = audioCtx.createGain();
  bodyGain.gain.setValueAtTime(0.0001, now);
  bodyGain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);

  const voiceGain = audioCtx.createGain();
  voiceGain.gain.value = 0.55 * velocity;

  let out = voiceGain;
  if (audioCtx.createStereoPanner) {
    const pan = audioCtx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.6;
    voiceGain.connect(pan);
    out = pan;
  }
  out.connect(voiceBus);

  src.connect(tone);
  tone.connect(voiceGain);
  body.connect(bodyGain);
  bodyGain.connect(voiceGain);

  src.start(now);
  src.stop(now + 2.5);
  body.start(now);
  body.stop(now + 1.5);
}

function playNotes(notes, scale) {
  if (notes.size === 0) return;
  if (!audioCtx) initAudio();

  const now = audioCtx.currentTime;
  const minGap = 60 / bpm / 4;

  [...notes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_VOICES_PER_STEP)
    .forEach(([index, count]) => {
      const key = scale.length + ":" + index;
      if (lastNoteTime[key] && now - lastNoteTime[key] < minGap) return;
      lastNoteTime[key] = now;
      const velocity = Math.min(1, 0.45 + count * 0.12);
      playNote(scale[index], velocity);
    });
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      sourceCtx.fillStyle = "#ffffff";
      sourceCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);

      const hRatio = sourceCanvas.width / img.width;
      const vRatio = sourceCanvas.height / img.height;
      const ratio = Math.min(hRatio, vRatio);
      const centerShiftX = (sourceCanvas.width - img.width * ratio) / 2;
      const centerShiftY = (sourceCanvas.height - img.height * ratio) / 2;

      sourceCtx.drawImage(
        img,
        0,
        0,
        img.width,
        img.height,
        centerShiftX,
        centerShiftY,
        img.width * ratio,
        img.height * ratio,
      );

      analyzeImagePoints();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function clearCanvas() {
  sourceCtx.fillStyle = "#ffffff";
  sourceCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  analyzeImagePoints();
}

function setupDrawingEvents() {
  sourceCanvas.addEventListener("mousedown", (e) => {
    if (!isDrawMode) return;
    isDrawing = true;
    drawPoint(e);
  });
  sourceCanvas.addEventListener("mousemove", (e) => {
    if (isDrawing && isDrawMode) drawPoint(e);
  });
  sourceCanvas.addEventListener("mouseup", () => (isDrawing = false));
  sourceCanvas.addEventListener("mouseleave", () => (isDrawing = false));
}

function toggleDrawMode() {
  isDrawMode = !isDrawMode;
  const btn = document.getElementById("drawBtn");
  if (isDrawMode) {
    sourceCanvas.classList.add("draw-mode");
    btn.classList.add("active");
  } else {
    sourceCanvas.classList.remove("draw-mode");
    btn.classList.remove("active");
  }
}

function drawPoint(e) {
  const rect = sourceCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (sourceCanvas.width / rect.width);
  const y = (e.clientY - rect.top) * (sourceCanvas.height / rect.height);

  sourceCtx.fillStyle = "#000000";
  sourceCtx.beginPath();
  sourceCtx.arc(x, y, 6, 0, Math.PI * 2);
  sourceCtx.fill();

  analyzeImagePoints();
}

function analyzeImagePoints() {
  const imgData = sourceCtx.getImageData(
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
  );
  const data = imgData.data;
  const threshold = parseInt(document.getElementById("sensSlider").value);

  detectedPoints = [];
  const step = 6;

  const gridWidth = Math.floor(sourceCanvas.width / step);
  const gridHeight = Math.floor(sourceCanvas.height / step);
  const visited = new Uint8Array(gridWidth * gridHeight);

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const idx = gy * gridWidth + gx;
      if (visited[idx]) continue;

      const px = gx * step;
      const py = gy * step;
      const pIdx = (py * sourceCanvas.width + px) * 4;

      const brightness = (data[pIdx] + data[pIdx + 1] + data[pIdx + 2]) / 3;

      if (brightness < threshold) {
        detectedPoints.push({
          x: px,
          y: py,
          triggered: false,
          activeFrames: 0,
        });
        visited[idx] = 1;
      }
    }
  }
  drawOverlay();
}

function drawOverlay() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  detectedPoints.forEach((p) => {
    if (p.activeFrames > 0) {
      overlayCtx.fillStyle = "#000000";
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      overlayCtx.fill();
      p.activeFrames--;
    }
  });

  overlayCtx.strokeStyle = "#0000ff";
  overlayCtx.lineWidth = 1;
  overlayCtx.beginPath();
  overlayCtx.moveTo(scanPos, 0);
  overlayCtx.lineTo(scanPos, overlayCanvas.height);
  overlayCtx.stroke();
}

function togglePlay() {
  if (isPlaying) {
    pauseScan();
  } else {
    startScan();
  }
}

function startScan() {
  if (!audioCtx) initAudio();
  isPlaying = true;
  document.getElementById("playBtn").textContent = "Pausar";
  lastTimestamp = performance.now();
  animationFrameId = requestAnimationFrame(scanLoop);
}

function pauseScan() {
  isPlaying = false;
  document.getElementById("playBtn").textContent = "Reproducir";
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
}

function stopScan() {
  pauseScan();
  scanPos = 0;
  resetPoints();
  drawOverlay();
}

function resetPoints() {
  detectedPoints.forEach((p) => {
    p.triggered = false;
    p.activeFrames = 0;
  });
}

function updateBPM(val) {
  bpm = parseInt(val);
  document.getElementById("bpmVal").textContent = bpm;
  if (delayNode) {
    delayNode.delayTime.setTargetAtTime(
      delayTimeForBPM(bpm),
      audioCtx.currentTime,
      0.1,
    );
  }
}

function scanLoop(timestamp) {
  if (!isPlaying) return;

  const delta = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;

  const speedPixelsPerSec = (bpm / 60) * 140;
  scanPos += speedPixelsPerSec * delta;

  if (scanPos >= sourceCanvas.width) {
    scanPos = 0;
    resetPoints();
  }

  const scanTolerance = 5;
  const scale = getScale();
  const notesThisFrame = new Map();
  detectedPoints.forEach((p) => {
    if (!p.triggered && Math.abs(p.x - scanPos) < scanTolerance) {
      p.triggered = true;
      p.activeFrames = 6;
      const idx = noteIndexFor(p.y / sourceCanvas.height, scale);
      notesThisFrame.set(idx, (notesThisFrame.get(idx) || 0) + 1);
    }
  });
  playNotes(notesThisFrame, scale);

  drawOverlay();
  animationFrameId = requestAnimationFrame(scanLoop);
}
