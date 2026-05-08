import type { SupabaseClient } from "@supabase/supabase-js";

export type PackageGridOrderRow = {
  country_id: string;
  ui_tab: string;
  package_order: string[] | string;
};

/** Key: `${country_id}::${ui_tab}` -> ordered package ids */
export async function fetchDbPackageGridOrders(sb: SupabaseClient): Promise<Map<string, string[]>> {
  const { data, error } = await sb
    .from("admin_country_package_order")
    .select("country_id, ui_tab, package_order");
  if (error) throw error;
  const m = new Map<string, string[]>();
  for (const raw of data ?? []) {
    const r = raw as PackageGridOrderRow;
    const arr = Array.isArray(r.package_order) ? r.package_order : [];
    const ids = arr
      .map((x) => String(x).trim())
      .filter((x) => x.length > 0);
    m.set(`${r.country_id}::${r.ui_tab}`, ids);
  }
  return m;
}

export async function upsertPackageGridOrder(
  sb: SupabaseClient,
  row: { country_id: string; ui_tab: "live" | "movies" | "series"; package_order: string[] }
): Promise<{ error?: string }> {
  const { error } = await sb.from("admin_country_package_order").upsert(
    {
      country_id: row.country_id,
      ui_tab: row.ui_tab,
      package_order: row.package_order,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "country_id,ui_tab" }
  );
  if (error) return { error: error.message };
  return {};
}
