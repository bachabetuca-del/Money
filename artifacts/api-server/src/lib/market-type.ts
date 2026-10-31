import type { GetKalshiExplorerMarketType } from "@workspace/api-zod";

export type MarketType = Exclude<GetKalshiExplorerMarketType, "all">;

type MarketIdentity = { ticker: string; eventTitle: string | null; marketTitle: string | null; sport?: string };

/** Series identifiers are stronger evidence than team/player names in titles. */
export function marketType(market: MarketIdentity): MarketType {
  const series = market.ticker.split("-")[0].toUpperCase();
  const title = `${market.eventTitle ?? ""} ${market.marketTitle ?? ""}`.toLowerCase();
  const soccer = market.sport?.trim().toLowerCase() === "soccer";
  if (/SPREAD|HANDICAP|PUCKLINE|RUNLINE/.test(series)) return "spread";
  if (/TOTAL|OU$/.test(series)) return "total";
  if (/BTTS$/.test(series)) return "btts";
  if (/CORRECTSCORE$/.test(series) ||
      (soccer && /SCORE$/.test(series) && !/FIRST|LAST|ANYTIME/.test(series))) return "correctScore";
  if (/CORNERS$/.test(series)) return "corners";
  if (/ADVANCE$|QUALIFY$|QUALIFICATION$/.test(series)) return "qualification";
  if (/(?:[12]H|[1-4]Q|[1-3]P)$/.test(series)) return "periodWinner";
  if (/GOALSCORER$/.test(series) || (soccer && /GOAL$/.test(series) && !/TEAM/.test(series))) return "props";
  // A league name can contain CHAMPIONSHIP: its GAME/1H markets are still
  // single-match bets, not season futures. Prefer the explicit series suffix.
  if (/(?:GAME|MATCH|FIGHT|BOUT|MONEYLINE)$/.test(series)) return "winner";
  if (/CHAMP|TITLE|PLAYOFF|SUPERBOWL|WORLDSERIES|MVP|BALLONDOR/.test(series) ||
      /\b(championship|champion|win the league|win the title|make the playoffs|campe[oó]n|golden boot|ballon d['’]or|bal[oó]n de oro)\b|\b(?:league|cup|tournament|season|trophy) winner\b|\btop \d+ finishers\b/.test(title)) return "futures";
  if (/\bboth teams (?:to )?score\b|\bambos (?:equipos )?(?:marcan|anotan)\b/.test(title)) return "btts";
  if (/\b(?:correct|exact|final) score\b|\bmarcador exacto\b/.test(title)) return "correctScore";
  if (/\bcorners?\b|\bsaques? de esquina\b/.test(title)) return "corners";
  if (/\b(?:to advance|advances?|to qualify|qualifies|avanza|clasifica)\b/.test(title)) return "qualification";
  if (/\b(?:half|quarter|period) winner\b|\b(?:wins?|draw|tie)(?: the)? (?:1st|2nd|3rd|4th|first|second|third|fourth) (?:half|quarter|period)\b/.test(title)) return "periodWinner";
  if (/PTS$|REBS?$|AST$|3PT|PASSYDS|RUSHYDS|RECYDS|TOUCHDOWN|STRIKEOUT|HOMERUN|PLAYER/.test(series) ||
      /\b(player|jugador|goal ?scorers?|goleador|rebounds?|assists?|strikeouts?|passing yards|rushing yards|receiving yards|touchdowns?|home runs?|three.pointers?)\b/.test(title)) return "props";
  if (/\b(spread|handicap|h[aá]ndicap)\b|win(?:s)? by (?:over|more than|at least)|gana por m[aá]s de/.test(title)) return "spread";
  if (/\btotal (?:points|runs|goals|games|sets|score)\b|\b(?:over|under|m[aá]s de|menos de) \d+(?:\.\d+)? (?:points|runs|goals|games|sets|puntos|goles)\b/.test(title)) return "total";
  if (/\b(?:moneyline|game winner|match winner)\b|\b(?:to win|wins|will win|gana|empate|draw)\s*[?!.]?$/.test((market.marketTitle ?? "").toLowerCase())) return "winner";
  return "other";
}
