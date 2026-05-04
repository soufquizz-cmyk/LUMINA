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

export type PackageCoverOverrideEntry = {
  cover_url: string | null;
  theme_bg: string | null;
  theme_surface: string | null;
  theme_primary: string | null;
  theme_glow: string | null;
  theme_back: string | null;
};

function rowToEntry(row: Record<string, unknown>): PackageCoverOverrideEntry {
  const s = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length ? t : null;
  };
  return {
    cover_url: s(row.cover_url),
    theme_bg: s(row.theme_bg),
    theme_surface: s(row.theme_surface),
    theme_primary: s(row.theme_primary),
    theme_glow: s(row.theme_glow),
    theme_back: s(row.theme_back),
  };
}

function entryHasAnyTheme(e: PackageCoverOverrideEntry): boolean {
  return Boolean(
    e.theme_bg ||
      e.theme_surface ||
      e.theme_primary ||
      e.theme_glow ||
      e.theme_back
  );
}

/** Catalogue / bouquets synthétiques : image + couleurs hors `admin_packages`. */
export async function fetchDbPackageCoverOverrides(
  sb: SupabaseClient
): Promise<Map<string, PackageCoverOverrideEntry>> {
  const { data, error } = await sb
    .from("admin_package_covers")
    .select("package_id, cover_url, theme_bg, theme_surface, theme_primary, theme_glow, theme_back");
  if (error) {
    if (isMissingAdminPackageCoversTable(error)) {
      console.warn("[package-cover]", MISSING_ADMIN_PACKAGE_COVERS_HINT, error.message);
      return new Map();
    }
    throw error;
  }
  const m = new Map<string, PackageCoverOverrideEntry>();
  for (const row of data ?? []) {
    const o = row as { package_id?: string };
    const id = o.package_id?.trim();
    if (!id) continue;
    const e = rowToEntry(row as Record<string, unknown>);
    if (!e.cover_url && !entryHasAnyTheme(e)) continue;
    m.set(id, e);
  }
  return m;
}

export async function upsertPackageCoverOverride(
  sb: SupabaseClient,
  packageId: string,
  coverUrl: string,
  preserve?: PackageCoverOverrideEntry | null
): Promise<{ error?: string }> {
  const row = {
    package_id: packageId,
    cover_url: coverUrl,
    theme_bg: preserve?.theme_bg ?? null,
    theme_surface: preserve?.theme_surface ?? null,
    theme_primary: preserve?.theme_primary ?? null,
    theme_glow: preserve?.theme_glow ?? null,
    theme_back: preserve?.theme_back ?? null,
  };
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

export type PackageThemeColumns = {
  theme_bg: string | null;
  theme_surface: string | null;
  theme_primary: string | null;
  theme_glow: string | null;
  theme_back: string | null;
};

/** Persists theme on a catalogue id (`admin_package_covers`), keeping existing cover URL when present. */
export async function upsertPackageCoverThemeOnly(
  sb: SupabaseClient,
  packageId: string,
  themes: PackageThemeColumns,
  prev: PackageCoverOverrideEntry | null | undefined
): Promise<{ error?: string }> {
  const cover =
    prev?.cover_url && prev.cover_url.trim().length ? prev.cover_url.trim() : null;
  const none =
    !themes.theme_bg?.trim() &&
    !themes.theme_surface?.trim() &&
    !themes.theme_primary?.trim() &&
    !themes.theme_glow?.trim() &&
    !themes.theme_back?.trim();
  if (none && !cover) {
    return deletePackageCoverOverride(sb, packageId);
  }
  const row = {
    package_id: packageId,
    cover_url: cover,
    ...themes,
  };
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

/** Retire l’image ; conserve une ligne si des couleurs sont encore définies. */
export async function clearPackageCoverImageKeepingThemes(
  sb: SupabaseClient,
  packageId: string,
  prev: PackageCoverOverrideEntry | null | undefined
): Promise<{ error?: string }> {
  if (!prev || (!prev.cover_url?.trim() && !entryHasAnyTheme(prev))) return {};
  if (entryHasAnyTheme(prev)) {
    const { error } = await sb
      .from("admin_package_covers")
      .update({
        cover_url: null,
        theme_bg: prev.theme_bg,
        theme_surface: prev.theme_surface,
        theme_primary: prev.theme_primary,
        theme_glow: prev.theme_glow,
        theme_back: prev.theme_back,
      })
      .eq("package_id", packageId);
    if (error) {
      if (isMissingAdminPackageCoversTable(error)) {
        return { error: `${error.message}\n\n${MISSING_ADMIN_PACKAGE_COVERS_HINT}` };
      }
      return { error: error.message };
    }
    return {};
  }
  return deletePackageCoverOverride(sb, packageId);
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
