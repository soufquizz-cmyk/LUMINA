/**
 * Square crop step for package cover uploads (pan + zoom, then JPEG export).
 */

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const VIEW_CSS = 300;
const EXPORT_MAX = 960;
const JPEG_QUALITY_START = 0.9;

const elDialog = document.getElementById("dialog-cover-square-crop") as HTMLDialogElement | null;
const elCanvas = document.getElementById("crop-sq-canvas") as HTMLCanvasElement | null;
const elViewport = document.getElementById("crop-sq-viewport") as HTMLDivElement | null;
const elZoom = document.getElementById("crop-sq-zoom") as HTMLInputElement | null;
const elCancel = document.getElementById("crop-sq-cancel") as HTMLButtonElement | null;
const elApply = document.getElementById("crop-sq-apply") as HTMLButtonElement | null;
const elErr = document.getElementById("crop-sq-err") as HTMLParagraphElement | null;

type Source = ImageBitmap | HTMLImageElement;

let finish: ((file: File | null) => void) | null = null;
let source: Source | null = null;
let revokeObjectUrl: string | null = null;
let pendingSourceFileName = "cover.jpg";
/** Bumped when a new crop session supersedes or closes; stale async loads ignore results. */
let cropGeneration = 0;

function discardStale(s: Source): void {
  if ("close" in s && typeof (s as ImageBitmap).close === "function") {
    try {
      (s as ImageBitmap).close();
    } catch {
      /* ignore */
    }
    return;
  }
  if (s instanceof HTMLImageElement && s.src.startsWith("blob:")) {
    URL.revokeObjectURL(s.src);
    if (revokeObjectUrl === s.src) revokeObjectUrl = null;
  }
}
let iw = 0;
let ih = 0;
let px = 0;
let py = 0;
let zoom = 1;
let drag: { sx: number; sy: number; spx: number; spy: number } | null = null;

function baseScale(): number {
  return Math.max(VIEW_CSS / iw, VIEW_CSS / ih);
}

function scale(): number {
  return baseScale() * zoom;
}

function imgW(): number {
  return iw * scale();
}

function imgH(): number {
  return ih * scale();
}

function clampPan(): void {
  const W = imgW();
  const H = imgH();
  px = Math.min(0, Math.max(VIEW_CSS - W, px));
  py = Math.min(0, Math.max(VIEW_CSS - H, py));
}

function centerImage(): void {
  px = (VIEW_CSS - imgW()) / 2;
  py = (VIEW_CSS - imgH()) / 2;
  clampPan();
}

function setZoomClamped(z: number, anchorScreenX: number, anchorScreenY: number): void {
  const oldS = scale();
  const oldPx = px;
  const oldPy = py;
  const nz = Math.max(1, Math.min(3, z));
  zoom = nz;
  const newS = scale();
  if (oldS === newS) {
    clampPan();
    return;
  }
  const fx = (anchorScreenX - oldPx) / (iw * oldS);
  const fy = (anchorScreenY - oldPy) / (ih * oldS);
  px = anchorScreenX - fx * iw * newS;
  py = anchorScreenY - fy * ih * newS;
  clampPan();
}

async function loadSource(file: File): Promise<Source> {
  try {
    return await createImageBitmap(file);
  } catch {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const u = URL.createObjectURL(file);
      revokeObjectUrl = u;
      img.onload = () => resolve(img);
      img.onerror = () => {
        URL.revokeObjectURL(u);
        revokeObjectUrl = null;
        reject(new Error("decode"));
      };
      img.src = u;
    });
  }
}

function cleanupSource(): void {
  if (source && "close" in source && typeof (source as ImageBitmap).close === "function") {
    try {
      (source as ImageBitmap).close();
    } catch {
      /* ignore */
    }
  }
  if (revokeObjectUrl) {
    URL.revokeObjectURL(revokeObjectUrl);
    revokeObjectUrl = null;
  }
  source = null;
}

function readCanvasScale(): number {
  const w = elCanvas?.getBoundingClientRect().width ?? VIEW_CSS;
  return VIEW_CSS / Math.max(w, 1);
}

function render(): void {
  if (!elCanvas || !source) return;
  const ctx = elCanvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  elCanvas.width = Math.round(VIEW_CSS * dpr);
  elCanvas.height = Math.round(VIEW_CSS * dpr);
  elCanvas.style.width = "100%";
  elCanvas.style.height = "100%";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#08060f";
  ctx.fillRect(0, 0, VIEW_CSS, VIEW_CSS);
  ctx.drawImage(source, px, py, imgW(), imgH());
  ctx.strokeStyle = "rgba(255,255,255,0.38)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, VIEW_CSS - 2, VIEW_CSS - 2);
}

function cropLengthInSource(): number {
  return VIEW_CSS / scale();
}

function cropOriginInSource(): { x: number; y: number } {
  const W = imgW();
  const H = imgH();
  const L = cropLengthInSource();
  let ix = ((0 - px) / W) * iw;
  let iy = ((0 - py) / H) * ih;
  ix = Math.max(0, Math.min(iw - L, ix));
  iy = Math.max(0, Math.min(ih - L, iy));
  return { x: ix, y: iy };
}

async function exportCroppedJpeg(originalName: string): Promise<File> {
  if (!source) throw new Error("no source");
  const L = cropLengthInSource();
  const { x: ix, y: iy } = cropOriginInSource();
  let outSize = Math.min(EXPORT_MAX, Math.max(2, Math.round(L)));
  let q = JPEG_QUALITY_START;
  const oc = document.createElement("canvas");
  const octx = oc.getContext("2d");
  if (!octx) throw new Error("ctx");
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < 28; attempt++) {
    oc.width = outSize;
    oc.height = outSize;
    octx.drawImage(source, ix, iy, L, L, 0, 0, outSize, outSize);
    blob = await new Promise<Blob | null>((r) => oc.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= MAX_UPLOAD_BYTES) break;
    if (q > 0.48) q -= 0.06;
    else {
      outSize = Math.max(240, Math.round(outSize * 0.86));
      q = Math.min(q + 0.05, JPEG_QUALITY_START);
    }
  }
  if (!blob || blob.size > MAX_UPLOAD_BYTES) throw new Error("too large");
  const stem = originalName.replace(/\.[^.]+$/, "") || "cover";
  return new File([blob], `${stem}-carre.jpg`, { type: "image/jpeg" });
}

function closeSession(result: File | null): void {
  cropGeneration++;
  const r = finish;
  finish = null;
  cleanupSource();
  drag = null;
  elDialog?.close();
  elErr && (elErr.textContent = "");
  if (r) r(result);
}

function onPointerDown(e: PointerEvent): void {
  if (!elViewport) return;
  drag = { sx: e.clientX, sy: e.clientY, spx: px, spy: py };
  elViewport.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return;
  const sc = readCanvasScale();
  px = drag.spx + (e.clientX - drag.sx) * sc;
  py = drag.spy + (e.clientY - drag.sy) * sc;
  clampPan();
  render();
}

function onPointerUp(e: PointerEvent): void {
  if (elViewport?.hasPointerCapture(e.pointerId)) {
    elViewport.releasePointerCapture(e.pointerId);
  }
  drag = null;
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const rect = elViewport?.getBoundingClientRect();
  if (!rect?.width) return;
  const lx = ((e.clientX - rect.left) / rect.width) * VIEW_CSS;
  const ly = ((e.clientY - rect.top) / rect.height) * VIEW_CSS;
  const delta = e.deltaY > 0 ? -0.12 : 0.12;
  setZoomClamped(zoom + delta, lx, ly);
  if (elZoom) elZoom.value = String(Math.round(zoom * 100));
  render();
}

let listenersBound = false;

function bindUiOnce(): void {
  if (listenersBound) return;
  listenersBound = true;
  elZoom?.addEventListener("input", () => {
    const v = Number(elZoom?.value) / 100;
    setZoomClamped(Number.isFinite(v) ? v : 1, VIEW_CSS / 2, VIEW_CSS / 2);
    render();
  });
  elCancel?.addEventListener("click", () => closeSession(null));
  elApply?.addEventListener("click", () => {
    void (async () => {
      if (!finish || !source) return;
      elApply.disabled = true;
      try {
        const file = await exportCroppedJpeg(pendingSourceFileName);
        closeSession(file);
      } catch {
        if (elErr) elErr.textContent = "Impossible d’exporter l’image. Réessayez.";
      } finally {
        elApply.disabled = false;
      }
    })();
  });
  elDialog?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeSession(null);
  });
  elViewport?.addEventListener("pointerdown", onPointerDown);
  elViewport?.addEventListener("pointermove", onPointerMove);
  elViewport?.addEventListener("pointerup", onPointerUp);
  elViewport?.addEventListener("pointercancel", onPointerUp);
  elViewport?.addEventListener("wheel", onWheel, { passive: false });
}

/** Opens the crop dialog; returns `null` if cancelled or on error. */
export function runCoverSquareCrop(file: File): Promise<File | null> {
  if (!elDialog || !elCanvas || !elViewport) {
    return Promise.resolve(file);
  }
  bindUiOnce();
  if (finish) {
    const r = finish;
    finish = null;
    r(null);
  }
  cleanupSource();
  elDialog.close();
  cropGeneration++;
  const myGen = cropGeneration;
  pendingSourceFileName = file.name || "cover.jpg";
  return new Promise<File | null>((resolve) => {
    finish = resolve;
    void (async () => {
      elErr && (elErr.textContent = "");
      if (elApply) elApply.disabled = true;
      elDialog.showModal();
      try {
        const src = await loadSource(file);
        if (myGen !== cropGeneration) {
          discardStale(src);
          return;
        }
        source = src;
        iw = "width" in src && typeof src.width === "number" ? src.width : (src as HTMLImageElement).naturalWidth;
        ih = "height" in src && typeof src.height === "number" ? src.height : (src as HTMLImageElement).naturalHeight;
        if (iw < 2 || ih < 2) {
          cleanupSource();
          if (elErr) elErr.textContent = "Image trop petite.";
          if (elApply) elApply.disabled = true;
          return;
        }
        zoom = 1;
        centerImage();
        if (elZoom) elZoom.value = "100";
        if (elApply) elApply.disabled = false;
        render();
      } catch {
        cleanupSource();
        if (elErr) elErr.textContent = "Impossible de lire cette image.";
        if (elApply) elApply.disabled = true;
      }
    })();
  });
}
