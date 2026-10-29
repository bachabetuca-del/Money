import { sql, type SQLWrapper } from "drizzle-orm";

/** Must match publicDirection(outcome, undefined, book), including legacy book fallback. */
export function explorerDirection(outcome: SQLWrapper, book: SQLWrapper) {
  return sql<string>`case
    when lower(trim(${outcome})) in ('yes', 'no') then lower(trim(${outcome}))
    when lower(trim(${book})) = 'bid' then 'yes'
    when lower(trim(${book})) = 'ask' then 'no'
    else 'unknown' end`;
}
