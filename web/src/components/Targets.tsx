import { toast } from '../toast';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';

interface Profile {
  height_cm: number;
  weight_kg: number;
  age: number;
  sex: 'male' | 'female';
  activity: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  goal_rate_kg_per_week: number;
}
interface Goals {
  targets: Record<string, number>;
  profile: Profile | null;
}

const FIELDS: [string, string, string][] = [
  ['energy', 'ENERC_KCAL', 'Calories (kcal)'],
  ['protein', 'PROCNT', 'Protein (g)'],
  ['fat', 'FAT', 'Fat (g)'],
  ['carbs', 'CHOCDF', 'Carbs (g)'],
  ['fiber', 'FIBTG', 'Fiber (g)'],
];
const ACTIVITY: [Profile['activity'], string][] = [
  ['sedentary', 'Sedentary (desk job, little exercise)'],
  ['light', 'Light (exercise 1–3 days/week)'],
  ['moderate', 'Moderate (3–5 days/week)'],
  ['active', 'Active (6–7 days/week)'],
  ['very_active', 'Very active (physical job or 2×/day)'],
];
const LB = 0.45359237;

export function Targets(props: { weightUnit: 'kg' | 'lb' }) {
  const [g, setG] = useState<Goals | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [p, setP] = useState<Profile>({ height_cm: 175, weight_kg: 75, age: 35, sex: 'male', activity: 'light', goal_rate_kg_per_week: -0.25 });
  const [suggestion, setSuggestion] = useState<{ bmr: number; tdee: number; energy: number; protein: number; floored: boolean } | null>(null);
  const lb = props.weightUnit === 'lb';

  const load = () =>
    api.get<Goals>('/goals').then((r) => {
      setG(r);
      setEdit(Object.fromEntries(FIELDS.map(([, code]) => [code, r.targets[code] != null ? String(r.targets[code]) : ''])));
      if (r.profile) setP(r.profile);
    });
  useEffect(() => {
    load();
  }, []);

  async function saveTargets() {
    const body: Record<string, number | null> = {};
    for (const [type, code] of FIELDS) {
      const raw = edit[code]?.trim() ?? '';
      const cur = g?.targets[code];
      const next = raw === '' ? null : Number(raw);
      if ((next ?? null) !== (cur ?? null)) body[type] = next;
    }
    if (!Object.keys(body).length) return;
    try {
      await api.put('/goals', body);
      toast.success('Targets saved');
      load();
    } catch (e) {
      toast.error(e);
    }
  }

  async function calc(apply: boolean) {
    try {
      const s = await api.post<typeof suggestion>('/goals/suggest', { profile: p, apply });
      setSuggestion(s);
      if (apply) {
        toast.success('Targets updated from your profile');
        load();
      }
    } catch (e) {
      toast.error(e);
    }
  }

  if (!g) return <div class="card h-40 animate-pulse" />;
  const num = (v: string) => Number(v);
  return (
    <div class="contents">
      <section class="card flex flex-col gap-3 p-4">
        <h2 class="display text-xl font-semibold">Daily targets</h2>
        <div class="grid grid-cols-2 gap-3">
          {FIELDS.map(([, code, label]) => (
            <label class="flex flex-col gap-1">
              <span class="text-xs text-ink-2">{label}</span>
              <input
                class="input tabular-nums"
                type="number"
                inputMode="numeric"
                placeholder="—"
                value={edit[code] ?? ''}
                onInput={(e) => setEdit({ ...edit, [code]: (e.target as HTMLInputElement).value })}
              />
            </label>
          ))}
        </div>
        <button class="btn-primary" onClick={saveTargets}>
          Save targets
        </button>
      </section>

      <section class="card flex flex-col gap-3 p-4">
        <h2 class="display text-xl font-semibold">Calculate a starting target</h2>
        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-ink-2">Height (cm)</span>
            <input class="input" type="number" value={p.height_cm} onInput={(e) => setP({ ...p, height_cm: num((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-ink-2">Weight ({props.weightUnit})</span>
            <input
              class="input"
              type="number"
              value={Math.round((lb ? p.weight_kg / LB : p.weight_kg) * 10) / 10}
              onInput={(e) => {
                const v = num((e.target as HTMLInputElement).value);
                setP({ ...p, weight_kg: lb ? v * LB : v });
              }}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-ink-2">Age</span>
            <input class="input" type="number" value={p.age} onInput={(e) => setP({ ...p, age: num((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-ink-2">Sex (for the formula)</span>
            <select class="input" value={p.sex} onChange={(e) => setP({ ...p, sex: (e.target as HTMLSelectElement).value as Profile['sex'] })}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>
        </div>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-ink-2">Activity</span>
          <select class="input" value={p.activity} onChange={(e) => setP({ ...p, activity: (e.target as HTMLSelectElement).value as Profile['activity'] })}>
            {ACTIVITY.map(([v, l]) => (
              <option value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-ink-2">Goal ({props.weightUnit} per week; negative to lose)</span>
          <input
            class="input"
            type="number"
            step="0.05"
            value={Math.round((lb ? p.goal_rate_kg_per_week / LB : p.goal_rate_kg_per_week) * 100) / 100}
            onInput={(e) => {
              const v = num((e.target as HTMLInputElement).value);
              setP({ ...p, goal_rate_kg_per_week: lb ? v * LB : v });
            }}
          />
        </label>
        <button class="btn-ghost" onClick={() => calc(false)}>
          Calculate
        </button>
        {suggestion && (
          <div class="rounded-xl bg-sunken p-3 text-sm ">
            <p>
              Resting burn ≈ <b>{suggestion.bmr.toLocaleString()}</b> kcal, daily burn ≈ <b>{suggestion.tdee.toLocaleString()}</b> kcal.
            </p>
            <p class="mt-1">
              Suggested: <b>{suggestion.energy.toLocaleString()} kcal</b> and <b>{suggestion.protein} g protein</b> a day.
            </p>
            {suggestion.floored && <p class="mt-1 text-mustard">Raised to a minimum safe intake; consider a slower rate.</p>}
            <button class="btn-primary mt-3 w-full" onClick={() => calc(true)}>
              Use these targets
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
