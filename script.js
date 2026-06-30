import {
  HandLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const start = document.getElementById("start");

const foto = document.getElementById("foto");
const jokowi = document.getElementById("jokowi");

let gesture = "NORMAL";
let handLandmarker = null;
let lastVideoTime = -1;


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

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "CPU" // pakai CPU biar gak crash gara-gara GPU/driver bermasalah
    },
    runningMode: "VIDEO",
    numHands: 1
  });

}


// ===================
// CAMERA
// ===================

navigator.mediaDevices
  .getUserMedia({
    video: true
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

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  // hanya deteksi kalau frame video berganti (hindari proses dobel)
  if (video.currentTime !== lastVideoTime) {

    lastVideoTime = video.currentTime;

    const result = handLandmarker.detectForVideo(video, performance.now());

    if (result.landmarks && result.landmarks.length > 0) {
      gesture = detect(result.landmarks[0]);
    } else {
      gesture = "NORMAL";
    }

  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ukuran font dihitung dari sisi TERKECIL canvas, biar tetap proporsional
  // baik di layar landscape (laptop) maupun portrait (HP)
  let fontSize = Math.round(Math.min(canvas.width, canvas.height) * 0.08);

  // posisi teks selalu di tengah vertikal — titik ini PASTI selalu
  // kelihatan walau canvas di-crop object-fit:cover di rasio layar manapun
  let textY = canvas.height / 2;


  // ===================
  // EFEK SESUAI GESTURE
  // ===================

  if (gesture === "V") {

    ctx.filter = "blur(25px)";
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";

    ctx.font = `bold ${fontSize}px Arial`;
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 12;
    ctx.fillText("FOTO KITA BLUR", canvas.width / 2, textY);
    ctx.shadowBlur = 0;

  } else {

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

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

    ctx.fillStyle = "rgba(255,0,0,0.3)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = `bold ${fontSize}px Arial`;
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 12;
    ctx.fillText("pria solo itu lagi", canvas.width / 2, textY);
    ctx.shadowBlur = 0;

  } else {

    if (!jokowi.paused) {
      jokowi.pause();
      jokowi.currentTime = 0;
    }

  }

  requestAnimationFrame(renderLoop);

}