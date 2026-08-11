import * as Automerge from "@automerge/automerge";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyPlanOperation,
  canonicalJSON,
  maximumRetainedOperationPayloadBytes,
  operationEventPayload,
  type PlanDocument,
  validatePlanMutation,
} from "../src/lib/server/plan-document";

const planID = "11111111-1111-4111-8111-111111111111";
const actorID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const userID = "0123456789abcdef0123456789abcdef";
const replicaID = "33333333-3333-4333-8333-333333333333";

test("retained memo payloads use a linear 512 KiB compaction boundary without duplicating text into events", async (t) => {
  const current = Automerge.change(loadBootstrap(), (draft) =>
    applyPlanOperation(draft, operationUUID(1), {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userID,
      payload: { v: 1, wcID: 9001, state: "active" },
    }),
  );
  const maximumText = "あ".repeat(Math.floor((64 * 1024) / 3));
  assert.ok(new TextEncoder().encode(maximumText).byteLength <= 64 * 1024);
  let acceptedCandidate = Automerge.clone(current, { actor: actorID });
  for (let index = 0; index < 7; index += 1) {
    const operationID = operationUUID(60_000 + index);
    const memoLength = Array.from(
      acceptedCandidate.circles["9001"]!.memo,
    ).length;
    acceptedCandidate = Automerge.change(
      acceptedCandidate,
      { message: `operation:${operationID}` },
      (draft) =>
        applyPlanOperation(draft, operationID, {
          type: "shared_plan.circle.memo.splice.v1",
          actorUserID: userID,
          payload: {
            v: 1,
            wcID: 9001,
            index: 0,
            deleteCount: memoLength,
            text:
              index % 2 === 0 ? maximumText : `${maximumText.slice(0, -1)}い`,
          },
        }),
    );
  }
  const started = performance.now();
  const accepted = await validatePlanMutation(
    current,
    acceptedCandidate,
    context(),
  );
  const elapsed = performance.now() - started;
  t.diagnostic(`seven max-memo payloads: ${elapsed.toFixed(1)}ms`);
  assert.equal(accepted.operations.length, 7);
  const retainedBytes = Object.values(accepted.document.operations).reduce(
    (bytes, operation) =>
      bytes +
      new TextEncoder().encode(canonicalJSON(operation.payload)).byteLength,
    0,
  );
  assert.ok(retainedBytes <= maximumRetainedOperationPayloadBytes);
  const eventBytes = accepted.operations.reduce(
    (bytes, operation) =>
      bytes +
      new TextEncoder().encode(
        canonicalJSON(operationEventPayload(planID, operation)),
      ).byteLength,
    0,
  );
  assert.ok(eventBytes < 8 * 1024, `event previews used ${eventBytes} bytes`);

  const eighthMemoLength = Array.from(
    acceptedCandidate.circles["9001"]!.memo,
  ).length;
  const overBudgetOperationID = operationUUID(60_007);
  const overBudget = Automerge.change(
    acceptedCandidate,
    { message: `operation:${overBudgetOperationID}` },
    (draft) =>
      applyPlanOperation(draft, overBudgetOperationID, {
        type: "shared_plan.circle.memo.splice.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          index: 0,
          deleteCount: eighthMemoLength,
          text: maximumText,
        },
      }),
  );
  await assert.rejects(
    validatePlanMutation(current, overBudget, context()),
    (error: unknown) => hasCode(error, "plan_compaction_required"),
  );
});

function loadBootstrap(): Automerge.Doc<PlanDocument> {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/automerge-bootstrap-v1.json", "utf8"),
  ) as { document: string };
  return Automerge.clone(
    Automerge.load<PlanDocument>(
      Uint8Array.from(Buffer.from(fixture.document, "base64url")),
    ),
    { actor: actorID },
  );
}

function context() {
  return {
    planID,
    comiketNo: 108,
    frameActorID: actorID,
    frameUserPublicID: userID,
    actors: new Map([
      [
        actorID,
        {
          actorID,
          userID: 1,
          userPublicID: userID,
          replicaID,
          authVersion: 1,
          membershipEpoch: 1,
        },
      ],
    ]),
    activeMemberPublicIDs: new Set([userID]),
    membershipEpoch: 1,
  };
}

function operationUUID(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
