/**
 * Model calls. Every call goes through AI Gateway; model ids come from settings.
 * Models propose foods and portions only; nutrient numbers come from food databases.
 */
import type { Env } from '../env';

export const PROMPT_VERSION = 'parse-v1';
export const PIPELINE_VERSION = '2.0';

export interface QuestionEffect {
  set_amount?: { amount: number; unit: string };
  add_item?: { name: string; amount: number; unit: string; search_terms?: string[] };
}

export interface ModelItem {
  name: string;
  amount: number;
  unit: string;
  confidence: number;
  search_terms: string[];
  barcode: string | null;
  /** Rough per-100 g estimate used only when no database match exists. */
  estimate_per_100g?: { kcal?: number; protein?: number; fat?: number; carbs?: number };
}

export interface ModelQuestion {
  id: string;
  item_index: number;
  text: string;
  options: string[];
  default: string;
  effects: Record<string, QuestionEffect>;
}

export interface ModelOutput {
  meal_type_guess: 'breakfast' | 'lunch' | 'dinner' | 'snack' | null;
  items: ModelItem[];
  questions: ModelQuestion[];
}

const SCHEMA_TEXT = `Return ONLY a JSON object, no prose:
{
  "meal_type_guess": "breakfast" | "lunch" | "dinner" | "snack" | null,
  "items": [{
    "name": "grilled chicken breast",          // generic food name, cooking method included
    "amount": 150, "unit": "g",                // unit: g, ml, cup, tbsp, tsp, oz, slice, piece, small, medium, large, serving, can, bottle
    "confidence": 0.7,                          // 0-1: how sure you are of food AND amount
    "search_terms": ["chicken breast roasted"],// 1-3 phrases for the USDA FoodData Central search
    "barcode": null,                            // GTIN if visible/stated, else null
    "estimate_per_100g": {"kcal": 165, "protein": 31, "fat": 3.6, "carbs": 0}
  }],
  "questions": [{
    "id": "q1", "item_index": 0,
    "text": "Cooked in oil or butter?",
    "options": ["None", "1 tsp oil", "1 tbsp oil", "Butter"],
    "default": "1 tsp oil",
    "effects": {
      "None": {},
      "1 tsp oil": {"add_item": {"name": "olive oil", "amount": 1, "unit": "tsp", "search_terms": ["olive oil"]}},
      "1 tbsp oil": {"add_item": {"name": "olive oil", "amount": 1, "unit": "tbsp", "search_terms": ["olive oil"]}},
      "Butter": {"add_item": {"name": "butter", "amount": 1, "unit": "tsp", "search_terms": ["butter salted"]}}
    }
  }]
}`;

const RULES = `Rules:
- List every distinct food or drink as its own item. Split mixed plates into components when sensible.
- Prefer grams for solid food you can estimate visually and ml for drinks; use household units when the user states them.
- Name drinks with their size and milk when known (e.g. "latte, whole milk", 350 ml).
- Ask at most 2 questions, only where the answer could change the meal's calories by about 15% or more
  (cooking fat, portion size, dressing or sauce, drink size, milk type). Fewer is better; zero is fine.
- Each question has 2-4 short tap options, a default that is one of the options, and an "effects" entry for every option.
  An effect is {} (no change), {"set_amount": {"amount": 250, "unit": "g"}} for the question's item,
  or {"add_item": {...}} to add something like oil or sauce. For portion questions put grams in the label, e.g. "Large (250 g)".
- Never invent brands. Do not include nutrition totals beyond estimate_per_100g.`;

export function parserMessages(text: string, localTime: string) {
  return [
    {
      role: 'system',
      content: `You turn a meal description into structured food items for a nutrition log. The user's local time is ${localTime}.\n${RULES}\n${SCHEMA_TEXT}`,
    },
    { role: 'user', content: text },
  ];
}

export function visionPrompt(localTime: string, hint?: string) {
  return `Identify every food and drink in this photo and estimate each portion. The user's local time is ${localTime}.${
    hint ? ` The user added: "${hint}".` : ''
  }\n${RULES}\n${SCHEMA_TEXT}`;
}

// ---------- validation ----------

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const clamp01 = (n: unknown, d = 0.5) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d);

export class ModelOutputError extends Error {}

/** Pull the first JSON object out of a model response (string or already-parsed). */
export function extractJson(raw: unknown): unknown {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') throw new ModelOutputError('empty response');
  const s = raw.replace(/```(?:json)?/g, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ModelOutputError('no JSON object in response');
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw new ModelOutputError(`invalid JSON: ${(e as Error).message}`);
  }
}

function validEffect(e: unknown): QuestionEffect | null {
  if (!e || typeof e !== 'object') return {};
  const o = e as Record<string, any>;
  if (o.set_amount) {
    const { amount, unit } = o.set_amount;
    if (typeof amount === 'number' && amount > 0 && typeof unit === 'string' && unit) return { set_amount: { amount, unit } };
    return null;
  }
  if (o.add_item) {
    const a = o.add_item;
    if (typeof a.name === 'string' && a.name && typeof a.amount === 'number' && a.amount > 0 && typeof a.unit === 'string')
      return {
        add_item: {
          name: a.name,
          amount: a.amount,
          unit: a.unit,
          search_terms: Array.isArray(a.search_terms) ? a.search_terms.filter((t: unknown) => typeof t === 'string').slice(0, 3) : [a.name],
        },
      };
    return null;
  }
  return {};
}

/** Validate and normalise model output against the fixed schema. Throws ModelOutputError. */
export function validateOutput(raw: unknown): ModelOutput {
  const o = extractJson(raw) as Record<string, any>;
  if (!o || !Array.isArray(o.items)) throw new ModelOutputError('items must be an array');
  const items: ModelItem[] = [];
  for (const it of o.items.slice(0, 20)) {
    if (!it || typeof it.name !== 'string' || !it.name.trim()) throw new ModelOutputError('item.name is required');
    const amount = typeof it.amount === 'number' ? it.amount : Number(it.amount);
    if (!(amount > 0)) throw new ModelOutputError(`item ${it.name}: amount must be > 0`);
    const est = it.estimate_per_100g && typeof it.estimate_per_100g === 'object' ? it.estimate_per_100g : undefined;
    items.push({
      name: it.name.trim(),
      amount,
      unit: typeof it.unit === 'string' && it.unit.trim() ? it.unit.trim() : 'g',
      confidence: clamp01(it.confidence),
      search_terms: (Array.isArray(it.search_terms) ? it.search_terms : [])
        .filter((t: unknown): t is string => typeof t === 'string' && !!t.trim())
        .slice(0, 3),
      barcode: typeof it.barcode === 'string' && /^\d{8,14}$/.test(it.barcode) ? it.barcode : null,
      ...(est
        ? {
            estimate_per_100g: Object.fromEntries(
              ['kcal', 'protein', 'fat', 'carbs'].filter((k) => typeof est[k] === 'number' && est[k] >= 0).map((k) => [k, est[k]]),
            ),
          }
        : {}),
    });
  }
  const questions: ModelQuestion[] = [];
  for (const [i, q] of (Array.isArray(o.questions) ? o.questions : []).entries()) {
    if (!q || typeof q.text !== 'string' || !Array.isArray(q.options)) continue;
    const options = q.options.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()).slice(0, 4);
    if (options.length < 2) continue;
    const idx = Number.isInteger(q.item_index) && q.item_index >= 0 && q.item_index < items.length ? q.item_index : 0;
    const effects: Record<string, QuestionEffect> = {};
    let ok = true;
    for (const opt of options) {
      const e = validEffect(q.effects?.[opt]);
      if (e === null) ok = false;
      else effects[opt] = e;
    }
    if (!ok || !items.length) continue;
    questions.push({
      id: typeof q.id === 'string' && q.id ? q.id : `q${i + 1}`,
      item_index: idx,
      text: q.text.trim(),
      options,
      default: options.includes(q.default) ? q.default : options[0]!,
      effects,
    });
  }
  return {
    meal_type_guess: MEALS.includes(o.meal_type_guess) ? o.meal_type_guess : null,
    items,
    questions,
  };
}

// ---------- calls ----------

function responseText(r: unknown): unknown {
  if (r && typeof r === 'object' && 'response' in r) return (r as { response: unknown }).response;
  return r;
}

const gatewayOpts = (env: Env) => (env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {});

async function withRetry(call: (attempt: number) => Promise<unknown>): Promise<ModelOutput> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return validateOutput(responseText(await call(attempt)));
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ModelOutputError)) throw e;
    }
  }
  throw lastErr;
}

const RETRY_NOTE = 'Your previous answer was not valid JSON matching the schema. Reply with the JSON object only.';

export function parseText(env: Env, model: string, text: string, localTime: string): Promise<ModelOutput> {
  return withRetry((attempt) => {
    const messages = parserMessages(text, localTime);
    if (attempt) messages.push({ role: 'user', content: RETRY_NOTE });
    return env.AI.run(
      model as Parameters<Ai['run']>[0],
      { messages, max_tokens: 1500, temperature: 0.2, response_format: { type: 'json_object' } } as never,
      gatewayOpts(env) as never,
    );
  });
}

export function parsePhoto(env: Env, model: string, image: Uint8Array, mime: string, localTime: string, hint?: string) {
  const prompt = visionPrompt(localTime, hint);
  return withRetry((attempt) => {
    const text = attempt ? `${prompt}\n${RETRY_NOTE}` : prompt;
    // Llama 3.2 Vision takes raw bytes; chat-style vision models (Llama 4 Scout, etc.) take a data URL.
    const inputs = /llama-3\.2-11b-vision/.test(model)
      ? { prompt: text, image: [...image], max_tokens: 1500, temperature: 0.2 }
      : {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${b64(image)}` } },
              ],
            },
          ],
          max_tokens: 1500,
          temperature: 0.2,
        };
    return env.AI.run(model as Parameters<Ai['run']>[0], inputs as never, gatewayOpts(env) as never);
  });
}

export async function transcribe(env: Env, model: string, audio: Uint8Array): Promise<string> {
  const isTurbo = /whisper-large-v3-turbo/.test(model);
  const r = (await env.AI.run(
    model as Parameters<Ai['run']>[0],
    (isTurbo ? { audio: b64(audio), language: 'en', vad_filter: true } : { audio: [...audio] }) as never,
    gatewayOpts(env) as never,
  )) as { text?: string };
  return (r.text ?? '').trim();
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
