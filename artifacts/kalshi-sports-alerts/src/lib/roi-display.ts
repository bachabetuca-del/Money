const SPORTS: Record<string, string> = {
  basketball: 'Baloncesto', soccer: 'Fútbol', football: 'Fútbol americano',
  baseball: 'Béisbol', tennis: 'Tenis', hockey: 'Hockey', golf: 'Golf',
  esports: 'Esports', 'combat sports': 'Deportes de combate', cricket: 'Críquet',
  motorsport: 'Automovilismo',
};

export const ROI_MARKET_NAMES: Record<string, string> = {
  winner: 'Ganador', spread: 'Hándicap', total: 'Totales', props: 'Estadísticas de jugadores',
  futures: 'Campeonatos / Futuros', other: 'Otros / Sin clasificar',
};

export function roiSportLabel(sport: string | null | undefined) {
  return sport ? SPORTS[sport.trim().toLowerCase()] ?? sport : 'Sin clasificar';
}

/** Prices are for the observed side, including NO; never complement them again. */
export function americanOdds(price: number) {
  if (!Number.isFinite(price) || price < 0 || price > 1) return 'n/d';
  if (price === 0) return '+∞';
  if (price === 1) return '−∞';
  return price <= 0.5
    ? `+${Math.round(100 * (1 - price) / price)}`
    : `−${Math.round(100 * price / (1 - price))}`;
}

export function americanOddsRange(lo: number | null, hi: number | null) {
  if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi) ||
      lo < 0 || hi > 1 || lo >= hi) return 'n/d';
  return `${americanOdds(lo)} a ${americanOdds(hi)}`;
}

export function oddsBoundaryText(lo: number | null, hi: number | null) {
  if (lo == null || hi == null) return 'Rango de precio no disponible';
  return `${Math.round(lo * 100)}¢ ${lo === 0 ? '<' : '≤'} precio del lado operado ${hi === 1 ? '≤' : '<'} ${Math.round(hi * 100)}¢`;
}
