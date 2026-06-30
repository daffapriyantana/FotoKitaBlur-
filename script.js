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
const resultBox = document.getElementById("resultBox");
const downloadLink = document.getElementById("downloadLink");
const retryBtn = document.getElementById("retry");

const foto = document.getElementById("foto");
const jokowi = document.getElementById("jokowi");

let gesture = "NORMAL";
let handLandmarker = null;
let lastVideoTime = -1;
let frameCount = 0;

const WATERMARK_TEXT = "@daffapriyantana";


// ===================
// CANVAS KHUSUS REKAM
// ===================
// Canvas ini TIDAK ditampilkan ke user (gak ditaruh ke DOM), cuma dipakai
// sebagai sumber video untuk MediaRecorder. Kenapa harus terpisah dari
// canvas tampilan? Karena blur di canvas tampilan pakai CSS filter
// (style.filter), dan CSS filter TIDAK ikut kebawa kalau kita
// captureStream() dari canvas itu. Jadi semua efek (video, blur, teks
// gesture, watermark) digambar ULANG secara manual di sini tiap frame
// pakai ctx.filter & drawImage biasa, supaya ikut kerekam di video hasil.
const recordCanvas = document.createElement("canvas");
const recordCtx = recordCanvas.getContext("2d");


// ===================
// AUDIO GRAPH (buat ngerekam suara foto.mp3 / hidup_jokowi.mp3)
// ===================
// createMediaElementSource cuma boleh dipanggil SEKALI per elemen audio
// seumur hidup elemen itu, makanya di-guard pakai audioCtx (null check)
// supaya gak ke-trigger dua kali kalau user klik start lagi.
let audioCtx = null;
let destNode = null;

function setupAudioGraph() {

  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  destNode = audioCtx.createMediaStreamDestination();

  const fotoSource = audioCtx.createMediaElementSource(foto);
  fotoSource.connect(destNode);
  fotoSource.connect(audioCtx.destination); // tetap kedengeran di speaker

  const jokowiSource = audioCtx.createMediaElementSource(jokowi);
  jokowiSource.connect(destNode);
  jokowiSource.connect(audioCtx.destination);

}


// ===================
// BEEP COUNTDOWN (ala TikTok) — disintesis pakai oscillator, BUKAN file
// audio. Sengaja cuma disambung ke audioCtx.destination (speaker), TIDAK
// disambung ke destNode, supaya bunyi "tik" countdown ini gak ikut
// kerekam di video (logis, soalnya recording baru mulai SETELAH
// countdown selesai).
// ===================

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

  // diutamakan video/mp4 dulu (cuma kebaca true di Safari versi baru) —
  // kalau browser bisa langsung rekam ke mp4, kita SKIP proses convert
  // ffmpeg.wasm yang berat di akhir, biar lebih cepat & hemat baterai.
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
// CONVERT KE MP4 (ffmpeg.wasm) — dimuat LAZY (cuma di-download pas
// dibutuhkan, gak dibebanin ke semua orang), supaya browser yang udah
// bisa rekam mp4 native (Safari) gak perlu download wasm ~25-30MB ini
// sama sekali.
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

    await instance.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm")
    });

    ffmpegInstance = instance;
    return instance;

  })();

  return ffmpegLoadingPromise;

}

async function convertToMp4(blob) {

  const inst = await getFFmpeg();
  const { fetchFile } = await import(
    "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js"
  );

  const inputName = "input.webm";
  const outputName = "output.mp4";

  await inst.writeFile(inputName, await fetchFile(blob));

  // preset ultrafast: ffmpeg.wasm jalan single-thread di browser,
  // ultrafast dipilih biar proses convert gak lama-lama amat di HP.
  // yuv420p wajib biar mp4-nya playable di semua device (termasuk
  // QuickTime/iOS yang rewel soal pixel format).
  await inst.exec([
    "-i", inputName,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    outputName
  ]);

  const data = await inst.readFile(outputName);

  await inst.deleteFile(inputName);
  await inst.deleteFile(outputName);

  return new Blob([data.buffer], { type: "video/mp4" });

}

async function handleRecordingStop() {

  const rawBlob = new Blob(recordedChunks, {
    type: chosenMimeType.split(";")[0]
  });

  // udah mp4 dari sononya (Safari) -> langsung pakai, gak perlu convert
  if (chosenMimeType.startsWith("video/mp4")) {
    finalizeDownload(rawBlob, "mp4");
    return;
  }

  processingEl.style.display = "flex";

  try {

    const mp4Blob = await convertToMp4(rawBlob);
    finalizeDownload(mp4Blob, "mp4");

  } catch (err) {

    console.error("Gagal convert ke mp4:", err);
    // fallback: tetap kasih file aslinya (webm) biar user tetap dapet
    // hasil rekamannya walau gagal convert (mis. koneksi internet putus
    // pas download ffmpeg core)
    finalizeDownload(rawBlob, "webm");

  } finally {

    processingEl.style.display = "none";

  }

}

function finalizeDownload(blob, ext) {

  const url = URL.createObjectURL(blob);

  downloadLink.href = url;
  downloadLink.download = `daffapriyantana-${Date.now()}.${ext}`;

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
      beep(1320, 0.18, 0.3); // nada lebih tinggi pas mulai rekam
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

  // SEMENTARA dipaksa CPU dulu buat debugging Safari — GPU mungkin yang
  // nyangkut diam-diam (gak nge-throw error) di iOS, jadi fallback
  // try/catch kita gak pernah ke-trigger walau sebenarnya bermasalah
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

navigator.mediaDevices
  .getUserMedia({
    video: {
      width: { ideal: 480 },
      height: { ideal: 360 },
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


// ===================
// WATERMARK (kiri bawah, gaya transparan ala TikTok)
// ===================

function drawWatermark(targetCtx, w, h) {

  const fontSize = Math.max(14, Math.round(Math.min(w, h) * 0.045));

  targetCtx.save();
  targetCtx.font = `italic 600 ${fontSize}px 'Segoe UI', system-ui, -apple-system, sans-serif`;
  targetCtx.textAlign = "left";
  targetCtx.textBaseline = "bottom";

  // shadow tipis biar tetap kebaca di background apapun, tapi badan
  // teksnya sendiri tetap setengah transparan (efek ala watermark TikTok)
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

  // hanya resize canvas kalau ukurannya BENERAN berubah — nge-set
  // canvas.width/height tiap frame walau nilainya sama tetap memicu
  // realloc buffer penuh di Safari, ini penyumbang lag yang besar
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    textCanvas.width = video.videoWidth;
    textCanvas.height = video.videoHeight;
    recordCanvas.width = video.videoWidth;
    recordCanvas.height = video.videoHeight;
  }

  frameCount++;

  // deteksi tangan tiap 3 frame aja (bukan tiap frame) biar gak berat
  // di Safari/HP yang CPU-nya lebih lemah — video tetap smooth tiap frame
  if (frameCount % 3 === 0 && video.currentTime !== lastVideoTime) {

    lastVideoTime = video.currentTime;

    const t0 = performance.now();
    const result = handLandmarker.detectForVideo(video, performance.now());
    const t1 = performance.now();

    if (t1 - t0 > 200) {
      console.warn("detectForVideo LAMA:", Math.round(t1 - t0), "ms");
    }

    if (result.landmarks && result.landmarks.length > 0) {
      gesture = detect(result.landmarks[0]);
    } else {
      gesture = "NORMAL";
    }

  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);
  recordCtx.clearRect(0, 0, recordCanvas.width, recordCanvas.height);

  // ukuran font dihitung dari sisi TERKECIL canvas, biar tetap proporsional
  // baik di layar landscape (laptop) maupun portrait (HP)
  let fontSize = Math.round(Math.min(canvas.width, canvas.height) * 0.08);

  // posisi teks selalu di tengah vertikal — titik ini PASTI selalu
  // kelihatan walau canvas di-crop object-fit:cover di rasio layar manapun
  let textY = canvas.height / 2;


  // ===================
  // EFEK SESUAI GESTURE (TAMPILAN / PREVIEW)
  // ===================
  // CATATAN: blur pakai CSS filter di elemen <canvas>, BUKAN ctx.filter.
  // ctx.filter="blur()" tidak reliable di Safari/WebKit (sering gak
  // ke-apply walau teksnya tetap muncul). CSS filter jauh lebih konsisten
  // didukung lintas browser, termasuk Safari & in-app browser di iPhone.

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  if (gesture === "V") {

    canvas.style.filter = "blur(18px)";

    textCtx.font = `bold ${fontSize}px Arial`;
    textCtx.fillStyle = "white";
    textCtx.textAlign = "center";
    textCtx.textBaseline = "middle";
    textCtx.shadowColor = "rgba(0,0,0,0.6)";
    textCtx.shadowBlur = 8;
    textCtx.fillText("FOTO KITA BLUR", canvas.width / 2, textY);
    textCtx.shadowBlur = 0;

  } else {

    canvas.style.filter = "none";

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
  // GAMBAR ULANG KE recordCanvas (buat hasil rekaman)
  // ===================
  // Urutan: video (+blur manual kalau gesture V) -> overlay teks/efek
  // gesture (disalin dari textCanvas) -> watermark paling atas, supaya
  // watermark selalu kebaca dan gak ketutup efek apapun.

  recordCtx.filter = (gesture === "V") ? "blur(18px)" : "none";
  recordCtx.drawImage(video, 0, 0, recordCanvas.width, recordCanvas.height);
  recordCtx.filter = "none";

  recordCtx.drawImage(textCanvas, 0, 0, recordCanvas.width, recordCanvas.height);

  drawWatermark(recordCtx, recordCanvas.width, recordCanvas.height);

  requestAnimationFrame(renderLoop);

}
