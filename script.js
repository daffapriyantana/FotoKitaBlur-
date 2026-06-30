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

const foto = document.getElementById("foto");
const jokowi = document.getElementById("jokowi");

let gesture = "NORMAL";
let handLandmarker = null;
let lastVideoTime = -1;
let frameCount = 0;


// ===================
// START
// ===================

start.onclick = () => {

  foto.loop = true;
  foto.currentTime = 0;

  foto.play().catch((err) => {
    console.log("Gagal play foto:", err);
  });

  start.style.display = "none";

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

  // ukuran font dihitung dari sisi TERKECIL canvas, biar tetap proporsional
  // baik di layar landscape (laptop) maupun portrait (HP)
  let fontSize = Math.round(Math.min(canvas.width, canvas.height) * 0.08);

  // posisi teks selalu di tengah vertikal — titik ini PASTI selalu
  // kelihatan walau canvas di-crop object-fit:cover di rasio layar manapun
  let textY = canvas.height / 2;


  // ===================
  // EFEK SESUAI GESTURE
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

  requestAnimationFrame(renderLoop);

}
