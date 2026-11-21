import { Minus, Plus } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import { EXACT_UNITS, SIZE_LABEL, sizesFor, toGrams, withCounts, type Conversion, type Portion } from '../../../src/worker/lib/units';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const fmtCount = (n: number) => {
  const whole = Math.floor(n);
  const half = n - whole >= 0.5;
  return whole === 0 && half ? '½' : `${whole}${half ? '½' : ''}`;
};

/** The food's own portions shown as chips; USDA can list many near-duplicates. */
const MAX_OWN = 4;

/**
 * Pick an amount the way people think about food: a relative size ("1 handful", "1½ bowls",
 * the food's own "1 slice") with a count, or an exact amount typed in (grams or ounces; ml or
 * fl oz for drinks). Only sizes that suit the food are offered, chosen from its USDA / Open Food
 * Facts category (see sizesFor).
 * Uses the server's conversion table, so the preview is what gets saved.
 */
export function AmountEditor(props: {
  amount: number;
  unit: string;
  onChange: (amount: number, unit: string) => void;
  portions?: Portion[];
  /** The food's database category, which picks the sizes on offer... */
  category?: string | null;
  /** ...or, without a usable one, its name (and the user's wording). */
  name?: string | string[];
  defaultServingGrams?: number | null;
  kcalPer100?: number | null;
  /** Show the "typical size" note under the preview (Food details explains it separately). */
  hint?: boolean;
  /** A weight already known for one of a unit (the AI's estimate when the item was logged), used over the generic size table. */
  knownUnit?: { unit: string; grams: number } | null;
}) {
  const row = useRef<HTMLDivElement>(null);
  // Keep the selected size visible in the scrolling row (e.g. "Piece" sits far to the right).
  useEffect(() => {
    const chip = row.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    const r = row.current;
    if (chip && r) r.scrollTo({ left: Math.max(0, chip.offsetLeft - r.clientWidth / 2 + chip.offsetWidth / 2), behavior: 'smooth' });
  }, [props.unit]);
  // Name and category pick the cup weight for volumes (a cup of lettuce isn't a cup of water), as on the server.
  const food = { name: props.name, category: props.category, portions: props.portions ?? [], default_serving_grams: props.defaultServingGrams ?? null };
  const exactUnit = EXACT_UNITS[props.unit];
  const grams = props.unit === 'g';
  const known = props.knownUnit && props.knownUnit.unit === props.unit ? props.knownUnit : null;
  const estimate: Conversion = known ? { grams: (props.amount || 0) * known.grams, method: 'portion' } : toGrams(props.amount || 0, props.unit, food);
  const fit = sizesFor({ name: props.name, category: props.category, portions: props.portions });
  // The food's own portions (exact units already have their own chip), then the sizes that suit it.
  // Includes the count inside a labelled serving ("2 cookies (36g)" offers a Cookie chip).
  const own = withCounts(props.portions ?? [])
    .filter((p, i, a) => !(p.unit in EXACT_UNITS) && a.findIndex((x) => x.unit === p.unit) === i)
    .filter((p, i) => i < MAX_OWN || p.unit === props.unit);
  const shown = new Set([...fit.exact, ...own.map((p) => p.unit)]);
  const generic = fit.sizes.filter((u) => !shown.has(u));
  // An amount saved in a unit we no longer suggest (e.g. "plate" from a voice note) still shows, selected.
  const current = shown.has(props.unit) || generic.includes(props.unit) ? null : props.unit;

  const pick = (unit: string) => {
    if (unit === props.unit) return;
    const ex = EXACT_UNITS[unit];
    if (ex) {
      // Keep the same weight in the new unit, at this food's density (2 cups of lettuce is ~470 ml, not 94).
      const n = estimate.grams / (toGrams(1, unit, food).grams || ex.grams);
      props.onChange(Math.max(ex.step, Math.round(n / ex.step) * ex.step), unit);
    } else props.onChange(1, unit);
  };
  const step = (d: number) => props.onChange(Math.max(0.5, Math.round(((props.amount || 0) + d) * 2) / 2), props.unit);

  return (
    <div class="flex flex-col gap-3">
      <div ref={row} class="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1" role="radiogroup" aria-label="Size">
        {fit.exact.map((u) => (
          <SizeChip on={props.unit === u} onClick={() => pick(u)} label={EXACT_UNITS[u]!.label} />
        ))}
        {current && <SizeChip on onClick={() => {}} label={EXACT_UNITS[current]?.label ?? SIZE_LABEL[current] ?? cap(current)} />}
        {own.map((p) => (
          <SizeChip on={props.unit === p.unit} onClick={() => pick(p.unit)} label={cap(p.label.replace(/^1\s+/, ''))} sub={`${Math.round(p.grams / p.amount)} g`} />
        ))}
        {generic.map((u) => {
          // A cup or spoon of a food weighed from the cup table shows that weight, like the food's own portions.
          const one = toGrams(1, u, food);
          return (
            <SizeChip on={props.unit === u} onClick={() => pick(u)} label={SIZE_LABEL[u] ?? cap(u)} sub={one.method === 'density' ? `${Math.round(one.grams)} g` : undefined} />
          );
        })}
      </div>

      <div class="flex items-center gap-3">
        {exactUnit ? (
          <label class="flex items-center gap-2">
            <input
              class="input w-28 text-center text-lg"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={props.amount}
              onInput={(e) => props.onChange(Number((e.target as HTMLInputElement).value), props.unit)}
              aria-label={exactUnit.label}
            />
            <span class="text-ink-2">{exactUnit.suffix}</span>
          </label>
        ) : (
          <div class="flex items-center gap-1 rounded-full bg-sunken p-1">
            <button class="icon-btn h-9 w-9 bg-card" onClick={() => step(-0.5)} disabled={props.amount <= 0.5} aria-label="Less">
              <Minus size={16} />
            </button>
            <span class="num w-10 text-center text-xl" aria-live="polite">
              {fmtCount(props.amount)}
            </span>
            <button class="icon-btn h-9 w-9 bg-card" onClick={() => step(0.5)} aria-label="More">
              <Plus size={16} />
            </button>
          </div>
        )}
        <p class="text-sm text-ink-2">
          {/* With grams the weight is already in the box; just show the energy. */}
          {grams ? (
            '='
          ) : (
            <>
              ≈ <span class="num text-ink">{Math.round(estimate.grams)}</span> g
            </>
          )}
          {props.kcalPer100 != null && (
            <>
              {grams ? ' ' : ' · '}
              <span class="num text-ink">{Math.round((props.kcalPer100 * estimate.grams) / 100)}</span> kcal
            </>
          )}
          {props.hint !== false && !exactUnit && estimate.method === 'generic' && (
            <span class="block text-xs text-faint">typical size; switch to {EXACT_UNITS[fit.exact[0]!]!.label.toLowerCase()} for an exact amount</span>
          )}
          {props.hint !== false && estimate.method === 'density' && estimate.per_cup && (
            <span class="block text-xs text-faint">
              estimate: a cup of {estimate.per_cup.what} is about {estimate.per_cup.grams} g
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

function SizeChip(props: { on: boolean; onClick: () => void; label: string; sub?: string }) {
  return (
    <button role="radio" aria-checked={props.on} class={`shrink-0 ${props.on ? 'chip-on' : 'chip'}`} onClick={props.onClick}>
      {props.label}
      {props.sub && <span class={`ml-1 text-xs ${props.on ? 'opacity-70' : 'text-faint'}`}>{props.sub}</span>}
    </button>
  );
}
