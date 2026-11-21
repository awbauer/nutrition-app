import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { Waypoints, X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { kcal, MEAL_LABEL } from '../format';
import { toast } from '../toast';

type NodeType = 'food' | 'meal' | 'brand' | 'recipe';
interface GNode {
  id: string;
  type: NodeType;
  label: string;
  weight: number;
  food_id?: string;
  food_name?: string;
  kcal_avg?: number;
  protein_avg?: number;
  last_at?: string;
  top_meal?: keyof typeof MEAL_LABEL;
  source?: string;
}
interface GEdge {
  source: string;
  target: string;
  type: 'eaten_at' | 'eaten_with' | 'made_by' | 'ingredient';
  weight: number;
}
interface Graph {
  days: number;
  nodes: GNode[];
  edges: GEdge[];
  omitted_foods: number;
}

type SimNode = GNode & SimulationNodeDatum & { r: number };
type SimLink = SimulationLinkDatum<SimNode> & GEdge;

const TYPES: { type: NodeType; label: string; color: string }[] = [
  { type: 'food', label: 'Foods', color: 'var(--accent)' },
  { type: 'meal', label: 'Meals', color: 'var(--mustard)' },
  { type: 'brand', label: 'Brands', color: 'var(--plum)' },
  { type: 'recipe', label: 'Recipes', color: 'var(--sage)' },
];
const COLOR = Object.fromEntries(TYPES.map((t) => [t.type, t.color])) as Record<NodeType, string>;
const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'Year' },
];

const radius = (n: GNode) => (n.type === 'meal' ? 16 + Math.sqrt(n.weight) * 1.2 : 5 + Math.sqrt(Math.max(n.weight, 0.5)) * 3.2);
const endId = (e: SimLink['source']) => (typeof e === 'object' ? (e as SimNode).id : String(e));

/** Lay the graph out once (no live jiggle): a few hundred ticks of a force simulation. */
function layout(g: Graph, shown: Set<NodeType>): { nodes: SimNode[]; links: SimLink[] } {
  const nodes: SimNode[] = g.nodes.filter((n) => shown.has(n.type)).map((n) => ({ ...n, r: radius(n) }));
  const ids = new Set(nodes.map((n) => n.id));
  const links: SimLink[] = g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e }));
  // Meals sit apart on a ring so foods gather around the meal they belong to.
  const meals = nodes.filter((n) => n.type === 'meal');
  meals.forEach((m, i) => {
    const a = (i / meals.length) * Math.PI * 2 - Math.PI / 2;
    m.x = Math.cos(a) * 220;
    m.y = Math.sin(a) * 220;
  });
  const sim = forceSimulation<SimNode>(nodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((n) => n.id)
        .distance((l) => (l.type === 'eaten_with' ? 60 : l.type === 'eaten_at' ? 110 : 70))
        .strength((l) => (l.type === 'eaten_at' ? 0.04 + Math.min(l.weight, 10) * 0.02 : l.type === 'eaten_with' ? 0.08 + Math.min(l.weight, 8) * 0.03 : 0.25)),
    )
    .force(
      'charge',
      forceManyBody<SimNode>().strength((n) => (n.type === 'meal' ? -500 : -70)),
    )
    .force(
      'collide',
      forceCollide<SimNode>((n) => n.r + 3),
    )
    .force('x', forceX<SimNode>(0).strength(0.03))
    .force('y', forceY<SimNode>(0).strength(0.03))
    .stop();
  sim.tick(320);
  return { nodes, links };
}

function ago(iso: string): string {
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

export function GraphView() {
  const [days, setDays] = useState(90);
  const [g, setG] = useState<Graph | null>(null);
  const [shown, setShown] = useState<Set<NodeType>>(() => new Set(['food', 'meal', 'brand', 'recipe']));
  const [sel, setSel] = useState<string | null>(null);
  const [k, setK] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });

  useEffect(() => {
    setG(null);
    setSel(null);
    api.get<Graph>(`/graph?days=${days}`).then(setG, (e) => toast.error(e));
  }, [days]);

  const { nodes, links } = useMemo(() => (g ? layout(g, shown) : { nodes: [], links: [] }), [g, shown]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const neighbours = useMemo(() => {
    const m = new Map<string, { node: SimNode; edge: SimLink }[]>();
    for (const l of links) {
      const a = byId.get(endId(l.source))!;
      const b = byId.get(endId(l.target))!;
      (m.get(a.id) ?? m.set(a.id, []).get(a.id)!).push({ node: b, edge: l });
      (m.get(b.id) ?? m.set(b.id, []).get(b.id)!).push({ node: a, edge: l });
    }
    return m;
  }, [links, byId]);
  // The most-eaten foods are always labelled; the rest when zoomed in or next to the selection.
  const labelled = useMemo(
    () =>
      new Set(
        nodes
          .filter((n) => n.type !== 'meal')
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 14)
          .map((n) => n.id),
      ),
    [nodes],
  );
  const near = useMemo(() => new Set(sel ? [sel, ...(neighbours.get(sel) ?? []).map((x) => x.node.id)] : []), [sel, neighbours]);

  // Pan and pinch-zoom; fit the layout to the box whenever it changes.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 6])
      .on('zoom', (e) => {
        setT({ x: e.transform.x, y: e.transform.y, k: e.transform.k });
        setK(e.transform.k);
      });
    zoomRef.current = z;
    select(svg).call(z).on('dblclick.zoom', null);
    return () => {
      select(svg).on('.zoom', null);
    };
  }, [g]);
  useEffect(() => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z || !nodes.length) return;
    const w = svg.clientWidth;
    const h = svg.clientHeight;
    const xs = nodes.map((n) => n.x!);
    const ys = nodes.map((n) => n.y!);
    const [x0, x1, y0, y1] = [Math.min(...xs) - 40, Math.max(...xs) + 40, Math.min(...ys) - 40, Math.max(...ys) + 40];
    const s = Math.min(2, w / (x1 - x0), h / (y1 - y0));
    select(svg).call(z.transform, zoomIdentity.translate(w / 2 - ((x0 + x1) / 2) * s, h / 2 - ((y0 + y1) / 2) * s).scale(s));
  }, [nodes]);

  const toggle = (type: NodeType) =>
    setShown((cur) => {
      const next = new Set(cur);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next.size ? next : cur;
    });

  const selected = sel ? byId.get(sel) : undefined;
  const counts = useMemo(() => Object.fromEntries(TYPES.map((x) => [x.type, g?.nodes.filter((n) => n.type === x.type).length ?? 0])), [g]);

  return (
    <div class="flex flex-col gap-4">
      <header class="flex flex-wrap items-end justify-between gap-3 pt-2">
        <div>
          <p class="eyebrow">How your food connects</p>
          <h1 class="display mt-0.5 text-[2.1rem] leading-none font-semibold">Food graph</h1>
        </div>
        <div class="segmented w-full max-w-[16rem] text-xs" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button class="seg" role="radio" aria-checked={days === r.days} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </header>

      <div class="flex flex-wrap gap-2" role="group" aria-label="Show">
        {TYPES.map((x) => (
          <button
            class={`${shown.has(x.type) && counts[x.type] ? 'chip-on' : 'chip'} disabled:opacity-40`}
            aria-pressed={shown.has(x.type) && !!counts[x.type]}
            onClick={() => toggle(x.type)}
            disabled={!counts[x.type]}
          >
            <span class="mr-1.5 inline-block h-2.5 w-2.5 rounded-full" style={{ background: x.color }} aria-hidden="true" />
            {x.label}
            <span class="ml-1 text-faint">{counts[x.type]}</span>
          </button>
        ))}
      </div>

      <div class="relative flex flex-col gap-4">
        <div class="card relative h-[58dvh] min-h-[22rem] overflow-hidden lg:h-[72dvh]">
          {!g && <div class="absolute inset-0 animate-pulse bg-sunken" />}
          {g && !g.nodes.length && (
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
              <Waypoints size={40} strokeWidth={1.5} class="text-faint" aria-hidden="true" />
              <p class="display text-xl font-semibold">Nothing to connect yet</p>
              <p class="max-w-[18rem] text-sm text-ink-2">Log a few meals and this fills in with what you eat, when, and what goes together.</p>
            </div>
          )}
          <svg
            ref={svgRef}
            class="h-full w-full touch-none select-none"
            role="img"
            aria-label={`Graph of ${nodes.length} foods, meals and brands from your log`}
            onClick={(e) => {
              if (e.target === svgRef.current) setSel(null);
            }}
          >
            <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
              {links.map((l) => {
                const a = l.source as SimNode;
                const b = l.target as SimNode;
                const on = !sel || a.id === sel || b.id === sel;
                return (
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={l.type === 'eaten_with' ? 'var(--accent)' : 'var(--ink-2)'}
                    stroke-opacity={on ? (sel ? 0.7 : l.type === 'eaten_with' ? 0.35 : 0.14) : 0.04}
                    stroke-width={(l.type === 'eaten_with' ? 0.8 + Math.min(l.weight, 8) * 0.5 : 0.8) / Math.sqrt(k)}
                    stroke-dasharray={l.type === 'ingredient' ? '3 3' : undefined}
                  />
                );
              })}
              {nodes.map((n) => {
                const dim = sel && !near.has(n.id);
                const showLabel = n.type !== 'food' || labelled.has(n.id) || n.r * k > 16 || near.has(n.id);
                // Text keeps the same size on screen whatever the zoom.
                const fs = (n.type === 'meal' ? 12 : 11) / k;
                return (
                  <g
                    transform={`translate(${n.x},${n.y})`}
                    class="cursor-pointer"
                    opacity={dim ? 0.18 : 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSel(sel === n.id ? null : n.id);
                    }}
                  >
                    <circle
                      r={n.r}
                      fill={COLOR[n.type]}
                      fill-opacity={n.type === 'meal' ? 0.22 : 0.9}
                      stroke={COLOR[n.type]}
                      stroke-width={n.id === sel ? 3 : n.type === 'meal' ? 1.5 : 0}
                    />
                    {showLabel && (
                      <text
                        y={n.type === 'meal' ? fs * 0.35 : n.r + fs * 1.05}
                        text-anchor="middle"
                        font-size={fs}
                        font-weight={n.type === 'meal' || n.id === sel ? 650 : 500}
                        fill="var(--ink)"
                        stroke="var(--card)"
                        stroke-width={3 / k}
                        paint-order="stroke"
                        style={{ pointerEvents: 'none' }}
                      >
                        {n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          {g && g.nodes.length > 0 && !sel && <p class="pointer-events-none absolute bottom-3 left-4 text-xs text-faint">Tap a circle · pinch or scroll to zoom</p>}
        </div>

        {selected && <Details node={selected} links={neighbours.get(selected.id) ?? []} onSelect={setSel} onClose={() => setSel(null)} />}
      </div>
      {g && g.omitted_foods > 0 && (
        <p class="text-xs text-faint">
          Showing your {g.nodes.filter((n) => n.type === 'food' && n.weight > 0).length} most-eaten foods; {g.omitted_foods} more eaten once or twice are left out.
        </p>
      )}
    </div>
  );
}

function Details(props: { node: SimNode; links: { node: SimNode; edge: SimLink }[]; onSelect: (id: string) => void; onClose: () => void }) {
  const n = props.node;
  const by = (type: GEdge['type']) => props.links.filter((x) => x.edge.type === type).sort((a, b) => b.edge.weight - a.edge.weight || b.node.weight - a.node.weight);
  const with_ = by('eaten_with');
  const at = by('eaten_at');
  const brand = by('made_by');
  const ingredients = by('ingredient');
  const Chip = (p: { x: { node: SimNode; edge: SimLink }; count?: boolean }) => (
    <button class="chip text-xs" onClick={() => props.onSelect(p.x.node.id)}>
      <span class="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: COLOR[p.x.node.type] }} aria-hidden="true" />
      {p.x.node.label}
      {p.count && <span class="ml-1 text-faint">{p.x.edge.weight}×</span>}
    </button>
  );
  return (
    <aside
      class="card flex flex-col gap-3 p-4 lg:absolute lg:top-3 lg:right-3 lg:max-h-[calc(100%-1.5rem)] lg:w-80 lg:overflow-y-auto lg:shadow-lg"
      aria-label={`About ${n.label}`}
    >
      <div class="flex items-start gap-3">
        <span class="mt-1.5 inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: COLOR[n.type] }} aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <h2 class="display text-xl leading-tight font-semibold">{n.label}</h2>
          {n.food_name && <p class="text-xs text-ink-2">{n.food_name}</p>}
        </div>
        <button class="icon-btn h-8 w-8" onClick={props.onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {(n.type === 'food' || n.type === 'recipe') && n.weight > 0 && (
        <p class="text-sm text-ink-2">
          Eaten <b class="text-ink">{n.weight}×</b>
          {n.top_meal && <> · mostly at {MEAL_LABEL[n.top_meal].toLowerCase()}</>}
          {n.last_at && <> · last {ago(n.last_at)}</>}
          <br />
          About <b class="num text-ink">{kcal(n.kcal_avg)}</b> kcal and <b class="num text-ink">{n.protein_avg}</b> g protein each time
        </p>
      )}
      {n.type === 'food' && n.weight === 0 && <p class="text-sm text-ink-2">An ingredient in your recipes.</p>}
      {n.type === 'meal' && (
        <p class="text-sm text-ink-2">
          <b class="text-ink">{n.weight}</b> items logged at {n.label.toLowerCase()} in this period.
        </p>
      )}
      {n.type === 'brand' && (
        <p class="text-sm text-ink-2">
          <b class="text-ink">{n.weight}</b> times eaten across {brand.length} {brand.length === 1 ? 'food' : 'foods'}.
        </p>
      )}

      {with_.length > 0 && (
        <section class="flex flex-col gap-1.5">
          <p class="eyebrow">Often with</p>
          <div class="flex flex-wrap gap-1.5">
            {with_.slice(0, 8).map((x) => (
              <Chip x={x} count />
            ))}
          </div>
        </section>
      )}
      {at.length > 0 && (
        <section class="flex flex-col gap-1.5">
          <p class="eyebrow">{n.type === 'meal' ? 'Most eaten' : 'Eaten at'}</p>
          <div class="flex flex-wrap gap-1.5">
            {at.slice(0, 10).map((x) => (
              <Chip x={x} count />
            ))}
          </div>
        </section>
      )}
      {brand.length > 0 && (
        <section class="flex flex-col gap-1.5">
          <p class="eyebrow">{n.type === 'brand' ? 'Foods' : 'Brand'}</p>
          <div class="flex flex-wrap gap-1.5">
            {brand.slice(0, 10).map((x) => (
              <Chip x={x} count={n.type === 'brand'} />
            ))}
          </div>
        </section>
      )}
      {ingredients.length > 0 && (
        <section class="flex flex-col gap-1.5">
          <p class="eyebrow">{n.type === 'recipe' ? 'Ingredients' : 'In recipes'}</p>
          <div class="flex flex-wrap gap-1.5">
            {ingredients.map((x) => (
              <Chip x={x} />
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
