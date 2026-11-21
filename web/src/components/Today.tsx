import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { onIntakeSettled, watch } from '../analysis';
import { api, type Day, type HomeBlock, type Intake } from '../api';
import { addDays, dayLabel, guessMeal, MEAL_LABEL, time } from '../format';
import { onQueueChange } from '../queue';
import { toast } from '../toast';
import { useRefreshOnReturn } from '../refresh';
import { LogSheet } from './LogSheet';
import { MealCard } from './MealCard';
import { Sheet } from './Sheet';
import { Summary } from './Summary';
import { WeighIn } from './Weight';

const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

/** True at the desktop breakpoint (Tailwind lg), where meals get their own column. */
function useWide() {
  const q = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export function Today(props: { today: string; weightUnit: 'kg' | 'lb'; blocks: HomeBlock[] }) {
  const wide = useWide();
  const [date, setDate] = useState(props.today);
  const [day, setDay] = useState<Day | null>(null);
  const [adding, setAdding] = useState<{ intake?: Intake } | null>(null);
  const [yesterday, setYesterday] = useState<Intake[]>([]);

  // The listeners below are registered once; they read the day being shown from here, not from the
  // first render (a meal settling while viewing another day reloaded today into that day's header).
  const shown = useRef(date);
  shown.current = date;
  const load = async (d = shown.current) => {
    try {
      const got = await api.get<Day>(`/day/${d}`);
      // A slow answer for a day no longer shown mustn't replace the one that is.
      if (d === shown.current) setDay(got);
    } catch (e) {
      toast.error(e, { id: 'day' });
    }
  };

  // Pick up meals logged on another device when the app comes back to the foreground.
  useRefreshOnReturn(() => load());

  useEffect(() => {
    const offQueue = onQueueChange(() => load());
    const offSettled = onIntakeSettled(() => load());
    // The log button lives in the bottom bar; it asks this screen to open the sheet.
    const open = () => setAdding({});
    addEventListener('open-log', open);
    return () => {
      offQueue();
      offSettled();
      removeEventListener('open-log', open);
    };
  }, []);

  useEffect(() => {
    setDay(null);
    load(date);
    api.get<Day>(`/day/${addDays(date, -1)}`).then(
      (d) => setYesterday(d.meals.filter((m) => m.status === 'completed')),
      () => setYesterday([]),
    );
  }, [date]);

  useEffect(() => {
    day?.meals.forEach(watch);
  }, [day]);

  async function repeat(m: Intake) {
    const at = date === props.today ? undefined : new Date(`${date}T12:00:00`).toISOString();
    try {
      await api.post(`/intake/${m.id}/copy`, { meal_type: m.meal_type, ...(at ? { occurrence_at: at } : {}) });
      toast.success(`${MEAL_LABEL[m.meal_type]} repeated`);
      load();
    } catch (e) {
      toast.error(e, { id: 'day' });
    }
  }

  const repeatable = day ? yesterday.filter((y) => y.meal_type !== 'snack' && !day.meals.some((m) => m.meal_type === y.meal_type)) : [];
  const meals = day ? [...day.meals].sort((a, b) => a.occurrence_at.localeCompare(b.occurrence_at)) : [];
  const isToday = date === props.today;
  const mealList =
    meals.length === 0 ? (
      <EmptyDay isToday={isToday} onLog={() => setAdding({})} />
    ) : (
      <ol class="relative flex flex-col gap-4" aria-label="Meals">
        {/* The day's timeline */}
        {/* Tablet and up only; on phones the time sits in the card so cards get the full width. */}
        <span class="absolute top-3 bottom-3 left-[3.5rem] hidden w-px bg-line md:block" aria-hidden="true" />
        {meals.map((m, i) => (
          <li class="rise items-start gap-4 md:grid md:grid-cols-[3rem_minmax(0,1fr)]" style={{ animationDelay: `${i * 40}ms` }}>
            <div class="hidden flex-col items-end pt-4 whitespace-nowrap md:flex">
              <span class="num text-[0.8rem] leading-none text-ink-2">{time(m.occurrence_at).replace(/\s?[AP]M/i, '')}</span>
              <span class="mt-0.5 text-[10px] text-faint uppercase">{/PM/i.test(time(m.occurrence_at)) ? 'pm' : 'am'}</span>
            </div>
            <div class="relative min-w-0">
              <span class="absolute top-5 -left-[0.82rem] hidden h-2.5 w-2.5 md:block rounded-full bg-accent ring-4 ring-paper" aria-hidden="true" />
              <MealCard meal={m} onChange={() => load()} onAdd={(intake) => setAdding({ intake })} />
            </div>
          </li>
        ))}
      </ol>
    );

  return (
    <div class="flex flex-col gap-5">
      <header class="flex items-end justify-between pt-2">
        <div>
          <p class="eyebrow">{longDate(date)}</p>
          <h1 class="display mt-0.5 text-[2.1rem] leading-none font-semibold">{dayLabel(date, props.today)}</h1>
        </div>
        <div class="flex items-center gap-1">
          <button class="icon-btn" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">
            <ChevronLeft size={22} />
          </button>
          <button class="icon-btn disabled:opacity-25" onClick={() => setDate(addDays(date, 1))} disabled={isToday} aria-label="Next day">
            <ChevronRight size={22} />
          </button>
        </div>
      </header>

      {day ? (
        // Blocks in the order chosen in Settings. Desktop: meals get the right column and the rest stay
        // pinned on the left in the same order; phones: one column.
        (() => {
          const block = (b: HomeBlock) =>
            b === 'summary' ? (
              <Summary day={day} isToday={isToday} />
            ) : b === 'weight' ? (
              <WeighIn unit={props.weightUnit} date={date} today={props.today} />
            ) : b === 'repeat' ? (
              repeatable.length > 0 && (
                <div class="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 lg:mx-0 lg:flex-wrap lg:px-0">
                  {repeatable.map((m) => (
                    <button class="chip flex shrink-0 items-center gap-1.5 hover:bg-sunken" onClick={() => repeat(m)}>
                      <RotateCcw size={14} /> Yesterday's {MEAL_LABEL[m.meal_type].toLowerCase()}
                    </button>
                  ))}
                </div>
              )
            ) : (
              mealList
            );
          if (!wide) return <div class="flex flex-col gap-5">{props.blocks.map(block)}</div>;
          return (
            <div class="grid grid-cols-[minmax(0,22rem)_minmax(0,1fr)] items-start gap-10">
              <div class="sticky top-8 flex flex-col gap-4">{props.blocks.filter((b) => b !== 'meals').map(block)}</div>
              {mealList}
            </div>
          );
        })()
      ) : (
        <div class="flex flex-col gap-4 lg:grid lg:grid-cols-[22rem_1fr] lg:gap-10" aria-busy="true">
          <div class="card h-72 animate-pulse" />
          <div class="card h-40 animate-pulse" />
        </div>
      )}

      <Sheet open={!!adding} onClose={() => setAdding(null)} title={adding?.intake ? `Add to ${MEAL_LABEL[adding.intake.meal_type].toLowerCase()}` : 'What did you eat?'}>
        {adding && (
          <LogSheet
            date={date}
            today={props.today}
            target={adding.intake}
            defaultMeal={isToday ? guessMeal() : 'snack'}
            onDone={() => {
              setAdding(null);
              load();
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

function EmptyDay(props: { isToday: boolean; onLog: () => void }) {
  return (
    <div class="card flex flex-col items-center gap-3 px-6 py-10 text-center">
      <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
        <circle cx="36" cy="38" r="26" fill="none" stroke="var(--line)" stroke-width="3" />
        <circle cx="36" cy="38" r="17" fill="var(--sunken)" />
        <path d="M14 10v16M10 10v8a4 4 0 0 0 8 0v-8M58 10c-4 2-5 8-5 12h5v16" fill="none" stroke="var(--faint)" stroke-width="2.5" stroke-linecap="round" />
      </svg>
      <p class="display text-xl font-semibold">{props.isToday ? 'A blank plate' : 'Nothing logged'}</p>
      <p class="max-w-[16rem] text-sm text-ink-2">
        {props.isToday ? 'Snap a photo, say it, or type what you ate. Rough is fine; a missed day hurts more than a guess.' : 'Nothing was logged for this day.'}
      </p>
      <button class="btn-primary mt-1" onClick={props.onLog}>
        Log a meal
      </button>
    </div>
  );
}
