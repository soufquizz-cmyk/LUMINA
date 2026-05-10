/**
 * Server-only: IP-based free trial usage (Supabase `public.trial_usage`).
 * Used by Vite dev/preview middleware, Vercel `api/trial.ts`, and documented for parity.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const ROUTE_PREFIX = "/api/trial";

const DEFAULT_LIMIT_SECONDS = 60;
/** Max seconds credited per POST (mitigates inflated client payloads). */
const MAX_ADD_PER_REQUEST = 20;

function headerString(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  if (v == null) return "";
  return Array.isArray(v) ? String(v[0] ?? "").trim() : String(v).trim();
}

/**
 * One stable row for local dev: Node may report `::1`, `127.0.0.1`, or `::ffff:127.0.0.1` across requests / refreshes.
 * Without this, each variant gets its own `trial_usage` row and the timer appears to reset.
 */
export function canonicalTrialIpKey(raw: string): string {
  const t = raw.trim().slice(0, 128);
  const lower = t.toLowerCase();
  if (lower === "localhost") return "::1";
  if (lower === "127.0.0.1") return "::1";
  if (lower === "::1") return "::1";
  if (lower === "::ffff:127.0.0.1") return "::1";
  return t;
}

export function trialClientIp(req: IncomingMessage): string {
  const vff = headerString(req, "x-vercel-forwarded-for");
  if (vff) {
    const first = vff.split(",")[0]?.trim();
    if (first) return canonicalTrialIpKey(first);
  }
  const xff = headerString(req, "x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return canonicalTrialIpKey(first);
  }
  const cf = headerString(req, "cf-connecting-ip");
  if (cf) return canonicalTrialIpKey(cf);
  const realIp = headerString(req, "x-real-ip");
  if (realIp) return canonicalTrialIpKey(realIp);
  const ra = req.socket?.remoteAddress;
  if (typeof ra === "string" && ra.trim()) return canonicalTrialIpKey(ra.trim());
  return "unknown";
}

function corsHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function readLimitSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.VITE_TRIAL_SECONDS ?? env.TRIAL_SECONDS ?? "";
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT_SECONDS;
  return Math.min(Math.max(Math.floor(n), 60), 86_400);
}

function readSupabase(env: NodeJS.ProcessEnv): { url: string; key: string } | null {
  const url =
    env.SUPABASE_URL?.trim() ||
    env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    env.VITE_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

export type TrialStatusJson = {
  trialDisabled: boolean;
  secondsUsed: number;
  limitSeconds: number;
  remainingSeconds: number;
  exhausted: boolean;
};

function jsonBody(res: ServerResponse, status: number, body: TrialStatusJson & { error?: string }): void {
  res.statusCode = status;
  for (const [k, v] of Object.entries(corsHeaders())) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<{ addSeconds?: number }> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") return {};
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as { addSeconds?: unknown };
    const n = Number(o.addSeconds);
    if (!Number.isFinite(n)) return {};
    return { addSeconds: n };
  } catch {
    return {};
  }
}

async function fetchSecondsUsed(sbUrl: string, serviceKey: string, ip: string): Promise<number> {
  const u = new URL(`${sbUrl.replace(/\/+$/, "")}/rest/v1/trial_usage`);
  u.searchParams.set("select", "seconds_used");
  u.searchParams.set("ip_address", `eq.${ip}`);
  u.searchParams.set("limit", "1");
  const r = await fetch(u.href, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) return 0;
  const rows = (await r.json()) as { seconds_used?: number }[];
  const v = rows[0]?.seconds_used;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

async function upsertSecondsUsed(
  sbUrl: string,
  serviceKey: string,
  ip: string,
  secondsUsed: number
): Promise<void> {
  const u = `${sbUrl.replace(/\/+$/, "")}/rest/v1/trial_usage`;
  await fetch(u, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      ip_address: ip,
      seconds_used: secondsUsed,
      updated_at: new Date().toISOString(),
    }),
  });
}

function buildStatus(used: number, limit: number): TrialStatusJson {
  const capped = Math.min(Math.max(used, 0), limit);
  const remaining = Math.max(0, limit - capped);
  return {
    trialDisabled: false,
    secondsUsed: capped,
    limitSeconds: limit,
    remainingSeconds: remaining,
    exhausted: remaining <= 0,
  };
}

export function isTrialUsageRoute(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0] ?? "";
  return path === ROUTE_PREFIX || path === `${ROUTE_PREFIX}/`;
}

export async function handleTrialUsageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(corsHeaders())) {
      res.setHeader(k, v);
    }
    res.end();
    return;
  }

  const supabase = readSupabase(env);
  const limit = readLimitSeconds(env);
  if (!supabase) {
    jsonBody(res, 200, {
      trialDisabled: true,
      secondsUsed: 0,
      limitSeconds: limit,
      remainingSeconds: limit,
      exhausted: false,
    });
    return;
  }

  const ip = trialClientIp(req);
  if (ip === "unknown") {
    jsonBody(res, 200, {
      trialDisabled: true,
      secondsUsed: 0,
      limitSeconds: limit,
      remainingSeconds: limit,
      exhausted: false,
    });
    return;
  }

  try {
    if (method === "GET") {
      const used = await fetchSecondsUsed(supabase.url, supabase.key, ip);
      jsonBody(res, 200, buildStatus(used, limit));
      return;
    }
    if (method === "POST") {
      const { addSeconds: rawAdd } = await readJsonBody(req);
      const add = Math.max(
        0,
        Math.min(Math.floor(Number(rawAdd) || 0), MAX_ADD_PER_REQUEST)
      );
      let used = await fetchSecondsUsed(supabase.url, supabase.key, ip);
      if (add > 0) {
        used = Math.min(limit, used + add);
        await upsertSecondsUsed(supabase.url, supabase.key, ip, used);
      } else {
        used = Math.min(limit, used);
      }
      jsonBody(res, 200, buildStatus(used, limit));
      return;
    }
    res.statusCode = 405;
    for (const [k, v] of Object.entries(corsHeaders())) {
      res.setHeader(k, v);
    }
    res.end(JSON.stringify({ error: "Method not allowed" }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Trial server error";
    jsonBody(res, 500, {
      trialDisabled: true,
      secondsUsed: 0,
      limitSeconds: limit,
      remainingSeconds: limit,
      exhausted: false,
      error: msg,
    });
  }
}
