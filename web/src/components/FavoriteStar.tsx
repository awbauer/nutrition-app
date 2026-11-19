import { Star } from 'lucide-preact';
import { findFavorite, toggleFavorite, useFavorites } from '../favorites';
import { toast } from '../toast';

/**
 * One tap to star a food (with the name and amount to log it by) or unstar it.
 * Big enough to hit with a thumb; never triggers the row it sits in.
 */
export function FavoriteStar(props: { name: string; food_id: string; amount: number; unit: string; size?: number; class?: string }) {
  const on = !!findFavorite(useFavorites(), props.name);
  const label = on ? `Remove ${props.name} from favorites` : `Add ${props.name} to favorites`;
  return (
    <button
      type="button"
      class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-sunken active:scale-90 ${on ? 'text-mustard' : 'text-faint'} ${props.class ?? ''}`}
      aria-pressed={on}
      aria-label={label}
      title={on ? 'Favorite' : 'Add to favorites'}
      onClick={(e) => {
        e.stopPropagation();
        toggleFavorite(props).then(
          (starred) => toast.success(starred ? `Starred ${props.name}` : `Removed ${props.name} from favorites`),
          (err) => toast.error(err),
        );
      }}
    >
      <Star size={props.size ?? 20} fill={on ? 'currentColor' : 'none'} strokeWidth={1.75} />
    </button>
  );
}
