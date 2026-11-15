import { ArrowUp, Camera, Mic, Plus, Search, X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { watch } from '../analysis';
import { api, type Intake, type MealType } from '../api';
import { amountLabel, kcal, MEALS, MEAL_LABEL } from '../format';
import { resizeImage } from '../image';
import { submitMeal } from '../queue';
import { toast } from '../toast';
import { AddFood, occurrenceFor, type QuickPick } from './AddFood';
import { Questions } from './Questions';
import { Recorder } from './Recorder';

const AUDIO_EXT: Record<string, string> = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };

/**
 * One composer for every way of logging: type it, attach a photo, or record it, then send.
 * Search is there for picking an exact food. With `target` (a meal's "Add to …") everything
 * goes into that meal; from the main button, breakfast/lunch/dinner join the day's existing
 * meal of that type and snacks are new.
 */
export function LogSheet(props: { date: string; defaultMeal: MealType; target?: Intake; onDone: () => void }) {
  const [view, setView] = useState<'compose' | 'record' | 'search'>('compose');
  const [text, setText] = useState('');
  const [meal, setMeal] = useState<MealType>(props.defaultMeal);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [clip, setClip] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Intake | null>(null);
  const [quickPick, setQuickPick] = useState<QuickPick | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);
  const mealFor = props.target?.meal_type ?? meal;

  const ready = !!(photo || clip || text.trim());

  async function submit() {
    if (!ready || busy) return;
    const f = new FormData();
    if (clip) f.append('audio', clip.blob, `voice.${AUDIO_EXT[clip.blob.type] ?? 'm4a'}`);
    else if (photo) f.append('photo', photo.blob, 'meal.jpg');
    if (text.trim() && !clip) f.append('text', text.trim());
    if (props.target) f.append('append_to', props.target.id);
    else {
      f.append('meal_type', meal);
      f.append('merge', '1');
      const at = occurrenceFor(props.date);
      if (at) f.append('occurrence_at', at);
    }
    setBusy(true);
    try {
      const r = await submitMeal('/intake', f);
      // Saved (or queued offline): the AI fills it in in the background and Today shows progress.
      if (r?.merged_from) {
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
    const file = input.files?.[0];
    input.value = ''; // so picking the same photo again still fires change
    if (!file) return;
    const blob = await resizeImage(file);
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto({ blob, url: URL.createObjectURL(blob) });
    setClip(null);
  }

  if (draft) return <DraftView draft={draft} onDone={props.onDone} onChange={setDraft} />;

  if (view === 'search')
    return (
      <div class="flex flex-col gap-3">
        <button class="self-start text-sm font-medium text-accent-ink" onClick={() => (setView('compose'), setQuickPick(undefined))}>
          ← Back
        </button>
        <AddFood date={props.date} defaultMeal={meal} intakeId={props.target?.id} initial={quickPick} onDone={props.onDone} />
      </div>
    );

  return (
    <div class="flex flex-col gap-4">
      {props.target ? (
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

      <input ref={fileRef} type="file" accept="image/*" class="hidden" onChange={onFile} />

      {view === 'record' ? (
        <div class="card p-4">
          <Recorder
            onClip={(b) => {
              setClip(b ? { blob: b, url: URL.createObjectURL(b) } : null);
              if (b) {
                setPhoto(null);
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
          {(photo || clip) && (
            <div class="flex items-center gap-3">
              {photo && <img src={photo.url} alt="Your photo" class="h-20 w-20 rounded-xl object-cover" />}
              {clip && <audio src={clip.url} controls class="h-10 min-w-0 flex-1" />}
              <button class="icon-btn ml-auto" onClick={() => (setPhoto(null), setClip(null))} aria-label="Remove attachment">
                <X size={18} />
              </button>
            </div>
          )}
          {!clip && (
            <textarea
              class="min-h-24 w-full resize-none bg-transparent px-1 text-[1.05rem] leading-relaxed outline-none placeholder:text-faint"
              placeholder={photo ? 'Anything to add? (optional, e.g. "half the rice")' : 'Two eggs, toast with butter, a flat white…'}
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit()}
              aria-label="What did you eat?"
              enterkeyhint="send"
            />
          )}
          <div class="flex items-center gap-1">
            <ToolButton onClick={() => fileRef.current?.click()} icon={<Camera size={19} />} label="Photo" />
            <ToolButton onClick={() => setView('record')} icon={<Mic size={19} />} label="Voice" />
            <ToolButton onClick={() => setView('search')} icon={<Search size={18} />} label="Search" />
            <button class="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-accent text-white transition active:scale-95 disabled:bg-sunken disabled:text-faint" disabled={!ready || busy} onClick={submit} aria-label="Log it">
              {busy ? <span class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> : <ArrowUp size={22} strokeWidth={2.5} />}
            </button>
          </div>
        </div>
      )}

      {view === 'compose' && !text && !photo && !clip && (
        <QuickAdd mealType={mealFor} onPick={(q) => (setQuickPick(q), setView('search'))} />
      )}

      <p class="text-center text-xs text-faint">
        Describe it however you like. The AI finds the foods, and nutrition comes from USDA and the package label.
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

/** Recent and frequent foods: tap one to log it again with the amount you used last time. */
function QuickAdd(props: { mealType: MealType; onPick: (q: QuickPick) => void }) {
  const [data, setData] = useState<{ recent: Quick[]; frequent: Quick[] } | null>(null);
  const [tab, setTab] = useState<'frequent' | 'recent'>('frequent');
  useEffect(() => {
    api.get<{ recent: Quick[]; frequent: Quick[] }>(`/foods/quick?meal_type=${props.mealType}`).then(
      (d) => {
        setData(d);
        if (!d.frequent.length) setTab('recent');
      },
      () => setData({ recent: [], frequent: [] }),
    );
  }, [props.mealType]);

  if (!data || (!data.recent.length && !data.frequent.length)) return null;
  const list = tab === 'frequent' ? data.frequent : data.recent;
  return (
    <section class="flex flex-col gap-2" aria-label="Quick add">
      <div class="flex items-center justify-between">
        <p class="eyebrow">Quick add</p>
        <div class="segmented w-48 text-xs" role="tablist">
          {data.frequent.length > 0 && (
            <button class="seg py-1 text-xs" role="tab" aria-pressed={tab === 'frequent'} aria-selected={tab === 'frequent'} onClick={() => setTab('frequent')}>
              Frequent
            </button>
          )}
          <button class="seg py-1 text-xs" role="tab" aria-pressed={tab === 'recent'} aria-selected={tab === 'recent'} onClick={() => setTab('recent')}>
            Recent
          </button>
        </div>
      </div>
      <ul class="card divide-y divide-line">
        {list.map((q) => (
          <li>
            <button class="flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-sunken" onClick={() => props.onPick(q)}>
              <div class="min-w-0 flex-1">
                <p class="truncate text-[0.95rem]">{q.name}</p>
                <p class="truncate text-xs text-faint">
                  {amountLabel(q.amount, q.unit)}
                  {tab === 'frequent' && ` · ${q.count}× lately`}
                </p>
              </div>
              {q.kcal != null && <span class="num text-ink-2">{kcal(q.kcal)}</span>}
              <span class="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent-ink" aria-hidden="true">
                <Plus size={16} />
              </span>
            </button>
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
              <span class="ml-1 text-faint">· {Math.round(it.grams)} g</span>
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
