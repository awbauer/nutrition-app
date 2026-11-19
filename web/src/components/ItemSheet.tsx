import { useEffect, useState } from 'preact/hooks';
import { api, type Intake, type ItemDetail, type MatchCandidate } from '../api';
import { amountLabel, CONFIDENCE_LEVELS, confidenceLevel, kcal } from '../format';
import { toast } from '../toast';
import { fromUcum } from '../../../src/worker/lib/units';
import { AmountEditor } from './AmountEditor';

const SOURCE_LABEL: Record<string, string> = {
  usda: 'USDA',
  off: 'Open Food Facts',
  fatsecret: 'FatSecret',
  custom: 'Your food',
  recipe: 'Your recipe',
  estimate: 'AI estimate',
};

const VIA_LABEL: Record<string, string> = {
  alias: 'Your earlier choice for this food',
  custom: 'Matched your saved food',
  history: "Matched something you've eaten before",
  cache: 'Matched a food you logged before',
  barcode: 'Matched the exact product by its barcode',
  label: 'Read from the nutrition label on the package, and saved as your food',
  usda: 'Best match from a USDA search',
  fatsecret: 'Best match from a FatSecret search',
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
  if (source === 'fatsecret') return dataType === 'FatSecret Brand' ? `${s} · Brand` : s;
  return dataType && source === 'usda' ? `${s} · ${dataType}` : s;
}

/** Everything behind one item's numbers, plus other matches and a search to switch. */
export function ItemSheet(props: { itemId: string; onChange: (m: Intake) => void; onClose: () => void }) {
  const [d, setD] = useState<ItemDetail | null>(null);
  const [amt, setAmt] = useState<{ amount: number; unit: string }>({ amount: 0, unit: 'g' });
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MatchCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.get<ItemDetail>(`/item/${props.itemId}`);
      setD(r);
      setAmt({ amount: r.item.amount_value, unit: fromUcum(r.item.amount_unit) });
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

  if (!d) return <div class="h-64 animate-pulse rounded-xl bg-sunken" />;
  const { item, food, match, conversion } = d;
  const per100 = (code: string) => food?.nutrients.find((x) => x.code === code)?.value;
  const chosenKey = match?.chosen ?? (food?.source === 'usda' || food?.source === 'fatsecret' ? food.source_id : food?.id);
  const isChosen = (c: MatchCandidate) =>
    (c.fdc_id && c.fdc_id === chosenKey) || (c.fatsecret_id && c.fatsecret_id === chosenKey) || (c.food_id && c.food_id === chosenKey) || (c.food_id && c.food_id === food?.id);
  const others = (match?.candidates ?? []).filter((c) => !isChosen(c));
  // "1 small" saved from the AI's weight estimate: the preview and a new count use that weight, not the generic table.
  const aiUnit = conversion?.method === 'ai-estimate' ? { unit: fromUcum(item.amount_unit), grams: conversion.grams_per_unit } : null;
  const use = (c: MatchCandidate) =>
    patch(c.food_id ? { food_id: c.food_id } : c.fdc_id ? { fdc_id: c.fdc_id } : { fatsecret_id: c.fatsecret_id }, `Switched to ${c.name}`);

  return (
    <div class="flex flex-col gap-4 pb-2">
      {/* What it matched */}
      <section class="flex flex-col gap-1">
        <p class="eyebrow">Matched to</p>
        <p class="font-semibold">{food?.name ?? 'Unknown food'}</p>
        <div class="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span class="rounded bg-sunken px-1.5 py-0.5 ">{sourceLabel(food?.source, food?.data_type)}</span>
          {food?.brand && <span>{food.brand}</span>}
          {food?.fdc_url && (
            <a class="text-accent-ink underline " href={food.fdc_url} target="_blank" rel="noopener">
              View on USDA
            </a>
          )}
          {food?.source === 'fatsecret' && <FatSecretCredit />}
        </div>
        {match &&
          (match.via === 'estimate' && match.lookup_error ? (
            <p class="rounded-xl bg-mustard-soft p-3 text-sm text-ink">
              The food database didn't respond when this was logged, so it uses the AI's estimate. Search below to pick the real food.
            </p>
          ) : (
            <p class="text-sm text-ink-2">
              {VIA_LABEL[match.via]}
              {match.via === 'usda' || match.via === 'fatsecret' || match.via === 'estimate' ? ` for “${match.query}”.` : '.'}
            </p>
          ))}
        {item.check_match && match?.estimate_kcal_100g != null && (
          <p class="rounded-xl bg-mustard-soft p-3 text-sm text-ink">
            This food has {kcal(per100('ENERC_KCAL'))} kcal per 100 g, but the AI expected about {kcal(match.estimate_kcal_100g)}. Worth checking the other matches.
          </p>
        )}
      </section>

      {/* Numbers */}
      <section class="grid grid-cols-2 gap-2 text-center">
        <div class="rounded-xl bg-sunken p-3 ">
          <div class="num text-2xl font-semibold">{kcal(item.nutrients.ENERC_KCAL)}</div>
          <div class="text-xs text-ink-2">kcal in this item</div>
        </div>
        <div class="rounded-xl bg-sunken p-3 ">
          <div class="num text-2xl font-semibold">{n1(item.nutrients.PROCNT)} g</div>
          <div class="text-xs text-ink-2">protein</div>
        </div>
      </section>

      <section class="flex flex-col gap-1 text-sm">
        <div class="mt-2 rounded-2xl bg-sunken p-3">
          <p class="eyebrow mb-2">Per 100 g of the matched food</p>
          <div class="grid grid-cols-5 gap-2 text-center">
            {[
              ['kcal', kcal(per100('ENERC_KCAL'))],
              ['protein', n1(per100('PROCNT'))],
              ['fat', n1(per100('FAT'))],
              ['carbs', n1(per100('CHOCDF'))],
              ['fiber', n1(per100('FIBTG'))],
            ].map(([label, v]) => (
              <div>
                <p class="num text-lg leading-none">{v}</p>
                <p class="mt-1 text-[11px] text-faint">{label}</p>
              </div>
            ))}
          </div>
          {match?.estimate_kcal_100g != null && <p class="mt-2 text-xs text-ink-2">The AI expected about {kcal(match.estimate_kcal_100g)} kcal per 100 g.</p>}
        </div>
      </section>

      {/* How sure */}
      <section class="flex flex-col gap-2">
        <p class="eyebrow">How sure are you about this item?</p>
        <div class="grid grid-cols-4 gap-1 rounded-xl bg-sunken p-1 text-sm " role="radiogroup" aria-label="Confidence">
          {CONFIDENCE_LEVELS.map((l) => {
            const on = confidenceLevel(item.confidence)?.key === l.key;
            return (
              <button
                role="radio"
                aria-checked={on}
                class={`rounded-lg py-1.5 font-medium ${on ? 'bg-card shadow-sm ' : 'text-ink-2'}`}
                disabled={busy}
                onClick={() => !on && patch({ confidence: l.value }, `Confidence set to ${l.label.toLowerCase()}`)}
              >
                {l.label}
              </button>
            );
          })}
        </div>
        <p class="text-xs text-ink-2">{confidenceLevel(item.confidence)?.hint}. Low-confidence items are flagged so you know which numbers to trust less.</p>
      </section>

      {/* Amount: relative size or exact grams */}
      <section class="flex flex-col gap-3">
        <p class="eyebrow">How much</p>
        <AmountEditor
          amount={amt.amount}
          unit={amt.unit}
          onChange={(amount, unit) => setAmt({ amount, unit })}
          portions={food?.portions}
          category={food?.category}
          name={[item.display_name, food?.name ?? '']}
          defaultServingGrams={food?.default_serving_grams}
          kcalPer100={per100('ENERC_KCAL')}
          hint={false}
          knownUnit={aiUnit}
        />
        {/* How a household amount became grams; nothing to explain when it's already grams. */}
        {conversion && item.amount_unit !== 'g' && (
          <p class="text-xs text-faint">
            Saved as {amountLabel(item.amount_value, item.amount_unit)} = {Math.round(item.grams)} g. {CONVERSION_LABEL[conversion.method]}.
          </p>
        )}
        <button
          class="btn-primary self-start"
          disabled={busy || !(amt.amount > 0) || (amt.amount === item.amount_value && amt.unit === fromUcum(item.amount_unit))}
          onClick={() => patch({ amount: amt.amount, unit: amt.unit }, 'Amount updated')}
        >
          Save amount
        </button>
      </section>

      {/* Other matches */}
      {others.length > 0 && !results && (
        <section class="flex flex-col gap-1">
          <p class="eyebrow">Other matches considered</p>
          <CandidateList items={others} onUse={use} busy={busy} />
        </section>
      )}

      {/* Search */}
      <section class="flex flex-col gap-2">
        <p class="eyebrow">Find a different food</p>
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
        {results && (results.length ? <CandidateList items={results} onUse={use} busy={busy} isChosen={isChosen} /> : <p class="text-sm text-ink-2">No matches.</p>)}
        <p class="text-xs text-ink-2">When you switch, the app remembers it the next time you log “{item.display_name}”.</p>
      </section>

      <button class="btn-ghost self-start text-berry" disabled={busy} onClick={remove}>
        Remove item
      </button>
    </div>
  );
}

/** FatSecret's terms: data shown from them carries this credit. */
export function FatSecretCredit() {
  return (
    <a class="text-xs text-ink-2 underline" href="https://www.fatsecret.com" target="_blank" rel="noopener">
      Powered by fatsecret
    </a>
  );
}

function CandidateList(props: { items: MatchCandidate[]; onUse: (c: MatchCandidate) => void; busy: boolean; isChosen?: (c: MatchCandidate) => boolean | '' | undefined }) {
  return (
    <div class="flex flex-col gap-1.5">
    <ul class="divide-y divide-line rounded-xl ring-1 ring-line">
      {props.items.map((c) => {
        const chosen = !!props.isChosen?.(c);
        return (
          <li class="flex items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm">{c.name}</p>
              <p class="truncate text-xs text-ink-2">
                {sourceLabel(c.source, c.data_type)}
                {c.brand ? ` · ${c.brand}` : ''}
                {c.notes.filter((x) => !/words$/.test(x)).length ? ` · ${c.notes.filter((x) => !/words$/.test(x)).join('; ')}` : ''}
              </p>
            </div>
            <div class="shrink-0 text-right text-xs tabular-nums text-ink-2">
              <div class="text-sm text-ink">{c.kcal_100g == null ? '–' : Math.round(c.kcal_100g)}</div>
              kcal/100g
            </div>
            {chosen ? (
              <span class="shrink-0 text-xs font-medium text-accent-ink">Current</span>
            ) : (
              <button class="btn-ghost shrink-0 px-2.5 py-1 text-xs" disabled={props.busy} onClick={() => props.onUse(c)}>
                Use
              </button>
            )}
          </li>
        );
      })}
    </ul>
    {props.items.some((c) => c.source === 'fatsecret') && <FatSecretCredit />}
    </div>
  );
}
