import { ArrowUp, Camera, ChefHat, ImagePlus, Mic, Plus, Search, X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { watch } from '../analysis';
import { api, type Favorite, type Intake, type MealType } from '../api';
import { amountLabel, kcal, MEALS, MEAL_LABEL, weight } from '../format';
import { resizeImage } from '../image';
import { submitMeal } from '../queue';
import { toast } from '../toast';
import { AddFood, type QuickPick } from './AddFood';
import { occurrenceFor } from '../today';
import { FavoriteStar } from './FavoriteStar';
import { findFavorite, setFavorites, useFavorites } from '../favorites';
import { Questions } from './Questions';
import { Recorder } from './Recorder';
import { emptyRecipeFields, RecipeFields, recipeBody, RecipePicks } from './Recipes';

const AUDIO_EXT: Record<string, string> = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };
/** Same limit as the server (MAX_PHOTOS). */
const MAX_PHOTOS = 6;

/**
 * One composer for every way of logging: type it, attach photos, or record it, then send.
 * Several photos (plate, drink, the package's label…) are read together by the AI as one meal.
 * Search is there for picking an exact food. With `target` (a meal's "Add to …") everything
 * goes into that meal; from the main button, breakfast/lunch/dinner join the day's existing
 * meal of that type and snacks are new.
 */
export function LogSheet(props: {
  date: string;
  /** Today's log date (after the day cutoff), when known. */
  today?: string;
  defaultMeal: MealType;
  target?: Intake;
  onDone: () => void;
  /** Open straight into "Cooked a batch?" (new recipe). */
  startBatch?: boolean;
  /** Open straight on this food's amount (e.g. a recipe's "Log a serving"). */
  initialPick?: QuickPick;
}) {
  const [view, setView] = useState<'compose' | 'record' | 'search'>(props.initialPick ? 'search' : 'compose');
  const [text, setText] = useState('');
  const [meal, setMeal] = useState<MealType>(props.defaultMeal);
  const [photos, setPhotos] = useState<{ blob: Blob; url: string }[]>([]);
  const [clip, setClip] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Intake | null>(null);
  const [quickPick, setQuickPick] = useState<QuickPick | undefined>(props.initialPick);
  // Cooked a batch: what's described becomes a recipe's ingredients instead of a meal.
  const [batch, setBatch] = useState<ReturnType<typeof emptyRecipeFields> | null>(props.startBatch ? emptyRecipeFields() : null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mealFor = props.target?.meal_type ?? meal;

  const photo = photos.length > 0;
  const ready = !!(photo || clip || text.trim());

  async function submit() {
    if (!ready || busy) return;
    const f = new FormData();
    if (clip) f.append('audio', clip.blob, `voice.${AUDIO_EXT[clip.blob.type] ?? 'm4a'}`);
    else photos.forEach((p, i) => f.append('photo', p.blob, `meal-${i + 1}.jpg`));
    if (text.trim() && !clip) f.append('text', text.trim());
    if (batch) {
      const body = recipeBody(batch);
      if (typeof body === 'string') return toast.error(body);
      f.append('recipe', JSON.stringify(body));
    } else if (props.target) f.append('append_to', props.target.id);
    else {
      f.append('meal_type', meal);
      f.append('merge', '1');
      const at = occurrenceFor(props.date, props.today);
      if (at) f.append('occurrence_at', at);
    }
    setBusy(true);
    try {
      const r = await submitMeal('/intake', f);
      // Saved (or queued offline): the AI fills it in in the background and Today shows progress.
      if (r?.pending?.recipe || r?.pending?.recipe_saved) {
        watch(r);
        props.onDone();
      } else if (r?.merged_from) {
        toast.success(`Added to your ${MEAL_LABEL[r.meal_type].toLowerCase()}`);
        props.onDone();
      } else if (r && r.status !== 'preparation') setDraft(r);
      else {
        if (r) watch(r);
        else toast.info("You're offline. It'll sync when you're back online.");
        props.onDone();
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = ''; // so picking the same photo again still fires change
    if (!files.length) return;
    const room = MAX_PHOTOS - photos.length;
    if (files.length > room) toast.info(`Up to ${MAX_PHOTOS} photos per meal${room > 0 ? `; added the first ${room}` : ''}.`);
    if (room <= 0) return;
    const blobs = await Promise.all(files.slice(0, room).map((f) => resizeImage(f)));
    setPhotos((prev) => [...prev, ...blobs.map((blob) => ({ blob, url: URL.createObjectURL(blob) }))].slice(0, MAX_PHOTOS));
    setClip(null);
  }

  function removePhoto(i: number) {
    setPhotos((prev) => {
      URL.revokeObjectURL(prev[i]!.url);
      return prev.filter((_, j) => j !== i);
    });
  }

  function clearPhotos() {
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    setPhotos([]);
  }

  if (draft) return <DraftView draft={draft} onDone={props.onDone} onChange={setDraft} />;

  if (view === 'search')
    return (
      <div class="flex flex-col gap-3">
        <button class="self-start text-sm font-medium text-accent-ink" onClick={() => (setView('compose'), setQuickPick(undefined))}>
          ← Back
        </button>
        <AddFood date={props.date} today={props.today} defaultMeal={meal} intakeId={props.target?.id} initial={quickPick} onDone={props.onDone} />
      </div>
    );

  return (
    <div class="flex flex-col gap-4">
      {batch ? (
        <div class="flex flex-col gap-3">
          {/* From the Recipes screen the sheet is already titled "New recipe". */}
          <div class={`flex items-center justify-between ${props.startBatch ? 'hidden' : ''}`}>
            <p class="flex items-center gap-2 text-sm font-medium">
              <ChefHat size={18} /> New recipe
            </p>
            <button class="text-sm font-medium text-accent-ink" onClick={() => setBatch(null)}>
              Log a meal instead
            </button>
          </div>
          <RecipeFields value={batch} onChange={setBatch} autoFocus />
        </div>
      ) : props.target ? (
        <p class="text-sm text-ink-2">Adding to your {MEAL_LABEL[props.target.meal_type].toLowerCase()}.</p>
      ) : (
        <div class="segmented" role="radiogroup" aria-label="Meal">
          {MEALS.map((m) => (
            <button class="seg" role="radio" aria-checked={m === meal} onClick={() => setMeal(m)}>
              {MEAL_LABEL[m]}
            </button>
          ))}
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" multiple class="hidden" onChange={onFile} />

      {view === 'record' ? (
        <div class="card p-4">
          <Recorder
            onClip={(b) => {
              setClip(b ? { blob: b, url: URL.createObjectURL(b) } : null);
              if (b) {
                clearPhotos();
                setView('compose');
              }
            }}
          />
          <button class="btn-quiet mx-auto mt-1 flex" onClick={() => setView('compose')}>
            Cancel
          </button>
        </div>
      ) : (
        <div class="card flex flex-col gap-3 p-3 focus-within:shadow-[0_0_0_2px_var(--accent)]">
          {photo && (
            <div class="-mt-1.5 flex items-center gap-2 overflow-x-auto pt-1.5 pr-1.5 pb-1" aria-label="Photos">
              {photos.map((p, i) => (
                <div class="relative shrink-0">
                  <img src={p.url} alt={`Photo ${i + 1}`} class="h-20 w-20 rounded-xl object-cover" />
                  <button
                    class="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-card shadow"
                    onClick={() => removePhoto(i)}
                    aria-label={`Remove photo ${i + 1}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              {photos.length < MAX_PHOTOS && (
                <button
                  class="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line text-xs text-ink-2 hover:bg-sunken"
                  onClick={() => fileRef.current?.click()}
                  aria-label="Add another photo"
                >
                  <ImagePlus size={18} />
                  Add
                </button>
              )}
            </div>
          )}
          {clip && (
            <div class="flex items-center gap-3">
              <audio src={clip.url} controls class="h-10 min-w-0 flex-1" />
              <button class="icon-btn ml-auto" onClick={() => setClip(null)} aria-label="Remove recording">
                <X size={18} />
              </button>
            </div>
          )}
          {!clip && (
            <textarea
              class="min-h-24 w-full resize-none bg-transparent px-1 text-[1.05rem] leading-relaxed outline-none placeholder:text-faint"
              placeholder={
                batch
                  ? photo
                    ? 'Anything to add? (optional, e.g. "plus 2 tbsp olive oil")'
                    : 'What went in? 2 lb ground turkey, 2 cans black beans, 1 onion, 1 tbsp oil…'
                  : photo
                    ? photos.length > 1
                      ? 'Anything to add? (optional, e.g. "I only drank half the shake")'
                      : 'Anything to add? (optional, e.g. "half the rice")'
                    : 'Two eggs, toast with butter, a flat white…'
              }
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit()}
              aria-label={batch ? 'What went into the batch?' : 'What did you eat?'}
              enterkeyhint="send"
            />
          )}
          <div class="flex items-center gap-1">
            <ToolButton onClick={() => fileRef.current?.click()} icon={<Camera size={19} />} label="Photo" />
            <ToolButton onClick={() => setView('record')} icon={<Mic size={19} />} label="Voice" />
            {!batch && <ToolButton onClick={() => setView('search')} icon={<Search size={18} />} label="Search" />}
            <button
              class="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-accent text-white transition active:scale-95 disabled:bg-sunken disabled:text-faint"
              disabled={!ready || busy}
              onClick={submit}
              aria-label="Log it"
            >
              {busy ? <span class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> : <ArrowUp size={22} strokeWidth={2.5} />}
            </button>
          </div>
        </div>
      )}

      {view === 'compose' && !batch && !text && !photo && !clip && (
        <>
          <RecipePicks onPick={(r) => (setQuickPick({ name: r.name, food_id: r.id, amount: 1, unit: 'serving' }), setView('search'))} />
          <QuickAdd mealType={mealFor} intakeId={props.target?.id} onPick={(q) => (setQuickPick(q), setView('search'))} />
        </>
      )}

      {!batch && !props.target && view === 'compose' && (
        <button class="btn-quiet mx-auto flex items-center gap-2 text-sm" onClick={() => setBatch(emptyRecipeFields())}>
          <ChefHat size={16} /> Cooked a batch? Save it as a recipe
        </button>
      )}

      <p class="text-center text-xs text-faint">
        {batch
          ? 'List everything that went into the pot, with amounts for the whole batch. Then log servings as you eat them.'
          : 'Describe it however you like. The AI finds the foods, and nutrition comes from USDA and the package label.'}
      </p>
    </div>
  );
}

interface Quick {
  name: string;
  food_id: string;
  amount: number;
  unit: string;
  kcal: number | null;
  count: number;
}
/** Something you usually have with what's already in the meal. */
type GoesWith = Quick & { with: string };
type QuickTab = 'with' | 'favorites' | 'frequent' | 'recent';

/**
 * Starred, frequent and recent foods: tap one to log it with its amount; tap the star to keep it on top.
 * Adding to a meal (`intakeId`), "Goes with" comes first: what you usually have with what's in it.
 */
function QuickAdd(props: { mealType: MealType; intakeId?: string; onPick: (q: QuickPick) => void }) {
  const [data, setData] = useState<{ recent: Quick[]; frequent: Quick[]; goes_with?: GoesWith[] } | null>(null);
  const [tab, setTab] = useState<QuickTab | null>(null);
  const favorites = useFavorites();
  useEffect(() => {
    const withMeal = props.intakeId ? `&with=${encodeURIComponent(props.intakeId)}` : '';
    api.get<{ favorites: Favorite[]; recent: Quick[]; frequent: Quick[]; goes_with?: GoesWith[] }>(`/foods/quick?meal_type=${props.mealType}${withMeal}`).then(
      (d) => {
        setFavorites(d.favorites);
        setData(d);
        setTab((t) => t ?? (d.goes_with?.length ? 'with' : d.favorites.length ? 'favorites' : d.frequent.length ? 'frequent' : 'recent'));
      },
      () => setData({ recent: [], frequent: [] }),
    );
  }, [props.mealType, props.intakeId]);

  const goesWith = data?.goes_with ?? [];
  if (!data || (!goesWith.length && !favorites.length && !data.recent.length && !data.frequent.length)) return null;
  // Unstarring the last favorite falls back to another list.
  const shown = tab === 'favorites' && !favorites.length ? (data.frequent.length ? 'frequent' : 'recent') : tab;
  const list: (Quick | Favorite | GoesWith)[] = shown === 'with' ? goesWith : shown === 'favorites' ? favorites : shown === 'frequent' ? data.frequent : data.recent;
  const tabs: [QuickTab, string][] = [];
  if (goesWith.length) tabs.push(['with', 'Goes with']);
  if (favorites.length) tabs.push(['favorites', 'Starred']);
  if (data.frequent.length) tabs.push(['frequent', 'Frequent']);
  if (data.recent.length) tabs.push(['recent', 'Recent']);
  return (
    <section class="flex flex-col gap-2" aria-label="Quick add">
      {/* Four tabs don't fit beside the label on a phone: they get their own row. */}
      <div class={`flex gap-2 ${tabs.length > 3 ? 'flex-col' : 'items-center justify-between'}`}>
        <p class="eyebrow whitespace-nowrap">Quick add</p>
        {tabs.length > 1 && (
          <div class={`segmented min-w-0 text-xs ${tabs.length > 3 ? 'w-full sm:w-80' : tabs.length > 2 ? 'w-60' : 'w-48'}`} role="tablist">
            {tabs.map(([key, label]) => (
              <button class="seg px-1.5 py-1 text-xs whitespace-nowrap" role="tab" aria-pressed={shown === key} aria-selected={shown === key} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <ul class="card divide-y divide-line">
        {list.map((q) => (
          <li class="flex items-center pr-1.5">
            <button class="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left hover:bg-sunken/70 active:bg-sunken" onClick={() => props.onPick(q)}>
              <div class="min-w-0 flex-1">
                <p class="truncate text-[0.95rem]">{q.name}</p>
                <p class="truncate text-xs text-faint">
                  {amountLabel(q.amount, q.unit)}
                  {shown === 'frequent' && 'count' in q && ` · ${q.count}× lately`}
                  {shown === 'with' && 'with' in q && ` · with ${q.with.toLowerCase()}${q.count > 1 ? ` ${q.count}×` : ''}`}
                </p>
              </div>
              {q.kcal != null && <span class="num text-ink-2">{kcal(q.kcal)}</span>}
              <span class="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent-ink" aria-hidden="true">
                <Plus size={16} />
              </span>
            </button>
            {/* A starred food keeps its saved amount; starring from Recent saves the latest one. */}
            <FavoriteStar {...(findFavorite(favorites, q.name) ?? q)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ToolButton(props: { onClick: () => void; icon: preact.ComponentChildren; label: string }) {
  return (
    <button class="flex items-center gap-1.5 rounded-full px-2.5 py-2 text-sm font-medium text-ink-2 hover:bg-sunken active:bg-sunken" onClick={props.onClick}>
      {props.icon}
      {props.label}
    </button>
  );
}

function DraftView(props: { draft: Intake; onDone: () => void; onChange: (i: Intake) => void }) {
  const d = props.draft;
  const open = d.status === 'in-progress';
  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-baseline justify-between">
        <h3 class="display text-lg font-semibold">{MEAL_LABEL[d.meal_type]}</h3>
        <span class="text-sm text-ink-2">
          <span class="num text-ink">{kcal(d.totals.ENERC_KCAL)}</span> kcal · <span class="text-sage">{Math.round(d.totals.PROCNT ?? 0)} g protein</span>
        </span>
      </div>
      {d.raw_input_text && d.source === 'voice' && <p class="display text-ink-2 italic">“{d.raw_input_text}”</p>}
      <ul class="card divide-y divide-line">
        {d.items.map((it) => (
          <li class="flex items-center justify-between px-4 py-2.5 text-sm">
            <span class="min-w-0 truncate">
              {it.display_name}
              <span class="ml-1 text-faint">· {weight(it.grams)}</span>
            </span>
            <span class="num text-ink-2">{kcal(it.nutrients.ENERC_KCAL)}</span>
          </li>
        ))}
      </ul>
      {open ? (
        <Questions intake={d} onDone={(i) => (props.onChange(i), props.onDone())} />
      ) : (
        <button class="btn-primary w-full py-3" onClick={props.onDone}>
          Done
        </button>
      )}
    </div>
  );
}
