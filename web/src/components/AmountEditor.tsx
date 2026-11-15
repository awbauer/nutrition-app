import { Minus, Plus } from 'lucide-preact';
import { RELATIVE_SIZES, toGrams, type Portion } from '../../../src/worker/lib/units';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const fmtCount = (n: number) => {
  const whole = Math.floor(n);
  const half = n - whole >= 0.5;
  return whole === 0 && half ? '½' : `${whole}${half ? '½' : ''}`;
};

/**
 * Pick an amount the way people think about food: a relative size ("1 handful", "1½ bowls",
 * the food's own "1 slice") with a count, or an exact weight in grams.
 * Uses the server's conversion table, so the preview is what gets saved.
 */
export function AmountEditor(props: {
  amount: number;
  unit: string;
  onChange: (amount: number, unit: string) => void;
  portions?: Portion[];
  defaultServingGrams?: number | null;
  kcalPer100?: number | null;
}) {
  const food = { portions: props.portions ?? [], default_serving_grams: props.defaultServingGrams ?? null };
  const grams = props.unit === 'g';
  const estimate = toGrams(props.amount || 0, props.unit, food);
  const own = (props.portions ?? []).filter((p, i, a) => a.findIndex((x) => x.unit === p.unit) === i);
  const ownUnits = new Set(own.map((p) => p.unit));
  const generic = RELATIVE_SIZES.filter((s) => !ownUnits.has(s.unit));

  const pick = (unit: string) => {
    if (unit === props.unit) return;
    if (unit === 'g') props.onChange(Math.round(estimate.grams) || 100, 'g');
    else props.onChange(1, unit);
  };
  const step = (d: number) => props.onChange(Math.max(0.5, Math.round(((props.amount || 0) + d) * 2) / 2), props.unit);

  return (
    <div class="flex flex-col gap-3">
      <div class="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1" role="radiogroup" aria-label="Size">
        <SizeChip on={grams} onClick={() => pick('g')} label="Grams" />
        {own.map((p) => (
          <SizeChip on={props.unit === p.unit} onClick={() => pick(p.unit)} label={cap(p.label.replace(/^1\s+/, ''))} sub={`${Math.round(p.grams / p.amount)} g`} />
        ))}
        {generic.map((s) => (
          <SizeChip on={props.unit === s.unit} onClick={() => pick(s.unit)} label={s.label} />
        ))}
      </div>

      <div class="flex items-center gap-3">
        {grams ? (
          <label class="flex items-center gap-2">
            <input
              class="input w-28 text-center text-lg"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={props.amount}
              onInput={(e) => props.onChange(Number((e.target as HTMLInputElement).value), 'g')}
              aria-label="Grams"
            />
            <span class="text-ink-2">g</span>
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
          ≈ <span class="num text-ink">{Math.round(estimate.grams)}</span> g
          {props.kcalPer100 != null && (
            <>
              {' · '}
              <span class="num text-ink">{Math.round((props.kcalPer100 * estimate.grams) / 100)}</span> kcal
            </>
          )}
          {!grams && estimate.method === 'generic' && <span class="block text-xs text-faint">typical size; switch to grams for an exact amount</span>}
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
