/**
 * Cloudflare R2 (S3 API): shared JSON cache for Xtream/Nodecast catalogue GET responses.
 * Same env as package-cover uploads (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`).
 * Objects: `velora-catalog-cache/v1/<sha256(normalized-target-url)>.json` — raw upstream bytes, 10 min TTL via metadata.
 */
import { createHash } from "node:crypto";
import https from "node:https";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const CATALOG_R2_KEY_PREFIX = "velora-catalog-cache/v1/";
export const CATALOG_R2_TTL_MS = 10 * 60 * 1000;
const META_EXPIRES = "velora-expires-at";
const META_ETAG = "velora-upstream-etag";
/** Large `vod_streams` / `series` JSON can exceed 50MB; R2 allows much larger objects. */
const MAX_CATALOG_R2_BYTES = 64 * 1024 * 1024;

const r2S3HttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  minVersion: "TLSv1.2",
});

function stripDefaultPortHref(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" && u.port === "80") u.port = "";
    if (u.protocol === "https:" && u.port === "443") u.port = "";
    return u.href;
  } catch {
    return url;
  }
}

function r2S3ApiEndpoint(accountId: string, env: NodeJS.ProcessEnv): string {
  const explicit = env.R2_S3_ENDPOINT?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const j = (env.R2_JURISDICTION ?? "").trim().toLowerCase();
  if (j === "eu") return `https://${accountId}.eu.r2.cloudflarestorage.com`;
  if (j === "fedramp") return `https://${accountId}.fedramp.r2.cloudflarestorage.com`;
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

type R2Cfg = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  s3Endpoint: string;
};

function readR2CatalogConfig(env: NodeJS.ProcessEnv): R2Cfg | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    s3Endpoint: r2S3ApiEndpoint(accountId, env),
  };
}

export function isR2CatalogCacheConfigured(env: NodeJS.ProcessEnv): boolean {
  return readR2CatalogConfig(env) != null;
}

export function catalogCacheR2ObjectKey(targetUrl: string): string {
  const normalized = stripDefaultPortHref(targetUrl);
  const h = createHash("sha256").update(normalized, "utf8").digest("hex");
  return `${CATALOG_R2_KEY_PREFIX}${h}.json`;
}

function metaLookup(meta: Record<string, string> | undefined, canonicalKey: string): string {
  if (!meta) return "";
  const want = canonicalKey.toLowerCase().replace(/-/g, "");
  for (const [k, v] of Object.entries(meta)) {
    const kn = k.toLowerCase().replace(/^x-amz-meta-/, "").replace(/-/g, "");
    if (kn === want && typeof v === "string") return v.trim();
  }
  return "";
}

function metaExpiresMs(meta: Record<string, string> | undefined): number {
  const v = metaLookup(meta, META_EXPIRES);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function metaUpstreamEtag(meta: Record<string, string> | undefined): string {
  return metaLookup(meta, META_ETAG);
}

export type CatalogR2Hit = {
  body: Buffer;
  contentType: string | null;
  etag: string;
};

export async function tryGetCatalogFromR2(
  env: NodeJS.ProcessEnv,
  targetUrl: string,
): Promise<CatalogR2Hit | null> {
  const cfg = readR2CatalogConfig(env);
  if (!cfg) return null;
  const key = catalogCacheR2ObjectKey(targetUrl);
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
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
    const out = await client.send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: key })
    );
    const exp = metaExpiresMs(out.Metadata as Record<string, string> | undefined);
    if (!exp || exp <= Date.now()) return null;
    if (!out.Body) return null;
    const arr = await out.Body.transformToByteArray();
    const body = Buffer.from(arr);
    if (body.length === 0) return null;
    const ct = out.ContentType?.split(";")[0]?.trim() ?? null;
    const storedEtag = metaUpstreamEtag(out.Metadata as Record<string, string> | undefined);
    const etag =
      storedEtag ||
      `W/"r2-${createHash("sha1").update(body).digest("hex").slice(0, 24)}"`;
    return { body, contentType: ct, etag };
  } catch (e: unknown) {
    const name = e && typeof e === "object" && "name" in e ? String((e as { name: string }).name) : "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    console.warn("[catalog-r2] get failed", key, e);
    return null;
  }
}

export function schedulePutCatalogToR2(
  env: NodeJS.ProcessEnv,
  targetUrl: string,
  body: Buffer,
  contentType: string | null,
  upstreamEtag: string | null | undefined,
): void {
  if (body.length === 0 || body.length > MAX_CATALOG_R2_BYTES) return;
  const cfg = readR2CatalogConfig(env);
  if (!cfg) return;
  const key = catalogCacheR2ObjectKey(targetUrl);
  const expiresAt = Date.now() + CATALOG_R2_TTL_MS;
  const ct = (contentType && contentType.trim()) || "application/json";
  const etagMeta = (upstreamEtag && upstreamEtag.trim()) || "";
  void (async () => {
    try {
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
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: ct,
          Metadata: {
            [META_EXPIRES]: String(expiresAt),
            ...(etagMeta ? { [META_ETAG]: etagMeta.slice(0, 1024) } : {}),
          },
        })
      );
    } catch (e) {
      console.warn("[catalog-r2] put failed", key, e);
    }
  })();
}
