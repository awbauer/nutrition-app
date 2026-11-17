import { ChefHat, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { watch } from '../analysis';
import { api, type Intake, type Item } from '../api';
import { amountLabel, confidenceTone, kcal, MEAL_LABEL, time } from '../format';
import { toast } from '../toast';
import { ItemSheet } from './ItemSheet';
import { MealEdit } from './MealEdit';
import { Questions } from './Questions';
import { SaveAsRecipe } from './Recipes';
import { Sheet } from './Sheet';

export function MealCard(props: { meal: Intake; onChange: (m: Intake | null) => void; onAdd: (m: Intake) => void }) {
  const { meal } = props;
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [savingRecipe, setSavingRecipe] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setMenu(false);
    try {
      return await fn();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const remove = () =>
    confirm(`Delete this ${MEAL_LABEL[meal.meal_type].toLowerCase()}?`) &&
    run(async () => {
      await api.del(`/intake/${meal.id}`);
      toast.success(`${MEAL_LABEL[meal.meal_type]} deleted`);
      props.onChange(null);
    });
  const retry = () =>
    run(async () => {
      const m = await api.post<Intake>(`/intake/${meal.id}/retry`);
      watch(m);
      props.onChange(m);
    });
  const copy = () =>
    run(async () => {
      props.onChange(await api.post<Intake>(`/intake/${meal.id}/copy`, {}));
      toast.success(`${MEAL_LABEL[meal.meal_type]} copied to now`);
    });

  const analyzing = meal.status === 'preparation' && !meal.pending?.error;
  const failed = meal.status === 'preparation' && !!meal.pending?.error;
  const asking = meal.status === 'in-progress';
  const done = meal.status === 'completed';

  return (
    <article class="card">
      <header class="flex items-start gap-2 px-4 pt-3.5">
        <div class="min-w-0 flex-1">
          <h3 class="display text-lg leading-tight font-semibold">
            {meal.pending?.recipe ? `Recipe: ${meal.pending.recipe}` : MEAL_LABEL[meal.meal_type]}
            {analyzing && <StatusPill tone="neutral" pulse>{meal.source === 'voice' ? 'Listening' : 'Reading'}</StatusPill>}
            {asking && <StatusPill tone="accent">One question</StatusPill>}
            {failed && <StatusPill tone="berry">Couldn't read</StatusPill>}
          </h3>
          {/* Phones: the time lives here (tablet and up show it on the timeline rail). */}
          <p class="num mt-0.5 text-[0.8rem] text-ink-2 md:hidden">{time(meal.occurrence_at)}</p>
          {meal.pending?.adding_to_meal && <p class="mt-0.5 text-xs text-ink-2">Will join your {MEAL_LABEL[meal.meal_type].toLowerCase()} when it's done</p>}
        </div>
        {meal.status !== 'preparation' && (
          <div class="text-right">
            <p class="num text-xl leading-tight font-semibold">
              {kcal(meal.totals.ENERC_KCAL)}
              <span class="ml-1 font-sans text-xs font-normal text-faint">kcal</span>
            </p>
            <p class="text-xs font-medium text-sage">{Math.round(meal.totals.PROCNT ?? 0)} g protein</p>
          </div>
        )}
        <div class="relative -mt-1 -mr-2" ref={menuRef}>
          <button class="icon-btn" onClick={() => setMenu(!menu)} aria-label={`More for ${MEAL_LABEL[meal.meal_type].toLowerCase()}`} aria-expanded={menu} aria-haspopup="menu" disabled={busy}>
            <MoreHorizontal size={20} />
          </button>
          {menu && (
            <div class="toast-in absolute top-10 right-0 z-30 w-52 overflow-hidden rounded-2xl bg-card py-1 shadow-xl ring-1 ring-line" role="menu">
              {meal.status !== 'preparation' && <MenuItem icon={<Pencil size={16} />} label="Edit time, meal or note" onClick={() => (setMenu(false), setEditing(true))} />}
              {done && <MenuItem icon={<Copy size={16} />} label="Copy to now" onClick={copy} />}
              {done && meal.items.length > 0 && <MenuItem icon={<ChefHat size={16} />} label="Save as recipe" onClick={() => (setMenu(false), setSavingRecipe(true))} />}
              <MenuItem icon={<Trash2 size={16} />} label="Delete" danger onClick={remove} />
            </div>
          )}
        </div>
      </header>

      {meal.note && <p class="display mx-4 mt-1.5 text-[0.95rem] text-ink-2 italic">{meal.note}</p>}
      {meal.photo_count === 1 && (
        <img src={`/api/intake/${meal.id}/photos/0`} alt="Meal photo" loading="lazy" class="mx-4 mt-3 h-36 w-[calc(100%-2rem)] rounded-2xl object-cover" />
      )}
      {meal.photo_count > 1 && (
        // Several photos: a strip that scrolls sideways, the next one peeking in.
        <div class="mt-3 flex snap-x gap-2 overflow-x-auto px-4" aria-label={`${meal.photo_count} meal photos`}>
          {Array.from({ length: meal.photo_count }, (_, i) => (
            <img
              src={`/api/intake/${meal.id}/photos/${i}`}
              alt={`Meal photo ${i + 1} of ${meal.photo_count}`}
              loading="lazy"
              class="h-36 w-[min(16rem,75%)] shrink-0 snap-start rounded-2xl object-cover"
            />
          ))}
        </div>
      )}

      {meal.status === 'preparation' && (
        // Fixed height while the AI works; progress and errors come as toasts, so nothing jumps.
        <div class="mx-4 mt-3 mb-4 flex h-16 flex-col justify-center gap-2" aria-busy={analyzing}>
          {meal.raw_input_text && meal.source === 'text' ? (
            <p class="display truncate text-ink-2 italic">“{meal.raw_input_text}”</p>
          ) : (
            <div class={`h-3 w-2/3 rounded-full bg-sunken ${analyzing ? 'animate-pulse' : ''}`} />
          )}
          {failed ? (
            <div class="flex items-center gap-2 text-sm">
              <span class="flex-1 truncate text-berry">{meal.pending?.error ?? "Couldn't read this meal"}</span>
              <button class="btn-primary px-3 py-1.5 text-sm" onClick={retry} disabled={busy}>
                Try again
              </button>
            </div>
          ) : (
            <div class="h-3 w-1/2 animate-pulse rounded-full bg-sunken" />
          )}
        </div>
      )}

      {asking && (
        <div class="mx-4 mt-3">
          <Questions intake={meal} onDone={props.onChange} />
        </div>
      )}

      {meal.items.length > 0 && (
        <ul class="mt-2">
          {meal.items.map((it) => (
            <ItemRow item={it} onOpen={() => setOpenItem(it.id)} />
          ))}
        </ul>
      )}

      {done ? (
        <button class="flex w-full items-center gap-2 border-t border-dashed border-line px-4 py-3 text-sm font-medium text-accent-ink" onClick={() => props.onAdd(meal)} disabled={busy}>
          <Plus size={16} /> Add to {MEAL_LABEL[meal.meal_type].toLowerCase()}
        </button>
      ) : (
        meal.status !== 'preparation' && <div class="h-3" />
      )}

      <Sheet open={!!openItem} onClose={() => setOpenItem(null)} title="Food details">
        {openItem && <ItemSheet itemId={openItem} onChange={props.onChange} onClose={() => setOpenItem(null)} />}
      </Sheet>
      <Sheet open={savingRecipe} onClose={() => setSavingRecipe(false)} title="Save as recipe">
        {savingRecipe && (
          <SaveAsRecipe
            meal={meal}
            onSaved={() => {
              setSavingRecipe(false);
              props.onChange(null);
            }}
          />
        )}
      </Sheet>
      <Sheet open={editing} onClose={() => setEditing(false)} title={`Edit ${MEAL_LABEL[meal.meal_type].toLowerCase()}`}>
        {editing && (
          <MealEdit
            meal={meal}
            onSaved={(m) => {
              setEditing(false);
              props.onChange(m);
            }}
          />
        )}
      </Sheet>
    </article>
  );
}

function StatusPill(props: { tone: 'neutral' | 'accent' | 'berry'; pulse?: boolean; children: preact.ComponentChildren }) {
  const cls = { neutral: 'bg-sunken text-ink-2', accent: 'bg-accent-soft text-accent-ink', berry: 'bg-berry-soft text-berry' }[props.tone];
  return (
    <span class={`ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 align-middle font-sans text-[11px] font-semibold ${cls}`}>
      {props.pulse && <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {props.children}
    </span>
  );
}

function MenuItem(props: { icon: preact.ComponentChildren; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" class={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-sunken ${props.danger ? 'text-berry' : 'text-ink'}`} onClick={props.onClick}>
      {props.icon}
      {props.label}
    </button>
  );
}

function ItemRow(props: { item: Item; onOpen: () => void }) {
  const it = props.item;
  const tone = confidenceTone(it.confidence);
  const showMatch = it.food_name && it.food_name.toLowerCase() !== it.display_name.toLowerCase();
  return (
    <li>
      <button class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-sunken/70 active:bg-sunken" onClick={props.onOpen}>
        {tone.dot && <span class={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} title={`${tone.label} confidence`} aria-label={`${tone.label} confidence`} role="img" />}
        <div class="min-w-0 flex-1">
          <p class="truncate text-[0.95rem]">
            {it.display_name}
            {it.check_match && <span class="ml-1.5 rounded-full bg-mustard-soft px-1.5 py-0.5 align-middle text-[10px] font-semibold text-mustard">check match</span>}
          </p>
          <p class="truncate text-xs text-faint">
            {amountLabel(it.amount_value, it.amount_unit)}
            {it.amount_unit !== 'g' && ` · ${Math.round(it.grams)} g`}
            {it.estimated ? ' · AI estimate' : showMatch ? ` · ${it.food_name}` : ''}
          </p>
        </div>
        <span class="num text-[0.95rem] text-ink-2">{kcal(it.nutrients.ENERC_KCAL)}</span>
      </button>
    </li>
  );
}
