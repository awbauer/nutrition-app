import { useEffect, useState } from 'preact/hooks';
import { api, type Intake, type ItemDetail, type MatchCandidate } from '../api';
import { amountLabel, kcal } from '../format';
import { toast } from '../toast';

const SOURCE_LABEL: Record<string, string> = {
  usda: 'USDA',
  off: 'Open Food Facts',
  custom: 'Your food',
  recipe: 'Your recipe',
  estimate: 'AI estimate',
};

const VIA_LABEL: Record<string, string> = {
  alias: 'Your earlier choice for this food',
  custom: 'Matched your saved food',
  cache: 'Matched a food you logged before',
  usda: 'Best match from a USDA search',
  off: 'Matched by barcode',
  estimate: 'No good database match, so this uses the AI estimate',
};

const CONVERSION_LABEL: Record<string, string> = {
  mass: 'Weight given directly',
  portion: "From the food's own portion sizes",
  'default-serving': "From the food's serving size",
  volume: 'Volume converted at water density',
  generic: 'Rough guess from a generic size table',
  'ai-estimate': "The AI's weight estimate (this food has no portion size for that unit)",
};

const n1 = (v: number | null | undefined) => (v == null ? '–' : Math.round(v * 10) / 10);

function sourceLabel(source: string | null | undefined, dataType: string | null | undefined) {
  const s = SOURCE_LABEL[source ?? ''] ?? source ?? '';
  return dataType && source === 'usda' ? `${s} · ${dataType}` : s;
}

/** Everything behind one item's numbers, plus other matches and a search to switch. */
export function ItemSheet(props: { itemId: string; onChange: (m: Intake) => void; onClose: () => void }) {
  const [d, setD] = useState<ItemDetail | null>(null);
  const [grams, setGrams] = useState<number>(0);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MatchCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.get<ItemDetail>(`/item/${props.itemId}`);
      setD(r);
      setGrams(Math.round(r.item.grams));
      setQ((x) => x || r.match?.query || r.item.display_name);
    } catch (e) {
      toast.error(e);
    }
  };
  useEffect(() => {
    load();
  }, [props.itemId]);

  async function patch(body: unknown, msg: string) {
    setBusy(true);
    try {
      const m = await api.patch<Intake>(`/item/${props.itemId}`, body);
      props.onChange(m);
      toast.success(msg);
      setResults(null);
      await load();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    if (q.trim().length < 2) return;
    setSearching(true);
    try {
      const r = await api.get<{ candidates: MatchCandidate[]; error?: string }>(`/item/${props.itemId}/search?q=${encodeURIComponent(q.trim())}`);
      setResults(r.candidates);
      if (r.error) toast.info('Food database unavailable; showing saved foods only.', { id: 'usda' });
    } catch (e) {
      toast.error(e);
    } finally {
      setSearching(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      props.onChange(await api.del<Intake>(`/item/${props.itemId}`));
      toast.success('Removed');
      props.onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  if (!d) return <div class="h-64 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />;
  const { item, food, match, conversion } = d;
  const per100 = (code: string) => food?.nutrients.find((x) => x.code === code)?.value;
  const chosenKey = match?.chosen ?? (food?.source === 'usda' ? food.source_id : food?.id);
  const isChosen = (c: MatchCandidate) => (c.fdc_id && c.fdc_id === chosenKey) || (c.food_id && c.food_id === chosenKey) || (c.food_id && c.food_id === food?.id);
  const others = (match?.candidates ?? []).filter((c) => !isChosen(c));
  const use = (c: MatchCandidate) => patch(c.fdc_id ? { fdc_id: c.fdc_id } : { food_id: c.food_id }, `Switched to ${c.name}`);

  return (
    <div class="flex flex-col gap-4 pb-2">
      {/* What it matched */}
      <section class="flex flex-col gap-1">
        <p class="text-xs tracking-wide text-slate-500 uppercase">Matched to</p>
        <p class="font-semibold">{food?.name ?? 'Unknown food'}</p>
        <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span class="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">{sourceLabel(food?.source, food?.data_type)}</span>
          {food?.brand && <span>{food.brand}</span>}
          {food?.fdc_url && (
            <a class="text-brand-700 underline dark:text-brand-500" href={food.fdc_url} target="_blank" rel="noopener">
              View on USDA
            </a>
          )}
        </div>
        {match && <p class="text-sm text-slate-500">{VIA_LABEL[match.via]}{match.via === 'usda' || match.via === 'estimate' ? ` for “${match.query}”.` : '.'}</p>}
        {item.check_match && match?.estimate_kcal_100g != null && (
          <p class="rounded-lg bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            This food has {kcal(per100('ENERC_KCAL'))} kcal per 100 g, but the AI expected about {kcal(match.estimate_kcal_100g)}. Worth checking the other matches.
          </p>
        )}
      </section>

      {/* Numbers */}
      <section class="grid grid-cols-2 gap-2 text-center">
        <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
          <div class="text-xl font-bold tabular-nums">{kcal(item.nutrients.ENERC_KCAL)}</div>
          <div class="text-xs text-slate-500">kcal in this item</div>
        </div>
        <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
          <div class="text-xl font-bold tabular-nums">{n1(item.nutrients.PROCNT)} g</div>
          <div class="text-xs text-slate-500">protein</div>
        </div>
      </section>

      <section class="flex flex-col gap-1 text-sm">
        <p>
          <span class="text-slate-500">Amount:</span> {item.display_name}, {amountLabel(item.amount_value, item.amount_unit)} → <b>{Math.round(item.grams)} g</b>
        </p>
        {conversion && <p class="text-xs text-slate-500">{CONVERSION_LABEL[conversion.method]}</p>}
        <table class="mt-1 w-full text-left text-xs">
          <thead class="text-slate-500">
            <tr>
              <th class="font-normal">Per 100 g</th>
              <th class="font-normal">kcal</th>
              <th class="font-normal">Protein</th>
              <th class="font-normal">Fat</th>
              <th class="font-normal">Carbs</th>
              <th class="font-normal">Fiber</th>
            </tr>
          </thead>
          <tbody class="tabular-nums">
            <tr>
              <td class="text-slate-500">Matched food</td>
              <td>{kcal(per100('ENERC_KCAL'))}</td>
              <td>{n1(per100('PROCNT'))}</td>
              <td>{n1(per100('FAT'))}</td>
              <td>{n1(per100('CHOCDF'))}</td>
              <td>{n1(per100('FIBTG'))}</td>
            </tr>
            {match?.estimate_kcal_100g != null && (
              <tr class="text-slate-500">
                <td>AI expected</td>
                <td>~{kcal(match.estimate_kcal_100g)}</td>
                <td colspan={4} />
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* Edit amount */}
      <section class="flex items-center gap-2">
        <input
          class="input w-24 py-1.5 text-center tabular-nums"
          type="number"
          inputMode="decimal"
          value={grams}
          onInput={(e) => setGrams(Number((e.target as HTMLInputElement).value))}
          aria-label="Grams"
        />
        <span class="text-sm text-slate-500">g</span>
        <button class="btn-primary ml-auto px-3 py-1.5" disabled={busy || !(grams > 0) || grams === Math.round(item.grams)} onClick={() => patch({ amount: grams, unit: 'g' }, 'Amount updated')}>
          Save amount
        </button>
      </section>

      {/* Other matches */}
      {others.length > 0 && !results && (
        <section class="flex flex-col gap-1">
          <p class="text-xs tracking-wide text-slate-500 uppercase">Other matches considered</p>
          <CandidateList items={others} onUse={use} busy={busy} />
        </section>
      )}

      {/* Search */}
      <section class="flex flex-col gap-2">
        <p class="text-xs tracking-wide text-slate-500 uppercase">Find a different food</p>
        <form
          class="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <input class="input py-1.5" type="search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} enterkeyhint="search" aria-label="Search foods" />
          <button class="btn-ghost shrink-0 px-3 py-1.5" disabled={searching}>
            {searching ? '…' : 'Search'}
          </button>
        </form>
        {results && (results.length ? <CandidateList items={results} onUse={use} busy={busy} isChosen={isChosen} /> : <p class="text-sm text-slate-500">No matches.</p>)}
        <p class="text-xs text-slate-500">When you switch, the app remembers it the next time you log “{item.display_name}”.</p>
      </section>

      <button class="btn-ghost self-start text-rose-600" disabled={busy} onClick={remove}>
        Remove item
      </button>
    </div>
  );
}

function CandidateList(props: { items: MatchCandidate[]; onUse: (c: MatchCandidate) => void; busy: boolean; isChosen?: (c: MatchCandidate) => boolean | '' | undefined }) {
  return (
    <ul class="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
      {props.items.map((c) => {
        const chosen = !!props.isChosen?.(c);
        return (
          <li class="flex items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm">{c.name}</p>
              <p class="truncate text-xs text-slate-500">
                {sourceLabel(c.source, c.data_type)}
                {c.brand ? ` · ${c.brand}` : ''}
                {c.notes.filter((x) => !/words$/.test(x)).length ? ` · ${c.notes.filter((x) => !/words$/.test(x)).join('; ')}` : ''}
              </p>
            </div>
            <div class="shrink-0 text-right text-xs tabular-nums text-slate-500">
              <div class="text-sm text-slate-700 dark:text-slate-200">{c.kcal_100g == null ? '–' : Math.round(c.kcal_100g)}</div>
              kcal/100g
            </div>
            {chosen ? (
              <span class="shrink-0 text-xs font-medium text-brand-700 dark:text-brand-500">Current</span>
            ) : (
              <button class="btn-ghost shrink-0 px-2.5 py-1 text-xs" disabled={props.busy} onClick={() => props.onUse(c)}>
                Use
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
