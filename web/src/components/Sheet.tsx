import { X } from 'lucide-preact';
import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { holdUpdates } from '../update';

/**
 * The part of the screen the keyboard leaves visible. iOS (especially the home-screen app)
 * lays the keyboard over the page without resizing it, so a bottom sheet pinned to the
 * layout viewport ends up behind the keyboard. Following visualViewport keeps it above.
 */
function useVisibleArea(active: boolean) {
  const [area, setArea] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const update = () => setArea({ top: vv.offsetTop, height: vv.height });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return area;
}

export function Sheet(props: { open: boolean; onClose: () => void; title: string; children: ComponentChildren }) {
  const area = useVisibleArea(props.open);
  // Keep the focused field visible once the keyboard has finished opening.
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target as HTMLElement;
    if (el.matches('input, textarea, select, [contenteditable]')) setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 300);
  };
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
  // Rendered into <body> so no ancestor (an animated timeline row, a card) can trap the
  // fixed overlay. iOS Safari treats a transformed ancestor as the containing block.
  return createPortal(
    <div
      class="fixed inset-x-0 top-0 bottom-0 z-40 flex items-end justify-center sm:items-center"
      style={area ? { top: `${area.top}px`, height: `${area.height}px`, bottom: 'auto' } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      onFocusIn={onFocusIn}
    >
      <div class="absolute inset-0 bg-[#1e211d]/45 backdrop-blur-[3px]" onClick={props.onClose} />
      <div class="safe-bottom toast-in relative flex max-h-[92%] w-full max-w-lg flex-col rounded-t-[1.75rem] bg-paper shadow-2xl sm:max-h-[85%] sm:rounded-[1.75rem] sm:pt-3">
        <div class="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line sm:hidden" aria-hidden="true" />
        <div class="flex items-center justify-between px-5 pt-2 pb-2">
          <h2 class="display text-[1.4rem] font-semibold">{props.title}</h2>
          <button class="icon-btn -mr-2" onClick={props.onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div class="overflow-y-auto overscroll-contain px-5 pb-5">{props.children}</div>
      </div>
    </div>,
    document.body,
  );
}
