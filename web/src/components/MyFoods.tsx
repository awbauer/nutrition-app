import { Camera, Plus, ScanText, Trash2 } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type Food } from '../api';
import { kcal } from '../format';
import { resizeImage } from '../image';
import { toast } from '../toast';

export type CustomFood = Food & { times_logged: number; last_logged_at: string | null };

/** Draft read from a label photo by POST /api/foods/label. */
interface LabelDraft {
  name: string;
  brand: string | null;
  serving_amount: number;
  serving_unit: string;
  serving_grams: number | null;
  serving_grams_estimated: boolean;
  per_serving: Record<string, number>;
}

/** Fields shown per serving, in label order. */
const FIELDS: { code: string; label: string; unit: string; indent?: boolean }[] = [
  { code: 'ENERC_KCAL', label: 'Calories', unit: 'kcal' },
  { code: 'FAT', label: 'Total fat', unit: 'g' },
  { code: 'FASAT', label: 'Saturated fat', unit: 'g', indent: true },
  { code: 'NA', label: 'Sodium', unit: 'mg' },
  { code: 'CHOCDF', label: 'Carbohydrate', unit: 'g' },
  { code: 'FIBTG', label: 'Fiber', unit: 'g', indent: true },
  { code: 'SUGAR', label: 'Sugars', unit: 'g', indent: true },
  { code: 'PROCNT', label: 'Protein', unit: 'g' },
];

interface Values {
  name: string;
  brand: string;
  serving: string;
  grams: string;
  gramsEstimated: boolean;
  nutrients: Record<string, string>;
}

const round = (v: number) => String(Math.round(v * 10) / 10);

function valuesFrom(f?: Food): Values {
  if (!f) return { name: '', brand: '', serving: '', grams: '', gramsEstimated: false, nutrients: {} };
  const portion = f.portions.find((p) => p.unit === 'serving') ?? null;
  const g = portion?.grams ?? f.default_serving_grams ?? 100;
  return {
    name: f.name,
    brand: f.brand ?? '',
    serving: portion?.label && portion.label !== 'serving' ? portion.label : portion ? '1 serving' : '100 g',
    grams: round(g),
    gramsEstimated: false,
    nutrients: Object.fromEntries(f.nutrients.map((n) => [n.code, round((n.value * g) / 100)])),
  };
}

/** 0.667 -> "2/3", 1.5 -> "1 1/2": labels print fractions. */
function amountText(a: number): string {
  const whole = Math.floor(a + 1e-6);
  const frac = a - whole;
  const f = [
    [1 / 4, '1/4'],
    [1 / 3, '1/3'],
    [1 / 2, '1/2'],
    [2 / 3, '2/3'],
    [3 / 4, '3/4'],
  ].find(([v]) => Math.abs(frac - (v as number)) < 0.02)?.[1];
  if (frac < 0.02) return String(whole);
  return f ? (whole ? `${whole} ${f}` : String(f)) : round(a);
}

function valuesFromDraft(d: LabelDraft, keepName: string): Values {
  const unit = d.serving_unit;
  return {
    name: keepName || d.name,
    brand: d.brand ?? '',
    serving: `${amountText(d.serving_amount)} ${unit}`,
    grams: d.serving_grams ? round(d.serving_grams) : '',
    gramsEstimated: d.serving_grams_estimated,
    nutrients: Object.fromEntries(Object.entries(d.per_serving).map(([k, v]) => [k, round(v)])),
  };
}

/** Request body for POST/PUT /api/foods, or an error message. */
function body(v: Values) {
  if (!v.name.trim()) return 'Give the food a name';
  const grams = Number(v.grams);
  if (!(grams > 0)) return 'Enter the weight of one serving (grams or ml)';
  const per_serving: Record<string, number> = {};
  for (const [k, s] of Object.entries(v.nutrients)) {
    if (!s.trim()) continue;
    const n = Number(s);
    if (!(n >= 0)) return `Check the ${FIELDS.find((f) => f.code === k)?.label.toLowerCase() ?? k} value`;
    per_serving[k] = n;
  }
  if (per_serving.ENERC_KCAL == null) return 'Calories are required';
  return { name: v.name.trim(), brand: v.brand.trim() || null, serving_grams: grams, serving_label: v.serving.trim() || '1 serving', per_serving };
}

/**
 * Create or edit a custom food. "Read a label" fills the form from a photo of a nutrition panel
 * or a screenshot of a restaurant app; everything stays editable before saving.
 */
export function CustomFoodForm(props: { food?: Food; initialName?: string; onSaved: (f: Food) => void; onDeleted?: () => void }) {
  const [v, setV] = useState<Values>(() => ({ ...valuesFrom(props.food), ...(props.initialName && !props.food ? { name: props.initialName } : {}) }));
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<Values>) => setV((cur) => ({ ...cur, ...p }));

  async function onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])].slice(0, 3);
    input.value = '';
    if (!files.length) return;
    setReading(true);
    try {
      const form = new FormData();
      for (const f of files) form.append('photo', await resizeImage(f, 1600, 0.88), 'label.jpg');
      if (v.name.trim()) form.append('name', v.name.trim());
      const d = await api.post<LabelDraft>('/foods/label', form);
      setV(valuesFromDraft(d, v.name.trim()));
      toast.success('Label read. Check the numbers, then save.');
    } catch (err) {
      toast.error(err instanceof ApiError && err.status === 422 ? `${err.message} Try a closer, sharper photo.` : err);
    } finally {
      setReading(false);
    }
  }

  async function save() {
    const b = body(v);
    if (typeof b === 'string') return toast.error(b);
    setSaving(true);
    try {
      const f = props.food ? await api.put<Food>(`/foods/${props.food.id}`, b) : await api.post<Food>('/foods', b);
      dispatchEvent(new CustomEvent('foods-changed'));
      props.onSaved(f);
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!props.food || !confirm(`Delete ${props.food.name}? Meals you already logged keep it.`)) return;
    try {
      await api.del(`/foods/${props.food.id}`);
      dispatchEvent(new CustomEvent('foods-changed'));
      props.onDeleted?.();
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <input ref={fileRef} type="file" accept="image/*" multiple class="hidden" onChange={onFiles} />
      <button class="btn-ghost w-full justify-center py-3" onClick={() => fileRef.current?.click()} disabled={reading}>
        {reading ? (
          <>
            <ScanText size={18} class="animate-pulse" /> Reading the label…
          </>
        ) : (
          <>
            <Camera size={18} /> {props.food ? 'Read a new label' : 'Read a label or screenshot'}
          </>
        )}
      </button>
      {!props.food && <p class="-mt-2 text-xs text-ink-2">A photo of the Nutrition Facts panel, or a screenshot of a restaurant app's nutrition screen. Or type the numbers in.</p>}

      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Name</span>
        <input class="input" value={v.name} maxLength={120} placeholder="Pistachio cold brew, grande" onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">
          Brand or restaurant <span class="font-normal text-faint">(optional)</span>
        </span>
        <input class="input" value={v.brand} maxLength={60} onInput={(e) => set({ brand: (e.target as HTMLInputElement).value })} />
      </label>
      <div class="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-3">
        <label class="flex min-w-0 flex-col gap-1">
          <span class="text-sm font-medium">Serving</span>
          <input class="input" value={v.serving} maxLength={60} placeholder="1 bar" onInput={(e) => set({ serving: (e.target as HTMLInputElement).value })} />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">Weight</span>
          <div class="relative">
            <input
              class="input w-full pr-10"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={v.grams}
              onInput={(e) => set({ grams: (e.target as HTMLInputElement).value, gramsEstimated: false })}
            />
            <span class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-faint">g</span>
          </div>
        </label>
      </div>
      {v.gramsEstimated && <p class="-mt-2 text-xs text-mustard">The label doesn't give a weight, so this is an estimate. It only matters if you log this food by weight.</p>}

      <fieldset class="card px-4 py-1">
        <legend class="sr-only">Nutrition per serving</legend>
        <p class="border-b-4 border-ink py-2 text-xs font-semibold tracking-wide text-ink-2 uppercase">Per serving</p>
        {FIELDS.map((f) => (
          <label class={`flex items-center gap-3 border-b border-line py-1.5 last:border-b-0 ${f.indent ? 'pl-4' : ''}`}>
            <span class={`flex-1 text-sm ${f.indent ? 'text-ink-2' : 'font-medium'}`}>{f.label}</span>
            <input
              class="num w-20 rounded-lg bg-sunken px-2 py-1.5 text-right text-[0.95rem] outline-none focus:ring-2 focus:ring-accent"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={v.nutrients[f.code] ?? ''}
              placeholder="–"
              onInput={(e) => set({ nutrients: { ...v.nutrients, [f.code]: (e.target as HTMLInputElement).value } })}
            />
            <span class="w-8 text-xs text-faint">{f.unit}</span>
          </label>
        ))}
      </fieldset>

      <button class="btn-primary w-full py-3" onClick={save} disabled={saving || reading}>
        {saving ? 'Saving…' : props.food ? 'Save changes' : 'Save food'}
      </button>
      {props.food && (
        <>
          <p class="text-center text-xs text-faint">Changes apply to future logs; meals already logged keep their numbers.</p>
          <button class="btn-quiet mx-auto flex text-berry" onClick={remove}>
            <Trash2 size={16} /> Delete food
          </button>
        </>
      )}
    </div>
  );
}

export function useCustomFoods(): CustomFood[] | null {
  const [list, setList] = useState<CustomFood[] | null>(null);
  useEffect(() => {
    const load = () => api.get<CustomFood[]>('/foods/mine').then(setList, () => setList([]));
    load();
    addEventListener('foods-changed', load);
    return () => removeEventListener('foods-changed', load);
  }, []);
  return list;
}

const perServing = (f: Food) => {
  const p = f.portions.find((x) => x.unit === 'serving');
  const g = p?.grams ?? 100;
  const v = (code: string) => ((f.nutrients.find((n) => n.code === code)?.value ?? 0) * g) / 100;
  return { label: p ? (p.label === 'serving' ? '1 serving' : p.label) : '100 g', kcal: v('ENERC_KCAL'), protein: v('PROCNT') };
};

/** The user's custom foods as cards: tap to edit, or log one. */
export function MyFoodsList(props: { onNew: () => void; onOpen: (f: CustomFood) => void; onLog: (f: CustomFood) => void }) {
  const list = useCustomFoods();
  if (!list) return <div class="card h-40 animate-pulse" />;
  if (!list.length)
    return (
      <div class="card flex flex-col items-center gap-3 px-6 py-10 text-center">
        <ScanText size={40} strokeWidth={1.5} class="text-faint" aria-hidden="true" />
        <p class="display text-xl font-semibold">No foods of your own yet</p>
        <p class="max-w-[19rem] text-sm text-ink-2">
          Something the food database doesn't have? Photograph its nutrition label, or screenshot the nutrition screen in a restaurant's app, and it's yours to log.
        </p>
        <button class="btn-primary mt-1" onClick={props.onNew}>
          Add a food
        </button>
      </div>
    );
  return (
    <ul class="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {list.map((f) => {
        const s = perServing(f);
        return (
          <li class="card flex flex-col">
            <button class="flex flex-1 flex-col gap-1 px-4 pt-3.5 pb-2 text-left" onClick={() => props.onOpen(f)}>
              <span class="display text-lg leading-tight font-semibold">{f.name}</span>
              <span class="text-xs text-faint">
                {f.brand ? `${f.brand} · ` : ''}
                {s.label}
                {f.times_logged > 0 && ` · eaten ${f.times_logged}×`}
              </span>
              <span class="mt-1 flex items-baseline gap-3">
                <span>
                  <span class="num text-xl font-semibold">{kcal(s.kcal)}</span>
                  <span class="ml-1 text-xs text-faint">kcal</span>
                </span>
                <span class="text-xs font-medium text-sage">{Math.round(s.protein)} g protein</span>
              </span>
            </button>
            <button class="flex items-center gap-2 border-t border-dashed border-line px-4 py-2.5 text-sm font-medium text-accent-ink" onClick={() => props.onLog(f)}>
              <Plus size={16} /> Log it
            </button>
          </li>
        );
      })}
    </ul>
  );
}
