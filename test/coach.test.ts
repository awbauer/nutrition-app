import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { coachDigest, generateReport, loggingScore, runDueReports, validateReport, type PeriodStats } from '../src/worker/lib/coach';
import { api } from './helpers';

const REPORT = {
  headline: 'Protein is on track; calories ran high this week',
  summary: 'You logged most days.',
  periods: { day: ['a'], week: ['b'], month: ['c'] },
  wins: ['w'],
  watch: [],
  coaching: [{ title: 'Add fruit at breakfast', detail: 'Fiber is low.' }],
  logging: { summary: 'Good.', tips: [] },
};

/** Workers AI fake: records the digest it was given and answers with REPORT. */
function fakeAi(seen: unknown[] = []) {
  return {
    run: async (_m: string, input: { messages: { role: string; content: string }[] }) => {
      seen.push(JSON.parse(input.messages[1]!.content));
      return { response: REPORT };
    },
  } as unknown as Ai;
}

async function setup(email: string) {
  const E = { DEV_USER_EMAIL: email };
  const food = await api('/foods', { method: 'POST', json: { name: 'Chicken & rice', serving_grams: 100, per_serving: { ENERC_KCAL: 600, PROCNT: 45 } } }, E);
  const log = (meal_type: string, at: string, display_name = 'chicken & rice') =>
    api('/intake', { method: 'POST', json: { meal_type, occurrence_at: at, merge: false, items: [{ food_id: food.data.id, amount: 1, unit: 'serving', display_name }] } }, E);
  await api('/goals', { method: 'PUT', json: { energy: 2000, protein: 120 } }, E);
  await (env as unknown as Env).DB.prepare(`UPDATE goal SET start_date = '2026-10-01' WHERE user_id = (SELECT id FROM users WHERE email = ?)`).bind(email).run();
  const me = await (env as unknown as Env).DB.prepare('SELECT id, access_sub, email, timezone FROM users WHERE email = ?').bind(email).first<any>();
  return { E, log, user: me };
}

describe('coach digest', () => {
  it('counts the day, week and month from the log, including how well it was logged', async () => {
    const { log, user } = await setup('coach-digest@example.test');
    // Times are UTC; the user's zone is UTC with a 04:00 cutoff.
    await log('lunch', '2026-11-10T12:00:00Z');
    await log('dinner', '2026-11-10T19:00:00Z');
    await log('lunch', '2026-11-12T12:00:00Z');
    await log('lunch', '2026-10-25T12:00:00Z'); // 18 days back: in the month, not the week
    const d = await coachDigest((env as unknown as Env).DB, user, '2026-11-12');
    expect(d.targets).toMatchObject({ ENERC_KCAL: 2000, PROCNT: 120 });
    expect(d.day).toMatchObject({ days_logged: 1, avg: expect.objectContaining({ ENERC_KCAL: 600, PROCNT: 45 }) });
    expect(d.day.meals).toEqual([{ meal_type: 'lunch', time: '12:00', items: [{ name: 'chicken & rice', kcal: 600, protein: 45, estimated: false }] }]);
    expect(d.week).toMatchObject({ days: 7, days_logged: 2, days_probably_incomplete: 1, meals_per_logged_day: 1.5 });
    expect(d.week.avg.ENERC_KCAL).toBe(900);
    expect(d.week.meal_days).toEqual({ breakfast: 0, lunch: 2, dinner: 1 });
    expect(d.month.days_logged).toBe(3);
    expect(d.top_foods_month[0]).toMatchObject({ name: 'chicken & rice', times: 4, kcal_share_pct: 100 });
    expect(d.new_foods_week).toEqual([]);
    expect(d.logging_score).toBeGreaterThan(0);
  });

  it('scores logging from coverage, matching, answers and promptness', () => {
    const base: PeriodStats = {
      from: '', to: '', days: 7, days_logged: 7, days_probably_incomplete: 0, avg: {}, days_within_10pct_kcal: 0, days_protein_target_met: 0,
      meals_per_logged_day: 3, meal_days: { breakfast: 7, lunch: 7, dinner: 7 }, items: 20, pct_items_ai_estimate: 0, pct_items_unsure: 0,
      meals_waiting_on_answers: 0, median_log_delay_min: 0, sources: {},
    };
    expect(loggingScore(base)).toBe(100);
    expect(loggingScore({ ...base, days_logged: 0 })).toBe(0);
    expect(loggingScore({ ...base, days_logged: 3, meal_days: { breakfast: 0, lunch: 3, dinner: 3 }, pct_items_ai_estimate: 50, median_log_delay_min: 300 })).toBeLessThan(60);
  });

  it('keeps only well-formed report fields', () => {
    expect(validateReport(JSON.stringify({ ...REPORT, coaching: [{ title: 'x' }, { title: 'y', detail: 'z' }], extra: 1 }))).toMatchObject({ coaching: [{ title: 'y', detail: 'z' }] });
    expect(() => validateReport({ summary: 'no headline' })).toThrow();
  });
});

describe('coach reports', () => {
  it('writes today so far on demand, and the nightly run replaces it once the day is over', async () => {
    const { E, log, user } = await setup('coach-run@example.test');
    const now = new Date();
    await log('lunch', new Date(now.getTime() - 3600000).toISOString());
    const seen: any[] = [];
    const run = await api('/coach/run', { method: 'POST' }, { ...E, AI: fakeAi(seen) });
    expect(run.data).toMatchObject({ status: 'ready', partial: true, report: { headline: REPORT.headline } });
    expect(seen[0]).toMatchObject({ partial: true, targets: { ENERC_KCAL: 2000 } });
    const list = await api('/coach', {}, E);
    expect(list.data.latest).toMatchObject({ log_date: run.data.log_date, partial: true });

    // Two days later at 05:00 UTC, the nightly run writes the day that just ended…
    const later = new Date(`${run.data.log_date}T05:00:00Z`);
    later.setUTCDate(later.getUTCDate() + 1);
    const runEnv = { ...(env as unknown as Env), HISTORY: undefined, AI: fakeAi(seen) } as Env;
    const first = await runDueReports(runEnv, later);
    expect(first.written).toBeGreaterThanOrEqual(1);
    const mine = await api('/coach', {}, E);
    expect(mine.data.reports.map((r: any) => [r.log_date, r.partial])).toContainEqual([run.data.log_date, false]);
    // …and only once.
    const before = seen.length;
    await runDueReports(runEnv, later);
    expect(seen.filter((d) => d.reviewed_date === run.data.log_date).length).toBe(seen.slice(0, before).filter((d) => d.reviewed_date === run.data.log_date).length);
    expect(user.id).toBeTruthy();
  });

  it('records a failure when the model keeps answering nonsense, and keeps reports private', async () => {
    const { E, log } = await setup('coach-fail@example.test');
    await log('lunch', new Date(Date.now() - 3600000).toISOString());
    const bad = { run: async () => ({ response: 'not json' }) } as unknown as Ai;
    const r = await api('/coach/run', { method: 'POST' }, { ...E, AI: bad });
    expect(r.data).toMatchObject({ status: 'failed' });
    expect((await api(`/coach/${r.data.log_date}`, {}, { DEV_USER_EMAIL: 'coach-other@example.test' })).status).toBe(404);
  });
});

describe('coach v2: macro split, streaks, changes, plans, no repeats', () => {
  it('computes the macro split from grams and judges it against targets or healthy ranges', async () => {
    const { macroSplit, macroReference, streak } = await import('../src/worker/lib/coach');
    expect(macroSplit({ PROCNT: 60, FAT: 120, CHOCDF: 220 })).toEqual({ protein_pct: 11, fat_pct: 49, carbs_pct: 40 });
    expect(macroSplit({ PROCNT: 5 })).toBeNull();
    expect(macroReference({})).toMatchObject({ source: 'healthy ranges', carbs_pct: [45, 65] });
    expect(macroReference({ ENERC_KCAL: 2000, PROCNT: 150 })).toMatchObject({
      source: 'derived from your calorie and protein targets',
      protein_pct: [25, 35],
      fat_pct: [20, 35],
      carbs_pct: [35, 50],
      fat_g: [44, 78],
    });
    // 150 g protein in 1,800 kcal is 33%: carbs are what's left after 20-35% fat, so 196 g is inside, not "under the floor".
    const mine = macroReference({ ENERC_KCAL: 1800, PROCNT: 150 });
    expect(mine).toMatchObject({ carbs_pct: [32, 47], carbs_g: [144, 212] });
    expect(196).toBeGreaterThanOrEqual(mine.carbs_g![0]);
    expect(macroReference({ ENERC_KCAL: 2000, FAT: 60 })).toMatchObject({ source: 'your targets', fat_pct: [22, 32], fat_g: [54, 66] });
    const days: { date: string; meals: number; totals: Record<string, number> }[] = [
      { date: '2026-11-10', meals: 2, totals: { PROCNT: 50 } },
      { date: '2026-11-11', meals: 0, totals: {} },
      { date: '2026-11-12', meals: 3, totals: { PROCNT: 60 } },
      { date: '2026-11-13', meals: 3, totals: { PROCNT: 70 } },
      { date: '2026-11-09', meals: 3, totals: { PROCNT: 140 } },
    ];
    expect(streak(days, '2026-11-13', (t) => (t.PROCNT ?? 0) < 100)).toEqual({ days_running: 3, days_in_last_7_logged: 3 });
  });

  it('gives the coach the split, the streak, the change and real high-protein meals to plan with', async () => {
    const email = 'coach-v2@example.test';
    const E = { DEV_USER_EMAIL: email };
    const mk = async (name: string, kcal: number, p: number, f: number, c: number) =>
      (await api('/foods', { method: 'POST', json: { name, serving_grams: 100, per_serving: { ENERC_KCAL: kcal, PROCNT: p, FAT: f, CHOCDF: c } } }, E)).data.id as string;
    const eggs = await mk('eggs and smoked salmon', 420, 42, 24, 4);
    const toast = await mk('toast with butter', 300, 6, 14, 36);
    const bacon = await mk('bacon cheeseburger', 900, 35, 60, 45);
    await api('/goals', { method: 'PUT', json: { energy: 2000, protein: 150 } }, E);
    await (env as unknown as Env).DB.prepare(`UPDATE goal SET start_date = '2026-10-01' WHERE user_id = (SELECT id FROM users WHERE email = ?)`).bind(email).run();
    const log = (meal_type: string, at: string, food_id: string, display_name: string) =>
      api('/intake', { method: 'POST', json: { meal_type, occurrence_at: at, merge: false, items: [{ food_id, amount: 1, unit: 'serving', display_name }] } }, E);
    // The week before: a high-protein breakfast; this week: toast and burgers.
    await log('breakfast', '2026-11-03T08:00:00Z', eggs, 'eggs and smoked salmon');
    for (const d of ['10', '11', '12', '13']) {
      await log('breakfast', `2026-11-${d}T08:00:00Z`, toast, 'toast with butter');
      await log('dinner', `2026-11-${d}T19:00:00Z`, bacon, 'bacon cheeseburger');
    }
    const user = await (env as unknown as Env).DB.prepare('SELECT id, access_sub, email, timezone FROM users WHERE email = ?').bind(email).first<any>();
    const d = await coachDigest((env as unknown as Env).DB, user, '2026-11-13');
    expect(d.macro_split.day).toMatchObject({ protein_pct: 14, fat_pct: 58, carbs_pct: 28 });
    expect(d.macro_reference.source).toBe('derived from your calorie and protein targets');
    expect(d.streaks.map((s) => s.issue)).not.toContain('carbs low'); // no carbs target: carbs are the remainder
    expect(d.streaks.map((s) => s.issue)).toEqual(expect.arrayContaining(['protein short', 'fat-heavy']));
    expect(d.streaks.find((s) => s.issue === 'protein short')).toMatchObject({ days_running: 5 }); // every logged day, Nov 3 included
    expect(d.plans.protein_per_meal_30d.breakfast).toMatchObject({ meals: 5, median_g: 6, big_meals_left_out: 0 });
    expect(d.plans.high_protein_meals.breakfast?.[0]).toMatchObject({ items: ['eggs and smoked salmon'], protein_g: 42 });
    expect(d.plans.top_fat_sources_week[0]).toMatchObject({ name: 'bacon cheeseburger', fat_g: 240 });
    expect(d.changes.some((c) => c.what === 'days logged')).toBe(true);
  });

  it('uses the median breakfast and leaves out a 1,000+ kcal brunch', async () => {
    const email = 'coach-brunch@example.test';
    const E = { DEV_USER_EMAIL: email };
    const mk = async (name: string, kcal: number, p: number) =>
      (await api('/foods', { method: 'POST', json: { name, serving_grams: 100, per_serving: { ENERC_KCAL: kcal, PROCNT: p, FAT: 10, CHOCDF: 40 } } }, E)).data.id as string;
    const oats = await mk('oats', 350, 18);
    const eggs = await mk('eggs on toast', 400, 22);
    const brunch = await mk('brunch: quiche, sashimi, shake', 1600, 63);
    const log = (at: string, food_id: string, display_name: string) =>
      api('/intake', { method: 'POST', json: { meal_type: 'breakfast', occurrence_at: at, merge: false, items: [{ food_id, amount: 1, unit: 'serving', display_name }] } }, E);
    await log('2026-11-10T08:00:00Z', oats, 'oats');
    await log('2026-11-11T08:00:00Z', eggs, 'eggs on toast');
    await log('2026-11-12T08:00:00Z', oats, 'oats');
    await log('2026-11-13T08:00:00Z', brunch, 'brunch');
    const user = await (env as unknown as Env).DB.prepare('SELECT id, access_sub, email, timezone FROM users WHERE email = ?').bind(email).first<any>();
    const d = await coachDigest((env as unknown as Env).DB, user, '2026-11-13');
    expect(d.plans.protein_per_meal_30d.breakfast).toEqual({ median_g: 18, meals: 3, big_meals_left_out: 1 });
    // Not offered as a breakfast to repeat either.
    expect((d.plans.high_protein_meals.breakfast ?? []).some((m) => m.items.includes('brunch'))).toBe(false);
  });

  it("rewrites a headline that repeats a recent one, and tells the coach what it said before", async () => {
    const { E, log, user } = await setup('coach-repeat@example.test');
    await log('lunch', '2026-11-12T12:00:00Z');
    await log('lunch', '2026-11-13T12:00:00Z');
    const seen: any[] = [];
    const answers = [
      { ...REPORT, headline: 'Protein is short again this week' },
      { ...REPORT, headline: 'Protein is still short this week' },
      { ...REPORT, headline: 'Breakfasts average 21 g: three from your log hit 40 g' },
    ];
    const ai = {
      run: async (_m: string, input: { messages: { role: string; content: string }[] }) => {
        seen.push(input.messages);
        return { response: answers.shift() };
      },
    } as unknown as Ai;
    const runEnv = { ...(env as unknown as Env), HISTORY: undefined, AI: ai } as Env;
    const first = await generateReport(runEnv, user, '2026-11-12', false);
    expect(first.report?.headline).toBe('Protein is short again this week');
    const second = await generateReport(runEnv, user, '2026-11-13', false);
    expect(second.report?.headline).toBe('Breakfasts average 21 g: three from your log hit 40 g');
    // The second day's digest carried the first headline, and the retry said why.
    expect(JSON.parse(seen[1][1].content).previous_reports[0]).toMatchObject({ date: '2026-11-12', headline: 'Protein is short again this week' });
    expect(seen[2].at(-1).content).toMatch(/repeats a recent one/);
    expect(E).toBeTruthy();
  });
});
