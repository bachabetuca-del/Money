import assert from "node:assert/strict";
import { test } from "node:test";
import { GetKalshiExplorerQueryParams } from "../src/generated/api.ts";

test("explorer validates filters rather than silently mixing bands or windows", () => {
  assert.equal(GetKalshiExplorerQueryParams.safeParse({ band: "medium", scope: "history", window: "24h" }).success, true);
  for (const query of [{ band: "all" }, { scope: "everything" }, { window: "7d" }, { ticker: "x".repeat(201) }, { band: ["large", "medium"] }]) {
    assert.equal(GetKalshiExplorerQueryParams.safeParse(query).success, false);
  }
  assert.deepEqual(GetKalshiExplorerQueryParams.parse({}), { band: "large", scope: "active", window: "all" });
});
