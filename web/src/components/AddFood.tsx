import { toast } from '../toast';
import { occurrenceFor } from '../today';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Favorite, type FatSecretHit, type Food, type Intake, type MealType, type UsdaHit } from '../api';
import { FatSecretCredit } from './ItemSheet';
import { MEALS, MEAL_LABEL, preferMass } from '../format';
import { submitMeal } from '../queue';
import { AmountEditor } from './AmountEditor';
import { FavoriteStar } from './FavoriteStar';
import { saveFavorite } from '../favorites';
import { CustomFoodForm } from './MyFoods';
import { fromUcum, sizesFor, toGrams } from '../../../src/worker/lib/units';

type Hit = { kind: 'local'; food: Food } | { kind: 'usda'; hit: UsdaHit | FatSecretHit };

const per100 = (n: { code: string; value: number }[], code: string) => n.find((x) => x.code === code)?.value;

/**
 * Manual food search + amount entry. Adds to `intakeId` when given, otherwise creates a meal.
 */
export interface QuickPick {
  name: string;
  food_id: string;
  amount: number;
  unit: string;
}

/**
 * With `onFavorite`, the same search and amount picker stars the food instead of logging it
 * (Foods → Favorites → Add).
 */
export function AddFood(props: {
  date: string;
  /** Today's log date (after the day cutoff), when known. */
  today?: string;
  intakeId?: string;
  defaultMeal?: MealType;
  initial?: QuickPick;
  onDone: (i: Intake) => void;
  onFavorite?: (f: Favorite) => void;
  /** Start with this search typed in. */
  initialQuery?: string;
}) {
  const [q, setQ] = useState(props.initialQuery ?? '');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Food | null>(null);
  const [amount, setAmount] = useState(100);
  const [unit, setUnit] = useState('g');
  const [meal, setMeal] = useState<MealType>(props.defaultMeal ?? 'snack');
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const seq = useRef(0);
  // Opened from Recent / Frequent: start on that food with the amount used last time.
  const [label, setLabel] = useState<string | undefined>(props.initial?.name);
  useEffect(() => {
    const init = props.initial;
    if (!init) return;
    api.get<Food>(`/foods/${init.food_id}`).then(
      (food) => {
        setPicked(food);
        setAmount(init.amount);
        setUnit(fromUcum(init.unit));
      },
      (e) => toast.error(e),
    );
  }, [props.initial?.food_id]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setHits([]);
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ history?: Food[]; local: Food[]; usda: UsdaHit[]; fatsecret?: FatSecretHit[]; usda_error?: string }>(`/foods?q=${encodeURIComponent(term)}`);
        if (n !== seq.current) return;
        setHits([
          ...[...(r.history ?? []), ...r.local].map((food) => ({ kind: 'local' as const, food })),
          ...interleave(r.usda, r.fatsecret ?? []).map((hit) => ({ kind: 'usda' as const, hit })),
        ]);
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
      const food = h.kind === 'local' ? h.food : await api.get<Food>(h.hit.source === 'fatsecret' ? `/foods/fatsecret/${h.hit.sourceId}` : `/foods/fdc/${h.hit.sourceId}`);
      // Something you've had before: keep what you usually call it.
      const yours = h.kind === 'local' ? h.food.history?.names[0] : undefined;
      setLabel(yours && yours.toLowerCase() !== food.name.toLowerCase() ? yours : undefined);
      setPicked(food);
      const first = food.portions[0];
      if (first) {
        setAmount(first.amount);
        setUnit(first.unit);
      } else {
        // No portions: start in the food's exact unit (ml for a drink, the user's weight unit otherwise), about 100 g.
        const exact = preferMass(sizesFor({ name: food.name, category: food.category }).exact)[0]!;
        setAmount(exact === 'oz' ? 3.5 : 100);
        setUnit(exact);
      }
    } catch (e) {
      toast.error(e);
    }
  }

  async function save() {
    if (!picked || !(amount > 0)) return;
    setSaving(true);
    try {
      if (props.onFavorite) {
        const fav = await saveFavorite({ name: label ?? picked.name, food_id: picked.id, amount, unit });
        props.onFavorite(fav);
        return;
      }
      // Keep the user's own wording for a quick pick ("salmon sashimi" rather than the USDA name).
      const item = { food_id: picked.id, amount, unit, ...(label ? { display_name: label } : {}) };
      // Into a specific meal (its Add item), or from the main button: breakfast/lunch/dinner join the day's meal.
      const at = occurrenceFor(props.date, props.today);
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

  if (creating && !picked) {
    return (
      <div class="flex flex-col gap-4">
        <button class="self-start text-sm text-accent-ink" onClick={() => setCreating(false)}>
          ← Back to results
        </button>
        <CustomFoodForm initialName={q.trim()} onSaved={(food) => (setCreating(false), choose({ kind: 'local', food }))} />
      </div>
    );
  }

  if (picked) {
    const kcal100 = per100(picked.nutrients, 'ENERC_KCAL');
    const prot100 = per100(picked.nutrients, 'PROCNT');
    const g = toGrams(amount || 0, unit, {
      name: [label ?? '', picked.name],
      category: picked.category,
      portions: picked.portions,
      default_serving_grams: picked.default_serving_grams,
    }).grams;
    return (
      <div class="flex flex-col gap-4">
        {/* Opened on a quick pick there are no results to go back to (the sheet has its own Back). */}
        {!label && (
          <button class="self-start text-sm text-accent-ink" onClick={() => setPicked(null)}>
            ← Back to results
          </button>
        )}
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <h3 class="display text-lg font-semibold">{label ?? picked.name}</h3>
            {label && label.toLowerCase() !== picked.name.toLowerCase() && <p class="text-sm text-ink-2">{picked.name}</p>}
            {picked.brand && <p class="text-sm text-ink-2">{picked.brand}</p>}
          </div>
          {/* Stars it with the amount chosen below. */}
          {amount > 0 && !props.onFavorite && <FavoriteStar name={label ?? picked.name} food_id={picked.id} amount={amount} unit={unit} size={22} class="-mr-2 -mt-1" />}
        </div>
        <AmountEditor
          category={picked.category}
          name={[label ?? '', picked.name]}
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
        {!props.intakeId && !props.onFavorite && (
          <div class="flex flex-wrap gap-2">
            {MEALS.map((m) => (
              <button class={m === meal ? 'chip-on' : 'chip'} onClick={() => setMeal(m)}>
                {MEAL_LABEL[m]}
              </button>
            ))}
          </div>
        )}
        <button class="btn-primary w-full py-3" disabled={saving || !(amount > 0)} onClick={save}>
          {saving ? 'Saving…' : props.onFavorite ? 'Add to favorites' : props.intakeId ? 'Add to meal' : 'Log food'}
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
          const past = h.kind === 'local' ? h.food.history : undefined;
          const name = past?.names[0] ?? (h.kind === 'local' ? h.food.name : h.hit.name);
          const brand = h.kind === 'local' ? h.food.brand : h.hit.brand;
          const nutrients = h.kind === 'local' ? h.food.nutrients : h.hit.nutrients;
          const dbName = h.kind === 'local' ? h.food.name : h.hit.name;
          const tag = past
            ? `You've had this${past.times > 1 ? ` ${past.times}×` : ''}${name.toLowerCase() !== dbName.toLowerCase() ? ` · ${dbName}` : ''}`
            : h.kind === 'local'
              ? h.food.source === 'usda' || h.food.source === 'fatsecret'
                ? 'Recent'
                : h.food.source === 'recipe'
                  ? 'Your recipe'
                  : 'My food'
              : h.hit.source === 'fatsecret'
                ? 'FatSecret'
                : h.hit.dataType;
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
      {hits.some((h) => (h.kind === 'usda' && h.hit.source === 'fatsecret') || (h.kind === 'local' && h.food.source === 'fatsecret')) && (
        <div class="text-center">
          <FatSecretCredit />
        </div>
      )}
      {q.trim().length >= 2 && !loading && (
        <button class="btn-quiet mx-auto flex text-sm" onClick={() => setCreating(true)}>
          {hits.length ? 'Not here? Add it from a label' : 'No matches. Add it from a label'}
        </button>
      )}
    </div>
  );
}

/** USDA and FatSecret results alternated, so restaurant items aren't buried under 25 USDA rows. */
function interleave<A, B>(a: A[], b: B[]): (A | B)[] {
  const out: (A | B)[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]!);
    if (i < b.length) out.push(b[i]!);
  }
  return out;
}
