/**
 * Read a nutrition label (or a restaurant app's nutrition screen) into a draft custom food.
 * The draft is shown to the user to check and edit; nothing is saved here.
 */
import type { Env } from '../env';
import { b64, extractJson, gatewayOpts, LABEL_NUTRIENTS, modelOptions, responseText, validLabel, type PhotoInput } from './ai';
import { LABEL_CODES, labelServingGrams } from './matcher';

export interface LabelDraft {
  name: string;
  brand: string | null;
  serving_amount: number;
  serving_unit: string;
  /** Weight (or volume in ml) of one serving: printed, converted, or the model's estimate. */
  serving_grams: number | null;
  /** True when serving_grams is the model's guess rather than printed on the label. */
  serving_grams_estimated: boolean;
  /** Values for one serving, keyed by nutrient code. */
  per_serving: Record<string, number>;
}

export class LabelReadError extends Error {}

export function labelPrompt(hint?: string): string {
  return `The image(s) show a food's nutrition information: a Nutrition Facts panel on a package, or a screenshot of a
restaurant or coffee-shop app or website (e.g. a drink's nutrition screen). Transcribe it exactly.${
    hint ? `\nThe user calls this food: "${hint}".` : ''
  }
Return ONLY a JSON object, no prose:
{
  "name": "Pistachio Cream Cold Brew, Grande",  // product name with flavor and size; the user's name if given
  "brand": "Starbucks",                          // brand or restaurant if shown, else null
  "serving_amount": 1, "serving_unit": "cup",    // the serving size as printed (amount and unit)
  "serving_grams": 473,                          // grams or ml of one serving: as printed (e.g. "1 cup (240mL)" -> 240),
                                                 // else your best estimate of its weight
  "serving_grams_printed": true,                 // false when serving_grams is your estimate
  "kcal": 250, "protein": 3, "fat": 12, "carbs": 31, "fiber": 0, "sugars": 30, "sat_fat": 8, "sodium": 125
}
Rules:
- Numbers are for ONE serving as printed, never per container and never per 100 g unless that is all that's printed.
- sodium is in mg. Use 0 only when the label prints 0; leave a field out when it isn't shown.
- Never fill a value from memory: only what you can read.`;
}

export function validateDraft(raw: unknown, hint?: string): LabelDraft {
  const o = extractJson(raw) as Record<string, unknown> | null;
  const l = o && validLabel(o);
  if (!o || !l) throw new LabelReadError("Couldn't read a serving size and calories from that photo.");
  const name = (hint?.trim() || (typeof o.name === 'string' ? o.name.trim() : '')).slice(0, 120);
  // A unit we can convert ("355 ml", "1.5 oz") beats whatever the model wrote.
  const converted = labelServingGrams(l);
  const given = typeof o.serving_grams === 'number' && o.serving_grams > 0 && o.serving_grams < 5000 ? o.serving_grams : null;
  const grams = converted ?? given;
  const per_serving: Record<string, number> = { ENERC_KCAL: l.kcal };
  for (const k of LABEL_NUTRIENTS) if (l[k] != null) per_serving[LABEL_CODES[k]] = l[k]!;
  return {
    name,
    brand: typeof o.brand === 'string' && o.brand.trim() ? o.brand.trim().slice(0, 60) : null,
    serving_amount: l.serving_amount,
    serving_unit: l.serving_unit,
    serving_grams: grams ? Math.round(grams * 10) / 10 : null,
    serving_grams_estimated: !converted && (!given || o.serving_grams_printed === false),
    per_serving,
  };
}

export async function readLabel(env: Env, model: string, photos: PhotoInput[], hint?: string): Promise<LabelDraft> {
  const prompt = labelPrompt(hint);
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = attempt ? `${prompt}\nYour previous answer was not valid. Reply with the JSON object only.` : prompt;
    const r = await env.AI.run(
      model as Parameters<Ai['run']>[0],
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text }, ...photos.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${b64(p.bytes)}` } }))],
          },
        ],
        temperature: 0.1,
        ...modelOptions(model),
      } as never,
      gatewayOpts(env) as never,
    );
    try {
      return validateDraft(responseText(r), hint);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof LabelReadError ? last : new LabelReadError("Couldn't read that label.");
}
