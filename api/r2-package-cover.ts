/**
 * Vercel serverless: POST multipart (field `file`, optional `packageId`) → R2 via S3 API.
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME;
 * optional R2_PUBLIC_BASE_URL; optional upload auth via VITE_CLOUDFLARE_COVER_UPLOAD_SECRET (server env).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleR2PackageCoverRoute } from "./r2PackageCoverShared";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  await handleR2PackageCoverRoute(req, res);
}
