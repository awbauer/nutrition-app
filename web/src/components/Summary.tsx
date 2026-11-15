import { kcal } from '../format';

function Ring(props: { value: number; target: number | undefined }) {
  const pct = props.target ? Math.min(props.value / props.target, 1.5) : 0;
  const r = 52;
  const c = 2 * Math.PI * r;
  const over = props.target != null && props.value > props.target;
  return (
    <svg viewBox="0 0 120 120" class="h-32 w-32 -rotate-90">
      <circle cx="60" cy="60" r={r} fill="none" stroke-width="10" class="stroke-slate-200 dark:stroke-slate-800" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke-width="10"
        stroke-linecap="round"
        stroke-dasharray={`${Math.min(pct, 1) * c} ${c}`}
        class={over ? 'stroke-amber-500' : 'stroke-brand-600'}
      />
    </svg>
  );
}

function Bar(props: { label: string; value: number; target?: number; unit: string }) {
  const pct = props.target ? Math.min((props.value / props.target) * 100, 100) : 0;
  return (
    <div>
      <div class="flex justify-between text-xs text-slate-500">
        <span>{props.label}</span>
        <span>
          {Math.round(props.value)}
          {props.target ? ` / ${Math.round(props.target)}` : ''} {props.unit}
        </span>
      </div>
      <div class="mt-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800">
        <div class="h-1.5 rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Summary(props: { totals: Record<string, number>; targets: Record<string, number>; remaining: Record<string, number> }) {
  const eaten = props.totals.ENERC_KCAL ?? 0;
  const target = props.targets.ENERC_KCAL;
  const left = props.remaining.ENERC_KCAL;
  const protLeft = props.remaining.PROCNT;
  return (
    <section class="card flex items-center gap-5 p-5">
      <div class="relative">
        <Ring value={eaten} target={target} />
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          {target != null ? (
            <>
              <span class="text-2xl font-bold tabular-nums">{kcal(Math.abs(left ?? 0))}</span>
              <span class="text-xs text-slate-500">{(left ?? 0) >= 0 ? 'kcal left' : 'kcal over'}</span>
            </>
          ) : (
            <>
              <span class="text-2xl font-bold tabular-nums">{kcal(eaten)}</span>
              <span class="text-xs text-slate-500">kcal</span>
            </>
          )}
        </div>
      </div>
      <div class="flex flex-1 flex-col gap-2.5">
        {protLeft != null && (
          <p class="text-sm font-medium">
            <span class="tabular-nums">{Math.max(0, Math.round(protLeft))} g</span> protein to go
          </p>
        )}
        <Bar label="Protein" value={props.totals.PROCNT ?? 0} target={props.targets.PROCNT} unit="g" />
        <Bar label="Carbs" value={props.totals.CHOCDF ?? 0} target={props.targets.CHOCDF} unit="g" />
        <Bar label="Fat" value={props.totals.FAT ?? 0} target={props.targets.FAT} unit="g" />
        <Bar label="Fiber" value={props.totals.FIBTG ?? 0} target={props.targets.FIBTG} unit="g" />
      </div>
    </section>
  );
}
