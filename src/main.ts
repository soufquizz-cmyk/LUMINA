import Hls from "hls.js";

type LiveCategory = {
  category_id: string;
  category_name: string;
  parent_id: number;
};

type LiveStream = {
  stream_id: number;
  name: string;
  category_id?: string | number;
  stream_icon?: string;
  epg_channel_id?: string | null;
  direct_source?: string;
  nodecast_channel_id?: string;
  nodecast_source_id?: string;
};

type ServerInfo = {
  url: string;
  port: string | number;
  https_port?: string | number;
  server_protocol?: string;
};

type ProxiedRequestInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

/** Production shared hosting: set `VITE_PROXY_PREFIX=/proxy.php` at build time, or use /.htaccess rewrite `^proxy$` → `proxy.php`. */
const PROXY_PREFIX = (import.meta.env.VITE_PROXY_PREFIX ?? "/proxy").replace(/\/$/, "");

const elServer = $("#server") as HTMLInputElement;
const elUser = $("#user") as HTMLInputElement;
const elPass = $("#pass") as HTMLInputElement;
const elBtnConnect = $("#btn-connect") as HTMLButtonElement;
const elLoginStatus = $("#login-status") as HTMLSpanElement;
const elMain = $("#main") as HTMLElement;
const elLoginPanel = document.querySelector(".login-panel") as HTMLElement;
const elCatPills = $("#cat-pills") as HTMLDivElement;
const elStreamList = $("#stream-list") as HTMLUListElement;
const elStreamFilter = $("#stream-filter") as HTMLInputElement;
const elVideo = $("#video") as HTMLVideoElement;
const elNowPlaying = $("#now-playing") as HTMLDivElement;
const elChannelCount = $("#channel-count") as HTMLSpanElement;
const elPlayerBarTitle = $("#player-now-title") as HTMLSpanElement;
const elBtnLogout = $("#btn-logout") as HTMLButtonElement;

type PillId = (typeof PILL_DEFS)[number]["id"];

const PILL_DEFS = [
  { id: "all", label: "All" },
  { id: "sports", label: "Sports" },
  { id: "news", label: "News" },
  { id: "movies", label: "Movies" },
  { id: "kids", label: "Kids" },
  { id: "documentary", label: "Documentary" },
] as const;

let selectedPillId: PillId = "all";

function normalizeServerInput(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  return s;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** `from` = playlist / page URL for upstream Referer (hotlink checks). */
function proxiedUrl(target: string, fromPlaylist?: string): string {
  const p = new URLSearchParams();
  p.set("target", target);
  p.set("from", fromPlaylist ?? target);
  return `${PROXY_PREFIX}?${p.toString()}`;
}

function resolvedIconUrl(raw: string | undefined, base: string): string | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    return /^https?:\/\//i.test(s) ? s : new URL(s, base).href;
  } catch {
    return null;
  }
}

const FETCH_TIMEOUT_MS = 90_000;

/** Same upstream URL → same Nodecast transcode session; avoid duplicate POSTs (log spam + extra load). */
const TRANSCODE_CACHE_MS = 3 * 60 * 1000;
const transcodePlaylistCache = new Map<string, { expires: number; playlistUrl: string }>();
const transcodeInflight = new Map<string, Promise<string | null>>();

async function fetchProxiedJson<T>(url: string): Promise<T> {
  return fetchProxiedJsonWithInit<T>(url);
}

async function fetchProxiedJsonWithInit<T>(
  url: string,
  init: ProxiedRequestInit = {}
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(proxiedUrl(url), {
      signal: ac.signal,
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s. Check the server URL and your network.`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = (await r.text()).replace(/^\uFEFF/, "");
  if (!r.ok) {
    throw new Error(text.slice(0, 400) || r.statusText);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid JSON from server (wrong URL or blocked response).");
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
    (useHttps && server.https_port != null && server.https_port !== "")
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
  categories: LiveCategory[];
  streamsByCat: Map<string, LiveStream[]>;
} | null = null;

let hls: Hls | null = null;
let activeStreamId: number | null = null;

function destroyPlayer(): void {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  elVideo.removeAttribute("src");
  elVideo.load();
  elPlayerBarTitle.textContent = "Select a channel";
}

function playUrl(url: string, label: string): void {
  destroyPlayer();
  const proxied = proxiedUrl(url);
  elPlayerBarTitle.textContent = label;
  elNowPlaying.innerHTML = `Playing: <strong>${escapeHtml(label)}</strong>`;

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
        elPlayerBarTitle.textContent = "Playback error";
        elNowPlaying.innerHTML = `<span class="error">Playback error: ${escapeHtml(
          data.type
        )} / ${escapeHtml(String(data.details))}</span>`;
      }
    });
    return;
  }

  elNowPlaying.innerHTML =
    '<span class="error">HLS not supported in this browser.</span>';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Strip common `FR -` / `FR |` style prefixes from list and player labels. */
function displayChannelName(raw: string): string {
  const s = raw
    .replace(/^\s*(?:\[FR\]\s*|FR\s*[-–—|]\s*|FR\s*:\s+)/i, "")
    .trim();
  return s.length ? s : raw.trim();
}

function setLoginStatus(msg: string, isError = false): void {
  elLoginStatus.textContent = msg;
  elLoginStatus.classList.toggle("error", isError);
}

function groupStreamsByCategory(streams: LiveStream[]): Map<string, LiveStream[]> {
  const map = new Map<string, LiveStream[]>();
  for (const s of streams) {
    const cid = s.category_id != null ? String(s.category_id) : "";
    if (!cid) continue;
    const list = map.get(cid);
    if (list) list.push(s);
    else map.set(cid, [s]);
  }
  return map;
}

/** Category pills: only names containing "france" (case-insensitive). */
function categoryNameIncludesFrance(c: LiveCategory): boolean {
  return c.category_name.toLowerCase().includes("france");
}

function filterCategoriesAndStreamsToFrance(
  cats: LiveCategory[],
  streamsByCat: Map<string, LiveStream[]>
): { categories: LiveCategory[]; streamsByCat: Map<string, LiveStream[]> } {
  const categories = cats.filter(categoryNameIncludesFrance);
  const next = new Map<string, LiveStream[]>();
  for (const c of categories) {
    const id = String(c.category_id);
    next.set(id, streamsByCat.get(id) ?? []);
  }
  return { categories, streamsByCat: next };
}

function categoryNameById(categories: LiveCategory[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of categories) {
    m.set(String(c.category_id), c.category_name);
  }
  return m;
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

function streamHaystack(s: LiveStream, catNames: Map<string, string>): string {
  const cid = s.category_id != null ? String(s.category_id) : "";
  const cat = (cid && catNames.get(cid)) || "";
  return `${s.name} ${cat}`.toLowerCase();
}

function streamMatchesGenrePill(hay: string, pillId: Exclude<PillId, "all">): boolean {
  switch (pillId) {
    case "sports":
      return /sport|football|soccer|foot\b|rugby|f1\b|formula|ligue|uefa|nba|nfl|nhl|mlb|tennis|golf|match|stadium|olymp|bein|eurosport|dazn|motogp|cyclisme|volley|handball|hockey|mma|boxe|catch|ipl|cricket|arena|rmc\s*sp|eleven|canal\+\s*sp/i.test(
        hay
      );
    case "news":
      return /news|info\b|actu|actualit|bfm|lci|cnews|franceinfo|euronews|cnn|bbc\b|i24|rtl\b|journal|politique|parlement|assembly|bloomberg|sky\s*news|msnbc|fox\s*news|al\s*jazeera|france\s*24/i.test(
        hay
      );
    case "movies":
      return /cin[eé]ma|cinema|\bfilm\b|movie|vod|hollywood|oscar|paramount|warner|mgm|hbo\b|netflix|prime\s*vid|amazon\s*stud/i.test(
        hay
      );
    case "kids":
      return /kid|enfant|junior|cartoon|disney|nickelodeon|boomerang|gulli|tiji|piwi|baby|teen|duck|rubika|yoyo|babar|peppa|paw\s*patrol|spongebob|minuscule/i.test(
        hay
      );
    case "documentary":
      return /document|docu|discovery|nat\s*geo|national\s*geo|animal\s*planet|science\b|histoire|arte\b|ushua[iï]a|museum|wildlife|plan[eè]te|geo\b|investigation|enqu[eê]te/i.test(
        hay
      );
    default:
      return false;
  }
}

function streamsForPill(
  streamsByCat: Map<string, LiveStream[]>,
  categories: LiveCategory[],
  pillId: PillId
): LiveStream[] {
  const all = allStreamsDeduped(streamsByCat);
  if (pillId === "all") return all;
  const catNames = categoryNameById(categories);
  return all.filter((s) => streamMatchesGenrePill(streamHaystack(s, catNames), pillId));
}

function asArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  if (Array.isArray(o.channels)) return o.channels;
  if (Array.isArray(o.data)) return o.data;
  if (Array.isArray(o.items)) return o.items;
  if (Array.isArray(o.results)) return o.results;
  return [];
}

function looksLikeMediaUrl(v: string): boolean {
  return /^https?:\/\//i.test(v) && /(\.m3u8|\.mpd|\.ts|\/live\/|\/hls\/|\/stream\/)/i.test(v);
}

function extractStreamUrlDeep(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return looksLikeMediaUrl(trimmed) ? trimmed : null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const hit = extractStreamUrlDeep(item);
      if (hit) return hit;
    }
    return null;
  }

  const obj = payload as Record<string, unknown>;
  const preferredKeys = [
    "stream_url",
    "playback_url",
    "hls_url",
    "url",
    "direct_source",
    "stream",
    "play_url",
  ];
  for (const k of preferredKeys) {
    const v = obj[k];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (looksLikeMediaUrl(trimmed)) return trimmed;
    }
  }
  for (const v of Object.values(obj)) {
    const hit = extractStreamUrlDeep(v);
    if (hit) return hit;
  }
  return null;
}

function extractTokenDeep(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const t = extractTokenDeep(item);
      if (t) return t;
    }
    return null;
  }
  const o = payload as Record<string, unknown>;
  const directKeys = ["token", "access_token", "accessToken", "jwt", "bearer"];
  for (const k of directKeys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(o)) {
    const t = extractTokenDeep(v);
    if (t) return t;
  }
  return null;
}

function isLikelyM3u8Body(text: string): boolean {
  return text.trimStart().startsWith("#EXTM3U");
}

/** Nodecast POST /api/transcode/session returns `{ playlistUrl: "/api/transcode/:id/stream.m3u8", ... }`. */
function playlistUrlFromNodecastTranscodeResponse(
  payload: unknown,
  nodecastBase: string
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const rel = o.playlistUrl;
  if (typeof rel !== "string" || !rel.includes("m3u8")) return null;
  try {
    const u = new URL(rel.trim(), nodecastBase);
    if (u.origin !== new URL(nodecastBase).origin) return null;
    return u.href;
  } catch {
    return null;
  }
}

async function createNodecastTranscodeUrl(
  nodecastBase: string,
  upstreamUrl: string,
  headers?: Record<string, string>
): Promise<string | null> {
  const now = Date.now();
  const cached = transcodePlaylistCache.get(upstreamUrl);
  if (cached && cached.expires > now) {
    return cached.playlistUrl;
  }

  let inflight = transcodeInflight.get(upstreamUrl);
  if (inflight) {
    return inflight;
  }

  inflight = (async (): Promise<string | null> => {
    console.debug("[nodecast] create transcode session for", upstreamUrl);
    try {
      await fetchProxiedJsonWithInit<unknown>(
        `${nodecastBase}/api/probe?url=${encodeURIComponent(upstreamUrl)}`,
        { headers }
      );
    } catch {
      // optional warm-up
    }

    const postHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    };
    const postBody = JSON.stringify({ url: upstreamUrl });
    const sessionUrl = `${nodecastBase}/api/transcode/session`;

    for (let round = 0; round < 2; round++) {
      if (round > 0) {
        await new Promise((r) => setTimeout(r, 2800));
      }
      try {
        const payload = await fetchProxiedJsonWithInit<unknown>(sessionUrl, {
          method: "POST",
          headers: postHeaders,
          body: postBody,
        });
        const fromPlaylist = playlistUrlFromNodecastTranscodeResponse(payload, nodecastBase);
        if (fromPlaylist) {
          transcodePlaylistCache.set(upstreamUrl, {
            expires: Date.now() + TRANSCODE_CACHE_MS,
            playlistUrl: fromPlaylist,
          });
          console.debug("[nodecast] transcode session playlist", fromPlaylist);
          return fromPlaylist;
        }
        const resolved = extractStreamUrlDeep(payload);
        if (resolved) {
          const u = new URL(resolved, nodecastBase);
          if (u.origin === new URL(nodecastBase).origin) {
            transcodePlaylistCache.set(upstreamUrl, {
              expires: Date.now() + TRANSCODE_CACHE_MS,
              playlistUrl: u.href,
            });
            return u.href;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isPlaylistTimeout = msg.includes("Playlist not generated in time");
        console.debug("[nodecast] transcode session failed", msg.slice(0, 200));
        if (!isPlaylistTimeout || round === 1) {
          break;
        }
      }
    }
    return null;
  })().finally(() => {
    transcodeInflight.delete(upstreamUrl);
  });

  transcodeInflight.set(upstreamUrl, inflight);
  return inflight;
}

async function resolveCandidateToPlayableUrl(
  candidate: string,
  headers?: Record<string, string>
): Promise<string | null> {
  try {
    const r = await fetch(proxiedUrl(candidate), { method: "GET", headers });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const body = await r.text();

    if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) {
      return isLikelyM3u8Body(body) ? candidate : null;
    }
    if (isLikelyM3u8Body(body)) {
      return candidate;
    }

    // Some Nodecast routes return JSON metadata with nested stream URL.
    if (ct.includes("application/json") || body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
      try {
        const parsed = JSON.parse(body) as unknown;
        const extracted = extractStreamUrlDeep(parsed);
        if (!extracted) return null;
        try {
          const candidateUrl = new URL(candidate);
          const extractedUrl = new URL(extracted, candidateUrl);
          // Third-party URL: use Nodecast HTTP proxy (same as official app), then transcode only if needed.
          if (extractedUrl.origin !== candidateUrl.origin) {
            const nodecastOrigin = `${candidateUrl.protocol}//${candidateUrl.host}`;
            const viaProxy = buildNodecastProxyStreamPlaylistUrl(
              nodecastOrigin,
              extractedUrl.href
            );
            const playable = await resolveCandidateToPlayableUrl(viaProxy, headers);
            if (playable) return playable;
            return await createNodecastTranscodeUrl(
              nodecastOrigin,
              extractedUrl.href,
              headers
            );
          }
          return extractedUrl.href;
        } catch {
          return null;
        }
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function mapNodecastChannelToLiveStream(raw: unknown, index: number): LiveStream | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const name = String(c.name ?? c.title ?? `Channel ${index + 1}`).trim();
  const directSource = extractStreamUrlDeep(c) ?? "";
  if (!name) return null;

  const categoryId = String(
    c.category_id ??
      c.group_id ??
      c.group ??
      c.category ??
      c.source_id ??
      "uncategorized"
  );
  const numericId = Number(c.stream_id ?? c.id ?? index + 1);
  const iconRaw =
    (typeof c.stream_icon === "string" && c.stream_icon.trim()) ||
    (typeof c.logo === "string" && c.logo.trim()) ||
    (typeof c.cover === "string" && c.cover.trim()) ||
    (typeof c.icon === "string" && c.icon.trim()) ||
    "";
  return {
    stream_id: Number.isFinite(numericId) ? numericId : index + 1,
    name,
    category_id: categoryId,
    stream_icon: iconRaw || undefined,
    direct_source: directSource || undefined,
    nodecast_channel_id: String(c.channel_id ?? c.id ?? c.stream_id ?? ""),
  };
}

function categoriesFromStreams(streams: LiveStream[]): LiveCategory[] {
  const seen = new Map<string, LiveCategory>();
  for (const s of streams) {
    const cid = String(s.category_id ?? "uncategorized");
    if (!seen.has(cid)) {
      seen.set(cid, {
        category_id: cid,
        category_name: cid === "uncategorized" ? "Other" : cid,
        parent_id: 0,
      });
    }
  }
  return [...seen.values()];
}

function parseIdCandidates(payload: unknown): string[] {
  if (!payload) return [];
  const out = new Set<string>();
  const arr = Array.isArray(payload) ? payload : asArray(payload);
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = String(o.id ?? o.source_id ?? o.connection_id ?? "").trim();
    const type = String(o.type ?? o.kind ?? o.source_type ?? "").toLowerCase();
    const provider = String(o.provider ?? o.name ?? "").toLowerCase();
    if (!id) continue;
    if (!type && !provider) {
      out.add(id);
      continue;
    }
    if (type.includes("xtream") || provider.includes("xtream")) {
      out.add(id);
    }
  }
  return [...out];
}

/** `/api/sources/status` uses `source_id` and `status` (see Nodecast UI). */
function collectXtreamSourceIdsFromStatus(payload: unknown): string[] {
  const out = new Set<string>();
  const arr = Array.isArray(payload) ? payload : asArray(payload);
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const status = String(o.status ?? "").toLowerCase();
    if (status && status !== "success") continue;
    const id = String(o.source_id ?? o.sourceId ?? o.id ?? "").trim();
    if (!id) continue;
    out.add(id);
  }
  return [...out];
}

/** Same as Nodecast UI: server-side fetch + rewritten HLS via `/api/proxy/stream?url=`. */
function buildNodecastProxyStreamPlaylistUrl(nodecastBase: string, upstreamUrl: string): string {
  const b = nodecastBase.replace(/\/+$/, "");
  return `${b}/api/proxy/stream?url=${encodeURIComponent(upstreamUrl)}`;
}

async function tryNodecastLoginAndLoad(
  base: string,
  username: string,
  password: string
): Promise<{
  categories: LiveCategory[];
  streamsByCat: Map<string, LiveStream[]>;
  authHeaders?: Record<string, string>;
}> {
  const loginCandidates = [
    "/api/auth/login",
    "/api/login",
    "/auth/login",
  ];
  let loggedIn = false;
  let nodecastAuthHeaders: Record<string, string> | undefined;
  for (const path of loginCandidates) {
    try {
      const loginPayload = await fetchProxiedJsonWithInit<unknown>(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const token = extractTokenDeep(loginPayload);
      if (token) {
        nodecastAuthHeaders = { Authorization: `Bearer ${token}` };
      }
      loggedIn = true;
      break;
    } catch {
      // try next candidate
    }
  }
  if (!loggedIn) {
    throw new Error("Nodecast login failed. Check panel credentials.");
  }

  const channelCandidates = [
    "/api/channels",
    "/api/live/channels",
    "/api/content/live",
    "/api/streams/live",
    "/api/tv/channels",
    "/api/content/channels",
    "/api/live",
  ];
  let streams: LiveStream[] = [];
  for (const path of channelCandidates) {
    try {
      const payload = await fetchProxiedJson<unknown>(`${base}${path}`);
      const arr = asArray(payload);
      const mapped = arr
        .map((item, idx) => mapNodecastChannelToLiveStream(item, idx))
        .filter((s): s is LiveStream => s != null);
      if (mapped.length) {
        streams = mapped;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!streams.length) {
    const sourceIdEndpoints = [
      "/api/sources/status",
      "/api/xtream/connections",
      "/api/sources",
      "/api/proxy/xtream",
    ];
    const sourceIds = new Set<string>();
    for (const ep of sourceIdEndpoints) {
      try {
        const payload = await fetchProxiedJsonWithInit<unknown>(`${base}${ep}`, {
          headers: nodecastAuthHeaders,
        });
        if (ep === "/api/sources/status") {
          for (const id of collectXtreamSourceIdsFromStatus(payload)) sourceIds.add(id);
        } else {
          for (const id of parseIdCandidates(payload)) sourceIds.add(id);
        }
      } catch {
        // keep trying
      }
    }
    if (sourceIds.size === 0) {
      sourceIds.add("9");
    }

    for (const sourceId of sourceIds) {
      try {
        const [catPayload, streamPayload] = await Promise.all([
          fetchProxiedJsonWithInit<unknown>(`${base}/api/proxy/xtream/${encodeURIComponent(sourceId)}/live_categories`, {
            headers: nodecastAuthHeaders,
          }),
          fetchProxiedJsonWithInit<unknown>(`${base}/api/proxy/xtream/${encodeURIComponent(sourceId)}/live_streams`, {
            headers: nodecastAuthHeaders,
          }),
        ]);
        const mappedStreams = asArray(streamPayload)
          .map((item, idx) => mapNodecastChannelToLiveStream(item, idx))
          .filter((s): s is LiveStream => s != null)
          .map((s) => ({ ...s, nodecast_source_id: sourceId }));
        if (!mappedStreams.length) continue;

        streams = mappedStreams;
        const mappedCats = asArray(catPayload)
          .map((c) => {
            if (!c || typeof c !== "object") return null;
            const o = c as Record<string, unknown>;
            const id = String(o.category_id ?? o.id ?? "").trim();
            const name = String(o.category_name ?? o.name ?? id).trim();
            if (!id) return null;
            return { category_id: id, category_name: name, parent_id: 0 } as LiveCategory;
          })
          .filter((c): c is LiveCategory => c != null);
        const categories = mappedCats.length ? mappedCats : categoriesFromStreams(streams);
        return {
          categories,
          streamsByCat: groupStreamsByCategory(streams),
          authHeaders: nodecastAuthHeaders,
        };
      } catch {
        // try next source id
      }
    }

    throw new Error("Connected to Nodecast but no channels endpoint returned stream URLs.");
  }

  const categories = categoriesFromStreams(streams);
  return {
    categories,
    streamsByCat: groupStreamsByCategory(streams),
    authHeaders: nodecastAuthHeaders,
  };
}

async function resolveNodecastStreamUrl(
  base: string,
  s: LiveStream,
  authHeaders?: Record<string, string>
): Promise<string | null> {
  if (s.nodecast_source_id) {
    const sid = encodeURIComponent(s.nodecast_source_id);
    const streamId = encodeURIComponent(String(s.stream_id));
    const proxyXtreamCandidates = [
      `${base}/api/proxy/xtream/${sid}/stream/${streamId}/live?container=m3u8`,
      `${base}/api/proxy/xtream/${sid}/stream/${streamId}/live?container=ts`,
      `${base}/api/proxy/xtream/${sid}/stream/${streamId}`,
      `${base}/api/proxy/xtream/${sid}/live/${streamId}.m3u8`,
    ];
    for (const candidate of proxyXtreamCandidates) {
      const playable = await resolveCandidateToPlayableUrl(candidate, authHeaders);
      if (playable) return playable;
    }
    // In Nodecast mode, never fall back to direct provider URLs.
    // Upstream hosts commonly reject browser-style access (403/458).
    return null;
  }
  const id = (s.nodecast_channel_id ?? "").trim();
  if (!id) return null;

  const candidates = [
    `/api/channels/${encodeURIComponent(id)}/stream`,
    `/api/channels/${encodeURIComponent(id)}/play`,
    `/api/live/channels/${encodeURIComponent(id)}/stream`,
    `/api/stream/${encodeURIComponent(id)}`,
    `/stream/${encodeURIComponent(id)}`,
  ];

  for (const p of candidates) {
    try {
      const payload = await fetchProxiedJsonWithInit<unknown>(`${base}${p}`, {
        headers: authHeaders,
      });
      const url = extractStreamUrlDeep(payload);
      if (url) return url;
    } catch {
      // try next endpoint
    }
  }
  return null;
}

function updateChannelBadge(streamsInCat: number, shown: number): void {
  if (shown === streamsInCat) {
    elChannelCount.textContent = `${shown} total`;
  } else {
    elChannelCount.textContent = `${shown} / ${streamsInCat}`;
  }
}

function renderCategoryPills(): void {
  elCatPills.innerHTML = "";
  if (!state) return;
  if (!PILL_DEFS.some((p) => p.id === selectedPillId)) {
    selectedPillId = "all";
  }
  for (const p of PILL_DEFS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-pill";
    btn.setAttribute("role", "tab");
    btn.dataset.pillId = p.id;
    if (p.id === selectedPillId) btn.classList.add("active");
    btn.textContent = p.label;
    btn.addEventListener("click", () => {
      selectedPillId = p.id;
      elCatPills.querySelectorAll(".cat-pill").forEach((b) => {
        b.classList.toggle("active", (b as HTMLButtonElement).dataset.pillId === p.id);
      });
      renderStreams(selectedPillId, elStreamFilter.value);
    });
    elCatPills.appendChild(btn);
  }
  renderStreams(selectedPillId, elStreamFilter.value);
}

function renderStreams(pillId: PillId, filter: string): void {
  elStreamList.innerHTML = "";
  if (!state) return;
  const streams = streamsForPill(state.streamsByCat, state.categories, pillId);
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? streams.filter((s) => {
        const d = displayChannelName(s.name).toLowerCase();
        return d.includes(q) || s.name.toLowerCase().includes(q);
      })
    : streams;

  updateChannelBadge(streams.length, filtered.length);

  for (const s of filtered) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stream-row channel-card";
    if (activeStreamId === s.stream_id) btn.classList.add("active");

    const iconHref = resolvedIconUrl(s.stream_icon, state.base);
    if (iconHref) {
      const img = document.createElement("img");
      img.className = "ch-logo";
      img.alt = "";
      img.decoding = "async";
      img.loading = "lazy";
      img.src = proxiedUrl(iconHref);
      img.addEventListener("error", () => {
        const ph = document.createElement("span");
        ph.className = "ch-logo ch-logo--empty";
        ph.setAttribute("aria-hidden", "true");
        img.replaceWith(ph);
      });
      btn.appendChild(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "ch-logo ch-logo--empty";
      ph.setAttribute("aria-hidden", "true");
      btn.appendChild(ph);
    }

    const textWrap = document.createElement("div");
    textWrap.className = "channel-card__text";
    const titleEl = document.createElement("span");
    titleEl.className = "channel-card__title";
    titleEl.textContent = displayChannelName(s.name);
    const subEl = document.createElement("span");
    subEl.className = "channel-card__sub";
    const epgId = s.epg_channel_id;
    subEl.textContent =
      typeof epgId === "string" && epgId.trim() ? `EPG: ${epgId}` : "Live stream";
    const prog = document.createElement("div");
    prog.className = "channel-card__progress";
    const progBar = document.createElement("div");
    progBar.className = "channel-card__progress-bar";
    prog.appendChild(progBar);
    textWrap.appendChild(titleEl);
    textWrap.appendChild(subEl);
    textWrap.appendChild(prog);
    btn.appendChild(textWrap);
    btn.addEventListener("click", () => {
      activeStreamId = s.stream_id;
      elStreamList.querySelectorAll("button.channel-card").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (state!.mode === "nodecast") {
        elNowPlaying.textContent = "Resolving stream URL...";
        void (async () => {
          const resolved = await resolveNodecastStreamUrl(
            state!.base,
            s,
            state!.nodecastAuthHeaders
          );
          if (!resolved) {
            elNowPlaying.innerHTML = '<span class="error">Could not resolve this channel stream URL from Nodecast API.</span>';
            return;
          }
          if (!sameOrigin(resolved, state!.base)) {
            elNowPlaying.innerHTML = '<span class="error">Blocked non-Nodecast playback URL; proxy stream endpoint required.</span>';
            return;
          }
          s.direct_source = resolved;
          playUrl(resolved, displayChannelName(s.name));
        })();
        return;
      }
      const m3u8 = buildLiveStreamUrl(state!.serverInfo, state!.username, state!.password, s.stream_id, "m3u8");
      playUrl(m3u8, displayChannelName(s.name));
    });
    li.appendChild(btn);
    elStreamList.appendChild(li);
  }

  if (filtered.length === 0) {
    const li = document.createElement("li");
    const empty = document.createElement("div");
    empty.style.padding = "0.75rem";
    empty.style.color = "var(--muted)";
    empty.textContent = "No channels match.";
    li.appendChild(empty);
    elStreamList.appendChild(li);
  }
}

async function connect(): Promise<void> {
  setLoginStatus("");
  const base = normalizeServerInput(elServer.value);
  const username = elUser.value.trim();
  const password = elPass.value;

  if (!base || !username || !password) {
    setLoginStatus("Fill server URL, username, and password.", true);
    return;
  }

  elBtnConnect.disabled = true;
  setLoginStatus("Connecting to Nodecast…");

  try {
    const mode: "nodecast" = "nodecast";
    const nodecast = await tryNodecastLoginAndLoad(base, username, password);
    let cats: LiveCategory[] = nodecast.categories;
    let streamsByCat = nodecast.streamsByCat;
    const nodecastAuthHeaders = nodecast.authHeaders;
    const serverInfo: ServerInfo = {
      url: new URL(base).hostname,
      port: new URL(base).port || (new URL(base).protocol === "https:" ? "443" : "80"),
      server_protocol: new URL(base).protocol.replace(":", ""),
    };

    const france = filterCategoriesAndStreamsToFrance(cats, streamsByCat);
    cats = france.categories;
    streamsByCat = france.streamsByCat;

    state = {
      mode,
      base,
      username,
      password,
      nodecastAuthHeaders,
      serverInfo: serverInfo!,
      categories: cats,
      streamsByCat,
    };

    selectedPillId = "all";
    elStreamFilter.value = "";
    renderCategoryPills();

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
  destroyPlayer();
  elStreamList.innerHTML = "";
  elCatPills.innerHTML = "";
  elStreamFilter.value = "";
  elNowPlaying.textContent = "";
  elChannelCount.textContent = "0";
  elMain.classList.add("hidden");
  elLoginPanel.classList.remove("hidden");
  setLoginStatus("");
}

elBtnConnect.addEventListener("click", () => void connect());
elBtnLogout.addEventListener("click", disconnect);

elStreamFilter.addEventListener("input", () => {
  renderStreams(selectedPillId, elStreamFilter.value);
});

elServer.value = "http://5.180.180.198:3000";
elUser.value = "samadoxal";
elPass.value = "123456";

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement?.closest(".login-panel")) {
    void connect();
  }
});
