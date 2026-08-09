import assert from "node:assert/strict";
import test from "node:test";
import {
  followingImportIntervalSeconds,
  snapshotMatchesUserName,
  type FollowingSnapshot,
} from "../src/lib/server/following-import";

const snapshot: FollowingSnapshot = {
  twitterUserName: "circle_owner",
  importedAt: "2026-08-09T00:00:00.000Z",
  nextAllowedAt: "2026-08-09T06:00:00.000Z",
  followings: [],
};

test("the server import interval is exactly six hours", () => {
  assert.equal(followingImportIntervalSeconds, 21_600);
});

test("a retained snapshot is only served for the username it was fetched for", () => {
  assert.equal(snapshotMatchesUserName(snapshot, "circle_owner"), true);
  assert.equal(snapshotMatchesUserName(snapshot, "another_owner"), false);
  assert.equal(snapshotMatchesUserName(null, "circle_owner"), false);
});
