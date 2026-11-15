import type { Portion } from '../api';

/** Amount + unit control: grams plus the food's household portions. */
export function AmountPicker(props: {
  portions: Portion[];
  amount: number;
  unit: string;
  onChange: (amount: number, unit: string) => void;
}) {
  const units = [...new Map([['g', 'g'], ...props.portions.map((p) => [p.unit, p.label] as [string, string])]).entries()];
  const portion = props.portions.find((p) => p.unit === props.unit);
  const gramsPreview = props.unit === 'g' ? props.amount : portion ? (props.amount * portion.grams) / portion.amount : null;
  return (
    <div class="flex flex-col gap-2">
      <div class="flex gap-2">
        <input
          class="input w-28 text-center text-lg tabular-nums"
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={props.amount}
          onInput={(e) => props.onChange(Number((e.target as HTMLInputElement).value), props.unit)}
          aria-label="Amount"
        />
        <select class="input flex-1" value={props.unit} onChange={(e) => props.onChange(props.amount, (e.target as HTMLSelectElement).value)} aria-label="Unit">
          {units.map(([u, label]) => (
            <option value={u}>{u === 'g' ? 'grams' : label}</option>
          ))}
        </select>
      </div>
      {gramsPreview != null && props.unit !== 'g' && <p class="text-xs text-slate-500">≈ {Math.round(gramsPreview)} g</p>}
    </div>
  );
}
