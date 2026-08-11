import * as Automerge from "@automerge/automerge";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalJSON,
  type PlanDocument,
  validatePlanMutation,
} from "../src/lib/server/plan-document";

interface NamedNeedFixture {
  fixtureVersion: number;
  planID: string;
  comiketNo: number;
  replicaID: string;
  actorID: string;
  userPublicID: string;
  vector: {
    operationID: string;
    operation: {
      type: string;
      actorUserID: string;
      payload: Record<string, unknown>;
    };
    beforeDocument: string;
    beforeHeads: string[];
    change: string;
    changeHash: string;
    afterDocument: string;
    afterHeads: string[];
  };
}

test("the server accepts a literal Swift-authored named purchase request", async () => {
  const fixtureBytes = readFileSync(
    "tests/fixtures/automerge-swift-named-need-v1.json",
  );
  assert.equal(
    createHash("sha256").update(Uint8Array.from(fixtureBytes)).digest("hex"),
    "fd86cb1c540597b0d4608690e161e48cd18735da33803b3054353ca50fffb294",
  );
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as NamedNeedFixture;
  assert.equal(fixture.fixtureVersion, 1);
  const before = loadDocument(fixture.vector.beforeDocument);
  assert.deepEqual(
    Automerge.getHeads(before).slice().sort(),
    fixture.vector.beforeHeads,
  );
  const [candidate] = Automerge.applyChanges(Automerge.clone(before), [
    bytes(fixture.vector.change),
  ]);
  assert.equal(base64(Automerge.save(candidate)), fixture.vector.afterDocument);
  assert.deepEqual(
    Automerge.getHeads(candidate).slice().sort(),
    fixture.vector.afterHeads,
  );

  const validated = await validatePlanMutation(before, candidate, {
    planID: fixture.planID,
    comiketNo: fixture.comiketNo,
    frameActorID: fixture.actorID,
    frameUserPublicID: fixture.userPublicID,
    actors: new Map([
      [
        fixture.actorID,
        {
          actorID: fixture.actorID,
          userID: 1,
          userPublicID: fixture.userPublicID,
          replicaID: fixture.replicaID,
          authVersion: 1,
          membershipEpoch: 1,
        },
      ],
    ]),
    activeMemberPublicIDs: new Set([fixture.userPublicID]),
    membershipEpoch: 1,
  });
  assert.equal(validated.operations.length, 1);
  assert.equal(
    validated.operations[0]?.operationID,
    fixture.vector.operationID,
  );
  assert.equal(
    canonicalJSON(validated.operations[0]?.payload),
    canonicalJSON(fixture.vector.operation.payload),
  );
  const needID = String(fixture.vector.operation.payload.needID);
  const wcID = String(fixture.vector.operation.payload.wcID);
  assert.equal(
    validated.document.circles[wcID]?.needs[needID]?.itemName,
    "新幹線のきっぷ",
  );
  assert.equal(
    validated.document.circles[wcID]?.needs[needID]?.unitPrice,
    14_720,
  );
});

function loadDocument(value: string): Automerge.Doc<PlanDocument> {
  return Automerge.load<PlanDocument>(bytes(value));
}

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
