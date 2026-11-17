import { Scale, X } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { addDays } from '../format';
import { useRefreshOnReturn } from '../refresh';
import { toast } from '../toast';

interface Entry {
  id: string;
  value: number;
  effective_at: string;
  log_date: string;
}
interface Data {
  entries: Entry[];
  trend: { date: string; kg: number; trend: number }[];
}

const LB = 0.45359237;
type Unit = 'kg' | 'lb';

function useWeight(from: string, to: string) {
  const [data, setData] = useState<Data | null>(null);
  const load = () => api.get<Data>(`/weight?from=${from}&to=${to}`).then(setData, (e) => toast.error(e, { id: 'weight' }));
  useRefreshOnReturn(() => load());
  useEffect(() => {
    setData(null);
    load();
  }, [from, to]);
  return { data, load };
}

const units = (unit: Unit) => {
  const show = (kg: number) => (unit === 'lb' ? kg / LB : kg);
  return { show, fmt: (kg: number) => `${show(kg).toFixed(1)} ${unit}` };
};

/** Change in trend weight over the 7 days ending at `end` (in display units), when there's data for both ends. */
function weekChange(trend: Data['trend'], end: string, show: (kg: number) => number): number | null {
  const upTo = trend.filter((p) => p.date <= end);
  const last = upTo[upTo.length - 1];
  const before = upTo.filter((p) => p.date <= addDays(end, -7)).pop();
  return last && before ? show(last.trend) - show(before.trend) : null;
}

async function removeEntry(id: string, after: () => void) {
  if (!confirm('Delete this weigh-in?')) return;
  try {
    await api.del(`/weight/${id}`);
    after();
  } catch (e) {
    toast.error(e);
  }
}

/** Today: the day's weigh-in, or a box to log one, with the trend for context. */
export function WeighIn(props: { unit: Unit; date: string; today: string }) {
  const { data, load } = useWeight(addDays(props.date, -13), props.date);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const { show, fmt } = units(props.unit);
  const entry = data?.entries.filter((e) => e.log_date === props.date).pop();
  const trendNow = data?.trend.filter((p) => p.date <= props.date).pop();
  const change = data ? weekChange(data.trend, props.date, show) : null;

  async function add() {
    const v = Number(value);
    if (!(v > 0)) return;
    setBusy(true);
    try {
      // A past day gets a morning weigh-in on that day.
      const at = props.date === props.today ? undefined : new Date(`${props.date}T08:00:00`).toISOString();
      await api.post('/weight', {
        value: v,
        unit: props.unit,
        ...(at ? { effective_at: at } : {}),
      });
      setValue('');
      await load();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div class="card h-[4.5rem] animate-pulse" />;
  return (
    <section class="card flex flex-col gap-2 p-4" aria-label="Weight">
      <div class="flex items-center gap-3">
        <Scale size={18} class="shrink-0 text-ink-2" aria-hidden="true" />
        {entry ? (
          <>
            <p class="min-w-0 flex-1 text-sm">
              Weighed in at <span class="num text-base font-semibold">{fmt(entry.value)}</span>
            </p>
            <button class="icon-btn h-8 w-8 text-faint hover:text-berry" onClick={() => removeEntry(entry.id, load)} aria-label="Delete weigh-in">
              <X size={16} />
            </button>
          </>
        ) : (
          <>
            <input
              class="input min-w-0 flex-1 py-2 tabular-nums"
              type="number"
              inputMode="decimal"
              step="0.1"
              placeholder={`${props.date === props.today ? "Today's" : "That day's"} weight (${props.unit})`}
              value={value}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              aria-label={`Weight in ${props.unit}`}
            />
            <button class="btn-primary shrink-0 px-4 py-2" disabled={busy || !(Number(value) > 0)} onClick={add}>
              Log
            </button>
          </>
        )}
      </div>
      {trendNow && (
        <p class="pl-[1.875rem] text-xs text-ink-2">
          Trend <span class="num text-ink">{fmt(trendNow.trend)}</span>
          {change != null && (
            <span class={change <= 0 ? 'text-sage' : 'text-mustard'}>
              {' · '}
              {change > 0 ? '+' : ''}
              {change.toFixed(1)} this week
            </span>
          )}
        </p>
      )}
    </section>
  );
}

/** Week: trend weight over the last eight weeks, and the week's weigh-ins. */
export function WeightTrend(props: { unit: Unit; start: string; end: string }) {
  const { data, load } = useWeight(addDays(props.end, -55), props.end);
  const { show, fmt } = units(props.unit);
  if (!data) return <div class="card h-48 animate-pulse" />;
  const t = data.trend;
  const latest = t[t.length - 1];
  const change = weekChange(t, props.end, show);
  const week = data.entries.filter((e) => e.log_date >= props.start && e.log_date <= props.end).reverse();

  return (
    // Desktop: chart on the left, the week's weigh-ins beside it.
    <section class="card p-5 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-6" aria-label="Weight">
      <div>
        <p class="text-sm text-ink-2">Trend weight</p>
        {latest ? (
          <>
            <div class="mt-1 flex items-baseline gap-2">
              <span class="num text-5xl font-semibold">{show(latest.trend).toFixed(1)}</span>
              <span class="text-ink-2">{props.unit}</span>
              {change != null && (
                <span class={`text-sm font-medium ${change <= 0 ? 'text-sage' : 'text-mustard'}`}>
                  {change > 0 ? '+' : ''}
                  {change.toFixed(1)} this week
                </span>
              )}
            </div>
            <Chart trend={t} show={show} start={props.start} />
            <p class="mt-2 text-xs text-ink-2">Dots are weigh-ins; the line is the trend. This week is shaded. Daily swings are mostly water.</p>
          </>
        ) : (
          <p class="mt-1 text-sm text-ink-2">Weigh in a few mornings a week (on Today) to see your trend.</p>
        )}
      </div>
      {week.length > 0 && (
        <ul class="-mx-5 mt-3 divide-y divide-line border-t border-line lg:mx-0 lg:mt-0 lg:self-start lg:border-t-0">
          {week.map((e) => (
            <li class="flex items-center justify-between px-5 py-2 text-sm">
              <span>
                {new Date(e.effective_at).toLocaleDateString([], {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
              <span class="flex items-center gap-2 tabular-nums">
                {fmt(e.value)}
                <button class="icon-btn h-8 w-8 text-faint hover:text-berry" onClick={() => removeEntry(e.id, load)} aria-label="Delete weigh-in">
                  <X size={15} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Chart(props: { trend: Data['trend']; show: (kg: number) => number; start: string }) {
  const pts = props.trend;
  if (pts.length < 2) return null;
  const W = 320;
  const H = 140;
  const xs = pts.map((p) => Date.parse(p.date));
  const vals = pts.flatMap((p) => [props.show(p.kg), props.show(p.trend)]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [lo, hi] = [Math.min(...vals) - 0.5, Math.max(...vals) + 0.5];
  const x = (t: number) => 8 + ((t - x0) / Math.max(x1 - x0, 1)) * (W - 16);
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (H - 16);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(xs[i]!).toFixed(1)},${y(props.show(p.trend)).toFixed(1)}`).join(' ');
  const weekX = x(Math.max(x0, Date.parse(props.start)));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} class="mt-3 w-full" role="img" aria-label="Weight trend">
      {weekX < W - 8 && <rect x={weekX} y="0" width={W - 8 - weekX} height={H} rx="6" class="fill-[var(--sunken)]" />}
      {pts.map((p, i) => (
        <circle cx={x(xs[i]!)} cy={y(props.show(p.kg))} r="2.5" class="fill-[var(--faint)]" />
      ))}
      <path d={line} fill="none" stroke-width="2.5" class="stroke-[var(--accent)]" stroke-linejoin="round" />
    </svg>
  );
}
