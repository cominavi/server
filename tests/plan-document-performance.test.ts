import * as Automerge from "@automerge/automerge";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyPlanOperation,
  type PlanDocument,
  validatePlanMutation,
} from "../src/lib/server/plan-document";

const planID = "11111111-1111-4111-8111-111111111111";
const actorID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const userID = "0123456789abcdef0123456789abcdef";
const replicaID = "33333333-3333-4333-8333-333333333333";

test("an adversarial alternating history remains bounded at the 10,000-operation ceiling", async (t) => {
  let current = Automerge.change(loadBootstrap(), (draft) =>
    applyPlanOperation(draft, operationUUID(1), {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userID,
      payload: { v: 1, wcID: 9001, state: "active" },
    }),
  );
  let operationIndex = 20_000;
  for (let cycle = 0; cycle < 3_332; cycle += 1) {
    current = Automerge.change(current, (draft) =>
      applyPlanOperation(draft, operationUUID(operationIndex++), {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, state: "removed" },
      }),
    );
    current = Automerge.change(current, (draft) =>
      applyPlanOperation(draft, operationUUID(operationIndex++), {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, state: "active" },
      }),
    );
    current = Automerge.change(current, (draft) =>
      applyPlanOperation(draft, operationUUID(operationIndex++), {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "meeting.place",
          value: cycle % 2 === 0 ? "東" : "西",
        },
      }),
    );
  }
  for (const value of ["中央", "北"] as const) {
    current = Automerge.change(current, (draft) =>
      applyPlanOperation(draft, operationUUID(operationIndex++), {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, key: "meeting.place", value },
      }),
    );
  }
  const candidateOperationID = operationUUID(operationIndex);
  const candidate = Automerge.change(
    current,
    { message: `operation:${candidateOperationID}` },
    (draft) =>
      applyPlanOperation(draft, candidateOperationID, {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "meeting.place",
          value: "南",
        },
      }),
  );
  const started = performance.now();
  const accepted = await validatePlanMutation(current, candidate, context());
  const elapsed = performance.now() - started;
  t.diagnostic(
    `10,000-operation alternating validation: ${elapsed.toFixed(1)}ms`,
  );
  assert.equal(Object.keys(accepted.document.operations).length, 10_000);
  assert.equal(accepted.conflicts.length, 0);
  const maximumElapsed = process.env.CI ? 15_000 : 5_000;
  assert.ok(
    elapsed < maximumElapsed,
    `10,000-operation validation took ${elapsed}ms (limit ${maximumElapsed}ms)`,
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
