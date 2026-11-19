import { Plus, Search, Star } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type Favorite } from '../api';
import { setFavorites, useFavorites } from '../favorites';
import { amountLabel, kcal } from '../format';
import { FavoriteStar } from './FavoriteStar';

/** Loads favorites fresh when the tab opens (the shared store may hold an older list or none). */
function useFreshFavorites(): Favorite[] | null {
  const favs = useFavorites();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api.get<Favorite[]>('/foods/favorites').then(
      (l) => (setFavorites(l), setLoaded(true)),
      () => setLoaded(true),
    );
  }, []);
  return loaded ? favs : null;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The Favorites tab of Foods: every starred food with the amount it logs, a search box that filters
 * them and, from the same words, searches the food database to star something new.
 */
export function FavoritesList(props: { onAdd: (query: string) => void; onOpen: (f: Favorite) => void; onLog: (f: Favorite) => void }) {
  const list = useFreshFavorites();
  const [q, setQ] = useState('');
  const term = norm(q);
  // The words go to the add sheet; coming back shows the whole list with the new one in it.
  const add = (words: string) => (props.onAdd(words), setQ(''));
  const shown = (list ?? []).filter((f) => !term || norm(f.name).includes(term)).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div class="flex flex-col gap-3">
      <form
        class="relative"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (term.length >= 2) add(q.trim());
        }}
      >
        <Search size={18} class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
        <input
          class="input w-full pl-10"
          type="search"
          placeholder={list?.length ? 'Search favorites or find a food to add' : 'Find a food to add'}
          aria-label="Search favorites and foods"
          value={q}
          enterKeyHint="search"
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
      </form>

      {term.length >= 2 && (
        <button class="card flex items-center gap-3 px-4 py-3 text-left hover:bg-sunken/70 active:bg-sunken" onClick={() => add(q.trim())}>
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink" aria-hidden="true">
            <Plus size={16} />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[0.95rem] font-medium">Search foods for “{q.trim()}”</span>
            <span class="block text-xs text-faint">Pick one and an amount to add it to favorites</span>
          </span>
        </button>
      )}

      {!list && <div class="card h-40 animate-pulse" />}
      {list && !list.length && !term && (
        <div class="card flex flex-col items-center gap-3 px-6 py-10 text-center">
          <Star size={40} strokeWidth={1.5} class="text-faint" aria-hidden="true" />
          <p class="display text-xl font-semibold">No favorites yet</p>
          <p class="max-w-[19rem] text-sm text-ink-2">
            Star the foods you log all the time, with the amount you usually have, and they're one tap from Quick add. Search above to add one, or tap the star
            on any food as you log it.
          </p>
          <button class="btn-primary mt-1" onClick={() => props.onAdd('')}>
            Add a favorite
          </button>
        </div>
      )}
      {list && list.length > 0 && term && !shown.length && <p class="px-1 text-sm text-ink-2">None of your favorites match.</p>}
      {shown.length > 0 && (
        <ul class="card divide-y divide-line">
          {shown.map((f) => (
            <li class="flex items-center pr-1.5">
              <button
                class="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left hover:bg-sunken/70 active:bg-sunken"
                onClick={() => props.onOpen(f)}
                aria-label={`Change the amount for ${f.name}`}
              >
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[0.95rem]">{f.name}</p>
                  <p class="truncate text-xs text-faint">{amountLabel(f.amount, f.unit)}</p>
                </div>
                {f.kcal != null && <span class="num text-ink-2">{kcal(f.kcal)}</span>}
              </button>
              <button
                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-sunken"
                onClick={() => props.onLog(f)}
                aria-label={`Log ${f.name}`}
                title="Log it"
              >
                <span class="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                  <Plus size={16} />
                </span>
              </button>
              <FavoriteStar {...f} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
