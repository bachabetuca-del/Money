import type { PaperInterval } from "@workspace/api-zod";

export type Observation = { game: string; date: string; cost: number; profit: number };
export const ratio = (rows: Pick<Observation, "cost" | "profit">[]): number | null => {
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  return cost > 0 ? 100 * rows.reduce((s, r) => s + r.profit, 0) / cost : null;
};
function random(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function bootstrap(rows: Observation[], block: "game" | "date" = "game"): PaperInterval | undefined {
  const groups = new Map<string, { cost: number; profit: number }>();
  for (const r of rows) {
    const id = r[block], g = groups.get(id) ?? { cost: 0, profit: 0 };
    g.cost += r.cost; g.profit += r.profit; groups.set(id, g);
  }
  const data = [...groups.values()];
  if (data.length < 10) return undefined; // No cosmetically precise tiny-sample intervals.
  const rand = random(41321), outcomes: number[] = [];
  for (let b = 0; b < 800; b++) {
    let cost = 0, profit = 0;
    for (let i = 0; i < data.length; i++) {
      const r = data[Math.floor(rand() * data.length)]; cost += r.cost; profit += r.profit;
    }
    if (cost > 0) outcomes.push(100 * profit / cost);
  }
  outcomes.sort((a, b) => a - b);
  if (outcomes.length < 760) return undefined;
  return { lower: outcomes[Math.floor(outcomes.length * .025)], upper: outcomes[Math.floor(outcomes.length * .975)],
    clusters: data.length };
}

export type PairedObservation = Observation & { controlGame: string; controlCost: number; controlProfit: number };
/** Connected game blocks ensure a game appearing in multiple pairs is not
 * resampled as independent evidence, even when it appears on both sides. */
export function pairedInterval(rows: PairedObservation[]): PaperInterval | undefined {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (!p) { parent.set(x, x); return x; }
    if (p === x) return x;
    const root = find(p); parent.set(x, root); return root;
  };
  for (const r of rows) parent.set(find(r.game), find(r.controlGame));
  const grouped = new Map<string, { c: number; p: number; cc: number; cp: number }>();
  for (const r of rows) {
    const id = find(r.game), g = grouped.get(id) ?? { c: 0, p: 0, cc: 0, cp: 0 };
    g.c += r.cost; g.p += r.profit; g.cc += r.controlCost; g.cp += r.controlProfit; grouped.set(id, g);
  }
  const blocks = [...grouped.values()];
  if (blocks.length < 10) return undefined;
  const rand = random(51217), outcomes: number[] = [];
  for (let b = 0; b < 800; b++) {
    let c = 0, p = 0, cc = 0, cp = 0;
    for (let i = 0; i < blocks.length; i++) {
      const g = blocks[Math.floor(rand() * blocks.length)]; c += g.c; p += g.p; cc += g.cc; cp += g.cp;
    }
    if (c && cc) outcomes.push(100 * (p / c - cp / cc));
  }
  outcomes.sort((a, b) => a - b);
  if (outcomes.length < 760) return undefined;
  return { lower: outcomes[Math.floor(outcomes.length * .025)], upper: outcomes[Math.floor(outcomes.length * .975)],
    clusters: blocks.length };
}
