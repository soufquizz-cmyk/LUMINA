/** Shared channel label + admin rule matching (player + admin UI). */

function assignmentExactMatchOnly(): boolean {
  const v = import.meta.env?.VITE_ASSIGNMENT_EXACT_MATCH_ONLY;
  if (v == null || v === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Strips common FR / country-style prefixes from catalogue titles for display and matching. */
export function displayChannelName(raw: string): string {
  const s = raw
    .replace(
      /^\s*(?:\[[A-Z]{2}\]\s*|\[FR\]\s*|\|?\s*FR\s*\|?\s*|FR\s*[-–—|]\s*|FR\s*:\s+)/i,
      ""
    )
    .trim();
  return s.length ? s : raw.trim();
}

export type AssignmentRule = { match_text: string; category_id: string };

function stripMatchDecorators(s: string): string {
  return s
    .replace(/^[\s\uFEFF"'“”‘’\[\]()]+/u, "")
    .replace(/[\s"'“”‘’\[\]()]+$/u, "")
    .trim();
}

function normalizeKey(s: string): string {
  let t = s;
  try {
    t = t.normalize("NFKC");
  } catch {
    /* ignore */
  }
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

function compactKey(s: string): string {
  return normalizeKey(s).replace(/\s/g, "");
}

/**
 * Maps a provider stream name to an admin leaf `category_id` using `admin_channel_rules`.
 * Compares normalized names (case, spacing, NFKC); substring match prefers longer `match_text`
 * first; optional compact (no spaces) match. `match_text` is what you configure in Admin.
 */
export function assignmentCategoryIdForStreamName(
  streamName: string,
  assignments: readonly AssignmentRule[]
): string | null {
  if (!assignments.length) return null;

  const stripped = displayChannelName(streamName);
  const rawTrim = streamName.trim();
  if (!stripped && !rawTrim) return null;
  const k1 = normalizeKey(stripped);
  const k2 = normalizeKey(rawTrim);
  const variants = k1 === k2 ? [k1] : [k1, k2];

  for (const a of assignments) {
    const needle = normalizeKey(stripMatchDecorators(a.match_text));
    if (!needle) continue;
    for (const v of variants) {
      if (v === needle) return a.category_id;
    }
  }

  if (assignmentExactMatchOnly()) return null;

  const byNeedleLen = [...assignments].sort(
    (a, b) =>
      normalizeKey(stripMatchDecorators(b.match_text)).length -
      normalizeKey(stripMatchDecorators(a.match_text)).length
  );

  for (const a of byNeedleLen) {
    const needle = normalizeKey(stripMatchDecorators(a.match_text));
    if (needle.length < 3) continue;
    for (const v of variants) {
      if (v.includes(needle)) return a.category_id;
    }
  }

  for (const a of byNeedleLen) {
    const needle = normalizeKey(stripMatchDecorators(a.match_text));
    const needleC = compactKey(needle);
    if (needleC.length < 4) continue;
    for (const v of variants) {
      if (compactKey(v).includes(needleC)) return a.category_id;
    }
  }

  return null;
}
