import { useEffect, useState } from 'preact/hooks';
import { api, type Settings } from '../api';
import { Export } from './Export';
import { Reminders } from './Reminders';
import { Targets } from './Targets';

export function SettingsView(props: { today: string; onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.get<Settings>('/settings').then(setS, (e) => setMsg(e.message));
  }, []);

  async function save(patch: Partial<Settings>) {
    try {
      setS(await api.put<Settings>('/settings', patch));
      setMsg('Saved');
      props.onSaved();
      setTimeout(() => setMsg(null), 1500);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  if (!s) return <div class="card h-40 animate-pulse" />;
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div class="flex flex-col gap-4">
      <h1 class="text-2xl font-bold">Settings</h1>
      <section class="card flex flex-col gap-4 p-4">
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">Time zone</span>
          <div class="flex gap-2">
            <input class="input" value={s.timezone} onChange={(e) => save({ timezone: (e.target as HTMLInputElement).value })} />
            {deviceTz !== s.timezone && (
              <button class="btn-ghost shrink-0" onClick={() => save({ timezone: deviceTz })}>
                Use {deviceTz}
              </button>
            )}
          </div>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">Day starts at</span>
          <input class="input" type="time" value={s.day_cutoff} onChange={(e) => save({ day_cutoff: (e.target as HTMLInputElement).value })} />
          <span class="text-xs text-slate-500">Meals before this time count toward the previous day.</span>
        </label>
        <div class="flex gap-4">
          <label class="flex flex-1 flex-col gap-1">
            <span class="text-sm font-medium">Body weight</span>
            <select class="input" value={s.weight_unit} onChange={(e) => save({ weight_unit: (e.target as HTMLSelectElement).value as 'kg' })}>
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </label>
          <label class="flex flex-1 flex-col gap-1">
            <span class="text-sm font-medium">Food amounts</span>
            <select class="input" value={s.mass_unit} onChange={(e) => save({ mass_unit: (e.target as HTMLSelectElement).value as 'g' })}>
              <option value="g">g</option>
              <option value="oz">oz</option>
            </select>
          </label>
        </div>
      </section>
      {msg && <p class="text-center text-sm text-slate-500">{msg}</p>}
      <Targets weightUnit={s.weight_unit} />
      <Reminders />
      <Export today={props.today} />
    </div>
  );
}
