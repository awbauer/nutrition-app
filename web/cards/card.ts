/**
 * Clem's MCP App card: one view for several tools, chosen by `card` in the tool's structured
 * result. Renders inside the host's sandboxed iframe (Claude, etc.), themed from the host.
 *
 *   day   get_day                 rings for kcal and protein, macros, the day's meals
 *   meal  log_meal, log_food, get_meal, answer_meal_questions
 *                                 items and totals; open questions as tap-to-answer chips
 *   range get_range               a bar per day against the calorie target
 *   coach get_coach_report, run_coach
 *                                 headline, the week's tiles, coaching steps, logging score
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';

type Rec = Record<string, any>;
interface Payload extends Rec {
  card: 'day' | 'meal' | 'range' | 'coach';
  app_url?: string;
}

const root = document.getElementById('root')!;
const app = new App({ name: 'Clem', version: '1.0.0' }, {}, { autoResize: true });

// ---------- helpers ----------
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n0 = (v: unknown) => Math.round(Number(v) || 0).toLocaleString();
const MEAL: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
const MEAL_COLOR: Record<string, string> = { breakfast: 'var(--clem-mustard)', lunch: 'var(--clem-accent)', dinner: 'var(--clem-plum)', snack: 'var(--clem-sage)' };
const day = (d: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
const time = (iso: string, tz?: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });

function ring(value: number, target: number | undefined, color: string, label: string, unit: string): string {
  const r = 34;
  const c = 2 * Math.PI * r;
  const frac = target ? Math.min(1, value / target) : 0;
  const over = !!target && value > target * 1.05;
  return `<div class="ring">
    <svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="${r}" class="track"/>
      <circle cx="42" cy="42" r="${r}" stroke="${over ? 'var(--clem-berry)' : color}" stroke-dasharray="${(frac * c).toFixed(1)} ${c.toFixed(1)}" class="arc"/></svg>
    <div class="ring-text"><b>${n0(value)}</b><span>${esc(unit)}</span></div>
    <p class="ring-label">${esc(label)}${target ? `<br><span class="muted">of ${n0(target)}${unit === 'kcal' ? '' : ' ' + esc(unit)}</span>` : ''}</p>
  </div>`;
}

function itemRows(items: Rec[]): string {
  return items
    .map(
      (it) => `<li><span class="name">${esc(it.display_name || it.food_name)}${it.estimated ? ' <span class="tag">estimate</span>' : ''}</span>
        <span class="amt muted">${esc(fmtAmount(it.amount_value, it.amount_unit))} · ${n0(it.grams)} g</span>
        <span class="kcal">${n0(it.nutrients?.ENERC_KCAL)}</span></li>`,
    )
    .join('');
}
function fmtAmount(a: number, u: string): string {
  const units: Record<string, string> = { g: 'g', mL: 'ml', ml: 'ml', '[foz_us]': 'fl oz', '[oz_av]': 'oz' };
  const amt = Math.round(Number(a) * 100) / 100;
  return units[u] ? `${amt} ${units[u]}` : `${amt} ${String(u).replace(/^\{|\}$/g, '')}`;
}

function openButton(p: Payload, hash = '#today'): string {
  return p.app_url ? `<button class="link" data-open="${esc(p.app_url + '/' + hash)}">Open in Clem ↗</button>` : '';
}

// ---------- cards ----------
function dayCard(p: Payload): string {
  const t = p.totals ?? {};
  const g = p.targets ?? {};
  const meals = (p.meals ?? []).filter((m: Rec) => m.status !== 'entered-in-error');
  const left = g.ENERC_KCAL != null ? g.ENERC_KCAL - (t.ENERC_KCAL ?? 0) : null;
  const status = left == null ? `${n0(t.ENERC_KCAL)} kcal logged` : left >= 0 ? `${n0(left)} kcal left` : `${n0(-left)} kcal over`;
  return `<header><p class="eyebrow">${esc(day(p.date))}</p><h1>${esc(status)}</h1></header>
  <section class="rings">
    ${ring(t.ENERC_KCAL ?? 0, g.ENERC_KCAL, 'var(--clem-accent)', 'Calories', 'kcal')}
    ${ring(t.PROCNT ?? 0, g.PROCNT, 'var(--clem-sage)', 'Protein', 'g')}
    <div class="macros">
      ${[
        ['Carbs', 'CHOCDF', 'g'],
        ['Fat', 'FAT', 'g'],
        ['Fiber', 'FIBTG', 'g'],
        ['Sugars', 'SUGAR', 'g'],
        ['Sodium', 'NA', 'mg'],
      ]
        .map(([label, code, unit]) => `<div><span class="muted">${label}</span><b>${n0(t[code!])}<small> ${unit}</small></b></div>`)
        .join('')}
    </div>
  </section>
  ${
    meals.length
      ? meals
          .map(
            (m: Rec) => `<section class="meal">
      <div class="meal-head"><span class="dot" style="background:${MEAL_COLOR[m.meal_type] ?? 'var(--clem-accent)'}"></span>
        <b>${esc(MEAL[m.meal_type] ?? m.meal_type)}</b><span class="muted">${esc(time(m.occurrence_at, m.occurrence_tz))}</span>
        <span class="right"><b>${n0(m.totals?.ENERC_KCAL)}</b> <span class="muted">kcal</span></span></div>
      ${m.status === 'completed' ? `<ul class="items">${itemRows(m.items ?? [])}</ul>` : `<p class="muted small">${m.status === 'preparation' ? 'Still being read…' : 'Waiting on an answer'}</p>`}
    </section>`,
          )
          .join('')
      : '<p class="empty">Nothing logged yet.</p>'
  }
  <footer>${openButton(p)}</footer>`;
}

function mealCard(p: Payload): string {
  const items: Rec[] = p.items ?? [];
  const qs: Rec[] = p.pending?.questions ?? [];
  const head = `<header><p class="eyebrow">${esc(day(p.log_date, { weekday: 'short', month: 'short', day: 'numeric' }))} · ${esc(time(p.occurrence_at, p.occurrence_tz))}</p>
    <h1><span class="dot big" style="background:${MEAL_COLOR[p.meal_type] ?? 'var(--clem-accent)'}"></span>${esc(MEAL[p.meal_type] ?? p.meal_type)}</h1></header>`;
  if (p.status === 'preparation')
    return `${head}<p class="muted">Clem is still reading this meal.</p><footer><button class="btn" data-refresh="${esc(p.id)}">Check again</button></footer>`;
  const totals = p.totals ?? {};
  return `${head}
  <section class="totals">
    <div><b>${n0(totals.ENERC_KCAL)}</b><span class="muted">kcal</span></div>
    <div><b>${n0(totals.PROCNT)}</b><span class="muted">g protein</span></div>
    <div><b>${n0(totals.CHOCDF)}</b><span class="muted">g carbs</span></div>
    <div><b>${n0(totals.FAT)}</b><span class="muted">g fat</span></div>
  </section>
  <ul class="items">${itemRows(items)}</ul>
  ${qs
    .map(
      (q) => `<section class="question"><p><b>${esc(q.text)}</b></p><div class="chips">
      ${(q.options ?? []).map((o: string) => `<button class="chip${o === q.default ? ' default' : ''}" data-meal="${esc(p.id)}" data-q="${esc(q.id)}" data-a="${esc(o)}">${esc(o)}</button>`).join('')}
    </div></section>`,
    )
    .join('')}
  <footer>${openButton(p)}</footer>`;
}

function rangeCard(p: Payload): string {
  const days: Rec[] = p.days ?? [];
  const target = p.targets?.ENERC_KCAL as number | undefined;
  const all: string[] = [];
  for (let d = p.from as string; d <= p.to; d = new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)) all.push(d);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const max = Math.max(target ?? 0, ...days.map((d) => d.totals?.ENERC_KCAL ?? 0), 1) * 1.08;
  const logged = days.filter((d) => d.meals > 0);
  const avg = logged.length ? logged.reduce((a, d) => a + (d.totals?.ENERC_KCAL ?? 0), 0) / logged.length : 0;
  const avgP = logged.length ? logged.reduce((a, d) => a + (d.totals?.PROCNT ?? 0), 0) / logged.length : 0;
  const many = all.length > 14;
  return `<header><p class="eyebrow">${esc(day(p.from, { month: 'short', day: 'numeric' }))} – ${esc(day(p.to, { month: 'short', day: 'numeric' }))}</p>
    <h1>${n0(avg)} kcal a day</h1><p class="muted">${logged.length} of ${all.length} days logged · ${n0(avgP)} g protein a day${target ? ` · target ${n0(target)}` : ''}</p></header>
  <section class="bars${many ? ' many' : ''}">
    ${target ? `<div class="target" style="bottom:${((target / max) * 100).toFixed(1)}%"></div>` : ''}
    ${all
      .map((d) => {
        const k = byDate.get(d)?.totals?.ENERC_KCAL ?? 0;
        const over = target && k > target * 1.05;
        return `<div class="bar" title="${esc(day(d, { weekday: 'short', month: 'short', day: 'numeric' }))}: ${n0(k)} kcal">
          <div class="fill${over ? ' over' : ''}${k ? '' : ' none'}" style="height:${((k / max) * 100).toFixed(1)}%"></div>
          ${many ? '' : `<span class="lbl">${esc(day(d, { weekday: 'narrow' }))}</span>`}</div>`;
      })
      .join('')}
  </section>
  <footer>${openButton(p, '#week')}</footer>`;
}

function coachCard(p: Payload): string {
  const s: Rec | null = p.report ? p : p.latest;
  if (!s || s.status !== 'ready' || !s.report)
    return `<header><p class="eyebrow">Coach</p><h1>${s?.status === 'pending' ? 'Writing your report…' : 'No report yet'}</h1></header><p class="muted">Your report arrives each morning after 4 am. Ask Claude to run the coach for today so far.</p>`;
  const r = s.report;
  const d = s.digest ?? {};
  const w = d.week ?? { avg: {} };
  const score = d.logging_score ?? 0;
  const scoreColor = score >= 75 ? 'var(--clem-sage)' : score >= 50 ? 'var(--clem-mustard)' : 'var(--clem-berry)';
  const c = 2 * Math.PI * 18;
  return `<header><p class="eyebrow">${s.partial ? 'Today so far' : esc(day(s.log_date))} · Coach</p><h1 class="serif">${esc(r.headline)}</h1><p>${esc(r.summary)}</p></header>
  <section class="tiles">
    <div><span class="muted">Calories / day</span><b>${n0(w.avg?.ENERC_KCAL)}</b><small class="muted">${d.targets?.ENERC_KCAL ? `target ${n0(d.targets.ENERC_KCAL)}` : ''}</small></div>
    <div><span class="muted">Protein / day</span><b>${n0(w.avg?.PROCNT)} g</b><small class="muted">${d.targets?.PROCNT ? `target ${n0(d.targets.PROCNT)} g` : ''}</small></div>
    <div><span class="muted">Days logged</span><b>${w.days_logged ?? 0} of 7</b><small class="muted">${d.previous_week ? `${d.previous_week.days_logged} the week before` : ''}</small></div>
    <div class="score"><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" class="track"/><circle cx="22" cy="22" r="18" class="arc" stroke="${scoreColor}" stroke-dasharray="${((score / 100) * c).toFixed(1)} ${c.toFixed(1)}"/></svg>
      <div><span class="muted">Logging</span><b>${score}</b></div></div>
  </section>
  ${r.coaching?.length ? `<ol class="coaching">${r.coaching.map((x: Rec) => `<li><b>${esc(x.title)}</b><span>${esc(x.detail)}</span></li>`).join('')}</ol>` : ''}
  <section class="two">
    ${r.wins?.length ? `<div><p class="eyebrow">Going well</p><ul class="ticks good">${r.wins.map((x: string) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${r.watch?.length ? `<div><p class="eyebrow">Keep an eye on</p><ul class="ticks watch">${r.watch.map((x: string) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
  </section>
  <footer>${openButton(p, '#coach')}</footer>`;
}

const RENDER: Record<Payload['card'], (p: Payload) => string> = { day: dayCard, meal: mealCard, range: rangeCard, coach: coachCard };

function payloadOf(result: Rec): Payload | null {
  const sc = result?.structuredContent;
  if (sc && typeof sc === 'object' && 'card' in sc) return sc as Payload;
  return null;
}

let current: Payload | null = null;
function render(p: Payload | null, error?: string) {
  current = p;
  if (error) {
    root.innerHTML = `<p class="error">${esc(error)}</p>`;
    return;
  }
  root.innerHTML = p ? (RENDER[p.card]?.(p) ?? '') : '<p class="muted">Loading…</p>';
}

// ---------- interactions ----------
root.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest('button');
  if (!el) return;
  if (el.dataset.open) return void app.openLink({ url: el.dataset.open });
  if (el.dataset.q && el.dataset.meal) {
    // Answer one question; others keep their defaults if this one finishes the meal.
    root.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    el.classList.add('picked');
    const r = await app.callServerTool({ name: 'answer_meal_questions', arguments: { meal_id: el.dataset.meal, answers: { [el.dataset.q]: el.dataset.a } } });
    const p = payloadOf(r);
    if (p) render({ ...p, app_url: p.app_url ?? current?.app_url });
    else render(current, r.isError ? 'Couldn’t save that answer.' : undefined);
    return;
  }
  if (el.dataset.refresh) {
    el.disabled = true;
    const r = await app.callServerTool({ name: 'get_meal', arguments: { meal_id: el.dataset.refresh } });
    render(payloadOf(r) ?? current);
  }
});

// ---------- host wiring ----------
function theme(ctx?: McpUiHostContext) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}
app.ontoolresult = (result) => {
  const p = payloadOf(result as Rec);
  render(p, p ? undefined : (result as Rec).isError ? 'Clem couldn’t do that.' : undefined);
};
app.onhostcontextchanged = theme;
render(null);
app.connect().then(() => theme(app.getHostContext()));
