import { toast } from '../toast';
import { ChevronLeft, ChevronRight } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useRefreshOnReturn } from '../refresh';
import { api } from '../api';
import { addDays, kcal } from '../format';
import { WeightTrend } from './Weight';

interface Summary {
  start: string;
  end: string;
  days: { date: string; meals: number; totals: Record<string, number> }[];
  days_logged: number;
  /** Logged days before today: the ones the average is taken over. */
  days_counted: number;
  average: Record<string, number>;
  targets: Record<string, number>;
  streak: number;
}

export function Week(props: { today: string; weightUnit: 'kg' | 'lb' }) {
  const [end, setEnd] = useState(props.today);
  const [s, setS] = useState<Summary | null>(null);

  const load = () => api.get<Summary>(`/summary?end=${end}`).then(setS, (e) => toast.error(e));
  useRefreshOnReturn(() => load());
  useEffect(() => {
    setS(null);
    load();
  }, [end]);

  return (
    <div class="flex flex-col gap-4">
      <header class="flex items-end justify-between pt-2">
        <div>
          <p class="eyebrow">{s ? `${fmt(s.start)} – ${fmt(s.end)}` : '\u00a0'}</p>
          <h1 class="display mt-0.5 text-[2.1rem] leading-none font-semibold">{end === props.today ? 'This week' : 'That week'}</h1>
        </div>
        <div class="flex items-center gap-1">
          <button class="icon-btn" onClick={() => setEnd(addDays(end, -7))} aria-label="Previous week">
            <ChevronLeft size={22} />
          </button>
          <button class="icon-btn disabled:opacity-25" disabled={end >= props.today} onClick={() => setEnd(addDays(end, 7))} aria-label="Next week">
            <ChevronRight size={22} />
          </button>
        </div>
      </header>
      {!s ? (
        <div class="card h-64 animate-pulse" />
      ) : (
        // Desktop: summary and chart side by side.
        <div class="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:items-start lg:gap-6">
          <section class="card p-5">
            <p class="text-sm text-ink-2">
              Daily average · {s.days_counted} completed {s.days_counted === 1 ? 'day' : 'days'}
            </p>
            <div class="mt-1 flex items-baseline gap-2">
              <span class="num text-5xl font-semibold">{s.days_counted ? kcal(s.average.ENERC_KCAL) : '–'}</span>
              <span class="text-ink-2">kcal</span>
              {s.targets.ENERC_KCAL != null && s.days_counted > 0 && <Delta value={s.average.ENERC_KCAL ?? 0} target={s.targets.ENERC_KCAL} unit="kcal" />}
            </div>
            {s.end >= props.today && <p class="mt-1 text-xs text-faint">Today counts once it's over.</p>}
            <div class="mt-3 grid grid-cols-3 gap-2 text-center">
              <Stat label="Protein / day" value={s.days_counted ? `${Math.round(s.average.PROCNT ?? 0)} g` : '–'} sub={s.targets.PROCNT ? `target ${Math.round(s.targets.PROCNT)} g` : undefined} />
              <Stat label="Target" value={s.targets.ENERC_KCAL ? kcal(s.targets.ENERC_KCAL) : '–'} sub="kcal / day" />
              <Stat label="Streak" value={`${s.streak}`} sub={s.streak === 1 ? 'day' : 'days'} />
            </div>
          </section>
          <section class="card p-4">
            <Bars days={s.days} target={s.targets.ENERC_KCAL} today={props.today} />
          </section>
          <div class="lg:col-span-2">
            <WeightTrend unit={props.weightUnit} start={s.start} end={s.end} />
          </div>
          <p class="px-2 text-center text-xs text-ink-2 lg:col-span-2">The weekly average is what matters. One big day is noise.</p>
        </div>
      )}
    </div>
  );
}

const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });

function Delta(props: { value: number; target: number; unit: string }) {
  const d = Math.round(props.value - props.target);
  const near = Math.abs(d) <= props.target * 0.05;
  return (
    <span class={`text-sm font-medium ${near ? 'text-sage' : d > 0 ? 'text-mustard' : 'text-plum'}`}>
      {d > 0 ? '+' : ''}
      {d.toLocaleString()} vs target
    </span>
  );
}

function Stat(props: { label: string; value: string; sub?: string }) {
  return (
    <div class="rounded-xl bg-sunken p-2.5 ">
      <div class="text-xs text-ink-2">{props.label}</div>
      <div class="num text-xl font-semibold">{props.value}</div>
      {props.sub && <div class="text-[11px] text-ink-2">{props.sub}</div>}
    </div>
  );
}

/** Macro energy (Atwater 4/4/9 kcal per g) and colours, shared by the bars and the legend. */
const MACROS = [
  { code: 'PROCNT', label: 'Protein', kcalPerG: 4, color: 'var(--sage)' },
  { code: 'CHOCDF', label: 'Carbs', kcalPerG: 4, color: 'var(--mustard)' },
  { code: 'FAT', label: 'Fat', kcalPerG: 9, color: 'var(--plum)' },
] as const;

/** Split a day's energy into macro segments (plus "other"), scaled to its total kcal. */
function segments(totals: Record<string, number>) {
  const kcal = totals.ENERC_KCAL ?? 0;
  const parts = MACROS.map((m) => ({ ...m, kcal: (totals[m.code] ?? 0) * m.kcalPerG }));
  const sum = parts.reduce((a, p) => a + p.kcal, 0);
  // Macro kcal rarely add up exactly (fibre, alcohol, rounding): fit them to the day's total.
  const scale = sum > kcal && sum > 0 ? kcal / sum : 1;
  const out: { label: string; color: string; kcal: number }[] = parts.map((p) => ({ label: p.label, color: p.color, kcal: p.kcal * scale }));
  const other = Math.max(0, kcal - sum * scale);
  if (other > 1) out.push({ label: 'Other', color: 'var(--line)', kcal: other });
  return out;
}

function Bars(props: { days: Summary['days']; target?: number; today: string }) {
  // Draw at the container's real width so text stays 10px and bars widen on big screens.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W > 500 ? 260 : 190;
  const pad = 20;
  const top = 22;
  const max = Math.max(props.target ?? 0, ...props.days.map((d) => d.totals.ENERC_KCAL ?? 0), 1000) * 1.05;
  const bw = (W - 8) / 7;
  const barW = Math.min(bw - 14, 56);
  const y = (v: number) => H - pad - (v / max) * (H - pad - top);
  // Same days as the headline average: completed (before today) and logged.
  const logged = props.days.filter((d) => d.meals > 0 && d.date < props.today);
  const avg = MACROS.map((m) => {
    const g = logged.length ? logged.reduce((a, d) => a + (d.totals[m.code] ?? 0), 0) / logged.length : 0;
    return { ...m, g, kcal: g * m.kcalPerG };
  });
  const avgKcal = avg.reduce((a, m) => a + m.kcal, 0) || 1;

  return (
    <div class="flex flex-col gap-3" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} class="block max-w-full" role="img" aria-label="Calories by day, split by protein, carbs and fat">
        {props.target != null && (
          <g>
            <line x1="4" x2={W - 4} y1={y(props.target)} y2={y(props.target)} stroke-dasharray="4 4" class="stroke-[var(--faint)]" stroke-width="1.2" />
          </g>
        )}
        {props.days.map((d, i) => {
          const v = d.totals.ENERC_KCAL ?? 0;
          const over = props.target != null && v > props.target * 1.05;
          const w = barW;
          const x = 4 + i * bw + (bw - w) / 2;
          let acc = 0;
          return (
            <g>
              <title>{`${d.date}: ${Math.round(v)} kcal · protein ${Math.round(d.totals.PROCNT ?? 0)} g, carbs ${Math.round(d.totals.CHOCDF ?? 0)} g, fat ${Math.round(d.totals.FAT ?? 0)} g`}</title>
              {d.meals === 0 ? (
                <rect x={x} y={H - pad - 3} width={w} height={3} rx="1.5" class="fill-[var(--sunken)]" />
              ) : (
                <>
                  <clipPath id={`bar-${i}`}>
                    <rect x={x} y={y(v)} width={w} height={Math.max(0, H - pad - y(v))} rx="5" />
                  </clipPath>
                  <g clip-path={`url(#bar-${i})`}>
                    {segments(d.totals).map((sg) => {
                      const y0 = y(acc + sg.kcal);
                      const h = y(acc) - y0;
                      acc += sg.kcal;
                      return <rect x={x} y={y0} width={w} height={Math.max(0, h)} fill={sg.color} />;
                    })}
                  </g>
                  {/* A card-coloured halo keeps the total legible where it crosses the target line. */}
                  <text x={x + w / 2} y={y(v) - 5} text-anchor="middle" paint-order="stroke" stroke="var(--card)" stroke-width="4" stroke-linejoin="round" class={`num text-[10px] ${over ? 'fill-[var(--berry)] font-semibold' : 'fill-[var(--ink-2)]'}`}>
                    {Math.round(v).toLocaleString()}
                  </text>
                </>
              )}
              <text x={4 + i * bw + bw / 2} y={H - 5} text-anchor="middle" class={`text-[10px] ${d.date === props.today ? 'fill-[var(--ink)] font-bold' : 'fill-[var(--faint)]'}`}>
                {new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: 'narrow' })}
              </text>
            </g>
          );
        })}
      </svg>
      {logged.length > 0 && (
        <div class="grid grid-cols-3 gap-2 border-t border-line pt-3">
          {avg.map((m) => (
            <div>
              <p class="flex items-center gap-1.5 text-xs text-ink-2">
                <span class="h-2.5 w-2.5 rounded-sm" style={{ background: m.color }} aria-hidden="true" />
                {m.label}
              </p>
              <p class="mt-0.5">
                <span class="num text-lg font-semibold">{Math.round((m.kcal / avgKcal) * 100)}%</span>
                <span class="ml-1 text-xs text-faint">{Math.round(m.g)} g/day</span>
              </p>
            </div>
          ))}
          <p class="col-span-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
            {props.target != null && (
              <span class="flex items-center gap-1.5">
                <span class="w-4 border-t-[1.5px] border-dashed border-faint" aria-hidden="true" />
                Target {Math.round(props.target).toLocaleString()} kcal
              </span>
            )}
            <span class="flex items-center gap-1.5">
              <span class="h-2.5 w-2.5 rounded-sm bg-line" aria-hidden="true" />
              Other (fibre, alcohol, rounding)
            </span>
            <span>Red totals are over target.</span>
          </p>
        </div>
      )}
    </div>
  );
}
