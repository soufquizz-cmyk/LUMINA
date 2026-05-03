/**
 * Vercel serverless: POST multipart → R2 (implementation in `r2PackageCoverShared.ts`).
 * Use a static import so Vercel bundles the helper into this function (dynamic `import("./…")`
 * can omit the sibling file from `/var/task` and cause ERR_MODULE_NOT_FOUND).
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
