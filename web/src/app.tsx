import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from './api';
import { isIOS, isStandalone } from './push';
import { applyUpdate, onUpdateAvailable } from './update';
import { toast } from './toast';
import { Toaster } from './components/Toaster';
import { SettingsView } from './components/SettingsView';
import { Today } from './components/Today';
import { Week } from './components/Week';
import { Weight } from './components/Weight';

type Tab = 'today' | 'week' | 'weight' | 'settings';

interface Me {
  timezone: string;
  settings: { day_cutoff: string; weight_unit: 'kg' | 'lb' };
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
  useEffect(
    () =>
      onUpdateAvailable((v) => {
        if (v) toast.show({ id: 'update', message: 'A new version is ready.', sticky: true, dismissible: true, action: { label: 'Reload', onClick: applyUpdate } });
      }),
    [],
  );

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
      (e) =>
        toast.error(e instanceof ApiError && e.status === 401 ? 'Your session expired.' : e, {
          id: 'me',
          sticky: true,
          action: { label: e instanceof ApiError && e.status === 401 ? 'Sign in' : 'Reload', onClick: () => location.reload() },
        }),
    );

  useEffect(() => {
    loadMe();
  }, []);
  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
  }, [tab]);
  useEffect(() => {
    const onHash = () => setTab((location.hash.slice(1) as Tab) || 'today');
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let dismissed = true;
    try {
      dismissed = localStorage.getItem('install-hint-dismissed') === '1';
    } catch {}
    if (!isIOS() || isStandalone() || dismissed) return;
    toast.info('Add Meals to your Home Screen for reminders: tap Share, then Add to Home Screen.', {
      id: 'install',
      sticky: true,
      onDismiss: () => {
        try {
          localStorage.setItem('install-hint-dismissed', '1');
        } catch {}
      },
    });
  }, []);

  const today = me ? logToday(me.timezone, me.settings.day_cutoff) : null;

  return (
    <div class="mx-auto flex min-h-dvh max-w-lg flex-col">
      <Toaster />
      <main class="safe-top flex-1 px-4 pb-28">
        {today && tab === 'today' && <Today key={today} today={today} />}
        {today && tab === 'week' && <Week key={today} today={today} />}
        {me && tab === 'weight' && <Weight unit={me.settings.weight_unit} />}
        {today && tab === 'settings' && <SettingsView today={today} onSaved={loadMe} />}
      </main>
      <nav class="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div class="mx-auto flex max-w-lg">
          {(
            [
              ['today', 'Today', '◉'],
              ['week', 'Week', '▤'],
              ['weight', 'Weight', '⚖'],
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
