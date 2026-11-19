import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { coachDigest, loggingScore, runDueReports, validateReport, type PeriodStats } from '../src/worker/lib/coach';
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
