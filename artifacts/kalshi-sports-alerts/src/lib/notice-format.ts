import type { TelegramNotice, TelegramNoticeRoi } from '@workspace/api-client-react';

/** Selected-side price in cents; never complements NO. */
export function priceCents(price: number | null): string {
  if (price == null || !Number.isFinite(price)) return 'Precio no registrado';
  return `${(price * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}¢`;
}

export function sideLabel(side: TelegramNotice['side']): string {
  return side === 'yes' ? 'SÍ' : side === 'no' ? 'NO' : 'Lado no registrado';
}

export function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Desconocido';
  const s = Math.abs(value).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${s}%`;
}

export function basisLabel(basis: TelegramNoticeRoi['basis']): string {
  return basis === 'net' ? 'ROI histórico neto estimado' : 'ROI histórico bruto';
}

export interface RoiView { headline: string; label: string; other: string | null; sample: string | null; tone: 'pos' | 'neg' | 'none' }

export function roiView(roi: TelegramNoticeRoi | null): RoiView {
  if (!roi) return { headline: 'ROI no registrado', label: 'Aviso anterior sin ROI guardado', other: null, sample: null, tone: 'none' };
  const other = roi.basis === 'net'
    ? `Bruto: ${pct(roi.grossRoiPct)}`
    : `Neto estimado: ${roi.netRoiPct == null ? 'desconocido' : pct(roi.netRoiPct)}`;
  return {
    headline: pct(roi.roiPct),
    label: basisLabel(roi.basis),
    other,
    sample: `${roi.games.toLocaleString('es-ES')} partidos · ${roi.trades.toLocaleString('es-ES')} operaciones`,
    tone: roi.roiPct > 0 ? 'pos' : roi.roiPct < 0 ? 'neg' : 'none',
  };
}

export function usd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Monto no registrado';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

export function contractsText(n: number | null): string {
  return n == null ? 'Contratos no registrados' : `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} contratos`;
}

export function etTime(value: string | null): string {
  if (!value) return 'No registrado';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('es-US', { timeZone: 'America/New_York', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d) + ' ET';
}

export function sportName(s: string): string {
  const t = s.trim();
  const labels: Record<string, string> = {
    soccer: 'Fútbol', football: 'Fútbol americano', basketball: 'Baloncesto', tennis: 'Tenis',
    baseball: 'Béisbol', hockey: 'Hockey', golf: 'Golf', esports: 'Esports',
    'combat sports': 'Deportes de combate', motorsport: 'Automovilismo', cricket: 'Críquet',
  };
  return labels[t.toLowerCase()] ?? (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Deporte no registrado');
}

export function safeKalshiUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['kalshi.com', 'www.kalshi.com'].includes(u.hostname) &&
      !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}
