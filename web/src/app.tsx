import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from './api';
import { SettingsView } from './components/SettingsView';
import { Today } from './components/Today';

type Tab = 'today' | 'settings';

interface Me {
  timezone: string;
  settings: { day_cutoff: string };
}

/** Today's log date in the user's zone with the configured cutoff. */
function logToday(tz: string, cutoff: string): string {
  const [h, m] = cutoff.split(':').map(Number);
  const shifted = new Date(Date.now() - ((h ?? 4) * 60 + (m ?? 0)) * 60000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'today');
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadMe = () =>
    api.get<Me>('/me').then(
      async (m) => {
        // First run: adopt the device time zone.
        const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (m.timezone === 'UTC' && deviceTz && deviceTz !== 'UTC') {
          await api.put('/settings', { timezone: deviceTz });
          m.timezone = deviceTz;
        }
        setMe(m);
      },
      (e) => setErr(e instanceof ApiError && e.status === 401 ? 'Your session expired. Reload to sign in again.' : e.message),
    );

  useEffect(() => {
    loadMe();
  }, []);
  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
  }, [tab]);

  const today = me ? logToday(me.timezone, me.settings.day_cutoff) : null;

  return (
    <div class="mx-auto flex min-h-dvh max-w-lg flex-col">
      <main class="safe-top flex-1 px-4 pb-28">
        {err && (
          <div class="card mt-8 p-6 text-center">
            <p class="text-sm">{err}</p>
            <button class="btn-primary mt-4" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        )}
        {today && tab === 'today' && <Today key={today} today={today} />}
        {me && tab === 'settings' && <SettingsView onSaved={loadMe} />}
      </main>
      <nav class="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div class="mx-auto flex max-w-lg">
          {(
            [
              ['today', 'Today', '◉'],
              ['settings', 'Settings', '⚙'],
            ] as const
          ).map(([t, label, icon]) => (
            <button
              class={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${tab === t ? 'text-brand-700 dark:text-brand-500' : 'text-slate-500'}`}
              onClick={() => setTab(t)}
              aria-current={tab === t ? 'page' : undefined}
            >
              <span class="text-lg leading-none">{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
