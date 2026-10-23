function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const TZ = "America/New_York";

function nyParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

const pad = (value: number) => String(value).padStart(2, "0");
export const nyDay = (date: Date) => { const p = nyParts(date); return `${p.day} ${MONTHS[p.month - 1]}`; };
export const nyTime = (date: Date, seconds = false) => {
  const p = nyParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}${seconds ? `:${pad(p.second)}` : ""}`;
};
export const nyDateTime = (date: Date) => `${nyDay(date)} ${nyParts(date).year} · ${nyTime(date)}`;

/** Exact dollars, always full digits (no rounding of totals). */
export function exactMoney(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 });
}

/** Axis-only compact form: "$12 mil", "$1,25 M". */
export function axisMoney(value: number) {
  const fmt = (n: number, digits: number) => n.toLocaleString("es-ES", { maximumFractionDigits: digits, useGrouping: false }).replace(".", ",");
  if (value >= 1_000_000) return `$${fmt(value / 1_000_000, 2)} M`;
  if (value >= 1000) return `$${fmt(value / 1000, value >= 100_000 ? 0 : 1)} mil`;
  return `$${Math.round(value)}`;
}

export function elapsed(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "hace menos de 1 min";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} días`;
}

/** Word wrap by estimated glyph width; splits words longer than a line. */
export function wrapLines(text: string, maxWidth: number, fontSize: number, maxLines = 4) {
  const maxChars = Math.max(6, Math.floor(maxWidth / (fontSize * 0.6)));
  const words = text.trim().split(/\s+/).flatMap(word => {
    const pieces: string[] = [];
    for (let i = 0; i < word.length; i += maxChars) pieces.push(word.slice(i, i + maxChars));
    return pieces;
  });
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxChars) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, maxChars - 1)}…`;
    return kept;
  }
  return lines;
}

export function textBlock(text: string, x: number, y: number, fontSize: number, maxWidth: number,
  color: string, weight = 600, maxLines = 4) {
  const lines = wrapLines(text, maxWidth, fontSize, maxLines);
  const lineHeight = Math.round(fontSize * 1.22);
  return {
    svg: lines.map((value, index) => `<text x="${x}" y="${y + index * lineHeight}" font-size="${fontSize}" font-weight="${weight}" fill="${color}">${escapeHtml(value)}</text>`).join(""),
    height: lines.length * lineHeight,
  };
}

/** Largest font size (down to min) at which a single line fits the width. */
export function fitSize(text: string, maxWidth: number, preferred: number, minimum: number) {
  let size = preferred;
  while (size > minimum && text.length * size * 0.62 > maxWidth) size -= 2;
  return size;
}
