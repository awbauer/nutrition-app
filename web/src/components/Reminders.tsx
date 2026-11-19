import { toast } from '../toast';
import { useEffect, useState } from 'preact/hooks';
import { api, type MealType } from '../api';
import { MEAL_LABEL } from '../format';
import { currentSubscription, disablePush, enablePush, isIOS, isStandalone, pushSupported } from '../push';

interface Reminder {
  id?: string;
  label: string;
  meal_type: MealType | null;
  kind: 'meal' | 'end-of-day';
  local_time: string;
  days_of_week: string;
  enabled: boolean;
}

const DEFAULTS: Reminder[] = [
  { label: 'Breakfast', meal_type: 'breakfast', kind: 'meal', local_time: '09:00', days_of_week: '0123456', enabled: true },
  { label: 'Lunch', meal_type: 'lunch', kind: 'meal', local_time: '13:00', days_of_week: '0123456', enabled: true },
  { label: 'Dinner', meal_type: 'dinner', kind: 'meal', local_time: '19:30', days_of_week: '0123456', enabled: true },
  { label: 'End of day', meal_type: null, kind: 'end-of-day', local_time: '21:00', days_of_week: '0123456', enabled: true },
];
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Reminders() {
  const [list, setList] = useState<Reminder[] | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const needsInstall = isIOS() && !isStandalone();

  useEffect(() => {
    api.get<Reminder[]>('/reminders').then((r) => setList(r.length ? r : DEFAULTS), (e) => toast.error(e));
    currentSubscription().then((s) => setSubscribed(!!s));
  }, []);

  async function save(next: Reminder[]) {
    setList(next);
    try {
      setList(await api.put<Reminder[]>('/reminders', next));
    } catch (e) {
      toast.error(e);
    }
  }

  async function toggleNotifications() {
    setBusy(true);
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
      } else {
        await enablePush();
        setSubscribed(true);
        if (list) await save(list); // persist defaults the first time
        await api.post('/push/test');
        toast.success('Notifications are on. A test notification is on its way.');
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const update = (i: number, patch: Partial<Reminder>) => list && save(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <section class="card flex flex-col gap-3 p-4">
      <h2 class="display text-xl font-semibold">Reminders</h2>
      {needsInstall ? (
        <div class="rounded-2xl bg-accent-soft/60 p-4 text-sm">
          <p class="font-medium">Add the app to your Home Screen first</p>
          <ol class="mt-1 list-decimal pl-5 text-ink-2">
            <li>Tap the Share button in Safari.</li>
            <li>Choose “Add to Home Screen”.</li>
            <li>Open Clem from your Home Screen and come back here.</li>
          </ol>
          <p class="mt-1 text-xs text-ink-2">iPhone only allows notifications for apps on the Home Screen (iOS 16.4+).</p>
        </div>
      ) : !pushSupported() ? (
        <p class="text-sm text-ink-2">This browser doesn't support notifications.</p>
      ) : (
        <button class={subscribed ? 'btn-ghost' : 'btn-primary'} disabled={busy} onClick={toggleNotifications}>
          {busy ? '…' : subscribed ? 'Turn off notifications on this device' : 'Turn on notifications'}
        </button>
      )}
      {list?.map((r, i) => (
        <div class="flex flex-col gap-2 border-t border-line pt-3">
          <div class="flex items-center gap-2">
            <input class="input min-w-0 flex-1 py-1.5" value={r.label} onChange={(e) => update(i, { label: (e.target as HTMLInputElement).value })} aria-label="Reminder label" />
            <input class="input w-36 shrink-0 py-1.5" type="time" value={r.local_time} onChange={(e) => update(i, { local_time: (e.target as HTMLInputElement).value })} aria-label="Time" />
            <input type="checkbox" class="h-5 w-5 accent-[var(--accent)]" checked={r.enabled} onChange={(e) => update(i, { enabled: (e.target as HTMLInputElement).checked })} aria-label="Enabled" />
          </div>
          <div class="flex items-center justify-between gap-1" role="group" aria-label="Days">
            {DAYS.map((d, n) => {
              const on = r.days_of_week.includes(String(n));
              return (
                <button
                  class={`h-9 w-9 shrink-0 rounded-full text-sm ${on ? 'bg-accent text-white' : 'bg-sunken text-ink-2 '}`}
                  aria-pressed={on}
                  aria-label={DAY_NAMES[n]}
                  onClick={() => update(i, { days_of_week: on ? r.days_of_week.replace(String(n), '') || r.days_of_week : r.days_of_week + n })}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <div class="flex items-center gap-2">
            <select
              class="input min-w-0 flex-1 py-1.5"
              aria-label="What to remind about"
              value={r.kind === 'end-of-day' ? 'end-of-day' : (r.meal_type ?? 'any')}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                update(i, v === 'end-of-day' ? { kind: 'end-of-day', meal_type: null } : { kind: 'meal', meal_type: v === 'any' ? null : (v as MealType) });
              }}
            >
              {(['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).map((m) => (
                <option value={m}>{MEAL_LABEL[m]}</option>
              ))}
              <option value="any">Any meal</option>
              <option value="end-of-day">End-of-day summary</option>
            </select>
            <button class="shrink-0 p-2 text-faint hover:text-berry" onClick={() => save(list.filter((_, j) => j !== i))} aria-label="Delete reminder">
              ✕
            </button>
          </div>
        </div>
      ))}
      <button
        class="self-start text-sm text-accent-ink"
        onClick={() => list && save([...list, { label: 'Snack', meal_type: 'snack', kind: 'meal', local_time: '16:00', days_of_week: '0123456', enabled: true }])}
      >
        + Add reminder
      </button>
      <p class="text-xs text-ink-2">Meal reminders are skipped when that meal is already logged.</p>
    </section>
  );
}
