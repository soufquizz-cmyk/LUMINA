/** Country → package → category (leaf) → channel rules. Shared by player + admin. */

export type AdminCountry = { id: string; name: string };
export type AdminPackage = {
  id: string;
  country_id: string;
  name: string;
  /** Optional overrides; null/empty = use preset for that slot. */
  theme_bg?: string | null;
  theme_surface?: string | null;
  theme_primary?: string | null;
  theme_glow?: string | null;
  /** « Accueil » / liens secondaires. */
  theme_back?: string | null;
};
/** Leaf category (e.g. Sports) inside a package. */
export type AdminCategory = { id: string; package_id: string; name: string };
export type AdminAssignment = { id: string; match_text: string; category_id: string };
export type AdminHiddenFilter = { id: string; needle: string };

export type AdminConfig = {
  countries: AdminCountry[];
  packages: AdminPackage[];
  categories: AdminCategory[];
  assignments: AdminAssignment[];
  hiddenFilters: AdminHiddenFilter[];
};

export const EMPTY_ADMIN_CONFIG: AdminConfig = {
  countries: [],
  packages: [],
  categories: [],
  assignments: [],
  hiddenFilters: [],
};

export const ADMIN_STORAGE_KEY_V2 = "lumina_admin_config_v2";
const ADMIN_STORAGE_KEY_V1 = "lumina_admin_config_v1";

function isCountry(x: unknown): x is AdminCountry {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as AdminCountry).id === "string" &&
    typeof (x as AdminCountry).name === "string"
  );
}

function pickThemeStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

export function normalizePackage(raw: unknown): AdminPackage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.country_id !== "string" ||
    typeof o.name !== "string"
  ) {
    return null;
  }
  return {
    id: o.id,
    country_id: o.country_id,
    name: o.name,
    theme_bg: pickThemeStr(o, "theme_bg"),
    theme_surface: pickThemeStr(o, "theme_surface"),
    theme_primary: pickThemeStr(o, "theme_primary"),
    theme_glow: pickThemeStr(o, "theme_glow"),
    theme_back: pickThemeStr(o, "theme_back"),
  };
}

function isCategoryLeaf(x: unknown): x is AdminCategory {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as AdminCategory).id === "string" &&
    typeof (x as AdminCategory).package_id === "string" &&
    typeof (x as AdminCategory).name === "string"
  );
}

function isAssignment(x: unknown): x is AdminAssignment {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as AdminAssignment).id === "string" &&
    typeof (x as AdminAssignment).match_text === "string" &&
    typeof (x as AdminAssignment).category_id === "string"
  );
}

function isHidden(x: unknown): x is AdminHiddenFilter {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as AdminHiddenFilter).id === "string" &&
    typeof (x as AdminHiddenFilter).needle === "string"
  );
}

/** Migrate v1 flat `categories: {id,name}[]` into default country → package → leaves. */
function migrateV1FlatCategories(parsed: Record<string, unknown>): AdminConfig {
  const rawCats = parsed.categories;
  const rawAssign = parsed.assignments;
  const rawHidden = parsed.hiddenFilters;
  const gen = (p: string) =>
    `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const countryId = gen("country");
  const packageId = gen("pkg");
  const countries: AdminCountry[] = [{ id: countryId, name: "Default" }];
  const packages: AdminPackage[] = [{ id: packageId, country_id: countryId, name: "General" }];
  const categories: AdminCategory[] = Array.isArray(rawCats)
    ? rawCats
        .filter(isCategoryV1Flat)
        .map((c) => ({ id: c.id, package_id: packageId, name: c.name }))
    : [];
  const assignments: AdminAssignment[] = Array.isArray(rawAssign)
    ? rawAssign.filter(isAssignment)
    : [];
  const hiddenFilters: AdminHiddenFilter[] = Array.isArray(rawHidden)
    ? rawHidden.filter(isHidden)
    : [];
  return { countries, packages, categories, assignments, hiddenFilters };
}

function isCategoryV1Flat(x: unknown): x is { id: string; name: string } {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as { id: string }).id === "string" &&
    typeof (x as { name: string }).name === "string" &&
    !("package_id" in (x as object))
  );
}

export function parseAdminConfig(raw: unknown): AdminConfig {
  if (!raw || typeof raw !== "object") return { ...EMPTY_ADMIN_CONFIG };
  const o = raw as Record<string, unknown>;
  const cats = Array.isArray(o.categories) ? o.categories : [];
  const hasLeafCategories = cats.some(
    (c) => !!c && typeof c === "object" && "package_id" in (c as object)
  );
  const countryList = Array.isArray(o.countries) ? o.countries : [];
  const looksLikeHierarchy =
    hasLeafCategories ||
    countryList.length > 0 ||
    (Array.isArray(o.packages) && (o.packages as unknown[]).length > 0);

  if (looksLikeHierarchy) {
    return {
      countries: countryList.filter(isCountry),
      packages: Array.isArray(o.packages)
        ? o.packages.map(normalizePackage).filter((p): p is AdminPackage => p != null)
        : [],
      categories: cats.filter(isCategoryLeaf),
      assignments: Array.isArray(o.assignments) ? o.assignments.filter(isAssignment) : [],
      hiddenFilters: Array.isArray(o.hiddenFilters) ? o.hiddenFilters.filter(isHidden) : [],
    };
  }
  if (cats.length > 0) return migrateV1FlatCategories(o);
  return { ...EMPTY_ADMIN_CONFIG };
}

export function readAdminConfigFromLocalStorage(): AdminConfig {
  try {
    const v2 = localStorage.getItem(ADMIN_STORAGE_KEY_V2);
    if (v2) return parseAdminConfig(JSON.parse(v2) as unknown);
    const v1 = localStorage.getItem(ADMIN_STORAGE_KEY_V1);
    if (v1) {
      const migrated = parseAdminConfig(JSON.parse(v1) as unknown);
      localStorage.setItem(ADMIN_STORAGE_KEY_V2, JSON.stringify(migrated));
      return migrated;
    }
  } catch {
    /* ignore */
  }
  return { ...EMPTY_ADMIN_CONFIG };
}

export function writeAdminConfigToLocalStorage(cfg: AdminConfig): void {
  localStorage.setItem(ADMIN_STORAGE_KEY_V2, JSON.stringify(cfg));
}

export function leafCategoryLabel(cfg: AdminConfig, categoryId: string): string {
  const cat = cfg.categories.find((c) => c.id === categoryId);
  if (!cat) return "Unknown";
  const pkg = cfg.packages.find((p) => p.id === cat.package_id);
  const country = pkg ? cfg.countries.find((c) => c.id === pkg.country_id) : undefined;
  return [country?.name, pkg?.name, cat.name].filter(Boolean).join(" › ");
}
