/**
 * Keeps the installed app current. iOS can keep a Home Screen app alive for days,
 * so a fresh launch is not enough: we check /version.json when the app returns to
 * the foreground and every 15 minutes while it is visible.
 *
 * When a new version is out we reload right away unless something is in progress
 * (a sheet is open, a request is running, text is being typed). Then we wait for the
 * next quiet moment and show an "Update ready" banner the user can tap.
 */
export const APP_VERSION = __APP_VERSION__;

const CHECK_EVERY_MS = 15 * 60 * 1000;
const RELOAD_GUARD_KEY = 'update-reloaded-for';

let busy = 0;
let available: string | null = null;
const listeners = new Set<(v: string | null) => void>();

export const onUpdateAvailable = (fn: (v: string | null) => void) => (listeners.add(fn), fn(available), () => listeners.delete(fn));

/** Mark work in progress (open sheet, pending save). Returns a release function. */
export function holdUpdates(): () => void {
  busy++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busy = Math.max(0, busy - 1);
    if (!busy && available) maybeReload();
  };
}

function typing(): boolean {
  const el = document.activeElement as HTMLInputElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !!el.value));
}

async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const { version } = (await res.json()) as { version?: string };
    return version ?? null;
  } catch {
    return null; // offline, or an Access redirect; try again later
  }
}

/** Reload into the new version, at most once per version (guards against loops if a cache serves stale HTML). */
export async function applyUpdate(): Promise<void> {
  const target = available ?? 'unknown';
  try {
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === target) return;
    sessionStorage.setItem(RELOAD_GUARD_KEY, target);
  } catch {}
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  // Let the new worker install (it precaches the new shell) before reloading, but don't wait forever.
  await Promise.race([reg?.update().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  location.reload();
}

function maybeReload() {
  if (!available || busy || typing()) return;
  void applyUpdate();
}

export async function checkForUpdate(): Promise<void> {
  const v = await latestVersion();
  if (!v || v === APP_VERSION) return;
  available = v;
  listeners.forEach((f) => f(v));
  maybeReload();
}

export function startUpdates(): void {
  if (!import.meta.env.PROD) return;
  try {
    // A completed reload into the target version clears the loop guard.
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === APP_VERSION) sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {}
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate();
  });
  addEventListener('online', () => void checkForUpdate());
  setInterval(() => document.visibilityState === 'visible' && void checkForUpdate(), CHECK_EVERY_MS);
  void checkForUpdate();
}
