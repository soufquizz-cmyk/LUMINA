/**
 * France-only curated bouquets (beIN Sports, Canal, Disney): auto grouping by channel name
 * plus manual moves via Supabase `admin_stream_curations`.
 */

import { displayChannelName } from "./assignmentMatch";
import type { LiveStream } from "./nodecastCatalog";

export const STREAM_CURATION_HIDDEN = "hidden";

export const FRANCE_SYNTH_PACKAGES = [
  { id: "velagg:fr:bein", name: "beIN Sports" },
  { id: "velagg:fr:canal", name: "Canal" },
  { id: "velagg:fr:disney", name: "Disney" },
] as const;

export function isFranceSynthPackageId(packageId: string): boolean {
  return FRANCE_SYNTH_PACKAGES.some((p) => p.id === packageId);
}

function compactLower(s: string): string {
  let t = s.trim();
  try {
    t = t.normalize("NFKC");
  } catch {
    /* ignore */
  }
  return t.toLowerCase().replace(/\s+/g, "");
}

/** Auto-route to synthetic France package when there is no DB curation row. Order: beIN → Disney → Canal. */
export function autoSynthPackageIdForStreamName(rawName: string, isFrance: boolean): string | null {
  if (!isFrance) return null;
  const disp = displayChannelName(rawName);
  const d = compactLower(disp);
  const r = compactLower(rawName);
  const bein =
    d.includes("beinsport") ||
    r.includes("beinsport") ||
    /\bbein\s*sport\b/i.test(disp) ||
    /\bbein\s*sport\b/i.test(rawName);
  if (bein) return "velagg:fr:bein";
  if (d.includes("disney") || r.includes("disney")) return "velagg:fr:disney";
  if (d.includes("canal") || r.includes("canal")) return "velagg:fr:canal";
  return null;
}

export function collectStreamsFromProviderCategories(
  streamsByCatAll: Map<string, LiveStream[]>,
  providerCategoryIds: readonly string[]
): LiveStream[] {
  const byId = new Map<number, LiveStream>();
  for (const catId of providerCategoryIds) {
    for (const s of streamsByCatAll.get(catId) ?? []) {
      if (!byId.has(s.stream_id)) byId.set(s.stream_id, s);
    }
  }
  return [...byId.values()];
}

export function listStreamsForOpenedPackage(opts: {
  packageId: string;
  streamsByCatAll: Map<string, LiveStream[]>;
  /** Deduped streams from all provider categories in this country (for cross-bouquet moves). */
  unionStreamsForCountry: LiveStream[];
  isFranceContext: boolean;
  isLikelyUuidPackage: (id: string) => boolean;
  /** `country_id` → stream_id → target_package_id (or STREAM_CURATION_HIDDEN). */
  curationForSelectedDbCountry: Map<number, string> | null;
}): LiveStream[] {
  const {
    packageId,
    streamsByCatAll,
    unionStreamsForCountry,
    isFranceContext,
    isLikelyUuidPackage,
    curationForSelectedDbCountry,
  } = opts;

  const cur = curationForSelectedDbCountry;

  const curationTarget = (streamId: number): string | null => {
    if (!cur) return null;
    return cur.get(streamId) ?? null;
  };

  const nativeSet = new Set((streamsByCatAll.get(packageId) ?? []).map((s) => s.stream_id));

  const sortFr = (a: LiveStream, b: LiveStream) =>
    displayChannelName(a.name).localeCompare(displayChannelName(b.name), "fr");

  if (isFranceSynthPackageId(packageId)) {
    const out: LiveStream[] = [];
    for (const s of unionStreamsForCountry) {
      const ct = curationTarget(s.stream_id);
      if (ct === STREAM_CURATION_HIDDEN) continue;
      if (ct) {
        if (ct === packageId) out.push(s);
        continue;
      }
      if (autoSynthPackageIdForStreamName(s.name, isFranceContext) === packageId) out.push(s);
    }
    return out.sort(sortFr);
  }

  if (isLikelyUuidPackage(packageId)) {
    const out: LiveStream[] = [];
    for (const s of unionStreamsForCountry) {
      const ct = curationTarget(s.stream_id);
      if (ct === packageId) out.push(s);
    }
    return out.sort(sortFr);
  }

  const out: LiveStream[] = [];
  for (const s of unionStreamsForCountry) {
    const ct = curationTarget(s.stream_id);
    if (ct === STREAM_CURATION_HIDDEN) continue;
    if (ct) {
      if (ct === packageId) out.push(s);
      continue;
    }
    const auto = autoSynthPackageIdForStreamName(s.name, isFranceContext);
    if (auto) continue;
    if (nativeSet.has(s.stream_id)) out.push(s);
  }
  return out.sort(sortFr);
}
