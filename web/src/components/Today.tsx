import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { onIntakeSettled, watch } from '../analysis';
import { api, type Day, type Intake, type MealType } from '../api';
import { addDays, dayLabel, MEAL_LABEL, time } from '../format';
import { onQueueChange } from '../queue';
import { toast } from '../toast';
import { useRefreshOnReturn } from '../refresh';
import { LogSheet } from './LogSheet';
import { MealCard } from './MealCard';
import { Sheet } from './Sheet';
import { Summary } from './Summary';

function guessMeal(): MealType {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h >= 4 && h < 10.5) return 'breakfast';
  if (h >= 11 && h < 14.5) return 'lunch';
  if (h >= 17 && h < 21.5) return 'dinner';
  return 'snack';
}

const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

export function Today(props: { today: string }) {
  const [date, setDate] = useState(props.today);
  const [day, setDay] = useState<Day | null>(null);
  const [adding, setAdding] = useState<{ intake?: Intake } | null>(null);
  const [yesterday, setYesterday] = useState<Intake[]>([]);

  const load = async (d = date) => {
    try {
      setDay(await api.get<Day>(`/day/${d}`));
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
        // Desktop: the day's summary stays pinned on the left while the timeline scrolls.
        <div class="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start lg:gap-10">
          <div class="flex flex-col gap-4 lg:sticky lg:top-8">
            <Summary day={day} />
            {repeatable.length > 0 && (
              <div class="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 lg:mx-0 lg:flex-wrap lg:px-0">
                {repeatable.map((m) => (
                  <button class="chip flex shrink-0 items-center gap-1.5 hover:bg-sunken" onClick={() => repeat(m)}>
                    <RotateCcw size={14} /> Yesterday's {MEAL_LABEL[m.meal_type].toLowerCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          {meals.length === 0 ? (
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
          )}
        </div>
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
