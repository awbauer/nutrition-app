import { CheckCircle2, ChevronRight, Eye, RefreshCw, Sparkles } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { dayLabel, kcal } from '../format';
import { toast } from '../toast';
import { Sheet } from './Sheet';

interface PeriodStats {
  from: string;
  to: string;
  days: number;
  days_logged: number;
  days_probably_incomplete: number;
  avg: Record<string, number>;
  days_within_10pct_kcal: number;
  days_protein_target_met: number;
  meals_per_logged_day: number;
  pct_items_ai_estimate: number;
  meals_waiting_on_answers: number;
  median_log_delay_min: number | null;
}
interface Digest {
  reviewed_date: string;
  partial: boolean;
  targets: Record<string, number>;
  day: PeriodStats;
  week: PeriodStats;
  previous_week: PeriodStats;
  month: PeriodStats;
  weight: { unit: string; trend_now: number | null; trend_change_week: number | null; trend_change_month: number | null } | null;
  logging_score: number;
}
interface Report {
  headline: string;
  summary: string;
  periods: { day: string[]; week: string[]; month: string[] };
  wins: string[];
  watch: string[];
  coaching: { title: string; detail: string }[];
  logging: { summary: string; tips: string[] };
}
interface Stored {
  log_date: string;
  partial: boolean;
  status: 'pending' | 'ready' | 'failed';
  created_at: string;
  digest: Digest | null;
  report: Report | null;
  error: string | null;
}
interface ListItem {
  log_date: string;
  partial: boolean;
  status: string;
  headline: string | null;
}

export function CoachView() {
  const [data, setData] = useState<{ today: string; latest: Stored | null; reports: ListItem[] } | null>(null);
  const [shown, setShown] = useState<Stored | null>(null);
  const [running, setRunning] = useState(false);
  const [past, setPast] = useState<Stored | null>(null);

  const load = () =>
    api.get<{ today: string; latest: Stored | null; reports: ListItem[] }>('/coach').then((d) => {
      setData(d);
      setShown(d.latest);
    }, toast.error);
  useEffect(() => {
    load();
  }, []);

  async function run() {
    setRunning(true);
    try {
      const r = await api.post<Stored>('/coach/run');
      if (r.status === 'failed') toast.error("The coach couldn't write a report just now. Try again in a minute.");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError && e.status === 409 ? 'A report is already being written.' : e);
    } finally {
      setRunning(false);
    }
  }

  const label = (s: { log_date: string; partial: boolean }) => (s.partial ? 'Today so far' : data ? dayLabel(s.log_date, data.today) : s.log_date);

  return (
    <div class="flex flex-col gap-4">
      <header class="flex items-end justify-between gap-3 pt-2">
        <div>
          <p class="eyebrow">Insights & coaching</p>
          <h1 class="display mt-0.5 text-[2.1rem] leading-none font-semibold">Coach</h1>
        </div>
        <button class="btn-ghost shrink-0 px-3.5 py-2 text-sm" onClick={run} disabled={running || !data}>
          <RefreshCw size={16} class={running ? 'animate-spin' : ''} /> {running ? 'Thinking…' : 'Update now'}
        </button>
      </header>

      {!data && <div class="card h-56 animate-pulse" />}
      {data && !shown && (
        <div class="card flex flex-col items-center gap-3 px-6 py-10 text-center">
          <Sparkles size={40} strokeWidth={1.5} class="text-faint" aria-hidden="true" />
          <p class="display text-xl font-semibold">Your first report is on its way</p>
          <p class="max-w-[20rem] text-sm text-ink-2">
            Every morning after 4 am the coach looks back at your last day, week and month: what you ate, your targets, your weight and how well you're logging. Or get one for
            today so far.
          </p>
          <button class="btn-primary mt-1" onClick={run} disabled={running}>
            {running ? 'Thinking…' : 'Get insights now'}
          </button>
        </div>
      )}
      {shown && <ReportView stored={shown} label={label(shown)} />}

      {data && data.reports.filter((r) => r.log_date !== shown?.log_date && r.status === 'ready').length > 0 && (
        <section class="flex flex-col gap-2">
          <p class="eyebrow">Earlier reports</p>
          <ul class="card divide-y divide-line">
            {data.reports
              .filter((r) => r.log_date !== shown?.log_date && r.status === 'ready')
              .map((r) => (
                <li>
                  <button class="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={() => api.get<Stored>(`/coach/${r.log_date}`).then(setPast, toast.error)}>
                    <span class="min-w-0 flex-1">
                      <span class="block text-xs font-medium text-ink-2">{label(r)}</span>
                      <span class="block truncate text-sm">{r.headline}</span>
                    </span>
                    <ChevronRight size={18} class="text-faint" aria-hidden="true" />
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}
      <Sheet open={!!past} onClose={() => setPast(null)} title={past ? label(past) : 'Report'}>
        {past && <ReportView stored={past} label={label(past)} compact />}
      </Sheet>
    </div>
  );
}

function ReportView(props: { stored: Stored; label: string; compact?: boolean }) {
  const { report: r, digest: d, status } = props.stored;
  if (status === 'pending') return <div class="card h-56 animate-pulse" aria-label="Writing your report" />;
  if (status === 'failed' || !r || !d)
    return <p class="card p-4 text-sm text-ink-2">The report for {props.label.toLowerCase()} couldn't be written. Tap Update now to try again.</p>;
  return (
    <div class="flex flex-col gap-4">
      <section class={props.compact ? 'flex flex-col gap-2' : 'card flex flex-col gap-2 p-5'}>
        {!props.compact && <p class="eyebrow">{props.label}</p>}
        <h2 class="display text-2xl leading-tight font-semibold">{r.headline}</h2>
        <p class="text-[0.95rem] text-ink-2">{r.summary}</p>
      </section>

      <Numbers d={d} />

      {r.coaching.length > 0 && (
        <section class="flex flex-col gap-2">
          <p class="eyebrow">Coaching</p>
          <ol class="grid gap-2 md:grid-cols-3">
            {r.coaching.map((c, i) => (
              <li class="card flex gap-3 p-4">
                <span class="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-ink">{i + 1}</span>
                <div>
                  <p class="font-semibold">{c.title}</p>
                  <p class="mt-0.5 text-sm text-ink-2">{c.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div class="grid gap-3 md:grid-cols-2">
        {r.wins.length > 0 && <List title="Going well" items={r.wins} icon={<CheckCircle2 size={16} class="text-sage" />} />}
        {r.watch.length > 0 && <List title="Keep an eye on" items={r.watch} icon={<Eye size={16} class="text-mustard" />} />}
      </div>

      <div class="grid gap-3 md:grid-cols-3">
        <Period title={props.stored.partial ? 'So far today' : 'The day'} items={r.periods.day} />
        <Period title="Last 7 days" items={r.periods.week} />
        <Period title="Last 30 days" items={r.periods.month} />
      </div>

      <section class="card flex gap-4 p-4">
        <Score value={d.logging_score} />
        <div class="min-w-0">
          <p class="eyebrow">How you're logging</p>
          <p class="mt-1 text-sm">{r.logging.summary}</p>
          {r.logging.tips.length > 0 && (
            <ul class="mt-2 flex list-disc flex-col gap-1 pl-4 text-sm text-ink-2">
              {r.logging.tips.map((t) => (
                <li>{t}</li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <Accuracy />
    </div>
  );
}

interface Quality {
  days: number;
  ai_items: number;
  pct_swapped: number;
  pct_amount_changed: number;
  pct_removed: number;
  pct_any_fix: number;
  items_added_after_ai: number;
  searches: number;
  top_swaps: { name: string; from: string; to: string; times: number }[];
}

/** How often the AI's items needed fixing, from the change log. */
function Accuracy() {
  const [q, setQ] = useState<Quality | null>(null);
  useEffect(() => {
    api
      .get<Quality>('/coach/quality?days=30')
      .then(setQ)
      .catch(() => setQ(null));
  }, []);
  if (!q || q.ai_items === 0) return null;
  const tiles = [
    { label: 'Kept as logged', value: `${100 - q.pct_any_fix}%` },
    { label: 'Food swapped', value: `${q.pct_swapped}%` },
    { label: 'Amount changed', value: `${q.pct_amount_changed}%` },
    { label: 'Searches', value: String(q.searches) },
  ];
  return (
    <section class="card p-4">
      <p class="eyebrow">AI logging accuracy · last {q.days} days</p>
      <p class="mt-1 text-sm text-ink-2">
        {q.ai_items} items logged by the AI{q.items_added_after_ai ? `, ${q.items_added_after_ai} added by hand after` : ''}.
      </p>
      <div class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        {tiles.map((t) => (
          <div class="rounded-xl bg-sunken px-3 py-2">
            <p class="text-lg font-semibold tabular-nums">{t.value}</p>
            <p class="text-xs text-ink-2">{t.label}</p>
          </div>
        ))}
      </div>
      {q.top_swaps.length > 0 && (
        <div class="mt-3">
          <p class="text-xs font-medium text-ink-2">Most common fixes</p>
          <ul class="mt-1 flex flex-col gap-1 text-sm">
            {q.top_swaps.slice(0, 5).map((s) => (
              <li>
                {s.name}: {s.from} → {s.to}
                {s.times > 1 ? ` (${s.times}×)` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The week's numbers as tiles: these come straight from the log, not from the model. */
function Numbers({ d }: { d: Digest }) {
  const w = d.week;
  const kT = d.targets.ENERC_KCAL;
  const pT = d.targets.PROCNT;
  const tiles: { label: string; value: string; sub: string }[] = [
    { label: 'Calories / day', value: kcal(w.avg.ENERC_KCAL), sub: kT ? `target ${kcal(kT)}` : 'no target set' },
    { label: 'Protein / day', value: `${Math.round(w.avg.PROCNT ?? 0)} g`, sub: pT ? `target ${Math.round(pT)} g` : 'no target set' },
    { label: 'Days logged', value: `${w.days_logged} of 7`, sub: `${d.previous_week.days_logged} the week before` },
  ];
  if (d.weight?.trend_now != null)
    tiles.push({
      label: 'Weight trend',
      value: `${d.weight.trend_now} ${d.weight.unit}`,
      sub: d.weight.trend_change_week != null ? `${d.weight.trend_change_week > 0 ? '+' : ''}${d.weight.trend_change_week} this week` : '',
    });
  return (
    <section class="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="This week">
      {tiles.map((t) => (
        <div class="card px-4 py-3">
          <p class="text-xs text-ink-2">{t.label}</p>
          <p class="num mt-0.5 text-xl font-semibold">{t.value}</p>
          <p class="text-xs text-faint">{t.sub}</p>
        </div>
      ))}
    </section>
  );
}

function Period(props: { title: string; items: string[] }) {
  if (!props.items.length) return null;
  return (
    <section class="card flex flex-col gap-2 p-4">
      <p class="eyebrow">{props.title}</p>
      <ul class="flex flex-col gap-1.5 text-sm">
        {props.items.map((t) => (
          <li class="flex gap-2">
            <span class="mt-2 h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden="true" />
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function List(props: { title: string; items: string[]; icon: preact.ComponentChildren }) {
  return (
    <section class="card flex flex-col gap-2 p-4">
      <p class="eyebrow">{props.title}</p>
      <ul class="flex flex-col gap-2 text-sm">
        {props.items.map((t) => (
          <li class="flex gap-2">
            <span class="mt-0.5 shrink-0">{props.icon}</span>
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Score({ value }: { value: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const color = value >= 75 ? 'var(--sage)' : value >= 50 ? 'var(--mustard)' : 'var(--berry)';
  return (
    <div class="relative h-14 w-14 shrink-0" role="img" aria-label={`Logging score ${value} out of 100`}>
      <svg viewBox="0 0 56 56" class="h-14 w-14 -rotate-90">
        <circle cx="28" cy="28" r={r} fill="none" stroke="var(--sunken)" stroke-width="6" />
        <circle cx="28" cy="28" r={r} fill="none" stroke={color} stroke-width="6" stroke-linecap="round" stroke-dasharray={`${(value / 100) * c} ${c}`} />
      </svg>
      <span class="num absolute inset-0 flex items-center justify-center text-base font-semibold">{value}</span>
    </div>
  );
}
