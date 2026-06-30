import {
  HandLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const textCanvas = document.getElementById("textCanvas");
const textCtx = textCanvas.getContext("2d");

const start = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const countdownEl = document.getElementById("countdown");
const processingEl = document.getElementById("processing");
const processingTextEl = document.getElementById("processingText");
const resultBox = document.getElementById("resultBox");
const resultNote = document.getElementById("resultNote");
const downloadLink = document.getElementById("downloadLink");
const retryBtn = document.getElementById("retry");

const foto = document.getElementById("foto");
const jokowi = document.getElementById("jokowi");

let gesture = "NORMAL";
let handLandmarker = null;
let lastVideoTime = -1;
let frameCount = 0;

const WATERMARK_TEXT = "@daffapriyantana";

// batas maksimal sisi terpanjang video HASIL REKAMAN, sekarang ADAPTIF
// sesuai kemampuan device (ditentukan di bawah lewat getQualityTier()).
let MAX_RECORD_SIDE = 1280;

// ===================
// ADAPTIVE QUALITY — nyesuaiin setting encode (resolusi, CRF, preset)
// sesuai kemampuan device, biar device kenceng dapet hasil maksimal dan
// device medium tetap dapet kualitas bagus tapi tetap aman/gak nge-hang.
// navigator.deviceMemory cuma kebaca di browser berbasis Chromium
// (Android Chrome dll), TIDAK ada di Safari/iOS — makanya kalau gak ada,
// kita tebak pakai jumlah core CPU (hardwareConcurrency) yang didukung
// lebih luas termasuk Safari.
// ===================

const QUALITY_TIERS = {
  high: { maxSide: 1920, crf: "17", preset: "fast", timeoutMs: 180000, label: "Tinggi (1080p)" },
  mid: { maxSide: 1280, crf: "19", preset: "veryfast", timeoutMs: 150000, label: "Bagus (720p)" }
};

function getQualityTier() {

  const mem = navigator.deviceMemory; // GB, bisa undefined
  const cores = navigator.hardwareConcurrency || 4;

  if (mem) {
    return mem >= 6 ? "high" : "mid";
  }

  // fallback buat browser yang gak expose deviceMemory (Safari/iOS)
  return cores >= 6 ? "high" : "mid";

}

const activeTier = QUALITY_TIERS[getQualityTier()];
MAX_RECORD_SIDE = activeTier.maxSide;


// ===================
// CANVAS KHUSUS REKAM
// ===================
// Canvas ini TIDAK ditampilkan ke user (gak ditaruh ke DOM), cuma dipakai
// sebagai sumber video untuk MediaRecorder. Semua efek (video, blur,
// teks gesture, watermark) digambar ULANG secara manual di sini tiap
// frame, terpisah dari resolusi preview, supaya hasil rekam tetap ringan.
const recordCanvas = document.createElement("canvas");
const recordCtx = recordCanvas.getContext("2d");

function computeRecordSize(vw, vh) {

  const longest = Math.max(vw, vh);

  if (longest <= MAX_RECORD_SIDE) {
    return { rw: vw, rh: vh };
  }

  const scale = MAX_RECORD_SIDE / longest;
  return {
    rw: Math.round(vw * scale),
    rh: Math.round(vh * scale)
  };

}


// ===================
// BLUR MANUAL (downscale -> upscale)
// ===================
// ctx.filter="blur()" / CSS filter TIDAK reliable lintas browser HP,
// terutama in-app browser (WhatsApp/Instagram) & Safari iOS — kadang
// kelihatan pas preview, ilang pas direkam/didownload. Trik ini cuma
// pakai drawImage + image smoothing, yang didukung 100% di semua browser,
// jadi hasilnya KONSISTEN baik di preview maupun di video hasil download.
const blurTempCanvas = document.createElement("canvas");
const blurTempCtx = blurTempCanvas.getContext("2d");

function drawFrame(targetCtx, w, h, blurOn) {

  if (!blurOn) {
    targetCtx.drawImage(video, 0, 0, w, h);
    return;
  }

  const sw = 28; // makin kecil, makin blur hasilnya
  const sh = Math.max(1, Math.round(sw * (h / w)));

  blurTempCanvas.width = sw;
  blurTempCanvas.height = sh;
  blurTempCtx.drawImage(video, 0, 0, sw, sh);

  targetCtx.imageSmoothingEnabled = true;
  targetCtx.imageSmoothingQuality = "high";
  targetCtx.drawImage(blurTempCanvas, 0, 0, sw, sh, 0, 0, w, h);

}


// ===================
// AUDIO GRAPH (buat ngerekam suara foto.mp3 / hidup_jokowi.mp3)
// ===================
let audioCtx = null;
let destNode = null;

function setupAudioGraph() {

  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  destNode = audioCtx.createMediaStreamDestination();

  const fotoSource = audioCtx.createMediaElementSource(foto);
  fotoSource.connect(destNode);
  fotoSource.connect(audioCtx.destination);

  const jokowiSource = audioCtx.createMediaElementSource(jokowi);
  jokowiSource.connect(destNode);
  jokowiSource.connect(audioCtx.destination);

}

function beep(freq = 880, duration = 0.12, volume = 0.25) {

  if (!audioCtx) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(audioCtx.currentTime + duration);

}


// ===================
// MEDIARECORDER
// ===================

let mediaRecorder = null;
let recordedChunks = [];
let chosenMimeType = "video/webm";

function pickMimeType() {

  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];

  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }

  return "video/webm";

}

function startRecording() {

  recordedChunks = [];
  chosenMimeType = pickMimeType();

  // 30fps buat hasil gerakan yang lebih halus (sebelumnya 24fps demi
  // ringan, tapi sekarang kualitas diprioritaskan)
  const videoStream = recordCanvas.captureStream(30);
  const combinedStream = new MediaStream();

  videoStream.getVideoTracks().forEach((t) => combinedStream.addTrack(t));
  destNode.stream.getAudioTracks().forEach((t) => combinedStream.addTrack(t));

  mediaRecorder = new MediaRecorder(combinedStream, {
    mimeType: chosenMimeType
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = handleRecordingStop;

  mediaRecorder.start();

}

function stopRecording() {

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

}


// ===================
// CONVERT KE MP4 (ffmpeg.wasm) — lazy load, dengan timeout & fallback
// ===================

let ffmpegInstance = null;
let ffmpegLoadingPromise = null;

async function getFFmpeg() {

  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoadingPromise) return ffmpegLoadingPromise;

  ffmpegLoadingPromise = (async () => {

    const { FFmpeg } = await import(
      "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js"
    );
    const { toBlobURL } = await import(
      "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js"
    );

    const instance = new FFmpeg();
    const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";

    instance.on("progress", ({ progress }) => {
      if (processingTextEl && progress >= 0 && progress <= 1) {
        processingTextEl.textContent =
          `Mengonversi video... ${Math.round(progress * 100)}%`;
      }
    });

    await instance.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm")
    });

    ffmpegInstance = instance;
    return instance;

  })();

  return ffmpegLoadingPromise;

}

function withTimeout(promise, ms) {

  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Proses convert kelamaan (timeout)")), ms)
    )
  ]);

}

async function convertToMp4(blob, inputExt) {

  const inst = await getFFmpeg();
  const { fetchFile } = await import(
    "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js"
  );

  const inputName = `input.${inputExt}`;
  const outputName = "output.mp4";

  await inst.writeFile(inputName, await fetchFile(blob));

  // setting CRF & preset dipakai dari activeTier (adaptive sesuai device).
  // GOP dipaksa pendek (keyframe tiap 1 detik / 30 frame) + sc_threshold
  // dimatiin biar x264 GAK nentuin sendiri kapan taro keyframe (default-nya
  // adaptif, bisa jadi cuma 1 keyframe doang di awal kalau scene-nya
  // cenderung statis kayak rekaman wajah diem). Ini akar masalah kenapa
  // TikTok macet di detik ke-1 pas masuk editor: TikTok perlu loncat/seek
  // buat generate thumbnail & preview, dan tanpa keyframe yang sering,
  // dia gak nemu titik aman buat mulai baca ulang -> freeze.
  await inst.exec([
    "-i", inputName,
    "-c:v", "libx264",
    "-preset", activeTier.preset,
    "-crf", activeTier.crf,
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-vsync", "cfr",
    "-g", "30",
    "-keyint_min", "30",
    "-sc_threshold", "0",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-movflags", "+faststart",
    outputName
  ]);

  const data = await inst.readFile(outputName);

  await inst.deleteFile(inputName);
  await inst.deleteFile(outputName);

  return new Blob([data.buffer], { type: "video/mp4" });

}

// HP dengan RAM kecil (<=2GB, terdeteksi di sebagian browser Android)
// rawan ngehang/crash kalau dipaksa transcode ffmpeg.wasm. Kalau
// terdeteksi, langsung kasih file webm tanpa convert, daripada user
// stuck nungguin proses yang gak bakal pernah selesai.
function isLikelyLowEndDevice() {
  return !!(navigator.deviceMemory && navigator.deviceMemory <= 2);
}

async function handleRecordingStop() {

  const rawBlob = new Blob(recordedChunks, {
    type: chosenMimeType.split(";")[0]
  });

  // PENTING: dulu di sini ada shortcut "kalau browser udah native rekam
  // ke mp4 (Safari/iPhone), skip ffmpeg" — niatnya biar cepat. Tapi itu
  // bikin SEMUA fix CFR & keyframe interval gak pernah ke-apply di
  // iPhone, karena hasil rekaman Safari native langsung dipakai apa
  // adanya tanpa diproses ulang. Makanya sekarang SEMUA hasil rekaman,
  // dari device manapun, WAJIB lewat ffmpeg supaya konsisten kompatibel.
  const inputExt = chosenMimeType.includes("mp4") ? "mp4" : "webm";

  if (isLikelyLowEndDevice()) {
    finalizeDownload(rawBlob, inputExt, `${inputExt.toUpperCase()} (device RAM kecil, convert di-skip biar gak crash)`);
    return;
  }

  processingEl.style.display = "flex";
  processingTextEl.textContent = "Menyiapkan alat convert...";

  try {

    const mp4Blob = await withTimeout(convertToMp4(rawBlob, inputExt), activeTier.timeoutMs);
    finalizeDownload(mp4Blob, "mp4", `MP4 — Kualitas ${activeTier.label}`);

  } catch (err) {

    console.error("Gagal convert ke mp4:", err);
    finalizeDownload(rawBlob, inputExt, `${inputExt.toUpperCase()} (convert MP4 gagal/timeout, video tetap disimpan)`);

  } finally {

    processingEl.style.display = "none";

  }

}

function finalizeDownload(blob, ext, noteText) {

  const url = URL.createObjectURL(blob);

  downloadLink.href = url;
  downloadLink.download = `daffapriyantana-${Date.now()}.${ext}`;

  if (resultNote) {
    resultNote.textContent = `Format: ${noteText}`;
  }

  resultBox.style.display = "flex";

}


// ===================
// COUNTDOWN 3..2..1 (visual + beep)
// ===================

function runCountdown(onDone) {

  let count = 3;

  countdownEl.style.display = "flex";
  countdownEl.textContent = count;
  beep(880, 0.12);

  const interval = setInterval(() => {

    count--;

    if (count > 0) {
      countdownEl.textContent = count;
      beep(880, 0.12);
    } else {
      clearInterval(interval);
      countdownEl.style.display = "none";
      beep(1320, 0.18, 0.3);
      onDone();
    }

  }, 1000);

}


// ===================
// START
// ===================

start.onclick = async () => {

  start.style.display = "none";

  setupAudioGraph();
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  runCountdown(() => {

    foto.loop = true;
    foto.currentTime = 0;
    foto.play().catch((err) => {
      console.log("Gagal play foto:", err);
    });

    startRecording();
    stopBtn.style.display = "inline-flex";

  });

};


// ===================
// STOP
// ===================

stopBtn.onclick = () => {

  stopBtn.style.display = "none";

  stopRecording();

  foto.pause();
  jokowi.pause();
  jokowi.currentTime = 0;

};


// ===================
// REKAM ULANG
// ===================

retryBtn.onclick = () => {
  location.reload();
};


// ===================
// INIT HAND LANDMARKER
// ===================

async function initHandLandmarker() {

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  console.log("Memulai inisialisasi HandLandmarker...");

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "CPU"
    },
    runningMode: "VIDEO",
    numHands: 1
  });

  console.log("HandLandmarker siap!");

}


// ===================
// CAMERA
// ===================
// resolusi ideal dinaikkan ke HD (1280x720) buat hasil yang lebih bagus
// di live preview. Resolusi hasil REKAMAN tetap dibatasi terpisah lewat
// MAX_RECORD_SIDE supaya proses convert tetap aman di HP.

navigator.mediaDevices
  .getUserMedia({
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      facingMode: "user"
    }
  })
  .then((stream) => {
    video.srcObject = stream;
    video.addEventListener("loadeddata", onVideoReady);
  })
  .catch((err) => {
    alert("Tidak bisa akses kamera: " + err.message);
  });


async function onVideoReady() {

  if (!handLandmarker) {
    await initHandLandmarker();
  }

  renderLoop();

}


// ===================
// DETEKSI TANGAN
// ===================

function detect(lm) {

  let index = lm[8].y < lm[6].y;
  let middle = lm[12].y < lm[10].y;
  let ring = lm[16].y < lm[14].y;
  let pinky = lm[20].y < lm[18].y;

  if (index && middle && !ring && !pinky) {
    return "V";
  }

  if (!index && !middle && !ring && !pinky) {
    return "FIST";
  }

  return "NORMAL";

}

// stabilisasi gesture (debounce): di HP, deteksi tangan lebih "noisy"
// (gampang flicker antar gesture dalam hitungan frame) dibanding laptop.
// Tanpa ini, audio hidup_jokowi jadi keputus-putus tiap kali deteksi
// sempat salah baca sesaat. Gesture baru dianggap VALID & dipakai cuma
// kalau kedeteksi sama 2x berturut-turut.
let pendingGesture = "NORMAL";
let pendingCount = 0;
const REQUIRED_STABLE_DETECTIONS = 2;

function updateStableGesture(rawGesture) {

  if (rawGesture === pendingGesture) {
    pendingCount++;
  } else {
    pendingGesture = rawGesture;
    pendingCount = 1;
  }

  if (pendingCount >= REQUIRED_STABLE_DETECTIONS) {
    gesture = pendingGesture;
  }

}


// ===================
// WATERMARK (kiri bawah, gaya transparan ala TikTok)
// ===================

function drawWatermark(targetCtx, w, h) {

  const fontSize = Math.max(14, Math.round(Math.min(w, h) * 0.045));

  targetCtx.save();
  targetCtx.font = `italic 600 ${fontSize}px 'Segoe UI', system-ui, -apple-system, sans-serif`;
  targetCtx.textAlign = "left";
  targetCtx.textBaseline = "bottom";

  targetCtx.shadowColor = "rgba(0,0,0,0.45)";
  targetCtx.shadowBlur = 6;
  targetCtx.fillStyle = "rgba(255,255,255,0.55)";

  const x = w * 0.035;
  const y = h - (h * 0.035);

  targetCtx.fillText(WATERMARK_TEXT, x, y);

  targetCtx.shadowBlur = 0;
  targetCtx.restore();

}


// ===================
// LOOP UTAMA
// ===================

function renderLoop() {

  if (!video.videoWidth || !video.videoHeight) {
    requestAnimationFrame(renderLoop);
    return;
  }

  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    textCanvas.width = video.videoWidth;
    textCanvas.height = video.videoHeight;

    const { rw, rh } = computeRecordSize(video.videoWidth, video.videoHeight);
    recordCanvas.width = rw;
    recordCanvas.height = rh;

  }

  frameCount++;

  if (frameCount % 3 === 0 && video.currentTime !== lastVideoTime) {

    lastVideoTime = video.currentTime;

    const t0 = performance.now();
    const result = handLandmarker.detectForVideo(video, performance.now());
    const t1 = performance.now();

    if (t1 - t0 > 200) {
      console.warn("detectForVideo LAMA:", Math.round(t1 - t0), "ms");
    }

    const rawGesture = (result.landmarks && result.landmarks.length > 0)
      ? detect(result.landmarks[0])
      : "NORMAL";

    updateStableGesture(rawGesture);

  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);
  recordCtx.clearRect(0, 0, recordCanvas.width, recordCanvas.height);

  let fontSize = Math.round(Math.min(canvas.width, canvas.height) * 0.08);
  let textY = canvas.height / 2;


  // ===================
  // GAMBAR FRAME (PREVIEW) — blur manual, BUKAN CSS filter lagi
  // ===================

  drawFrame(ctx, canvas.width, canvas.height, gesture === "V");

  if (gesture === "V") {

    textCtx.font = `bold ${fontSize}px Arial`;
    textCtx.fillStyle = "white";
    textCtx.textAlign = "center";
    textCtx.textBaseline = "middle";
    textCtx.shadowColor = "rgba(0,0,0,0.6)";
    textCtx.shadowBlur = 8;
    textCtx.fillText("FOTO KITA BLUR", canvas.width / 2, textY);
    textCtx.shadowBlur = 0;

  }


  // ===================
  // JOKOWI
  // ===================

  if (gesture === "FIST") {

    if (jokowi.paused) {
      jokowi.loop = true;
      jokowi.play().catch((err) => {
        console.log("Gagal play jokowi:", err);
      });
    }

    textCtx.fillStyle = "rgba(255,0,0,0.3)";
    textCtx.fillRect(0, 0, textCanvas.width, textCanvas.height);

    textCtx.font = `bold ${fontSize}px Arial`;
    textCtx.fillStyle = "white";
    textCtx.textAlign = "center";
    textCtx.textBaseline = "middle";
    textCtx.shadowColor = "rgba(0,0,0,0.6)";
    textCtx.shadowBlur = 8;
    textCtx.fillText("pria solo itu lagi", canvas.width / 2, textY);
    textCtx.shadowBlur = 0;

  } else {

    if (!jokowi.paused) {
      jokowi.pause();
      jokowi.currentTime = 0;
    }

  }


  // ===================
  // GAMBAR ULANG KE recordCanvas (buat hasil rekaman) — pakai teknik
  // blur manual yang SAMA biar konsisten sama preview.
  // ===================

  drawFrame(recordCtx, recordCanvas.width, recordCanvas.height, gesture === "V");
  recordCtx.drawImage(textCanvas, 0, 0, recordCanvas.width, recordCanvas.height);
  drawWatermark(recordCtx, recordCanvas.width, recordCanvas.height);

  requestAnimationFrame(renderLoop);

}
