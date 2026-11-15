import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Food, type Intake, type MealType, type UsdaHit } from '../api';
import { MEALS, MEAL_LABEL } from '../format';
import { submitMeal } from '../queue';
import { AmountPicker } from './AmountPicker';

type Hit = { kind: 'local'; food: Food } | { kind: 'usda'; hit: UsdaHit };

const per100 = (n: { code: string; value: number }[], code: string) => n.find((x) => x.code === code)?.value;

/**
 * Manual food search + amount entry. Adds to `intakeId` when given, otherwise creates a meal.
 */
export function AddFood(props: { date: string; intakeId?: string; defaultMeal?: MealType; onDone: (i: Intake) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Food | null>(null);
  const [amount, setAmount] = useState(100);
  const [unit, setUnit] = useState('g');
  const [meal, setMeal] = useState<MealType>(props.defaultMeal ?? 'snack');
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setHits([]);
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ local: Food[]; usda: UsdaHit[]; usda_error?: string }>(`/foods?q=${encodeURIComponent(term)}`);
        if (n !== seq.current) return;
        setHits([...r.local.map((food) => ({ kind: 'local' as const, food })), ...r.usda.map((hit) => ({ kind: 'usda' as const, hit }))]);
        setErr(r.usda_error ? 'Food database unavailable; showing saved foods only.' : null);
      } catch (e) {
        if (n === seq.current) setErr((e as Error).message);
      } finally {
        if (n === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function choose(h: Hit) {
    setErr(null);
    try {
      const food = h.kind === 'local' ? h.food : await api.get<Food>(`/foods/fdc/${h.hit.sourceId}`);
      setPicked(food);
      const first = food.portions[0];
      if (first) {
        setAmount(first.amount);
        setUnit(first.unit);
      } else {
        setAmount(100);
        setUnit('g');
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function save() {
    if (!picked || !(amount > 0)) return;
    setSaving(true);
    setErr(null);
    try {
      const item = { food_id: picked.id, amount, unit };
      const res = props.intakeId
        ? await api.post<Intake>(`/intake/${props.intakeId}/items`, item)
        : await submitMeal('/intake', { meal_type: meal, ...(occurrenceFor(props.date) ? { occurrence_at: occurrenceFor(props.date) } : {}), items: [item] });
      props.onDone(res as Intake);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (picked) {
    const kcal100 = per100(picked.nutrients, 'ENERC_KCAL');
    const prot100 = per100(picked.nutrients, 'PROCNT');
    const portion = picked.portions.find((p) => p.unit === unit);
    const g = unit === 'g' ? amount : portion ? (amount * portion.grams) / portion.amount : amount;
    return (
      <div class="flex flex-col gap-4">
        <button class="self-start text-sm text-brand-700 dark:text-brand-500" onClick={() => setPicked(null)}>
          ← Back to results
        </button>
        <div>
          <h3 class="font-semibold">{picked.name}</h3>
          {picked.brand && <p class="text-sm text-slate-500">{picked.brand}</p>}
        </div>
        <AmountPicker portions={picked.portions} amount={amount} unit={unit} onChange={(a, u) => (setAmount(a), setUnit(u))} />
        <div class="grid grid-cols-2 gap-2 text-center">
          <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
            <div class="text-xl font-bold tabular-nums">{kcal100 != null ? Math.round((kcal100 * g) / 100) : '–'}</div>
            <div class="text-xs text-slate-500">kcal</div>
          </div>
          <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
            <div class="text-xl font-bold tabular-nums">{prot100 != null ? Math.round((prot100 * g) / 10) / 10 : '–'}</div>
            <div class="text-xs text-slate-500">g protein</div>
          </div>
        </div>
        {!props.intakeId && (
          <div class="flex flex-wrap gap-2">
            {MEALS.map((m) => (
              <button class={m === meal ? 'chip-on' : 'chip'} onClick={() => setMeal(m)}>
                {MEAL_LABEL[m]}
              </button>
            ))}
          </div>
        )}
        {err && <p class="text-sm text-rose-600">{err}</p>}
        <button class="btn-primary w-full py-3" disabled={saving || !(amount > 0)} onClick={save}>
          {saving ? 'Saving…' : props.intakeId ? 'Add to meal' : 'Log food'}
        </button>
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-3">
      <input
        class="input"
        type="search"
        placeholder="Search foods (e.g. greek yogurt)"
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        autoFocus
        enterKeyHint="search"
      />
      {err && <p class="text-sm text-amber-600">{err}</p>}
      {loading && hits.length === 0 && <p class="text-sm text-slate-500">Searching…</p>}
      <ul class="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
        {hits.map((h) => {
          const name = h.kind === 'local' ? h.food.name : h.hit.name;
          const brand = h.kind === 'local' ? h.food.brand : h.hit.brand;
          const nutrients = h.kind === 'local' ? h.food.nutrients : h.hit.nutrients;
          const tag = h.kind === 'local' ? (h.food.source === 'usda' ? 'Recent' : 'My food') : h.hit.dataType;
          return (
            <li>
              <button class="flex w-full items-center gap-3 py-3 text-left" onClick={() => choose(h)}>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium">{name}</p>
                  <p class="truncate text-xs text-slate-500">
                    {tag}
                    {brand ? ` · ${brand}` : ''}
                  </p>
                </div>
                <span class="shrink-0 text-xs text-slate-500 tabular-nums">{Math.round(per100(nutrients, 'ENERC_KCAL') ?? 0)} kcal/100g</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Log "now" for today; noon local time for other days. */
export function occurrenceFor(date: string): string | undefined {
  const local = new Date();
  const todayLocal = new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return date === todayLocal ? undefined : new Date(`${date}T12:00:00`).toISOString();
}
