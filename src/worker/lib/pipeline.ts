/**
 * AI logging pipeline: model output → matched foods → clarifying questions → draft intake.
 * Draft state lives in nutrition_intake.pending_json until the user answers or accepts defaults.
 */
import type { Env, User } from '../env';
import { PIPELINE_VERSION, PROMPT_VERSION, type ModelOutput, type QuestionEffect } from './ai';
import { getFood, type FoodRecord } from './foods';
import { HttpError, nowIso } from './ids';
import { itemStatements, refreshConfidence, type EstimationMethod, type MealType, type ResolvedItem } from './intake';
import { ESTIMATE_CONFIDENCE_CAP, matchFood, type MatchInfo } from './matcher';
import { mergeDraft, resolveTarget, type MergeSpec } from './merge';
import type { Settings } from './settings';
import { countUnit, normaliseUnit, toGrams } from './units';

export interface BaseItem {
  name: string;
  food_id: string;
  via: string;
  amount: number;
  unit: string;
  confidence: number;
  method: EstimationMethod;
  estimated: boolean;
  match?: MatchInfo;
  /** Model's weight estimate, used instead of the generic size table for household units. */
  grams_estimate?: number;
}

export interface StoredEffect {
  set_amount?: { amount: number; unit: string };
  add_item?: { name: string; amount: number; unit: string; food_id: string; estimated: boolean; match?: MatchInfo };
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
  /** Where the items go once the questions are answered (see merge.ts). */
  merge?: MergeSpec | null;
}

const kcalPer100 = (f: FoodRecord) => f.nutrients.find((n) => n.code === 'ENERC_KCAL')?.value ?? 0;
const itemKcal = (f: FoodRecord, amount: number, unit: string) => (kcalPer100(f) * toGrams(amount, unit, f).grams) / 100;

export const SKIP_PENALTY = 0.15;

/** Resolve model items and question effects against food databases, then pick which questions to ask. */
export async function buildPending(env: Env, user: User, out: ModelOutput, settings: Settings, method: EstimationMethod): Promise<Pending> {
  const foods = new Map<string, FoodRecord>();
  // Match every item (and every add-on in question options) in parallel; these are independent lookups.
  // Printed label values only exist in photos; from text or voice they'd be the model's memory.
  const matches = await Promise.all(out.items.map((it) => matchFood(env, user.id, method === 'photo-estimate' ? it : { ...it, label: null })));
  const base: BaseItem[] = out.items.map((it, i) => {
    const m = matches[i]!;
    foods.set(m.food.id, m.food);
    const estimated = m.via === 'estimate';
    return {
      name: it.name,
      food_id: m.food.id,
      via: m.via,
      amount: it.amount,
      unit: it.unit,
      // The model's confidence covers the amount; the match score covers whether it's the right food.
      confidence: Math.min(it.confidence, m.matchConfidence, estimated ? ESTIMATE_CONFIDENCE_CAP : 1),
      // Values from the actual product (barcode or printed label) count as label-based.
      method: m.fromPackage ? 'label' : method,
      estimated,
      match: m.match,
      ...(it.grams ? { grams_estimate: it.grams } : {}),
    };
  });
  const addOns = new Map<string, ReturnType<typeof matchFood>>();
  for (const q of out.questions)
    for (const e of Object.values(q.effects))
      if (e.add_item) {
        const key = (e.add_item.search_terms?.[0] ?? e.add_item.name).toLowerCase();
        if (!addOns.has(key)) addOns.set(key, matchFood(env, user.id, e.add_item));
      }
  const addOnFood = async (a: NonNullable<QuestionEffect['add_item']>) => {
    const m = await addOns.get((a.search_terms?.[0] ?? a.name).toLowerCase())!;
    foods.set(m.food.id, m.food);
    return m;
  };

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
        const m = await addOnFood(e.add_item);
        effects[opt] = {
          add_item: { name: e.add_item.name, amount: e.add_item.amount, unit: e.add_item.unit, food_id: m.food.id, estimated: m.via === 'estimate', match: m.match },
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
        // An answered question confirms the add-on, but an AI-estimated food stays capped.
        confidence: Math.min(answered ? 0.8 : 0.5, e.add_item.estimated ? ESTIMATE_CONFIDENCE_CAP : 1),
        method: 'described',
        estimated: e.add_item.estimated,
        match: e.add_item.match,
      });
    }
  }
  const out: ResolvedItem[] = [];
  for (const b of items) {
    const food = await load(b.food_id);
    // "1 medium croissant" with no portion data would hit the generic table (medium = 150 g);
    // the model's own weight estimate is much closer. Scale it if a question changed the amount.
    // "3 Oreos" logged as pieces reads as 3 cookies, in the food's own word for one.
    const unit = (normaliseUnit(b.unit) === 'piece' && countUnit(food.portions)) || b.unit;
    const conv = toGrams(b.amount, unit, food);
    const base = p.base.find((x) => x.food_id === b.food_id && x.name === b.name);
    const grams =
      conv.method === 'generic' && b.grams_estimate && base && base.unit === b.unit ? (b.grams_estimate * b.amount) / base.amount : undefined;
    out.push({
      food,
      display_name: b.name,
      amount: b.amount,
      unit,
      confidence: b.estimated ? Math.min(b.confidence, ESTIMATE_CONFIDENCE_CAP) : b.confidence,
      method: b.method,
      estimated: b.estimated,
      match: b.match,
      ...(grams ? { grams } : {}),
    });
  }
  return [...out, ...extra];
}

/**
 * Fill a `preparation` intake with matched items. With no questions it is completed;
 * otherwise it becomes `in-progress` with defaults applied so totals are visible.
 */
export async function finishDraft(
  env: Env,
  user: User,
  intakeId: string,
  input: { model_id: string; raw_input_text: string | null; meal_type?: MealType },
  pending: Pending,
): Promise<void> {
  const asking = pending.questions.length > 0;
  const items = await materialise(env.DB, user.id, pending, asking ? Object.fromEntries(pending.questions.map((q) => [q.id, q.default])) : {});
  if (asking) for (const it of items) it.confidence = Math.min(it.confidence, 0.79);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM intake_nutrient WHERE consumed_item_id IN (SELECT id FROM consumed_item WHERE intake_id = ?)').bind(intakeId),
    env.DB.prepare('DELETE FROM consumed_item WHERE intake_id = ?').bind(intakeId),
  ];
  items.forEach((it, i) => stmts.push(...itemStatements(env.DB, user.id, intakeId, it, i)));
  stmts.push(
    env.DB.prepare(
      `UPDATE nutrition_intake SET status = ?, meal_type = COALESCE(?, meal_type), raw_input_text = ?, model_id = ?, prompt_version = ?,
       pipeline_version = ?, pending_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND user_id = ? AND status = 'preparation'`,
    ).bind(
      asking ? 'in-progress' : 'completed',
      input.meal_type ?? null,
      input.raw_input_text,
      input.model_id,
      PROMPT_VERSION,
      PIPELINE_VERSION,
      asking ? JSON.stringify(pending) : null,
      intakeId,
      user.id,
    ),
    refreshConfidence(env.DB, intakeId),
  );
  await env.DB.batch(stmts);
}

/** Apply answers to an in-progress draft and complete it. Returns the id of the meal now holding the items. */
export async function applyAnswers(env: Env, user: User, intakeId: string, answers: Record<string, string>): Promise<string> {
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
  const target = await resolveTarget(env, user.id, intakeId, pending.merge);
  return target ? mergeDraft(env, user.id, intakeId, target) : intakeId;
}
