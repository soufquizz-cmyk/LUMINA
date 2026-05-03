/**
 * Server-only: multipart package cover upload → Cloudflare R2 (S3 API).
 * Used by Vite dev/preview middleware and Vercel `api/r2-package-cover.ts`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const MAX_BYTES = 2 * 1024 * 1024;
/** Multipart body can exceed file size (boundaries); keep a hard cap for buffering. */
const MAX_BODY_BYTES = MAX_BYTES + 512 * 1024;
const ROUTE_PREFIX = "/api/r2-package-cover";

/** Shared agent for R2 S3 API (TLS 1.2+; avoids odd defaults on some serverless runtimes). */
const r2S3HttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  minVersion: "TLSv1.2",
});

/** Cloudflare account IDs are 32 hex chars (Workers / R2 dashboard → Account ID). */
function invalidR2AccountIdMessage(accountId: string): string | null {
  const t = accountId.trim();
  if (/^R2_ACCOUNT_ID$/i.test(t)) {
    return (
      "R2_ACCOUNT_ID is still the placeholder text. In Vercel → Settings → Environment Variables, " +
      "set R2_ACCOUNT_ID to your real Cloudflare Account ID (32 hex characters), not the words R2_ACCOUNT_ID."
    );
  }
  if (t.length !== 32 || !/^[0-9a-f]+$/i.test(t)) {
    return (
      "R2_ACCOUNT_ID must be your Cloudflare Account ID: exactly 32 hexadecimal characters " +
      "(Dashboard → Workers & Pages or R2 → copy Account ID on the right). Wrong values cause TLS handshake failures against R2."
    );
  }
  return null;
}

function r2S3ApiEndpoint(accountId: string, env: NodeJS.ProcessEnv): string {
  const explicit = env.R2_S3_ENDPOINT?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const j = (env.R2_JURISDICTION ?? "").trim().toLowerCase();
  if (j === "eu") return `https://${accountId}.eu.r2.cloudflarestorage.com`;
  if (j === "fedramp") return `https://${accountId}.fedramp.r2.cloudflarestorage.com`;
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function headerString(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  if (v == null) return "";
  return Array.isArray(v) ? String(v[0] ?? "").trim() : String(v).trim();
}

function debugPackageCover(env: NodeJS.ProcessEnv): boolean {
  const v = (env.VITE_DEBUG_PACKAGE_COVER ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function logDebug(env: NodeJS.ProcessEnv, msg: string, extra?: Record<string, unknown>): void {
  if (!debugPackageCover(env)) return;
  if (extra) console.log("[package-cover:r2]", msg, extra);
  else console.log("[package-cover:r2]", msg);
}

function corsJsonHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Upload-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function sanitizePackagePrefix(packageId: string): string {
  const t = packageId.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  return t.length ? t.slice(0, 120) : "pkg";
}

/**
 * Multipart `filename` is often UTF-8 bytes mis-decoded as Latin-1 (busboy / clients).
 * Example: `tÃ©lÃ©chargement (52).jpg` → `téléchargement (52).jpg`
 */
function decodeMultipartFilename(name: string): string {
  const t = (name.trim() || "upload").normalize("NFC");
  if (!/[ÃÂ]/.test(t)) return t;
  try {
    const recovered = Buffer.from(t, "latin1").toString("utf8");
    if (!recovered.includes("\uFFFD") && recovered.length > 0) return recovered.normalize("NFC");
  } catch {
    /* ignore */
  }
  return t;
}

function readEnv(env: NodeJS.ProcessEnv): {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBase: string;
  s3Endpoint: string;
  uploadSecrets: string[];
} | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;

  const s3Endpoint = r2S3ApiEndpoint(accountId, env);

  const explicit = env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  // `https://{bucket}.{accountId}.r2.dev` is NOT a valid public host (browser: ERR_SSL_VERSION_OR_CIPHER_MISMATCH).
  // Default matches Cloudflare's usual dev URL: `https://{bucket}.r2.dev` — if yours differs, set R2_PUBLIC_BASE_URL
  // to the exact origin shown under R2 → bucket → Settings → Public development URL (e.g. https://pub-….r2.dev).
  const publicBase = explicit || `https://${bucket}.r2.dev`;

  const uploadSecrets: string[] = [];
  const bearer = env.VITE_CLOUDFLARE_COVER_UPLOAD_SECRET?.trim();
  if (bearer) uploadSecrets.push(bearer);

  return { accountId, accessKeyId, secretAccessKey, bucket, publicBase, s3Endpoint, uploadSecrets };
}

async function putObjectToR2(
  cfg: NonNullable<ReturnType<typeof readEnv>>,
  key: string,
  body: Buffer,
  contentType: string
): Promise<{ ok: true } | { error: string }> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: cfg.s3Endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({
      httpsAgent: r2S3HttpsAgent,
      connectionTimeout: 15_000,
      socketTimeout: 120_000,
    }),
  });
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "R2 put failed" };
  }
}

function authorize(req: IncomingMessage, uploadSecrets: string[]): boolean {
  if (!uploadSecrets.length) return true;
  const auth = headerString(req, "authorization");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerKey = headerString(req, "x-upload-key");
  return uploadSecrets.some((s) => s === bearer || s === headerKey);
}

function json(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = corsJsonHeaders()
): void {
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** True if this request targets the R2 package-cover route (path + optional query). */
export function isR2PackageCoverRoute(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0] ?? "";
  return path === ROUTE_PREFIX;
}

export async function handleR2PackageCoverRoute(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsJsonHeaders());
      res.end();
      return;
    }

    if (req.method === "GET") {
      json(res, 200, { ok: true, service: "r2-package-cover" });
      return;
    }

    if (req.method !== "POST") {
      logDebug(env, "reject non-POST", { method: req.method });
      json(res, 405, { error: "Method not allowed" });
      return;
    }

    const cfg = readEnv(env);
    if (!cfg) {
      logDebug(env, "R2 env incomplete", {
        hasAccountId: Boolean(env.R2_ACCOUNT_ID?.trim()),
        hasAccessKey: Boolean(env.R2_ACCESS_KEY_ID?.trim()),
        hasSecret: Boolean(env.R2_SECRET_ACCESS_KEY?.trim()),
        hasBucket: Boolean(env.R2_BUCKET_NAME?.trim()),
      });
      json(res, 503, {
        error:
          "R2 is not configured (set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME).",
      });
      return;
    }

    const accountIdErr = invalidR2AccountIdMessage(cfg.accountId);
    if (accountIdErr) {
      logDebug(env, "R2_ACCOUNT_ID invalid", { accountIdPreview: `${cfg.accountId.slice(0, 6)}…` });
      json(res, 503, { error: accountIdErr });
      return;
    }

    logDebug(env, "R2 config", {
      bucket: cfg.bucket,
      publicBase: cfg.publicBase,
      s3Endpoint: cfg.s3Endpoint,
      authRequired: cfg.uploadSecrets.length > 0,
    });

    if (!authorize(req, cfg.uploadSecrets)) {
      logDebug(env, "401 missing or wrong bearer / X-Upload-Key");
      json(res, 401, { error: "Unauthorized" });
      return;
    }

    const ct = headerString(req, "content-type");
    if (!ct.includes("multipart/form-data")) {
      json(res, 400, { error: "Expected multipart/form-data" });
      return;
    }

    const bodyRead = await readRequestBodyBuffer(req);
    if ("error" in bodyRead) {
      logDebug(env, "body read error", bodyRead);
      json(res, bodyRead.status, { error: bodyRead.error });
      return;
    }

    const parsed = await parseMultipartAsync(bodyRead.buffer, ct);
    if ("error" in parsed) {
      logDebug(env, "multipart error", { status: parsed.status, error: parsed.error });
      json(res, parsed.status, { error: parsed.error });
      return;
    }

    const { fileBuffer, fileName, mime, packageId } = parsed;
    logDebug(env, "parsed multipart", {
      packageId,
      fileName,
      mime,
      bytes: fileBuffer.length,
    });
    const rawExt = (fileName.split(".").pop() || "jpg").toLowerCase();
    const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "jpg";
    const folder = sanitizePackagePrefix(packageId);
    const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const contentType = mime || (ext === "jpg" ? "image/jpeg" : `image/${ext}`);

    const put = await putObjectToR2(cfg, key, fileBuffer, contentType);
    if ("error" in put) {
      logDebug(env, "PutObject failed", { key, s3Endpoint: cfg.s3Endpoint, message: put.error });
      json(res, 500, { error: put.error });
      return;
    }

    const pathEnc = key.split("/").map(encodeURIComponent).join("/");
    const url = `${cfg.publicBase}/${pathEnc}`;
    logDebug(env, "PutObject ok", { key, url });
    json(res, 200, { url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[package-cover:r2] unhandled", msg, e instanceof Error ? e.stack : "");
    if (!res.headersSent) {
      json(res, 500, { error: msg });
    }
  }
}

type ParseOk = {
  fileBuffer: Buffer;
  fileName: string;
  mime: string;
  packageId: string;
};

type ParseErr = { error: string; status: number };

async function readRequestBodyBuffer(req: IncomingMessage): Promise<{ buffer: Buffer } | ParseErr> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > MAX_BODY_BYTES) {
        return { error: "Corps de requête trop volumineux.", status: 413 };
      }
      chunks.push(b);
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Lecture du corps impossible.", status: 400 };
  }
  return { buffer: Buffer.concat(chunks) };
}

/** Buffer first; busboy loaded lazily (smaller Vercel cold bundle). */
async function parseMultipartAsync(body: Buffer, contentType: string): Promise<ParseOk | ParseErr> {
  const busboyMod = await import("busboy");
  const busboyFactory = busboyMod.default;
  return new Promise((resolve) => {
    const bb = busboyFactory({
      headers: { "content-type": contentType },
      limits: { fileSize: MAX_BYTES },
    });

    let fileBuffer: Buffer | null = null;
    let fileName = "";
    let mime = "";
    let packageId = "";
    let fileTooBig = false;

    bb.on("field", (name, val) => {
      if (name === "packageId") packageId = String(val).trim();
    });

    bb.on("file", (_name, file, info) => {
      fileName = decodeMultipartFilename(info.filename || "upload");
      mime = info.mimeType || "";
      const chunks: Buffer[] = [];
      file.on("data", (d: Buffer) => {
        chunks.push(d);
      });
      file.on("limit", () => {
        fileTooBig = true;
      });
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    bb.on("error", (err: Error) => {
      resolve({ error: err.message || "Multipart parse error", status: 400 });
    });

    bb.on("finish", () => {
      if (fileTooBig) {
        resolve({ error: "Image trop volumineuse (max 2 Mo).", status: 413 });
        return;
      }
      if (!fileBuffer?.length) {
        resolve({ error: "Missing file field", status: 400 });
        return;
      }
      const pid = packageId || "pkg";
      resolve({
        fileBuffer,
        fileName,
        mime,
        packageId: pid,
      });
    });

    Readable.from(body).pipe(bb);
  });
}
