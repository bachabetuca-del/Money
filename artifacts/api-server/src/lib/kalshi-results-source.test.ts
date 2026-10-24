import assert from "node:assert/strict";
import { test } from "node:test";
import { finalScore, KalshiResultsSource } from "./kalshi-results-source";

test("final score maps home/away IDs, preserves zero, and uses explicit winner", () => {
  const details = { status: "closed", home_points: 0, away_points: 2, winner: "a" };
  const meta = { home_team_id: "h", away_team_id: "a" };
  assert.equal(finalScore(details, meta, { h: "Madrid", a: "Barcelona" }),
    "Madrid 0–2 Barcelona");
  for (const status of ["live", "scheduled", "unknown"]) {
    assert.equal(finalScore({ ...details, status }, meta, { h: "Madrid", a: "Barcelona" }), null);
  }
  assert.equal(finalScore({ ...details, live_data_delayed: true }, meta, { h: "Madrid", a: "Barcelona" }), null);
  assert.equal(finalScore(details, meta, {}), null);
  assert.equal(finalScore({ ...details, home_points: null }, meta, { h: "Madrid", a: "Barcelona" }), null);
});

test("tennis uses competitor IDs, never event-title or home/away order assumptions", () => {
  assert.equal(finalScore({ status: "closed", competitor1_id: "b", competitor2_id: "a",
    competitor1_overall_score: 2, competitor2_overall_score: 1, winner: "b" },
  {}, { a: "Kawa", b: "Rybakina" }), "Rybakina 2–1 Kawa");
});

test("tennis includes completed set scores in the same participant order", () => {
  assert.equal(finalScore({ status: "closed", competitor1_id: "s", competitor2_id: "p",
    competitor1_overall_score: 1, competitor2_overall_score: 2,
    competitor1_round_scores: [{score:6},{score:6},{score:6}],
    competitor2_round_scores: [{score:2},{score:7},{score:7}] },
  {}, { s: "Shibahara", p: "Parks" }), "Shibahara 1–2 Parks · Sets: 6–2, 6–7, 6–7");
});

test("unknown milestone uses historical market discovery only on 404, never its settlement as a score", async () => {
  const calls: string[] = [];
  const source = new KalshiResultsSource(async <T>(path: string): Promise<T> => {
    calls.push(path);
    if (path === "/markets/T") throw new Error("HTTP 404");
    if (path === "/historical/markets/T") return { market: { status: "settled", result: "no" } } as T;
    throw new Error("HTTP 404");
  });
  assert.deepEqual(await source.resolve("T", null), { gameResult: null, marketResult: null });
  assert.ok(calls.includes("/historical/markets/T"));
  const failed = new KalshiResultsSource(async () => { throw new Error("HTTP 500"); });
  await assert.rejects(failed.resolve("T", null), /HTTP 500/);
});

test("shared milestone and team names reuse requests across markets", async () => {
  const calls: string[] = [];
  const source = new KalshiResultsSource(async <T>(path: string): Promise<T> => {
    calls.push(path);
    if (path.startsWith("/markets/")) return { market: { status: "settled", result: "yes" } } as T;
    if (path.startsWith("/milestones/")) return { milestone: { details: { home_team_id: "h", away_team_id: "a" } } } as T;
    if (path.startsWith("/live_data/")) return { live_data: { details: { status: "closed", home_points: 3, away_points: 1, winner: "h" } } } as T;
    return { structured_target: { name: path.endsWith("/h") ? "Home" : "Away" } } as T;
  });
  assert.equal((await source.resolve("ONE", "m")).gameResult, "Home 3–1 Away");
  await source.resolve("TWO", "m");
  assert.equal(calls.filter(p => p.startsWith("/live_data/")).length, 1);
  assert.equal(calls.filter(p => p.startsWith("/structured_targets/")).length, 2);
  assert.equal(calls.filter(p => p.startsWith("/markets/")).length, 0);
});
