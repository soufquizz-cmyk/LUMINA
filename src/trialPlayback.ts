/**
 * Free trial: server-tracked usage by IP, countdown UI, paywall when exhausted.
 * Requires same-origin `GET|POST /api/trial` (Vite middleware, Vercel, or Cloudflare Worker).
 */

export type TrialPlaybackInit = {
  liveVideo: HTMLVideoElement;
  vodVideo: HTMLVideoElement | null;
  isAdmin: () => boolean;
  /** Stop streams and sync UI when the trial hits zero. */
  stopAllPlayback: () => void;
};

type TrialApiPayload = {
  trialDisabled?: boolean;
  secondsUsed?: number;
  limitSeconds?: number;
  remainingSeconds?: number;
  exhausted?: boolean;
};

const API_PATH = "/api/trial";
const HEARTBEAT_MS = 5000;
const HEARTBEAT_CREDIT_SECONDS = 5;

let initDone = false;
/** Server-backed trial: gates playback when exhausted. */
let trialActive = false;
/** API off or unreachable in dev/preview: show pill + local countdown only, never block or modal. */
let trialVisualOnly = false;
let exhausted = false;
let limitSeconds = 60;
/** Last `remainingSeconds` from server (authoritative). */
let serverRemainingSec = 0;
/** Playback time since last server response, counted only while a video is playing. */
let unbilledPlaySec = 0;
let debtMarkWallMs = Date.now();
let debtMarkWasPlaying = false;

let elRoot: HTMLElement | null = null;
let elCount: HTMLElement | null = null;
let elDialog: HTMLDialogElement | null = null;
let elDialogClose: HTMLButtonElement | null = null;

let liveVideo: HTMLVideoElement | null = null;
let vodVideo: HTMLVideoElement | null = null;
let getIsAdmin: (() => boolean) | null = null;
let stopAllPlayback: (() => void) | null = null;

function apiUrl(): string {
  const base = (import.meta.env.VITE_TRIAL_API_BASE as string | undefined)?.trim();
  if (base) return `${base.replace(/\/+$/, "")}${API_PATH}`;
  return API_PATH;
}

function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function anyVideoPlaying(): boolean {
  const live = liveVideo && !liveVideo.paused && !liveVideo.ended;
  const vod = vodVideo && !vodVideo.paused && !vodVideo.ended;
  return Boolean(live || vod);
}

function advanceUnbilledDebt(): void {
  const playing = anyVideoPlaying();
  const now = Date.now();
  if (debtMarkWasPlaying) {
    unbilledPlaySec += (now - debtMarkWallMs) / 1000;
  }
  debtMarkWallMs = now;
  debtMarkWasPlaying = playing;
}

function estimateRemainingSeconds(): number {
  if ((!trialActive && !trialVisualOnly) || exhausted) return 0;
  return Math.max(0, serverRemainingSec - unbilledPlaySec);
}

function updateTimerLabel(): void {
  if (!elCount) return;
  if ((!trialActive && !trialVisualOnly) || exhausted) {
    elCount.textContent = "0:00";
    return;
  }
  elCount.textContent = formatMmSs(estimateRemainingSeconds());
}

function showTimer(visible: boolean): void {
  elRoot?.classList.toggle("hidden", !visible);
}

function showPaywall(): void {
  if (!elDialog) return;
  try {
    if (!elDialog.open) elDialog.showModal();
  } catch {
    /* ignore */
  }
}

function hidePaywall(): void {
  try {
    elDialog?.close();
  } catch {
    /* ignore */
  }
}

function freezeDebtFromServer(p: TrialApiPayload): void {
  const rem =
    typeof p.remainingSeconds === "number" && Number.isFinite(p.remainingSeconds)
      ? Math.max(0, p.remainingSeconds)
      : Math.max(0, (p.limitSeconds ?? limitSeconds) - (p.secondsUsed ?? 0));
  serverRemainingSec = rem;
  unbilledPlaySec = 0;
  debtMarkWallMs = Date.now();
  debtMarkWasPlaying = anyVideoPlaying();
}

function applyExhaustedUi(): void {
  if (trialVisualOnly) return;
  exhausted = true;
  showTimer(true);
  updateTimerLabel();
  showPaywall();
  stopAllPlayback?.();
  try {
    liveVideo?.pause();
  } catch {
    /* ignore */
  }
  try {
    vodVideo?.pause();
  } catch {
    /* ignore */
  }
}

async function fetchStatus(method: "GET" | "POST", body?: object): Promise<TrialApiPayload | null> {
  try {
    const r = await fetch(apiUrl(), {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" && body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    if (!r.ok) return null;
    return (await r.json()) as TrialApiPayload;
  } catch {
    return null;
  }
}

function syncTrialHintForVisualOnly(): void {
  const hint = document.getElementById("trial-timer-hint");
  if (!hint) return;
  if (import.meta.env.DEV) {
    hint.textContent = "Local";
    hint.title = "Compteur local : l’API /api/trial ne comptabilise pas (clés Supabase ou route).";
  } else {
    hint.textContent = "Démo";
    hint.title =
      "Quota serveur inactif : sur Vercel, ajoutez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY, et vérifiez que la fonction /api/trial répond (GET 200).";
  }
  hint.classList.remove("hidden");
}

function applyPayload(p: TrialApiPayload | null): void {
  if (!p || p.trialDisabled) {
    trialActive = false;
    exhausted = false;
    hidePaywall();
    trialVisualOnly = true;
    limitSeconds =
      typeof p?.limitSeconds === "number" && Number.isFinite(p.limitSeconds) ? p.limitSeconds : 60;
    serverRemainingSec = limitSeconds;
    unbilledPlaySec = 0;
    debtMarkWallMs = Date.now();
    debtMarkWasPlaying = anyVideoPlaying();
    showTimer(true);
    updateTimerLabel();
    elRoot?.classList.add("trial-timer-root--visual-only");
    syncTrialHintForVisualOnly();
    return;
  }
  trialVisualOnly = false;
  elRoot?.classList.remove("trial-timer-root--visual-only");
  document.getElementById("trial-timer-hint")?.classList.add("hidden");
  trialActive = true;
  limitSeconds = typeof p.limitSeconds === "number" ? p.limitSeconds : 60;
  freezeDebtFromServer(p);
  exhausted = Boolean(p.exhausted || serverRemainingSec <= 0);
  showTimer(true);
  updateTimerLabel();
  if (exhausted) {
    applyExhaustedUi();
  }
}

async function postHeartbeat(): Promise<void> {
  if (trialVisualOnly || !trialActive || exhausted || getIsAdmin?.()) return;
  if (!anyVideoPlaying()) return;
  const p = await fetchStatus("POST", { addSeconds: HEARTBEAT_CREDIT_SECONDS });
  if (!p || p.trialDisabled) return;
  freezeDebtFromServer(p);
  exhausted = Boolean(p.exhausted || serverRemainingSec <= 0);
  updateTimerLabel();
  if (exhausted) {
    applyExhaustedUi();
  }
}

function tickRaf(): void {
  if ((!trialActive && !trialVisualOnly) || exhausted) return;
  advanceUnbilledDebt();
  updateTimerLabel();
  const d = estimateRemainingSeconds();
  if (!trialVisualOnly && d <= 0 && !getIsAdmin?.()) {
    exhausted = true;
    applyExhaustedUi();
    return;
  }
  window.requestAnimationFrame(tickRaf);
}

function onVideoPlayBlock(ev: Event): void {
  if (getIsAdmin?.()) return;
  if (trialVisualOnly || !trialActive) return;
  if (!exhausted) return;
  const t = ev.target;
  if (t instanceof HTMLVideoElement) {
    try {
      t.pause();
    } catch {
      /* ignore */
    }
  }
  showPaywall();
}

export function trialPlaybackAllowed(): boolean {
  if (getIsAdmin?.()) return true;
  if (trialVisualOnly || !trialActive) return true;
  return !exhausted;
}

export async function initTrialPlaybackGate(opts: TrialPlaybackInit): Promise<void> {
  if (initDone) return;
  initDone = true;
  liveVideo = opts.liveVideo;
  vodVideo = opts.vodVideo;
  getIsAdmin = opts.isAdmin;
  stopAllPlayback = opts.stopAllPlayback;

  elRoot = document.getElementById("trial-timer-root");
  elCount = document.getElementById("trial-timer-count");
  elDialog = document.getElementById("trial-expired-dialog") as HTMLDialogElement | null;
  elDialogClose = document.getElementById("trial-expired-close") as HTMLButtonElement | null;

  elDialogClose?.addEventListener("click", () => hidePaywall());

  const blockTargets: HTMLVideoElement[] = [opts.liveVideo];
  if (opts.vodVideo) blockTargets.push(opts.vodVideo);
  for (const v of blockTargets) {
    v.addEventListener("play", onVideoPlayBlock);
  }

  const p = await fetchStatus("GET");
  applyPayload(p);

  if ((trialActive || trialVisualOnly) && !exhausted) {
    if (trialActive && !trialVisualOnly) {
      window.setInterval(() => {
        void postHeartbeat();
      }, HEARTBEAT_MS);
    }
    window.requestAnimationFrame(tickRaf);
  }
}
