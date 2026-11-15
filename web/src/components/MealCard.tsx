import { useState } from 'preact/hooks';
import { api, type Intake, type Item } from '../api';
import { Questions } from './Questions';
import { amountLabel, confidenceTone, kcal, MEAL_LABEL, time } from '../format';

export function MealCard(props: { meal: Intake; onChange: (m: Intake | null) => void; onAdd: (m: Intake) => void }) {
  const { meal } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tone = confidenceTone(meal.confidence);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const remove = () =>
    confirm('Delete this meal?') &&
    run(async () => {
      await api.del(`/intake/${meal.id}`);
      props.onChange(null);
    });
  const copy = () => run(async () => props.onChange(await api.post<Intake>(`/intake/${meal.id}/copy`, {})));

  return (
    <article class="card overflow-hidden">
      <header class="flex items-center justify-between px-4 pt-3">
        <div>
          <h3 class="font-semibold">
            {MEAL_LABEL[meal.meal_type]}
            {meal.status === 'in-progress' && <span class="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">draft</span>}
          </h3>
          <p class="text-xs text-slate-500">
            {time(meal.occurrence_at)}
            {tone.label && (
              <>
                {' · '}
                <span class={tone.cls}>{tone.label} confidence</span>
              </>
            )}
          </p>
        </div>
        <div class="text-right">
          <div class="font-semibold tabular-nums">{kcal(meal.totals.ENERC_KCAL)} kcal</div>
          <div class="text-xs text-slate-500 tabular-nums">{Math.round(meal.totals.PROCNT ?? 0)} g protein</div>
        </div>
      </header>
      {meal.has_media && meal.source === 'photo' && (
        <img src={`/api/intake/${meal.id}/media`} alt="" loading="lazy" class="mx-4 mt-2 h-32 w-[calc(100%-2rem)] rounded-xl object-cover" />
      )}
      {meal.status === 'in-progress' && (
        <div class="mx-4 mt-2">
          <Questions intake={meal} onDone={props.onChange} />
        </div>
      )}
      <ul class="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
        {meal.items.map((it) => (
          <ItemRow item={it} editing={editing === it.id} onToggle={() => setEditing(editing === it.id ? null : it.id)} onChange={props.onChange} />
        ))}
      </ul>
      <footer class="flex gap-1 border-t border-slate-100 px-2 py-1.5 text-sm dark:border-slate-800">
        <button class="rounded-lg px-3 py-1.5 text-brand-700 hover:bg-slate-100 dark:text-brand-500 dark:hover:bg-slate-800" onClick={() => props.onAdd(meal)} disabled={busy}>
          + Add item
        </button>
        <button class="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800" onClick={copy} disabled={busy}>
          Copy to now
        </button>
        <button class="ml-auto rounded-lg px-3 py-1.5 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950" onClick={remove} disabled={busy}>
          Delete
        </button>
      </footer>
    </article>
  );
}

function ItemRow(props: { item: Item; editing: boolean; onToggle: () => void; onChange: (m: Intake) => void }) {
  const it = props.item;
  const [grams, setGrams] = useState(it.grams);
  const [busy, setBusy] = useState(false);

  async function save(body: unknown, method: 'patch' | 'del' = 'patch') {
    setBusy(true);
    try {
      const m = method === 'patch' ? await api.patch<Intake>(`/item/${it.id}`, body) : await api.del<Intake>(`/item/${it.id}`);
      props.onChange(m);
      props.onToggle();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li class="px-4 py-2.5">
      <button class="flex w-full items-center gap-3 text-left" onClick={props.onToggle}>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm">
            {it.display_name}
            {it.estimated && <span class="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">estimated</span>}
          </p>
          <p class="text-xs text-slate-500">
            {amountLabel(it.amount_value, it.amount_unit)}
            {it.amount_unit !== 'g' && ` · ${Math.round(it.grams)} g`}
          </p>
        </div>
        <span class="text-sm tabular-nums text-slate-600 dark:text-slate-300">{kcal(it.nutrients.ENERC_KCAL)}</span>
      </button>
      {props.editing && (
        <div class="mt-2 flex items-center gap-2">
          <input
            class="input w-24 py-1.5 text-center tabular-nums"
            type="number"
            inputMode="decimal"
            value={grams}
            onInput={(e) => setGrams(Number((e.target as HTMLInputElement).value))}
            aria-label="Grams"
          />
          <span class="text-sm text-slate-500">g</span>
          <button class="btn-primary ml-auto px-3 py-1.5" disabled={busy || !(grams > 0)} onClick={() => save({ amount: grams, unit: 'g' })}>
            Save
          </button>
          <button class="btn-ghost px-3 py-1.5 text-rose-600" disabled={busy} onClick={() => save(null, 'del')}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}
