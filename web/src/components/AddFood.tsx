import { toast } from '../toast';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Food, type Intake, type MealType, type UsdaHit } from '../api';
import { MEALS, MEAL_LABEL } from '../format';
import { submitMeal } from '../queue';
import { AmountEditor } from './AmountEditor';
import { toGrams } from '../../../src/worker/lib/units';

type Hit = { kind: 'local'; food: Food } | { kind: 'usda'; hit: UsdaHit };

const per100 = (n: { code: string; value: number }[], code: string) => n.find((x) => x.code === code)?.value;

/**
 * Manual food search + amount entry. Adds to `intakeId` when given, otherwise creates a meal.
 */
export function AddFood(props: { date: string; intakeId?: string; defaultMeal?: MealType; onDone: (i: Intake) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
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
        if (r.usda_error) toast.info('Food database unavailable; showing saved foods only.', { id: 'usda' });
      } catch (e) {
        if (n === seq.current) toast.error(e, { id: 'usda' });
      } finally {
        if (n === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function choose(h: Hit) {
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
      toast.error(e);
    }
  }

  async function save() {
    if (!picked || !(amount > 0)) return;
    setSaving(true);
    try {
      const item = { food_id: picked.id, amount, unit };
      // Into a specific meal (its Add item), or from the main button: breakfast/lunch/dinner join the day's meal.
      const at = occurrenceFor(props.date);
      const res = await submitMeal(
        '/intake',
        props.intakeId ? { append_to: props.intakeId, items: [item] } : { meal_type: meal, merge: true, ...(at ? { occurrence_at: at } : {}), items: [item] },
      );
      if (!res) toast.info("You're offline. The food will sync when you're back online.");
      props.onDone(res as Intake);
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  }

  if (picked) {
    const kcal100 = per100(picked.nutrients, 'ENERC_KCAL');
    const prot100 = per100(picked.nutrients, 'PROCNT');
    const g = toGrams(amount || 0, unit, { portions: picked.portions, default_serving_grams: picked.default_serving_grams }).grams;
    return (
      <div class="flex flex-col gap-4">
        <button class="self-start text-sm text-accent-ink" onClick={() => setPicked(null)}>
          ← Back to results
        </button>
        <div>
          <h3 class="font-semibold">{picked.name}</h3>
          {picked.brand && <p class="text-sm text-ink-2">{picked.brand}</p>}
        </div>
        <AmountEditor
          portions={picked.portions}
          defaultServingGrams={picked.default_serving_grams}
          kcalPer100={kcal100 ?? null}
          amount={amount}
          unit={unit}
          onChange={(a, u) => (setAmount(a), setUnit(u))}
        />
        <div class="grid grid-cols-2 gap-2 text-center">
          <div class="rounded-xl bg-sunken p-3 ">
            <div class="num text-2xl font-semibold">{kcal100 != null ? Math.round((kcal100 * g) / 100) : '–'}</div>
            <div class="text-xs text-ink-2">kcal</div>
          </div>
          <div class="rounded-xl bg-sunken p-3 ">
            <div class="num text-2xl font-semibold">{prot100 != null ? Math.round((prot100 * g) / 10) / 10 : '–'}</div>
            <div class="text-xs text-ink-2">g protein</div>
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
      {loading && hits.length === 0 && <p class="text-sm text-ink-2">Searching…</p>}
      <ul class="flex flex-col divide-y divide-line">
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
                  <p class="truncate text-xs text-ink-2">
                    {tag}
                    {brand ? ` · ${brand}` : ''}
                  </p>
                </div>
                <span class="shrink-0 text-xs text-ink-2 tabular-nums">{Math.round(per100(nutrients, 'ENERC_KCAL') ?? 0)} kcal/100g</span>
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
