const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Prefer the real schedule; ticker dates are a fallback, never trade/import dates. */
export function gameDateLabel(ticker: string, startsAt?: string | null) {
  if (startsAt) {
    const scheduled = new Date(startsAt);
    if (Number.isFinite(scheduled.getTime())) return formatDate(scheduled, "America/New_York");
  }
  const match = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (match) {
    const year = 2000 + Number(match[1]);
    const month = MONTHS.indexOf(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month, day));
    if (month >= 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month &&
        date.getUTCDate() === day) return formatDate(date, "UTC");
  }
  return "Sin fecha";
}

function formatDate(date: Date, timeZone: string) {
  return date.toLocaleDateString("es-ES", {
    timeZone, day: "2-digit", month: "short", year: "numeric",
  }).replaceAll(".", "");
}
