/** Reminder dispatch, run by the 15-minute Cron Trigger. */
import type { Env } from '../env';
import { localParts, logDate, parseHHMM } from './dates';
import { goalsOn, targetsFromGoals } from './goals';
import { dailyTotals } from './intake';
import { getSettings } from './settings';
import { sendPush, type PushMessage, type VapidKeys } from './webpush';

export interface ReminderRow {
  id: string;
  user_id: string;
  label: string;
  meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack' | null;
  kind: 'meal' | 'end-of-day';
  local_time: string;
  days_of_week: string;
  enabled: number;
  last_sent_on: string | null;
}

/** How late a reminder may still fire if a cron tick was missed. */
export const GRACE_MINUTES = 60;

export function vapidKeys(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'mailto:admin@example.com' };
}

/** Is the reminder due at `now` in `tz`? Returns the local date it is due for, or null. */
export function dueOn(r: Pick<ReminderRow, 'local_time' | 'days_of_week' | 'enabled' | 'last_sent_on'>, now: Date, tz: string): string | null {
  if (!r.enabled) return null;
  const lp = localParts(now, tz);
  if (!r.days_of_week.includes(String(lp.weekday))) return null;
  const diff = lp.minutes - parseHHMM(r.local_time);
  if (diff < 0 || diff >= GRACE_MINUTES) return null;
  if (r.last_sent_on === lp.date) return null;
  return lp.date;
}

export interface DispatchResult {
  sent: number;
  skipped: number;
  removed: number;
}

export async function dispatchReminders(env: Env, now = new Date(), send = sendPush): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, skipped: 0, removed: 0 };
  const keys = vapidKeys(env);
  if (!keys) return result;
  const { results } = await env.DB.prepare(
    `SELECT r.*, u.timezone FROM reminder r JOIN users u ON u.id = r.user_id
     WHERE r.enabled = 1 AND EXISTS (SELECT 1 FROM push_subscription p WHERE p.user_id = r.user_id)`,
  ).all<ReminderRow & { timezone: string }>();

  for (const r of results) {
    const due = dueOn(r, now, r.timezone);
    if (!due) continue;
    // Mark first so an overlapping cron run can't double-send.
    const claimed = await env.DB.prepare(`UPDATE reminder SET last_sent_on = ? WHERE id = ? AND (last_sent_on IS NULL OR last_sent_on != ?)`).bind(due, r.id, due).run();
    if (!claimed.meta.changes) continue;

    // One reminder failing (a D1 error, every push failing) mustn't stop the others; release its claim
    // so the next tick (within the grace period) tries it again.
    let delivered = false;
    let failed = false;
    try {
      const msg = await buildMessage(env, r, now);
      if (!msg) {
        result.skipped++;
        continue;
      }
      const subs = await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = ?')
        .bind(r.user_id)
        .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
      for (const s of subs.results) {
        try {
          const status = await send(s, msg, keys);
          if (status === 404 || status === 410) {
            await env.DB.prepare('DELETE FROM push_subscription WHERE id = ?').bind(s.id).run();
            result.removed++;
          } else if (status >= 200 && status < 300) {
            result.sent++;
            delivered = true;
          } else {
            console.warn('push rejected', status, new URL(s.endpoint).host);
            failed = true;
          }
        } catch (e) {
          console.warn('push failed', e);
          failed = true;
        }
      }
    } catch (e) {
      console.warn('reminder failed', r.id, (e as Error).message);
      failed = true;
    }
    if (failed && !delivered)
      await env.DB.prepare('UPDATE reminder SET last_sent_on = ? WHERE id = ? AND last_sent_on = ?')
        .bind(r.last_sent_on, r.id, due)
        .run()
        .catch((e) => console.warn('reminder release failed', r.id, (e as Error).message));
  }
  return result;
}

/** Message for a due reminder, or null when it should be skipped (meal already logged). */
export async function buildMessage(env: Env, r: ReminderRow & { timezone: string }, now: Date): Promise<PushMessage | null> {
  const settings = await getSettings(env.DB, r.user_id);
  const date = logDate(now.toISOString(), r.timezone, settings.day_cutoff);
  if (r.kind === 'meal') {
    if (r.meal_type) {
      const logged = await env.DB.prepare(`SELECT 1 FROM nutrition_intake WHERE user_id = ? AND log_date = ? AND meal_type = ? AND status != 'entered-in-error' LIMIT 1`)
        .bind(r.user_id, date, r.meal_type)
        .first();
      if (logged) return null;
    }
    return {
      title: r.label,
      body: r.meal_type ? `Log your ${r.meal_type}? It takes a few seconds.` : 'Time to log what you ate.',
      url: '/#today',
      tag: `meal-${r.meal_type ?? 'any'}`,
    };
  }
  // End-of-day nudge.
  const [days, goals] = await Promise.all([dailyTotals(env.DB, r.user_id, date, date), goalsOn(env.DB, r.user_id, date)]);
  const totals = days[0]?.totals ?? {};
  const targets = targetsFromGoals(goals);
  const parts: string[] = [];
  if (targets.ENERC_KCAL != null) {
    const left = Math.round(targets.ENERC_KCAL - (totals.ENERC_KCAL ?? 0));
    parts.push(left >= 0 ? `${left.toLocaleString('en-US')} kcal` : `${(-left).toLocaleString('en-US')} kcal over`);
  }
  if (targets.PROCNT != null) {
    const left = Math.round(targets.PROCNT - (totals.PROCNT ?? 0));
    if (left > 0) parts.push(`${left} g protein`);
  }
  const body = !days[0]
    ? 'Nothing logged today yet. A rough entry beats none.'
    : parts.length
      ? parts[0]!.endsWith('over')
        ? `You're ${parts.join(' and ')} today.`
        : `You have ${parts.join(' and ')} left.`
      : 'Anything else to log today?';
  return { title: r.label, body, url: '/#today', tag: 'end-of-day' };
}
