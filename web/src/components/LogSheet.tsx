import { useRef, useState } from 'preact/hooks';
import { api, type Intake, type MealType } from '../api';
import { MEALS, MEAL_LABEL, kcal } from '../format';
import { resizeImage } from '../image';
import { AddFood, occurrenceFor } from './AddFood';
import { Questions } from './Questions';
import { Recorder } from './Recorder';

type Mode = 'describe' | 'voice' | 'photo' | 'search';

const MODE_LABEL: Record<Mode, string> = { describe: 'Describe', voice: 'Voice', photo: 'Photo', search: 'Search' };
const AUDIO_EXT: Record<string, string> = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };

/** Log a meal by describing it, photographing it, or searching the food database. */
export function LogSheet(props: { date: string; defaultMeal: MealType; onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('describe');
  const [text, setText] = useState('');
  const [meal, setMeal] = useState<MealType | null>(null);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [clip, setClip] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Intake | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit() {
    const f = new FormData();
    if (mode === 'voice') {
      if (!clip) return;
      f.append('audio', clip, `voice.${AUDIO_EXT[clip.type] ?? 'm4a'}`);
    } else if (mode === 'photo') {
      if (!photo) return;
      f.append('photo', photo.blob, 'meal.jpg');
      if (text.trim()) f.append('text', text.trim());
    } else {
      if (!text.trim()) return;
      f.append('text', text.trim());
    }
    f.append('meal_type', meal ?? props.defaultMeal);
    const at = occurrenceFor(props.date);
    if (at) f.append('occurrence_at', at);
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<Intake>('/intake', f);
      setDraft(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const blob = await resizeImage(file);
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto({ blob, url: URL.createObjectURL(blob) });
  }

  if (draft) return <DraftView draft={draft} onDone={props.onDone} onChange={setDraft} />;

  return (
    <div class="flex flex-col gap-4">
      <div class="grid grid-cols-4 rounded-xl bg-slate-100 p-1 text-sm dark:bg-slate-800">
        {(['describe', 'voice', 'photo', 'search'] as Mode[]).map((m) => (
          <button
            class={`rounded-lg py-1.5 font-medium ${mode === m ? 'bg-white shadow-sm dark:bg-slate-900' : 'text-slate-500'}`}
            onClick={() => (setMode(m), setErr(null))}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {mode === 'search' ? (
        <AddFood date={props.date} defaultMeal={props.defaultMeal} onDone={props.onDone} />
      ) : (
        <>
          {mode === 'photo' && (
            <>
              <input ref={fileRef} type="file" accept="image/*" capture="environment" class="hidden" onChange={onFile} />
              {photo ? (
                <button onClick={() => fileRef.current?.click()} class="overflow-hidden rounded-xl">
                  <img src={photo.url} alt="Meal photo" class="max-h-64 w-full object-cover" />
                </button>
              ) : (
                <button
                  class="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 text-slate-500 dark:border-slate-700"
                  onClick={() => fileRef.current?.click()}
                >
                  <span class="text-3xl">📷</span>
                  <span class="text-sm">Take or choose a photo</span>
                </button>
              )}
            </>
          )}
          {mode === 'voice' && <Recorder onClip={setClip} />}
          {mode !== 'voice' && (
          <textarea
            class="input min-h-24 resize-none"
            placeholder={mode === 'photo' ? 'Optional note (e.g. "half the rice")' : 'e.g. two eggs scrambled, toast with butter, black coffee'}
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            enterkeyhint="send"
          />
          )}
          <div class="flex flex-wrap gap-2">
            {MEALS.map((m) => (
              <button class={m === (meal ?? props.defaultMeal) ? 'chip-on' : 'chip'} onClick={() => setMeal(m)}>
                {MEAL_LABEL[m]}
              </button>
            ))}
          </div>
          {err && <p class="text-sm text-rose-600">{err}</p>}
          <button class="btn-primary w-full py-3" disabled={busy || (mode === 'photo' ? !photo : mode === 'voice' ? !clip : !text.trim())} onClick={submit}>
            {busy ? 'Reading your meal…' : 'Log meal'}
          </button>
        </>
      )}
    </div>
  );
}

function DraftView(props: { draft: Intake; onDone: () => void; onChange: (i: Intake) => void }) {
  const d = props.draft;
  const open = d.status === 'in-progress';
  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-baseline justify-between">
        <h3 class="font-semibold">{MEAL_LABEL[d.meal_type]}</h3>
        <span class="text-sm tabular-nums text-slate-500">
          {kcal(d.totals.ENERC_KCAL)} kcal · {Math.round(d.totals.PROCNT ?? 0)} g protein
        </span>
      </div>
      {d.raw_input_text && d.source === 'voice' && <p class="text-sm text-slate-500 italic">“{d.raw_input_text}”</p>}
      <ul class="divide-y divide-slate-100 dark:divide-slate-800">
        {d.items.map((it) => (
          <li class="flex items-center justify-between py-2 text-sm">
            <span class="min-w-0 truncate">
              {it.display_name}
              {it.estimated && <span class="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">estimated</span>}
              <span class="ml-1 text-slate-500">· {Math.round(it.grams)} g</span>
            </span>
            <span class="tabular-nums text-slate-600 dark:text-slate-300">{kcal(it.nutrients.ENERC_KCAL)}</span>
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
