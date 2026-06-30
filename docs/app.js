// App Configuration and State
const videoElement = document.getElementsByClassName('input_video')[0];
const canvasElement = document.getElementsByClassName('output_canvas')[0];
const canvasCtx = canvasElement.getContext('2d');

const overlay = document.getElementById('calibration-overlay');
const progressFill = document.getElementById('calibration-progress');
const progressText = document.getElementById('calibration-text');
const hudOverlay = document.getElementById('hud-overlay');
const currentMemeText = document.getElementById('current-meme-text');
const handsInfo = document.getElementById('hands-info');
const detectedMemeImg = document.getElementById('detected-meme');
const noMemeText = document.getElementById('no-meme-text');

// In Github Pages, if serving from docs folder, images must be inside docs folder too.
const getMemePath = (filename) => `./${filename}`;

// Utilities
function dist(a, b) {
    const z1 = a.z || 0;
    const z2 = b.z || 0;
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(z1 - z2, 2));
}

function esc(lm) {
    return dist(lm[152], lm[10]) + 1e-6;
}

function px(pt, W, H) {
    return { x: pt.x * W, y: pt.y * H };
}

function dedosEstado(lm, izq = false) {
    const tip = [8, 12, 16, 20];
    const mid_j = [6, 10, 14, 18];
    const out = [];
    if (izq) {
        out.push(lm[4].x > lm[3].x ? 1 : 0);
    } else {
        out.push(lm[4].x < lm[3].x ? 1 : 0);
    }
    for (let i = 0; i < tip.length; i++) {
        out.push(lm[tip[i]].y < lm[mid_j[i]].y ? 1 : 0);
    }
    return out;
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[half];
    return (sorted[half - 1] + sorted[half]) / 2.0;
}

function std(values) {
    if (values.length === 0) return 0;
    const m = values.reduce((a, b) => a + b) / values.length;
    const variance = values.reduce((a, b) => a + Math.pow(b - m, 2), 0) / values.length;
    return Math.sqrt(variance);
}

// Calibration Class
class Cal {
    constructor() {
        this.N = 45;
        this.buf = { ci: [], cd: [], cen: [], lap: [], llb: [], bi_y: [], bd_y: [], gap: [] };
        this.done = false;
        this.thr = {
            ci: 0.180, cd: 0.180, cen_lo: 0.185,
            lap: 0.055, llb: 0.145,
            bi_y_lo: 0.30, bd_y_lo: 0.30,
            gap_lo: 0.10
        };
    }

    feed(lm) {
        if (this.done) return;
        const e = esc(lm);
        this.buf.ci.push(dist(lm[52], lm[159]) / e);
        this.buf.cd.push(dist(lm[282], lm[386]) / e);
        this.buf.cen.push(dist(lm[55], lm[285]) / e);
        this.buf.lap.push(dist(lm[13], lm[14]) / e);
        this.buf.llb.push(dist(lm[17], lm[152]) / e);
        this.buf.bi_y.push(lm[55].y - lm[9].y);
        this.buf.bd_y.push(lm[285].y - lm[9].y);
        this.buf.gap.push(Math.abs(lm[55].x - lm[285].x));
        
        if (this.buf.ci.length >= this.N) {
            this._calc();
        }
    }

    _calc() {
        const m = (k) => median(this.buf[k]);
        const s = (k) => std(this.buf[k]);
        const mg_c = (k) => Math.max(1.5 * s(k), 0.015);
        const mg_b = (k, mn) => Math.max(3 * s(k), mn);

        this.thr.ci = m('ci') + mg_c('ci');
        this.thr.cd = m('cd') + mg_c('cd');
        this.thr.cen_lo = m('cen') - mg_c('cen');
        this.thr.lap = m('lap') + mg_b('lap', 0.032);
        this.thr.llb = m('llb') - mg_b('llb', 0.018);
        this.thr.bi_y_lo = m('bi_y') + mg_c('bi_y');
        this.thr.bd_y_lo = m('bd_y') + mg_c('bd_y');
        this.thr.gap_lo = m('gap') - mg_c('gap');
        
        this.done = true;
    }

    get progress() {
        return Math.min(this.buf.ci.length / this.N, 1.0);
    }
}

// Detection logic
function det_lengua(lm, cal) {
    const e = esc(lm);
    const boca_abierta = dist(lm[13], lm[14]) / e > cal.thr.lap;
    const lengua_baja = dist(lm[17], lm[152]) / e < cal.thr.llb;
    const punta_fuera = lm[17].y > lm[14].y + 0.012;
    return boca_abierta && lengua_baja && punta_fuera;
}

function det_ceja(lm, cal) {
    const e = esc(lm);
    const ci = dist(lm[52], lm[159]) / e;
    const cd = dist(lm[282], lm[386]) / e;
    const cen = dist(lm[55], lm[285]) / e;
    const bi_y = lm[55].y - lm[9].y;
    const bd_y = lm[285].y - lm[9].y;
    const gap = Math.abs(lm[55].x - lm[285].x);
    
    return (ci > cal.thr.ci || cd > cal.thr.cd || cen < cal.thr.cen_lo || 
            bi_y > cal.thr.bi_y_lo || bd_y > cal.thr.bd_y_lo || gap < cal.thr.gap_lo);
}

function det_cristiano(manos, lm_cara) {
    const boca = lm_cara[13];
    for (const mano of manos) {
        const lm = mano.lm;
        if (dist(lm[8], boca) < 0.09 || dist(lm[12], boca) < 0.09) {
            return true;
        }
    }
    return false;
}

function det_rata(ded) {
    return ded.join(',') === "0,1,1,0,0";
}

function det_sonic(manos, lm_cara) {
    if (manos.length !== 2) return false;
    const nariz_y = lm_cara[1].y;
    return manos.every(mano => mano.lm[9].y < nariz_y);
}

function det_cara(manos) {
    if (manos.length !== 2) return false;
    for (const mano of manos) {
        const ded = mano.ded;
        const lm = mano.lm;
        if (ded.slice(1).join(',') !== "1,1,1,1" || lm[0].y < 0.50) {
            return false;
        }
    }
    return Math.abs(manos[0].lm[0].x - manos[1].lm[0].x) >= 0.20;
}

// Drawing logic (Python translation)
const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109,10];
const EYE_L = [33,246,161,160,159,158,157,173,133,155,154,153,145,144,163,7,33];
const EYE_R = [362,398,384,385,386,387,388,466,263,249,390,373,374,380,381,382,362];
const BROW_L = [70,63,105,66,107,55,65,52,53,46];
const BROW_R = [300,293,334,296,336,285,295,282,283,276];
const LIPS_OUT = [61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185,61];
const LIPS_IN = [78,95,88,178,87,14,317,402,318,324,308,415,310,311,312,13,82,81,80,191,78];
const NOSE = [168,6,197,195,5,4,1,19,94,2];

function drawFaceMinimal(ctx, lm, W, H, cal) {
    const e = esc(lm);
    const ci = dist(lm[52], lm[159]) / e;
    const cd = dist(lm[282], lm[386]) / e;
    const cen = dist(lm[55], lm[285]) / e;
    const boca_act = (dist(lm[13], lm[14]) / e > cal.thr.lap && dist(lm[17], lm[152]) / e < cal.thr.llb);
    const ceja_act = ci > cal.thr.ci || cd > cal.thr.cd || cen < cal.thr.cen_lo;

    const COL_BASE = 'rgb(140, 200, 140)';
    const COL_ACT = 'rgb(80, 240, 80)';
    const COL_CEJA = ceja_act ? COL_ACT : COL_BASE;
    const COL_BOCA = boca_act ? COL_ACT : COL_BASE;

    function drawPath(indices, col) {
        ctx.beginPath();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        for (let j = 0; j < indices.length; j++) {
            const pt = px(lm[indices[j]], W, H);
            if (j === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
        
        ctx.fillStyle = col;
        for (let j = 0; j < indices.length; j++) {
            const pt = px(lm[indices[j]], W, H);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 1, 0, 2 * Math.PI);
            ctx.fill();
        }
    }

    drawPath(FACE_OVAL, COL_BASE);
    drawPath(EYE_L, COL_BASE);
    drawPath(EYE_R, COL_BASE);
    drawPath(BROW_L, COL_CEJA);
    drawPath(BROW_R, COL_CEJA);
    drawPath(NOSE, COL_BASE);
    drawPath(LIPS_OUT, COL_BOCA);
    drawPath(LIPS_IN, COL_BOCA);
}

// Global State
let cal = new Cal();
let lastFaceLandmarks = null;
let lastHandsLandmarks = [];
let img_actual = null;
const buf = [];
const MINVOTOS = 6;

// MediaPipe Initialization
const faceMesh = new FaceMesh({locateFile: (file) => {
  return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
}});
faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7
});
faceMesh.onResults((results) => {
    lastFaceLandmarks = results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0 ? results.multiFaceLandmarks[0] : null;
});

const hands = new Hands({locateFile: (file) => {
  return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
}});
hands.setOptions({
  maxNumHands: 2,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7
});
hands.onResults((results) => {
    lastHandsLandmarks = [];
    if (results.multiHandLandmarks) {
        for (let i = 0; i < results.multiHandLandmarks.length; i++) {
            const lm = results.multiHandLandmarks[i];
            const classification = results.multiHandedness[i];
            const label = classification.label || (classification[0] && classification[0].label) || "Left";
            const isLeft = label === "Right"; // MediaPipe selfies invert
            const ded = dedosEstado(lm, isLeft);
            lastHandsLandmarks.push({ lm, ded, isLeft });
        }
    }
});

// Main Frame Processing Loop
async function processFrame() {
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // Draw mirrored video
    canvasCtx.translate(canvasElement.width, 0);
    canvasCtx.scale(-1, 1);
    canvasCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
    
    // Send to MediaPipe synchronously inside the frame loop
    await faceMesh.send({image: videoElement});
    await hands.send({image: videoElement});

    if (!cal.done) {
        // Calibration Mode
        const pct = cal.progress;
        progressFill.style.width = `${Math.floor(pct * 100)}%`;
        progressText.innerText = `${Math.floor(pct * 100)}%`;
        
        if (lastFaceLandmarks) {
            cal.feed(lastFaceLandmarks);
        }
    } else {
        // Active Mode
        overlay.style.display = 'none';
        hudOverlay.style.display = 'block';
        
        let det = null;
        
        if (lastFaceLandmarks) {
            drawFaceMinimal(canvasCtx, lastFaceLandmarks, canvasElement.width, canvasElement.height, cal);
        }
        
        if (lastHandsLandmarks.length > 0) {
            let handsText = '';
            lastHandsLandmarks.forEach((mano) => {
                // To avoid needing HAND_CONNECTIONS which might be undefined globally, draw dots:
                canvasCtx.fillStyle = '#FF0000';
                for(let pt of mano.lm) {
                    const p = px(pt, canvasElement.width, canvasElement.height);
                    canvasCtx.beginPath();
                    canvasCtx.arc(p.x, p.y, 3, 0, 2*Math.PI);
                    canvasCtx.fill();
                }
                handsText += `<p>${mano.isLeft ? 'I' : 'D'}: [${mano.ded.join(',')}]</p>`;
            });
            handsInfo.innerHTML = handsText;
        } else {
            handsInfo.innerHTML = '';
        }

        // Detection
        if (lastFaceLandmarks && lastHandsLandmarks.length === 2 && det_sonic(lastHandsLandmarks, lastFaceLandmarks)) {
            det = "Sonic.jpeg";
        } else if (lastHandsLandmarks.length === 2 && det_cara(lastHandsLandmarks)) {
            det = "cara.jpeg";
        } else if (lastFaceLandmarks && lastHandsLandmarks.length > 0 && det_cristiano(lastHandsLandmarks, lastFaceLandmarks)) {
            det = "cristiano.png";
        } else if (lastFaceLandmarks && det_lengua(lastFaceLandmarks, cal)) {
            det = "gato1.png";
        } else if (lastFaceLandmarks && det_ceja(lastFaceLandmarks, cal)) {
            det = "perro.jpeg";
        } else if (lastHandsLandmarks.length === 1 && det_rata(lastHandsLandmarks[0].ded)) {
            det = "rata.jpeg";
        }

        // Voting mechanism
        buf.push(det);
        if (buf.length > 10) buf.shift();

        const counts = {};
        let maxCount = 0;
        let topMeme = null;
        
        for (const item of buf) {
            counts[item] = (counts[item] || 0) + 1;
            if (counts[item] > maxCount) {
                maxCount = counts[item];
                topMeme = item;
            }
        }

        if (maxCount >= MINVOTOS) {
            img_actual = topMeme;
        }

        // Update UI
        if (img_actual) {
            currentMemeText.innerText = img_actual;
            currentMemeText.style.color = '#10b981';
            detectedMemeImg.src = getMemePath(img_actual);
            detectedMemeImg.style.display = 'block';
            noMemeText.style.display = 'none';
        } else {
            currentMemeText.innerText = "neutral";
            currentMemeText.style.color = '#9ca3af';
            detectedMemeImg.style.display = 'none';
            noMemeText.style.display = 'block';
            noMemeText.innerText = det ? `Mendeteksi... (${maxCount}/${MINVOTOS})` : "Menunggu Gestur...";
        }
    }
    
    // Undo mirroring
    canvasCtx.restore();
}

// Start Camera using MediaPipe Camera utility
const camera = new Camera(videoElement, {
  onFrame: async () => {
    try {
        await processFrame();
    } catch(e) {
        progressText.innerText = "Error: " + e.message;
        console.error(e);
    }
  },
  width: 640,
  height: 480
});

camera.start();
