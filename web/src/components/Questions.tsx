import { useState } from 'preact/hooks';
import { api, type Intake, type Question } from '../api';

/** Tap-to-answer clarifying questions. Defaults are preselected; Skip accepts them all. */
export function Questions(props: { intake: Intake; onDone: (i: Intake) => void }) {
  const qs: Question[] = props.intake.pending?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(skip: boolean) {
    setBusy(true);
    setErr(null);
    try {
      props.onDone(await api.post<Intake>(`/intake/${props.intake.id}/answers`, { answers: skip ? {} : answers }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!qs.length) return null;
  return (
    <div class="flex flex-col gap-4 rounded-xl bg-brand-50 p-3 dark:bg-slate-800/60">
      {qs.map((q) => {
        const chosen = answers[q.id] ?? q.default;
        return (
          <div>
            <p class="mb-2 text-sm font-medium">
              {q.text}
              <span class="ml-1 text-xs font-normal text-slate-500">({props.intake.items[q.item_index]?.display_name})</span>
            </p>
            <div class="flex flex-wrap gap-2">
              {q.options.map((o) => (
                <button class={o === chosen ? 'chip-on' : 'chip bg-white dark:bg-slate-900'} onClick={() => setAnswers({ ...answers, [q.id]: o })}>
                  {o}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {err && <p class="text-sm text-rose-600">{err}</p>}
      <div class="flex gap-2">
        <button class="btn-primary flex-1" disabled={busy} onClick={() => submit(false)}>
          {busy ? 'Saving…' : 'Done'}
        </button>
        <button class="btn-ghost" disabled={busy} onClick={() => submit(true)}>
          Skip
        </button>
      </div>
    </div>
  );
}
