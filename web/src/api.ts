export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  default_serving_grams: number | null;
  portions: Portion[];
  nutrients: Nutrient[];
}
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
  nutrients: Record<string, number>;
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
  confidence: number | null;
  items: Item[];
  totals: Record<string, number>;
  pending?: { questions?: Question[] };
}
export interface Day {
  date: string;
  meals: Intake[];
  totals: Record<string, number>;
  targets: Record<string, number>;
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
}
