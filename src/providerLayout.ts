/**
 * Build in-memory country › « package » layout from the provider catalogue:
 * each live category is a grid card; country is inferred from titles; zones
 * `|AR|`, `|AF|`, … viennent des clés dans `canonical_countries` / RAW (ex. clé `ar` → « Arabe »).
 */

import type { AdminConfig, AdminCountry, AdminPackage } from "./adminHierarchyConfig";
import type { LiveCategory, LiveStream } from "./nodecastCatalog";
import { matchCanonicalCountry, type ParsedCountry } from "./canonicalCountries";
import ISO_ALPHA3_TO_ALPHA2 from "./isoAlpha3ToAlpha2.json";

export type { ParsedCountry };

const OTHER_COUNTRY_ID = "country__other";

const ISO_NAMES: Record<string, string> = {
  FR: "France",
  BE: "Belgique",
  CH: "Suisse",
  CA: "Canada",
  US: "États-Unis",
  GB: "Royaume-Uni",
  UK: "Royaume-Uni",
  /** IPTV VOD buckets: “English”, not ISO3166 alpha-2. */
  EN: "United Kingdom",
  DE: "Allemagne",
  ES: "Espagne",
  IT: "Italie",
  MA: "Maroc",
  DZ: "Algérie",
  TN: "Tunisie",
  PT: "Portugal",
  NL: "Pays-Bas",
  LU: "Luxembourg",
  AT: "Autriche",
  PL: "Pologne",
  TR: "Turquie",
  AR: "Arabie / Monde arabe",
};

let regionNamesEn: Intl.DisplayNames | null | undefined;

function regionDisplayNameEn(alpha2: string): string | null {
  if (regionNamesEn === undefined) {
    try {
      regionNamesEn = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNamesEn = null;
    }
  }
  if (!regionNamesEn) return null;
  try {
    const n = regionNamesEn.of(alpha2);
    return n && n !== alpha2 ? n : null;
  } catch {
    return null;
  }
}

function countryLabelFromCode(code: string): string {
  const u = code.toUpperCase();
  if (ISO_NAMES[u]) return ISO_NAMES[u];
  if (u.length === 2) {
    const n = regionDisplayNameEn(u);
    if (n) return n;
  }
  return u;
}

/** ISO alpha-3 (e.g. ALB) or alpha-2 from a tag (`[ALB]`, `|ALB|`) → English name for matching. */
function countryLabelFromIsoTag(tag: string): string | null {
  const u = tag.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (u.length === 2) return countryLabelFromCode(u);
  if (u.length === 3) {
    const a2 = (ISO_ALPHA3_TO_ALPHA2 as Record<string, string>)[u];
    if (a2) return countryLabelFromCode(a2);
  }
  return null;
}

/** IPTV-style `|AF| CAMEROON`, `|ALB| MOVIES` (tag 1–8 alnum; rest optional). */
function afterPipeClusterTag(name: string): { tag: string; rest: string } | null {
  const m = /^\|([A-Za-z0-9]{1,8})\|\s*(.*)$/i.exec(name.trim());
  if (!m) return null;
  const tag = m[1]?.trim() ?? "";
  const rest = (m[2] ?? "").trim();
  if (!tag) return null;
  return { tag, rest };
}

/** Single-word remainder that is a genre/group, not a place → bucket by `|TAG|`. */
const GENRE_TOKENS = new Set([
  "children",
  "documentary",
  "general",
  "islamic",
  "movies",
  "music",
  "news",
  "sports",
  "others",
  "ppv",
  "series",
  "entertainment",
  "kids",
  "religious",
  "comedy",
  "action",
  "horror",
  "thriller",
  "family",
  "animation",
  "vod",
  "live",
  "radio",
]);

function isGenreOnlySingleWord(label: string): boolean {
  const w = label.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return w.length === 1 && GENRE_TOKENS.has(w[0]!);
}

/** Leading `[tag]` plus optional remainder (e.g. `[ALB]`, `[EU] FRANCE 4k`). */
function parseLeadingBracket(name: string): { tag: string; rest: string } | null {
  const m = /^\[([^\]]+)\]\s*(.*)$/i.exec(name.trim());
  if (!m) return null;
  const tag = (m[1] ?? "").trim();
  if (!tag) return null;
  return { tag, rest: (m[2] ?? "").trim() };
}

/** Turn remainder into a single country label (before bouquet separators, strip quality suffixes). */
function countryLabelFromBracketSuffix(rest: string): string {
  let s = rest.trim();
  const beforePipe = s.split(/\s*\|\s*/)[0];
  s = (beforePipe ?? s).trim();
  const beforeDash = s.split(/\s+[-–—]\s+/)[0];
  s = (beforeDash ?? s).trim();
  s = s.replace(/\s+(4k|8k|2k|uhd|fhd|full\s*hd|hd|sd|hevc|h\.?265|h\.?264|hdr10\+?|sdr)\s*$/i, "").trim();
  s = s.replace(/\s+\d{3,4}\s*p\s*$/i, "").trim();
  return s;
}

/**
 * Country for UI: only known countries (merged variants like « France 4k », « France cinema »)
 * or `null` → bucket « Autres ».
 */
export function inferCountryFromCategoryName(name: string): ParsedCountry | null {
  const t = name.trim();

  const pipeCluster = afterPipeClusterTag(t);
  if (pipeCluster) {
    const { tag, rest } = pipeCluster;
    if (rest) {
      const cleaned = countryLabelFromBracketSuffix(rest);
      if (cleaned && !isGenreOnlySingleWord(cleaned)) {
        const fromRest = matchCanonicalCountry(cleaned);
        if (fromRest) return fromRest;
      }
    }
    const fromFull = matchCanonicalCountry(t);
    if (fromFull) return fromFull;
    const fromTag = countryLabelFromIsoTag(tag);
    if (fromTag) {
      const hit = matchCanonicalCountry(fromTag);
      if (hit) return hit;
    }
    return null;
  }

  const bracket = parseLeadingBracket(t);
  if (bracket) {
    const { tag, rest } = bracket;
    if (rest) {
      const label = countryLabelFromBracketSuffix(rest);
      if (label && !isGenreOnlySingleWord(label)) {
        const fromRest = matchCanonicalCountry(label);
        if (fromRest) return fromRest;
      }
    }
    const fromFullBracket = matchCanonicalCountry(t);
    if (fromFullBracket) return fromFullBracket;
    const fromTag = countryLabelFromIsoTag(tag);
    if (fromTag) {
      const hit = matchCanonicalCountry(fromTag);
      if (hit) return hit;
    }
    return null;
  }

  const dash = /^([A-Za-z]{2})\s*[-–—]\s+/.exec(t);
  if (dash) {
    const code = dash[1].toUpperCase();
    return matchCanonicalCountry(countryLabelFromCode(code));
  }

  const pipe = /^([A-Za-z]{2})\s*\|\s*/.exec(t);
  if (pipe) {
    const code = pipe[1].toUpperCase();
    return matchCanonicalCountry(countryLabelFromCode(code));
  }

  const fromTrail = inferFromTrailingRegionBracket(t);
  if (fromTrail) return fromTrail;

  return null;
}

/** Suffixe `… [FR]`, `… [PL]`, `… [ALB]` (très courant sur les catégories VOD Xtream). */
const TRAILING_BRACKET_DENY = new Set([
  "MULTISUB",
  "MULTI",
  "SUB",
  "DTS",
  "HDR",
  "SDR",
  "UHD",
  "FHD",
  "HD",
  "TS",
  "HQ",
  "XXX",
]);

function inferFromTrailingRegionBracket(name: string): ParsedCountry | null {
  const m = /\[\s*([A-Za-z]{2,3})\s*\]\s*$/i.exec(name.trim());
  if (!m) return null;
  const raw = (m[1] ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length < 2 || raw.length > 3) return null;
  if (TRAILING_BRACKET_DENY.has(raw)) return null;

  /** ISO `AF` = Afghanistan ; sur l’IPTV, « AFRICAN … [AF] » = zone Afrique. */
  if (raw === "AF" && /\bafrican(s)?\b/i.test(name)) {
    return matchCanonicalCountry("Afrique");
  }

  const fromIso = countryLabelFromIsoTag(raw);
  if (fromIso) {
    const hit = matchCanonicalCountry(fromIso);
    if (hit) return hit;
  }
  return null;
}

function streamCountForCategory(streamsByCat: Map<string, LiveStream[]>, categoryId: string): number {
  return streamsByCat.get(String(categoryId))?.length ?? 0;
}

/**
 * Synthetic admin-shaped config: packages = provider live categories (with streams);
 * countries = unique names inferred from titles (`[EU] FRANCE 4k` → France, etc.).
 */
export function buildProviderAdminConfig(
  categories: LiveCategory[],
  streamsByCat: Map<string, LiveStream[]>
): AdminConfig {
  const withStreams = categories.filter((c) => streamCountForCategory(streamsByCat, c.category_id) > 0);

  if (withStreams.length === 0) {
    return {
      countries: [],
      packages: [],
      categories: [],
      assignments: [],
      hiddenFilters: [],
    };
  }

  const rows = withStreams.map((cat) => ({
    cat,
    parsed: inferCountryFromCategoryName(cat.category_name),
  }));

  const countryById = new Map<string, string>();
  for (const { parsed } of rows) {
    if (parsed) countryById.set(parsed.id, parsed.name);
  }

  const countries: AdminCountry[] = [...countryById.entries()].map(([id, name]) => ({ id, name }));
  /* Always list « Autres » so users can filter packages that did not match the DB / default keys. */
  if (!countries.some((c) => c.id === OTHER_COUNTRY_ID)) {
    countries.push({ id: OTHER_COUNTRY_ID, name: "Autres" });
  }
  countries.sort((a, b) => {
    if (a.id === OTHER_COUNTRY_ID) return 1;
    if (b.id === OTHER_COUNTRY_ID) return -1;
    return a.name.localeCompare(b.name, "fr");
  });

  /** One Supabase row per display (e.g. `albania` + `|ALB|` both « Albanie ») → single country in the list. */
  const primaryIdByName = new Map<string, string>();
  for (const c of countries) {
    if (c.id === OTHER_COUNTRY_ID) continue;
    if (!primaryIdByName.has(c.name)) primaryIdByName.set(c.name, c.id);
  }
  const countriesDeduped = countries.filter((c) => {
    if (c.id === OTHER_COUNTRY_ID) return true;
    return primaryIdByName.get(c.name) === c.id;
  });

  const packages: AdminPackage[] = rows
    .map(({ cat, parsed }) => {
      let country_id = parsed?.id ?? OTHER_COUNTRY_ID;
      if (country_id !== OTHER_COUNTRY_ID) {
        const n = parsed?.name;
        const primary = n ? primaryIdByName.get(n) : undefined;
        if (primary) country_id = primary;
      }
      return {
        id: String(cat.category_id),
        country_id,
        name: cat.category_name,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  return {
    countries: countriesDeduped,
    packages,
    categories: [],
    assignments: [],
    hiddenFilters: [],
  };
}
