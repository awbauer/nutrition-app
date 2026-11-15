/**
 * App-wide toasts. Status messages float over the page instead of being inserted into
 * the layout, so nothing reflows when they appear or go away.
 *
 *   toast.success('Saved')
 *   toast.error(e)                                     // Error or string
 *   toast.show({ id: 'sync', message: '2 meals waiting', sticky: true, action: { label: 'Retry', onClick } })
 *   toast.dismiss('sync')
 *
 * Passing an `id` replaces an existing toast with that id, which is how progress
 * toasts turn into success/error toasts without stacking.
 */
export type Tone = 'info' | 'success' | 'error' | 'progress';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface Toast {
  id: string;
  message: string;
  tone: Tone;
  action?: ToastAction;
  /** Sticky toasts stay until dismissed or replaced (progress toasts are always sticky). */
  sticky?: boolean;
  /** Show a close button (default: sticky non-progress toasts). */
  dismissible?: boolean;
  onDismiss?: () => void;
}

const MAX_VISIBLE = 3;
const DURATION: Record<Tone, number> = { info: 3500, success: 3000, error: 6000, progress: 0 };

let toasts: Toast[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<(t: Toast[]) => void>();
let seq = 0;

const emit = () => listeners.forEach((f) => f(toasts));

export function subscribe(fn: (t: Toast[]) => void): () => void {
  listeners.add(fn);
  fn(toasts);
  return () => listeners.delete(fn);
}

function show(t: Omit<Toast, 'id' | 'tone'> & { id?: string; tone?: Tone }): string {
  const id = t.id ?? `t${++seq}`;
  const tone = t.tone ?? 'info';
  const next: Toast = { ...t, id, tone };
  clearTimeout(timers.get(id));
  timers.delete(id);
  const i = toasts.findIndex((x) => x.id === id);
  toasts = i >= 0 ? toasts.map((x) => (x.id === id ? next : x)) : [...toasts, next].slice(-MAX_VISIBLE);
  if (!t.sticky && tone !== 'progress') timers.set(id, setTimeout(() => dismiss(id, false), DURATION[tone]));
  emit();
  return id;
}

function dismiss(id: string, byUser = true): void {
  const t = toasts.find((x) => x.id === id);
  if (!t) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts = toasts.filter((x) => x.id !== id);
  if (byUser) t.onDismiss?.();
  emit();
}

const text = (m: unknown) => (m instanceof Error ? m.message : String(m));

export const toast = {
  show,
  dismiss,
  info: (m: string, o: Partial<Toast> = {}) => show({ ...o, message: m, tone: 'info' }),
  success: (m: string, o: Partial<Toast> = {}) => show({ ...o, message: m, tone: 'success' }),
  error: (m: unknown, o: Partial<Toast> = {}) => show({ ...o, message: text(m), tone: 'error' }),
  progress: (m: string, o: Partial<Toast> = {}) => show({ ...o, message: m, tone: 'progress', sticky: true }),
};
