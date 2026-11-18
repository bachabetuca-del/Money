/** Test-only reconstruction of the pre-optimization fee lookup. Keeps all
 * other ROI SQL identical, so comparisons cannot quietly test another formula. */
import assert from "node:assert/strict";
import { sql, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

export function legacyRoiFeeQuery(query: SQLWrapper | string) {
  assert.notEqual(typeof query, "string");
  const compiled = new PgDialect().sqlToQuery((query as SQLWrapper).getSQL());
  let text = compiled.sql;
  const replace = (pattern: RegExp, replacement: string) => {
    const old = text;
    text = text.replace(pattern, replacement);
    assert.notEqual(text, old, "The baseline adapter must match the current fee-only optimization");
  };
  replace(/fee_catalog AS MATERIALIZED/, "fee_catalog AS");
  replace(/, series_fees AS MATERIALIZED \([\s\S]*?\), base AS \(/, ", base AS (");
  replace(/g\.event_ticker IS NOT NULL AND sf\.ticker IS NOT NULL AS fee_known/,
    "g.event_ticker IS NOT NULL AND (f.rules->'series'->split_part(a.ticker, '-', 1)) IS NOT NULL AS fee_known");
  replace(/coalesce\(ef\.fee_type, sf\.fee_type\) AS fee_type/,
    "coalesce(f.rules->'events'->g.event_ticker->>'feeType', f.rules->'series'->split_part(a.ticker, '-', 1)->>'feeType') AS fee_type");
  replace(/coalesce\(ef\.fee_multiplier, sf\.fee_multiplier\)::numeric AS fee_multiplier/,
    "coalesce(f.rules->'events'->g.event_ticker->>'multiplier', f.rules->'series'->split_part(a.ticker, '-', 1)->>'multiplier')::numeric AS fee_multiplier");
  replace(/FROM kalshi_alerts a/, "FROM kalshi_alerts a CROSS JOIN fee_catalog f");
  replace(/\s+LEFT JOIN series_fees sf ON sf\.ticker = split_part\(a\.ticker, '-', 1\)/, "");
  replace(/\s+LEFT JOIN event_fees ef ON ef\.event_ticker = g\.event_ticker/, "");
  // Rebind every original parameter; never interpolate values into SQL.
  const chunks = text.split(/(\$\d+)/).map(part => /^\$\d+$/.test(part)
    ? sql`${compiled.params[Number(part.slice(1)) - 1]}` : sql.raw(part));
  return sql.join(chunks, sql``);
}
