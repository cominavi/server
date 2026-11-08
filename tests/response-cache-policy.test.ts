import assert from "node:assert/strict";
import test from "node:test";
import { realtimeCachePolicy } from "../src/api/routers/realtime-updates";

test("realtime cache policy is decided from the typed tag overlay status", () => {
  assert.equal(realtimeCachePolicy(undefined), "public-realtime");
  assert.equal(realtimeCachePolicy("current"), "public-realtime");
  assert.equal(realtimeCachePolicy("absent"), "public-realtime");
  assert.equal(realtimeCachePolicy("invalidated"), "no-store");
  assert.equal(realtimeCachePolicy("unavailable"), "no-store");
});
