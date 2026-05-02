import Hls from "hls.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assignmentCategoryIdForStreamName,
  displayChannelName,
} from "./assignmentMatch";
import {
  type AdminCategory,
  type AdminConfig,
  type AdminCountry,
  type AdminPackage,
  EMPTY_ADMIN_CONFIG,
  readAdminConfigFromLocalStorage,
} from "./adminHierarchyConfig";
import {
  type LiveStream,
  tryNodecastLoginAndLoad,
  resolveNodecastStreamUrl,
  proxiedUrl,
  normalizeServerInput,
  sameOrigin,
} from "./nodecastCatalog";

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
const elCountrySelect = $("#country-select") as HTMLSelectElement;
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
/** Selected country from `admin_countries` (database). */
let selectedAdminCountryId: string | null = null;

const COUNTRY_STORAGE_KEY = "lumina_selected_country_id";

const THEMES: Record<string, { bg: string; surface: string; primary: string; glow: string }> = {
  default: {
    bg: "#06050a",
    surface: "#110f1a",
    primary: "#8A2BE2",
    glow: "rgba(138, 43, 226, 0.3)",
  },
  canal: {
    bg: "#000000",
    surface: "#1a1a1a",
    primary: "#ffffff",
    glow: "rgba(255, 255, 255, 0.25)",
  },
  bein: {
    bg: "#2b0c3d",
    surface: "#3a1451",
    primary: "#d40062",
    glow: "rgba(212, 0, 98, 0.35)",
  },
  disney: {
    bg: "#001a4d",
    surface: "#002673",
    primary: "#00e6ff",
    glow: "rgba(0, 230, 255, 0.3)",
  },
};

const supabaseUrl = import.meta.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env
  .NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const supabase: SupabaseClient | null =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

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

function themeKeyForLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("canal")) return "canal";
  if (n.includes("bein")) return "bein";
  if (n.includes("disney")) return "disney";
  return "default";
}

function applyTheme(key: string): void {
  const t = THEMES[key] || THEMES.default;
  elMain.style.setProperty("--vel-bg", t.bg);
  elMain.style.setProperty("--vel-surface", t.surface);
  elMain.style.setProperty("--vel-primary", t.primary);
  elMain.style.setProperty("--vel-accent-glow", t.glow);
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

function normalizeAdminId(id: string): string {
  return id.trim().toLowerCase();
}

/** Leaf category ids for this package (normalized for stable UUID compares). */
function leafCategoryIdSetForPackage(packageId: string): Set<string> {
  const pid = normalizeAdminId(packageId);
  return new Set(
    adminConfig.categories
      .filter((c) => normalizeAdminId(c.package_id) === pid)
      .map((c) => normalizeAdminId(c.id))
  );
}

/** Channel rules that target a leaf category inside this package only. */
function assignmentsForPackageLeaves(leafIds: Set<string>): AdminConfig["assignments"] {
  return adminConfig.assignments.filter((a) => leafIds.has(normalizeAdminId(a.category_id)));
}

/**
 * Which leaf category this stream belongs to **for this bouquet only**, using rules
 * scoped to that package. Avoids another package’s rule matching the same name first
 * and hiding channels here.
 */
function ruleCategoryForStreamInPackage(streamName: string, packageId: string): string | null {
  const leafIds = leafCategoryIdSetForPackage(packageId);
  if (leafIds.size === 0) return null;
  const scoped = assignmentsForPackageLeaves(leafIds);
  const aid = assignmentCategoryIdForStreamName(streamName, scoped);
  if (aid == null) return null;
  return leafIds.has(normalizeAdminId(aid)) ? aid : null;
}

function isHiddenByAdminFilter(name: string): boolean {
  const n = name.toLowerCase();
  return adminConfig.hiddenFilters.some((f) => {
    const needle = f.needle.trim().toLowerCase();
    return needle && n.includes(needle);
  });
}

function loadAdminFromLocalStorage(): void {
  adminConfig = readAdminConfigFromLocalStorage();
}

async function loadAdminConfig(): Promise<void> {
  if (!supabase) {
    loadAdminFromLocalStorage();
    return;
  }
  try {
    const [ctryRes, pkgRes, catRes, rulesRes, filtersRes] = await Promise.all([
      supabase.from("admin_countries").select("id,name").order("name", { ascending: true }),
      supabase
        .from("admin_packages")
        .select("id,country_id,name")
        .order("name", { ascending: true }),
      supabase
        .from("admin_categories")
        .select("id,package_id,name")
        .order("name", { ascending: true }),
      supabase
        .from("admin_channel_rules")
        .select("id,match_text,category_id")
        .order("created_at", { ascending: true }),
      supabase
        .from("admin_hidden_filters")
        .select("id,needle")
        .order("created_at", { ascending: true }),
    ]);
    if (
      ctryRes.error ||
      pkgRes.error ||
      catRes.error ||
      rulesRes.error ||
      filtersRes.error
    ) {
      throw (
        ctryRes.error ||
        pkgRes.error ||
        catRes.error ||
        rulesRes.error ||
        filtersRes.error
      );
    }
    adminConfig = {
      countries: (ctryRes.data ?? []) as AdminCountry[],
      packages: (pkgRes.data ?? []) as AdminPackage[],
      categories: (catRes.data ?? []) as AdminCategory[],
      assignments: (rulesRes.data ?? []) as AdminConfig["assignments"],
      hiddenFilters: (filtersRes.data ?? []) as AdminConfig["hiddenFilters"],
    };
  } catch {
    loadAdminFromLocalStorage();
  }
}

function allStreamsDeduped(streamsByCat: Map<string, LiveStream[]>): LiveStream[] {
  const seen = new Map<number, LiveStream>();
  for (const list of streamsByCat.values()) {
    for (const s of list) {
      if (!seen.has(s.stream_id)) seen.set(s.stream_id, s);
    }
  }
  return [...seen.values()];
}

/** Streams from the provider that are assigned (rules) to a leaf category inside this package. */
function streamsMatchedInPackage(packageId: string): LiveStream[] {
  if (!state) return [];
  const leafIds = leafCategoryIdSetForPackage(packageId);
  if (leafIds.size === 0) return [];
  const pool = allStreamsDeduped(state.streamsByCatAll).filter((s) => !isHiddenByAdminFilter(s.name));
  return pool.filter((s) => ruleCategoryForStreamInPackage(s.name, packageId) != null);
}

function streamsAfterPill(base: LiveStream[], pillId: PillId, packageId: string): LiveStream[] {
  if (pillId === "all") return base;
  if (pillId.startsWith("custom:")) {
    const customId = pillId.slice("custom:".length);
    const want = normalizeAdminId(customId);
    return base.filter(
      (s) => normalizeAdminId(ruleCategoryForStreamInPackage(s.name, packageId) ?? "") === want
    );
  }
  return [];
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
  const base = streamsMatchedInPackage(uiAdminPackageId);
  const filtered = streamsAfterPill(base, selectedPillId, uiAdminPackageId);

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
    const leaves = leafCategoryIdSetForPackage(uiAdminPackageId).size;
    const rulesHere = assignmentsForPackageLeaves(leafCategoryIdSetForPackage(uiAdminPackageId)).length;
    empty.textContent =
      leaves === 0
        ? "Aucune catégorie dans ce bouquet. Ajoutez des catégories dans Admin (Supabase)."
        : rulesHere === 0
          ? "Aucune règle de chaîne ne cible ce bouquet. Dans Admin, assignez des chaînes aux catégories de ce package."
          : "Aucune chaîne du catalogue ne correspond à ces règles (texte exact / sous-chaîne), ou elles sont masquées.";
    elDynamicList.appendChild(empty);
  }
}

function ensureSelectedCountry(): void {
  const countries = adminConfig.countries;
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
  const countries = adminConfig.countries;
  if (countries.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.disabled = true;
    o.selected = true;
    o.textContent = "Aucun pays (Admin)";
    elCountrySelect.appendChild(o);
    elCountrySelect.disabled = true;
    return;
  }
  elCountrySelect.disabled = false;
  ensureSelectedCountry();
  for (const c of [...countries].sort((a, b) => a.name.localeCompare(b.name, "fr"))) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    if (c.id === selectedAdminCountryId) o.selected = true;
    elCountrySelect.appendChild(o);
  }
}

function packagesForSelectedCountry(): AdminPackage[] {
  if (!selectedAdminCountryId) return [];
  return adminConfig.packages
    .filter((p) => p.country_id === selectedAdminCountryId)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function renderPackagesGrid(): void {
  elPackagesView.innerHTML = "";
  const st = state;
  if (!st) return;

  if (adminConfig.countries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.style.gridColumn = "1 / -1";
    empty.innerHTML =
      "Aucun <strong>pays</strong> dans la base. Créez des pays et bouquets dans <a href=\"/admin.html\">Admin</a> (tables Supabase).";
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

  const pkgs = packagesForSelectedCountry();
  for (const pkg of pkgs) {
    const matched = streamsMatchedInPackage(pkg.id);
    const firstIcon = matched
      .map((s) => resolvedIconUrl(s.stream_icon, st.base))
      .find(Boolean);

    const card = document.createElement("button");
    card.type = "button";
    card.className = "vel-package-card";
    card.dataset.packageId = pkg.id;

    if (firstIcon) {
      const img = document.createElement("img");
      img.alt = "";
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

    const name = document.createElement("div");
    name.className = "vel-package-card__name";
    name.textContent = pkg.name;
    card.appendChild(name);

    card.addEventListener("click", () => openAdminPackage(pkg.id, pkg.name));
    elPackagesView.appendChild(card);
  }

  if (pkgs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.style.gridColumn = "1 / -1";
    empty.innerHTML =
      "Aucun <strong>bouquet</strong> pour ce pays dans la base. Ajoutez des packages dans <a href=\"/admin.html\">Admin</a>.";
    elPackagesView.appendChild(empty);
  }
}

function openAdminPackage(packageId: string, packageName: string): void {
  if (!state) return;
  uiShell = "content";
  uiTab = "live";
  uiAdminPackageId = packageId;
  setTabsActive("live");
  applyTheme(themeKeyForLabel(packageName));
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
  applyTheme("default");
  elPackagesView.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.add("hidden");
  elCatPillsWrap.classList.add("hidden");
  selectedPillId = "all";
  if (state) renderPackagesGrid();
}

function showVodPlaceholder(kind: "movies" | "series"): void {
  uiShell = "content";
  uiTab = kind;
  uiAdminPackageId = null;
  setTabsActive(kind);
  applyTheme("default");
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
  setLoginStatus("");
  const base = normalizeServerInput(elServer.value);
  const username = elUser.value.trim();
  const password = elPass.value;

  if (!base || !username || !password) {
    setLoginStatus("Renseignez l’URL, l’identifiant et le mot de passe.", true);
    return;
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

    await loadAdminConfig();
    populateCountrySelectFromAdmin();

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
    setLoginStatus("");
  } catch (e) {
    setLoginStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    elBtnConnect.disabled = false;
  }
}

function disconnect(): void {
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
  applyTheme("default");
  elMain.classList.add("hidden");
  elLoginPanel.classList.remove("hidden");
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
    const pkg = adminConfig.packages.find((p) => p.id === uiAdminPackageId);
    if (!pkg || pkg.country_id !== selectedAdminCountryId) {
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

elServer.value = "http://5.180.180.198:3000";
elUser.value = "samadoxal";
elPass.value = "123456";

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

void (async () => {
  await loadAdminConfig();
  populateCountrySelectFromAdmin();
})();
