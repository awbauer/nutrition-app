import { toast } from '../toast';
import { ChevronLeft, ChevronRight } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { addDays, kcal } from '../format';

interface Summary {
  start: string;
  end: string;
  days: { date: string; meals: number; totals: Record<string, number> }[];
  days_logged: number;
  average: Record<string, number>;
  targets: Record<string, number>;
  streak: number;
}

export function Week(props: { today: string }) {
  const [end, setEnd] = useState(props.today);
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => {
    setS(null);
    api.get<Summary>(`/summary?end=${end}`).then(setS, (e) => toast.error(e));
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
        <>
          <section class="card p-5">
            <p class="text-sm text-ink-2">Daily average · {s.days_logged} of 7 days logged</p>
            <div class="mt-1 flex items-baseline gap-2">
              <span class="num text-5xl font-semibold">{s.days_logged ? kcal(s.average.ENERC_KCAL) : '–'}</span>
              <span class="text-ink-2">kcal</span>
              {s.targets.ENERC_KCAL != null && s.days_logged > 0 && <Delta value={s.average.ENERC_KCAL ?? 0} target={s.targets.ENERC_KCAL} unit="kcal" />}
            </div>
            <div class="mt-3 grid grid-cols-3 gap-2 text-center">
              <Stat label="Protein / day" value={s.days_logged ? `${Math.round(s.average.PROCNT ?? 0)} g` : '–'} sub={s.targets.PROCNT ? `target ${Math.round(s.targets.PROCNT)} g` : undefined} />
              <Stat label="Target" value={s.targets.ENERC_KCAL ? kcal(s.targets.ENERC_KCAL) : '–'} sub="kcal / day" />
              <Stat label="Streak" value={`${s.streak}`} sub={s.streak === 1 ? 'day' : 'days'} />
            </div>
          </section>
          <section class="card p-4">
            <Bars days={s.days} target={s.targets.ENERC_KCAL} today={props.today} />
          </section>
          <p class="px-2 text-center text-xs text-ink-2">The weekly average is what matters. One big day is noise.</p>
        </>
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

function Bars(props: { days: Summary['days']; target?: number; today: string }) {
  const W = 320;
  const H = 160;
  const pad = 20;
  const max = Math.max(props.target ?? 0, ...props.days.map((d) => d.totals.ENERC_KCAL ?? 0), 1000) * 1.1;
  const bw = (W - 8) / 7;
  const y = (v: number) => H - pad - (v / max) * (H - pad - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} class="w-full" role="img" aria-label="Calories by day">
      {props.days.map((d, i) => {
        const v = d.totals.ENERC_KCAL ?? 0;
        const over = props.target != null && v > props.target * 1.05;
        return (
          <g>
            <rect
              x={4 + i * bw + 6}
              y={y(v)}
              width={bw - 12}
              height={Math.max(0, H - pad - y(v))}
              rx="4"
              class={d.meals === 0 ? 'fill-[var(--sunken)]' : over ? 'fill-[var(--berry)]' : 'fill-[var(--accent)]'}
            >
              <title>{`${d.date}: ${Math.round(v)} kcal`}</title>
            </rect>
            <text x={4 + i * bw + bw / 2} y={H - 5} text-anchor="middle" class={`fill-[var(--faint)] text-[10px] ${d.date === props.today ? 'font-bold' : ''}`}>
              {new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: 'narrow' })}
            </text>
          </g>
        );
      })}
      {props.target != null && (
        <g>
          <line x1="4" x2={W - 4} y1={y(props.target)} y2={y(props.target)} stroke-dasharray="4 4" class="stroke-[var(--faint)]" stroke-width="1.5" />
          <text x={6} y={y(props.target) - 5} text-anchor="start" class="fill-[var(--faint)] text-[10px]">
            target {Math.round(props.target).toLocaleString()}
          </text>
        </g>
      )}
    </svg>
  );
}
