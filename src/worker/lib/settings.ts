export interface Settings {
  day_cutoff: string;
  weight_unit: 'kg' | 'lb';
  mass_unit: 'g' | 'oz';
  question_confidence_threshold: number;
  max_questions: number;
  model_vision: string;
  model_parser: string;
  model_speech: string;
}

export const DEFAULT_SETTINGS: Settings = {
  day_cutoff: '04:00',
  weight_unit: 'kg',
  mass_unit: 'g',
  question_confidence_threshold: 0.6,
  max_questions: 2,
  model_vision: '@cf/meta/llama-4-scout-17b-16e-instruct',
  model_parser: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  model_speech: '@cf/openai/whisper-large-v3-turbo',
};

const VALIDATORS: { [K in keyof Settings]: (v: unknown) => boolean } = {
  day_cutoff: (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  weight_unit: (v) => v === 'kg' || v === 'lb',
  mass_unit: (v) => v === 'g' || v === 'oz',
  question_confidence_threshold: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  max_questions: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 2,
  model_vision: (v) => typeof v === 'string' && v.length > 0,
  model_parser: (v) => typeof v === 'string' && v.length > 0,
  model_speech: (v) => typeof v === 'string' && v.length > 0,
};

export async function getSettings(db: D1Database, userId: string): Promise<Settings> {
  const { results } = await db
    .prepare('SELECT key, value FROM settings WHERE user_id = ?')
    .bind(userId)
    .all<{ key: string; value: string }>();
  const s: Settings = { ...DEFAULT_SETTINGS };
  for (const r of results) {
    if (r.key in VALIDATORS) {
      try {
        const v = JSON.parse(r.value);
        if (VALIDATORS[r.key as keyof Settings](v)) (s as unknown as Record<string, unknown>)[r.key] = v;
      } catch {
        /* ignore corrupt values; default applies */
      }
    }
  }
  return s;
}

/** Validate and persist a partial settings update. Returns the list of rejected keys. */
export async function putSettings(db: D1Database, userId: string, patch: Record<string, unknown>): Promise<string[]> {
  const rejected: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in VALIDATORS) || !VALIDATORS[k as keyof Settings](v)) {
      rejected.push(k);
      continue;
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
           ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .bind(userId, k, JSON.stringify(v)),
    );
  }
  if (rejected.length === 0 && stmts.length) await db.batch(stmts);
  return rejected;
}
