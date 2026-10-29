export type MarketType = "winner" | "spread" | "total" | "props" | "futures" | "other";

type MarketIdentity = { ticker: string; eventTitle: string | null; marketTitle: string | null };

/** Series identifiers are stronger evidence than team/player names in titles. */
export function marketType(market: MarketIdentity): MarketType {
  const series = market.ticker.split("-")[0].toUpperCase();
  const title = `${market.eventTitle ?? ""} ${market.marketTitle ?? ""}`.toLowerCase();
  if (/SPREAD|HANDICAP|PUCKLINE|RUNLINE/.test(series)) return "spread";
  if (/TOTAL|OU$/.test(series)) return "total";
  if (/CHAMP|TITLE|PLAYOFF|SUPERBOWL|WORLDSERIES|MVP/.test(series) ||
      /\b(championship|champion|win the league|win the title|make the playoffs|campe[oó]n)\b/.test(title)) return "futures";
  if (/PTS$|REBS?$|AST$|3PT|PASSYDS|RUSHYDS|RECYDS|TOUCHDOWN|STRIKEOUT|HOMERUN|PLAYER/.test(series) ||
      /\b(player|jugador|rebounds?|assists?|strikeouts?|passing yards|rushing yards|receiving yards|touchdowns?|home runs?|three.pointers?)\b/.test(title)) return "props";
  if (/\b(spread|handicap|h[aá]ndicap)\b|win(?:s)? by (?:over|more than|at least)|gana por m[aá]s de/.test(title)) return "spread";
  if (/\btotal (?:points|runs|goals|games|sets|score)\b|\b(?:over|under|m[aá]s de|menos de) \d+(?:\.\d+)? (?:points|runs|goals|games|sets|puntos|goles)\b/.test(title)) return "total";
  if (/(?:GAME|MATCH|FIGHT|BOUT|MONEYLINE)$/.test(series) ||
      /\b(?:moneyline|game winner|match winner)\b|\b(?:to win|wins|will win|gana|empate|draw)\s*[?!.]?$/.test((market.marketTitle ?? "").toLowerCase())) return "winner";
  return "other";
}
