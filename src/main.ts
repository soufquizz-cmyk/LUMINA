import Hls from "hls.js";
import { isAdminSession, tryConsumeAdminAccessFromUrl } from "./adminSession";
import {
  displayChannelName,
  setChannelHideNeedlesFromDatabase,
  setChannelNamePrefixesFromDatabase,
  shouldHideChannelByName,
} from "./assignmentMatch";
import {
  applySettingsRouteOnLoad,
  isSettingsPageOpen,
  openSettingsPage,
  syncSettingsFromUrl,
} from "./settingsPage";
import {
  type AdminConfig,
  type AdminCountry,
  type AdminPackage,
  EMPTY_ADMIN_CONFIG,
} from "./adminHierarchyConfig";
import { THEMES, presetForPackageName } from "./packageThemePresets";
import { normalizeCountryKey } from "./canonicalCountries";
import { fetchAndApplyCanonicalCountries } from "./canonicalCountriesSupabase";
import { fetchAndApplyChannelNamePrefixes } from "./channelNamePrefixesSupabase";
import { fetchAndApplyChannelHideNeedles } from "./channelHideNeedlesSupabase";
import { buildProviderAdminConfig } from "./providerLayout";
import {
  type LiveCategory,
  type LiveStream,
  tryNodecastLoginAndLoad,
  fetchNodecastVodCatalog,
  fetchNodecastSeriesCatalog,
  resolveNodecastStreamUrl,
  resolveNodecastVodStreamUrl,
  resolveNodecastSeriesPlayableUrl,
  fetchNodecastVodInfo,
  fetchNodecastSeriesInfo,
  proxiedUrl,
  imageUrlForDisplay,
  normalizeServerInput,
  sameOrigin,
} from "./nodecastCatalog";
import {
  fetchDbAdminCountries,
  fetchDbAdminPackages,
  getSupabaseClient,
  isLikelyUuid,
  matchDbCountryIdByDisplayName,
  uploadPackageCoverFile,
  isPackageCoverDebugEnabled,
} from "./supabaseAdminHierarchy";
import { runCoverSquareCrop } from "./coverSquareCrop";
import {
  FRANCE_SYNTH_PACKAGES,
  STREAM_CURATION_HIDDEN,
  collectStreamsFromProviderCategories,
  listStreamsForOpenedPackage,
} from "./franceStreamCuration";
import { fetchDbStreamCurations, upsertStreamCuration } from "./channelCurationSupabase";
import {
  deletePackageCoverOverride,
  fetchDbPackageCoverOverrides,
  upsertPackageCoverOverride,
} from "./packageCoverOverridesSupabase";
import {
  extractPresetFromImageUrlCached,
  invalidatePackageImageThemeCache,
} from "./packageImageTheme";
import { applyVeloraShellBgToMain } from "./veloraShellBackground";

type ServerInfo = {
  url: string;
  port: string | number;
  https_port?: string | number;
  server_protocol?: string;
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

const elServer = $("#server") as HTMLInputElement;
const elUser = $("#user") as HTMLInputElement;
const elPass = $("#pass") as HTMLInputElement;
const elBtnConnect = $("#btn-connect") as HTMLButtonElement;
const elLoginStatus = $("#login-status") as HTMLSpanElement;
const elMain = $("#main") as HTMLElement;
const elCatalogLoadingOverlay = $("#catalog-loading-overlay") as HTMLDivElement | null;
const elCatalogLoadingStatus = $("#catalog-loading-status") as HTMLParagraphElement | null;
const elLoginPanel = document.querySelector(".login-panel") as HTMLElement;
const elCatPills = $("#cat-pills") as HTMLDivElement;
const elCatPillsWrap = $("#cat-pills-wrap") as HTMLElement;
const elVideo = $("#video") as HTMLVideoElement;
const elVideoVod = document.getElementById("video-vod") as HTMLVideoElement | null;
const elVodPlayerContainer = document.getElementById("vod-player-container") as HTMLElement | null;
const elNowPlayingVod = document.getElementById("now-playing-vod") as HTMLDivElement | null;
const elVodPlayerBuffering = document.getElementById("vod-player-buffering") as HTMLDivElement | null;
const elBtnCloseVodPlayer = document.getElementById("btn-close-vod-player") as HTMLButtonElement | null;
const elPlayerBuffering = document.getElementById("player-buffering") as HTMLDivElement | null;
const elNowPlaying = $("#now-playing") as HTMLDivElement;
const elBtnLogout = $("#btn-logout") as HTMLButtonElement;
const elBtnSettings = $("#btn-settings") as HTMLButtonElement | null;
const elVelAdminToolsWrap = document.getElementById("vel-admin-tools-wrap") as HTMLElement | null;
const elToggleAdminUi = document.getElementById("toggle-admin-ui") as HTMLInputElement | null;
const elHeaderLoginOnly = document.querySelector(".header--login-only") as HTMLElement | null;
const elCountrySelect = $("#country-select") as HTMLSelectElement;
const elDialogAddPkg = document.getElementById("dialog-admin-add-package") as HTMLDialogElement;
const elDapSbCountry = document.getElementById("dap-sb-country") as HTMLSelectElement;
const elDapName = document.getElementById("dap-name") as HTMLInputElement;
const elDapCancel = document.getElementById("dap-cancel") as HTMLButtonElement;
const elDapSubmit = document.getElementById("dap-submit") as HTMLButtonElement;
const elDapStatus = document.getElementById("dap-status") as HTMLParagraphElement;
const elDapCover = document.getElementById("dap-cover") as HTMLInputElement;
const elDapCoverPick = document.getElementById("dap-cover-pick") as HTMLButtonElement | null;
const elDapCoverEmpty = document.getElementById("dap-cover-empty") as HTMLDivElement | null;
const elDapCoverPreviewWrap = document.getElementById("dap-cover-preview-wrap") as HTMLDivElement | null;
const elDapCoverPreview = document.getElementById("dap-cover-preview") as HTMLImageElement | null;
const elDapDropzone = document.getElementById("dap-dropzone") as HTMLDivElement | null;
const elDapEmptyCountriesHint = document.getElementById("dap-empty-countries-hint") as HTMLParagraphElement | null;
const elDapNewCountryName = document.getElementById("dap-new-country-name") as HTMLInputElement;
const elDapAddCountry = document.getElementById("dap-add-country") as HTMLButtonElement;
const elCurateStatus = document.getElementById("vel-curate-status") as HTMLParagraphElement | null;
let curateStatusClearTimer: number | undefined;

/** Visible feedback in the player shell (login status is hidden after connect). */
function flashCurateStatus(message: string, isError: boolean): void {
  if (!elCurateStatus) {
    if (isError) window.alert(message);
    return;
  }
  elCurateStatus.textContent = message;
  elCurateStatus.classList.remove("hidden");
  elCurateStatus.classList.toggle("vel-curate-status--error", isError);
  if (curateStatusClearTimer) window.clearTimeout(curateStatusClearTimer);
  curateStatusClearTimer = window.setTimeout(() => {
    elCurateStatus.classList.add("hidden");
    elCurateStatus.textContent = "";
  }, 6000);
}

const elDialogPackageCover = document.getElementById("dialog-package-cover") as HTMLDialogElement | null;
const elPcePackageId = document.getElementById("pce-package-id") as HTMLInputElement | null;
const elPcePackageName = document.getElementById("pce-package-name") as HTMLParagraphElement | null;
const elPceCover = document.getElementById("pce-cover") as HTMLInputElement | null;
const elPceCoverPick = document.getElementById("pce-cover-pick") as HTMLButtonElement | null;
const elPceCoverEmpty = document.getElementById("pce-cover-empty") as HTMLDivElement | null;
const elPceCoverPreviewWrap = document.getElementById("pce-cover-preview-wrap") as HTMLDivElement | null;
const elPceCoverPreview = document.getElementById("pce-cover-preview") as HTMLImageElement | null;
const elPceDropzone = document.getElementById("pce-dropzone") as HTMLDivElement | null;
const elPceClear = document.getElementById("pce-clear") as HTMLButtonElement | null;
const elPceCancel = document.getElementById("pce-cancel") as HTMLButtonElement | null;
const elPceSubmit = document.getElementById("pce-submit") as HTMLButtonElement | null;
const elPceStatus = document.getElementById("pce-status") as HTMLParagraphElement | null;

/** `URL.createObjectURL` for cover previews — revoked when clearing or replacing. */
let pceCoverPreviewObjectUrl: string | null = null;
let dapCoverPreviewObjectUrl: string | null = null;

const elDialogChannelAssign = document.getElementById("dialog-channel-assign") as HTMLDialogElement | null;
const elChannelAssignSelect = document.getElementById("channel-assign-package") as HTMLSelectElement | null;
const elChannelAssignStatus = document.getElementById("channel-assign-status") as HTMLParagraphElement | null;
const elChannelAssignCancel = document.getElementById("channel-assign-cancel") as HTMLButtonElement | null;
const elChannelAssignOk = document.getElementById("channel-assign-ok") as HTMLButtonElement | null;
let pendingAssignStreamId: number | null = null;

const elDialogAddChannels = document.getElementById("dialog-admin-add-channels") as HTMLDialogElement | null;
const elAddChannelsHint = document.getElementById("add-channels-package-hint") as HTMLParagraphElement | null;
const elAddChannelsSearch = document.getElementById("add-channels-search") as HTMLInputElement | null;
const elAddChannelsList = document.getElementById("add-channels-list") as HTMLDivElement | null;
const elAddChannelsStatus = document.getElementById("add-channels-status") as HTMLParagraphElement | null;
const elAddChannelsCancel = document.getElementById("add-channels-cancel") as HTMLButtonElement | null;
const elAddChannelsSubmit = document.getElementById("add-channels-submit") as HTMLButtonElement | null;
const elAddChannelsSelectVisible = document.getElementById("add-channels-select-visible") as HTMLButtonElement | null;
const elBtnAdminAddChannels = document.getElementById("btn-admin-add-channels") as HTMLButtonElement | null;

const elPlayerContainer = $("#player-container") as HTMLElement;
const elBtnClosePlayer = document.getElementById("btn-close-player") as HTMLButtonElement | null;
const elMainTabs = $("#main-tabs") as HTMLElement;
const elPackagesView = $("#packages-view") as HTMLDivElement;
const elContentView = $("#content-view") as HTMLElement;
const elDynamicList = $("#dynamic-list") as HTMLDivElement;
const elBtnBackHome = $("#btn-back-home") as HTMLButtonElement;
const elTabLive = $("#tab-live") as HTMLButtonElement;
const elTabMovies = $("#tab-movies") as HTMLButtonElement;
const elTabSeries = $("#tab-series") as HTMLButtonElement;

applyVeloraShellBgToMain(elMain);
window.addEventListener("velora-shell-bg-changed", () => applyVeloraShellBgToMain(elMain));

type PillId = string;

const ALL_PILL = { id: "all", label: "Tout" } as const;

let selectedPillId: PillId = "all";
let pillDefs: Array<{ id: string; label: string }> = [ALL_PILL];

let adminConfig: AdminConfig = { ...EMPTY_ADMIN_CONFIG };
/** Pays › bouquets dérivés des catégories VOD / séries (même logique que le live). */
let vodAdminConfig: AdminConfig = { ...EMPTY_ADMIN_CONFIG };
let seriesAdminConfig: AdminConfig = { ...EMPTY_ADMIN_CONFIG };

type UiTab = "live" | "movies" | "series";
type UiShell = "packages" | "content";

let uiTab: UiTab = "live";
let uiShell: UiShell = "packages";
/** When in live TV content view, which admin package (grid card) is open. */
let uiAdminPackageId: string | null = null;
/** Selected country in the header (inferred from catalogue keys, e.g. canonical id). */
let selectedAdminCountryId: string | null = null;
/** Supabase `admin_countries` / `admin_packages` — merged into the grid for admins. */
let dbAdminCountries: AdminCountry[] = [];
let dbAdminPackages: AdminPackage[] = [];
/** Supabase `country_id` → `stream_id` → `target_package_id` (or `hidden`). */
let streamCurationByCountry: Map<string, Map<number, string>> = new Map();
/** `package_id` (fournisseur ou velagg:…) → `cover_url` pour images hors `admin_packages`. */
let packageCoverOverrides: Map<string, string> = new Map();

const COUNTRY_STORAGE_KEY = "lumina_selected_country_id";
/** When `"0"`, hide + / Supabase delete in the grid (admin session only). Default = visible. */
const ADMIN_GRID_TOOLS_KEY = "velora_admin_grid_tools";
/** Same id as `providerLayout` « Autres » bucket — keep last in the list. */
const OTHER_COUNTRY_ID = "country__other";

function resolvedIconUrl(raw: string | undefined, base: string): string | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    return /^https?:\/\//i.test(s) ? s : new URL(s, base).href;
  } catch {
    return null;
  }
}

function buildLiveStreamUrl(
  server: ServerInfo,
  username: string,
  password: string,
  streamId: number,
  ext: "m3u8" | "ts"
): string {
  const protocol = (server.server_protocol || "http").replace(/:$/, "");
  const host = String(server.url).replace(/^\/+/, "");
  const useHttps = protocol === "https";
  const port = String(
    useHttps && server.https_port != null && server.https_port !== ""
      ? server.https_port
      : server.port || ""
  );
  const hostPort = port ? `${host}:${port}` : host;
  const base = `${protocol}://${hostPort}`.replace(/\/+$/, "");
  return `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`;
}

let state: {
  mode: "xtream" | "nodecast";
  base: string;
  username: string;
  password: string;
  nodecastAuthHeaders?: Record<string, string>;
  serverInfo: ServerInfo;
  /** Full provider catalog (used only to resolve streams matched by admin rules). */
  streamsByCatAll: Map<string, LiveStream[]>;
  nodecastXtreamSourceId?: string;
  vodCategories: LiveCategory[];
  vodStreamsByCat: Map<string, LiveStream[]>;
  seriesCategories: LiveCategory[];
  seriesStreamsByCat: Map<string, LiveStream[]>;
  /** VOD / séries ne sont chargés qu’à l’ouverture des onglets (pas au login). */
  vodCatalogLoaded: boolean;
  seriesCatalogLoaded: boolean;
} | null = null;

let hls: Hls | null = null;
let hlsVod: Hls | null = null;
let activeStreamId: number | null = null;

type VodMovieUiPhase = "list" | "detail";
let vodMovieUiPhase: VodMovieUiPhase = "list";
let vodDetailStream: LiveStream | null = null;

type SeriesUiPhase = "list" | "detail";
let seriesUiPhase: SeriesUiPhase = "list";
let seriesDetailStream: LiveStream | null = null;

type CatalogMediaTab = "movies" | "series";

function applyPresetTheme(key: string): void {
  const t = THEMES[key] || THEMES.default;
  elMain.style.setProperty("--vel-bg", t.bg);
  elMain.style.setProperty("--vel-surface", t.surface);
  elMain.style.setProperty("--vel-primary", t.primary);
  elMain.style.setProperty("--vel-accent-glow", t.glow);
  elMain.style.removeProperty("--vel-back");
}

function applyThemeForPackageSync(pkg: AdminPackage | null): void {
  if (!pkg) {
    applyPresetTheme("default");
    return;
  }
  const preset = presetForPackageName(pkg.name);
  const bg = pkg.theme_bg?.trim() || preset.bg;
  const surface = pkg.theme_surface?.trim() || preset.surface;
  const primary = pkg.theme_primary?.trim() || preset.primary;
  const glow = pkg.theme_glow?.trim() || preset.glow;
  elMain.style.setProperty("--vel-bg", bg);
  elMain.style.setProperty("--vel-surface", surface);
  elMain.style.setProperty("--vel-primary", primary);
  elMain.style.setProperty("--vel-accent-glow", glow);
  const back = pkg.theme_back?.trim();
  if (back) elMain.style.setProperty("--vel-back", back);
  else elMain.style.removeProperty("--vel-back");
}

function resolveHeroImageUrlForTheme(pkg: AdminPackage): string | null {
  const st = state;
  if (!st) return null;
  const id = pkg.id;
  if (isLikelyUuid(id)) {
    const u = pkg.cover_url?.trim();
    if (u && /^https?:\/\//i.test(u)) return u;
    return null;
  }
  const o = packageCoverOverrides.get(id)?.trim();
  if (o && /^https?:\/\//i.test(o)) return o;
  const list = streamsForPackageCoverFallback(id);
  const ch = list.map((s) => resolvedIconUrl(s.stream_icon, st.base)).find(Boolean);
  return ch?.trim() || null;
}

async function applyPackageImageThemeAsync(pkg: AdminPackage | null): Promise<void> {
  if (!pkg) return;
  const hasCustom =
    Boolean(pkg.theme_bg?.trim()) ||
    Boolean(pkg.theme_surface?.trim()) ||
    Boolean(pkg.theme_primary?.trim()) ||
    Boolean(pkg.theme_glow?.trim());
  if (hasCustom) return;
  const url = resolveHeroImageUrlForTheme(pkg);
  if (!url) return;
  const pid = pkg.id;
  const extracted = await extractPresetFromImageUrlCached(pid, url);
  if (!extracted) return;
  if (uiAdminPackageId !== pid) return;
  const now = findPackageById(pid);
  if (!now) return;
  if (
    now.theme_bg?.trim() ||
    now.theme_surface?.trim() ||
    now.theme_primary?.trim() ||
    now.theme_glow?.trim()
  ) {
    return;
  }
  const urlNow = resolveHeroImageUrlForTheme(now);
  if (urlNow !== url) return;
  elMain.style.setProperty("--vel-bg", extracted.bg);
  elMain.style.setProperty("--vel-surface", extracted.surface);
  elMain.style.setProperty("--vel-primary", extracted.primary);
  elMain.style.setProperty("--vel-accent-glow", extracted.glow);
}

function applyThemeForPackage(pkg: AdminPackage | null): void {
  applyThemeForPackageSync(pkg);
  void applyPackageImageThemeAsync(pkg);
}

function setTabsActive(tab: UiTab): void {
  elTabLive.classList.toggle("active", tab === "live");
  elTabMovies.classList.toggle("active", tab === "movies");
  elTabSeries.classList.toggle("active", tab === "series");
}

/** × sur le lecteur : visible seulement sur la grille bouquets (hors package), lecteur affiché. */
function syncPlayerDismissOverlay(): void {
  const onPackagesGrid = uiShell === "packages";
  const liveShown = !elPlayerContainer.classList.contains("hidden");
  const vodShown = Boolean(elVodPlayerContainer && !elVodPlayerContainer.classList.contains("hidden"));
  const ok = state != null && onPackagesGrid;
  elBtnClosePlayer?.classList.toggle("hidden", !(liveShown && ok));
  elBtnCloseVodPlayer?.classList.toggle("hidden", !(vodShown && ok));
}

function showPlayerChrome(show: boolean): void {
  if (show) {
    destroyVodPlayer();
  }
  elPlayerContainer.classList.toggle("hidden", !show);
  elPlayerContainer.setAttribute("aria-hidden", show ? "false" : "true");
  elNowPlaying.classList.toggle("hidden", !show);
  elNowPlaying.setAttribute("aria-hidden", show ? "false" : "true");
  syncPlayerDismissOverlay();
}

function showVodPlayerChrome(show: boolean): void {
  if (!elVodPlayerContainer || !elNowPlayingVod) return;
  if (show) {
    destroyPlayer();
  }
  elVodPlayerContainer.classList.toggle("hidden", !show);
  elVodPlayerContainer.setAttribute("aria-hidden", show ? "false" : "true");
  elNowPlayingVod.classList.toggle("hidden", !show);
  elNowPlayingVod.setAttribute("aria-hidden", show ? "false" : "true");
  syncPlayerDismissOverlay();
}

/** Arrête la lecture et masque le lecteur ; met à jour la liste des chaînes si on est encore dans un bouquet. */
function closePlayerUserAction(): void {
  activeStreamId = null;
  destroyPlayer();
  if (state && uiShell === "content" && uiAdminPackageId != null) {
    renderPackageChannelList();
  }
}

function closeVodPlayerUserAction(): void {
  activeStreamId = null;
  destroyVodPlayer();
  if (state && uiShell === "content" && uiAdminPackageId != null) {
    renderPackageChannelList();
  }
}

function setPlayerBufferingVisible(visible: boolean): void {
  if (!elPlayerBuffering) return;
  elPlayerBuffering.classList.toggle("hidden", !visible);
  elPlayerBuffering.setAttribute("aria-hidden", visible ? "false" : "true");
}

/** Stop HLS / native playback without hiding the player shell (used when switching stream). */
function teardownPlaybackMedia(): void {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  elVideo.onerror = null;
  try {
    elVideo.pause();
  } catch {
    /* ignore */
  }
  elVideo.removeAttribute("src");
  elVideo.removeAttribute("title");
  elVideo.load();
  elPlayerContainer.classList.remove("player-container--live-tv");
}

function destroyPlayer(): void {
  teardownPlaybackMedia();
  setPlayerBufferingVisible(false);
  elNowPlaying.textContent = "";
  showPlayerChrome(false);
}

function setVodPlayerBufferingVisible(visible: boolean): void {
  if (!elVodPlayerBuffering) return;
  elVodPlayerBuffering.classList.toggle("hidden", !visible);
  elVodPlayerBuffering.setAttribute("aria-hidden", visible ? "false" : "true");
}

function teardownVodMedia(): void {
  if (!elVideoVod) return;
  if (hlsVod) {
    hlsVod.destroy();
    hlsVod = null;
  }
  elVideoVod.onerror = null;
  try {
    elVideoVod.pause();
  } catch {
    /* ignore */
  }
  elVideoVod.removeAttribute("src");
  elVideoVod.removeAttribute("title");
  elVideoVod.load();
  elVodPlayerContainer?.classList.remove("player-container--live-tv");
}

function destroyVodPlayer(): void {
  teardownVodMedia();
  setVodPlayerBufferingVisible(false);
  if (elNowPlayingVod) elNowPlayingVod.textContent = "";
  showVodPlayerChrome(false);
}

/** HLS manifest or Nodecast transcode playlist (not raw MKV/MP4). */
function urlLooksLikeHls(href: string): boolean {
  const h = href.toLowerCase();
  if (/\.m3u8(\?|#|&|$)/i.test(h)) return true;
  if (/\/api\/transcode\/[^/]+\/stream\.m3u8/i.test(h)) return true;
  if (/[?&]container=m3u8(?:&|$)/i.test(h)) return true;
  return false;
}

/** Progressive file or Xtream `container=` for a file container (native video element, not hls.js). */
function urlLooksLikeProgressiveMedia(href: string): boolean {
  if (urlLooksLikeHls(href)) return false;
  const h = href.toLowerCase();
  if (/\.(mp4|mkv|webm|mov|avi|m4v)(\?|#|&|$)/i.test(h)) return true;
  if (/[?&]container=(mkv|mp4|webm|mov|avi|m4v)(?:&|$)/i.test(h)) return true;
  return false;
}

function playUrl(
  url: string,
  label: string,
  upstreamAuth?: Record<string, string>,
  /** Live HLS (direct Xtream / chaîne Nodecast) : masque la barre de progression native (flux non borné). */
  hideNativeProgressBar = false
): void {
  destroyVodPlayer();
  teardownPlaybackMedia();
  setPlayerBufferingVisible(false);
  const proxied = proxiedUrl(url);
  elNowPlaying.innerHTML = nowPlayingLiveMarkup(label);
  /* Classe live avant d’afficher le shell : sinon une frame affiche la barre de progression native. */
  if (hideNativeProgressBar) {
    elPlayerContainer.classList.add("player-container--live-tv");
  } else {
    elPlayerContainer.classList.remove("player-container--live-tv");
  }
  showPlayerChrome(true);

  const hasUpstreamAuth = Boolean(
    upstreamAuth &&
      Object.values(upstreamAuth).some((v) => typeof v === "string" && v.trim())
  );

  if (urlLooksLikeProgressiveMedia(url) || urlLooksLikeProgressiveMedia(proxied)) {
    elVideo.src = proxied;
    elVideo.onerror = () => {
      elNowPlaying.innerHTML = nowPlayingErrorMarkup(
        "Lecture impossible (codec non pris en charge ou flux refusé)."
      );
    };
    void elVideo.play().catch(() => {});
    return;
  }

  // Native <video> cannot send Authorization; Nodecast transcode/HLS needs Bearer on every segment.
  if (
    elVideo.canPlayType("application/vnd.apple.mpegurl") &&
    !hasUpstreamAuth &&
    urlLooksLikeHls(url)
  ) {
    elVideo.src = proxied;
    void elVideo.play().catch(() => {});
    return;
  }

  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      xhrSetup(xhr) {
        if (!upstreamAuth) return;
        for (const [k, v] of Object.entries(upstreamAuth)) {
          if (typeof v !== "string" || !v.trim()) continue;
          try {
            xhr.setRequestHeader(k, v);
          } catch {
            /* ignore invalid header names */
          }
        }
      },
    });
    hls.loadSource(proxied);
    hls.attachMedia(elVideo);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void elVideo.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        elNowPlaying.innerHTML = nowPlayingErrorMarkup(
          `Erreur lecture : ${data.type} / ${String(data.details)}`
        );
      }
    });
    return;
  }

  elNowPlaying.innerHTML = nowPlayingErrorMarkup(
    "HLS non pris en charge dans ce navigateur."
  );
}

/** Lecteur VOD : `<video>` et instance HLS séparées du direct TV. */
function playVodUrl(url: string, label: string, upstreamAuth?: Record<string, string>): void {
  if (!elVideoVod || !elNowPlayingVod) return;
  teardownVodMedia();
  setVodPlayerBufferingVisible(false);
  const proxied = proxiedUrl(url);
  elNowPlayingVod.innerHTML = nowPlayingLiveMarkup(label);
  showVodPlayerChrome(true);

  const hasUpstreamAuth = Boolean(
    upstreamAuth &&
      Object.values(upstreamAuth).some((v) => typeof v === "string" && v.trim())
  );

  if (urlLooksLikeProgressiveMedia(url) || urlLooksLikeProgressiveMedia(proxied)) {
    elVideoVod.src = proxied;
    elVideoVod.onerror = () => {
      elNowPlayingVod.innerHTML = nowPlayingErrorMarkup(
        "Lecture impossible (codec non pris en charge ou flux refusé)."
      );
    };
    void elVideoVod.play().catch(() => {});
    return;
  }

  if (
    elVideoVod.canPlayType("application/vnd.apple.mpegurl") &&
    !hasUpstreamAuth &&
    urlLooksLikeHls(url)
  ) {
    elVideoVod.src = proxied;
    void elVideoVod.play().catch(() => {});
    return;
  }

  if (Hls.isSupported()) {
    hlsVod = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      xhrSetup(xhr) {
        if (!upstreamAuth) return;
        for (const [k, v] of Object.entries(upstreamAuth)) {
          if (typeof v !== "string" || !v.trim()) continue;
          try {
            xhr.setRequestHeader(k, v);
          } catch {
            /* ignore invalid header names */
          }
        }
      },
    });
    hlsVod.loadSource(proxied);
    hlsVod.attachMedia(elVideoVod);
    hlsVod.on(Hls.Events.MANIFEST_PARSED, () => {
      void elVideoVod.play().catch(() => {});
    });
    hlsVod.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        elNowPlayingVod.innerHTML = nowPlayingErrorMarkup(
          `Erreur lecture : ${data.type} / ${String(data.details)}`
        );
      }
    });
    return;
  }

  elNowPlayingVod.innerHTML = nowPlayingErrorMarkup(
    "HLS non pris en charge dans ce navigateur."
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nowPlayingLiveMarkup(title: string): string {
  return `<div class="vel-live-ticker" role="status">
  <div class="vel-live-ticker__meta">

    <strong class="vel-live-ticker__title">${escapeHtml(title)}</strong>
  </div>
</div>`;
}

function nowPlayingErrorMarkup(message: string): string {
  return `<div class="vel-live-ticker vel-live-ticker--error" role="alert">
  <span class="vel-live-ticker__badge vel-live-ticker__badge--alert" aria-hidden="true">!</span>
  <p class="vel-live-ticker__error">${escapeHtml(message)}</p>
</div>`;
}

function setLoginStatus(msg: string, isError = false): void {
  elLoginStatus.textContent = msg;
  elLoginStatus.classList.toggle("error", isError);
}

function setCatalogLoadingVisible(visible: boolean, statusText?: string): void {
  const el = elCatalogLoadingOverlay;
  if (!el) return;
  if (elCatalogLoadingStatus) {
    if (visible && statusText) {
      elCatalogLoadingStatus.textContent = statusText;
    } else if (!visible) {
      elCatalogLoadingStatus.textContent = "Chargement du catalogue…";
    }
  }
  el.classList.toggle("hidden", !visible);
  el.setAttribute("aria-hidden", visible ? "false" : "true");
}

function envAutoConnectConfigured(): boolean {
  const u = import.meta.env.VITE_NODECAST_URL?.trim();
  const n = import.meta.env.VITE_NODECAST_USERNAME?.trim();
  return Boolean(u && n);
}

function applyNodecastEnvDefaults(): void {
  if (!envAutoConnectConfigured()) return;
  elServer.value = import.meta.env.VITE_NODECAST_URL!.trim();
  elUser.value = import.meta.env.VITE_NODECAST_USERNAME!.trim();
  elPass.value =
    typeof import.meta.env.VITE_NODECAST_PASSWORD === "string"
      ? import.meta.env.VITE_NODECAST_PASSWORD
      : "";
}

/** Skip the login card: show main shell with a loading line until `connect()` finishes. */
function prepareEnvAutoconnectUi(): void {
  elHeaderLoginOnly?.classList.add("hidden");
  elLoginPanel.classList.add("hidden");
  elMain.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.add("hidden");
  elPackagesView.classList.remove("hidden");
  elPackagesView.innerHTML = "";
}

function syncPillDefsForPackage(packageId: string): void {
  const leaves = adminConfig.categories
    .filter((c) => c.package_id === packageId)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  pillDefs = [
    ALL_PILL,
    ...leaves.map((c) => ({ id: `custom:${c.id}`, label: c.name })),
  ];
  if (!pillDefs.some((p) => p.id === selectedPillId)) {
    selectedPillId = "all";
  }
}

function streamsAfterPill(base: LiveStream[], pillId: PillId): LiveStream[] {
  if (pillId === "all") return base;
  return base;
}

function updatePillsVisibility(): void {
  const show = uiShell === "content" && uiTab === "live" && uiAdminPackageId != null;
  if (!show) {
    elCatPillsWrap.classList.add("hidden");
    return;
  }
  const hasExtra = pillDefs.length > 1;
  elCatPillsWrap.classList.toggle("hidden", !hasExtra);
}

function renderCategoryPills(): void {
  if (!state || uiAdminPackageId == null) return;
  /** Films / séries : pas de pastilles live, mais la liste des titres doit s’afficher. */
  if (uiTab === "movies" || uiTab === "series") {
    elCatPills.innerHTML = "";
    updatePillsVisibility();
    renderPackageChannelList();
    return;
  }
  if (uiTab !== "live") return;
  elCatPills.innerHTML = "";
  if (!pillDefs.some((p) => p.id === selectedPillId)) {
    selectedPillId = "all";
  }
  for (const p of pillDefs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-pill";
    btn.setAttribute("role", "tab");
    btn.dataset.pillId = p.id;
    if (p.id === selectedPillId) btn.classList.add("active");
    btn.textContent = p.label;
    btn.title = p.label;
    btn.addEventListener("click", () => {
      selectedPillId = p.id;
      elCatPills.querySelectorAll(".cat-pill").forEach((b) => {
        b.classList.toggle("active", (b as HTMLButtonElement).dataset.pillId === p.id);
      });
      renderPackageChannelList();
    });
    elCatPills.appendChild(btn);
  }
  updatePillsVisibility();
  renderPackageChannelList();
}

function showAdminChannelCurateTools(): boolean {
  return Boolean(isAdminSession() && readAdminGridToolsEnabled() && getSupabaseClient());
}

/**
 * If the catalogue pays has no matching `admin_countries` row yet, create one with the same
 * display name so curations (masquer / déplacer) can be stored.
 */
async function ensureSupabaseCountryForSelection(): Promise<string | null> {
  const existing = resolvedDbCountryIdForAdminPackages();
  if (existing) return existing;
  const sb = getSupabaseClient();
  if (!sb) return null;
  const label = currentCountryDisplayLabel()?.trim();
  if (!label) return null;
  const reuse = matchDbCountryIdByDisplayName(label, dbAdminCountries);
  if (reuse) return reuse;
  const { error } = await sb.from("admin_countries").insert({ name: label });
  if (error) {
    const msg = `Impossible de créer le pays « ${label} » dans Supabase : ${error.message}`;
    flashCurateStatus(msg, true);
    await refreshSupabaseHierarchy();
    return matchedDbCountryIdForSelection();
  }
  await refreshSupabaseHierarchy();
  return matchedDbCountryIdForSelection();
}

async function persistStreamCuration(streamId: number, targetPackageId: string): Promise<boolean> {
  const sb = getSupabaseClient();
  if (!sb) {
    flashCurateStatus("Supabase non configuré.", true);
    return false;
  }
  let cid = resolvedDbCountryIdForAdminPackages();
  if (!cid) {
    cid = await ensureSupabaseCountryForSelection();
  }
  if (!cid) {
    flashCurateStatus(
      "Enregistrement impossible : pays introuvable en base ou droits Supabase (admin_countries / admin_stream_curations).",
      true
    );
    return false;
  }
  const res = await upsertStreamCuration(sb, {
    stream_id: streamId,
    country_id: cid,
    target_package_id: targetPackageId,
  });
  if (res.error) {
    flashCurateStatus(
      `Enregistrement chaîne : ${res.error}. Vérifiez la table admin_stream_curations et la contrainte unique (stream_id, country_id).`,
      true
    );
    return false;
  }
  let inner = streamCurationByCountry.get(cid);
  if (!inner) {
    inner = new Map();
    streamCurationByCountry.set(cid, inner);
  }
  inner.set(streamId, targetPackageId);
  if (targetPackageId === STREAM_CURATION_HIDDEN) {
    if (uiAdminPackageId) invalidatePackageImageThemeCache(uiAdminPackageId);
  } else {
    invalidatePackageImageThemeCache(targetPackageId);
    if (uiAdminPackageId && uiAdminPackageId !== targetPackageId) {
      invalidatePackageImageThemeCache(uiAdminPackageId);
    }
  }
  if (state && uiShell === "content" && uiTab === "live" && uiAdminPackageId) {
    applyThemeForPackage(findPackageById(uiAdminPackageId) ?? null);
  }
  return true;
}

function populateChannelAssignPackageSelect(): void {
  if (!elChannelAssignSelect) return;
  elChannelAssignSelect.innerHTML = "";
  const pkgs = augmentChannelAssignPackagesFromDb(mergedPackagesForGrid());
  for (const p of pkgs) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    elChannelAssignSelect.appendChild(o);
  }
  if (uiAdminPackageId && [...elChannelAssignSelect.options].some((o) => o.value === uiAdminPackageId)) {
    elChannelAssignSelect.value = uiAdminPackageId;
  }
}

function openChannelAssignDialog(streamId: number): void {
  if (!elDialogChannelAssign || !elChannelAssignSelect) return;
  pendingAssignStreamId = streamId;
  elChannelAssignStatus && (elChannelAssignStatus.textContent = "");
  elChannelAssignStatus?.classList.remove("error");
  populateChannelAssignPackageSelect();
  elDialogChannelAssign.showModal();
}

function closeChannelAssignDialog(): void {
  pendingAssignStreamId = null;
  elDialogChannelAssign?.close();
}

function syncAdminAddChannelsButton(): void {
  const wrap = document.getElementById("vel-admin-add-channels-wrap");
  if (!wrap) return;
  const show =
    showAdminChannelCurateTools() &&
    state != null &&
    uiShell === "content" &&
    uiTab === "live" &&
    uiAdminPackageId != null;
  wrap.classList.toggle("hidden", !show);
}

/** Chaînes du pays hors de ce bouquet (liste courante + règles), pour import admin. */
function candidatesStreamsNotInOpenPackage(packageId: string): LiveStream[] {
  if (!state) return [];
  const inside = new Set(streamsDisplayedForOpenPackage(packageId).map((s) => s.stream_id));
  return unionStreamsForCurrentCountry()
    .filter((s) => !inside.has(s.stream_id) && !shouldHideChannelByName(s.name))
    .sort((a, b) => displayChannelName(a.name).localeCompare(displayChannelName(b.name), "fr"));
}

function filterAddChannelsListRows(): void {
  if (!elAddChannelsSearch || !elAddChannelsList) return;
  const q = elAddChannelsSearch.value.trim().toLowerCase();
  elAddChannelsList.querySelectorAll(".add-channels-row").forEach((rowEl) => {
    const row = rowEl as HTMLElement;
    const hay = (row.dataset.searchHay ?? "").toLowerCase();
    row.classList.toggle("hidden", q.length > 0 && !hay.includes(q));
  });
}

function buildAddChannelsDialogList(packageId: string): void {
  if (!elAddChannelsList) return;
  elAddChannelsList.innerHTML = "";
  const cand = candidatesStreamsNotInOpenPackage(packageId);
  for (const s of cand) {
    const row = document.createElement("div");
    row.className = "add-channels-row";
    const hay = `${displayChannelName(s.name)} ${s.name}`.replace(/\s+/g, " ").trim();
    row.dataset.searchHay = hay;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `add-ch-${s.stream_id}`;
    cb.dataset.streamId = String(s.stream_id);
    const lab = document.createElement("label");
    lab.htmlFor = cb.id;
    lab.textContent = displayChannelName(s.name);
    lab.title = s.name;
    row.append(cb, lab);
    elAddChannelsList.appendChild(row);
  }
  if (cand.length === 0) {
    const p = document.createElement("p");
    p.className = "vel-empty-msg";
    p.style.margin = "0.5rem 0";
    p.textContent =
      "Aucune chaîne disponible ailleurs pour ce pays (ou elles sont déjà dans ce bouquet).";
    elAddChannelsList.appendChild(p);
  }
}

function openAddChannelsToPackageDialog(): void {
  if (!elDialogAddChannels || !uiAdminPackageId || !state) return;
  if (!showAdminChannelCurateTools()) return;
  const pkg = findPackageById(uiAdminPackageId);
  const label = pkg?.name ?? uiAdminPackageId;
  if (elAddChannelsHint) {
    elAddChannelsHint.textContent = `Bouquet « ${label} » — les chaînes ajoutées disparaissent des autres bouquets de ce pays.`;
  }
  if (elAddChannelsSearch) elAddChannelsSearch.value = "";
  elAddChannelsStatus && (elAddChannelsStatus.textContent = "");
  elAddChannelsStatus?.classList.remove("error");
  buildAddChannelsDialogList(uiAdminPackageId);
  filterAddChannelsListRows();
  elDialogAddChannels.showModal();
}

function closeAddChannelsToPackageDialog(): void {
  elDialogAddChannels?.close();
}

function syncCatalogBackButtonLabel(): void {
  const lab = elBtnBackHome.querySelector(".back-btn__text");
  if (!lab) return;
  const inDetail =
    uiShell === "content" &&
    ((uiTab === "movies" && vodMovieUiPhase === "detail") ||
      (uiTab === "series" && seriesUiPhase === "detail"));
  lab.textContent = inDetail ? "Liste" : "Accueil";
}

function catalogPosterRowLooksPlaying(s: LiveStream): boolean {
  if (activeStreamId !== s.stream_id) return false;
  if (s.nodecast_media === "vod") {
    return Boolean(elVodPlayerContainer && !elVodPlayerContainer.classList.contains("hidden"));
  }
  return Boolean(elPlayerContainer && !elPlayerContainer.classList.contains("hidden"));
}

/** Notes renvoyées par `vod_streams` (rating ~ /10, rating_5based ~ /5). */
function vodStreamsRowRatingLabel(s: LiveStream): string | null {
  if (s.vod_rating != null && Number.isFinite(s.vod_rating)) {
    return `★ ${s.vod_rating.toFixed(1)}`;
  }
  if (s.vod_rating_5based != null && Number.isFinite(s.vod_rating_5based)) {
    return `★ ${s.vod_rating_5based.toFixed(1)}/5`;
  }
  return null;
}

function renderCatalogPosterGrid(streams: LiveStream[], tab: CatalogMediaTab): void {
  if (!state) return;
  const st = state;
  const emptyEmoji = tab === "movies" ? "🎬" : "📺";
  for (const s of streams) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "vel-vod-movie-card";
    card.dataset.streamId = String(s.stream_id);
    if (catalogPosterRowLooksPlaying(s)) {
      card.classList.add("vel-vod-movie-card--active");
    }

    const media = document.createElement("div");
    media.className = "vel-vod-movie-card__media";

    const poster = document.createElement("div");
    poster.className = "vel-vod-movie-card__poster";
    const iconHref = resolvedIconUrl(s.stream_icon, st.base);
    if (iconHref) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = proxiedUrl(iconHref);
      img.addEventListener("error", () => {
        poster.innerHTML = "";
        poster.classList.add("vel-vod-movie-card__poster--empty");
        poster.textContent = emptyEmoji;
        poster.setAttribute("aria-hidden", "true");
      });
      poster.appendChild(img);
    } else {
      poster.classList.add("vel-vod-movie-card__poster--empty");
      poster.textContent = emptyEmoji;
      poster.setAttribute("aria-hidden", "true");
    }

    media.appendChild(poster);

    if (tab === "movies") {
      const ratingLabel = vodStreamsRowRatingLabel(s);
      if (ratingLabel) {
        const badge = document.createElement("span");
        badge.className = "vel-vod-movie-card__rating-badge";
        badge.textContent = ratingLabel;
        badge.setAttribute("aria-label", `Note ${ratingLabel}`);
        media.appendChild(badge);
      }
    }

    const body = document.createElement("div");
    body.className = "vel-vod-movie-card__body";
    const title = document.createElement("span");
    title.className = "vel-vod-movie-card__title";
    const titleText = displayChannelName(s.name);
    title.textContent = titleText;
    title.title = titleText;
    body.appendChild(title);

    card.append(media, body);
    card.addEventListener("click", () => {
      if (tab === "movies") {
        vodDetailStream = s;
        vodMovieUiPhase = "detail";
      } else {
        seriesDetailStream = s;
        seriesUiPhase = "detail";
      }
      destroyVodPlayer();
      activeStreamId = null;
      renderPackageChannelList();
      syncCatalogBackButtonLabel();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    elDynamicList.appendChild(card);
  }

  if (streams.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.textContent =
      tab === "movies" ? "Aucun film dans ce bouquet." : "Aucune série dans ce bouquet.";
    elDynamicList.appendChild(empty);
  }
}

const VOD_HERO_GRAD_BACKDROP = `linear-gradient(180deg, rgba(6,4,12,0.06) 0%, rgba(6,4,12,0.1) 32%, rgba(6,4,12,0.45) 58%, rgba(6,4,12,0.88) 82%, rgba(6,4,12,0.97) 100%)`;
const VOD_HERO_GRAD_POSTER = `linear-gradient(180deg, rgba(6,4,12,0.35) 0%, rgba(6,4,12,0.95) 100%)`;

/** Précharge le visuel puis l’affiche (évite l’affiche carte → swap backdrop). */
function preloadVodDetailHeroBackground(
  bg: HTMLDivElement,
  primaryUrl: string,
  gradient: string,
  fallbackUrl: string | null,
  isStill: () => boolean
): void {
  const apply = (url: string, grad: string) => {
    if (!isStill()) return;
    bg.classList.remove("vel-vod-detail__bg--loading");
    bg.classList.remove("vel-vod-detail__bg--entered");
    bg.style.backgroundImage = `${grad}, url("${url}")`;
    void bg.offsetWidth;
    bg.classList.add("vel-vod-detail__bg--entered");
  };

  const attempt = (url: string, grad: string, allowIconFallback: boolean) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => apply(url, grad);
    img.onerror = () => {
      if (!isStill()) return;
      if (allowIconFallback && fallbackUrl && url !== fallbackUrl) {
        attempt(fallbackUrl, VOD_HERO_GRAD_BACKDROP, false);
        return;
      }
      bg.classList.remove("vel-vod-detail__bg--loading", "vel-vod-detail__bg--entered");
      bg.style.backgroundImage = "";
    };
    img.src = url;
  };

  attempt(primaryUrl, gradient, Boolean(fallbackUrl));
}

function renderCatalogMediaDetailView(s: LiveStream, tab: CatalogMediaTab): void {
  if (!state) return;
  const st = state;
  const streamTitle = displayChannelName(s.name);
  const sid = st.nodecastXtreamSourceId?.trim();
  const iconHref = resolvedIconUrl(s.stream_icon, st.base);

  const wrap = document.createElement("article");
  wrap.className = "vel-vod-detail";
  wrap.setAttribute("aria-label", streamTitle);

  const bg = document.createElement("div");
  bg.className = "vel-vod-detail__bg vel-vod-detail__bg--loading";

  const inner = document.createElement("div");
  inner.className = "vel-vod-detail__inner";

  const titleEl = document.createElement("h1");
  titleEl.className = "vel-vod-detail__title";
  titleEl.textContent = streamTitle;

  const metaRow = document.createElement("div");
  metaRow.className = "vel-vod-detail__meta";

  const ratingEl = document.createElement("span");
  ratingEl.className = "vel-vod-detail__rating";
  ratingEl.textContent = "…";

  const genreEl = document.createElement("span");
  genreEl.className = "vel-vod-detail__genre";

  metaRow.append(ratingEl, genreEl);

  const plot = document.createElement("p");
  plot.className = "vel-vod-detail__plot";
  plot.textContent = "Chargement de la fiche…";

  const castBlock = document.createElement("section");
  castBlock.className = "vel-vod-detail__section";
  const castH = document.createElement("h2");
  castH.className = "vel-vod-detail__section-title";
  castH.textContent = "Distribution";
  const castP = document.createElement("p");
  castP.className = "vel-vod-detail__cast";
  castP.textContent = "—";
  castBlock.append(castH, castP);

  const directorBlock = document.createElement("section");
  directorBlock.className = "vel-vod-detail__section";
  const dirH = document.createElement("h2");
  dirH.className = "vel-vod-detail__section-title";
  dirH.textContent = "Réalisation";
  const dirP = document.createElement("p");
  dirP.className = "vel-vod-detail__director";
  dirP.textContent = "—";
  directorBlock.append(dirH, dirP);

  const btnWatch = document.createElement("button");
  btnWatch.type = "button";
  btnWatch.className = "vel-vod-detail__watch primary";
  btnWatch.textContent = "Regarder";
  btnWatch.addEventListener("click", () => {
    activeStreamId = s.stream_id;
    void playStreamByMode(s);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  inner.append(titleEl, metaRow, plot, castBlock, directorBlock, btnWatch);
  wrap.append(bg, inner);
  elDynamicList.appendChild(wrap);

  const requestedId = s.stream_id;
  const noPlotCopy =
    tab === "movies"
      ? "Aucune description disponible pour ce titre."
      : "Aucune description disponible pour cette série.";

  void (async () => {
    const isStill = () =>
      tab === "movies"
        ? vodDetailStream?.stream_id === requestedId && uiTab === "movies"
        : seriesDetailStream?.stream_id === requestedId && uiTab === "series";

    const info =
      sid && sid.length > 0
        ? tab === "movies"
          ? await fetchNodecastVodInfo(st.base, sid, requestedId, st.nodecastAuthHeaders, streamTitle)
          : await fetchNodecastSeriesInfo(st.base, sid, requestedId, st.nodecastAuthHeaders, streamTitle)
        : null;
    if (!state || !isStill()) return;

    const displayTitle = (info?.title || streamTitle).trim() || streamTitle;
    titleEl.textContent = displayTitle;

    const rd = (info?.ratingDisplay ?? "").trim();
    if (rd) {
      ratingEl.textContent = `★ ${rd}`;
    } else {
      ratingEl.textContent = "";
      ratingEl.classList.add("vel-vod-detail__rating--empty");
    }

    const gn = (info?.genre ?? "").trim();
    genreEl.textContent = gn;
    genreEl.classList.toggle("hidden", !gn);

    plot.textContent = (info?.plot ?? "").trim() || noPlotCopy;

    const c = (info?.cast ?? "").trim();
    castP.textContent = c || "Non communiqué.";

    const d = (info?.director ?? "").trim();
    dirP.textContent = d || "—";
    directorBlock.classList.toggle("hidden", !d);

    const backdrop = info?.backdropUrl?.trim();
    const poster = info?.posterUrl?.trim();
    const fallbackIcon = iconHref ? proxiedUrl(iconHref) : null;
    if (backdrop) {
      preloadVodDetailHeroBackground(
        bg,
        imageUrlForDisplay(backdrop),
        VOD_HERO_GRAD_BACKDROP,
        fallbackIcon,
        isStill
      );
    } else if (poster) {
      preloadVodDetailHeroBackground(
        bg,
        imageUrlForDisplay(poster),
        VOD_HERO_GRAD_POSTER,
        fallbackIcon,
        isStill
      );
    } else if (fallbackIcon) {
      preloadVodDetailHeroBackground(bg, fallbackIcon, VOD_HERO_GRAD_BACKDROP, null, isStill);
    } else {
      bg.classList.remove("vel-vod-detail__bg--loading", "vel-vod-detail__bg--entered");
      bg.style.backgroundImage = "";
    }
  })();
}

function renderPackageChannelList(): void {
  if (!state || uiAdminPackageId == null) return;
  const base = streamsDisplayedForOpenPackage(uiAdminPackageId);
  const filtered = streamsAfterPill(base, selectedPillId).filter((s) => !shouldHideChannelByName(s.name));
  const adminTools = showAdminChannelCurateTools();

  elDynamicList.innerHTML = "";

  if (uiTab === "movies") {
    if (vodMovieUiPhase === "detail" && vodDetailStream) {
      elDynamicList.classList.remove("item-list--vod-vertical");
      elDynamicList.classList.add("item-list--vod-film-detail");
      elContentView.classList.add("content-view--vod-film-detail");
      renderCatalogMediaDetailView(vodDetailStream, "movies");
    } else {
      elDynamicList.classList.remove("item-list--vod-film-detail");
      elContentView.classList.remove("content-view--vod-film-detail");
      elDynamicList.classList.add("item-list--vod-vertical");
      renderCatalogPosterGrid(filtered, "movies");
    }
    syncCatalogBackButtonLabel();
    syncAdminAddChannelsButton();
    return;
  }

  if (uiTab === "series") {
    if (seriesUiPhase === "detail" && seriesDetailStream) {
      elDynamicList.classList.remove("item-list--vod-vertical");
      elDynamicList.classList.add("item-list--vod-film-detail");
      elContentView.classList.add("content-view--vod-film-detail");
      renderCatalogMediaDetailView(seriesDetailStream, "series");
    } else {
      elDynamicList.classList.remove("item-list--vod-film-detail");
      elContentView.classList.remove("content-view--vod-film-detail");
      elDynamicList.classList.add("item-list--vod-vertical");
      renderCatalogPosterGrid(filtered, "series");
    }
    syncCatalogBackButtonLabel();
    syncAdminAddChannelsButton();
    return;
  }

  elDynamicList.classList.remove("item-list--vod-vertical", "item-list--vod-film-detail");
  elContentView.classList.remove("content-view--vod-film-detail");

  for (const s of filtered) {
    const row = document.createElement("div");
    row.className = "vel-media-item-row";
    row.dataset.streamId = String(s.stream_id);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "media-item media-item__main";
    if (activeStreamId === s.stream_id) btn.classList.add("selected");

    const thumb = document.createElement("div");
    thumb.className = "media-item__thumb";
    const iconHref = resolvedIconUrl(s.stream_icon, state.base);
    if (iconHref) {
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.loading = "lazy";
      img.src = proxiedUrl(iconHref);
      img.addEventListener("error", () => {
        thumb.innerHTML = "";
        thumb.classList.add("media-item__thumb--empty");
        thumb.textContent = "📺";
        thumb.setAttribute("aria-hidden", "true");
      });
      thumb.appendChild(img);
    } else {
      thumb.classList.add("media-item__thumb--empty");
      thumb.textContent = "📺";
      thumb.setAttribute("aria-hidden", "true");
    }

    const info = document.createElement("div");
    info.className = "media-info";
    const h4 = document.createElement("h4");
    const titleText = displayChannelName(s.name);
    h4.textContent = titleText;
    h4.title = titleText;
    info.appendChild(h4);
    const epgId = s.epg_channel_id;
    if (typeof epgId === "string" && epgId.trim()) {
      const p = document.createElement("p");
      p.textContent = `EPG : ${epgId}`;
      info.appendChild(p);
    }
    btn.appendChild(thumb);
    btn.appendChild(info);
    btn.addEventListener("click", () => {
      activeStreamId = s.stream_id;
      elDynamicList.querySelectorAll(".vel-media-item-row").forEach((wrapEl) => {
        const wrap = wrapEl as HTMLElement;
        const sid = wrap.dataset.streamId;
        wrap.querySelector(".media-item__main")?.classList.toggle("selected", sid === String(s.stream_id));
      });
      void playStreamByMode(s);
      showPlayerChrome(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    row.appendChild(btn);

    if (adminTools) {
      const tools = document.createElement("div");
      tools.className = "vel-media-item-tools";

      const btnAssign = document.createElement("button");
      btnAssign.type = "button";
      btnAssign.className = "vel-media-item-tool vel-media-item-tool--assign";
      btnAssign.title = "Affecter à un bouquet";
      btnAssign.setAttribute("aria-label", "Affecter à un bouquet");
      btnAssign.textContent = "➡️";
      btnAssign.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openChannelAssignDialog(s.stream_id);
      });

      const btnRemove = document.createElement("button");
      btnRemove.type = "button";
      btnRemove.className = "vel-media-item-tool vel-media-item-tool--remove";
      btnRemove.title = "Retirer cette chaîne";
      btnRemove.setAttribute("aria-label", "Retirer cette chaîne");
      btnRemove.textContent = "🗑️";
      btnRemove.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!window.confirm("Retirer cette chaîne de toutes les listes ?")) return;
        void (async () => {
          const ok = await persistStreamCuration(s.stream_id, STREAM_CURATION_HIDDEN);
          if (ok) renderPackageChannelList();
        })();
      });

      tools.append(btnAssign, btnRemove);
      row.appendChild(tools);
    }

    elDynamicList.appendChild(row);
  }

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.textContent =
      uiAdminPackageId && isLikelyUuid(uiAdminPackageId)
        ? "Ce bouquet Supabase n’a pas encore de catégories / règles liées au catalogue fournisseur dans la base."
        : "Aucune chaîne dans cette catégorie.";
    elDynamicList.appendChild(empty);
  }

  syncAdminAddChannelsButton();
}

function providerLayoutForUiTab(): AdminConfig {
  if (uiTab === "movies") return vodAdminConfig;
  if (uiTab === "series") return seriesAdminConfig;
  return adminConfig;
}

/** Pays du header : même liste que le live (catalogue + Supabase), aussi pour Films / Séries. */
function countryRowsForSelect(): AdminCountry[] {
  const provider = adminConfig.countries;
  const seen = new Set(provider.map((c) => c.name.trim().toLowerCase()));
  const out: AdminCountry[] = [...provider];
  for (const c of dbAdminCountries) {
    const k = c.name.trim().toLowerCase();
    if (seen.has(k)) continue;
    out.push(c);
    seen.add(k);
  }
  out.sort((a, b) => {
    if (a.id === OTHER_COUNTRY_ID) return 1;
    if (b.id === OTHER_COUNTRY_ID) return -1;
    return a.name.localeCompare(b.name, "fr");
  });
  return out;
}

/** `VITE_DEFAULT_COUNTRY`: id exact, sinon nom affiché (normalisé comme le catalogue). */
function defaultCountryIdFromEnv(countries: AdminCountry[]): string | null {
  const raw = import.meta.env.VITE_DEFAULT_COUNTRY?.trim();
  if (!raw) return null;
  if (countries.some((c) => c.id === raw)) return raw;
  const nk = normalizeCountryKey(raw);
  if (!nk) return null;
  const hit = countries.find((c) => normalizeCountryKey(c.name) === nk);
  return hit?.id ?? null;
}

function ensureSelectedCountry(): void {
  const countries = countryRowsForSelect();
  if (countries.length === 0) {
    selectedAdminCountryId = null;
    return;
  }
  const valid =
    selectedAdminCountryId != null &&
    countries.some((c) => c.id === selectedAdminCountryId);
  if (valid) return;
  try {
    const stored = sessionStorage.getItem(COUNTRY_STORAGE_KEY);
    if (stored && countries.some((c) => c.id === stored)) {
      selectedAdminCountryId = stored;
      return;
    }
  } catch {
    /* ignore */
  }
  const fromEnv = defaultCountryIdFromEnv(countries);
  if (fromEnv) {
    selectedAdminCountryId = fromEnv;
    return;
  }
  selectedAdminCountryId = countries[0]?.id ?? null;
}

function populateCountrySelectFromAdmin(): void {
  elCountrySelect.innerHTML = "";
  const countries = countryRowsForSelect();
  if (countries.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.disabled = true;
    o.selected = true;
    o.textContent = "Aucun pays";
    elCountrySelect.appendChild(o);
    elCountrySelect.disabled = true;
    return;
  }
  elCountrySelect.disabled = false;
  ensureSelectedCountry();
  for (const c of countries) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    if (c.id === selectedAdminCountryId) o.selected = true;
    elCountrySelect.appendChild(o);
  }
}

function readAdminGridToolsEnabled(): boolean {
  if (!isAdminSession()) return false;
  try {
    if (localStorage.getItem(ADMIN_GRID_TOOLS_KEY) === "0") return false;
  } catch {
    /* ignore */
  }
  return true;
}

/** Grille bouquets : Live, Films ou Séries (overrides image + thème comme le live). */
function isPackagesGridTab(): boolean {
  return uiTab === "live" || uiTab === "movies" || uiTab === "series";
}

function syncAdminGridToolsToggleFromStorage(): void {
  if (!elToggleAdminUi) return;
  const on = readAdminGridToolsEnabled();
  elToggleAdminUi.checked = on;
  elToggleAdminUi.setAttribute("aria-checked", on ? "true" : "false");
}

function syncAdminSettingsButton(): void {
  const admin = isAdminSession();
  elBtnSettings?.classList.toggle("hidden", !admin);
  elVelAdminToolsWrap?.classList.toggle("hidden", !admin);
  elBtnLogout?.classList.toggle("hidden", !admin);
  elMain.classList.toggle("main--velora-admin", admin);
  if (admin) syncAdminGridToolsToggleFromStorage();
}

tryConsumeAdminAccessFromUrl();
syncAdminSettingsButton();
applySettingsRouteOnLoad();

elBtnSettings?.addEventListener("click", () => {
  openSettingsPage();
});

elToggleAdminUi?.addEventListener("change", () => {
  try {
    localStorage.setItem(ADMIN_GRID_TOOLS_KEY, elToggleAdminUi.checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  elToggleAdminUi.setAttribute("aria-checked", elToggleAdminUi.checked ? "true" : "false");
  if (!elToggleAdminUi.checked && elDialogAddPkg.open) {
    elDialogAddPkg.close();
  }
  if (!elToggleAdminUi.checked && elDialogChannelAssign?.open) {
    closeChannelAssignDialog();
  }
  if (!elToggleAdminUi.checked && elDialogPackageCover?.open) {
    elDialogPackageCover.close();
  }
  if (!elToggleAdminUi.checked && elDialogAddChannels?.open) {
    closeAddChannelsToPackageDialog();
  }
  if (state && uiShell === "packages") {
    renderPackagesGrid();
  }
  if (state && uiShell === "content" && uiAdminPackageId) {
    renderPackageChannelList();
  }
  syncAdminAddChannelsButton();
});

window.addEventListener("popstate", () => {
  tryConsumeAdminAccessFromUrl();
  syncAdminSettingsButton();
  syncSettingsFromUrl();
});

window.addEventListener("velora-admin-session-changed", () => {
  syncAdminSettingsButton();
  void refreshSupabaseHierarchy().then(() => {
    if (state && uiShell === "packages") renderPackagesGrid();
    if (state && uiShell === "content" && uiAdminPackageId) {
      renderPackageChannelList();
    }
    syncAdminAddChannelsButton();
  });
});

window.addEventListener("velora-settings-closed", () => {
  applyVeloraShellBgToMain(elMain);
  if (state) {
    void (async () => {
      await fetchAndApplyCanonicalCountries();
      await fetchAndApplyChannelNamePrefixes();
      await fetchAndApplyChannelHideNeedles();
      await refreshSupabaseHierarchy();
      if (uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
    })();
  }
  if (envAutoConnectConfigured() && !state) {
    prepareEnvAutoconnectUi();
    void connect();
  }
});

/** Bouquets fournisseur (live / VOD / séries) pour le pays sélectionné dans le header. */
function packagesForSelectedCountry(): AdminPackage[] {
  const layout = providerLayoutForUiTab();
  const liveCountries = adminConfig.countries;
  if (!selectedAdminCountryId) return [];
  if (isLikelyUuid(selectedAdminCountryId)) {
    /* Canonical pays from Supabase use UUID ids — same shape as admin_countries. */
    if (liveCountries.some((c) => c.id === selectedAdminCountryId)) {
      return layout.packages
        .filter((p) => p.country_id === selectedAdminCountryId)
        .sort((a, b) => a.name.localeCompare(b.name, "fr"));
    }
    const dbC = dbAdminCountries.find((c) => c.id === selectedAdminCountryId);
    if (!dbC) return [];
    const key = normalizeCountryKey(dbC.name);
    if (!key) return [];
    const prov = liveCountries.find((c) => normalizeCountryKey(c.name) === key);
    if (!prov) return [];
    return layout.packages
      .filter((p) => p.country_id === prov.id)
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }
  return layout.packages
    .filter((p) => p.country_id === selectedAdminCountryId)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function currentCountryDisplayLabel(): string | null {
  if (!selectedAdminCountryId) return null;
  if (isLikelyUuid(selectedAdminCountryId)) {
    const dbC = dbAdminCountries.find((c) => c.id === selectedAdminCountryId);
    if (dbC) return dbC.name;
    const liveProv = adminConfig.countries.find((c) => c.id === selectedAdminCountryId);
    if (liveProv) return liveProv.name;
    return null;
  }
  const prov = adminConfig.countries.find((c) => c.id === selectedAdminCountryId);
  return prov?.name ?? null;
}

function isSelectedCountryFrance(): boolean {
  const n = currentCountryDisplayLabel();
  return n != null && normalizeCountryKey(n) === "france";
}

function providerCategoryIdsForCurrentCountry(): string[] {
  return packagesForSelectedCountry()
    .filter((p) => !isLikelyUuid(p.id))
    .map((p) => p.id);
}

function unionStreamsForCurrentCountry(): LiveStream[] {
  if (!state) return [];
  return collectStreamsFromProviderCategories(
    state.streamsByCatAll,
    providerCategoryIdsForCurrentCountry()
  );
}

function curationMapForSelection(): Map<number, string> | null {
  const cid = resolvedDbCountryIdForAdminPackages();
  if (!cid) return null;
  return streamCurationByCountry.get(cid) ?? new Map();
}

function streamsDisplayedForOpenPackage(packageId: string): LiveStream[] {
  if (!state) return [];
  if (uiTab === "movies") {
    return state.vodStreamsByCat.get(String(packageId)) ?? [];
  }
  if (uiTab === "series") {
    return state.seriesStreamsByCat.get(String(packageId)) ?? [];
  }
  return listStreamsForOpenedPackage({
    packageId,
    streamsByCatAll: state.streamsByCatAll,
    unionStreamsForCountry: unionStreamsForCurrentCountry(),
    isFranceContext: isSelectedCountryFrance(),
    isLikelyUuidPackage: isLikelyUuid,
    curationForSelectedDbCountry: curationMapForSelection(),
  });
}

/** Icône fallback grille / thème : uniquement des chaînes visibles (hors « Mots masqués — noms »). */
function streamsForPackageCoverFallback(packageId: string): LiveStream[] {
  return streamsDisplayedForOpenPackage(packageId).filter((s) => !shouldHideChannelByName(s.name));
}

async function refreshSupabaseHierarchy(): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) {
    dbAdminCountries = [];
    dbAdminPackages = [];
    streamCurationByCountry = new Map();
    packageCoverOverrides = new Map();
    populateCountrySelectFromAdmin();
    return;
  }
  try {
    const [countries, packages] = await Promise.all([fetchDbAdminCountries(sb), fetchDbAdminPackages(sb)]);
    dbAdminCountries = countries;
    dbAdminPackages = packages;
    try {
      streamCurationByCountry = await fetchDbStreamCurations(sb);
    } catch {
      streamCurationByCountry = new Map();
    }
    try {
      packageCoverOverrides = await fetchDbPackageCoverOverrides(sb);
    } catch {
      packageCoverOverrides = new Map();
    }
  } catch {
    dbAdminCountries = [];
    dbAdminPackages = [];
    streamCurationByCountry = new Map();
    packageCoverOverrides = new Map();
  }
  populateCountrySelectFromAdmin();
}

function matchedDbCountryIdForSelection(): string | null {
  if (!selectedAdminCountryId) return null;
  if (isLikelyUuid(selectedAdminCountryId)) {
    if (dbAdminCountries.some((c) => c.id === selectedAdminCountryId)) {
      return selectedAdminCountryId;
    }
    /** Pays du catalogue (ex. UUID `canonical_countries`) — lier au pays Supabase par nom affiché. */
    const prov = adminConfig.countries.find((x) => x.id === selectedAdminCountryId);
    if (prov) return matchDbCountryIdByDisplayName(prov.name, dbAdminCountries);
    return null;
  }
  const c = adminConfig.countries.find((x) => x.id === selectedAdminCountryId);
  if (!c) return null;
  return matchDbCountryIdByDisplayName(c.name, dbAdminCountries);
}

/**
 * `admin_countries.id` pour packages Supabase + curations : reprend `matchedDbCountryIdForSelection`,
 * puis le libellé pays du header si le catalogue et Supabase n’alignent pas les ids.
 */
function resolvedDbCountryIdForAdminPackages(): string | null {
  const m = matchedDbCountryIdForSelection();
  if (m) return m;
  const label = currentCountryDisplayLabel();
  if (!label) return null;
  return matchDbCountryIdByDisplayName(label, dbAdminCountries);
}

function augmentChannelAssignPackagesFromDb(base: AdminPackage[]): AdminPackage[] {
  const byId = new Map(base.map((p) => [p.id, p]));
  const sid = resolvedDbCountryIdForAdminPackages();
  const label = currentCountryDisplayLabel();
  const labelKey = label ? normalizeCountryKey(label) : "";
  for (const p of dbAdminPackages) {
    if (byId.has(p.id)) continue;
    if (sid && p.country_id === sid) {
      byId.set(p.id, p);
      continue;
    }
    if (labelKey) {
      const dc = dbAdminCountries.find((c) => c.id === p.country_id);
      if (dc && normalizeCountryKey(dc.name) === labelKey) {
        byId.set(p.id, p);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function mergedPackagesForGrid(): AdminPackage[] {
  const provider = packagesForSelectedCountry();
  if (uiTab === "movies" || uiTab === "series") {
    return [...provider].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }
  const sid = resolvedDbCountryIdForAdminPackages();
  const fromDb = sid ? dbAdminPackages.filter((p) => p.country_id === sid) : [];
  const base = [...fromDb, ...provider];
  if (isSelectedCountryFrance() && selectedAdminCountryId) {
    for (const t of FRANCE_SYNTH_PACKAGES) {
      base.push({
        id: t.id,
        country_id: selectedAdminCountryId,
        name: t.name,
      });
    }
  }
  return base.sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function findPackageById(packageId: string): AdminPackage | undefined {
  if (uiTab === "live" && isSelectedCountryFrance() && selectedAdminCountryId) {
    const syn = FRANCE_SYNTH_PACKAGES.find((t) => t.id === packageId);
    if (syn) {
      return { id: syn.id, country_id: selectedAdminCountryId, name: syn.name };
    }
  }
  return (
    providerLayoutForUiTab().packages.find((p) => p.id === packageId) ??
    (uiTab === "live" ? dbAdminPackages.find((p) => p.id === packageId) : undefined)
  );
}

function httpsCatalogCoverOverride(packageId: string): string | null {
  const u = packageCoverOverrides.get(packageId)?.trim();
  return u && /^https?:\/\//i.test(u) ? u : null;
}

/** See `imageUrlForDisplay` (R2 `*.r2.dev` = direct; other HTTPS = `/proxy`). */
function packageCoverImageSrc(href: string): string {
  return imageUrlForDisplay(href);
}

function appendAddPackageCard(): void {
  const add = document.createElement("button");
  add.type = "button";
  add.className = "vel-package-card vel-package-card--add";
  add.setAttribute("aria-label", "Nouveau package Supabase");
  const plus = document.createElement("span");
  plus.className = "vel-package-card__add-plus";
  plus.setAttribute("aria-hidden", "true");
  plus.textContent = "+";
  const title = document.createElement("span");
  title.className = "vel-package-card__title";
  title.textContent = "Nouveau package";
  add.append(plus, title);
  add.addEventListener("click", () => openAddPackageDialog());
  elPackagesView.appendChild(add);
}

/** Nearly square grid art fills the card; horizontal / vertical images stay fully visible (`contain`). */
const PACKAGE_CARD_SQUARE_RATIO_EPS = 0.1;

function isNearlySquarePackageArt(nw: number, nh: number): boolean {
  if (nw < 2 || nh < 2) return false;
  const r = nw / nh;
  return r >= 1 - PACKAGE_CARD_SQUARE_RATIO_EPS && r <= 1 + PACKAGE_CARD_SQUARE_RATIO_EPS;
}

function wirePackageCardArtFit(img: HTMLImageElement): void {
  img.classList.add("vel-package-card__art");
  const apply = (): void => {
    img.classList.remove("vel-package-card__art--cover", "vel-package-card__art--contain");
    img.classList.add(
      isNearlySquarePackageArt(img.naturalWidth, img.naturalHeight)
        ? "vel-package-card__art--cover"
        : "vel-package-card__art--contain"
    );
  };
  img.addEventListener("load", apply);
  if (img.complete) queueMicrotask(apply);
}

function renderPackagesGrid(): void {
  elPackagesView.innerHTML = "";
  const st = state;
  if (!st) return;
  const gridEmojiFallback = uiTab === "movies" ? "🎬" : uiTab === "series" ? "📺" : "📡";

  if (countryRowsForSelect().length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.style.gridColumn = "1 / -1";
    empty.textContent =
      "Aucun pays (ni dans le catalogue, ni dans Supabase). Connectez-vous ou ajoutez des pays via l’admin Supabase / le dialogue « + ».";
    elPackagesView.appendChild(empty);
    return;
  }

  if (!selectedAdminCountryId) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.style.gridColumn = "1 / -1";
    empty.textContent = "Sélectionnez un pays.";
    elPackagesView.appendChild(empty);
    return;
  }

  const showAdminPackageImageTools =
    isAdminSession() &&
    Boolean(getSupabaseClient()) &&
    readAdminGridToolsEnabled() &&
    isPackagesGridTab();
  const showAdminLiveGridExtras = showAdminPackageImageTools && uiTab === "live";
  if (showAdminLiveGridExtras) appendAddPackageCard();

  const pkgs = mergedPackagesForGrid();
  for (const pkg of pkgs) {
    const isDb = isLikelyUuid(pkg.id);
    const matched = streamsForPackageCoverFallback(pkg.id);
    const channelFirstIcon = matched
      .map((s) => resolvedIconUrl(s.stream_icon, st.base))
      .find(Boolean);

    if (isDb) {
      const card = document.createElement("div");
      card.className = "vel-package-card vel-package-card--db";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.dataset.packageId = pkg.id;
      card.setAttribute("aria-label", pkg.name);

      if (showAdminPackageImageTools) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "admin-pkg-edit-sb";
        edit.setAttribute("aria-label", `Image — ${pkg.name}`);
        edit.title =
          uiTab === "live"
            ? "Modifier l’image du bouquet"
            : "Modifier l’image de la catégorie (affiche + thème)";
        edit.textContent = "🖼";
        edit.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openPackageCoverEditDialog(pkg);
        });
        card.appendChild(edit);
      }
      if (showAdminLiveGridExtras) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "admin-pkg-del-sb";
        del.dataset.packageId = pkg.id;
        del.setAttribute("aria-label", `Supprimer ${pkg.name}`);
        del.textContent = "×";
        del.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void deleteDbPackageById(pkg.id);
        });
        card.appendChild(del);
      }

      const cover = pkg.cover_url?.trim();
      const useCover = Boolean(cover && /^https?:\/\//i.test(cover));
      if (useCover && cover) {
        const img = document.createElement("img");
        img.alt = "";
        img.setAttribute("role", "presentation");
        img.src = packageCoverImageSrc(cover);
        wirePackageCardArtFit(img);
        img.addEventListener("error", () => {
          if (isPackageCoverDebugEnabled()) {
            console.warn("[package-cover] grid img error (db package)", {
              packageId: pkg.id,
              rawCoverUrl: cover,
              imgSrc: img.src,
            });
          }
          img.remove();
          if (channelFirstIcon) {
            const img2 = document.createElement("img");
            img2.alt = "";
            img2.setAttribute("role", "presentation");
            img2.src = proxiedUrl(channelFirstIcon);
            wirePackageCardArtFit(img2);
            img2.addEventListener("error", () => {
              img2.remove();
              const em = document.createElement("span");
              em.className = "vel-package-card__emoji";
              em.textContent = "📦";
              em.setAttribute("aria-hidden", "true");
              card.appendChild(em);
            });
            card.appendChild(img2);
          } else {
            const em = document.createElement("span");
            em.className = "vel-package-card__emoji";
            em.textContent = "📦";
            em.setAttribute("aria-hidden", "true");
            card.appendChild(em);
          }
        });
        card.appendChild(img);
      } else if (channelFirstIcon) {
        const img = document.createElement("img");
        img.alt = "";
        img.setAttribute("role", "presentation");
        img.src = proxiedUrl(channelFirstIcon);
        wirePackageCardArtFit(img);
        img.addEventListener("error", () => {
          img.remove();
          const em = document.createElement("span");
          em.className = "vel-package-card__emoji";
          em.textContent = "📦";
          em.setAttribute("aria-hidden", "true");
          card.appendChild(em);
        });
        card.appendChild(img);
      } else {
        const em = document.createElement("span");
        em.className = "vel-package-card__emoji";
        em.textContent = "📦";
        em.setAttribute("aria-hidden", "true");
        card.appendChild(em);
      }

      const title = document.createElement("span");
      title.className = "vel-package-card__title";
      title.textContent = pkg.name;
      card.appendChild(title);

      card.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".admin-pkg-del-sb, .admin-pkg-edit-sb"))
          return;
        openAdminPackage(pkg.id);
      });
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openAdminPackage(pkg.id);
        }
      });
      elPackagesView.appendChild(card);
      continue;
    }

    const card = document.createElement("button");
    card.type = "button";
    card.className = "vel-package-card";
    card.dataset.packageId = pkg.id;
    card.setAttribute("aria-label", pkg.name);

    if (showAdminPackageImageTools) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "admin-pkg-edit-sb";
      edit.setAttribute("aria-label", `Image — ${pkg.name}`);
      edit.title =
        uiTab === "live"
          ? "Modifier l’image du bouquet"
          : "Modifier l’image de la catégorie (affiche + thème)";
      edit.textContent = "🖼";
      edit.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openPackageCoverEditDialog(pkg);
      });
      card.appendChild(edit);
    }

    const httpsOverride = httpsCatalogCoverOverride(pkg.id);
    const appendEmoji = (sym: string) => {
      const em = document.createElement("span");
      em.className = "vel-package-card__emoji";
      em.textContent = sym;
      em.setAttribute("aria-hidden", "true");
      card.appendChild(em);
    };
    const appendProxiedIcon = (href: string, onFailEmoji: string) => {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("role", "presentation");
      img.src = proxiedUrl(href);
      wirePackageCardArtFit(img);
      img.addEventListener("error", () => {
        img.remove();
        appendEmoji(onFailEmoji);
      });
      card.appendChild(img);
    };

    if (httpsOverride) {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("role", "presentation");
      img.src = packageCoverImageSrc(httpsOverride);
      wirePackageCardArtFit(img);
      img.addEventListener("error", () => {
        if (isPackageCoverDebugEnabled()) {
          console.warn("[package-cover] grid img error (catalog override)", {
            packageId: pkg.id,
            rawUrl: httpsOverride,
            imgSrc: img.src,
          });
        }
        img.remove();
        if (channelFirstIcon) appendProxiedIcon(channelFirstIcon, gridEmojiFallback);
        else appendEmoji(gridEmojiFallback);
      });
      card.appendChild(img);
    } else if (channelFirstIcon) {
      appendProxiedIcon(channelFirstIcon, gridEmojiFallback);
    } else {
      appendEmoji(gridEmojiFallback);
    }

    const title = document.createElement("span");
    title.className = "vel-package-card__title";
    title.textContent = pkg.name;
    card.appendChild(title);

    card.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".admin-pkg-edit-sb")) return;
      openAdminPackage(pkg.id);
    });
    elPackagesView.appendChild(card);
  }

  if (pkgs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.style.gridColumn = "1 / -1";
    empty.textContent =
      uiTab === "movies"
        ? "Aucun bouquet (catégorie) VOD pour ce pays. Essayez un autre pays ou « Autres »."
        : uiTab === "series"
          ? "Aucun bouquet (catégorie) séries pour ce pays. Essayez un autre pays ou « Autres »."
          : "Aucune catégorie live pour ce pays dans le catalogue fournisseur. Essayez un autre pays ou « Autres ».";
    elPackagesView.appendChild(empty);
  }
}

function openAdminPackage(packageId: string): void {
  if (!state) return;
  const pkg = findPackageById(packageId);
  if (!pkg) return;
  const tab: UiTab = uiTab === "movies" || uiTab === "series" ? uiTab : "live";
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  destroyVodPlayer();
  uiShell = "content";
  uiTab = tab;
  uiAdminPackageId = packageId;
  setTabsActive(tab);
  applyThemeForPackage(pkg);
  elPackagesView.classList.add("hidden");
  elMainTabs.classList.add("hidden");
  elContentView.classList.remove("hidden");
  selectedPillId = "all";
  syncPillDefsForPackage(packageId);
  renderCategoryPills();
  updatePillsVisibility();
  syncAdminAddChannelsButton();
  syncPlayerDismissOverlay();
}

/** Grille bouquets : conserve l’onglet (Live / Films / Séries). */
function showPackagesShell(): void {
  activeStreamId = null;
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  destroyVodPlayer();
  uiShell = "packages";
  uiAdminPackageId = null;
  setTabsActive(uiTab);
  applyPresetTheme("default");
  elPackagesView.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.add("hidden");
  elContentView.classList.remove("content-view--vod-film-detail");
  elDynamicList.classList.remove("item-list--vod-film-detail");
  elCatPillsWrap.classList.add("hidden");
  selectedPillId = "all";
  syncAdminAddChannelsButton();
  if (state) renderPackagesGrid();
  syncPlayerDismissOverlay();
}

function goLiveHome(): void {
  uiTab = "live";
  showPackagesShell();
}

async function deleteDbPackageById(packageId: string): Promise<void> {
  if (!isLikelyUuid(packageId)) return;
  if (
    !window.confirm("Supprimer ce package Supabase ? Les catégories liées seront supprimées (cascade).")
  ) {
    return;
  }
  const sb = getSupabaseClient();
  if (!sb) return;
  const { error } = await sb.from("admin_packages").delete().eq("id", packageId);
  if (error) {
    setLoginStatus(error.message, true);
    return;
  }
  await refreshSupabaseHierarchy();
  if (state && uiShell === "packages" && uiTab === "live") {
    renderPackagesGrid();
  }
}

/** One row per normalized pays name (évite les doublons « France » si plusieurs lignes en base). */
function dedupeCountriesByDisplayName(countries: AdminCountry[]): AdminCountry[] {
  if (countries.length === 0) return [];
  const sorted = [...countries].sort((a, b) => a.id.localeCompare(b.id));
  const byKey = new Map<string, AdminCountry>();
  for (const c of sorted) {
    const nk = normalizeCountryKey(c.name);
    const key = nk.length > 0 ? nk : `__id:${c.id}`;
    if (!byKey.has(key)) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/** `admin_packages.country_id` : réutilise `admin_countries` si le nom correspond, sinon insert. */
async function resolveSupabaseCountryIdForNewPackage(selectionValue: string): Promise<string | null> {
  const v = selectionValue.trim();
  if (!v) return null;
  if (isLikelyUuid(v) && dbAdminCountries.some((c) => c.id === v)) return v;
  const row = countryRowsForSelect().find((c) => c.id === v);
  if (!row) return null;
  const name = row.name.trim();
  if (!name) return null;
  const existing = matchDbCountryIdByDisplayName(name, dbAdminCountries);
  if (existing) return existing;
  const sb = getSupabaseClient();
  if (!sb) return null;
  const { data, error } = await sb.from("admin_countries").insert({ name }).select("id").single();
  if (!error && data && typeof data === "object" && "id" in data) {
    await refreshSupabaseHierarchy();
    return String((data as { id: string }).id);
  }
  await refreshSupabaseHierarchy();
  return matchDbCountryIdByDisplayName(name, dbAdminCountries);
}

function populateAddPackageDialogCountries(): void {
  elDapSbCountry.innerHTML = "";
  const pickList = dedupeCountriesByDisplayName(countryRowsForSelect());
  if (pickList.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "— Connectez-vous au catalogue ou créez un pays ci-dessous —";
    o.disabled = true;
    o.selected = true;
    elDapSbCountry.appendChild(o);
    elDapSbCountry.disabled = true;
    return;
  }
  elDapSbCountry.disabled = false;
  for (const c of pickList) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    elDapSbCountry.appendChild(o);
  }
}

function preselectDapCountryFromHeader(): void {
  const opts = [...elDapSbCountry.options].filter((o) => o.value && !o.disabled);
  if (!opts.length || elDapSbCountry.disabled) return;
  const tryVal = (val: string | null | undefined): boolean => {
    if (!val) return false;
    if (opts.some((o) => o.value === val)) {
      elDapSbCountry.value = val;
      return true;
    }
    return false;
  };
  if (tryVal(selectedAdminCountryId)) return;
  const label = currentCountryDisplayLabel();
  if (label) {
    const nk = normalizeCountryKey(label);
    const hit = countryRowsForSelect().find((c) => normalizeCountryKey(c.name) === nk);
    if (hit && tryVal(hit.id)) return;
  }
  if (tryVal(resolvedDbCountryIdForAdminPackages())) return;
  elDapSbCountry.selectedIndex = 0;
}

function openAddPackageDialog(): void {
  const sb = getSupabaseClient();
  if (!isAdminSession() || !readAdminGridToolsEnabled() || !sb) return;
  elDapStatus.textContent = "";
  elDapStatus.classList.remove("error");
  elDapNewCountryName.value = "";
  elDapCover.value = "";
  syncCoverUploadVisual("dap");
  populateAddPackageDialogCountries();
  const merged = countryRowsForSelect();
  const hasCatalogueCountries = merged.length > 0;
  document.getElementById("dap-create-country-field")?.classList.toggle("hidden", hasCatalogueCountries);
  elDapEmptyCountriesHint?.classList.toggle("hidden", hasCatalogueCountries);
  preselectDapCountryFromHeader();
  elDapName.value = "";
  elDialogAddPkg.showModal();
  queueMicrotask(() => {
    if (!hasCatalogueCountries) elDapNewCountryName.focus();
    else elDapName.focus();
  });
}

function closeAddPackageDialog(): void {
  elDialogAddPkg.close();
}

function revokeCoverPreviewObjectUrl(side: "pce" | "dap"): void {
  if (side === "pce") {
    if (pceCoverPreviewObjectUrl) {
      URL.revokeObjectURL(pceCoverPreviewObjectUrl);
      pceCoverPreviewObjectUrl = null;
    }
  } else if (dapCoverPreviewObjectUrl) {
    URL.revokeObjectURL(dapCoverPreviewObjectUrl);
    dapCoverPreviewObjectUrl = null;
  }
}

function syncCoverUploadVisual(side: "pce" | "dap"): void {
  const input = side === "pce" ? elPceCover : elDapCover;
  const empty = side === "pce" ? elPceCoverEmpty : elDapCoverEmpty;
  const wrap = side === "pce" ? elPceCoverPreviewWrap : elDapCoverPreviewWrap;
  const img = side === "pce" ? elPceCoverPreview : elDapCoverPreview;
  const pick = side === "pce" ? elPceCoverPick : elDapCoverPick;
  const zone = side === "pce" ? elPceDropzone : elDapDropzone;
  revokeCoverPreviewObjectUrl(side);
  const f = input?.files?.[0];
  if (!f) {
    if (img) {
      img.removeAttribute("src");
      img.alt = "";
    }
    empty?.classList.remove("hidden");
    wrap?.classList.add("hidden");
    if (pick) pick.textContent = "Choisir une image";
    zone?.classList.remove("cover-upload__card--has-file");
    return;
  }
  const url = URL.createObjectURL(f);
  if (side === "pce") pceCoverPreviewObjectUrl = url;
  else dapCoverPreviewObjectUrl = url;
  if (img) {
    img.src = url;
    img.alt = `Aperçu : ${f.name}`;
  }
  empty?.classList.add("hidden");
  wrap?.classList.remove("hidden");
  if (pick) pick.textContent = "Changer l’image";
  zone?.classList.add("cover-upload__card--has-file");
}

async function assignCoverAfterCrop(
  input: HTMLInputElement | null,
  sync: () => void,
  file: File
): Promise<void> {
  if (!input) return;
  const cropped = await runCoverSquareCrop(file);
  input.value = "";
  if (!cropped) {
    sync();
    return;
  }
  const dt = new DataTransfer();
  dt.items.add(cropped);
  input.files = dt.files;
  sync();
}

function wirePackageCoverDropZone(
  zone: HTMLElement | null,
  input: HTMLInputElement | null,
  sync: () => void,
  afterCrop: (input: HTMLInputElement | null, sync: () => void, file: File) => Promise<void>
): void {
  if (!zone || !input) return;
  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    const rel = e.relatedTarget as Node | null;
    if (rel && zone.contains(rel)) return;
    zone.classList.add("cover-upload__card--drag");
  });
  zone.addEventListener("dragleave", (e) => {
    const rel = e.relatedTarget as Node | null;
    if (rel && zone.contains(rel)) return;
    zone.classList.remove("cover-upload__card--drag");
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("cover-upload__card--drag");
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    void afterCrop(input, sync, file);
  });
}

(function wireCoverUploadControls(): void {
  const syncPce = (): void => syncCoverUploadVisual("pce");
  const syncDap = (): void => syncCoverUploadVisual("dap");
  elPceCoverPick?.addEventListener("click", () => elPceCover?.click());
  elDapCoverPick?.addEventListener("click", () => elDapCover?.click());
  elPceCover?.addEventListener("change", () => {
    const f = elPceCover?.files?.[0];
    if (!f) {
      syncPce();
      return;
    }
    void assignCoverAfterCrop(elPceCover, syncPce, f);
  });
  elDapCover?.addEventListener("change", () => {
    const f = elDapCover?.files?.[0];
    if (!f) {
      syncDap();
      return;
    }
    void assignCoverAfterCrop(elDapCover, syncDap, f);
  });
  wirePackageCoverDropZone(elPceDropzone, elPceCover, syncPce, assignCoverAfterCrop);
  wirePackageCoverDropZone(elDapDropzone, elDapCover, syncDap, assignCoverAfterCrop);
})();

function openPackageCoverEditDialog(pkg: AdminPackage): void {
  if (!elDialogPackageCover || !elPcePackageId || !elPceCover) return;
  const sb = getSupabaseClient();
  if (!isAdminSession() || !readAdminGridToolsEnabled() || !sb) return;
  elPcePackageId.value = pkg.id;
  if (elPcePackageName) elPcePackageName.textContent = pkg.name;
  elPceCover.value = "";
  syncCoverUploadVisual("pce");
  elPceStatus && (elPceStatus.textContent = "");
  elPceStatus?.classList.remove("error");
  elDialogPackageCover.showModal();
}

function closePackageCoverEditDialog(): void {
  elDialogPackageCover?.close();
}

elDapCancel.addEventListener("click", () => closeAddPackageDialog());

elPceCancel?.addEventListener("click", () => closePackageCoverEditDialog());
elDialogPackageCover?.addEventListener("cancel", () => closePackageCoverEditDialog());

elPceClear?.addEventListener("click", () => {
  void (async () => {
    const id = elPcePackageId?.value.trim();
    const sb = getSupabaseClient();
    if (!id || !sb) return;
    elPceStatus && (elPceStatus.textContent = "");
    elPceStatus?.classList.remove("error");
    elPceClear.disabled = true;
    try {
      if (isLikelyUuid(id)) {
        const { error } = await sb.from("admin_packages").update({ cover_url: null }).eq("id", id);
        if (error) {
          elPceStatus && (elPceStatus.textContent = error.message);
          elPceStatus?.classList.add("error");
          return;
        }
      } else {
        const res = await deletePackageCoverOverride(sb, id);
        if (res.error) {
          elPceStatus && (elPceStatus.textContent = res.error);
          elPceStatus?.classList.add("error");
          return;
        }
      }
      invalidatePackageImageThemeCache(id);
      await refreshSupabaseHierarchy();
      closePackageCoverEditDialog();
      if (state && uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
      if (state && uiShell === "content" && uiAdminPackageId === id && isPackagesGridTab()) {
        applyThemeForPackage(findPackageById(id) ?? null);
      }
    } finally {
      elPceClear.disabled = false;
    }
  })();
});

elPceSubmit?.addEventListener("click", () => {
  void (async () => {
    const id = elPcePackageId?.value.trim();
    const sb = getSupabaseClient();
    if (!id || !sb || !elPceCover) return;
    const file = elPceCover.files?.[0];
    elPceStatus && (elPceStatus.textContent = "");
    elPceStatus?.classList.remove("error");
    if (!file) {
      elPceStatus && (elPceStatus.textContent = "Choisissez une image ou utilisez « Retirer l’image ».");
      elPceStatus?.classList.add("error");
      return;
    }

    elPceSubmit.disabled = true;
    try {
      const up = await uploadPackageCoverFile(sb, id, file);
      if ("error" in up) {
        elPceStatus && (elPceStatus.textContent = up.error);
        elPceStatus?.classList.add("error");
        return;
      }
      const finalUrl = up.url;

      if (isLikelyUuid(id)) {
        const { error } = await sb.from("admin_packages").update({ cover_url: finalUrl }).eq("id", id);
        if (error) {
          elPceStatus && (elPceStatus.textContent = error.message);
          elPceStatus?.classList.add("error");
          return;
        }
      } else {
        const res = await upsertPackageCoverOverride(sb, id, finalUrl);
        if (res.error) {
          elPceStatus && (elPceStatus.textContent = res.error);
          elPceStatus?.classList.add("error");
          return;
        }
      }

      if (isPackageCoverDebugEnabled()) {
        console.log("[package-cover] saved to Supabase", {
          packageId: id,
          row: isLikelyUuid(id) ? "admin_packages.cover_url" : "admin_package_covers",
          finalUrl,
        });
      }

      invalidatePackageImageThemeCache(id);
      await refreshSupabaseHierarchy();
      if (isPackageCoverDebugEnabled()) {
        const row = dbAdminPackages.find((p) => p.id === id);
        const ov = packageCoverOverrides.get(id)?.trim();
        console.log("[package-cover] after refreshSupabaseHierarchy", {
          packageId: id,
          cover_urlFromFetch: row?.cover_url ?? "(no admin_packages row)",
          overrideFromFetch: ov ?? "(no admin_package_covers row)",
        });
      }
      closePackageCoverEditDialog();
      if (state && uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
      if (state && uiShell === "content" && uiAdminPackageId === id && isPackagesGridTab()) {
        applyThemeForPackage(findPackageById(id) ?? null);
      }
    } finally {
      elPceSubmit.disabled = false;
    }
  })();
});

elChannelAssignCancel?.addEventListener("click", () => closeChannelAssignDialog());
elDialogChannelAssign?.addEventListener("cancel", () => closeChannelAssignDialog());
elChannelAssignOk?.addEventListener("click", () => {
  void (async () => {
    if (pendingAssignStreamId == null || !elChannelAssignSelect) return;
    const pkgId = elChannelAssignSelect.value?.trim();
    if (!pkgId) return;
    elChannelAssignStatus && (elChannelAssignStatus.textContent = "");
    elChannelAssignStatus?.classList.remove("error");
    const ok = await persistStreamCuration(pendingAssignStreamId, pkgId);
    if (!ok) {
      if (elChannelAssignStatus) {
        elChannelAssignStatus.textContent =
          "Échec de l’enregistrement. Vérifiez la table admin_stream_curations dans Supabase.";
        elChannelAssignStatus.classList.add("error");
      }
      return;
    }
    closeChannelAssignDialog();
    renderPackageChannelList();
    if (state && uiShell === "packages" && isPackagesGridTab()) {
      renderPackagesGrid();
    }
  })();
});

elBtnAdminAddChannels?.addEventListener("click", () => {
  openAddChannelsToPackageDialog();
});

elAddChannelsCancel?.addEventListener("click", () => closeAddChannelsToPackageDialog());
elDialogAddChannels?.addEventListener("cancel", () => closeAddChannelsToPackageDialog());

elAddChannelsSearch?.addEventListener("input", () => filterAddChannelsListRows());

elAddChannelsSelectVisible?.addEventListener("click", () => {
  if (!elAddChannelsList) return;
  elAddChannelsList.querySelectorAll(".add-channels-row:not(.hidden) input[type=checkbox]").forEach((cb) => {
    (cb as HTMLInputElement).checked = true;
  });
});

elAddChannelsSubmit?.addEventListener("click", () => {
  void (async () => {
    if (!elAddChannelsList || !uiAdminPackageId) return;
    const pkgId = uiAdminPackageId;
    const boxes = elAddChannelsList.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]:checked"
    );
    const ids: number[] = [];
    boxes.forEach((cb) => {
      const n = Number(cb.dataset.streamId);
      if (Number.isFinite(n)) ids.push(n);
    });
    elAddChannelsStatus && (elAddChannelsStatus.textContent = "");
    elAddChannelsStatus?.classList.remove("error");
    if (ids.length === 0) {
      elAddChannelsStatus && (elAddChannelsStatus.textContent = "Cochez au moins une chaîne.");
      elAddChannelsStatus?.classList.add("error");
      return;
    }
    elAddChannelsSubmit.disabled = true;
    let ok = 0;
    let fail = 0;
    for (const sid of ids) {
      if (await persistStreamCuration(sid, pkgId)) ok++;
      else fail++;
    }
    elAddChannelsSubmit.disabled = false;
    if (fail > 0) {
      elAddChannelsStatus &&
        (elAddChannelsStatus.textContent = `${ok} chaîne(s) ajoutée(s), ${fail} erreur(s). Réessayez ou vérifiez Supabase.`);
      elAddChannelsStatus?.classList.add("error");
      buildAddChannelsDialogList(pkgId);
      filterAddChannelsListRows();
    } else {
      closeAddChannelsToPackageDialog();
      renderPackageChannelList();
      if (state && uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
    }
  })();
});

elDapAddCountry.addEventListener("click", () => {
  void (async () => {
    const sb = getSupabaseClient();
    if (!sb) return;
    const name = elDapNewCountryName.value.trim();
    elDapStatus.textContent = "";
    elDapStatus.classList.remove("error");
    if (!name) {
      elDapStatus.textContent = "Saisissez un nom de pays.";
      elDapStatus.classList.add("error");
      return;
    }
    elDapAddCountry.disabled = true;
    const { data, error } = await sb.from("admin_countries").insert({ name }).select("id, name").single();
    elDapAddCountry.disabled = false;
    if (error) {
      elDapStatus.textContent = error.message;
      elDapStatus.classList.add("error");
      return;
    }
    elDapNewCountryName.value = "";
    await refreshSupabaseHierarchy();
    populateAddPackageDialogCountries();
    const mergedAfter = countryRowsForSelect();
    document.getElementById("dap-create-country-field")?.classList.toggle("hidden", mergedAfter.length > 0);
    elDapEmptyCountriesHint?.classList.toggle("hidden", mergedAfter.length > 0);
    const id = data && typeof data === "object" && "id" in data ? String((data as { id: string }).id) : "";
    if (id && [...elDapSbCountry.options].some((o) => o.value === id)) {
      elDapSbCountry.value = id;
    } else {
      preselectDapCountryFromHeader();
    }
    elDapStatus.textContent = "Pays ajouté. Saisissez le nom du package puis « Ajouter ».";
    elDapName.focus();
  })();
});

elDapSubmit.addEventListener("click", () => {
  void (async () => {
    const sb = getSupabaseClient();
    if (!sb) return;
    const countryId = elDapSbCountry.value?.trim();
    const name = elDapName.value.trim();
    elDapStatus.textContent = "";
    elDapStatus.classList.remove("error");
    if (!countryId) {
      elDapStatus.textContent = "Choisissez un pays dans la liste.";
      elDapStatus.classList.add("error");
      return;
    }
    if (!name) {
      elDapStatus.textContent = "Saisissez un nom.";
      elDapStatus.classList.add("error");
      return;
    }
    const file = elDapCover.files?.[0];

    elDapSubmit.disabled = true;
    const resolvedCountryId = await resolveSupabaseCountryIdForNewPackage(countryId);
    if (!resolvedCountryId) {
      elDapSubmit.disabled = false;
      elDapStatus.textContent =
        "Impossible d’associer ce pays à Supabase (admin_countries). Vérifiez les droits ou réessayez.";
      elDapStatus.classList.add("error");
      return;
    }

    const insertRow: { country_id: string; name: string; cover_url?: string | null } = {
      country_id: resolvedCountryId,
      name,
      cover_url: null,
    };
    const { data: inserted, error } = await sb
      .from("admin_packages")
      .insert(insertRow)
      .select("id")
      .single();
    if (error) {
      elDapSubmit.disabled = false;
      const dup = /unique|duplicate/i.test(error.message);
      elDapStatus.textContent = dup
        ? "Un package avec ce nom existe déjà pour ce pays."
        : error.message;
      elDapStatus.classList.add("error");
      return;
    }
    const newId = inserted && typeof inserted === "object" && "id" in inserted ? String(inserted.id) : "";
    if (file && newId) {
      const up = await uploadPackageCoverFile(sb, newId, file);
      if ("error" in up) {
        elDapStatus.textContent = `Package créé ; image non enregistrée : ${up.error}`;
        elDapStatus.classList.remove("error");
        elDapSubmit.disabled = false;
        invalidatePackageImageThemeCache(newId);
        await refreshSupabaseHierarchy();
        if (state && uiShell === "packages" && uiTab === "live") {
          renderPackagesGrid();
        }
        return;
      }
      const { error: upErr } = await sb.from("admin_packages").update({ cover_url: up.url }).eq("id", newId);
      if (upErr) {
        elDapStatus.textContent = `Package créé ; fichier reçu mais URL non sauvegardée : ${upErr.message}`;
        elDapStatus.classList.add("error");
        elDapSubmit.disabled = false;
        invalidatePackageImageThemeCache(newId);
        await refreshSupabaseHierarchy();
        if (state && uiShell === "packages" && uiTab === "live") {
          renderPackagesGrid();
        }
        return;
      }
    }
    elDapSubmit.disabled = false;
    closeAddPackageDialog();
    if (newId) invalidatePackageImageThemeCache(newId);
    await refreshSupabaseHierarchy();
    if (state && uiShell === "packages" && uiTab === "live") {
      renderPackagesGrid();
    }
  })();
});

function countStreamsInMap(m: Map<string, LiveStream[]>): number {
  let n = 0;
  for (const list of m.values()) n += list.length;
  return n;
}

function showVodPlaceholder(
  kind: "movies" | "series",
  reason: "no-nodecast" | "no-xtream-source" | "empty" = "no-nodecast"
): void {
  activeStreamId = null;
  destroyPlayer();
  destroyVodPlayer();
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  uiShell = "content";
  uiTab = kind;
  uiAdminPackageId = null;
  setTabsActive(kind);
  applyPresetTheme("default");
  elPackagesView.classList.add("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.remove("hidden");
  elCatPillsWrap.classList.add("hidden");
  elDynamicList.classList.remove("item-list--vod-vertical", "item-list--vod-film-detail");
  elContentView.classList.remove("content-view--vod-film-detail");
  elDynamicList.innerHTML = "";
  const msg = document.createElement("div");
  msg.className = "vel-empty-msg";
  if (reason === "empty") {
    msg.innerHTML =
      kind === "movies"
        ? "Aucun <strong>film</strong> (VOD) dans le catalogue pour cette source Xtream."
        : "Aucune <strong>série</strong> dans le catalogue pour cette source Xtream.";
  } else if (reason === "no-xtream-source") {
    msg.innerHTML =
      kind === "movies"
        ? "Impossible de déterminer la <strong>source Xtream</strong> pour charger les films (catalogue live sans proxy <code>api/proxy/xtream</code>)."
        : "Impossible de déterminer la <strong>source Xtream</strong> pour charger les séries (catalogue live sans proxy <code>api/proxy/xtream</code>).";
  } else {
    msg.innerHTML =
      kind === "movies"
        ? "Les <strong>films</strong> (VOD) sont disponibles après connexion <strong>Nodecast</strong> avec un proxy Xtream (<code>vod_categories</code> / <code>vod_streams</code>)."
        : "Les <strong>séries</strong> sont disponibles après connexion <strong>Nodecast</strong> avec un proxy Xtream (<code>series_categories</code> / <code>get_series</code>).";
  }
  elDynamicList.appendChild(msg);
}

function openNodecastMediaShell(tab: "movies" | "series"): void {
  void openNodecastMediaShellAsync(tab);
}

async function openNodecastMediaShellAsync(tab: "movies" | "series"): Promise<void> {
  if (!state || state.mode !== "nodecast") {
    showVodPlaceholder(tab, "no-nodecast");
    return;
  }
  const sid = state.nodecastXtreamSourceId?.trim();
  if (!sid) {
    showVodPlaceholder(tab, "no-xtream-source");
    return;
  }

  if (tab === "movies" && !state.vodCatalogLoaded) {
    setCatalogLoadingVisible(true, "Chargement des films…");
    try {
      const v = await fetchNodecastVodCatalog(state.base, sid, state.nodecastAuthHeaders);
      if (!state) return;
      state.vodCategories = v?.categories ?? [];
      state.vodStreamsByCat = v?.streamsByCat ?? new Map();
      state.vodCatalogLoaded = true;
      vodAdminConfig = buildProviderAdminConfig(state.vodCategories, state.vodStreamsByCat);
    } catch {
      if (state) {
        state.vodCategories = [];
        state.vodStreamsByCat = new Map();
        state.vodCatalogLoaded = true;
        vodAdminConfig = buildProviderAdminConfig([], new Map());
      }
    } finally {
      setCatalogLoadingVisible(false);
    }
  } else if (
    tab === "series" &&
    (!state.seriesCatalogLoaded || countStreamsInMap(state.seriesStreamsByCat) === 0)
  ) {
    setCatalogLoadingVisible(true, "Chargement des séries…");
    try {
      const s = await fetchNodecastSeriesCatalog(state.base, sid, state.nodecastAuthHeaders);
      if (!state) return;
      state.seriesCategories = s?.categories ?? [];
      state.seriesStreamsByCat = s?.streamsByCat ?? new Map();
      state.seriesCatalogLoaded = true;
      seriesAdminConfig = buildProviderAdminConfig(state.seriesCategories, state.seriesStreamsByCat);
    } catch {
      if (state) {
        state.seriesCategories = [];
        state.seriesStreamsByCat = new Map();
        state.seriesCatalogLoaded = true;
        seriesAdminConfig = buildProviderAdminConfig([], new Map());
      }
    } finally {
      setCatalogLoadingVisible(false);
    }
  }

  if (!state) return;
  const map = tab === "movies" ? state.vodStreamsByCat : state.seriesStreamsByCat;
  if (countStreamsInMap(map) === 0) {
    showVodPlaceholder(tab, "empty");
    return;
  }
  activeStreamId = null;
  destroyPlayer();
  destroyVodPlayer();
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  uiTab = tab;
  uiShell = "packages";
  uiAdminPackageId = null;
  setTabsActive(tab);
  applyPresetTheme("default");
  elPackagesView.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.add("hidden");
  elCatPillsWrap.classList.add("hidden");
  selectedPillId = "all";
  populateCountrySelectFromAdmin();
  renderPackagesGrid();
  syncAdminAddChannelsButton();
  syncPlayerDismissOverlay();
}

function onTabClick(tab: UiTab): void {
  if (tab === "live") {
    vodMovieUiPhase = "list";
    vodDetailStream = null;
    seriesUiPhase = "list";
    seriesDetailStream = null;
    destroyVodPlayer();
    goLiveHome();
    return;
  }
  if (tab === "movies") {
    seriesUiPhase = "list";
    seriesDetailStream = null;
    destroyPlayer();
  }
  if (tab === "series") {
    vodMovieUiPhase = "list";
    vodDetailStream = null;
    destroyVodPlayer();
  }
  openNodecastMediaShell(tab === "movies" ? "movies" : "series");
}

async function playStreamByMode(s: LiveStream): Promise<void> {
  if (!state) return;
  const isVodFilm = s.nodecast_media === "vod";
  const hideLiveProgress = !isVodFilm && s.nodecast_media !== "series";

  if (state.mode === "nodecast") {
    if (isVodFilm) {
      setVodPlayerBufferingVisible(true);
      showVodPlayerChrome(true);
      if (elNowPlayingVod) {
        elNowPlayingVod.innerHTML = nowPlayingLiveMarkup(displayChannelName(s.name));
      }
      let resolved: string | null = null;
      try {
        resolved = await resolveNodecastVodStreamUrl(state.base, s, state.nodecastAuthHeaders);
      } finally {
        setVodPlayerBufferingVisible(false);
      }
      if (!resolved) {
        if (elNowPlayingVod) {
          elNowPlayingVod.innerHTML = nowPlayingErrorMarkup(
            "Impossible de résoudre l’URL de ce film (proxy VOD Nodecast)."
          );
        }
        return;
      }
      if (!sameOrigin(resolved, state.base)) {
        if (elNowPlayingVod) {
          elNowPlayingVod.innerHTML = nowPlayingErrorMarkup(
            "URL de lecture externe bloquée ; proxy requis."
          );
        }
        return;
      }
      // Liste / autre navigation pendant l’await : ne pas relancer le lecteur.
      if (
        vodMovieUiPhase !== "detail" ||
        vodDetailStream == null ||
        vodDetailStream.stream_id !== s.stream_id
      ) {
        return;
      }
      s.direct_source = resolved;
      playVodUrl(resolved, displayChannelName(s.name), state.nodecastAuthHeaders);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    teardownPlaybackMedia();
    if (hideLiveProgress) {
      elPlayerContainer.classList.add("player-container--live-tv");
    } else {
      elPlayerContainer.classList.remove("player-container--live-tv");
    }
    showPlayerChrome(true);
    elNowPlaying.innerHTML = nowPlayingLiveMarkup(displayChannelName(s.name));
    let resolved: string | null = null;
    if (s.nodecast_media === "series" && s.nodecast_source_id) {
      resolved = await resolveNodecastSeriesPlayableUrl(
        state.base,
        s.stream_id,
        s.nodecast_source_id,
        state.nodecastAuthHeaders
      );
    } else {
      resolved = await resolveNodecastStreamUrl(state.base, s, state.nodecastAuthHeaders);
    }
    if (!resolved) {
      elNowPlaying.innerHTML = nowPlayingErrorMarkup(
        s.nodecast_media === "series"
          ? "Impossible de lire cette série (épisode / API get_series_info)."
          : "Impossible de résoudre l’URL de cette chaîne (API Nodecast)."
      );
      return;
    }
    if (!sameOrigin(resolved, state.base)) {
      elNowPlaying.innerHTML = nowPlayingErrorMarkup(
        "URL de lecture externe bloquée ; proxy requis."
      );
      return;
    }
    if (s.nodecast_media === "series") {
      if (
        seriesUiPhase !== "detail" ||
        seriesDetailStream == null ||
        seriesDetailStream.stream_id !== s.stream_id
      ) {
        return;
      }
    }
    s.direct_source = resolved;
    playUrl(resolved, displayChannelName(s.name), state.nodecastAuthHeaders, hideLiveProgress);
    return;
  }
  const m3u8 = buildLiveStreamUrl(
    state.serverInfo,
    state.username,
    state.password,
    s.stream_id,
    "m3u8"
  );
  playUrl(m3u8, displayChannelName(s.name), undefined, hideLiveProgress);
}

async function connect(): Promise<void> {
  applyNodecastEnvDefaults();
  setLoginStatus("");
  const base = normalizeServerInput(elServer.value);
  const username = elUser.value.trim();
  const password = elPass.value;

  if (!base || !username) {
    setLoginStatus("Renseignez l’URL et l’identifiant.", true);
    return;
  }

  if (envAutoConnectConfigured()) {
    prepareEnvAutoconnectUi();
  }

  elBtnConnect.disabled = true;
  setLoginStatus("Connexion à Nodecast…");

  try {
    setCatalogLoadingVisible(true, "Connexion au serveur…");
    const mode: "nodecast" = "nodecast";
    const nodecast = await tryNodecastLoginAndLoad(base, username, password);
    setCatalogLoadingVisible(true, "Préparation de l’accueil…");
    const streamsByCat = nodecast.streamsByCat;
    const nodecastAuthHeaders = nodecast.authHeaders;
    const serverInfo: ServerInfo = {
      url: new URL(base).hostname,
      port: new URL(base).port || (new URL(base).protocol === "https:" ? "443" : "80"),
      server_protocol: new URL(base).protocol.replace(":", ""),
    };

    await fetchAndApplyCanonicalCountries();
    await fetchAndApplyChannelNamePrefixes();
    await fetchAndApplyChannelHideNeedles();
    adminConfig = buildProviderAdminConfig(nodecast.categories, streamsByCat);
    vodAdminConfig = buildProviderAdminConfig(nodecast.vodCategories, nodecast.vodStreamsByCat);
    seriesAdminConfig = buildProviderAdminConfig(nodecast.seriesCategories, nodecast.seriesStreamsByCat);
    await refreshSupabaseHierarchy();

    state = {
      mode,
      base,
      username,
      password,
      nodecastAuthHeaders,
      serverInfo: serverInfo!,
      streamsByCatAll: new Map(streamsByCat),
      nodecastXtreamSourceId: nodecast.nodecastXtreamSourceId,
      vodCategories: nodecast.vodCategories,
      vodStreamsByCat: nodecast.vodStreamsByCat,
      seriesCategories: nodecast.seriesCategories,
      seriesStreamsByCat: nodecast.seriesStreamsByCat,
      vodCatalogLoaded: false,
      seriesCatalogLoaded: false,
    };

    selectedPillId = "all";
    activeStreamId = null;
    destroyPlayer();
    destroyVodPlayer();
    elNowPlaying.textContent = "";

    goLiveHome();
    elLoginPanel.classList.add("hidden");
    elMain.classList.remove("hidden");
    syncAdminSettingsButton();
    setLoginStatus("");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setLoginStatus(msg, true);
    if (envAutoConnectConfigured()) {
      elMain.classList.remove("hidden");
      elLoginPanel.classList.add("hidden");
      elHeaderLoginOnly?.classList.add("hidden");
      elPackagesView.classList.remove("hidden");
      elPackagesView.innerHTML = `<div class="vel-empty-msg" style="grid-column: 1 / -1; text-align: center; padding: 2rem 1rem; color: #fca5a5">${escapeHtml(msg)}</div>`;
    } else {
      elMain.classList.add("hidden");
      elLoginPanel.classList.remove("hidden");
      elHeaderLoginOnly?.classList.remove("hidden");
    }
  } finally {
    setCatalogLoadingVisible(false);
    elBtnConnect.disabled = false;
  }
}

function disconnect(): void {
  setChannelNamePrefixesFromDatabase(null);
  setChannelHideNeedlesFromDatabase(null);
  adminConfig = { ...EMPTY_ADMIN_CONFIG };
  vodAdminConfig = { ...EMPTY_ADMIN_CONFIG };
  seriesAdminConfig = { ...EMPTY_ADMIN_CONFIG };
  dbAdminCountries = [];
  dbAdminPackages = [];
  streamCurationByCountry = new Map();
  packageCoverOverrides = new Map();
  populateCountrySelectFromAdmin();
  state = null;
  activeStreamId = null;
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  selectedPillId = "all";
  uiTab = "live";
  uiShell = "packages";
  uiAdminPackageId = null;
  destroyPlayer();
  destroyVodPlayer();
  elDynamicList.classList.remove("item-list--vod-vertical", "item-list--vod-film-detail");
  elContentView.classList.remove("content-view--vod-film-detail");
  elDynamicList.innerHTML = "";
  elCatPills.innerHTML = "";
  elPackagesView.innerHTML = "";
  elNowPlaying.textContent = "";
  elContentView.classList.add("hidden");
  elPackagesView.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  elCatPillsWrap.classList.add("hidden");
  setTabsActive("live");
  applyPresetTheme("default");
  if (envAutoConnectConfigured()) {
    applyNodecastEnvDefaults();
    prepareEnvAutoconnectUi();
    void connect();
    return;
  }
  elMain.classList.add("hidden");
  elLoginPanel.classList.remove("hidden");
  elHeaderLoginOnly?.classList.remove("hidden");
  setLoginStatus("");
}

function onCountryChange(): void {
  selectedAdminCountryId = elCountrySelect.value || null;
  try {
    if (selectedAdminCountryId) {
      sessionStorage.setItem(COUNTRY_STORAGE_KEY, selectedAdminCountryId);
    }
  } catch {
    /* ignore */
  }

  if (!state) return;

  if (uiShell === "content" && uiAdminPackageId) {
    const merged = mergedPackagesForGrid();
    if (!merged.some((p) => p.id === uiAdminPackageId)) {
      showPackagesShell();
      return;
    }
    if (uiTab === "live") {
      syncPillDefsForPackage(uiAdminPackageId);
      renderCategoryPills();
    } else {
      renderPackageChannelList();
    }
    return;
  }

  if (uiShell === "packages") {
    renderPackagesGrid();
    syncPlayerDismissOverlay();
  }
}

elBtnConnect.addEventListener("click", () => void connect());
elBtnLogout.addEventListener("click", disconnect);
elBtnClosePlayer?.addEventListener("click", () => closePlayerUserAction());
elBtnCloseVodPlayer?.addEventListener("click", () => closeVodPlayerUserAction());
elBtnBackHome.addEventListener("click", () => {
  if (uiTab === "movies" && vodMovieUiPhase === "detail" && uiShell === "content") {
    vodMovieUiPhase = "list";
    vodDetailStream = null;
    closeVodPlayerUserAction();
    syncCatalogBackButtonLabel();
    return;
  }
  if (uiTab === "series" && seriesUiPhase === "detail" && uiShell === "content") {
    seriesUiPhase = "list";
    seriesDetailStream = null;
    closePlayerUserAction();
    syncCatalogBackButtonLabel();
    return;
  }
  showPackagesShell();
});

elTabLive.addEventListener("click", () => onTabClick("live"));
elTabMovies.addEventListener("click", () => onTabClick("movies"));
elTabSeries.addEventListener("click", () => onTabClick("series"));

elCountrySelect.addEventListener("change", onCountryChange);

applyNodecastEnvDefaults();
if (envAutoConnectConfigured()) {
  elHeaderLoginOnly?.classList.add("hidden");
  elLoginPanel.classList.add("hidden");
  elMain.classList.remove("hidden");
}

/** Click on the picture (not the native control bar) toggles play / pause. */
function toggleVideoPlayPause(ev: MouseEvent): void {
  if (!hls && !elVideo.src && !elVideo.currentSrc) return;
  const r = elVideo.getBoundingClientRect();
  const y = ev.clientY - r.top;
  const controlsReservePx = 52;
  if (y > r.height - controlsReservePx) return;
  ev.preventDefault();
  if (elVideo.paused) void elVideo.play().catch(() => {});
  else elVideo.pause();
}

elVideo.addEventListener("click", toggleVideoPlayPause);

function toggleVideoPlayPauseVod(ev: MouseEvent): void {
  if (!elVideoVod) return;
  if (!hlsVod && !elVideoVod.src && !elVideoVod.currentSrc) return;
  const r = elVideoVod.getBoundingClientRect();
  const y = ev.clientY - r.top;
  const controlsReservePx = 52;
  if (y > r.height - controlsReservePx) return;
  ev.preventDefault();
  if (elVideoVod.paused) void elVideoVod.play().catch(() => {});
  else elVideoVod.pause();
}

elVideoVod?.addEventListener("click", toggleVideoPlayPauseVod);

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement?.closest(".login-panel")) {
    void connect();
  }
});

if (envAutoConnectConfigured() && !isSettingsPageOpen()) {
  prepareEnvAutoconnectUi();
  void connect();
} else if (!isSettingsPageOpen()) {
  void fetchAndApplyCanonicalCountries().catch(() => {});
  void refreshSupabaseHierarchy().then(() => syncAdminSettingsButton());
} else {
  syncAdminSettingsButton();
}
