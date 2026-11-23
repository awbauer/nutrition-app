import type { Day, MealType } from '../api';
import { kcal, MEAL_LABEL } from '../format';

const MEAL_COLOR: Record<MealType, string> = {
  breakfast: 'var(--mustard)',
  lunch: 'var(--accent)',
  dinner: 'var(--plum)',
  snack: 'var(--sage)',
};
const ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/** The day at a glance: energy left (or over), how each meal filled it, and macros. */
export function Summary(props: { day: Day; isToday?: boolean }) {
  const { totals, targets, unconfirmed = 0 } = props.day;
  const eaten = totals.ENERC_KCAL ?? 0;
  const target = targets.ENERC_KCAL;
  const left = target != null ? Math.round(target - eaten) : null;
  const over = left != null && left < 0;

  // Energy by meal type, for the plate bar.
  const byMeal = ORDER.map((t) => ({
    type: t,
    kcal: props.day.meals.filter((m) => m.meal_type === t && (m.status === 'completed' || m.status === 'in-progress')).reduce((s, m) => s + (m.totals.ENERC_KCAL ?? 0), 0),
  })).filter((x) => x.kcal > 0);
  const scale = Math.max(target ?? 0, eaten, 1);
  // Past days (the Today screen's day arrows) aren't "today".
  const when = props.isToday === false ? '' : ' today';

  return (
    <section class="card overflow-hidden p-5" aria-label={props.isToday === false ? 'Day totals' : "Today's totals"}>
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="eyebrow">{target == null ? `Eaten${when}` : over ? 'Over your target' : `Left${when}`}</p>
          <p class={`num mt-1 text-[3.25rem] leading-none font-semibold ${over ? 'text-berry' : ''}`}>
            {kcal(target == null ? eaten : Math.abs(left!))}
            <span class="ml-1.5 font-sans text-base font-medium text-faint">kcal</span>
          </p>
          <p class="mt-1.5 text-sm text-ink-2">{target == null ? 'Set a target in Settings to see what’s left' : `${kcal(eaten)} eaten of ${kcal(target)}`}</p>
          {/* Meals with an open question count at their default answers; say so rather than hide them. */}
          {unconfirmed > 0 && (
            <p class="mt-1 flex items-center gap-1.5 text-xs text-faint">
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-mustard" aria-hidden="true" />
              Includes {unconfirmed} unconfirmed {unconfirmed === 1 ? 'meal' : 'meals'}
            </p>
          )}
        </div>
        <ProteinBadge eaten={totals.PROCNT ?? 0} target={targets.PROCNT} />
      </div>

      {/* Plate bar: each meal's share, with the target marked */}
      <div class="relative mt-5">
        <div
          class="flex h-3 overflow-hidden rounded-full bg-sunken"
          role="img"
          aria-label={byMeal.map((m) => `${MEAL_LABEL[m.type]} ${kcal(m.kcal)} kcal`).join(', ') || 'Nothing eaten yet'}
        >
          {byMeal.map((m, i) => (
            <span style={{ width: `${(m.kcal / scale) * 100}%`, background: MEAL_COLOR[m.type] }} class={i > 0 ? 'border-l-2 border-card' : ''} />
          ))}
        </div>
        {target != null && eaten > target && <span class="absolute -top-1 h-5 w-0.5 rounded bg-ink" style={{ left: `${(target / scale) * 100}%` }} aria-hidden="true" />}
        {byMeal.length > 0 && (
          <div class="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
            {byMeal.map((m) => (
              <span class="flex items-center gap-1.5 text-xs text-ink-2">
                <span class="h-2 w-2 rounded-full" style={{ background: MEAL_COLOR[m.type] }} />
                {MEAL_LABEL[m.type]} <span class="num text-ink">{kcal(m.kcal)}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div class="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4">
        <Macro label="Carbs" value={totals.CHOCDF} target={targets.CHOCDF} kind="limit" />
        <Macro label="Fat" value={totals.FAT} target={targets.FAT} kind="limit" />
        <Macro label="Fiber" value={totals.FIBTG} target={targets.FIBTG} kind="floor" />
      </div>
    </section>
  );
}

function ProteinBadge(props: { eaten: number; target?: number }) {
  const { eaten, target } = props;
  const pct = target ? Math.min(eaten / target, 1) : 0;
  const r = 26;
  const c = 2 * Math.PI * r;
  const met = target != null && eaten >= target;
  return (
    <div class="flex shrink-0 flex-col items-center">
      <div class="relative h-[4.5rem] w-[4.5rem]">
        <svg viewBox="0 0 64 64" class="h-full w-full -rotate-90" aria-hidden="true">
          <circle cx="32" cy="32" r={r} fill="none" stroke="var(--sage-soft)" stroke-width="7" />
          {target != null && <circle cx="32" cy="32" r={r} fill="none" stroke="var(--sage)" stroke-width="7" stroke-linecap="round" stroke-dasharray={`${pct * c} ${c}`} />}
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          <span class="num text-lg leading-none font-semibold">{Math.round(eaten)}</span>
          <span class="text-[10px] text-faint">g</span>
        </div>
      </div>
      <p class="mt-1 text-center text-[11px] leading-tight font-medium text-sage">{target == null ? 'protein' : met ? 'Protein met' : `${Math.round(target - eaten)} g to go`}</p>
    </div>
  );
}

/**
 * A macro against its target. Carbs and fat are budgets (going over shows in red); fiber is a floor to
 * reach (reaching it shows in green).
 */
function Macro(props: { label: string; value?: number; target?: number; kind: 'limit' | 'floor' }) {
  const v = props.value ?? 0;
  const t = props.target;
  const pct = t ? Math.min(v / t, 1) : null;
  const diff = t ? Math.round(t - v) : 0;
  const over = t != null && props.kind === 'limit' && diff < 0;
  const met = t != null && props.kind === 'floor' && diff <= 0;
  const bar = over ? 'bg-berry' : met ? 'bg-sage' : props.kind === 'floor' ? 'bg-sage/70' : 'bg-ink-2';
  return (
    <div>
      <p class="eyebrow">{props.label}</p>
      <p class="mt-1">
        <span class={`num text-xl font-semibold ${over ? 'text-berry' : ''}`}>{Math.round(v)}</span>
        <span class="text-xs text-faint">{t ? ` / ${Math.round(t)} g` : ' g'}</span>
      </p>
      {pct != null && (
        <>
          <div
            class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunken"
            role="progressbar"
            aria-label={`${props.label} toward target`}
            aria-valuemin={0}
            aria-valuemax={Math.round(t!)}
            aria-valuenow={Math.round(v)}
          >
            <div class={`h-full rounded-full ${bar}`} style={{ width: `${pct * 100}%` }} />
          </div>
          <p class={`mt-1 text-[11px] ${over ? 'text-berry' : met ? 'text-sage' : 'text-faint'}`}>
            {over ? `${-diff} g over` : met ? 'Met' : props.kind === 'floor' ? `${diff} g to go` : `${diff} g left`}
          </p>
        </>
      )}
    </div>
  );
}
