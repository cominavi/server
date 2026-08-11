import * as Automerge from "@automerge/automerge";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalJSON,
  detectPlanConflicts,
  type PlanDocument,
  type PlanOperation,
  validatePlanMutation,
} from "../src/lib/server/plan-document";

const fixturePath = "tests/fixtures/automerge-swift-scalar-conflicts-v1.json";
const metaFixturePath =
  "../meta/fixtures/shared-plans/automerge-swift-scalar-conflicts-v1.json";
const iosFixturePath =
  "../ios/ComiNaviTests/Fixtures/automerge-swift-scalar-conflicts-v1.json";
const sourceFixturePath = "tests/fixtures/automerge-sync-v1.json";
const fixtureSHA256 =
  "01371acb866aa39e020b1964b6730d918a3f4a83d186a87e7c9ea530110bcbf8";
const primaryUserPublicID = "11111111111111111111111111111111";

test("all literal Swift scalar-conflict resolutions pass strict JS topology validation", async () => {
  const fixtureBytes = readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(fixtureBytes) as SwiftScalarConflictFixture;
  assert.equal(digest(fixtureBytes), fixtureSHA256);
  assert.equal(readFileSync(metaFixturePath, "utf8"), fixtureBytes);
  assert.equal(readFileSync(iosFixturePath, "utf8"), fixtureBytes);
  assert.equal(
    fixture.sourceFixtureSHA256,
    digest(readFileSync(sourceFixturePath, "utf8")),
  );
  assert.deepEqual(fixture.producer, {
    package: "automerge-swift",
    version: "0.7.2",
  });
  assert.equal(fixture.vectors.length, 15);
  assert.deepEqual(
    fixture.vectors.map(({ field, choice }) => `${field}:${choice}`).sort(),
    [
      "buyerAllocation:losingCandidate",
      "buyerAllocation:newValue",
      "buyerAllocation:visibleWinner",
      "communication:losingCandidate",
      "communication:newValue",
      "communication:visibleWinner",
      "fulfilledQuantity:losingCandidate",
      "fulfilledQuantity:newValue",
      "fulfilledQuantity:visibleWinner",
      "presence:losingCandidate",
      "presence:sameState",
      "presence:visibleWinner",
      "wantedQuantity:losingCandidate",
      "wantedQuantity:newValue",
      "wantedQuantity:visibleWinner",
    ],
  );

  for (const vector of fixture.vectors) {
    const context = `${vector.field}:${vector.choice}`;
    const before = loadDocument(vector.beforeDocument);
    assert.equal(
      base64(Automerge.save(before)),
      vector.beforeDocument,
      context,
    );
    assert.deepEqual(sortedHeads(before), vector.beforeHeads, context);
    assert.equal(
      scalarValue(before, vector),
      vector.visibleValueBefore,
      context,
    );

    const beforeConflicts = await detectPlanConflicts(before);
    const expectedConflict = beforeConflicts.find(
      ({ conflictID }) => conflictID === vector.conflict.conflictID,
    );
    assert.deepEqual(
      expectedConflict,
      {
        conflictID: vector.conflict.conflictID,
        path: vector.conflict.path,
        changeHashes: vector.conflict.sourceChangeHashes,
      },
      context,
    );
    assert.deepEqual(
      vector.conflict.candidates.map(({ changeHash }) => changeHash).sort(),
      vector.conflict.sourceChangeHashes,
      context,
    );
    for (const competing of vector.competingChanges) {
      assert.equal(
        Automerge.decodeChange(bytes(competing.bytes)).hash,
        competing.hash,
        context,
      );
    }

    const changeBytes = bytes(vector.change);
    const decoded = Automerge.decodeChange(changeBytes);
    assert.equal(decoded.actor, vector.changeActorID, context);
    assert.equal(decoded.hash, vector.changeHash, context);
    assert.equal(decoded.message, vector.changeMessage, context);
    assert.equal(decoded.message, `operation:${vector.operationID}`, context);
    assert.equal(decoded.time, vector.changeTimestampUnixSeconds, context);

    const [after] = Automerge.applyChanges(Automerge.clone(before), [
      changeBytes,
    ]);
    assert.deepEqual(
      Automerge.getChanges(before, after).map(
        (change) => Automerge.decodeChange(change).hash,
      ),
      [vector.changeHash],
      context,
    );
    assert.equal(base64(Automerge.save(after)), vector.afterDocument, context);
    assert.deepEqual(sortedHeads(after), vector.afterHeads, context);
    assert.equal(scalarValue(after, vector), vector.selectedValue, context);

    const validated = await validatePlanMutation(
      before,
      after,
      validationContext(fixture, vector.changeActorID),
    );
    assert.equal(validated.operations.length, 1, context);
    assert.equal(validated.operations[0]!.operationID, vector.operationID);
    assert.equal(validated.operations[0]!.actorID, vector.changeActorID);
    assert.equal(validated.operations[0]!.changeHash, vector.changeHash);
    assert.equal(
      canonicalJSON({
        type: validated.operations[0]!.operationType,
        actorUserID: validated.operations[0]!.actorUserID,
        payload: validated.operations[0]!.payload,
      }),
      canonicalJSON(vector.operation),
      context,
    );
    assert.equal(
      (await detectPlanConflicts(after)).some(
        ({ conflictID }) => conflictID === vector.conflict.conflictID,
      ),
      false,
      context,
    );
  }
});

function validationContext(
  fixture: SwiftScalarConflictFixture,
  actorID: string,
) {
  return {
    planID: fixture.planID,
    comiketNo: fixture.comiketNo,
    frameActorID: actorID,
    frameUserPublicID: primaryUserPublicID,
    actors: new Map([
      [
        actorID,
        {
          actorID,
          userID: 1,
          userPublicID: primaryUserPublicID,
          replicaID: "81818181-8181-4181-8181-818181818181",
          authVersion: 1,
          membershipEpoch: 1,
        },
      ],
    ]),
    activeMemberPublicIDs: new Set([
      primaryUserPublicID,
      fixture.buyerUserID,
      "33333333333333333333333333333333",
    ]),
    membershipEpoch: 1,
  };
}

function scalarValue(
  document: Automerge.Doc<PlanDocument>,
  vector: SwiftScalarConflictVector,
): unknown {
  const path =
    vector.field === "presence"
      ? [...vector.conflict.path, "state"]
      : vector.conflict.path;
  let value: unknown = document;
  for (const component of path) {
    assert.ok(typeof value === "object" && value !== null);
    value = (value as Record<string, unknown>)[String(component)];
  }
  return value instanceof Automerge.ImmutableString ? value.val : value;
}

function loadDocument(value: string): Automerge.Doc<PlanDocument> {
  return Automerge.load<PlanDocument>(bytes(value));
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function sortedHeads(document: Automerge.Doc<unknown>): string[] {
  return Automerge.getHeads(document).slice().sort();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface SwiftScalarConflictFixture {
  fixtureVersion: 1;
  producer: { package: string; version: string };
  sourceFixtureSHA256: string;
  planID: string;
  comiketNo: number;
  circleWCID: number;
  needID: string;
  buyerUserID: string;
  communicationKey: string;
  vectors: SwiftScalarConflictVector[];
}

interface SwiftScalarConflictVector {
  field:
    | "buyerAllocation"
    | "communication"
    | "fulfilledQuantity"
    | "presence"
    | "wantedQuantity";
  choice: "losingCandidate" | "newValue" | "sameState" | "visibleWinner";
  beforeDocument: string;
  beforeHeads: string[];
  change: string;
  changeActorID: string;
  changeHash: string;
  changeMessage: string;
  changeTimestampUnixSeconds: number;
  afterDocument: string;
  afterHeads: string[];
  operationID: string;
  operation: PlanOperation;
  visibleValueBefore: unknown;
  selectedValue: unknown;
  competingChanges: Array<{ bytes: string; hash: string }>;
  conflict: {
    candidates: Array<{ changeHash: string }>;
    conflictID: string;
    kind: "scalar";
    parentRootOperationIDs: string[];
    path: Array<string | number>;
    sourceChangeHashes: string[];
  };
}
