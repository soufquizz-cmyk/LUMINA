/**
 * Cloudflare Worker entry: `/api/trial` (Supabase usage) then static assets.
 * Secrets: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
 * Vars: `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`, optional `VITE_TRIAL_SECONDS` / `TRIAL_SECONDS`
 */
const TRIAL_ROUTE = "/api/trial";
const MAX_ADD_PER_REQUEST = 20;

function corsJsonHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
  };
}

function readLimitSeconds(env) {
  const raw = String(env.VITE_TRIAL_SECONDS ?? env.TRIAL_SECONDS ?? "").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.min(Math.max(Math.floor(n), 60), 86400);
}

/** Same as `api/trialUsageShared.ts` — one DB key for all localhost shapes. */
function canonicalTrialIpKey(raw) {
  const t = String(raw).trim().slice(0, 128);
  const lower = t.toLowerCase();
  if (lower === "localhost") return "::1";
  if (lower === "127.0.0.1") return "::1";
  if (lower === "::1") return "::1";
  if (lower === "::ffff:127.0.0.1") return "::1";
  return t;
}

function trialClientIp(request) {
  const vff = request.headers.get("x-vercel-forwarded-for");
  if (vff) {
    const first = vff.split(",")[0]?.trim();
    if (first) return canonicalTrialIpKey(first);
  }
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return canonicalTrialIpKey(first);
  }
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return canonicalTrialIpKey(cf.trim());
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return canonicalTrialIpKey(realIp.trim());
  return "unknown";
}

function isTrialPath(pathname) {
  return pathname === TRIAL_ROUTE || pathname === `${TRIAL_ROUTE}/`;
}

function buildTrialJson(used, limit) {
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

async function trialFetchSeconds(sbUrl, serviceKey, ip) {
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
  const rows = await r.json();
  const v = rows[0]?.seconds_used;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

async function trialUpsertSeconds(sbUrl, serviceKey, ip, secondsUsed) {
  const u = `${sbUrl.replace(/\/+$/, "")}/rest/v1/trial_usage`;
  await fetch(u, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      ip_address: ip,
      seconds_used: secondsUsed,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function readJsonBody(request) {
  try {
    const t = await request.text();
    if (!t.trim()) return {};
    const o = JSON.parse(t);
    const n = Number(o.addSeconds);
    return Number.isFinite(n) ? { addSeconds: n } : {};
  } catch {
    return {};
  }
}

async function handleTrial(request, env) {
  const cors = corsJsonHeaders();
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  const method = request.method.toUpperCase();
  const limit = readLimitSeconds(env);
  const sbUrl = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!sbUrl || !key) {
    return new Response(
      JSON.stringify({
        trialDisabled: true,
        secondsUsed: 0,
        limitSeconds: limit,
        remainingSeconds: limit,
        exhausted: false,
      }),
      { status: 200, headers: cors }
    );
  }

  const ip = trialClientIp(request);
  if (ip === "unknown") {
    return new Response(
      JSON.stringify({
        trialDisabled: true,
        secondsUsed: 0,
        limitSeconds: limit,
        remainingSeconds: limit,
        exhausted: false,
      }),
      { status: 200, headers: cors }
    );
  }

  try {
    if (method === "GET") {
      const used = await trialFetchSeconds(sbUrl, key, ip);
      return new Response(JSON.stringify(buildTrialJson(used, limit)), {
        status: 200,
        headers: cors,
      });
    }
    if (method === "POST") {
      const { addSeconds: rawAdd } = await readJsonBody(request);
      const add = Math.max(0, Math.min(Math.floor(Number(rawAdd) || 0), MAX_ADD_PER_REQUEST));
      let used = await trialFetchSeconds(sbUrl, key, ip);
      if (add > 0) {
        used = Math.min(limit, used + add);
        await trialUpsertSeconds(sbUrl, key, ip, used);
      } else {
        used = Math.min(limit, used);
      }
      return new Response(JSON.stringify(buildTrialJson(used, limit)), {
        status: 200,
        headers: cors,
      });
    }
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: cors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Trial error";
    return new Response(
      JSON.stringify({
        trialDisabled: true,
        secondsUsed: 0,
        limitSeconds: limit,
        remainingSeconds: limit,
        exhausted: false,
        error: msg,
      }),
      { status: 500, headers: cors }
    );
  }
}

export default {
  /** @param {Request} request @param {{ ASSETS?: { fetch(request: Request): Promise<Response> } }} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isTrialPath(url.pathname)) {
      return handleTrial(request, env);
    }
    const assets = env.ASSETS;
    if (!assets?.fetch) {
      return new Response("ASSETS binding missing — check wrangler.toml [assets]", {
        status: 500,
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    }
    return assets.fetch(request);
  },
};
