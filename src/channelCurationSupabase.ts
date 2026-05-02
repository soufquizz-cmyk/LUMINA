import type { SupabaseClient } from "@supabase/supabase-js";

export type StreamCurationRow = {
  stream_id: number;
  country_id: string;
  target_package_id: string;
};

export function indexStreamCurations(rows: readonly StreamCurationRow[]): Map<string, Map<number, string>> {
  const m = new Map<string, Map<number, string>>();
  for (const r of rows) {
    const sid = Number(r.stream_id);
    if (!Number.isFinite(sid)) continue;
    let inner = m.get(r.country_id);
    if (!inner) {
      inner = new Map();
      m.set(r.country_id, inner);
    }
    inner.set(sid, r.target_package_id);
  }
  return m;
}

export async function fetchDbStreamCurations(sb: SupabaseClient): Promise<Map<string, Map<number, string>>> {
  const { data, error } = await sb
    .from("admin_stream_curations")
    .select("stream_id, country_id, target_package_id");
  if (error) throw error;
  return indexStreamCurations((data ?? []) as StreamCurationRow[]);
}

export async function upsertStreamCuration(
  sb: SupabaseClient,
  row: { stream_id: number; country_id: string; target_package_id: string }
): Promise<{ error?: string }> {
  const payload = {
    stream_id: row.stream_id,
    country_id: row.country_id,
    target_package_id: row.target_package_id,
  };
  const { error } = await sb.from("admin_stream_curations").upsert(payload, {
    onConflict: "stream_id,country_id",
  });
  if (!error) return {};

  await sb
    .from("admin_stream_curations")
    .delete()
    .eq("stream_id", row.stream_id)
    .eq("country_id", row.country_id);
  const ins = await sb.from("admin_stream_curations").insert(payload);
  if (ins.error) return { error: `${error.message} (puis ${ins.error.message})` };
  return {};
}
