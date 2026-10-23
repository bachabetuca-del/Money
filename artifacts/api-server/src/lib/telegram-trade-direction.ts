export type PublicDirection = "yes" | "no" | "unknown";

/** Kalshi canonical direction: outcome first, then bid≡YES / ask≡NO, then legacy. */
export function publicDirection(outcome?: string | null, legacy?: string | null, bookSide?: string | null): PublicDirection {
  const side = outcome?.trim().toLowerCase();
  if (side === "yes" || side === "no") return side;
  const book = bookSide?.trim().toLowerCase();
  if (book === "bid" || book === "ask") return book === "bid" ? "yes" : "no";
  const fallback = legacy?.trim().toLowerCase();
  return fallback === "yes" || fallback === "no" ? fallback : "unknown";
}

export function directionLabel(side: PublicDirection) {
  return side === "yes" ? "A favor de" : side === "no" ? "En contra de" : "Dirección no disponible";
}

export function directionMeaning(side: PublicDirection) {
  return side === "yes" ? "Compra de SÍ o venta de NO" :
    side === "no" ? "Compra de NO o venta de SÍ" : "Sin datos para distinguir la dirección";
}

export const DIRECTION_NOTE = "Dirección pública; no identifica al operador ni confirma una venta o cierre.";
