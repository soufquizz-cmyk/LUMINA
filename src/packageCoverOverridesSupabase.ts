import type { SupabaseClient } from "@supabase/supabase-js";

const MISSING_ADMIN_PACKAGE_COVERS_HINT =
  "Exécutez le fichier supabase-admin-package-covers.sql dans Supabase → SQL (table public.admin_package_covers).";

function isMissingAdminPackageCoversTable(err: { message?: string; code?: string }): boolean {
  const m = (err.message ?? "").toLowerCase();
  return (
    err.code === "PGRST205" ||
    (m.includes("admin_package_covers") && m.includes("schema cache")) ||
    m.includes("could not find the table")
  );
}

/** Catalogue / bouquets synthétiques : image personnalisée quand ce n’est pas une ligne `admin_packages`. */
export async function fetchDbPackageCoverOverrides(sb: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await sb.from("admin_package_covers").select("package_id, cover_url");
  if (error) {
    if (isMissingAdminPackageCoversTable(error)) {
      console.warn("[package-cover]", MISSING_ADMIN_PACKAGE_COVERS_HINT, error.message);
      return new Map();
    }
    throw error;
  }
  const m = new Map<string, string>();
  for (const row of data ?? []) {
    const o = row as { package_id?: string; cover_url?: string };
    const id = o.package_id?.trim();
    const u = o.cover_url?.trim();
    if (id && u) m.set(id, u);
  }
  return m;
}

export async function upsertPackageCoverOverride(
  sb: SupabaseClient,
  packageId: string,
  coverUrl: string
): Promise<{ error?: string }> {
  const row = { package_id: packageId, cover_url: coverUrl };
  const { error } = await sb.from("admin_package_covers").upsert(row, { onConflict: "package_id" });
  if (!error) return {};
  if (isMissingAdminPackageCoversTable(error)) {
    return { error: `${error.message}\n\n${MISSING_ADMIN_PACKAGE_COVERS_HINT}` };
  }
  await sb.from("admin_package_covers").delete().eq("package_id", packageId);
  const ins = await sb.from("admin_package_covers").insert(row);
  if (ins.error) {
    if (isMissingAdminPackageCoversTable(ins.error)) {
      return { error: `${error.message} (puis ${ins.error.message})\n\n${MISSING_ADMIN_PACKAGE_COVERS_HINT}` };
    }
    return { error: `${error.message} (puis ${ins.error.message})` };
  }
  return {};
}

export async function deletePackageCoverOverride(
  sb: SupabaseClient,
  packageId: string
): Promise<{ error?: string }> {
  const { error } = await sb.from("admin_package_covers").delete().eq("package_id", packageId);
  if (error) {
    if (isMissingAdminPackageCoversTable(error)) {
      return { error: `${error.message}\n\n${MISSING_ADMIN_PACKAGE_COVERS_HINT}` };
    }
    return { error: error.message };
  }
  return {};
}
