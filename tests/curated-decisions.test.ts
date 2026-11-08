import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  commitCuratedDecision,
  curatedDecisionRequestSHA256,
  mintCuratedDecisionID,
  readCuratedDecisionHistory,
  readCuratedLedger,
  type CuratedDecisionActor,
} from "../src/lib/server/curated-decisions";
import { ServiceError } from "../src/lib/server/service-error";
import { SQLiteD1Database } from "./sqlite-d1";

const migrations = [
  "migrations/0001_following_imports.sql",
  "migrations/0002_realtime_service.sql",
  "migrations/0003_accounts_shared_plans.sql",
  "migrations/0004_sanitized_catalog.sql",
  "migrations/0005_shared_plan_crdt_notifications.sql",
  "migrations/0006_notification_inbox.sql",
  "migrations/0007_catalog_genres_all_days.sql",
  "migrations/0008_circle_tag_overlays.sql",
  "migrations/0009_crawler_realtime_snapshots.sql",
  "migrations/0010_shinagaki_analysis.sql",
  "migrations/0011_catalog_identity.sql",
  "migrations/0012_curated_decisions.sql",
];

const operator: CuratedDecisionActor = {
  kind: "operator",
  subject: "op:fixture",
};
const version = "c108-v1-0123456789abcdef01234567";

function caseFixture(name: string): {
  steps: Array<{
    request: any;
    requestSHA256: string;
    expect: Record<string, any>;
  }>;
} {
  return JSON.parse(
    readFileSync(
      `tests/fixtures/catalog-contracts/decision-requests/${name}`,
      "utf8",
    ),
  );
}

/** comiket-108 with circles 10000001..10000003 and the given capabilities. */
function ledgerDatabase(
  capabilities: Record<string, "supported" | "unsupported"> = {
    attendanceStatus: "supported",
    socialEnrichment: "supported",
  },
): SQLiteD1Database {
  const db = new SQLiteD1Database(
    migrations.map((path) => readFileSync(path, "utf8")).join("\n"),
  );
  db.native.exec(`
    INSERT INTO catalog_events (comiket_no, name, provider_circlems_event_id, created_at, updated_at)
      VALUES (108, 'コミックマーケット108', 230, 1, 1);
    INSERT INTO catalog_versions (id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, created_at, published_at)
      VALUES ('${version}', 108, 1, 'published', 'claim', '${"1".repeat(64)}', '${"2".repeat(64)}', 1, 1);
    INSERT INTO catalog_editions VALUES
      ('comiket-108', 'comiket', 108, 1, '{}', 1, 'circlems', 'listed', 1, 1);
  `);
  const circle = db.native.prepare(
    `INSERT INTO catalog_edition_circles VALUES ('comiket-108', ?, ?, 'provider_durable', '${version}', '${version}', 1, 1)`,
  );
  for (const wcID of [10_000_001, 10_000_002, 10_000_003])
    circle.run(String(wcID), wcID);
  const capability = db.native.prepare(
    "INSERT INTO catalog_edition_capabilities VALUES ('comiket-108', ?, ?, 1)",
  );
  for (const [name, state] of Object.entries(capabilities))
    capability.run(name, state);
  return db;
}

let sequence = 0;
function nextID(): string {
  sequence += 1;
  return `01JC${String(sequence).padStart(22, "0")}`;
}

function commit(db: SQLiteD1Database, request: unknown, now = 1_000) {
  return commitCuratedDecision(db.binding, request, operator, {
    now,
    mintID: nextID,
  });
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<ServiceError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return (
      error instanceof ServiceError &&
      error.code === code &&
      error.status === status
    );
  });
  return caught as ServiceError;
}

function attendance(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestID: crypto.randomUUID(),
    subject: { catalogEventKey: "comiket-108", circleKey: "10000003" },
    slot: "attendance",
    operation: "assert",
    decisionType: "attendance_assert",
    payloadSchemaVersion: 1,
    payload: { status: "withdrawn", day: 2 },
    baseRevision: 0,
    reason: {
      code: "operator_observed",
      text: "Cancellation post.",
      evidenceRefs: [],
    },
    ...overrides,
  };
}

function attach(
  handle: string,
  role: "primary" | "secondary",
  circleKey = "10000001",
) {
  return {
    requestID: crypto.randomUUID(),
    subject: { catalogEventKey: "comiket-108", circleKey },
    slot: `x_account:handle:${handle}`,
    operation: "assert",
    decisionType: "x_account_attach",
    payloadSchemaVersion: 1,
    payload: { accountRef: { handle }, role },
    baseRevision: 0,
    reason: {
      code: "operator_observed",
      text: "Linked from the circle site.",
      evidenceRefs: [],
    },
  };
}

test("shared decision-request fixture digests verify", async () => {
  for (const name of [
    "replay.json",
    "payload-conflict.json",
    "stale-base.json",
  ])
    for (const step of caseFixture(name).steps)
      assert.equal(
        await curatedDecisionRequestSHA256(step.request),
        step.requestSHA256,
        name,
      );
});

for (const name of [
  "replay.json",
  "payload-conflict.json",
  "stale-base.json",
]) {
  test(`shared decision-request fixture behaves as specified: ${name}`, async () => {
    const db = ledgerDatabase();
    for (const step of caseFixture(name).steps) {
      const { expect } = step;
      if (expect.error) {
        const error = await rejectsWith(
          commit(db, step.request),
          expect.error,
          expect.status,
        );
        if ("currentRevision" in expect)
          assert.equal(error.details?.currentRevision, expect.currentRevision);
        continue;
      }
      const committed = await commit(db, step.request);
      assert.equal(committed.status, expect.status);
      assert.equal(committed.replayed, expect.replayed ?? false);
      assert.equal(committed.result.slotRevision, expect.slotRevision);
      if ("activeDecision" in expect)
        assert.equal(committed.result.activeDecisionID, expect.activeDecision);
    }
  });
}

test("a replay after the slot moved on still returns the original result", async () => {
  const db = ledgerDatabase();
  const first = attendance();
  const created = await commit(db, first);
  await commit(
    db,
    attendance({
      operation: "reverse",
      payload: {},
      baseRevision: 1,
      reason: {
        code: "other",
        text: "Cancellation was retracted.",
        evidenceRefs: [],
      },
    }),
  );
  const replay = await commit(db, first, 9_999);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.result, created.result);
});

test("one batch records the decision, head, sequence and receipt; a failed batch records nothing", async () => {
  const db = ledgerDatabase();
  const failEveryBatch = () => {
    db.beforeNextBatch = failEveryBatch;
    throw new Error("D1 unavailable");
  };
  db.beforeNextBatch = failEveryBatch;
  const request = attendance();
  await assert.rejects(commit(db, request), /D1 unavailable/);
  db.beforeNextBatch = undefined;
  for (const table of [
    "curated_decisions",
    "curated_decision_heads",
    "curated_edition_ledger_heads",
    "curated_decision_request_receipts",
  ])
    assert.equal(db.rows(`SELECT count(*) AS n FROM ${table}`)[0].n, 0, table);
  const committed = await commit(db, request);
  assert.equal(committed.status, 201);
  assert.deepEqual(
    db.rows(
      "SELECT slot, slot_revision, active_decision_id IS NOT NULL AS active FROM curated_decision_heads",
    ),
    [{ slot: "attendance", slot_revision: 1, active: 1 }],
  );
  assert.deepEqual(
    db.rows(
      "SELECT ledger_seq, published_through_seq FROM curated_edition_ledger_heads",
    ),
    [{ ledger_seq: 1, published_through_seq: 0 }],
  );
});

test("a transient batch failure is retried and commits exactly once", async () => {
  const db = ledgerDatabase();
  db.beforeNextBatch = () => {
    throw new Error("transient");
  };
  const committed = await commit(db, attendance());
  assert.equal(committed.status, 201);
  assert.equal(db.rows("SELECT count(*) AS n FROM curated_decisions")[0].n, 1);
});

test("a concurrent ledger sequence advance retries instead of conflicting", async () => {
  const db = ledgerDatabase();
  await commit(
    db,
    attendance({
      subject: { catalogEventKey: "comiket-108", circleKey: "10000001" },
    }),
  );
  db.beforeNextBatch = () => {
    // Another slot's commit lands between this request's reads and its batch.
    db.native.exec(
      "UPDATE curated_edition_ledger_heads SET ledger_seq = ledger_seq + 1",
    );
  };
  const committed = await commit(db, attendance());
  assert.equal(committed.status, 201);
  assert.equal(committed.result.ledgerSeq, 3);
  assert.equal(committed.result.slotRevision, 1);
});

test("decisions and receipts are append-only", async () => {
  const db = ledgerDatabase();
  await commit(db, attendance());
  for (const statement of [
    "UPDATE curated_decisions SET reason_text = 'edited'",
    "DELETE FROM curated_decisions",
    "UPDATE curated_decision_request_receipts SET response_json = '{}'",
    "DELETE FROM curated_decision_request_receipts",
  ])
    assert.throws(() => db.native.exec(statement), /append-only/, statement);
});

test("validation: unknown circle, unsupported capability, payload, slot, reason, actor", async () => {
  const db = ledgerDatabase({
    attendanceStatus: "supported",
    socialEnrichment: "unsupported",
  });
  await rejectsWith(
    commit(
      db,
      attendance({
        subject: { catalogEventKey: "comiket-108", circleKey: "99" },
      }),
    ),
    "unknown_circle",
    422,
  );
  await rejectsWith(
    commit(
      db,
      attendance({
        subject: { catalogEventKey: "comiket-109", circleKey: "10000003" },
      }),
    ),
    "unknown_circle",
    422,
  );
  await rejectsWith(
    commit(db, attach("fixture_a", "primary")),
    "capability_unsupported",
    422,
  );
  await rejectsWith(
    commit(db, attendance({ payload: { status: "maybe" } })),
    "invalid_decision_payload",
    422,
  );
  await rejectsWith(
    commit(db, attendance({ payload: { status: "withdrawn", note: "x" } })),
    "invalid_decision_payload",
    422,
  );
  await rejectsWith(
    commit(db, attendance({ slot: "attendance_claim:1:x" })),
    "invalid_slot",
    422,
  );
  await rejectsWith(
    commit(
      db,
      attendance({
        reason: { code: "other", text: "short", evidenceRefs: [] },
      }),
    ),
    "invalid_reason",
    422,
  );
  await rejectsWith(
    commit(
      db,
      attendance({
        reason: {
          code: "report_confirmed",
          text: "Reported.",
          evidenceRefs: [],
        },
      }),
    ),
    "invalid_reason",
    422,
  );
  await rejectsWith(
    commit(db, attendance({ requestID: "NOT-A-UUID" })),
    "invalid_decision_request",
    422,
  );
  await rejectsWith(
    commitCuratedDecision(
      db.binding,
      attendance(),
      { kind: "operator", subject: " " },
      { now: 1 },
    ),
    "operator_identity_required",
    403,
  );
  assert.equal(db.rows("SELECT count(*) AS n FROM curated_decisions")[0].n, 0);
});

test("reverse needs an active decision of the same type and a 10-character reason", async () => {
  const db = ledgerDatabase();
  const reverse = (overrides: Record<string, unknown>) =>
    attendance({
      operation: "reverse",
      payload: {},
      reason: {
        code: "operator_observed",
        text: "Withdrawn in error.",
        evidenceRefs: [],
      },
      ...overrides,
    });
  await rejectsWith(commit(db, reverse({})), "nothing_to_reverse", 409);
  await commit(db, attendance());
  await rejectsWith(
    commit(
      db,
      reverse({
        baseRevision: 1,
        reason: { code: "operator_observed", text: "Oops.", evidenceRefs: [] },
      }),
    ),
    "invalid_reason",
    422,
  );
  await rejectsWith(
    commit(db, reverse({ baseRevision: 1, payload: { status: "attending" } })),
    "invalid_decision_payload",
    422,
  );
  const reversed = await commit(db, reverse({ baseRevision: 1 }));
  assert.equal(reversed.result.activeDecisionID, null);
  assert.equal(reversed.result.slotRevision, 2);
});

test("X accounts: slot follows accountRef, one active primary, suppress replaces attach", async () => {
  const db = ledgerDatabase();
  await rejectsWith(
    commit(db, {
      ...attach("fixture_a", "primary"),
      slot: "x_account:handle:other",
    }),
    "invalid_slot",
    422,
  );
  await rejectsWith(
    commit(db, {
      ...attach("fixture_a", "primary"),
      payload: { accountRef: { handle: "Fixture_A" }, role: "primary" },
    }),
    "invalid_decision_payload",
    422,
  );
  await commit(db, attach("fixture_a", "primary"));
  await rejectsWith(
    commit(db, attach("fixture_b", "primary")),
    "primary_account_conflict",
    409,
  );
  await commit(db, attach("fixture_b", "secondary"));
  await commit(db, attach("fixture_a", "primary", "10000002"));
  const suppress = await commit(db, {
    ...attach("fixture_b", "secondary"),
    decisionType: "x_account_suppress",
    payload: { accountRef: { handle: "fixture_b" } },
    baseRevision: 1,
  });
  assert.equal(suppress.result.slotRevision, 2);
  assert.deepEqual(
    (
      await readCuratedDecisionHistory(db.binding, {
        catalogEventKey: "comiket-108",
        circleKey: "10000001",
      })
    ).map((decision) => [
      decision.slot,
      decision.decisionType,
      decision.slotRevision,
      decision.ledgerSeq,
    ]),
    [
      ["x_account:handle:fixture_a", "x_account_attach", 1, 1],
      ["x_account:handle:fixture_b", "x_account_attach", 1, 2],
      ["x_account:handle:fixture_b", "x_account_suppress", 2, 4],
    ],
  );
  assert.deepEqual(
    (await readCuratedLedger(db.binding, "comiket-108", 2, 10)).map(
      (decision) => decision.ledgerSeq,
    ),
    [3, 4],
  );
});

test("minted decision IDs are 26-character Crockford ULIDs ordered by time", () => {
  const early = mintCuratedDecisionID(1_700_000_000_000);
  const late = mintCuratedDecisionID(1_800_000_000_000);
  assert.match(early, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(early.slice(0, 10) < late.slice(0, 10));
});

test("the documented 0012 rollback restores the pre-0012 schema", () => {
  const snapshot = (database: DatabaseSync) =>
    (
      database
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => `${row.type}|${row.name}|${row.sql}`);
  const before = new DatabaseSync(":memory:");
  before.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.slice(0, -1))
    before.exec(readFileSync(migration, "utf8"));
  const after = new DatabaseSync(":memory:");
  after.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations)
    after.exec(readFileSync(migration, "utf8"));
  after.exec(`
    DROP TRIGGER curated_decision_request_receipts_append_only_delete;
    DROP TRIGGER curated_decision_request_receipts_append_only_update;
    DROP TRIGGER curated_decisions_append_only_delete;
    DROP TRIGGER curated_decisions_append_only_update;
    DROP TABLE curated_decision_request_receipts;
    DROP TABLE curated_edition_ledger_heads;
    DROP TABLE curated_decision_heads;
    DROP INDEX curated_decisions_subject;
    DROP TABLE curated_decisions;
  `);
  assert.deepEqual(snapshot(after), snapshot(before));
});
