import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';

interface Data {
  entries: { id: string; value: number; effective_at: string; log_date: string }[];
  trend: { date: string; kg: number; trend: number }[];
}

const LB = 0.45359237;

export function Weight(props: { unit: 'kg' | 'lb' }) {
  const [data, setData] = useState<Data | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const show = (kg: number) => (props.unit === 'lb' ? kg / LB : kg);
  const fmtW = (kg: number) => `${show(kg).toFixed(1)} ${props.unit}`;

  const load = () => api.get<Data>('/weight').then(setData, (e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  async function add() {
    const v = Number(value);
    if (!(v > 0)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post('/weight', { value: v, unit: props.unit });
      setValue('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this weigh-in?')) return;
    await api.del(`/weight/${id}`);
    load();
  }

  const t = data?.trend ?? [];
  const latest = t[t.length - 1];
  const weekAgo = t.filter((p) => latest && Date.parse(latest.date) - Date.parse(p.date) >= 6 * 86400000).pop();
  const change = latest && weekAgo ? show(latest.trend) - show(weekAgo.trend) : null;

  return (
    <div class="flex flex-col gap-4">
      <h1 class="text-2xl font-bold">Weight</h1>
      <section class="card flex gap-2 p-4">
        <input
          class="input text-lg tabular-nums"
          type="number"
          inputMode="decimal"
          step="0.1"
          placeholder={`Today's weight (${props.unit})`}
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        <button class="btn-primary shrink-0" disabled={busy || !(Number(value) > 0)} onClick={add}>
          Log
        </button>
      </section>
      {err && <p class="text-sm text-rose-600">{err}</p>}
      {latest && (
        <section class="card p-5">
          <p class="text-sm text-slate-500">Trend weight</p>
          <div class="flex items-baseline gap-3">
            <span class="text-4xl font-bold tabular-nums">{show(latest.trend).toFixed(1)}</span>
            <span class="text-slate-500">{props.unit}</span>
            {change != null && (
              <span class={`text-sm font-medium ${change <= 0 ? 'text-emerald-600' : 'text-amber-600'}`}>
                {change > 0 ? '+' : ''}
                {change.toFixed(1)} this week
              </span>
            )}
          </div>
          <Chart trend={t} show={show} />
          <p class="mt-2 text-xs text-slate-500">Dots are daily weigh-ins; the line is a 7-day moving average. Daily swings are mostly water.</p>
        </section>
      )}
      {data && data.entries.length > 0 && (
        <section class="card divide-y divide-slate-100 dark:divide-slate-800">
          {[...data.entries].reverse().slice(0, 14).map((e) => (
            <div class="flex items-center justify-between px-4 py-2.5 text-sm">
              <span>{new Date(e.effective_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              <span class="flex items-center gap-3 tabular-nums">
                {fmtW(e.value)}
                <button class="text-slate-400 hover:text-rose-600" onClick={() => remove(e.id)} aria-label="Delete weigh-in">
                  ✕
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
      {data && data.entries.length === 0 && <p class="py-6 text-center text-sm text-slate-500">Weigh in a few mornings a week to see your trend.</p>}
    </div>
  );
}

function Chart(props: { trend: Data['trend']; show: (kg: number) => number }) {
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
  return (
    <svg viewBox={`0 0 ${W} ${H}`} class="mt-3 w-full" role="img" aria-label="Weight trend">
      {pts.map((p, i) => (
        <circle cx={x(xs[i]!)} cy={y(props.show(p.kg))} r="2.5" class="fill-slate-400" />
      ))}
      <path d={line} fill="none" stroke-width="2.5" class="stroke-brand-600" stroke-linejoin="round" />
    </svg>
  );
}
