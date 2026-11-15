import { AlertCircle, Check, Info, X } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { subscribe, toast, type Toast } from '../toast';

const ICON: Record<Toast['tone'], preact.ComponentChildren> = {
  info: <Info size={16} />,
  success: <Check size={16} strokeWidth={2.5} />,
  error: <AlertCircle size={16} />,
  progress: null,
};
const ICON_CLASS: Record<Toast['tone'], string> = {
  info: 'bg-sunken text-ink-2',
  success: 'bg-sage text-white',
  error: 'bg-berry text-white',
  progress: '',
};

/** Fixed overlay at the top of the screen; never takes part in page layout. */
export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => subscribe(setItems), []);
  return (
    <div class="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-4" style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)' }} aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          class="toast-in pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[1.4rem] bg-ink py-2.5 pr-3 pl-3 text-sm text-paper shadow-xl"
        >
          {t.tone === 'progress' ? (
            <span class="inline-block h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
          ) : (
            <span class={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${ICON_CLASS[t.tone]}`} aria-hidden="true">
              {ICON[t.tone]}
            </span>
          )}
          <span class="min-w-0 flex-1 leading-snug">{t.message}</span>
          {t.action && (
            <button
              class="shrink-0 rounded-full bg-paper/15 px-3 py-1 font-semibold text-paper"
              onClick={async () => {
                toast.dismiss(t.id, false);
                await t.action!.onClick();
              }}
            >
              {t.action.label}
            </button>
          )}
          {(t.dismissible ?? (t.sticky && t.tone !== 'progress')) && (
            <button class="shrink-0 p-1 text-paper/60" onClick={() => toast.dismiss(t.id)} aria-label="Dismiss">
              <X size={16} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
