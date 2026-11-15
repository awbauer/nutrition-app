import { useState } from 'preact/hooks';
import { api, type Intake, type Item } from '../api';
import { Questions } from './Questions';
import { ItemSheet } from './ItemSheet';
import { Sheet } from './Sheet';
import { watch } from '../analysis';
import { toast } from '../toast';
import { amountLabel, confidenceTone, kcal, MEAL_LABEL, time } from '../format';

export function MealCard(props: { meal: Intake; onChange: (m: Intake | null) => void; onAdd: (m: Intake) => void }) {
  const { meal } = props;
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tone = confidenceTone(meal.confidence);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      toast.error(e);
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
  const retry = () =>
    run(async () => {
      const m = await api.post<Intake>(`/intake/${meal.id}/retry`);
      watch(m);
      props.onChange(m);
    });
  const analyzing = meal.status === 'preparation' && !meal.pending?.error;
  const failed = meal.status === 'preparation' && !!meal.pending?.error;

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
        {meal.status === 'preparation' ? null : (
          <div class="text-right">
            <div class="font-semibold tabular-nums">{kcal(meal.totals.ENERC_KCAL)} kcal</div>
            <div class="text-xs text-slate-500 tabular-nums">{Math.round(meal.totals.PROCNT ?? 0)} g protein</div>
          </div>
        )}
      </header>
      {meal.has_media && meal.source === 'photo' && (
        <img src={`/api/intake/${meal.id}/media`} alt="" loading="lazy" class="mx-4 mt-2 h-32 w-[calc(100%-2rem)] rounded-xl object-cover" />
      )}
      {meal.status === 'preparation' && (
        // Fixed-height placeholder: progress and errors are reported by toasts, so the page doesn't jump.
        <div class="mx-4 mt-2 flex h-20 flex-col justify-center gap-2" aria-busy={analyzing}>
          {meal.raw_input_text && meal.source === 'text' ? (
            <p class="truncate text-sm text-slate-500 italic">“{meal.raw_input_text}”</p>
          ) : (
            <div class={`h-3 w-2/3 rounded bg-slate-200 dark:bg-slate-800 ${analyzing ? 'animate-pulse' : ''}`} />
          )}
          {failed ? (
            <div class="flex items-center gap-2 text-sm">
              <span class="flex-1 truncate text-rose-600">Couldn't read this meal</span>
              <button class="btn-primary px-3 py-1" onClick={retry} disabled={busy}>
                Try again
              </button>
            </div>
          ) : (
            <div class="h-3 w-1/2 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          )}
        </div>
      )}
      {meal.status === 'in-progress' && (
        <div class="mx-4 mt-2">
          <Questions intake={meal} onDone={props.onChange} />
        </div>
      )}
      <ul class="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
        {meal.items.map((it) => (
          <ItemRow item={it} onOpen={() => setOpenItem(it.id)} />
        ))}
      </ul>
      <footer class="flex gap-1 border-t border-slate-100 px-2 py-1.5 text-sm dark:border-slate-800">
        {meal.status !== 'preparation' && (
          <>
            <button class="rounded-lg px-3 py-1.5 text-brand-700 hover:bg-slate-100 dark:text-brand-500 dark:hover:bg-slate-800" onClick={() => props.onAdd(meal)} disabled={busy}>
              + Add item
            </button>
            <button class="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800" onClick={copy} disabled={busy}>
              Copy to now
            </button>
          </>
        )}
        <button class="ml-auto rounded-lg px-3 py-1.5 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950" onClick={remove} disabled={busy}>
          Delete
        </button>
      </footer>
      <Sheet open={!!openItem} onClose={() => setOpenItem(null)} title="Food details">
        {openItem && <ItemSheet itemId={openItem} onChange={props.onChange} onClose={() => setOpenItem(null)} />}
      </Sheet>
    </article>
  );
}

function ItemRow(props: { item: Item; onOpen: () => void }) {
  const it = props.item;
  const showMatch = it.food_name && it.food_name.toLowerCase() !== it.display_name.toLowerCase();
  return (
    <li>
      <button class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={props.onOpen}>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm">
            {it.display_name}
            {it.check_match ? (
              <span class="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">check match</span>
            ) : (
              it.estimated && <span class="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">estimated</span>
            )}
          </p>
          <p class="truncate text-xs text-slate-500">
            {amountLabel(it.amount_value, it.amount_unit)}
            {it.amount_unit !== 'g' && ` · ${Math.round(it.grams)} g`}
            {showMatch && ` · ${it.food_name}`}
          </p>
        </div>
        <span class="text-sm tabular-nums text-slate-600 dark:text-slate-300">{kcal(it.nutrients.ENERC_KCAL)}</span>
        <span class="text-slate-300 dark:text-slate-600" aria-hidden="true">›</span>
      </button>
    </li>
  );
}
