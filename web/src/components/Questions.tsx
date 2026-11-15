import { toast } from '../toast';
import { useState } from 'preact/hooks';
import { api, type Intake, type Question } from '../api';

/** Tap-to-answer clarifying questions. Defaults are preselected; Skip accepts them all. */
export function Questions(props: { intake: Intake; onDone: (i: Intake) => void }) {
  const qs: Question[] = props.intake.pending?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(skip: boolean) {
    setBusy(true);
    try {
      props.onDone(await api.post<Intake>(`/intake/${props.intake.id}/answers`, { answers: skip ? {} : answers }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  if (!qs.length) return null;
  return (
    <div class="flex flex-col gap-4 rounded-2xl bg-accent-soft/60 p-4">
      {qs.map((q) => {
        const chosen = answers[q.id] ?? q.default;
        return (
          <div>
            <p class="mb-2 text-sm font-medium">
              {q.text}
              <span class="ml-1 text-xs font-normal text-ink-2">({props.intake.items[q.item_index]?.display_name})</span>
            </p>
            <div class="flex flex-wrap gap-2">
              {q.options.map((o) => (
                <button class={o === chosen ? 'chip-on' : 'chip bg-card'} onClick={() => setAnswers({ ...answers, [q.id]: o })}>
                  {o}
                </button>
              ))}
            </div>
          </div>
        );
      })}
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
