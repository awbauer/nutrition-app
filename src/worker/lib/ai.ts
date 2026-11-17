/**
 * Model calls. Every call goes through AI Gateway; model ids come from settings.
 * Models propose foods and portions only; nutrient numbers come from food databases.
 */
import type { Env } from '../env';

export const PROMPT_VERSION = 'parse-v4';
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
  /** The model's estimate of the item's weight; used when a household unit has no known portion size. */
  grams?: number;
  search_terms: string[];
  barcode: string | null;
  brand?: string | null;
  /** Nutrition printed on the package, per serving (transcribed, not estimated). */
  label?: LabelFacts | null;
  /** Rough per-100 g estimate used only when no database match exists. */
  estimate_per_100g?: { kcal?: number; protein?: number; fat?: number; carbs?: number };
}

export interface LabelFacts {
  serving_amount: number;
  serving_unit: string;
  kcal: number;
  protein?: number;
  fat?: number;
  carbs?: number;
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
    "grams": 150,                               // your best estimate of the item's weight in grams, always
    "confidence": 0.7,                          // 0-1: how sure you are of food AND amount
    "search_terms": ["chicken breast roasted"],// 1-3 phrases for the USDA FoodData Central search
    "brand": null,                              // brand if stated or printed on the package, e.g. "fairlife", else null
    "barcode": null,                            // all barcode digits if fully legible or stated, else null
    "label": null,                              // packaged foods only: numbers PRINTED on the package, else null:
                                                // {"serving_amount": 340, "serving_unit": "ml", "kcal": 150, "protein": 30, "fat": 2.5, "carbs": 4}
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
- Packaged products: read every visible word on the package (brand, product line, flavor, size, nutrition facts, barcode).
  Name the item with brand, product and flavor (e.g. "fairlife nutrition plan chocolate protein shake"), set "brand",
  and use the package size as the amount when one package is being consumed.
  Fill "label" ONLY with numbers you can actually read on the package, for one serving; never fill it from memory.
- If an amount is ambiguous in a way that changes calories a lot (e.g. "1/4 yogurt": a quarter cup or a quarter of a tub?),
  make your best guess and ask about it.
- Never invent brands. Do not include nutrition totals beyond estimate_per_100g and printed label values.`;

/**
 * The user's own recipes (batches they cooked). Listed so a portion of one is logged as that
 * recipe, by its exact name, instead of being broken into guessed ingredients.
 */
export interface PromptContext {
  /** Names of the user's saved recipes. */
  recipes?: string[];
  /** The input describes a batch being cooked (a recipe's ingredients), not something eaten. */
  batch?: boolean;
}

const BATCH_RULES = `
This is NOT a meal. The user is describing a batch they cooked (a recipe), to be eaten in portions later.
- List every ingredient that went into the batch as its own item, with the FULL amount used for the whole batch, uncooked
  as it went in (e.g. "1 lb ground beef" -> amount 1, unit "lb", grams 454). Do not divide into servings.
- Include cooking fats, sauces and liquids that stayed in the dish. Leave out water unless it's a soup or stew base.
- Ask NO questions: "questions" must be []. meal_type_guess is null.`;

function contextRules(ctx: PromptContext = {}): string {
  return (ctx.batch ? BATCH_RULES : '') + recipeRules(ctx.recipes);
}

export function recipeRules(recipes: string[] = []): string {
  if (!recipes.length) return '';
  return `\nThe user has saved these home-made recipes: ${recipes.map((r) => JSON.stringify(r)).join(', ')}.
- If they ate one of them (e.g. "a bowl of my chili", "leftover lasagna"), log it as ONE item named exactly as the recipe is written,
  not as its ingredients. Amount: unit "serving" for servings or bowls/plates (1 bowl = 1 serving unless they say otherwise),
  unit "batch" for a fraction of the whole batch (a quarter of the pot = 0.25 batch), or "g" when they give a weight.
- Only use a recipe when it clearly matches; otherwise treat the food normally.`;
}

export function parserMessages(text: string, localTime: string, ctx: PromptContext = {}) {
  return [
    {
      role: 'system',
      content: `You turn a meal description into structured food items for a nutrition log. The user's local time is ${localTime}.\n${RULES}${contextRules(ctx)}\n${SCHEMA_TEXT}`,
    },
    { role: 'user', content: text },
  ];
}

export function visionPrompt(localTime: string, hint?: string, ctx: PromptContext = {}, photoCount = 1) {
  const what = ctx.batch
    ? 'Identify every ingredient shown (a batch being cooked, or its ingredients and packages) and estimate each amount.'
    : 'Identify every food and drink shown and estimate each portion.';
  return `${photoCount > 1 ? `${MULTI_PHOTO_INTRO(photoCount)} ${what}` : `${what.replace(' shown', ' shown in this photo')}`} The user's local time is ${localTime}.${
    hint ? ` The user added: "${hint}".` : ''
  }\n${RULES}${photoCount > 1 ? MULTI_PHOTO_RULES : ''}${contextRules(ctx)}\n${SCHEMA_TEXT}`;
}

const MULTI_PHOTO_INTRO = (n: number) =>
  `These ${n} photos are all of ONE meal, taken together: different plates, angles, close-ups, drinks, packages or nutrition labels. Look at all of them before answering.`;

const MULTI_PHOTO_RULES = `
- Review the photos as a whole and return one combined list. Count each food once, even when it shows up in several photos
  (the same plate from two angles is one plate, not two).
- Use what one photo shows to inform another: a package or nutrition label in one photo names and sizes the food on the plate in another.
- Different servings of the same food that are clearly separate (two different cans, two plates) are separate items or one item with the summed amount.`;

// ---------- validation ----------

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const clamp01 = (n: unknown, d = 0.5) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d);

export class ModelOutputError extends Error {}

/** Remove line and block comments, and trailing commas, that models copy from the example schema. */
export function relaxJson(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      out += ch;
      if (ch === '\\') out += s[++i] ?? '';
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Pull the first JSON object out of a model response (string or already-parsed). */
export function extractJson(raw: unknown): unknown {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') throw new ModelOutputError('empty response');
  const s = raw.replace(/```(?:json)?/g, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ModelOutputError('no JSON object in response');
  const body = s.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    try {
      return JSON.parse(relaxJson(body));
    } catch (e) {
      throw new ModelOutputError(`invalid JSON: ${(e as Error).message}`);
    }
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
      ...(typeof it.grams === 'number' && it.grams > 0 && it.grams < 5000 ? { grams: it.grams } : {}),
      search_terms: (Array.isArray(it.search_terms) ? it.search_terms : [])
        .filter((t: unknown): t is string => typeof t === 'string' && !!t.trim())
        .slice(0, 3),
      barcode: normaliseBarcode(it.barcode),
      brand: typeof it.brand === 'string' && it.brand.trim() ? it.brand.trim().slice(0, 60) : null,
      label: validLabel(it.label),
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

/** GTIN check digit (EAN-8, UPC-A, EAN-13, GTIN-14): catches a single misread digit. */
export function validGtin(digits: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(digits)) return false;
  const body = digits.slice(0, -1).split('').reverse();
  const sum = body.reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/** Keep only barcodes that pass the check digit; a misread one would look up the wrong product. */
function normaliseBarcode(b: unknown): string | null {
  const digits = typeof b === 'string' || typeof b === 'number' ? String(b).replace(/\D/g, '') : '';
  return validGtin(digits) ? digits : null;
}

function validLabel(l: unknown): LabelFacts | null {
  if (!l || typeof l !== 'object') return null;
  const o = l as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined);
  const serving = num(o.serving_amount);
  const kcal = num(o.kcal);
  const unit = typeof o.serving_unit === 'string' ? o.serving_unit.trim().toLowerCase() : '';
  if (!serving || serving <= 0 || kcal === undefined || !unit) return null;
  const out: LabelFacts = { serving_amount: serving, serving_unit: unit, kcal };
  for (const k of ['protein', 'fat', 'carbs'] as const) {
    const v = num(o[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------- calls ----------

/** Workers AI returns `{response}` for most models and OpenAI-style `{choices}` for others. */
function responseText(r: unknown): unknown {
  if (r && typeof r === 'object') {
    if ('response' in r) return (r as { response: unknown }).response;
    const c = (r as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    if (c != null) return c;
  }
  return r;
}

/**
 * Per-model generation options. Reasoning models spend tokens thinking before they answer,
 * so they need a bigger budget and low effort, or the JSON never arrives.
 */
export function modelOptions(model: string): Record<string, unknown> {
  if (/inkling|deepseek|gemma-4|kimi|glm/.test(model)) return { max_tokens: 8000, reasoning_effort: 'low' };
  if (/qwen3/.test(model)) return { max_tokens: 8000, chat_template_kwargs: { enable_thinking: false } };
  return { max_tokens: 1500 };
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

/** Workers AI 3040: the model has no free capacity right now. Transient, and specific to that model. */
export function isCapacityError(e: unknown): boolean {
  return e instanceof Error && /\b3040\b|capacity temporarily exceeded/i.test(e.message);
}

/** Second-choice models, used only when the configured one is out of capacity. */
export const FALLBACK_MODELS = {
  vision: '@cf/meta/llama-4-scout-17b-16e-instruct',
  parser: '@cf/meta/llama-4-scout-17b-16e-instruct',
} as const;

/**
 * Runs `call` with `model`; if Workers AI says that model is out of capacity, runs it once more
 * with `fallback`. Returns the output and the model that produced it. If the fallback fails too,
 * the original capacity error is thrown so the caller can retry later.
 */
export async function withCapacityFallback(
  model: string,
  fallback: string,
  call: (model: string) => Promise<ModelOutput>,
): Promise<{ out: ModelOutput; model: string }> {
  try {
    return { out: await call(model), model };
  } catch (e) {
    if (!isCapacityError(e) || fallback === model) throw e;
    console.warn('model out of capacity, falling back', model, '->', fallback);
    try {
      return { out: await call(fallback), model: fallback };
    } catch (e2) {
      console.error('fallback model failed', fallback, e2);
      throw e;
    }
  }
}

const RETRY_NOTE = 'Your previous answer was not valid JSON matching the schema. Reply with the JSON object only.';

export function parseText(env: Env, model: string, text: string, localTime: string, ctx: PromptContext = {}): Promise<ModelOutput> {
  return withRetry((attempt) => {
    const messages = parserMessages(text, localTime, ctx);
    if (attempt) messages.push({ role: 'user', content: RETRY_NOTE });
    return env.AI.run(
      model as Parameters<Ai['run']>[0],
      { messages, temperature: 0.2, response_format: { type: 'json_object' }, ...modelOptions(model) } as never,
      gatewayOpts(env) as never,
    );
  });
}

export interface PhotoInput {
  bytes: Uint8Array;
  mime: string;
}

/** At most this many photos per meal: enough for plates, drinks and labels without blowing the model's context. */
export const MAX_PHOTOS = 6;

/** Llama 3.2 Vision takes a single raw image; chat-style vision models (Inkling, Llama 4 Scout, …) take several data URLs. */
const singleImageModel = (model: string) => /llama-3\.2-11b-vision/.test(model);

/**
 * Read one meal from its photos. Models that accept several images see them all in one request, so
 * they can de-duplicate across angles and use a label in one photo for a plate in another.
 */
export async function parsePhotos(env: Env, model: string, photos: PhotoInput[], localTime: string, hint?: string, ctx: PromptContext = {}): Promise<ModelOutput> {
  if (!photos.length) throw new ModelOutputError('no photos');
  if (photos.length === 1 || !singleImageModel(model)) {
    const prompt = visionPrompt(localTime, hint, ctx, photos.length);
    return withRetry((attempt) => {
      const text = attempt ? `${prompt}\n${RETRY_NOTE}` : prompt;
      const inputs = singleImageModel(model)
        ? { prompt: text, image: [...photos[0]!.bytes], max_tokens: 1500, temperature: 0.2 }
        : {
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text },
                  ...photos.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${b64(p.bytes)}` } })),
                ],
              },
            ],
            temperature: 0.2,
            ...modelOptions(model),
          };
      return env.AI.run(model as Parameters<Ai['run']>[0], inputs as never, gatewayOpts(env) as never);
    });
  }
  // A single-image model can't see them together: read each photo on its own and combine.
  // It can't de-duplicate across photos, so a food shown twice may be listed twice.
  const outs: ModelOutput[] = [];
  for (const p of photos) outs.push(await parsePhotos(env, model, [p], localTime, hint, ctx));
  return combineOutputs(outs);
}

/** Concatenate several outputs into one, re-pointing questions at their items; at most 2 questions overall. */
export function combineOutputs(outs: ModelOutput[]): ModelOutput {
  const items: ModelItem[] = [];
  const questions: ModelQuestion[] = [];
  for (const [n, o] of outs.entries()) {
    const offset = items.length;
    items.push(...o.items);
    for (const q of o.questions) questions.push({ ...q, id: `p${n + 1}${q.id}`, item_index: q.item_index + offset });
  }
  return {
    meal_type_guess: outs.find((o) => o.meal_type_guess)?.meal_type_guess ?? null,
    items: items.slice(0, 20),
    questions: questions.filter((q) => q.item_index < 20).slice(0, 2),
  };
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
