import { ChartColumn, NotebookPen, Plus, Scale, Settings2 } from 'lucide-preact';
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

  const openLog = () => {
    // The Today screen owns the log sheet (it knows which day you're looking at).
    if (tab !== 'today') setTab('today');
    setTimeout(() => dispatchEvent(new CustomEvent('open-log')), tab === 'today' ? 0 : 50);
  };

  return (
    <div class="mx-auto flex min-h-dvh max-w-lg flex-col">
      <Toaster />
      <main class="safe-top flex-1 px-5 pb-32">
        {today && tab === 'today' && <Today key={today} today={today} />}
        {today && tab === 'week' && <Week key={today} today={today} />}
        {me && tab === 'weight' && <Weight unit={me.settings.weight_unit} />}
        {today && tab === 'settings' && <SettingsView today={today} onSaved={loadMe} />}
      </main>
      <nav class="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper/90 backdrop-blur-md" aria-label="Main">
        <div class="mx-auto grid max-w-lg grid-cols-5 items-end px-2">
          <NavItem tab="today" current={tab} onSelect={setTab} label="Today" icon={<NotebookPen size={22} strokeWidth={1.75} />} />
          <NavItem tab="week" current={tab} onSelect={setTab} label="Week" icon={<ChartColumn size={22} strokeWidth={1.75} />} />
          <div class="flex justify-center">
            <button
              class="flex h-16 w-16 -translate-y-4 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 ring-[6px] ring-paper transition active:scale-95"
              onClick={openLog}
              aria-label="Log food"
            >
              <Plus size={30} strokeWidth={2.25} />
            </button>
          </div>
          <NavItem tab="weight" current={tab} onSelect={setTab} label="Weight" icon={<Scale size={22} strokeWidth={1.75} />} />
          <NavItem tab="settings" current={tab} onSelect={setTab} label="Settings" icon={<Settings2 size={22} strokeWidth={1.75} />} />
        </div>
      </nav>
    </div>
  );
}

function NavItem(props: { tab: Tab; current: Tab; onSelect: (t: Tab) => void; label: string; icon: preact.ComponentChildren }) {
  const on = props.tab === props.current;
  return (
    <button
      class={`flex flex-col items-center gap-1 pt-2.5 pb-1.5 text-[11px] font-medium ${on ? 'text-ink' : 'text-faint'}`}
      onClick={() => props.onSelect(props.tab)}
      aria-current={on ? 'page' : undefined}
    >
      {props.icon}
      <span>{props.label}</span>
      <span class={`h-1 w-1 rounded-full ${on ? 'bg-accent' : 'bg-transparent'}`} aria-hidden="true" />
    </button>
  );
}
