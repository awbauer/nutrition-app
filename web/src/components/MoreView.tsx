import { ChevronRight, Settings2, Waypoints } from 'lucide-preact';

/** Phone: the fifth tab. Pages that don't fit in the bottom bar live here. */
export function MoreView(props: { onOpen: (tab: 'graph' | 'settings') => void }) {
  const rows: { tab: 'graph' | 'settings'; title: string; sub: string; icon: preact.ComponentChildren }[] = [
    { tab: 'graph', title: 'Food graph', sub: 'How the foods you eat connect', icon: <Waypoints size={20} strokeWidth={1.75} /> },
    { tab: 'settings', title: 'Settings', sub: 'Targets, reminders, units and export', icon: <Settings2 size={20} strokeWidth={1.75} /> },
  ];
  return (
    <div class="flex flex-col gap-4">
      <header class="pt-4">
        <h1 class="display text-[2.1rem] leading-none font-semibold">More</h1>
      </header>
      <ul class="card divide-y divide-line">
        {rows.map((r) => (
          <li>
            <button class="flex w-full items-center gap-3 px-4 py-3.5 text-left" onClick={() => props.onOpen(r.tab)}>
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sunken text-ink-2">{r.icon}</span>
              <span class="min-w-0 flex-1">
                <span class="block font-medium">{r.title}</span>
                <span class="block text-xs text-ink-2">{r.sub}</span>
              </span>
              <ChevronRight size={18} class="text-faint" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
