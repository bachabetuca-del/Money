export type PublicDirection = "yes" | "no" | "unknown";

/** Explicit outcome is authoritative; book side never overrides or supplies it. */
export function publicDirection(outcome?: string | null, legacy?: string | null): PublicDirection {
  const side = outcome?.trim().toLowerCase();
  if (side === "yes" || side === "no") return side;
  const fallback = legacy?.trim().toLowerCase();
  return fallback === "yes" || fallback === "no" ? fallback : "unknown";
}

export function directionLabel(side: PublicDirection) {
  return side === "yes" ? "A favor de" : side === "no" ? "En contra de" : "Dirección no disponible";
}

export const DIRECTION_NOTE = "Dirección pública; no identifica al operador ni confirma una venta o cierre.";
