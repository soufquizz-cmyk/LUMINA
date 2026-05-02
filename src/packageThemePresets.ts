/** Preset Velora themes keyed by bouquet name heuristics (player + admin preview). */

export type PresetTheme = {
  bg: string;
  surface: string;
  primary: string;
  glow: string;
};

export const THEMES: Record<string, PresetTheme> = {
  default: {
    bg: "#06050a",
    surface: "#110f1a",
    primary: "#8A2BE2",
    glow: "rgba(138, 43, 226, 0.3)",
  },
  canal: {
    bg: "#000000",
    surface: "#1a1a1a",
    primary: "#ffffff",
    glow: "rgba(255, 255, 255, 0.25)",
  },
  bein: {
    bg: "#2b0c3d",
    surface: "#3a1451",
    primary: "#d40062",
    glow: "rgba(212, 0, 98, 0.35)",
  },
  disney: {
    bg: "#001a4d",
    surface: "#002673",
    primary: "#00e6ff",
    glow: "rgba(0, 230, 255, 0.3)",
  },
};

export function themeKeyForLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("canal")) return "canal";
  if (n.includes("bein")) return "bein";
  if (n.includes("disney")) return "disney";
  return "default";
}

export function presetForPackageName(name: string): PresetTheme {
  return THEMES[themeKeyForLabel(name)] || THEMES.default;
}
