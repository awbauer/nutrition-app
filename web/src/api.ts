import { holdUpdates } from './update';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const release = method === 'GET' ? () => {} : holdUpdates();
  try {
    return await send<T>(method, path, body);
  } finally {
    release();
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, init);
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
};

// ---- types mirrored from the Worker ----
/** A starred food (GET /foods/favorites): logged by this name and amount. */
export interface Favorite {
  id: string;
  name: string;
  food_id: string;
  amount: number;
  unit: string;
  grams: number;
  kcal: number | null;
}
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export interface Portion {
  label: string;
  unit: string;
  amount: number;
  grams: number;
}
export interface Nutrient {
  code: string;
  usdaId: number | null;
  value: number;
  unit: string;
}
export interface Food {
  id: string;
  source: string;
  source_id: string | null;
  name: string;
  brand: string | null;
  data_type: string | null;
  category: string | null;
  default_serving_grams: number | null;
  portions: Portion[];
  nutrients: Nutrient[];
  /** Present on search results you've eaten before. */
  history?: { names: string[]; times: number; last_at: string };
}
/** FatSecret search result: same shape as a USDA hit. */
export type FatSecretHit = Omit<UsdaHit, 'source'> & { source: 'fatsecret' };
export interface UsdaHit {
  source: 'usda';
  sourceId: string;
  name: string;
  brand: string | null;
  dataType: string;
  defaultServingGrams: number | null;
  portions: Portion[];
  nutrients: Nutrient[];
}
export interface Item {
  id: string;
  food_id: string | null;
  display_name: string;
  amount_value: number;
  amount_unit: string;
  grams: number;
  confidence: number;
  estimation_method: string;
  estimated: boolean;
  fdc_id: string | null;
  food_source: string | null;
  food_name: string | null;
  food_data_type: string | null;
  has_match_details: boolean;
  check_match: boolean;
  nutrients: Record<string, number>;
}

export interface MatchCandidate {
  fdc_id?: string;
  fatsecret_id?: string;
  food_id?: string;
  source: string;
  name: string;
  brand: string | null;
  data_type: string | null;
  kcal_100g: number | null;
  protein_100g: number | null;
  score: number;
  notes: string[];
}

export interface MatchInfo {
  query: string;
  via: 'alias' | 'favorite' | 'custom' | 'history' | 'cache' | 'barcode' | 'label' | 'usda' | 'fatsecret' | 'off' | 'estimate';
  estimate_kcal_100g: number | null;
  candidates: MatchCandidate[];
  chosen: string | null;
  lookup_error?: string;
}

export interface ItemDetail {
  item: Item;
  intake_id: string;
  food: (Food & { fdc_url: string | null; owner_user_id: string | null }) | null;
  conversion: {
    method: 'mass' | 'portion' | 'default-serving' | 'volume' | 'density' | 'generic' | 'ai-estimate';
    grams_per_unit: number;
    stored_grams: number;
    /** The typical cup a volume was weighed from, when the food has no cup portion of its own. */
    per_cup?: { what: string; grams: number } | null;
  } | null;
  match: MatchInfo | null;
}
export interface Question {
  id: string;
  item_index: number;
  text: string;
  options: string[];
  default: string;
}
export interface Intake {
  id: string;
  status: 'preparation' | 'in-progress' | 'completed' | 'entered-in-error';
  meal_type: MealType;
  occurrence_at: string;
  log_date: string;
  source: string;
  note: string | null;
  raw_input_text: string | null;
  has_media: boolean;
  /** Photos, served at /api/intake/:id/photos/:n. */
  photo_count: number;
  confidence: number | null;
  items: Item[];
  totals: Record<string, number>;
  pending?: {
    questions?: Question[];
    error?: string;
    adding_to_meal?: boolean;
    /** A batch being read and saved as this recipe. */
    recipe?: string;
    /** The batch was saved as a recipe (this entry is retired). */
    recipe_saved?: { id: string; name: string };
  };
  /** Present when this entry was merged into an existing meal (this object is that meal). */
  merged_from?: string;
}
export interface RecipeIngredient {
  id: string;
  food_id: string;
  food_name: string;
  display_name: string;
  amount_value: number;
  amount_unit: string;
  grams: number;
  kcal: number;
  protein: number;
}
export interface Recipe {
  id: string;
  name: string;
  servings: number;
  yield_grams: number | null;
  batch_grams: number;
  serving_grams: number;
  per_serving: Record<string, number>;
  per_100g: Record<string, number>;
  totals: Record<string, number>;
  ingredients: RecipeIngredient[];
  times_logged: number;
  last_logged_at: string | null;
  updated_at: string;
}
export interface Day {
  date: string;
  meals: Intake[];
  /** Includes meals still waiting on answers, at their default answers. */
  totals: Record<string, number>;
  /** How many of those meals the totals include. */
  unconfirmed: number;
  targets: Record<string, number>;
  /** Targets that are defaults following from the calorie target, not set by the user. */
  default_targets?: string[];
  remaining: Record<string, number>;
}
export interface Settings {
  timezone: string;
  day_cutoff: string;
  weight_unit: 'kg' | 'lb';
  mass_unit: 'g' | 'oz';
  question_confidence_threshold: number;
  max_questions: number;
  model_vision: string;
  model_parser: string;
  model_speech: string;
  home_blocks: HomeBlock[];
}

export const HOME_BLOCKS = ['summary', 'weight', 'repeat', 'meals'] as const;
export type HomeBlock = (typeof HOME_BLOCKS)[number];
/** The saved order with any blocks it doesn't mention appended. */
export const homeOrder = (saved?: HomeBlock[] | null): HomeBlock[] => [...(saved ?? []), ...HOME_BLOCKS.filter((b) => !saved?.includes(b))];
