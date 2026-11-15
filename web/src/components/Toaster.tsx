import { useEffect, useState } from 'preact/hooks';
import { subscribe, toast, type Toast } from '../toast';

const ICON: Record<Toast['tone'], string> = { info: 'ℹ', success: '✓', error: '!', progress: '' };
const ICON_CLASS: Record<Toast['tone'], string> = {
  info: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  success: 'bg-emerald-500 text-white',
  error: 'bg-rose-500 text-white',
  progress: '',
};

/** Fixed overlay at the top of the screen; never takes part in page layout. */
export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => subscribe(setItems), []);
  return (
    <div
      class="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-3"
      style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)' }}
      aria-live="polite"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          class="toast-in pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-white/95 px-4 py-3 text-sm shadow-lg ring-1 ring-slate-200 backdrop-blur dark:bg-slate-900/95 dark:ring-slate-700"
        >
          {t.tone === 'progress' ? (
            <span class="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" aria-hidden="true" />
          ) : (
            <span class={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${ICON_CLASS[t.tone]}`} aria-hidden="true">
              {ICON[t.tone]}
            </span>
          )}
          <span class="min-w-0 flex-1">{t.message}</span>
          {t.action && (
            <button
              class="shrink-0 font-semibold text-brand-700 dark:text-brand-500"
              onClick={async () => {
                toast.dismiss(t.id, false);
                await t.action!.onClick();
              }}
            >
              {t.action.label}
            </button>
          )}
          {(t.dismissible ?? (t.sticky && t.tone !== 'progress')) && (
            <button class="shrink-0 text-slate-400 hover:text-slate-600" onClick={() => toast.dismiss(t.id)} aria-label="Dismiss">
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
