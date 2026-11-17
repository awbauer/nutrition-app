import { toast } from '../toast';
import { useEffect, useState } from 'preact/hooks';
import { api, type Settings } from '../api';
import { Export } from './Export';
import { Reminders } from './Reminders';
import { Targets } from './Targets';
import { APP_VERSION } from '../update';

export function SettingsView(props: { today: string; onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);

  useEffect(() => {
    api.get<Settings>('/settings').then(setS, (e) => toast.error(e));
  }, []);

  async function save(patch: Partial<Settings>) {
    try {
      setS(await api.put<Settings>('/settings', patch));
      toast.success('Saved', { id: 'settings' });
      props.onSaved();
    } catch (e) {
      toast.error(e);
    }
  }

  if (!s) return <div class="card h-40 animate-pulse" />;
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    // Desktop: cards flow into two columns.
    <div class="flex flex-col gap-4 lg:block lg:columns-2 lg:gap-6 lg:[&>*]:mb-6 lg:[&>*]:break-inside-avoid">
      <h1 class="display pt-2 text-[2.1rem] leading-none font-semibold lg:[column-span:all]">Settings</h1>
      <section class="card flex flex-col gap-4 p-4">
        <h2 class="display text-xl font-semibold">Your day</h2>
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
          <span class="text-xs text-ink-2">Meals before this time count toward the previous day.</span>
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
      <Targets weightUnit={s.weight_unit} />
      <Reminders />
      <Export today={props.today} />
      <p class="pb-2 text-center text-xs text-faint">Version {APP_VERSION}</p>
    </div>
  );
}
