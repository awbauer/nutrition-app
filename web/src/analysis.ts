/**
 * Tracks meals the AI is still analyzing, wherever the user is in the app.
 * Shows a progress toast per meal, swaps it for a result toast when done,
 * and notifies listeners (Today) so they can refresh.
 */
import { api, type Intake } from './api';
import { kcal, MEAL_LABEL } from './format';
import { toast } from './toast';

const POLL_MS = 3000;
const watching = new Map<string, Intake>();
const listeners = new Set<(i: Intake) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

export const onIntakeSettled = (fn: (i: Intake) => void) => (listeners.add(fn), () => listeners.delete(fn));

const label = (i: Intake) => MEAL_LABEL[i.meal_type];
const toastId = (id: string) => `ai-${id}`;

function report(i: Intake) {
  const id = toastId(i.id);
  if (i.status === 'preparation' && !i.pending?.error) {
    toast.progress(i.source === 'voice' ? `Transcribing your ${label(i).toLowerCase()}…` : `Analyzing your ${label(i).toLowerCase()}…`, { id });
  } else if (i.status === 'preparation') {
    toast.error(`${label(i)}: ${i.pending!.error}`, { id, sticky: true, action: { label: 'Try again', onClick: () => retry(i.id) } });
  } else if (i.status === 'in-progress') {
    toast.info(`${label(i)} is ready. One quick question on Today.`, { id });
  } else if (i.status === 'completed') {
    toast.success(`${label(i)} logged · ${kcal(i.totals.ENERC_KCAL)} kcal`, { id });
  }
}

async function retry(id: string) {
  try {
    watch(await api.post<Intake>(`/intake/${id}/retry`));
  } catch (e) {
    toast.error(e, { id: toastId(id) });
  }
}

async function tick() {
  if (document.visibilityState !== 'visible') return;
  for (const [id] of watching) {
    try {
      const i = await api.get<Intake>(`/intake/${id}`);
      if (i.status === 'preparation' && !i.pending?.error) continue;
      watching.delete(id);
      report(i);
      listeners.forEach((f) => f(i));
    } catch {
      /* offline or transient; keep watching */
    }
  }
  if (!watching.size) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Start tracking a meal that is (or may be) still being analyzed. */
export function watch(i: Intake) {
  if (i.status !== 'preparation') return;
  report(i);
  if (i.pending?.error) return;
  watching.set(i.id, i);
  timer ??= setInterval(tick, POLL_MS);
}
