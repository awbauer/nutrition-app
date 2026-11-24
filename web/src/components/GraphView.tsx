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

const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'];
const radius = (n: GNode) =>
  n.type === 'meal'
    ? Math.min(44, 22 + Math.sqrt(n.weight) * 1.1)
    : n.type === 'brand'
      ? 3.5 + Math.sqrt(Math.max(n.weight, 0.5)) * 1.6
      : 4.5 + Math.sqrt(Math.max(n.weight, 0.5)) * 3;
const endId = (e: SimLink['source']) => (typeof e === 'object' ? (e as SimNode).id : String(e));

/** Lay the graph out once (no live jiggle): a few hundred ticks of a force simulation. */
function layout(g: Graph, shown: Set<NodeType>): { nodes: SimNode[]; links: SimLink[] } {
  const nodes: SimNode[] = g.nodes.filter((n) => shown.has(n.type)).map((n) => ({ ...n, r: radius(n) }));
  const ids = new Set(nodes.map((n) => n.id));
  const links: SimLink[] = g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e }));
  // Meals are pinned round a clock face (breakfast at the top, going clockwise), so each
  // meal's foods gather in their own quarter instead of the meals drifting into one knot.
  const meals = nodes.filter((n) => n.type === 'meal').sort((a, b) => MEAL_ORDER.indexOf(a.id.slice(5)) - MEAL_ORDER.indexOf(b.id.slice(5)));
  const ring = 150 + Math.sqrt(nodes.length) * 13;
  const mealAt = new Map<string, SimNode>();
  meals.forEach((m, i) => {
    const a = (i / meals.length) * Math.PI * 2 - Math.PI / 2;
    m.fx = m.x = meals.length > 1 ? Math.cos(a) * ring : 0;
    m.fy = m.y = meals.length > 1 ? Math.sin(a) * ring : 0;
    mealAt.set(m.id.slice(5), m);
  });
  // Start foods beside their usual meal so the layout settles into tidy clusters.
  nodes.forEach((n, i) => {
    if (n.type === 'meal') return;
    const home = n.top_meal ? mealAt.get(n.top_meal) : undefined;
    const a = i * 2.39996;
    const d = 30 + (i % 7) * 12;
    n.x = (home?.x ?? 0) + Math.cos(a) * d;
    n.y = (home?.y ?? 0) + Math.sin(a) * d;
  });
  // Each food is drawn gently toward its usual meal; brands and the rest toward the middle.
  const anchor = (n: SimNode) => (n.top_meal ? mealAt.get(n.top_meal) : undefined);
  const home = (l: SimLink) => {
    const food = (typeof l.source === 'object' ? l.source : null) as SimNode | null;
    return food?.top_meal && endId(l.target) === `meal:${food.top_meal}`;
  };
  const sim = forceSimulation<SimNode>(nodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((n) => n.id)
        .distance((l) => (l.type === 'eaten_with' ? 55 : l.type === 'eaten_at' ? 95 : l.type === 'made_by' ? 38 : 60))
        .strength((l) =>
          l.type === 'eaten_at'
            ? home(l)
              ? 0.12 + Math.min(l.weight, 10) * 0.02
              : 0.01
            : l.type === 'eaten_with'
              ? 0.05 + Math.min(l.weight, 8) * 0.02
              : l.type === 'made_by'
                ? 0.5
                : 0.25,
        ),
    )
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength((n) => (n.type === 'meal' ? -400 : n.type === 'brand' ? -25 : -60))
        .distanceMax(260),
    )
    .force('collide', forceCollide<SimNode>((n) => (n.type === 'meal' ? n.r + 14 : n.r + 3.5)).iterations(2))
    .force(
      'x',
      forceX<SimNode>((n) => (anchor(n)?.x ?? 0) * 0.9).strength((n) => (anchor(n) ? 0.06 : 0.02)),
    )
    .force(
      'y',
      forceY<SimNode>((n) => (anchor(n)?.y ?? 0) * 0.9).strength((n) => (anchor(n) ? 0.06 : 0.02)),
    )
    .stop();
  sim.tick(360);
  return { nodes, links };
}

/** A gentle bow so parallel edges don't stack into one thick line. */
function arc(a: SimNode, b: SimNode): string {
  const dx = b.x! - a.x!;
  const dy = b.y! - a.y!;
  const cx = (a.x! + b.x!) / 2 - dy * 0.12;
  const cy = (a.y! + b.y!) / 2 + dx * 0.12;
  return `M${a.x},${a.y}Q${cx},${cy} ${b.x},${b.y}`;
}

const LABEL_PX = 11;
let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
/** Width of a label at LABEL_PX on screen, measured once with the page's own font. */
function textWidth(text: string, weight: number): number {
  const key = `${weight}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
    if (ctx) ctx.font = `${weight} ${LABEL_PX}px ${getComputedStyle(document.body).fontFamily}`;
    w = ctx ? ctx.measureText(text).width : text.length * LABEL_PX * 0.56;
    widths.set(key, w);
  }
  return w;
}

const short = (s: string) => (s.length > 24 ? `${s.slice(0, 23)}…` : s);
interface Label {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  text: string;
}
type Rect = [number, number, number, number];
const hits = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const hitsCircle = (r: Rect, n: SimNode) => {
  const cx = Math.max(r[0], Math.min(n.x!, r[2]));
  const cy = Math.max(r[1], Math.min(n.y!, r[3]));
  return (cx - n.x!) ** 2 + (cy - n.y!) ** 2 < n.r * n.r;
};

/**
 * Greedy label placement: most important first, each label tries below, above, right and left
 * of its circle and is dropped if every spot would overlap another label or circle. Positions are
 * in layout units, sized so text stays LABEL_PX on screen at zoom k; `view` is the visible area,
 * so a label at the edge of the box tries another side rather than being cut off.
 */
function placeLabels(nodes: SimNode[], k: number, focus: Set<string>, focusId: string | null, view: Rect | null): Map<string, Label> {
  const out = new Map<string, Label>();
  const placed: Rect[] = [];
  const fs = LABEL_PX / k;
  const pad = 2 / k;
  for (const m of nodes) if (m.type === 'meal') placed.push([m.x! - m.r, m.y! - m.r, m.x! + m.r, m.y! + m.r]);
  const rank = (n: SimNode) => (n.id === focusId ? 3 : focus.has(n.id) ? 2 : 0) + (n.type === 'brand' ? 0 : 1);
  const order = nodes.filter((n) => n.type !== 'meal' && (focusId ? focus.has(n.id) : true)).sort((a, b) => rank(b) - rank(a) || b.weight - a.weight);
  order.forEach((n, i) => {
    // Away from the focus, small circles only get a label once zoomed in enough to read it.
    if (!focusId && i > 45 && n.r * k < 9) return;
    const text = short(n.label);
    const w = textWidth(text, n.id === focusId ? 650 : 550) / k;
    const gap = 3 / k;
    const spots: [Label, Rect][] = [
      [{ x: n.x!, y: n.y! + n.r + gap + fs * 0.8, anchor: 'middle', text }, [n.x! - w / 2, n.y! + n.r + gap, n.x! + w / 2, n.y! + n.r + gap + fs]],
      [{ x: n.x!, y: n.y! - n.r - gap - fs * 0.2, anchor: 'middle', text }, [n.x! - w / 2, n.y! - n.r - gap - fs, n.x! + w / 2, n.y! - n.r - gap]],
      [{ x: n.x! + n.r + gap, y: n.y! + fs * 0.35, anchor: 'start', text }, [n.x! + n.r + gap, n.y! - fs / 2, n.x! + n.r + gap + w, n.y! + fs / 2]],
      [{ x: n.x! - n.r - gap, y: n.y! + fs * 0.35, anchor: 'end', text }, [n.x! - n.r - gap - w, n.y! - fs / 2, n.x! - n.r - gap, n.y! + fs / 2]],
    ];
    const must = n.id === focusId;
    for (const [label, rect] of spots) {
      const box: Rect = [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad];
      const off = view && (box[0] < view[0] || box[1] < view[1] || box[2] > view[2] || box[3] > view[3]);
      if (!must && (off || placed.some((p) => hits(p, box)) || nodes.some((m) => m !== n && m.type !== 'meal' && hitsCircle(box, m)))) continue;
      placed.push(box);
      out.set(n.id, label);
      return;
    }
  });
  return out;
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
  const [hover, setHover] = useState<string | null>(null);
  const [k, setK] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });

  useEffect(() => {
    setG(null);
    setSel(null);
    setHover(null);
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
  // Hovering (mouse only) previews what selecting would highlight.
  const focusId = hover ?? sel;
  const near = useMemo(() => new Set(focusId ? [focusId, ...(neighbours.get(focusId) ?? []).map((x) => x.node.id)] : []), [focusId, neighbours]);
  // Labels are re-placed per zoom step: that is what lets more of them appear as you zoom in.
  const svgW = svgRef.current?.clientWidth ?? 0;
  const svgH = svgRef.current?.clientHeight ?? 0;
  const view: Rect | null = svgW ? [-t.x / t.k, -t.y / t.k, (svgW - t.x) / t.k, (svgH - t.y) / t.k] : null;
  const viewKey = view?.map((v) => Math.round(v)).join() ?? '';
  const labels = useMemo(() => placeLabels(nodes, k, near, focusId, view), [nodes, k, near, focusId, viewKey]);

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
    // Extra room at the sides for labels that sit beside their circle.
    const x0 = Math.min(...nodes.map((n) => n.x! - n.r)) - 60;
    const x1 = Math.max(...nodes.map((n) => n.x! + n.r)) + 60;
    const y0 = Math.min(...nodes.map((n) => n.y! - n.r)) - 30;
    const y1 = Math.max(...nodes.map((n) => n.y! + n.r)) + 30;
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
        <div
          class="card relative h-[58dvh] min-h-[22rem] overflow-hidden lg:h-[72dvh]"
          style={{
            backgroundImage: 'radial-gradient(var(--line) 1px, transparent 1.2px)',
            backgroundSize: '20px 20px',
            backgroundPosition: `${t.x}px ${t.y}px`,
          }}
        >
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
              {/* Each meal's quarter gets a soft wash so the clusters read at a glance. */}
              {nodes
                .filter((n) => n.type === 'meal')
                .map((m) => (
                  <circle cx={m.x} cy={m.y} r={m.r * 3.2} fill="url(#meal-wash)" opacity={focusId && !near.has(m.id) ? 0.3 : 1} class="transition-opacity" />
                ))}
              <g fill="none" stroke-linecap="round">
                {links.map((l) => {
                  const a = l.source as SimNode;
                  const b = l.target as SimNode;
                  const on = !!focusId && (a.id === focusId || b.id === focusId);
                  const base = l.type === 'eaten_with' ? 0.32 : l.type === 'eaten_at' ? 0.09 : l.type === 'made_by' ? 0.3 : 0.45;
                  const w = l.type === 'eaten_with' ? 0.8 + Math.min(l.weight, 8) * 0.35 : l.type === 'eaten_at' ? 0.6 + Math.min(l.weight, 10) * 0.08 : 0.9;
                  return (
                    <path
                      d={arc(a, b)}
                      stroke={l.type === 'eaten_with' ? 'var(--accent)' : l.type === 'eaten_at' ? 'var(--mustard)' : COLOR[b.type === 'food' ? a.type : b.type]}
                      stroke-opacity={focusId ? (on ? 0.85 : 0.03) : base}
                      stroke-width={(on ? w + 0.6 : w) / Math.sqrt(k)}
                      stroke-dasharray={l.type === 'ingredient' ? `${3 / k} ${3 / k}` : undefined}
                      class="transition-[stroke-opacity]"
                    />
                  );
                })}
              </g>
              {nodes.map((n) => {
                const dim = !!focusId && !near.has(n.id);
                const sw = 1.5 / Math.sqrt(k);
                return (
                  <g
                    transform={`translate(${n.x},${n.y})`}
                    class="cursor-pointer transition-opacity"
                    opacity={dim ? 0.15 : 1}
                    onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(n.id)}
                    onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSel(sel === n.id ? null : n.id);
                    }}
                  >
                    {n.id === sel && <circle r={n.r + 4 / Math.sqrt(k)} fill="none" stroke="var(--ink)" stroke-width={sw} />}
                    {n.type === 'meal' ? (
                      <>
                        <circle r={n.r} fill="var(--mustard-soft)" stroke="var(--mustard)" stroke-width={sw * 1.3} />
                        <text
                          y={(LABEL_PX + 1) / k / 2.8}
                          text-anchor="middle"
                          font-size={(LABEL_PX + 1) / k}
                          font-weight={700}
                          letter-spacing={0.02}
                          fill="var(--ink)"
                          stroke="var(--mustard-soft)"
                          stroke-width={3 / k}
                          paint-order="stroke"
                          style={{ pointerEvents: 'none' }}
                        >
                          {n.label}
                        </text>
                      </>
                    ) : n.type === 'brand' ? (
                      // Brands are context, not food: hollow so the eye goes to what was eaten.
                      <circle r={n.r} fill="var(--card)" stroke={COLOR.brand} stroke-width={sw} />
                    ) : (
                      <circle r={n.r} fill={COLOR[n.type]} stroke="var(--card)" stroke-width={sw} />
                    )}
                  </g>
                );
              })}
              <g style={{ pointerEvents: 'none' }} stroke="var(--card)" stroke-width={3 / k} paint-order="stroke" stroke-linejoin="round">
                {nodes.map((n) => {
                  const lb = labels.get(n.id);
                  if (!lb) return null;
                  return (
                    <text
                      x={lb.x}
                      y={lb.y}
                      text-anchor={lb.anchor}
                      font-size={LABEL_PX / k}
                      font-weight={n.id === focusId ? 650 : 550}
                      fill={n.type === 'brand' ? 'var(--ink-2)' : 'var(--ink)'}
                    >
                      {lb.text}
                    </text>
                  );
                })}
              </g>
            </g>
            <defs>
              <radialGradient id="meal-wash">
                <stop offset="0" stop-color="var(--mustard)" stop-opacity="0.13" />
                <stop offset="1" stop-color="var(--mustard)" stop-opacity="0" />
              </radialGradient>
            </defs>
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
