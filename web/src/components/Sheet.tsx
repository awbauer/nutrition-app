import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { holdUpdates } from '../update';

export function Sheet(props: { open: boolean; onClose: () => void; title: string; children: ComponentChildren }) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const release = holdUpdates(); // don't reload under an open sheet
    return () => {
      release();
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [props.open]);
  if (!props.open) return null;
  return (
    <div class="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={props.title}>
      <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={props.onClose} />
      <div class="safe-bottom relative flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-3xl bg-white shadow-xl sm:rounded-3xl dark:bg-slate-900">
        <div class="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 class="text-lg font-semibold">{props.title}</h2>
          <button class="rounded-full p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div class="overflow-y-auto px-5 pb-4">{props.children}</div>
      </div>
    </div>
  );
}
