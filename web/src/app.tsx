import { ChartColumn, ChefHat, ChevronLeft, Ellipsis, NotebookPen, Plus, Settings2, Sparkles, Waypoints } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from './api';
import { isIOS, isStandalone } from './push';
import { applyUpdate, onUpdateAvailable } from './update';
import { toast } from './toast';
import { useRefreshOnReturn } from './refresh';
import { Toaster } from './components/Toaster';
import { SettingsView } from './components/SettingsView';
import { Today } from './components/Today';
import { Week } from './components/Week';
import { RecipesView } from './components/Recipes';
import { MoreView } from './components/MoreView';
import { CoachView } from './components/CoachView';

type Tab = 'today' | 'week' | 'coach' | 'recipes' | 'graph' | 'settings' | 'more';
const TABS: Tab[] = ['today', 'week', 'coach', 'recipes', 'graph', 'settings', 'more'];
/** Phone: pages reached from More (the bottom bar has room for four tabs and the log button). */
const UNDER_MORE: Tab[] = ['recipes', 'graph', 'settings', 'more'];
/** Tab from the URL hash; old links to #weight land on Week, where the trend now lives. */
const tabFromHash = (): Tab => {
  const h = location.hash.slice(1);
  if (h === 'weight') return 'week';
  if (h === 'my-foods') return 'recipes';
  return TABS.includes(h as Tab) ? (h as Tab) : 'today';
};

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
  const [tab, setTab] = useState<Tab>(tabFromHash);
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
  // Settings (time zone, day cutoff, units) may have changed on another device.
  useRefreshOnReturn(() => loadMe());
  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
  }, [tab]);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
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

  // Keyboard: N opens the log (desktop), unless you're typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.closest('input, textarea, select, [contenteditable], [role=dialog]')) return;
      e.preventDefault();
      openLog();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const tabs: [Tab, string, preact.ComponentChildren][] = [
    ['today', 'Today', <NotebookPen size={22} strokeWidth={1.75} />],
    ['week', 'Week', <ChartColumn size={22} strokeWidth={1.75} />],
    ['coach', 'Coach', <Sparkles size={22} strokeWidth={1.75} />],
    ['recipes', 'Foods', <ChefHat size={22} strokeWidth={1.75} />],
    ['graph', 'Graph', <Waypoints size={22} strokeWidth={1.75} />],
    ['settings', 'Settings', <Settings2 size={22} strokeWidth={1.75} />],
  ];

  return (
    <div class="min-h-dvh">
      <Toaster />
      {/* Phone: a solid strip behind the status bar. Without it the page scrolls under the clock and iOS
          blurs whatever passes beneath, which made the top of the screen look smeared. */}
      <div class="safe-top-strip fixed inset-x-0 top-0 z-30 bg-paper md:hidden" aria-hidden="true" />

      {/* Tablet and desktop: sidebar */}
      <aside class="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col gap-1 border-r border-line bg-paper px-4 py-6 md:flex" aria-label="Main">
        <p class="display px-3 pb-5 text-2xl font-semibold">
          Meals<span class="text-accent">.</span>
        </p>
        <button class="btn-primary mb-4 w-full justify-start px-4 py-3" onClick={openLog}>
          <Plus size={20} strokeWidth={2.25} /> Log food
          <kbd class="ml-auto rounded-md bg-white/20 px-1.5 text-xs font-medium">N</kbd>
        </button>
        {tabs.map(([t, label, icon]) => (
          <button
            class={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[0.95rem] font-medium transition ${tab === t ? 'bg-card text-ink shadow-sm ring-1 ring-line' : 'text-ink-2 hover:bg-sunken'}`}
            onClick={() => setTab(t)}
            aria-current={tab === t ? 'page' : undefined}
          >
            {icon}
            {label}
          </button>
        ))}
      </aside>

      {/* Content is centred in the space beside the sidebar. */}
      <main class="safe-top px-5 pb-32 md:pt-8 md:pr-10 md:pb-16 md:pl-[calc(14rem+2.5rem)]">
        <div class={`mx-auto ${tab === 'settings' ? 'max-w-lg md:max-w-3xl lg:max-w-5xl' : 'max-w-lg md:max-w-3xl lg:max-w-6xl'}`}>
          {(tab === 'recipes' || tab === 'graph' || tab === 'settings') && (
            <button class="-mb-1 flex items-center gap-1 pt-2 text-sm font-medium text-accent-ink md:hidden" onClick={() => setTab('more')}>
              <ChevronLeft size={18} /> More
            </button>
          )}
          {me && today && tab === 'today' && <Today key={today} today={today} weightUnit={me.settings.weight_unit} />}
          {me && today && tab === 'week' && <Week key={today} today={today} weightUnit={me.settings.weight_unit} />}
          {today && tab === 'recipes' && <RecipesView today={today} />}
          {tab === 'coach' && <CoachView />}
          {tab === 'graph' && <LazyGraph />}
          {today && tab === 'settings' && <SettingsView today={today} onSaved={loadMe} />}
          {tab === 'more' && <MoreView onOpen={setTab} />}
        </div>
      </main>

      {/* Phone: bottom bar with the raised log button */}
      <nav class="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper/90 backdrop-blur-md md:hidden" aria-label="Main">
        <div class="mx-auto grid max-w-lg grid-cols-5 items-end px-2">
          <NavItem tab="today" current={tab} onSelect={setTab} label="Today" icon={tabs[0][2]} />
          <NavItem tab="week" current={tab} onSelect={setTab} label="Week" icon={tabs[1][2]} />
          <div class="flex justify-center">
            <button
              class="flex h-16 w-16 -translate-y-4 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 ring-[6px] ring-paper transition active:scale-95"
              onClick={openLog}
              aria-label="Log food"
            >
              <Plus size={30} strokeWidth={2.25} />
            </button>
          </div>
          <NavItem tab="coach" current={tab} onSelect={setTab} label="Coach" icon={<Sparkles size={22} strokeWidth={1.75} />} />
          <NavItem tab="more" current={UNDER_MORE.includes(tab) ? 'more' : tab} onSelect={setTab} label="More" icon={<Ellipsis size={22} strokeWidth={1.75} />} />
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

/** The graph pulls in d3, so it loads only when the Graph page is opened. */
function LazyGraph() {
  const [C, setC] = useState<preact.ComponentType | null>(null);
  useEffect(() => {
    import('./components/GraphView').then(
      (m) => setC(() => m.GraphView),
      (e) => toast.error(e),
    );
  }, []);
  return C ? <C /> : <div class="card mt-16 h-[58dvh] animate-pulse" />;
}
