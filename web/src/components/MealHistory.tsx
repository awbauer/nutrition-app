import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';

interface HistoryEvent {
  id: string;
  at: string;
  actor: 'app' | 'mcp' | 'ai' | 'system';
  kind: string;
  summary: string;
}

const WHO: Record<HistoryEvent['actor'], string> = { ai: 'AI', app: 'You', mcp: 'Claude', system: 'Clem' };
const FIX = new Set(['food_swapped', 'amount_changed', 'item_removed', 'item_added', 'searched']);

/** A meal's change log: what the AI logged and every change after. */
export function MealHistory(props: { mealId: string }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ events: HistoryEvent[] }>(`/intake/${props.mealId}/history`)
      .then((h) => setEvents(h.events))
      .catch((e: Error) => setError(e.message));
  }, [props.mealId]);
  if (error) return <p class="text-sm text-berry">{error}</p>;
  if (!events) return <p class="text-sm text-ink-2">Loading…</p>;
  if (!events.length) return <p class="text-sm text-ink-2">No changes recorded. Meals logged before the change log started have no history.</p>;
  const fixes = events.filter((e) => e.actor !== 'ai' && FIX.has(e.kind)).length;
  return (
    <div class="flex flex-col gap-3">
      <p class="text-sm text-ink-2">{fixes === 0 ? 'Logged as the AI had it, with no fixes.' : `${fixes} fix${fixes === 1 ? '' : 'es'} after the AI logged it.`}</p>
      <ol class="flex flex-col gap-2">
        {events.map((e) => (
          <li class="flex gap-3 text-sm">
            <span class="w-14 shrink-0 tabular-nums text-ink-2">{new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            <span class={`w-12 shrink-0 font-medium ${e.actor === 'ai' ? 'text-accent-ink' : 'text-ink'}`}>{WHO[e.actor]}</span>
            <span class="min-w-0 break-words">{e.summary}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
