// ===============================
// Firebase imports
// ===============================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
// ===============================
// Firebase config
// ===============================


// Import the functions you need from the SDKs you need

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBFqVgFam7BFeHM00K3m0EwCkWacPNDux8",
  authDomain: "abinhaic.firebaseapp.com",
  projectId: "abinhaic",
  storageBucket: "abinhaic.firebasestorage.app",
  messagingSenderId: "217553128810",
  appId: "1:217553128810:web:9c2101c16668714502a913",
  measurementId: "G-MVW2ZF2G7C"
};


// ===============================
// Init Firebase
// ===============================
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ===============================
// DOM elements
// ===============================
const consentAge = document.getElementById("consentAge");
const consentDevice = document.getElementById("consentDevice");
const startBtn = document.getElementById("startBtn");
const nextBtnD = document.getElementById("nextBtnD");

const consentDiv = document.getElementById("consent");
const surveyDiv = document.getElementById("survey");
const taskInfo1Div = document.getElementById("taskInfo1");
const taskInfo2Div = document.getElementById("taskInfo2");
const taskDiv = document.getElementById("task");
const thankyouDiv = document.getElementById("thankyou");

function scrollPageToTop() {
  // Defer until after the DOM visibility changes have been applied.
  requestAnimationFrame(() => {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch {
      window.scrollTo(0, 0);
    }
  });
}

// ===============================
// Task canvases: drag/draw/erase + logging
// ===============================
function getParticipantId() {
  const user = auth.currentUser;
  return user ? user.uid : "local_test_user";
}

function createTaskCanvasController({
  canvas,
  zoomInBtn,
  zoomOutBtn,
  dragBtn,
  drawBtn,
  eraserBtn,
  suggestionBtn,
  onSuggestionFirstUse = null
}) {
  const ctx = canvas?.getContext?.("2d") ?? null;
  const baseImg = new Image();
  const suggestionImg = new Image();

  const zoomLog = [];
  const toolLog = [];
  const panLog = [];
  const strokeLog = [];

  const zoomState = {
    mode: null, // "in" | "out" | null
    baseScale: 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0
  };

  const toolState = {
    tool: null // "zoom_in" | "zoom_out" | "drag" | "draw" | "erase" | null
  };

  const overlayCanvas = document.createElement("canvas");
  const overlayCtx = overlayCanvas.getContext("2d");

  let suggestionEnabled = false;
  let suggestionActive = false;
  let suggestionUsedThisTrial = false;
  let abortController = null;
  let dragSession = null;
  let strokeSession = null;
  let currentTrialId = null;
  let currentBaseImageSrc = null;
  let currentSuggestionImageSrc = null;
  let trialStartedAt = null;

  function logZoomEvent(type, payload = {}) {
    zoomLog.push({ t: Date.now(), type, trialId: currentTrialId, ...payload });
  }

  function logToolEvent(type, payload = {}) {
    toolLog.push({ t: Date.now(), type, tool: toolState.tool, trialId: currentTrialId, ...payload });
  }

  function computeToolModeDurationsMs({ startT, endT }) {
    const out = Object.create(null);
    const changes = toolLog
      .filter((e) => e && e.type === "tool_change" && typeof e.t === "number")
      .sort((a, b) => a.t - b.t);
    if (!changes.length) return out;

    for (let i = 0; i < changes.length; i += 1) {
      const cur = changes[i];
      const nextT = i + 1 < changes.length ? changes[i + 1].t : endT;
      const fromT = Math.max(startT, cur.t);
      const toT = Math.min(endT, nextT);
      if (!cur.tool || toT <= fromT) continue;
      out[cur.tool] = (out[cur.tool] || 0) + (toT - fromT);
    }
    return out;
  }

  function computeSuggestionHoldMs({ startT, endT }) {
    let total = 0;
    let lastOn = null;
    const events = toolLog
      .filter(
        (e) =>
          e &&
          (e.type === "ai_suggestion_on" || e.type === "ai_suggestion_off") &&
          typeof e.t === "number"
      )
      .sort((a, b) => a.t - b.t);

    for (const e of events) {
      if (e.type === "ai_suggestion_on") lastOn = e.t;
      if (e.type === "ai_suggestion_off" && lastOn != null) {
        const fromT = Math.max(startT, lastOn);
        const toT = Math.min(endT, e.t);
        if (toT > fromT) total += toT - fromT;
        lastOn = null;
      }
    }

    if (lastOn != null) {
      const fromT = Math.max(startT, lastOn);
      const toT = endT;
      if (toT > fromT) total += toT - fromT;
    }

    return total;
  }

  function computeActionDurationsMs({ startT, endT }) {
    const clampRange = (t) => Math.max(startT, Math.min(endT, t));
    let dragMs = 0;
    for (const p of panLog) {
      const a = clampRange(p?.tStart ?? 0);
      const b = clampRange(p?.tEnd ?? 0);
      if (b > a) dragMs += b - a;
    }

    let drawMs = 0;
    let eraseMs = 0;
    for (const s of strokeLog) {
      const a = clampRange(s?.tStart ?? 0);
      const b = clampRange(s?.tEnd ?? 0);
      if (b <= a) continue;
      if (s?.tool === "erase") eraseMs += b - a;
      else drawMs += b - a;
    }

    return { dragMs, drawMs, eraseMs };
  }

  function getImageDims(img) {
    const iw = img?.naturalWidth || img?.width || 0;
    const ih = img?.naturalHeight || img?.height || 0;
    return { iw, ih };
  }

  function getCurrentImageTransform() {
    const s = zoomState.baseScale * zoomState.scale;
    return { s, offsetX: zoomState.offsetX, offsetY: zoomState.offsetY };
  }

  function clampOffsets() {
    if (!canvas) return;
    if (!baseImg.complete) return;
    const { iw, ih } = getImageDims(baseImg);
    if (!iw || !ih) return;

    const cw = canvas.width;
    const ch = canvas.height;
    const { s } = getCurrentImageTransform();
    const dw = iw * s;
    const dh = ih * s;

    let minX;
    let maxX;
    if (dw <= cw) {
      minX = 0;
      maxX = cw - dw;
    } else {
      minX = cw - dw;
      maxX = 0;
    }

    let minY;
    let maxY;
    if (dh <= ch) {
      minY = 0;
      maxY = ch - dh;
    } else {
      minY = ch - dh;
      maxY = 0;
    }

    zoomState.offsetX = Math.max(minX, Math.min(maxX, zoomState.offsetX));
    zoomState.offsetY = Math.max(minY, Math.min(maxY, zoomState.offsetY));
  }

  function computeBaseFit() {
    if (!canvas || !ctx) return;
    if (!baseImg.complete) return;
    const { iw, ih } = getImageDims(baseImg);
    const cw = canvas.width;
    const ch = canvas.height;
    if (!iw || !ih || !cw || !ch) return;

    const baseScale = Math.min(cw / iw, ch / ih);
    const dw = iw * baseScale;
    const dh = ih * baseScale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    zoomState.baseScale = baseScale;
    zoomState.scale = 1;
    zoomState.offsetX = dx;
    zoomState.offsetY = dy;
    clampOffsets();
  }

  function render() {
    if (!canvas || !ctx) return;
    if (!baseImg.complete) return;
    const { iw, ih } = getImageDims(baseImg);
    const cw = canvas.width;
    const ch = canvas.height;
    if (!iw || !ih || !cw || !ch) return;

    ctx.clearRect(0, 0, cw, ch);
    const s = zoomState.baseScale * zoomState.scale;
    const dw = iw * s;
    const dh = ih * s;

    ctx.drawImage(baseImg, zoomState.offsetX, zoomState.offsetY, dw, dh);

    if (suggestionEnabled && suggestionActive && suggestionImg.complete) {
      ctx.drawImage(suggestionImg, zoomState.offsetX, zoomState.offsetY, dw, dh);
    }

    if (overlayCanvas.width && overlayCanvas.height) {
      ctx.drawImage(overlayCanvas, zoomState.offsetX, zoomState.offsetY, dw, dh);
    }
  }

  function setZoomMode(mode) {
    zoomState.mode = mode;
    logZoomEvent("mode_change", { mode });
  }

  function setActiveTool(tool) {
    toolState.tool = tool;

    if (tool === "zoom_in") setZoomMode("in");
    else if (tool === "zoom_out") setZoomMode("out");
    else setZoomMode(null);

    const buttons = [
      [zoomInBtn, "zoom_in"],
      [zoomOutBtn, "zoom_out"],
      [dragBtn, "drag"],
      [drawBtn, "draw"],
      [eraserBtn, "erase"]
    ];
    for (const [btn, t] of buttons) {
      if (!btn?.classList) continue;
      if (t === tool) btn.classList.add("active-tool");
      else btn.classList.remove("active-tool");
    }

    if (canvas) {
      if (tool === "drag") canvas.style.cursor = "grab";
      else if (tool === "draw") canvas.style.cursor = "crosshair";
      else if (tool === "erase") canvas.style.cursor = "cell";
      else if (tool === "zoom_in") canvas.style.cursor = "zoom-in";
      else if (tool === "zoom_out") canvas.style.cursor = "zoom-out";
      else canvas.style.cursor = "default";
    }

    logToolEvent("tool_change", { tool });
  }

  function canvasPointFromEvent(e) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function imagePointFromCanvasPoint(canvasPt) {
    if (!canvasPt) return null;
    if (!baseImg.complete) return null;
    const { s, offsetX, offsetY } = getCurrentImageTransform();
    if (!s) return null;
    return { x: (canvasPt.x - offsetX) / s, y: (canvasPt.y - offsetY) / s };
  }

  function isImagePointInside(ix, iy) {
    if (!baseImg.complete) return false;
    const { iw, ih } = getImageDims(baseImg);
    return ix >= 0 && iy >= 0 && ix <= iw && iy <= ih;
  }

  function applyZoomAtPoint(factor, point) {
    if (!canvas) return;
    if (!baseImg.complete) return;
    const { iw, ih } = getImageDims(baseImg);
    if (!iw || !ih) return;

    const scaleBefore = zoomState.scale;
    const scaleAfterUnclamped = scaleBefore * factor;
    const minScale = 0.5;
    const maxScale = 6;
    const scaleAfter = Math.max(minScale, Math.min(maxScale, scaleAfterUnclamped));

    const sBefore = zoomState.baseScale * scaleBefore;
    const imgX = (point.x - zoomState.offsetX) / sBefore;
    const imgY = (point.y - zoomState.offsetY) / sBefore;

    const sAfter = zoomState.baseScale * scaleAfter;
    zoomState.scale = scaleAfter;
    zoomState.offsetX = point.x - imgX * sAfter;
    zoomState.offsetY = point.y - imgY * sAfter;
    clampOffsets();

    logZoomEvent("zoom", {
      direction: factor > 1 ? "in" : "out",
      factorRequested: factor,
      x: point.x,
      y: point.y,
      scaleBefore,
      scaleAfter
    });

    render();
  }

  function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  function beginDrag(pointerId, canvasPt) {
    dragSession = {
      pointerId,
      startT: Date.now(),
      startCanvasPt: canvasPt,
      lastCanvasPt: canvasPt,
      startOffsetX: zoomState.offsetX,
      startOffsetY: zoomState.offsetY,
      moves: []
    };
    logToolEvent("drag_start", {
      x: canvasPt.x,
      y: canvasPt.y,
      offsetX: zoomState.offsetX,
      offsetY: zoomState.offsetY,
      scale: zoomState.scale
    });
  }

  function updateDrag(canvasPt) {
    if (!dragSession) return;
    const prev = dragSession.lastCanvasPt;
    const dx = canvasPt.x - prev.x;
    const dy = canvasPt.y - prev.y;

    zoomState.offsetX += dx;
    zoomState.offsetY += dy;
    clampOffsets();
    render();

    dragSession.lastCanvasPt = canvasPt;

    const now = Date.now();
    const lastMove = dragSession.moves[dragSession.moves.length - 1];
    const shouldSample = !lastMove || now - lastMove.t >= 50 || (dx * dx + dy * dy) >= 4;
    if (shouldSample) {
      dragSession.moves.push({
        t: now,
        x: canvasPt.x,
        y: canvasPt.y,
        offsetX: zoomState.offsetX,
        offsetY: zoomState.offsetY
      });
    }
  }

  function endDrag(reason = "up") {
    if (!dragSession) return;
    const endT = Date.now();
    panLog.push({
      tStart: dragSession.startT,
      tEnd: endT,
      reason,
      start: {
        x: dragSession.startCanvasPt.x,
        y: dragSession.startCanvasPt.y,
        offsetX: dragSession.startOffsetX,
        offsetY: dragSession.startOffsetY
      },
      end: {
        x: dragSession.lastCanvasPt.x,
        y: dragSession.lastCanvasPt.y,
        offsetX: zoomState.offsetX,
        offsetY: zoomState.offsetY
      },
      moves: dragSession.moves
    });
    logToolEvent("drag_end", { reason, offsetX: zoomState.offsetX, offsetY: zoomState.offsetY });
    dragSession = null;
  }

  function beginStroke(pointerId, canvasPt, tool) {
    if (!overlayCtx) return false;
    const imgPt = imagePointFromCanvasPoint(canvasPt);
    if (!imgPt) return false;
    if (!isImagePointInside(imgPt.x, imgPt.y)) return false;

    const now = Date.now();
    const width = tool === "erase" ? 15 : 2;
    const alpha = tool === "erase" ? 1 : 0.8;

    strokeSession = {
      pointerId,
      tool,
      startT: now,
      lastT: now,
      lastImgPt: imgPt,
      points: [{ x: imgPt.x, y: imgPt.y, t: now }],
      width,
      alpha
    };

    overlayCtx.save();
    overlayCtx.lineCap = "round";
    overlayCtx.lineJoin = "round";
    overlayCtx.lineWidth = width;
    if (tool === "erase") {
      overlayCtx.globalCompositeOperation = "destination-out";
      overlayCtx.strokeStyle = `rgba(0,0,0,${alpha})`;
    } else {
      overlayCtx.globalCompositeOperation = "source-over";
      overlayCtx.strokeStyle = `rgba(255,0,0,${alpha})`;
    }
    overlayCtx.beginPath();
    overlayCtx.moveTo(imgPt.x, imgPt.y);

    logToolEvent("stroke_start", { tool, x: imgPt.x, y: imgPt.y, width, alpha, scale: zoomState.scale });
    return true;
  }

  function updateStroke(canvasPt) {
    if (!strokeSession) return;
    if (!overlayCtx) return;
    const imgPt = imagePointFromCanvasPoint(canvasPt);
    if (!imgPt) return;
    if (!isImagePointInside(imgPt.x, imgPt.y)) return;

    const now = Date.now();
    const last = strokeSession.lastImgPt;
    const movedEnough = dist2(last, imgPt) >= 0.75 * 0.75;
    const timeEnough = now - strokeSession.lastT >= 10;
    if (!movedEnough && !timeEnough) return;

    if (strokeSession.points.length < 5000) {
      strokeSession.points.push({ x: imgPt.x, y: imgPt.y, t: now });
    }

    overlayCtx.lineTo(imgPt.x, imgPt.y);
    overlayCtx.stroke();
    strokeSession.lastImgPt = imgPt;
    strokeSession.lastT = now;
    render();
  }

  function endStroke(reason = "up") {
    if (!strokeSession) return;
    if (overlayCtx) overlayCtx.restore();
    const endT = Date.now();
    strokeLog.push({
      tool: strokeSession.tool,
      tStart: strokeSession.startT,
      tEnd: endT,
      reason,
      width: strokeSession.width,
      alpha: strokeSession.alpha,
      points: strokeSession.points
    });
    logToolEvent("stroke_end", { tool: strokeSession.tool, reason, points: strokeSession.points.length });
    strokeSession = null;
  }

  function setSuggestionActive(active, reason = "pointer") {
    if (!suggestionEnabled) return;
    if (suggestionActive === active) return;
    suggestionActive = active;
    if (active && !suggestionUsedThisTrial) {
      suggestionUsedThisTrial = true;
      try {
        onSuggestionFirstUse?.({ trialId: currentTrialId });
      } catch (err) {
        console.error("onSuggestionFirstUse failed:", err);
      }
    }
    logToolEvent(active ? "ai_suggestion_on" : "ai_suggestion_off", { reason });
    render();
  }

  function ensureOverlaySized() {
    const { iw, ih } = getImageDims(baseImg);
    if (!iw || !ih) return;
    if (overlayCanvas.width !== iw || overlayCanvas.height !== ih) {
      overlayCanvas.width = iw;
      overlayCanvas.height = ih;
      overlayCtx?.clearRect?.(0, 0, iw, ih);
    }
  }

  function mount() {
    if (!canvas) return;
    abortController?.abort?.();
    abortController = new AbortController();
    const { signal } = abortController;

    canvas.style.touchAction = "none";

    zoomInBtn?.addEventListener("click", () => setActiveTool("zoom_in"), { signal });
    zoomOutBtn?.addEventListener("click", () => setActiveTool("zoom_out"), { signal });
    dragBtn?.addEventListener("click", () => setActiveTool("drag"), { signal });
    drawBtn?.addEventListener("click", () => setActiveTool("draw"), { signal });
    eraserBtn?.addEventListener("click", () => setActiveTool("erase"), { signal });

    canvas.addEventListener(
      "click",
      (e) => {
        if (!zoomState.mode) return;
        if (toolState.tool !== "zoom_in" && toolState.tool !== "zoom_out") return;
        const pt = canvasPointFromEvent(e);
        if (!pt) return;
        if (zoomState.mode === "in") applyZoomAtPoint(1.25, pt);
        if (zoomState.mode === "out") applyZoomAtPoint(0.8, pt);
      },
      { signal }
    );

    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (!baseImg.complete) return;
        if (e.button !== 0) return;
        const canvasPt = canvasPointFromEvent(e);
        if (!canvasPt) return;
        const imgPt = imagePointFromCanvasPoint(canvasPt);
        if (!imgPt || !isImagePointInside(imgPt.x, imgPt.y)) return;

        if (toolState.tool === "drag") {
          beginDrag(e.pointerId, canvasPt);
          canvas.setPointerCapture?.(e.pointerId);
          canvas.style.cursor = "grabbing";
          return;
        }

        if (toolState.tool === "draw" || toolState.tool === "erase") {
          const started = beginStroke(e.pointerId, canvasPt, toolState.tool);
          if (!started) return;
          canvas.setPointerCapture?.(e.pointerId);
        }
      },
      { signal }
    );

    canvas.addEventListener(
      "pointermove",
      (e) => {
        const canvasPt = canvasPointFromEvent(e);
        if (!canvasPt) return;
        if (dragSession && e.pointerId === dragSession.pointerId) {
          updateDrag(canvasPt);
          return;
        }
        if (strokeSession && e.pointerId === strokeSession.pointerId) {
          updateStroke(canvasPt);
        }
      },
      { signal }
    );

    canvas.addEventListener(
      "pointerup",
      (e) => {
        if (dragSession && e.pointerId === dragSession.pointerId) {
          canvas.style.cursor = "grab";
          endDrag("up");
        }
        if (strokeSession && e.pointerId === strokeSession.pointerId) {
          endStroke("up");
        }
      },
      { signal }
    );

    canvas.addEventListener(
      "pointercancel",
      (e) => {
        if (dragSession && e.pointerId === dragSession.pointerId) {
          canvas.style.cursor = "grab";
          endDrag("cancel");
        }
        if (strokeSession && e.pointerId === strokeSession.pointerId) {
          endStroke("cancel");
        }
      },
      { signal }
    );

    const onDown = (e) => {
      if (!suggestionEnabled) return;
      suggestionBtn?.setPointerCapture?.(e.pointerId);
      setSuggestionActive(true, "button_down");
    };
    const onUp = () => setSuggestionActive(false, "button_up");
    const onCancel = () => setSuggestionActive(false, "button_cancel");
    const onLeave = () => setSuggestionActive(false, "button_leave");

    suggestionBtn?.addEventListener("pointerdown", onDown, { signal });
    suggestionBtn?.addEventListener("pointerup", onUp, { signal });
    suggestionBtn?.addEventListener("pointercancel", onCancel, { signal });
    suggestionBtn?.addEventListener("pointerleave", onLeave, { signal });

    setActiveTool("drag");
    logToolEvent("session_mount", {});
  }

  function unmount() {
    abortController?.abort?.();
    abortController = null;
    dragSession = null;
    strokeSession = null;
    suggestionActive = false;
  }

  function getTrialData() {
    const { iw, ih } = getImageDims(baseImg);
    const strokePointsTotal = strokeLog.reduce((sum, s) => sum + (s.points?.length || 0), 0);
    const startT = trialStartedAt || Date.now();
    const endT = Date.now();
    const durationMs = Math.max(0, endT - startT);
    const toolModeMs = computeToolModeDurationsMs({ startT, endT });
    const suggestionHoldMs = computeSuggestionHoldMs({ startT, endT });
    const actionMs = computeActionDurationsMs({ startT, endT });
    return {
      trialId: currentTrialId,
      trialStartedAt,
      trialEndedAt: endT,
      durationMs,
      baseImage: currentBaseImageSrc,
      suggestionImage: currentSuggestionImageSrc,
      suggestionEnabled,
      suggestionUsed: suggestionUsedThisTrial,
      suggestionHoldMs,
      imageDims: { iw, ih },
      zoomLog,
      toolLog,
      panLog,
      strokeLog,
      toolModeMs,
      actionMs,
      drawingSummary: { strokes: strokeLog.length, pointsTotal: strokePointsTotal },
      finalView: {
        baseScale: zoomState.baseScale,
        scale: zoomState.scale,
        offsetX: zoomState.offsetX,
        offsetY: zoomState.offsetY
      }
    };
  }

  function resetLogsAndState() {
    zoomLog.length = 0;
    toolLog.length = 0;
    panLog.length = 0;
    strokeLog.length = 0;

    zoomState.mode = null;
    zoomState.baseScale = 1;
    zoomState.scale = 1;
    zoomState.offsetX = 0;
    zoomState.offsetY = 0;

    toolState.tool = null;
    suggestionActive = false;
    dragSession = null;
    strokeSession = null;

    if (overlayCtx && overlayCanvas.width && overlayCanvas.height) {
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
  }

  function loadImage(img, src) {
    return new Promise((resolve, reject) => {
      if (!src) return reject(new Error("Missing src"));
      const onLoad = () => resolve(true);
      const onErr = () => reject(new Error(`Failed to load image: ${src}`));
      img.addEventListener("load", onLoad, { once: true });
      img.addEventListener("error", onErr, { once: true });
      img.src = src;
      if (img.complete && img.naturalWidth) resolve(true);
    });
  }

  async function startTrial({ trialId, baseImageSrc, suggestionImageSrc = null }) {
    currentTrialId = trialId;
    currentBaseImageSrc = baseImageSrc;
    currentSuggestionImageSrc = suggestionImageSrc;
    suggestionEnabled = !!suggestionImageSrc;
    suggestionUsedThisTrial = false;
    trialStartedAt = Date.now();

    resetLogsAndState();
    logToolEvent("trial_start", { baseImageSrc, suggestionImageSrc });

    await loadImage(baseImg, baseImageSrc);
    ensureOverlaySized();
    computeBaseFit();

    if (suggestionEnabled && suggestionImageSrc) {
      try {
        await loadImage(suggestionImg, suggestionImageSrc);
      } catch {
        // If suggestion fails to load, keep disabled but proceed
        suggestionEnabled = false;
      }
    }

    render();
    setActiveTool("drag");
  }

  // Expose for debugging
  window.taskController = { zoomLog, toolLog, panLog, strokeLog, getTrialData };

  return { mount, unmount, startTrial, getTrialData };
}

const aiSuggestionBtn = document.getElementById("aiSuggestionBtn");
const trialIndexEl = document.getElementById("trialIndex");
const trialTotalEl = document.getElementById("trialTotal");
const nextTaskBtn = document.getElementById("nextTaskBtn");
const dangerPromptEl = document.getElementById("dangerPrompt");

const nextTaskInfo1Btn = document.getElementById("nextTaskInfo1Btn");
const startTaskLoopBtn = document.getElementById("startTaskLoopBtn");

const info1Controller = createTaskCanvasController({
  canvas: document.getElementById("taskCanvasInfo1"),
  zoomInBtn: document.getElementById("zoomInBtnInfo1"),
  zoomOutBtn: document.getElementById("zoomOutBtnInfo1"),
  dragBtn: document.getElementById("dragBtnInfo1"),
  drawBtn: document.getElementById("drawBtnInfo1"),
  eraserBtn: document.getElementById("eraserBtnInfo1"),
  suggestionBtn: null
});

const info2Controller = createTaskCanvasController({
  canvas: document.getElementById("taskCanvasInfo2"),
  zoomInBtn: document.getElementById("zoomInBtnInfo2"),
  zoomOutBtn: document.getElementById("zoomOutBtnInfo2"),
  dragBtn: document.getElementById("dragBtnInfo2"),
  drawBtn: document.getElementById("drawBtnInfo2"),
  eraserBtn: document.getElementById("eraserBtnInfo2"),
  suggestionBtn: document.getElementById("aiSuggestionBtnInfo2")
});

const taskController = createTaskCanvasController({
  canvas: document.getElementById("taskCanvas"),
  zoomInBtn: document.getElementById("zoomInBtn"),
  zoomOutBtn: document.getElementById("zoomOutBtn"),
  dragBtn: document.getElementById("dragBtn"),
  drawBtn: document.getElementById("drawBtn"),
  eraserBtn: document.getElementById("eraserBtn"),
  suggestionBtn: aiSuggestionBtn,
  onSuggestionFirstUse: () => {
    if (!taskLoopState) return;
    taskLoopState.currentTrialAiPressed = true;
    setDangerInputsEnabled(true);
    updateNextEnabled();
  }
});

// ===============================
// Consent logic
// ===============================
function checkConsent() {
  startBtn.disabled = !(consentAge.checked && consentDevice.checked);
}

consentAge.addEventListener("change", checkConsent);
consentDevice.addEventListener("change", checkConsent);

// ===============================
// Start survey
// ===============================
startBtn.addEventListener("click", async () => {
  await signInAnonymously(auth);

  consentDiv.classList.add("hidden");
  surveyDiv.classList.remove("hidden");
  scrollPageToTop();
});

// ===============================
// Submit survey
// ===============================
nextBtnD.addEventListener("click", async () => {
  const q1 = document.getElementById("q1").value.trim();

  const age = document.querySelector('input[name="age"]:checked')?.value;
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  const race = Array.from(
    document.querySelectorAll('input[name="race[]"]:checked')
  ).map(el => el.value);
  const education = document.querySelector('input[name="education"]:checked')?.value;

  const genderOther = document.getElementById("gender_other")?.value.trim();
  const raceOther = document.getElementById("race_other")?.value.trim();

  // Basic required checks
  if (!q1 || !age || !gender || !race || !education) {
    alert("Please answer all demographic and survey questions before continuing.");
    return;
  }
  // if (!q1) return alert("Country missing");
  // if (!age) return alert("Age missing");
  // if (!gender) return alert("Gender missing");
  // if (!race) return alert("Race missing");
  // if (!education) return alert("Education missing");

  // Conditional text validation
  if (gender === "self_describe" && !genderOther) {
    alert("Please specify your gender.");
    return;
  }

  if (race === "other" && !raceOther) {
    alert("Please specify your race or ethnicity.");
    return;
  }

  // ===============================
  // Package all responses into one object
  // ===============================
  const responses = {
    country: q1,
    age,
    gender,
    gender_other: gender === "self_describe" ? genderOther : null,
    race,
    race_other: race === "other" ? raceOther : null,
    education
  };

  // Store globally for later use (e.g., Firebase, next pages)
  window.responses = responses;

  console.log("Responses object:", responses);

  // Firebase user (only required when Firebase is enabled)
  const user = auth.currentUser;
  const participantId = user ? user.uid : "local_test_user";

  // Save response (can be enabled when Firebase is configured)
  await setDoc(doc(db, "responses", participantId), {
    country: q1,
    age,
    gender,
    gender_other: genderOther || null,
    race,
    race_other: raceOther || null,
    education,
    submittedAt: serverTimestamp()
  });

  surveyDiv.classList.add("hidden");
  taskInfo1Div.classList.remove("hidden");
  taskInfo2Div.classList.add("hidden");
  taskDiv.classList.add("hidden");
  scrollPageToTop();

  info1Controller.mount();
  await info1Controller.startTrial({
    trialId: "info_1",
    baseImageSrc: "img/sample.png",
    suggestionImageSrc: null
  });
});

// ===============================
// Info pages
// ===============================
async function persistInfoTrial({ participantId, pageId, controller }) {
  try {
    const interaction = controller.getTrialData();
    await setDoc(
      doc(db, "responses", participantId, "infoTrials", pageId),
      {
        pageId,
        durationMs: interaction?.durationMs ?? null,
        toolModeMs: interaction?.toolModeMs ?? null,
        actionMs: interaction?.actionMs ?? null,
        suggestionHoldMs: interaction?.suggestionHoldMs ?? null,
        interaction,
        submittedAt: serverTimestamp()
      },
      { merge: true }
    );
  } catch (err) {
    console.error("Failed to save info trial:", err);
  }
}

nextTaskInfo1Btn?.addEventListener("click", async () => {
  const participantId = getParticipantId();
  await persistInfoTrial({ participantId, pageId: "info_1", controller: info1Controller });

  info1Controller.unmount();
  taskInfo1Div.classList.add("hidden");

  taskInfo2Div.classList.remove("hidden");
  scrollPageToTop();
  info2Controller.mount();
  await info2Controller.startTrial({
    trialId: "info_2",
    baseImageSrc: "img/sample.png",
    suggestionImageSrc: "img/sample_ai.png"
  });
});

startTaskLoopBtn?.addEventListener("click", async () => {
  const participantId = getParticipantId();
  await persistInfoTrial({ participantId, pageId: "info_2", controller: info2Controller });

  info2Controller.unmount();
  taskInfo2Div.classList.add("hidden");

  taskDiv.classList.remove("hidden");
  scrollPageToTop();
  taskController.mount();
  await startTaskLoop();
});

// ===============================
// Task loop: 24 trials (AI suggestion on every trial)
// ===============================
const PAIR_IDS = Array.from({ length: 24 }, (_, i) => String(i + 1).padStart(3, "0"));
// This version runs *only* AI-suggestion trials (no human-only/baseline trials).
const TASK_TRIALS = PAIR_IDS.map((id) => {
  const bagSrc = `img/bag_${id}.jpg`;
  const aiSrc = `img/ai_${id}.png`;
  return { trialId: `ai_${id}`, pairId: id, condition: "ai", baseImageSrc: bagSrc, suggestionImageSrc: aiSrc };
});

let taskLoopState = null;

function getCheckedDanger() {
  return document.querySelector('input[name="danger"]:checked')?.value ?? null;
}

function setDangerInputsEnabled(enabled) {
  const inputs = document.querySelectorAll('input[name="danger"]');
  for (const input of inputs) input.disabled = !enabled;
}

function clearDangerSelection() {
  const checked = document.querySelector('input[name="danger"]:checked');
  if (checked) checked.checked = false;
}

function updateNextEnabled() {
  if (!nextTaskBtn) return;
  const hasAnswer = !!getCheckedDanger();
  const needsAi = !!taskLoopState?.currentTrialRequiresAiPress;
  const aiOk = !needsAi || !!taskLoopState?.currentTrialAiPressed;
  nextTaskBtn.disabled = !(hasAnswer && aiOk);
}

taskDiv?.addEventListener("change", (e) => {
  const target = e.target;
  if (target && target.name === "danger") {
    if (taskLoopState) taskLoopState.currentAnswerSelectedAt = Date.now();
    updateNextEnabled();
  }
});

async function showTrial(index) {
  const trial = TASK_TRIALS[index];
  if (!trial) return;

  scrollPageToTop();

  if (trialTotalEl) trialTotalEl.textContent = String(TASK_TRIALS.length);
  if (trialIndexEl) trialIndexEl.textContent = String(index + 1);

  const hasSuggestion = !!trial.suggestionImageSrc;
  if (aiSuggestionBtn) aiSuggestionBtn.style.display = hasSuggestion ? "inline-block" : "none";
  if (dangerPromptEl) {
    dangerPromptEl.textContent = hasSuggestion
      ? "After view AI's suggestion, do you think there is a dangerous item?"
      : "Do you think there is a dangerous item?";
  }

  if (taskLoopState) {
    taskLoopState.currentTrialRequiresAiPress = hasSuggestion;
    taskLoopState.currentTrialAiPressed = !hasSuggestion;
  }

  clearDangerSelection();
  if (nextTaskBtn) nextTaskBtn.disabled = true;
  setDangerInputsEnabled(!hasSuggestion);

  await taskController.startTrial(trial);
}

async function persistTrial({ participantId, trial, answer }) {
  const interaction = taskController.getTrialData();
  const trialDoc = {
    trialId: trial.trialId,
    pairId: trial.pairId,
    condition: trial.condition,
    trialIndex: taskLoopState?.index ?? null,
    trialNumber: (taskLoopState?.index ?? 0) + 1,
    totalTrials: TASK_TRIALS.length,
    baseImage: trial.baseImageSrc,
    suggestionImage: trial.suggestionImageSrc,
    answer: { dangerousItem: answer },
    answerSelectedAt: taskLoopState?.currentAnswerSelectedAt ?? null,
    responseTimeMs:
      interaction?.trialStartedAt && (taskLoopState?.currentAnswerSelectedAt ?? null)
        ? Math.max(0, taskLoopState.currentAnswerSelectedAt - interaction.trialStartedAt)
        : null,
    durationMs: interaction?.durationMs ?? null,
    toolModeMs: interaction?.toolModeMs ?? null,
    actionMs: interaction?.actionMs ?? null,
    suggestionHoldMs: interaction?.suggestionHoldMs ?? null,
    suggestionUsed: interaction?.suggestionUsed ?? null,
    interaction,
    submittedAt: serverTimestamp()
  };
  await setDoc(doc(db, "responses", participantId, "taskTrials", trial.trialId), trialDoc, { merge: true });

  // Also update a lightweight progress marker on the participant root doc.
  try {
    await setDoc(
      doc(db, "responses", participantId),
      {
        task: {
          status: "in_progress",
          completed: false,
          completedTrialsCount: trialDoc.trialNumber,
          lastTrialId: trial.trialId,
          lastTrialSubmittedAt: serverTimestamp()
        }
      },
      { merge: true }
    );
  } catch (err) {
    console.error("Failed to update task progress:", err);
  }
}

async function startTaskLoop() {
  const participantId = getParticipantId();
  taskLoopState = {
    participantId,
    startedAt: Date.now(),
    index: 0,
    answers: {},
    currentTrialRequiresAiPress: false,
    currentTrialAiPressed: false,
    currentAnswerSelectedAt: null
  };

  await setDoc(
    doc(db, "responses", participantId),
    {
      task: {
        version: 3,
        status: "in_progress",
        completed: false,
        trialOrder: TASK_TRIALS.map((t) => t.trialId),
        startedAt: taskLoopState.startedAt,
        totalTrials: TASK_TRIALS.length,
        completedTrialsCount: 0
      }
    },
    { merge: true }
  );

  await showTrial(0);
}

nextTaskBtn?.addEventListener("click", async () => {
  if (!taskLoopState) return;
  const answer = getCheckedDanger();
  if (!answer) return;
  if (taskLoopState.currentTrialRequiresAiPress && !taskLoopState.currentTrialAiPressed) return;

  const idx = taskLoopState.index;
  const trial = TASK_TRIALS[idx];
  if (!trial) return;

  nextTaskBtn.disabled = true;

  try {
    await persistTrial({ participantId: taskLoopState.participantId, trial, answer });
    taskLoopState.answers[trial.trialId] = answer;
  } catch (err) {
    console.error("Failed to save trial:", err);
    alert("Saving failed. Please try again.");
    updateNextEnabled();
    return;
  }

  taskLoopState.index += 1;
  if (taskLoopState.index < TASK_TRIALS.length) {
    await showTrial(taskLoopState.index);
    return;
  }

  try {
    const completedAtClient = Date.now();
    await setDoc(
      doc(db, "responses", taskLoopState.participantId),
      {
        task: {
          status: "completed",
          completed: true,
          completedAt: serverTimestamp(),
          completedAtClient,
          totalDurationMs: Math.max(0, completedAtClient - taskLoopState.startedAt),
          answers: taskLoopState.answers,
          completedTrialsCount: TASK_TRIALS.length
        },
        taskSubmittedAt: serverTimestamp()
      },
      { merge: true }
    );
  } catch (err) {
    console.error("Failed to save task summary:", err);
  }

  taskController.unmount();
  taskDiv.classList.add("hidden");
  thankyouDiv.classList.remove("hidden");
  scrollPageToTop();
});
