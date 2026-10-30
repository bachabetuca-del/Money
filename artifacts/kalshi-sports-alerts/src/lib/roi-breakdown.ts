/** Display helpers for weekly and observed-transaction-size breakdowns. Never invent values for empty groups. */
export type MoneyBandKey = 'small' | 'medium' | 'large';

export const MONEY_BANDS: Record<MoneyBandKey, { short: string; range: string }> = {
  small: { short: '$1k–$5k', range: '$1,000 a $5,000, ambos incluidos' },
  medium: { short: '$5k–$10k', range: 'más de $5,000 y menos de $10,000' },
  large: { short: '≥ $10k', range: '$10,000 o más' },
};
export const MONEY_BAND_ORDER: MoneyBandKey[] = ['small', 'medium', 'large'];

export const NO_DATA = 'Sin datos';

/** Nullable rate: null/non-finite renders "Sin datos", never 0%. */
export function ratePct(v: number | null | undefined, sign = true) {
  if (v == null || !Number.isFinite(v)) return NO_DATA;
  const s = v.toLocaleString('es-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return sign && v > 0 ? `+${s}%` : `${s}%`;
}

export function rateTone(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return 'none';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}

export function signedUsd(v: number) {
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(v));
  return v < 0 ? `-${s}` : v > 0 ? `+${s}` : s;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** weekStart is a Monday civil date (America/New_York); compute Sunday purely in civil-date arithmetic. */
export function weekRange(weekStart: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart);
  if (!m) return weekStart;
  const start = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const f = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${f(start)} – ${f(end)}`;
}

export function bandLabel(band: string | null | undefined) {
  return band && band in MONEY_BANDS ? MONEY_BANDS[band as MoneyBandKey].short : 'Todos los importes';
}

type Comparable = { band: MoneyBandKey; roiPct: number | null; winRatePct: number | null; trades: number; meetsMinimum?: boolean };

/** DOM-safe id fragment for arbitrary row ids (may contain spaces, quotes, JSON). */
export function domId(prefix: string, id: string) {
  return `${prefix}-${Array.from(new TextEncoder().encode(id), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Bands with the highest observed value; ties return several bands. Empty or explicitly under-minimum subgroups never win. */
export function bandLeaders(items: Comparable[]) {
  const top = (key: 'roiPct' | 'winRatePct') => {
    const valid = items.filter((i) => i.trades > 0 && i.meetsMinimum !== false && i[key] != null && Number.isFinite(i[key] as number));
    if (!valid.length) return null;
    const max = Math.max(...valid.map((i) => i[key] as number));
    return { value: max, bands: valid.filter((i) => Math.abs((i[key] as number) - max) < 1e-9).map((i) => i.band) };
  };
  return { roi: top('roiPct'), winRate: top('winRatePct') };
}
