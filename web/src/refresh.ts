import { useEffect, useRef } from 'preact/hooks';

/**
 * Re-run `fn` when the user comes back to the app: the tab or PWA becomes visible again,
 * the window regains focus (desktop), or the connection returns. Data logged on another
 * device then shows up without a manual reload. A short cooldown avoids double fetches
 * when several of these fire together.
 */
export function useRefreshOnReturn(fn: () => void, cooldownMs = 2000) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    let last = Date.now();
    const run = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < cooldownMs) return;
      last = Date.now();
      latest.current();
    };
    document.addEventListener('visibilitychange', run);
    addEventListener('focus', run);
    addEventListener('online', run);
    return () => {
      document.removeEventListener('visibilitychange', run);
      removeEventListener('focus', run);
      removeEventListener('online', run);
    };
  }, []);
}
