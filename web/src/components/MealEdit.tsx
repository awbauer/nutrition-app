import { useState } from 'preact/hooks';
import { api, type Intake, type MealType } from '../api';
import { MEALS, MEAL_LABEL } from '../format';
import { toast } from '../toast';

/** `2026-11-15T12:30` in the device's local time, for <input type="datetime-local">. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** Edit a meal's time, type and note. */
export function MealEdit(props: { meal: Intake; onSaved: (m: Intake) => void }) {
  const [when, setWhen] = useState(toLocalInput(props.meal.occurrence_at));
  const [type, setType] = useState<MealType>(props.meal.meal_type);
  const [note, setNote] = useState(props.meal.note ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    const body: Record<string, unknown> = {};
    if (when !== toLocalInput(props.meal.occurrence_at)) {
      const d = new Date(when);
      if (Number.isNaN(d.getTime())) return toast.error('Enter a valid date and time');
      body.occurrence_at = d.toISOString();
    }
    if (type !== props.meal.meal_type) body.meal_type = type;
    if (note.trim() !== (props.meal.note ?? '')) body.note = note.trim() || null;
    if (!Object.keys(body).length) return props.onSaved(props.meal);
    setBusy(true);
    try {
      const m = await api.patch<Intake>(`/intake/${props.meal.id}`, body);
      toast.success(m.log_date !== props.meal.log_date ? `Moved to ${new Date(`${m.log_date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` : 'Meal updated');
      props.onSaved(m);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">When</span>
        <input class="input" type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} />
      </label>
      <div class="flex flex-col gap-1">
        <span class="text-sm font-medium">Meal</span>
        <div class="flex flex-wrap gap-2">
          {MEALS.map((m) => (
            <button class={m === type ? 'chip-on' : 'chip'} onClick={() => setType(m)}>
              {MEAL_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Note</span>
        <textarea
          class="input min-h-20 resize-none"
          maxLength={500}
          placeholder="Ate out, shared the dessert, felt hungry after…"
          value={note}
          onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <button class="btn-primary w-full py-3" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
