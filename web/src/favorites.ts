/**
 * Starred foods, shared by every star on screen so they stay in step: starring in Food details
 * fills the star in Quick add too. Loaded once, then updated as you tap.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type Favorite } from './api';

let list: Favorite[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const norm = (s: string) => s.trim().toLowerCase();

export function setFavorites(next: Favorite[]) {
  list = next;
  emit();
}

function load() {
  loading ??= api.get<Favorite[]>('/foods/favorites').then(setFavorites, () => {
    loading = null; // try again next time a star mounts
  });
}

/** The starred foods (empty until loaded), re-rendering when any star changes. */
export function useFavorites(): Favorite[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    if (!list) load();
    return () => void listeners.delete(l);
  }, []);
  return list ?? [];
}

export const findFavorite = (favs: Favorite[], name: string) => favs.find((f) => norm(f.name) === norm(name));

/** Star or unstar by name. Optimistic: the star changes at once and goes back if saving fails. */
export async function toggleFavorite(item: { name: string; food_id: string; amount: number; unit: string }): Promise<boolean> {
  const before = list ?? [];
  const existing = findFavorite(before, item.name);
  if (existing) {
    setFavorites(before.filter((f) => f !== existing));
    try {
      await api.del(`/foods/favorites/${existing.id}`);
      return false;
    } catch (e) {
      setFavorites(before);
      throw e;
    }
  }
  const temp: Favorite = { id: `pending-${Date.now()}`, ...item, grams: 0, kcal: null };
  setFavorites([...before, temp]);
  try {
    const saved = await api.post<Favorite>('/foods/favorites', item);
    setFavorites([...(list ?? []).filter((f) => f !== temp && norm(f.name) !== norm(item.name)), saved]);
    return true;
  } catch (e) {
    setFavorites(before);
    throw e;
  }
}
