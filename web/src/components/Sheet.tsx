import { X } from 'lucide-preact';
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
      <div class="absolute inset-0 bg-[#1e211d]/45 backdrop-blur-[3px]" onClick={props.onClose} />
      <div class="safe-bottom toast-in relative flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-[1.75rem] bg-paper shadow-2xl sm:rounded-[1.75rem]">
        <div class="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line" aria-hidden="true" />
        <div class="flex items-center justify-between px-5 pt-2 pb-2">
          <h2 class="display text-[1.4rem] font-semibold">{props.title}</h2>
          <button class="icon-btn -mr-2" onClick={props.onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div class="overflow-y-auto px-5 pb-5">{props.children}</div>
      </div>
    </div>
  );
}
