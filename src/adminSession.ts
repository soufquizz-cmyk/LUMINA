const STORAGE_KEY = "velora_admin_settings";

function accessKey(): string | undefined {
  const k = import.meta.env.VITE_ADMIN_ACCESS_KEY;
  return typeof k === "string" && k.trim() ? k.trim() : undefined;
}

/** Admin UI allowed (settings button + pays CRUD page). */
export function isAdminSession(): boolean {
  try {
    if (sessionStorage.getItem(STORAGE_KEY) === "1") return true;
  } catch {
    /* ignore */
  }
  /* No key in env (any environment): Paramètres + Outils stay visible without ?admin_access.
     Set VITE_ADMIN_ACCESS_KEY on the host (e.g. Vercel) to require ?admin_access=<key> once per tab. */
  if (!accessKey()) return true;
  return false;
}

/** Call on app load: `?admin_access=<VITE_ADMIN_ACCESS_KEY>` opens admin for this tab. */
export function tryConsumeAdminAccessFromUrl(): void {
  const key = accessKey();
  if (!key || typeof window === "undefined") return;
  try {
    const u = new URL(window.location.href);
    const got = u.searchParams.get("admin_access")?.trim();
    if (!got || got !== key) return;
    sessionStorage.setItem(STORAGE_KEY, "1");
    u.searchParams.delete("admin_access");
    const next = `${u.pathname}${u.search}${u.hash}` || "/";
    window.history.replaceState({}, "", next);
  } catch {
    /* ignore */
  }
}

export function clearAdminSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
