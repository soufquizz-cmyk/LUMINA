/** Shared Nodecast catalog loading + stream URL resolution (player + admin). */

export type LiveCategory = {
  category_id: string;
  category_name: string;
  parent_id: number;
};

export type LiveStream = {
  stream_id: number;
  name: string;
  category_id?: string | number;
  stream_icon?: string;
  epg_channel_id?: string | null;
  direct_source?: string;
  nodecast_channel_id?: string;
  nodecast_source_id?: string;
};

export type ProxiedRequestInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

const PROXY_PREFIX = (import.meta.env.VITE_PROXY_PREFIX ?? "/proxy").replace(/\/$/, "");

export function normalizeServerInput(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  return s;
}

export function proxiedUrl(target: string, fromPlaylist?: string): string {
  const p = new URLSearchParams();
  p.set("target", target);
  p.set("from", fromPlaylist ?? target);
  return `${PROXY_PREFIX}?${p.toString()}`;
}

const FETCH_TIMEOUT_MS = 90_000;
const TRANSCODE_CACHE_MS = 3 * 60 * 1000;
const transcodePlaylistCache = new Map<string, { expires: number; playlistUrl: string }>();
const transcodeInflight = new Map<string, Promise<string | null>>();

export async function fetchProxiedJson<T>(url: string): Promise<T> {
  return fetchProxiedJsonWithInit<T>(url);
}

export async function fetchProxiedJsonWithInit<T>(
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

function buildNodecastProxyStreamPlaylistUrl(nodecastBase: string, upstreamUrl: string): string {
  const b = nodecastBase.replace(/\/+$/, "");
  return `${b}/api/proxy/stream?url=${encodeURIComponent(upstreamUrl)}`;
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

    if (ct.includes("application/json") || body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
      try {
        const parsed = JSON.parse(body) as unknown;
        const extracted = extractStreamUrlDeep(parsed);
        if (!extracted) return null;
        try {
          const candidateUrl = new URL(candidate);
          const extractedUrl = new URL(extracted, candidateUrl);
          if (extractedUrl.origin !== candidateUrl.origin) {
            const nodecastOrigin = `${candidateUrl.protocol}//${candidateUrl.host}`;
            const viaProxy = buildNodecastProxyStreamPlaylistUrl(nodecastOrigin, extractedUrl.href);
            const playable = await resolveCandidateToPlayableUrl(viaProxy, headers);
            if (playable) return playable;
            return await createNodecastTranscodeUrl(nodecastOrigin, extractedUrl.href, headers);
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

export function mapNodecastChannelToLiveStream(raw: unknown, index: number): LiveStream | null {
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

export function groupStreamsByCategory(streams: LiveStream[]): Map<string, LiveStream[]> {
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

export async function tryNodecastLoginAndLoad(
  base: string,
  username: string,
  password: string
): Promise<{
  categories: LiveCategory[];
  streamsByCat: Map<string, LiveStream[]>;
  authHeaders?: Record<string, string>;
}> {
  const loginCandidates = ["/api/auth/login", "/api/login", "/auth/login"];
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
          fetchProxiedJsonWithInit<unknown>(
            `${base}/api/proxy/xtream/${encodeURIComponent(sourceId)}/live_categories`,
            { headers: nodecastAuthHeaders }
          ),
          fetchProxiedJsonWithInit<unknown>(
            `${base}/api/proxy/xtream/${encodeURIComponent(sourceId)}/live_streams`,
            { headers: nodecastAuthHeaders }
          ),
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

export async function resolveNodecastStreamUrl(
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

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
