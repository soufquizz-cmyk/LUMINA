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
  type LiveStream,
  tryNodecastLoginAndLoad,
  resolveNodecastStreamUrl,
  proxiedUrl,
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
} from "./supabaseAdminHierarchy";

tryConsumeAdminAccessFromUrl();

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
const elLoginPanel = document.querySelector(".login-panel") as HTMLElement;
const elCatPills = $("#cat-pills") as HTMLDivElement;
const elCatPillsWrap = $("#cat-pills-wrap") as HTMLElement;
const elVideo = $("#video") as HTMLVideoElement;
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
const elDapCoverUrl = document.getElementById("dap-cover-url") as HTMLInputElement;
const elDapEmptyCountriesHint = document.getElementById("dap-empty-countries-hint") as HTMLParagraphElement | null;
const elDapNewCountryName = document.getElementById("dap-new-country-name") as HTMLInputElement;
const elDapAddCountry = document.getElementById("dap-add-country") as HTMLButtonElement;

applySettingsRouteOnLoad();
const elPlayerContainer = $("#player-container") as HTMLElement;
const elMainTabs = $("#main-tabs") as HTMLElement;
const elPackagesView = $("#packages-view") as HTMLDivElement;
const elContentView = $("#content-view") as HTMLElement;
const elDynamicList = $("#dynamic-list") as HTMLDivElement;
const elBtnBackHome = $("#btn-back-home") as HTMLButtonElement;
const elTabLive = $("#tab-live") as HTMLButtonElement;
const elTabMovies = $("#tab-movies") as HTMLButtonElement;
const elTabSeries = $("#tab-series") as HTMLButtonElement;

type PillId = string;

const ALL_PILL = { id: "all", label: "Tout" } as const;

let selectedPillId: PillId = "all";
let pillDefs: Array<{ id: string; label: string }> = [ALL_PILL];

let adminConfig: AdminConfig = { ...EMPTY_ADMIN_CONFIG };

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
} | null = null;

let hls: Hls | null = null;
let activeStreamId: number | null = null;

function applyPresetTheme(key: string): void {
  const t = THEMES[key] || THEMES.default;
  elMain.style.setProperty("--vel-bg", t.bg);
  elMain.style.setProperty("--vel-surface", t.surface);
  elMain.style.setProperty("--vel-primary", t.primary);
  elMain.style.setProperty("--vel-accent-glow", t.glow);
  elMain.style.removeProperty("--vel-back");
}

function applyThemeForPackage(pkg: AdminPackage | null): void {
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

function setTabsActive(tab: UiTab): void {
  elTabLive.classList.toggle("active", tab === "live");
  elTabMovies.classList.toggle("active", tab === "movies");
  elTabSeries.classList.toggle("active", tab === "series");
}

function showPlayerChrome(show: boolean): void {
  elPlayerContainer.classList.toggle("hidden", !show);
  elPlayerContainer.setAttribute("aria-hidden", show ? "false" : "true");
  elNowPlaying.classList.toggle("hidden", !show);
  elNowPlaying.setAttribute("aria-hidden", show ? "false" : "true");
}

function destroyPlayer(): void {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  elVideo.removeAttribute("src");
  elVideo.removeAttribute("title");
  elVideo.load();
  elNowPlaying.textContent = "";
  showPlayerChrome(false);
}

function playUrl(url: string, label: string): void {
  destroyPlayer();
  const proxied = proxiedUrl(url);
  elNowPlaying.innerHTML = nowPlayingLiveMarkup(label);
  showPlayerChrome(true);

  if (elVideo.canPlayType("application/vnd.apple.mpegurl")) {
    elVideo.src = proxied;
    void elVideo.play().catch(() => {});
    return;
  }

  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
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
  elPackagesView.innerHTML =
    '<div class="vel-empty-msg" style="grid-column: 1 / -1; text-align: center; padding: 2rem 1rem">Connexion au catalogue…</div>';
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

/** Streams for the opened grid card: `packageId` is the provider live `category_id`. */
function streamsForProviderCategory(packageId: string): LiveStream[] {
  if (!state) return [];
  return state.streamsByCatAll.get(packageId) ?? [];
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
  elCatPills.innerHTML = "";
  if (!state || uiAdminPackageId == null) return;
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

function renderPackageChannelList(): void {
  if (!state || uiAdminPackageId == null) return;
  const base = streamsForProviderCategory(uiAdminPackageId);
  const filtered = streamsAfterPill(base, selectedPillId).filter((s) => !shouldHideChannelByName(s.name));

  elDynamicList.innerHTML = "";

  for (const s of filtered) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "media-item";
    btn.dataset.streamId = String(s.stream_id);
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
    h4.textContent = displayChannelName(s.name);
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
      elDynamicList.querySelectorAll(".media-item").forEach((el) =>
        el.classList.toggle("selected", (el as HTMLElement).dataset.streamId === String(s.stream_id))
      );
      void playStreamByMode(s);
      showPlayerChrome(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    elDynamicList.appendChild(btn);
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
}

/** Provider-inferred countries plus Supabase-only rows (deduped by display name). */
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

function syncAdminGridToolsToggleFromStorage(): void {
  if (!elToggleAdminUi) return;
  const on = readAdminGridToolsEnabled();
  elToggleAdminUi.checked = on;
  elToggleAdminUi.setAttribute("aria-checked", on ? "true" : "false");
}

function syncAdminSettingsButton(): void {
  elBtnSettings?.classList.toggle("hidden", !isAdminSession());
  elVelAdminToolsWrap?.classList.toggle("hidden", !isAdminSession());
  if (isAdminSession()) syncAdminGridToolsToggleFromStorage();
}

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
  if (state && uiShell === "packages" && uiTab === "live") {
    renderPackagesGrid();
  }
});

window.addEventListener("popstate", () => {
  syncSettingsFromUrl();
});

window.addEventListener("velora-admin-session-changed", () => {
  syncAdminSettingsButton();
  void refreshSupabaseHierarchy().then(() => {
    if (state && uiShell === "packages" && uiTab === "live") renderPackagesGrid();
  });
});

window.addEventListener("velora-settings-closed", () => {
  if (state) {
    void (async () => {
      await fetchAndApplyCanonicalCountries();
      await fetchAndApplyChannelNamePrefixes();
      await fetchAndApplyChannelHideNeedles();
      await refreshSupabaseHierarchy();
      if (uiShell === "packages" && uiTab === "live") renderPackagesGrid();
    })();
  }
  if (envAutoConnectConfigured() && !state) {
    prepareEnvAutoconnectUi();
    void connect();
  }
});

/** Live categories from the provider for the current header selection (catalogue `country_id`). */
function packagesForSelectedCountry(): AdminPackage[] {
  if (!selectedAdminCountryId) return [];
  if (isLikelyUuid(selectedAdminCountryId)) {
    /* Canonical pays from Supabase use UUID ids — same shape as admin_countries. */
    if (adminConfig.countries.some((c) => c.id === selectedAdminCountryId)) {
      return adminConfig.packages
        .filter((p) => p.country_id === selectedAdminCountryId)
        .sort((a, b) => a.name.localeCompare(b.name, "fr"));
    }
    const dbC = dbAdminCountries.find((c) => c.id === selectedAdminCountryId);
    if (!dbC) return [];
    const key = normalizeCountryKey(dbC.name);
    if (!key) return [];
    const prov = adminConfig.countries.find((c) => normalizeCountryKey(c.name) === key);
    if (!prov) return [];
    return adminConfig.packages
      .filter((p) => p.country_id === prov.id)
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }
  return adminConfig.packages
    .filter((p) => p.country_id === selectedAdminCountryId)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

async function refreshSupabaseHierarchy(): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) {
    dbAdminCountries = [];
    dbAdminPackages = [];
    populateCountrySelectFromAdmin();
    return;
  }
  try {
    const [countries, packages] = await Promise.all([
      fetchDbAdminCountries(sb),
      fetchDbAdminPackages(sb),
    ]);
    dbAdminCountries = countries;
    dbAdminPackages = packages;
  } catch {
    dbAdminCountries = [];
    dbAdminPackages = [];
  }
  populateCountrySelectFromAdmin();
}

function matchedDbCountryIdForSelection(): string | null {
  if (!selectedAdminCountryId) return null;
  if (isLikelyUuid(selectedAdminCountryId)) {
    return dbAdminCountries.some((c) => c.id === selectedAdminCountryId)
      ? selectedAdminCountryId
      : null;
  }
  const c = adminConfig.countries.find((x) => x.id === selectedAdminCountryId);
  if (!c) return null;
  return matchDbCountryIdByDisplayName(c.name, dbAdminCountries);
}

function mergedPackagesForGrid(): AdminPackage[] {
  const provider = packagesForSelectedCountry();
  const sid = matchedDbCountryIdForSelection();
  const fromDb = sid ? dbAdminPackages.filter((p) => p.country_id === sid) : [];
  return [...fromDb, ...provider].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function findPackageById(packageId: string): AdminPackage | undefined {
  return adminConfig.packages.find((p) => p.id === packageId) ?? dbAdminPackages.find((p) => p.id === packageId);
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

function renderPackagesGrid(): void {
  elPackagesView.innerHTML = "";
  const st = state;
  if (!st) return;

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

  const showAdminGridTools =
    isAdminSession() && Boolean(getSupabaseClient()) && readAdminGridToolsEnabled();
  if (showAdminGridTools) appendAddPackageCard();

  const pkgs = mergedPackagesForGrid();
  for (const pkg of pkgs) {
    const isDb = isLikelyUuid(pkg.id);
    const matched = streamsForProviderCategory(pkg.id);
    const firstIcon = !isDb
      ? matched
          .map((s) => resolvedIconUrl(s.stream_icon, st.base))
          .find(Boolean)
      : null;

    if (isDb) {
      const card = document.createElement("div");
      card.className = "vel-package-card vel-package-card--db";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.dataset.packageId = pkg.id;
      card.setAttribute("aria-label", pkg.name);

      if (showAdminGridTools) {
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
      if (cover && /^https?:\/\//i.test(cover)) {
        const img = document.createElement("img");
        img.alt = "";
        img.setAttribute("role", "presentation");
        img.src = cover;
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
        if ((ev.target as HTMLElement).closest(".admin-pkg-del-sb")) return;
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

    if (firstIcon) {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("role", "presentation");
      img.src = proxiedUrl(firstIcon);
      img.addEventListener("error", () => {
        img.remove();
        const em = document.createElement("span");
        em.className = "vel-package-card__emoji";
        em.textContent = "📡";
        em.setAttribute("aria-hidden", "true");
        card.prepend(em);
      });
      card.appendChild(img);
    } else {
      const em = document.createElement("span");
      em.className = "vel-package-card__emoji";
      em.textContent = "📡";
      em.setAttribute("aria-hidden", "true");
      card.appendChild(em);
    }

    const title = document.createElement("span");
    title.className = "vel-package-card__title";
    title.textContent = pkg.name;
    card.appendChild(title);

    card.addEventListener("click", () => openAdminPackage(pkg.id));
    elPackagesView.appendChild(card);
  }

  if (pkgs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.style.gridColumn = "1 / -1";
    empty.textContent =
      "Aucune catégorie live pour ce pays dans le catalogue fournisseur. Essayez un autre pays ou « Autres ».";
    elPackagesView.appendChild(empty);
  }
}

function openAdminPackage(packageId: string): void {
  if (!state) return;
  const pkg = findPackageById(packageId);
  if (!pkg) return;
  uiShell = "content";
  uiTab = "live";
  uiAdminPackageId = packageId;
  setTabsActive("live");
  applyThemeForPackage(pkg);
  elPackagesView.classList.add("hidden");
  elMainTabs.classList.add("hidden");
  elContentView.classList.remove("hidden");
  selectedPillId = "all";
  syncPillDefsForPackage(packageId);
  renderCategoryPills();
  updatePillsVisibility();
}

function goHome(): void {
  uiShell = "packages";
  uiTab = "live";
  uiAdminPackageId = null;
  setTabsActive("live");
  applyPresetTheme("default");
  elPackagesView.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.add("hidden");
  elCatPillsWrap.classList.add("hidden");
  selectedPillId = "all";
  if (state) renderPackagesGrid();
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

function populateAddPackageDialogCountries(): void {
  elDapSbCountry.innerHTML = "";
  if (dbAdminCountries.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "— Ajoutez un pays ci-dessus —";
    o.disabled = true;
    o.selected = true;
    elDapSbCountry.appendChild(o);
    elDapSbCountry.disabled = true;
    return;
  }
  elDapSbCountry.disabled = false;
  for (const c of dbAdminCountries) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    elDapSbCountry.appendChild(o);
  }
}

function openAddPackageDialog(): void {
  const sb = getSupabaseClient();
  if (!isAdminSession() || !readAdminGridToolsEnabled() || !sb) return;
  elDapStatus.textContent = "";
  elDapStatus.classList.remove("error");
  elDapNewCountryName.value = "";
  elDapCover.value = "";
  elDapCoverUrl.value = "";
  populateAddPackageDialogCountries();
  elDapEmptyCountriesHint?.classList.toggle("hidden", dbAdminCountries.length > 0);
  const match = matchedDbCountryIdForSelection();
  if (match && [...elDapSbCountry.options].some((o) => o.value === match)) {
    elDapSbCountry.value = match;
  } else if (elDapSbCountry.options.length && !elDapSbCountry.disabled) {
    elDapSbCountry.selectedIndex = 0;
  }
  elDapName.value = "";
  elDialogAddPkg.showModal();
  queueMicrotask(() => {
    if (dbAdminCountries.length === 0) elDapNewCountryName.focus();
    else elDapName.focus();
  });
}

function closeAddPackageDialog(): void {
  elDialogAddPkg.close();
}

elDapCancel.addEventListener("click", () => closeAddPackageDialog());

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
    elDapEmptyCountriesHint?.classList.add("hidden");
    const id = data && typeof data === "object" && "id" in data ? String((data as { id: string }).id) : "";
    if (id && [...elDapSbCountry.options].some((o) => o.value === id)) {
      elDapSbCountry.value = id;
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
      elDapStatus.textContent = "Choisissez un pays Supabase.";
      elDapStatus.classList.add("error");
      return;
    }
    if (!name) {
      elDapStatus.textContent = "Saisissez un nom.";
      elDapStatus.classList.add("error");
      return;
    }
    const file = elDapCover.files?.[0];
    const urlPaste = elDapCoverUrl.value.trim();
    if (file && urlPaste) {
      elDapStatus.textContent = "Utilisez soit un fichier, soit une URL — pas les deux.";
      elDapStatus.classList.add("error");
      return;
    }
    if (urlPaste && !/^https?:\/\//i.test(urlPaste)) {
      elDapStatus.textContent = "L’URL de l’image doit commencer par http:// ou https://";
      elDapStatus.classList.add("error");
      return;
    }

    elDapSubmit.disabled = true;
    const insertRow: { country_id: string; name: string; cover_url?: string | null } = {
      country_id: countryId,
      name,
      cover_url: file ? null : urlPaste || null,
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
        await refreshSupabaseHierarchy();
        if (state && uiShell === "packages" && uiTab === "live") {
          renderPackagesGrid();
        }
        return;
      }
    }
    elDapSubmit.disabled = false;
    closeAddPackageDialog();
    await refreshSupabaseHierarchy();
    if (state && uiShell === "packages" && uiTab === "live") {
      renderPackagesGrid();
    }
  })();
});

function showVodPlaceholder(kind: "movies" | "series"): void {
  uiShell = "content";
  uiTab = kind;
  uiAdminPackageId = null;
  setTabsActive(kind);
  applyPresetTheme("default");
  elPackagesView.classList.add("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.remove("hidden");
  elCatPillsWrap.classList.add("hidden");
  elDynamicList.innerHTML = "";
  const msg = document.createElement("div");
  msg.className = "vel-empty-msg";
  msg.innerHTML =
    kind === "movies"
      ? "Les <strong>films</strong> (VOD) ne sont pas encore branchés sur ce lecteur Nodecast.<br/>Utilisez <strong>DIRECT TV</strong> pour le live."
      : "Les <strong>séries</strong> (VOD) ne sont pas encore branchées sur ce lecteur Nodecast.<br/>Utilisez <strong>DIRECT TV</strong> pour le live.";
  elDynamicList.appendChild(msg);
}

function onTabClick(tab: UiTab): void {
  if (tab === "live") {
    goHome();
    return;
  }
  showVodPlaceholder(tab === "movies" ? "movies" : "series");
}

async function playStreamByMode(s: LiveStream): Promise<void> {
  if (!state) return;
  if (state.mode === "nodecast") {
    showPlayerChrome(true);
    elNowPlaying.innerHTML = nowPlayingLiveMarkup(displayChannelName(s.name));
    const resolved = await resolveNodecastStreamUrl(
      state.base,
      s,
      state.nodecastAuthHeaders
    );
    if (!resolved) {
      elNowPlaying.innerHTML = nowPlayingErrorMarkup(
        "Impossible de résoudre l’URL de cette chaîne (API Nodecast)."
      );
      return;
    }
    if (!sameOrigin(resolved, state.base)) {
      elNowPlaying.innerHTML = nowPlayingErrorMarkup(
        "URL de lecture externe bloquée ; proxy requis."
      );
      return;
    }
    s.direct_source = resolved;
    playUrl(resolved, displayChannelName(s.name));
    return;
  }
  const m3u8 = buildLiveStreamUrl(
    state.serverInfo,
    state.username,
    state.password,
    s.stream_id,
    "m3u8"
  );
  playUrl(m3u8, displayChannelName(s.name));
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
    const mode: "nodecast" = "nodecast";
    const nodecast = await tryNodecastLoginAndLoad(base, username, password);
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
    await refreshSupabaseHierarchy();

    state = {
      mode,
      base,
      username,
      password,
      nodecastAuthHeaders,
      serverInfo: serverInfo!,
      streamsByCatAll: new Map(streamsByCat),
    };

    selectedPillId = "all";
    activeStreamId = null;
    destroyPlayer();
    elNowPlaying.textContent = "";

    goHome();
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
    elBtnConnect.disabled = false;
  }
}

function disconnect(): void {
  setChannelNamePrefixesFromDatabase(null);
  setChannelHideNeedlesFromDatabase(null);
  adminConfig = { ...EMPTY_ADMIN_CONFIG };
  dbAdminCountries = [];
  dbAdminPackages = [];
  populateCountrySelectFromAdmin();
  state = null;
  activeStreamId = null;
  selectedPillId = "all";
  uiTab = "live";
  uiShell = "packages";
  uiAdminPackageId = null;
  destroyPlayer();
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

  if (uiShell === "content" && uiTab === "live" && uiAdminPackageId) {
    const merged = mergedPackagesForGrid();
    if (!merged.some((p) => p.id === uiAdminPackageId)) {
      goHome();
      return;
    }
    syncPillDefsForPackage(uiAdminPackageId);
    renderCategoryPills();
    return;
  }

  if (uiShell === "packages" && uiTab === "live") {
    renderPackagesGrid();
  }
}

elBtnConnect.addEventListener("click", () => void connect());
elBtnLogout.addEventListener("click", disconnect);
elBtnBackHome.addEventListener("click", () => {
  if (uiTab === "live") goHome();
  else {
    goHome();
  }
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
