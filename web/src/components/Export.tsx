import { useState } from 'preact/hooks';
import { addDays } from '../format';

/** Download links; the browser sends the Access cookie with same-origin requests. */
export function Export(props: { today: string }) {
  const [from, setFrom] = useState(addDays(props.today, -29));
  const [to, setTo] = useState(props.today);
  const q = (format: string, kind = 'items') => `/api/export?format=${format}&kind=${kind}&from=${from}&to=${to}`;
  return (
    <section class="card flex flex-col gap-3 p-4">
      <h2 class="display text-xl font-semibold">Export</h2>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-ink-2">From</span>
          <input class="input" type="date" value={from} max={to} onChange={(e) => setFrom((e.target as HTMLInputElement).value)} />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-ink-2">To</span>
          <input class="input" type="date" value={to} min={from} max={props.today} onChange={(e) => setTo((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="grid grid-cols-3 gap-2">
        <a class="btn-ghost" href={q('csv', 'items')} download>
          Foods CSV
        </a>
        <a class="btn-ghost" href={q('csv', 'daily')} download>
          Daily CSV
        </a>
        <a class="btn-ghost" href={q('json')} download>
          JSON
        </a>
      </div>
      <p class="text-xs text-ink-2">Foods CSV has one row per item; Daily CSV has totals vs targets and weight trend; JSON has full records.</p>
    </section>
  );
}
