const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Only a provider schedule supplies a kickoff time; never infer it from a ticker. */
export function gameTimeLabel(startsAt?: string | null) {
  const date = startsAt ? new Date(startsAt) : null;
  if (!date || !Number.isFinite(date.getTime())) return "Hora por confirmar";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date) + " ET";
}

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

/** Calendar keys, not localized labels, are used for date comparisons. */
export function newYorkDay(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function gameCalendarDay(ticker: string, startsAt?: string | null): string | null {
  if (startsAt && Number.isFinite(new Date(startsAt).getTime())) return newYorkDay(new Date(startsAt));
  const match = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!match) return null;
  const year = 2000 + Number(match[1]), month = MONTHS.indexOf(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return month >= 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month &&
    date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}

function formatDate(date: Date, timeZone: string) {
  return date.toLocaleDateString("es-ES", {
    timeZone, day: "2-digit", month: "short", year: "numeric",
  }).replaceAll(".", "");
}
