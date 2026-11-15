import { useEffect, useState } from 'preact/hooks';
import { api, type Day, type Intake, type MealType } from '../api';
import { addDays, dayLabel, MEALS } from '../format';
import { AddFood } from './AddFood';
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

export function Today(props: { today: string }) {
  const [date, setDate] = useState(props.today);
  const [day, setDay] = useState<Day | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ intake?: Intake } | null>(null);

  const load = async (d = date) => {
    try {
      setDay(await api.get<Day>(`/day/${d}`));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    setDay(null);
    load(date);
  }, [date]);

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

      {err && <p class="card p-4 text-sm text-rose-600">{err}</p>}
      {day ? (
        <>
          <Summary totals={day.totals} targets={day.targets} remaining={day.remaining} />
          {day.meals.length === 0 && <p class="py-8 text-center text-sm text-slate-500">Nothing logged yet.</p>}
          {MEALS.flatMap((mt) => day.meals.filter((m) => m.meal_type === mt)).map((m) => (
            <MealCard meal={m} onChange={onMealChange} onAdd={(intake) => setAdding({ intake })} />
          ))}
        </>
      ) : (
        !err && <div class="card h-40 animate-pulse" />
      )}

      <button
        class="btn-primary fixed right-5 bottom-24 z-30 h-14 w-14 rounded-full text-2xl shadow-lg"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        onClick={() => setAdding({})}
        aria-label="Log food"
      >
        +
      </button>

      <Sheet open={!!adding} onClose={() => setAdding(null)} title={adding?.intake ? 'Add to meal' : 'Log food'}>
        {adding?.intake && (
          <AddFood
            date={date}
            intakeId={adding.intake.id}
            onDone={() => {
              setAdding(null);
              load();
            }}
          />
        )}
        {adding && !adding.intake && (
          <LogSheet
            date={date}
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
