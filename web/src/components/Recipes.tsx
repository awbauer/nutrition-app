import { ChefHat, Minus, Plus, Trash2 } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type Intake, type Recipe } from '../api';
import { amountLabel, kcal } from '../format';
import { toast } from '../toast';
import { Sheet } from './Sheet';

const WEIGHT_UNITS = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 } as const;
type WeightUnit = keyof typeof WEIGHT_UNITS;

export interface RecipeFieldValues {
  name: string;
  servings: number;
  /** Finished batch weight as typed, in `weightUnit`; empty when not weighed. */
  weight: string;
  weightUnit: WeightUnit;
}

export const emptyRecipeFields = (name = ''): RecipeFieldValues => ({ name, servings: 4, weight: '', weightUnit: 'g' });

export function recipeFieldsFrom(r: Recipe): RecipeFieldValues {
  return { name: r.name, servings: r.servings, weight: r.yield_grams ? String(r.yield_grams) : '', weightUnit: 'g' };
}

/** {name, servings, yield_grams} for the API, or an error message. */
export function recipeBody(v: RecipeFieldValues): { name: string; servings: number; yield_grams: number | null } | string {
  if (!v.name.trim()) return 'Give the recipe a name';
  if (!(v.servings > 0)) return 'How many servings does it make?';
  const w = v.weight.trim() ? Number(v.weight) : null;
  if (w != null && !(w > 0)) return 'Enter the batch weight as a number, or leave it empty';
  return { name: v.name.trim(), servings: v.servings, yield_grams: w != null ? Math.round(w * WEIGHT_UNITS[v.weightUnit] * 10) / 10 : null };
}

/** Name, servings and (optional) weight of the finished batch. */
export function RecipeFields(props: { value: RecipeFieldValues; onChange: (v: RecipeFieldValues) => void; autoFocus?: boolean }) {
  const v = props.value;
  const set = (p: Partial<RecipeFieldValues>) => props.onChange({ ...v, ...p });
  return (
    <div class="flex flex-col gap-3">
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Name</span>
        <input class="input" value={v.name} maxLength={120} placeholder="Turkey chili" autoFocus={props.autoFocus} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
      </label>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-5">
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium" id="servings-label">
            Makes
          </span>
          <div class="flex w-fit items-center gap-1 rounded-full bg-sunken p-1" role="group" aria-labelledby="servings-label">
            <button class="icon-btn h-9 w-9 bg-card" onClick={() => set({ servings: Math.max(1, v.servings - 1) })} disabled={v.servings <= 1} aria-label="Fewer servings">
              <Minus size={16} />
            </button>
            <input
              class="num w-12 bg-transparent text-center text-xl outline-none"
              type="number"
              inputMode="decimal"
              min="1"
              value={v.servings}
              onInput={(e) => set({ servings: Number((e.target as HTMLInputElement).value) })}
              aria-label="Servings"
            />
            <button class="icon-btn h-9 w-9 bg-card" onClick={() => set({ servings: v.servings + 1 })} aria-label="More servings">
              <Plus size={16} />
            </button>
            <span class="pr-3 pl-1 text-sm text-ink-2">servings</span>
          </div>
        </div>
        <label class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="text-sm font-medium">
            Finished weight <span class="font-normal text-faint">(optional)</span>
          </span>
          <div class="flex gap-2">
            <input
              class="input min-w-0 flex-1"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="Weigh the pot"
              value={v.weight}
              onInput={(e) => set({ weight: (e.target as HTMLInputElement).value })}
            />
            <select class="input w-24 shrink-0" value={v.weightUnit} onChange={(e) => set({ weightUnit: (e.target as HTMLSelectElement).value as WeightUnit })} aria-label="Weight unit">
              {Object.keys(WEIGHT_UNITS).map((u) => (
                <option value={u}>{u}</option>
              ))}
            </select>
          </div>
        </label>
      </div>
      <p class="text-xs text-ink-2">
        Weighing the finished batch (less the pot) lets you log portions by weight accurately. Cooking changes weight, so without it portions are counted
        in servings.
      </p>
    </div>
  );
}

/** "Save as recipe" from a meal's menu: its items become the ingredients and the meal leaves the log. */
export function SaveAsRecipe(props: { meal: Intake; onSaved: () => void }) {
  const first = props.meal.items[0]?.display_name ?? '';
  const [v, setV] = useState(emptyRecipeFields(props.meal.items.length === 1 ? first : ''));
  const [busy, setBusy] = useState(false);
  async function save() {
    const body = recipeBody(v);
    if (typeof body === 'string') return toast.error(body);
    setBusy(true);
    try {
      const r = await api.post<Recipe>('/recipes', { ...body, from_intake: props.meal.id });
      toast.success(`Saved "${r.name}" · ${kcal(r.per_serving.ENERC_KCAL)} kcal a serving`);
      dispatchEvent(new CustomEvent('recipes-changed'));
      props.onSaved();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="flex flex-col gap-4">
      <p class="text-sm text-ink-2">
        {props.meal.items.length === 1 ? 'This item becomes the recipe' : `These ${props.meal.items.length} items become the recipe's ingredients`} ({kcal(props.meal.totals.ENERC_KCAL)} kcal for the whole batch). This entry
        comes off your log, since you haven't eaten the batch yet. Then log servings as you eat them.
      </p>
      <RecipeFields value={v} onChange={setV} autoFocus />
      <button class="btn-primary w-full py-3" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : 'Save recipe'}
      </button>
    </div>
  );
}

export function useRecipes(): Recipe[] | null {
  const [list, setList] = useState<Recipe[] | null>(null);
  useEffect(() => {
    const load = () => api.get<Recipe[]>('/recipes').then(setList, () => setList([]));
    load();
    addEventListener('recipes-changed', load);
    return () => removeEventListener('recipes-changed', load);
  }, []);
  return list;
}

/** Recipes at the top of the log sheet: tap one to log a serving. */
export function RecipePicks(props: { onPick: (r: Recipe) => void }) {
  const list = useRecipes();
  if (!list?.length) return null;
  return (
    <section class="flex flex-col gap-2" aria-label="Your recipes">
      <p class="eyebrow">Your recipes</p>
      <div class="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
        {list.map((r) => (
          <button class="card flex min-w-36 shrink-0 flex-col items-start gap-0.5 px-3.5 py-2.5 text-left hover:bg-sunken/70 active:bg-sunken" onClick={() => props.onPick(r)}>
            <span class="max-w-44 truncate text-[0.95rem] font-medium">{r.name}</span>
            <span class="text-xs text-faint">
              <span class="num text-ink-2">{kcal(r.per_serving.ENERC_KCAL)}</span> kcal a serving
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Settings card: the recipe list, each opening its details. */
export function RecipesCard() {
  const list = useRecipes();
  const [open, setOpen] = useState<Recipe | null>(null);
  return (
    <section class="card flex flex-col gap-3 p-4">
      <h2 class="display text-xl font-semibold">Recipes</h2>
      {list && !list.length && (
        <p class="text-sm text-ink-2">
          For things you cook in a batch and eat over a few days. Tap <span class="font-medium text-ink">+</span>, choose{' '}
          <span class="font-medium text-ink">Cooked a batch?</span>, and list what went in. Then log servings as you eat them.
        </p>
      )}
      {list && list.length > 0 && (
        <ul class="-mx-4 divide-y divide-line">
          {list.map((r) => (
            <li>
              <button class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-sunken/70" onClick={() => setOpen(r)}>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[0.95rem]">{r.name}</p>
                  <p class="truncate text-xs text-faint">
                    {amountLabel(r.servings, 'serving')} · {r.ingredients.length} ingredients
                    {r.times_logged > 0 && ` · eaten ${r.times_logged}×`}
                  </p>
                </div>
                <span class="text-right text-xs text-ink-2">
                  <span class="num block text-[0.95rem] text-ink">{kcal(r.per_serving.ENERC_KCAL)}</span>
                  kcal a serving
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!list && <div class="h-12 animate-pulse rounded-xl bg-sunken" />}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.name ?? 'Recipe'}>
        {open && <RecipeDetail recipe={open} onDone={() => setOpen(null)} />}
      </Sheet>
    </section>
  );
}

interface EditableIngredient {
  food_id: string;
  display_name: string;
  food_name: string;
  amount_value: number;
  amount_unit: string;
  grams: number;
  kcal_per_g: number;
  protein_per_g: number;
}

/** A recipe's numbers and ingredients; edit the size, ingredient weights, or delete it. */
function RecipeDetail(props: { recipe: Recipe; onDone: () => void }) {
  const r = props.recipe;
  const [v, setV] = useState(recipeFieldsFrom(r));
  const [ings, setIngs] = useState<EditableIngredient[]>(() =>
    r.ingredients.map((i) => ({ ...i, kcal_per_g: i.grams > 0 ? i.kcal / i.grams : 0, protein_per_g: i.grams > 0 ? i.protein / i.grams : 0 })),
  );
  const [busy, setBusy] = useState(false);
  const totalKcal = ings.reduce((s, i) => s + i.kcal_per_g * i.grams, 0);
  const totalProtein = ings.reduce((s, i) => s + i.protein_per_g * i.grams, 0);
  const body = recipeBody(v);
  const servings = typeof body === 'string' ? r.servings : body.servings;
  const batchGrams = (typeof body !== 'string' && body.yield_grams) || ings.reduce((s, i) => s + i.grams, 0);

  const setGrams = (idx: number, grams: number) => setIngs(ings.map((i, j) => (j === idx ? { ...i, grams, amount_value: grams, amount_unit: 'g' } : i)));

  async function save() {
    if (typeof body === 'string') return toast.error(body);
    if (!ings.length) return toast.error('A recipe needs at least one ingredient');
    setBusy(true);
    try {
      const saved = await api.put<Recipe>(`/recipes/${r.id}`, {
        ...body,
        ingredients: ings.map((i) => ({ food_id: i.food_id, amount: i.amount_value, unit: i.amount_unit, grams: i.grams, display_name: i.display_name })),
      });
      toast.success(`Saved "${saved.name}" · ${kcal(saved.per_serving.ENERC_KCAL)} kcal a serving`);
      dispatchEvent(new CustomEvent('recipes-changed'));
      props.onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${r.name}"? Servings you've already logged stay in your log.`)) return;
    setBusy(true);
    try {
      await api.del(`/recipes/${r.id}`);
      toast.success(`Deleted "${r.name}"`);
      dispatchEvent(new CustomEvent('recipes-changed'));
      props.onDone();
    } catch (e) {
      toast.error(e);
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <div class="grid grid-cols-3 gap-2 text-center">
        <Stat value={kcal(totalKcal / servings)} label="kcal a serving" />
        <Stat value={`${Math.round(totalProtein / servings)} g`} label="protein a serving" />
        <Stat value={`${Math.round(batchGrams / servings)} g`} label="a serving" />
      </div>
      <RecipeFields value={v} onChange={setV} />
      <div class="flex flex-col gap-1">
        <p class="eyebrow">Ingredients · {kcal(totalKcal)} kcal</p>
        <ul class="card divide-y divide-line">
          {ings.map((i, idx) => (
            <li class="flex items-center gap-2 px-3 py-2">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm">{i.display_name}</p>
                <p class="truncate text-xs text-faint">
                  {i.amount_unit !== 'g' && `${amountLabel(i.amount_value, i.amount_unit)} · `}
                  {i.food_name !== i.display_name ? i.food_name : ''}
                </p>
              </div>
              <label class="flex items-center gap-1 text-sm text-ink-2">
                <input
                  class="input w-20 px-2 py-1 text-right"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={Math.round(i.grams)}
                  onChange={(e) => {
                    const g = Number((e.target as HTMLInputElement).value);
                    if (g > 0) setGrams(idx, g);
                  }}
                  aria-label={`Grams of ${i.display_name}`}
                />
                g
              </label>
              <span class="num w-12 text-right text-sm text-ink-2">{kcal(i.kcal_per_g * i.grams)}</span>
              <button class="icon-btn h-8 w-8" onClick={() => setIngs(ings.filter((_, j) => j !== idx))} aria-label={`Remove ${i.display_name}`}>
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p class="text-xs text-ink-2">Changes apply to servings you log from now on; earlier entries keep their numbers.</p>
      <button class="btn-primary w-full py-3" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : 'Save changes'}
      </button>
      <button class="btn-quiet mx-auto flex items-center gap-2 text-berry" disabled={busy} onClick={remove}>
        <Trash2 size={16} /> Delete recipe
      </button>
    </div>
  );
}

function Stat(props: { value: string; label: string }) {
  return (
    <div class="rounded-xl bg-sunken p-3">
      <div class="num text-xl font-semibold">{props.value}</div>
      <div class="text-xs text-ink-2">{props.label}</div>
    </div>
  );
}

export const RecipeIcon = ChefHat;
