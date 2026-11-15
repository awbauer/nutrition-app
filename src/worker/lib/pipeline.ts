/**
 * AI logging pipeline: model output → matched foods → clarifying questions → draft intake.
 * Draft state lives in nutrition_intake.pending_json until the user answers or accepts defaults.
 */
import type { Env, User } from '../env';
import { PIPELINE_VERSION, PROMPT_VERSION, type ModelOutput, type QuestionEffect } from './ai';
import { getFood, type FoodRecord } from './foods';
import { HttpError, nowIso } from './ids';
import { createIntake, itemStatements, refreshConfidence, type EstimationMethod, type MealType, type ResolvedItem, type Source } from './intake';
import { ESTIMATE_CONFIDENCE_CAP, matchFood } from './matcher';
import type { Settings } from './settings';
import { toGrams } from './units';

export interface BaseItem {
  name: string;
  food_id: string;
  via: string;
  amount: number;
  unit: string;
  confidence: number;
  method: EstimationMethod;
  estimated: boolean;
}

export interface StoredEffect {
  set_amount?: { amount: number; unit: string };
  add_item?: { name: string; amount: number; unit: string; food_id: string; estimated: boolean };
}

export interface PendingQuestion {
  id: string;
  item_index: number;
  text: string;
  options: string[];
  default: string;
  effects: Record<string, StoredEffect>;
  kcal_spread: number;
}

export interface Pending {
  base: BaseItem[];
  questions: PendingQuestion[];
}

const kcalPer100 = (f: FoodRecord) => f.nutrients.find((n) => n.code === 'ENERC_KCAL')?.value ?? 0;
const itemKcal = (f: FoodRecord, amount: number, unit: string) => (kcalPer100(f) * toGrams(amount, unit, f).grams) / 100;

export const SKIP_PENALTY = 0.15;

/** Resolve model items and question effects against food databases, then pick which questions to ask. */
export async function buildPending(env: Env, user: User, out: ModelOutput, settings: Settings, method: EstimationMethod): Promise<Pending> {
  const foods = new Map<string, FoodRecord>();
  const base: BaseItem[] = [];
  for (const it of out.items) {
    const m = await matchFood(env, user.id, it);
    foods.set(m.food.id, m.food);
    const estimated = m.via === 'estimate';
    base.push({
      name: it.name,
      food_id: m.food.id,
      via: m.via,
      amount: it.amount,
      unit: it.unit,
      confidence: estimated ? Math.min(it.confidence, ESTIMATE_CONFIDENCE_CAP) : it.confidence,
      method,
      estimated,
    });
  }

  const mealKcal = base.reduce((s, b) => s + itemKcal(foods.get(b.food_id)!, b.amount, b.unit), 0);
  const candidates: PendingQuestion[] = [];
  for (const q of out.questions) {
    const target = base[q.item_index];
    if (!target) continue;
    const effects: Record<string, StoredEffect> = {};
    const kcals: number[] = [];
    for (const opt of q.options) {
      const e: QuestionEffect = q.effects[opt] ?? {};
      if (e.add_item) {
        const m = await matchFood(env, user.id, e.add_item);
        foods.set(m.food.id, m.food);
        effects[opt] = {
          add_item: { name: e.add_item.name, amount: e.add_item.amount, unit: e.add_item.unit, food_id: m.food.id, estimated: m.via === 'estimate' },
        };
        kcals.push(itemKcal(foods.get(target.food_id)!, target.amount, target.unit) + itemKcal(m.food, e.add_item.amount, e.add_item.unit));
      } else if (e.set_amount) {
        effects[opt] = { set_amount: e.set_amount };
        kcals.push(itemKcal(foods.get(target.food_id)!, e.set_amount.amount, e.set_amount.unit));
      } else {
        effects[opt] = {};
        kcals.push(itemKcal(foods.get(target.food_id)!, target.amount, target.unit));
      }
    }
    const spread = Math.max(...kcals) - Math.min(...kcals);
    candidates.push({ id: q.id, item_index: q.item_index, text: q.text, options: q.options, default: q.default, effects, kcal_spread: Math.round(spread) });
  }

  // Ask only when the answer moves the meal by ~15%, or a shaky item moves it by at least 5%.
  const denom = Math.max(mealKcal, 100);
  const questions = candidates
    .filter((q) => {
      const share = q.kcal_spread / denom;
      return share >= 0.15 || (base[q.item_index]!.confidence < settings.question_confidence_threshold && share >= 0.05);
    })
    .sort((a, b) => b.kcal_spread - a.kcal_spread)
    .slice(0, settings.max_questions)
    .map((q, i) => ({ ...q, id: `q${i + 1}` }));
  return { base, questions };
}

/** Turn base items plus chosen answers into persistable items. */
export async function materialise(db: D1Database, userId: string, p: Pending, answers: Record<string, string>): Promise<ResolvedItem[]> {
  const cache = new Map<string, FoodRecord>();
  const load = async (id: string) => {
    let f = cache.get(id);
    if (!f) {
      f = (await getFood(db, userId, id)) ?? undefined;
      if (!f) throw new HttpError(409, 'a matched food is no longer available');
      cache.set(id, f);
    }
    return f;
  };
  const items = p.base.map((b) => ({ ...b }));
  const extra: ResolvedItem[] = [];
  for (const q of p.questions) {
    const answered = typeof answers[q.id] === 'string' && q.options.includes(answers[q.id]!);
    const choice = answered ? answers[q.id]! : q.default;
    const target = items[q.item_index]!;
    if (answered) target.confidence = Math.min(1, Math.max(target.confidence, 0.8));
    else target.confidence = Math.max(0, target.confidence - SKIP_PENALTY);
    const e = q.effects[choice] ?? {};
    if (e.set_amount) {
      target.amount = e.set_amount.amount;
      target.unit = e.set_amount.unit;
    }
    if (e.add_item) {
      extra.push({
        food: await load(e.add_item.food_id),
        display_name: e.add_item.name,
        amount: e.add_item.amount,
        unit: e.add_item.unit,
        confidence: answered ? 0.8 : 0.5,
        method: 'described',
        estimated: e.add_item.estimated,
      });
    }
  }
  const out: ResolvedItem[] = [];
  for (const b of items)
    out.push({
      food: await load(b.food_id),
      display_name: b.name,
      amount: b.amount,
      unit: b.unit,
      confidence: b.estimated ? Math.min(b.confidence, ESTIMATE_CONFIDENCE_CAP) : b.confidence,
      method: b.method,
      estimated: b.estimated,
    });
  return [...out, ...extra];
}

export interface DraftInput {
  source: Source;
  meal_type?: MealType;
  occurrence_at?: string;
  note?: string | null;
  raw_input_text?: string | null;
  media_r2_key?: string | null;
  model_id: string;
}

/**
 * Persist a draft. With no questions the intake is completed right away;
 * otherwise it is `in-progress` with defaults applied so totals are visible.
 */
export async function saveDraft(env: Env, user: User, input: DraftInput, out: ModelOutput, pending: Pending): Promise<string> {
  const asking = pending.questions.length > 0;
  // With open questions, show the defaults applied (capped confidence) until the user answers.
  const items = await materialise(env.DB, user.id, pending, asking ? Object.fromEntries(pending.questions.map((q) => [q.id, q.default])) : {});
  if (asking) for (const it of items) it.confidence = Math.min(it.confidence, 0.79);
  return createIntake(
    env,
    user,
    {
      source: input.source,
      status: asking ? 'in-progress' : 'completed',
      meal_type: input.meal_type ?? out.meal_type_guess ?? undefined,
      occurrence_at: input.occurrence_at,
      note: input.note,
      raw_input_text: input.raw_input_text,
      media_r2_key: input.media_r2_key,
      model_id: input.model_id,
      prompt_version: PROMPT_VERSION,
      pipeline_version: PIPELINE_VERSION,
      pending_json: asking ? JSON.stringify(pending) : null,
    },
    items,
  );
}

/** Apply answers to an in-progress draft and complete it. */
export async function applyAnswers(env: Env, user: User, intakeId: string, answers: Record<string, string>): Promise<void> {
  const row = await env.DB.prepare('SELECT status, pending_json FROM nutrition_intake WHERE id = ? AND user_id = ?')
    .bind(intakeId, user.id)
    .first<{ status: string; pending_json: string | null }>();
  if (!row) throw new HttpError(404, 'intake not found');
  if (row.status !== 'in-progress' || !row.pending_json) throw new HttpError(409, 'intake has no open questions');
  const pending = JSON.parse(row.pending_json) as Pending;
  for (const [qid, a] of Object.entries(answers)) {
    const q = pending.questions.find((x) => x.id === qid);
    if (!q) throw new HttpError(400, `unknown question ${qid}`);
    if (!q.options.includes(a)) throw new HttpError(400, `invalid answer for ${qid}`);
  }
  const items = await materialise(env.DB, user.id, pending, answers);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM intake_nutrient WHERE consumed_item_id IN (SELECT id FROM consumed_item WHERE intake_id = ?)').bind(intakeId),
    env.DB.prepare('DELETE FROM consumed_item WHERE intake_id = ?').bind(intakeId),
  ];
  items.forEach((it, i) => stmts.push(...itemStatements(env.DB, user.id, intakeId, it, i)));
  stmts.push(
    env.DB.prepare(
      `UPDATE nutrition_intake SET status = 'completed', pending_json = NULL, recorded_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(nowIso(), intakeId, user.id),
    refreshConfidence(env.DB, intakeId),
  );
  await env.DB.batch(stmts);
}
