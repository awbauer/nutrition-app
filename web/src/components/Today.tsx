import { useEffect, useState } from 'preact/hooks';
import { api, type Day, type Intake, type MealType } from '../api';
import { addDays, dayLabel, MEALS, MEAL_LABEL } from '../format';
import { LogSheet } from './LogSheet';
import { MealCard } from './MealCard';
import { Sheet } from './Sheet';
import { Summary } from './Summary';
import { onIntakeSettled, watch } from '../analysis';
import { onQueueChange } from '../queue';
import { toast } from '../toast';

function guessMeal(): MealType {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h >= 4 && h < 10.5) return 'breakfast';
  if (h >= 11 && h < 14.5) return 'lunch';
  if (h >= 17 && h < 21.5) return 'dinner';
  return 'snack';
}

export function Today(props: { today: string }) {
  const [date, setDate] = useState(props.today);
  const [day, setDay] = useState<Day | null>(null);
  const [adding, setAdding] = useState<{ intake?: Intake } | null>(null);
  const [yesterday, setYesterday] = useState<Intake[]>([]);
  useEffect(() => {
    const offQueue = onQueueChange(() => load());
    const offSettled = onIntakeSettled(() => load());
    return () => {
      offQueue();
      offSettled();
    };
  }, []);


  const load = async (d = date) => {
    try {
      setDay(await api.get<Day>(`/day/${d}`));
    } catch (e) {
      toast.error(e, { id: 'day' });
    }
  };
  useEffect(() => {
    setDay(null);
    load(date);
    api.get<Day>(`/day/${addDays(date, -1)}`).then((d) => setYesterday(d.meals.filter((m) => m.status === 'completed')), () => setYesterday([]));
  }, [date]);

  async function repeat(m: Intake) {
    const at = date === props.today ? undefined : new Date(`${date}T12:00:00`).toISOString();
    try {
      await api.post(`/intake/${m.id}/copy`, { meal_type: m.meal_type, ...(at ? { occurrence_at: at } : {}) });
      load();
    } catch (e) {
      toast.error(e, { id: 'day' });
    }
  }

  useEffect(() => {
    day?.meals.forEach(watch);
  }, [day]);

  const repeatable = day ? yesterday.filter((y) => !day.meals.some((m) => m.meal_type === y.meal_type)) : [];

  const onMealChange = () => load();

  return (
    <div class="flex flex-col gap-4">
      <nav class="flex items-center justify-between">
        <button class="rounded-full p-2 text-xl text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-800" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">
          ‹
        </button>
        <button class="text-lg font-semibold" onClick={() => setDate(props.today)}>
          {dayLabel(date, props.today)}
        </button>
        <button
          class="rounded-full p-2 text-xl text-slate-500 hover:bg-slate-200/60 disabled:opacity-30 dark:hover:bg-slate-800"
          onClick={() => setDate(addDays(date, 1))}
          disabled={date >= props.today}
          aria-label="Next day"
        >
          ›
        </button>
      </nav>

      {day ? (
        <>
          <Summary totals={day.totals} targets={day.targets} remaining={day.remaining} />
          {repeatable.length > 0 && (
            <div class="flex gap-2 overflow-x-auto pb-1">
              {repeatable.map((m) => (
                <button class="chip shrink-0 bg-white dark:bg-slate-900" onClick={() => repeat(m)}>
                  ↻ Same as yesterday's {MEAL_LABEL[m.meal_type].toLowerCase()}
                </button>
              ))}
            </div>
          )}
          {day.meals.length === 0 && <p class="py-8 text-center text-sm text-slate-500">Nothing logged yet.</p>}
          {MEALS.flatMap((mt) => day.meals.filter((m) => m.meal_type === mt)).map((m) => (
            <MealCard meal={m} onChange={onMealChange} onAdd={(intake) => setAdding({ intake })} />
          ))}
        </>
      ) : (
        <div class="card h-40 animate-pulse" />
      )}

      <button
        class="btn-primary fixed right-5 bottom-24 z-30 h-14 w-14 rounded-full text-2xl shadow-lg"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        onClick={() => setAdding({})}
        aria-label="Log food"
      >
        +
      </button>

      <Sheet open={!!adding} onClose={() => setAdding(null)} title={adding?.intake ? `Add to ${MEAL_LABEL[adding.intake.meal_type].toLowerCase()}` : 'Log food'}>
        {adding && (
          <LogSheet
            date={date}
            target={adding.intake}
            defaultMeal={date === props.today ? guessMeal() : 'snack'}
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
