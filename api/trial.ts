/**
 * Vercel serverless: GET/POST `/api/trial` for IP-based trial usage.
 * Set `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY`.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleTrialUsageRoute } from "./trialUsageShared.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  await handleTrialUsageRoute(req, res, process.env);
}
