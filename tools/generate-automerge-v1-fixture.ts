import * as Automerge from "@automerge/automerge";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  applyPlanOperation,
  canonicalJSON,
  detectPlanConflicts,
  maximumNewOperationsPerSyncFrame,
  maximumRetainedOperationPayloadBytes,
  type PlanDocument,
  type PlanOperation,
} from "../src/lib/server/plan-document";
import { planSyncErrorEnvelope } from "../src/lib/server/sync-protocol";

const planID = "11111111-1111-4111-8111-111111111111";
const sessionID = "22222222-2222-4222-8222-222222222222";
const replicaA = "33333333-3333-4333-8333-333333333333";
const replicaB = "44444444-4444-4444-8444-444444444444";
const frameOne = "55555555-5555-4555-8555-555555555555";
const frameTwo = "66666666-6666-4666-8666-666666666666";
const actorA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const actorB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const actorC = "cccccccccccccccccccccccccccccccc";
const userA = "11111111111111111111111111111111";
const userB = "22222222222222222222222222222222";
const userC = "33333333333333333333333333333333";
const circleOperationID = "77777777-7777-4777-8777-777777777777";
const memoOperationA = "88888888-8888-4888-8888-888888888888";
const memoOperationB = "99999999-9999-4999-8999-999999999999";

const bootstrapFixture = JSON.parse(
  readFileSync("tests/fixtures/automerge-bootstrap-v1.json", "utf8"),
) as { document: string; heads: string[] };
const bootstrap = Automerge.load<PlanDocument>(
  Uint8Array.from(Buffer.from(bootstrapFixture.document, "base64url")),
);
const circleDocument = operationChange(
  bootstrap,
  actorA,
  circleOperationID,
  {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userA,
    payload: { v: 1, wcID: 9001, state: "active" },
  },
  1_786_300_001,
);

let clientState = Automerge.initSyncState();
let serverState = Automerge.initSyncState();
let serverDocument = bootstrap;
let clientDocument = circleDocument;
const [clientStateAfterHello, clientHello] = Automerge.generateSyncMessage(
  clientDocument,
  clientState,
);
clientState = clientStateAfterHello;
if (!clientHello) throw new Error("missing client hello sync payload");
[serverDocument, serverState] = Automerge.receiveSyncMessage(
  Automerge.clone(serverDocument),
  serverState,
  clientHello,
);
const [serverStateAfterNeed, serverNeed] = Automerge.generateSyncMessage(
  serverDocument,
  serverState,
);
serverState = serverStateAfterNeed;
if (!serverNeed) throw new Error("missing server need sync payload");
[clientDocument, clientState] = Automerge.receiveSyncMessage(
  Automerge.clone(clientDocument, { actor: actorA }),
  clientState,
  serverNeed,
);
const [clientStateAfterChanges, clientChanges] = Automerge.generateSyncMessage(
  clientDocument,
  clientState,
);
clientState = clientStateAfterChanges;
if (!clientChanges) throw new Error("missing client mutation sync payload");
[serverDocument, serverState] = Automerge.receiveSyncMessage(
  Automerge.clone(serverDocument),
  serverState,
  clientChanges,
);
const [serverStateAfterAck, serverAfterMutation] =
  Automerge.generateSyncMessage(serverDocument, serverState);
serverState = serverStateAfterAck;
if (!serverAfterMutation) throw new Error("missing server response payload");
[clientDocument, clientState] = Automerge.receiveSyncMessage(
  Automerge.clone(clientDocument, { actor: actorA }),
  clientState,
  serverAfterMutation,
);

const acceptedEnvelope = {
  v: 1,
  type: "sync",
  planID,
  sessionID,
  replicaID: replicaA,
  actorID: actorA,
  seq: 2,
  frameID: frameTwo,
  payload: base64(clientChanges),
};
const acceptedHeads = sortedHeads(serverDocument);
const ack = {
  v: 1,
  type: "ack",
  sessionID,
  ackSeq: 2,
  frameID: frameTwo,
  documentHeads: acceptedHeads,
};

const restart = syncUntilSettled(
  Automerge.load<PlanDocument>(Automerge.save(serverDocument)),
  Automerge.load<PlanDocument>(Automerge.save(clientDocument), {
    actor: actorA,
  }),
);

const offlineA = operationChange(
  serverDocument,
  actorA,
  memoOperationA,
  {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "日本語 e\u0301 ",
    },
  },
  1_786_300_002,
);
const offlineB = operationChange(
  serverDocument,
  actorB,
  memoOperationB,
  {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "👩‍👩‍👧‍👦🏳️‍🌈",
    },
  },
  1_786_300_003,
);
const concurrent = syncUntilSettled(offlineA, offlineB);
if (
  concurrent.left.circles["9001"]?.memo !==
  concurrent.right.circles["9001"]?.memo
) {
  throw new Error("offline Text documents did not converge");
}

const operationExamples: Array<{ operationID: string } & PlanOperation> = [
  {
    operationID: circleOperationID,
    type: "shared_plan.circle.presence.v1",
    actorUserID: userA,
    payload: { v: 1, wcID: 9001, state: "active" },
  },
  {
    operationID: memoOperationA,
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "日本語 e\u0301 ",
    },
  },
  {
    operationID: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
    type: "shared_plan.need.create.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      needID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      requesterUserID: userA,
      wantedQuantity: 3,
    },
  },
  {
    operationID: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
    type: "shared_plan.need.wanted_quantity.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      needID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      wantedQuantity: 4,
    },
  },
  {
    operationID: "dddddddd-dddd-4ddd-8ddd-ddddddddddd3",
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      needID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      buyerUserID: userB,
      quantity: 2,
    },
  },
  {
    operationID: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
    type: "shared_plan.need.fulfilled_quantity.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      needID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      fulfilledQuantity: 1,
    },
  },
  {
    operationID: "dddddddd-dddd-4ddd-8ddd-ddddddddddd5",
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      key: "meeting.status",
      value: "連絡済み",
    },
  },
  {
    operationID: "dddddddd-dddd-4ddd-8ddd-ddddddddddd6",
    type: "shared_plan.need.delete.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      needID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    },
  },
];

let operationVectorDocument = bootstrap;
const operationVectors = operationExamples.map(
  ({ operationID, ...operation }, index) => {
    const before = operationVectorDocument;
    const after = operationChange(
      before,
      actorA,
      operationID,
      operation,
      1_786_301_000 + index,
    );
    const changes = Automerge.getChanges(before, after);
    if (changes.length !== 1)
      throw new Error(`operation ${operationID} did not produce one change`);
    operationVectorDocument = after;
    return {
      operationID,
      operation,
      beforeDocument: base64(Automerge.save(before)),
      beforeHeads: sortedHeads(before),
      change: base64(changes[0]!),
      afterDocument: base64(Automerge.save(after)),
      afterHeads: sortedHeads(after),
    };
  },
);

const circleParentLeftID = "abababab-abab-4bab-8bab-ababababab01";
const circleParentRightID = "abababab-abab-4bab-8bab-ababababab02";
const circleParentLeft = operationChange(
  operationChange(
    bootstrap,
    actorA,
    circleParentLeftID,
    {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userA,
      payload: { v: 1, wcID: 9002, state: "active" },
    },
    1_786_301_100,
  ),
  actorA,
  "abababab-abab-4bab-8bab-ababababab03",
  {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userA,
    payload: { v: 1, wcID: 9002, index: 0, deleteCount: 0, text: "LEFT" },
  },
  1_786_301_101,
);
const circleParentRight = operationChange(
  operationChange(
    bootstrap,
    actorB,
    circleParentRightID,
    {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userB,
      payload: { v: 1, wcID: 9002, state: "active" },
    },
    1_786_301_102,
  ),
  actorB,
  "abababab-abab-4bab-8bab-ababababab04",
  {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9002, index: 0, deleteCount: 0, text: "RIGHT" },
  },
  1_786_301_103,
);
const circleParentConflict = Automerge.merge(
  Automerge.clone(circleParentLeft, { actor: actorA }),
  Automerge.clone(circleParentRight, { actor: actorB }),
);
const circleParentResolution = {
  operationID: "abababab-abab-4bab-8bab-ababababab05",
  type: "shared_plan.circle.resolve_parent.v1" as const,
  actorUserID: userA,
  payload: {
    v: 1,
    wcID: 9002,
    selectedParentOperationID: circleParentLeftID,
    state: "active" as const,
    nestedResolutions: [],
  },
};

const needParentID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd01";
const needParentLeftID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd02";
const needParentRightID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd03";
const needParentLeft = operationChange(
  circleDocument,
  actorA,
  needParentLeftID,
  {
    type: "shared_plan.need.create.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      needID: needParentID,
      requesterUserID: userA,
      wantedQuantity: 2,
    },
  },
  1_786_301_110,
);
const needParentRight = operationChange(
  circleDocument,
  actorB,
  needParentRightID,
  {
    type: "shared_plan.need.create.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID: needParentID,
      requesterUserID: userB,
      wantedQuantity: 5,
    },
  },
  1_786_301_111,
);
const needParentConflict = Automerge.merge(
  Automerge.clone(needParentLeft, { actor: actorA }),
  Automerge.clone(needParentRight, { actor: actorB }),
);
const needParentResolution = {
  operationID: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd04",
  type: "shared_plan.need.resolve_parent.v1" as const,
  actorUserID: userA,
  payload: {
    v: 1,
    wcID: 9001,
    needID: needParentID,
    selectedParentOperationID: needParentRightID,
    state: "active" as const,
    nestedResolutions: [],
  },
};

const parentResolutionVectors = await Promise.all([
  resolutionVector(
    "circle",
    circleParentConflict,
    circleParentResolution,
    1_786_301_120,
  ),
  resolutionVector(
    "need",
    needParentConflict,
    needParentResolution,
    1_786_301_121,
  ),
]);

const nestedCircleRootID = "abababab-abab-4bab-8bab-ababababab11";
const nestedCircleXID = "abababab-abab-4bab-8bab-ababababab12";
const nestedCircleYID = "abababab-abab-4bab-8bab-ababababab13";
const nestedCircleOtherRootID = "abababab-abab-4bab-8bab-ababababab14";
const nestedCircleBase = operationChange(
  bootstrap,
  actorA,
  nestedCircleRootID,
  {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userA,
    payload: { v: 1, wcID: 9003, state: "active" },
  },
  1_786_301_130,
);
const nestedCircleX = operationChange(
  nestedCircleBase,
  actorA,
  nestedCircleXID,
  {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9003,
      key: "meeting.place",
      value: "会議室A",
    },
  },
  1_786_301_131,
);
const nestedCircleY = operationChange(
  nestedCircleBase,
  actorB,
  nestedCircleYID,
  {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9003,
      key: "meeting.place",
      value: "会議室B",
    },
  },
  1_786_301_132,
);
const nestedCircleBranch = Automerge.merge(
  Automerge.clone(nestedCircleX, { actor: actorA }),
  Automerge.clone(nestedCircleY, { actor: actorB }),
);
const nestedCircleOther = operationChange(
  bootstrap,
  actorC,
  nestedCircleOtherRootID,
  {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userC,
    payload: { v: 1, wcID: 9003, state: "active" },
  },
  1_786_301_133,
);
const nestedCircleConflict = Automerge.merge(
  Automerge.clone(nestedCircleBranch, { actor: actorA }),
  Automerge.clone(nestedCircleOther, { actor: actorC }),
);
const circleCommunicationConflict = requiredConflictAtPath(
  await detectPlanConflicts(nestedCircleBranch),
  ["circles", "9003", "communicationState", "meeting.place"],
);
const nestedCircleResolution = {
  operationID: "abababab-abab-4bab-8bab-ababababab15",
  type: "shared_plan.circle.resolve_parent.v1" as const,
  actorUserID: userA,
  payload: {
    v: 1,
    wcID: 9003,
    selectedParentOperationID: nestedCircleRootID,
    state: "active" as const,
    nestedResolutions: [
      {
        conflictID: circleCommunicationConflict.conflictID,
        path: circleCommunicationConflict.path,
        selectedChangeHash: changeHashForOperation(
          nestedCircleBranch,
          nestedCircleXID,
        ),
        value: "会議室A",
      },
    ],
  },
};

const nestedNeedID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd11";
const nestedNeedRootID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd12";
const nestedNeedXID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd13";
const nestedNeedYID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd14";
const nestedNeedOtherRootID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd15";
const nestedNeedBase = operationChange(
  circleDocument,
  actorA,
  nestedNeedRootID,
  {
    type: "shared_plan.need.create.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      needID: nestedNeedID,
      requesterUserID: userA,
      wantedQuantity: 2,
    },
  },
  1_786_301_140,
);
const nestedNeedX = operationChange(
  nestedNeedBase,
  actorA,
  nestedNeedXID,
  {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      needID: nestedNeedID,
      buyerUserID: userA,
      quantity: 1,
    },
  },
  1_786_301_141,
);
const nestedNeedY = operationChange(
  nestedNeedBase,
  actorB,
  nestedNeedYID,
  {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID: nestedNeedID,
      buyerUserID: userA,
      quantity: 2,
    },
  },
  1_786_301_142,
);
const nestedNeedBranch = Automerge.merge(
  Automerge.clone(nestedNeedX, { actor: actorA }),
  Automerge.clone(nestedNeedY, { actor: actorB }),
);
const nestedNeedOther = operationChange(
  circleDocument,
  actorC,
  nestedNeedOtherRootID,
  {
    type: "shared_plan.need.create.v1",
    actorUserID: userC,
    payload: {
      v: 1,
      wcID: 9001,
      needID: nestedNeedID,
      requesterUserID: userC,
      wantedQuantity: 4,
    },
  },
  1_786_301_143,
);
const nestedNeedConflict = Automerge.merge(
  Automerge.clone(nestedNeedBranch, { actor: actorA }),
  Automerge.clone(nestedNeedOther, { actor: actorC }),
);
const needAllocationConflict = requiredConflictAtPath(
  await detectPlanConflicts(nestedNeedBranch),
  ["circles", "9001", "needs", nestedNeedID, "buyerAllocations", userA],
);
const nestedNeedResolution = {
  operationID: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd16",
  type: "shared_plan.need.resolve_parent.v1" as const,
  actorUserID: userA,
  payload: {
    v: 1,
    wcID: 9001,
    needID: nestedNeedID,
    selectedParentOperationID: nestedNeedRootID,
    state: "active" as const,
    nestedResolutions: [
      {
        conflictID: needAllocationConflict.conflictID,
        path: needAllocationConflict.path,
        selectedChangeHash: changeHashForOperation(
          nestedNeedBranch,
          nestedNeedXID,
        ),
        value: 1,
      },
    ],
  },
};

const threeRootNeedID = "efefefef-efef-4fef-8fef-efefefefef01";
const threeRootAID = "efefefef-efef-4fef-8fef-efefefefef02";
const threeRootBID = "efefefef-efef-4fef-8fef-efefefefef03";
const threeRootCID = "efefefef-efef-4fef-8fef-efefefefef04";
const threeRootA = operationChange(
  bootstrap,
  actorA,
  threeRootAID,
  {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userA,
    payload: { v: 1, wcID: 9004, state: "active" },
  },
  1_786_301_150,
);
const threeRootB = operationChange(
  operationChange(
    bootstrap,
    actorB,
    threeRootBID,
    {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userB,
      payload: { v: 1, wcID: 9004, state: "active" },
    },
    1_786_301_151,
  ),
  actorB,
  "efefefef-efef-4fef-8fef-efefefefef05",
  {
    type: "shared_plan.need.create.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9004,
      needID: threeRootNeedID,
      requesterUserID: userB,
      wantedQuantity: 1,
    },
  },
  1_786_301_152,
);
const threeRootC = operationChange(
  operationChange(
    bootstrap,
    actorC,
    threeRootCID,
    {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userC,
      payload: { v: 1, wcID: 9004, state: "active" },
    },
    1_786_301_153,
  ),
  actorC,
  "efefefef-efef-4fef-8fef-efefefefef06",
  {
    type: "shared_plan.need.create.v1",
    actorUserID: userC,
    payload: {
      v: 1,
      wcID: 9004,
      needID: threeRootNeedID,
      requesterUserID: userC,
      wantedQuantity: 3,
    },
  },
  1_786_301_154,
);
const threeRootConflict = Automerge.merge(
  Automerge.merge(
    Automerge.clone(threeRootA, { actor: actorA }),
    Automerge.clone(threeRootB, { actor: actorB }),
  ),
  Automerge.clone(threeRootC, { actor: actorC }),
);
const threeRootPath = ["circles", "9004", "needs", threeRootNeedID] as const;
const threeRootBHash = changeHashForOperation(threeRootConflict, threeRootBID);
const threeRootCHash = changeHashForOperation(threeRootConflict, threeRootCID);
const threeRootChangeHashes = [threeRootBHash, threeRootCHash].sort();
const threeRootObjectConflictID = sha256(
  canonicalJSON({
    schemaVersion: 1,
    path: threeRootPath,
    changeHashes: threeRootChangeHashes,
  }),
);
const threeRootResolution = {
  operationID: "efefefef-efef-4fef-8fef-efefefefef07",
  type: "shared_plan.circle.resolve_parent.v1" as const,
  actorUserID: userA,
  payload: {
    v: 1,
    wcID: 9004,
    selectedParentOperationID: threeRootAID,
    state: "active" as const,
    nestedResolutions: [
      {
        conflictID: threeRootObjectConflictID,
        path: [...threeRootPath],
        selectedChangeHash: threeRootBHash,
        value: plainJSON(threeRootB.circles["9004"]!.needs[threeRootNeedID]!),
      },
    ],
  },
};

const selectedPrecedenceRootID = "fafafafa-fafa-4afa-8afa-fafafafafa01";
const selectedPrecedenceValueID = "fafafafa-fafa-4afa-8afa-fafafafafa02";
const selectedPrecedenceOtherRootID =
  "fafafafa-fafa-4afa-8afa-fafafafafa03";
const selectedPrecedenceXID = "fafafafa-fafa-4afa-8afa-fafafafafa04";
const selectedPrecedenceYID = "fafafafa-fafa-4afa-8afa-fafafafafa05";
const selectedPrecedenceRoot = operationChange(
  operationChange(
    bootstrap,
    actorA,
    selectedPrecedenceRootID,
    {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userA,
      payload: { v: 1, wcID: 9005, state: "active" },
    },
    1_786_301_155,
  ),
  actorA,
  selectedPrecedenceValueID,
  {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9005,
      key: "meeting.place",
      value: "選択した親A",
    },
  },
  1_786_301_156,
);
const selectedPrecedenceOtherRoot = operationChange(
  bootstrap,
  actorB,
  selectedPrecedenceOtherRootID,
  {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9005, state: "active" },
  },
  1_786_301_157,
);
const selectedPrecedenceX = operationChange(
  selectedPrecedenceOtherRoot,
  actorB,
  selectedPrecedenceXID,
  {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9005,
      key: "meeting.place",
      value: "競合B1",
    },
  },
  1_786_301_158,
);
const selectedPrecedenceY = operationChange(
  selectedPrecedenceOtherRoot,
  actorC,
  selectedPrecedenceYID,
  {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userC,
    payload: {
      v: 1,
      wcID: 9005,
      key: "meeting.place",
      value: "競合B2",
    },
  },
  1_786_301_159,
);
const selectedPrecedenceOtherConflict = Automerge.merge(
  Automerge.clone(selectedPrecedenceX, { actor: actorB }),
  Automerge.clone(selectedPrecedenceY, { actor: actorC }),
);
const selectedPrecedenceConflict = Automerge.merge(
  Automerge.clone(selectedPrecedenceRoot, { actor: actorA }),
  Automerge.clone(selectedPrecedenceOtherConflict, { actor: actorB }),
);
const selectedPrecedenceNestedConflict = requiredConflictAtPath(
  await detectPlanConflicts(selectedPrecedenceOtherConflict),
  ["circles", "9005", "communicationState", "meeting.place"],
);
const selectedPrecedenceResolution = {
  operationID: "fafafafa-fafa-4afa-8afa-fafafafafa06",
  type: "shared_plan.circle.resolve_parent.v1" as const,
  actorUserID: userA,
  payload: {
    v: 1,
    wcID: 9005,
    selectedParentOperationID: selectedPrecedenceRootID,
    state: "active" as const,
    nestedResolutions: [
      {
        conflictID: selectedPrecedenceNestedConflict.conflictID,
        path: selectedPrecedenceNestedConflict.path,
        selectedChangeHash: changeHashForOperation(
          selectedPrecedenceConflict,
          selectedPrecedenceRootID,
        ),
        value: "選択した親A",
      },
    ],
  },
};

const nestedParentResolutionVectors = await Promise.all([
  resolutionVector(
    "circle",
    nestedCircleConflict,
    nestedCircleResolution,
    1_786_301_160,
  ).then((vector) => ({ ...vector, scenario: "nested-scalar" })),
  resolutionVector(
    "need",
    nestedNeedConflict,
    nestedNeedResolution,
    1_786_301_161,
  ).then((vector) => ({ ...vector, scenario: "nested-scalar" })),
  resolutionVector(
    "circle",
    threeRootConflict,
    threeRootResolution,
    1_786_301_162,
  ).then((vector) => ({ ...vector, scenario: "three-root-object" })),
  resolutionVector(
    "circle",
    selectedPrecedenceConflict,
    selectedPrecedenceResolution,
    1_786_301_163,
  ).then((vector) => ({ ...vector, scenario: "selected-parent-precedence" })),
]);

const semanticNeedID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const semanticBase = operationChange(
  circleDocument,
  actorA,
  "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
  {
    type: "shared_plan.need.create.v1",
    actorUserID: userA,
    payload: {
      v: 1,
      wcID: 9001,
      needID: semanticNeedID,
      requesterUserID: userA,
      wantedQuantity: 3,
    },
  },
  1_786_302_000,
);
const circleDescendantOperations: PlanOperation[] = [
  {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "まだ必要 👩‍👩‍👧‍👦",
    },
  },
  {
    type: "shared_plan.need.create.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef",
      requesterUserID: userB,
      wantedQuantity: 2,
    },
  },
  {
    type: "shared_plan.need.delete.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, needID: semanticNeedID },
  },
  {
    type: "shared_plan.need.wanted_quantity.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID: semanticNeedID,
      wantedQuantity: 4,
    },
  },
  {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID: semanticNeedID,
      buyerUserID: userB,
      quantity: 2,
    },
  },
  {
    type: "shared_plan.need.fulfilled_quantity.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID: semanticNeedID,
      fulfilledQuantity: 1,
    },
  },
  {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      key: "meeting.status",
      value: "連絡済み",
    },
  },
];
const circleDeletionConflictVectors = await Promise.all(
  circleDescendantOperations.map(async (operation, index) => {
    const removal = operationChange(
      semanticBase,
      actorA,
      fixtureUUID("c", index + 1),
      {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userA,
        payload: { v: 1, wcID: 9001, state: "removed" },
      },
      1_786_302_100 + index,
    );
    const descendant = operationChange(
      semanticBase,
      actorB,
      fixtureUUID("d", index + 1),
      operation,
      1_786_302_200 + index,
    );
    const merged = Automerge.merge(
      Automerge.clone(removal, { actor: actorA }),
      Automerge.clone(descendant, { actor: actorB }),
    );
    return conflictVector(
      "circle-removal",
      operation.type,
      semanticBase,
      removal,
      descendant,
      merged,
      await detectPlanConflicts(merged),
    );
  }),
);
const needDescendantOperations = circleDescendantOperations.filter(
  (operation) =>
    operation.type === "shared_plan.need.wanted_quantity.v1" ||
    operation.type === "shared_plan.need.buyer_allocation.v1" ||
    operation.type === "shared_plan.need.fulfilled_quantity.v1",
);
const needDeletionConflictVectors = await Promise.all(
  needDescendantOperations.map(async (operation, index) => {
    const removal = operationChange(
      semanticBase,
      actorA,
      fixtureUUID("e", index + 1),
      {
        type: "shared_plan.need.delete.v1",
        actorUserID: userA,
        payload: { v: 1, wcID: 9001, needID: semanticNeedID },
      },
      1_786_302_300 + index,
    );
    const descendant = operationChange(
      semanticBase,
      actorB,
      fixtureUUID("f", index + 1),
      operation,
      1_786_302_400 + index,
    );
    const merged = Automerge.merge(
      Automerge.clone(removal, { actor: actorA }),
      Automerge.clone(descendant, { actor: actorB }),
    );
    return conflictVector(
      "need-deletion",
      operation.type,
      semanticBase,
      removal,
      descendant,
      merged,
      await detectPlanConflicts(merged),
    );
  }),
);

const backlogLimitVectors = {
  baseDocument: base64(Automerge.save(serverDocument)),
  vectors: [
    backlogSyncVector(serverDocument, maximumNewOperationsPerSyncFrame),
    backlogSyncVector(serverDocument, maximumNewOperationsPerSyncFrame + 1),
  ],
};

const fixture = {
  fixtureVersion: 1,
  producer: {
    package: "@automerge/automerge",
    version: "3.2.6",
    runtime: "JavaScript",
  },
  swiftInterop: {
    targetPackage: "automerge-swift",
    targetVersion: "0.7.2",
    status: "pending-swift-authored-vectors",
    requiredBeforeMutationEnablement: true,
  },
  limits: {
    retainedOperationPayloadUTF8Bytes: maximumRetainedOperationPayloadBytes,
    retainedOperationPayloadCanonicalForm:
      "sum(utf8(canonical-json(operation.payload)))",
    compactionError: "plan_compaction_required",
    maximumOperations: 10_000,
    maximumNewOperationsPerSyncFrame,
    backlogError: "plan_sync_backlog_limit",
  },
  schemaVersion: 1,
  planID,
  comiketNo: 108,
  actors: [
    { actorID: actorA, replicaID: replicaA, userPublicID: userA },
    { actorID: actorB, replicaID: replicaB, userPublicID: userB },
    {
      actorID: actorC,
      replicaID: "45454545-4545-4545-8545-454545454545",
      userPublicID: userC,
    },
  ],
  operationExamples,
  operationVectors,
  parentResolutionVectors,
  nestedParentResolutionVectors,
  semanticConflictVectors: [
    ...circleDeletionConflictVectors,
    ...needDeletionConflictVectors,
  ],
  backlogLimitVectors,
  bootstrap: {
    document: bootstrapFixture.document,
    heads: bootstrapFixture.heads,
  },
  initialSession: {
    hello: {
      v: 1,
      type: "hello",
      planID,
      sessionID,
      nextClientSeq: 1,
      nextServerSeq: 1,
      mutationsEnabled: false,
    },
    clientNegotiationEnvelope: {
      v: 1,
      type: "sync",
      planID,
      sessionID,
      replicaID: replicaA,
      actorID: actorA,
      seq: 1,
      frameID: frameOne,
      payload: base64(clientHello),
    },
    serverNeedEnvelope: {
      v: 1,
      type: "sync",
      planID,
      sessionID,
      seq: 1,
      frameID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      payload: base64(serverNeed),
    },
    acceptedEnvelope,
    serverResponseEnvelope: {
      v: 1,
      type: "sync",
      planID,
      sessionID,
      seq: 2,
      frameID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      payload: base64(serverAfterMutation),
    },
    ack,
    acceptedDocument: base64(Automerge.save(serverDocument)),
    acceptedHeads,
  },
  transportReceipts: {
    exactDuplicateEnvelope: acceptedEnvelope,
    receiptViolationEnvelope: {
      ...acceptedEnvelope,
      payload: base64(clientHello),
    },
    sequenceGapEnvelope: {
      ...acceptedEnvelope,
      seq: 4,
      frameID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  },
  restart: {
    serverDocument: base64(Automerge.save(serverDocument)),
    clientDocument: base64(Automerge.save(clientDocument)),
    clientToServerPayloads: restart.leftToRight.map(base64),
    serverToClientPayloads: restart.rightToLeft.map(base64),
    convergedHeads: sortedHeads(restart.left),
  },
  offlineConcurrentText: {
    baseDocument: base64(Automerge.save(serverDocument)),
    clientADocument: base64(Automerge.save(offlineA)),
    clientBDocument: base64(Automerge.save(offlineB)),
    clientAToBPayloads: concurrent.leftToRight.map(base64),
    clientBToAPayloads: concurrent.rightToLeft.map(base64),
    convergedDocument: base64(Automerge.save(concurrent.left)),
    convergedHeads: sortedHeads(concurrent.left),
    convergedMemo: concurrent.left.circles["9001"]!.memo,
    operationIDs: [memoOperationA, memoOperationB],
  },
};

const output = `${JSON.stringify(fixture, null, 2)}\n`;
if (process.argv.includes("--write")) {
  writeFileSync("tests/fixtures/automerge-sync-v1.json", output);
} else {
  process.stdout.write(output);
}

function operationChange(
  document: Automerge.Doc<PlanDocument>,
  actor: string,
  operationID: string,
  operation: PlanOperation,
  time: number,
): Automerge.Doc<PlanDocument> {
  return Automerge.change(
    Automerge.clone(document, { actor }),
    { message: `operation:${operationID}`, time },
    (draft) => applyPlanOperation(draft, operationID, operation),
  );
}

function syncUntilSettled(
  initialLeft: Automerge.Doc<PlanDocument>,
  initialRight: Automerge.Doc<PlanDocument>,
): {
  left: Automerge.Doc<PlanDocument>;
  right: Automerge.Doc<PlanDocument>;
  leftToRight: Uint8Array[];
  rightToLeft: Uint8Array[];
} {
  let left = initialLeft;
  let right = initialRight;
  let leftState = Automerge.initSyncState();
  let rightState = Automerge.initSyncState();
  const leftToRight: Uint8Array[] = [];
  const rightToLeft: Uint8Array[] = [];
  for (let round = 0; round < 20; round += 1) {
    let sent = false;
    const [nextLeftState, leftMessage] = Automerge.generateSyncMessage(
      left,
      leftState,
    );
    leftState = nextLeftState;
    if (leftMessage) {
      sent = true;
      leftToRight.push(leftMessage);
      [right, rightState] = Automerge.receiveSyncMessage(
        Automerge.clone(right),
        rightState,
        leftMessage,
      );
    }
    const [nextRightState, rightMessage] = Automerge.generateSyncMessage(
      right,
      rightState,
    );
    rightState = nextRightState;
    if (rightMessage) {
      sent = true;
      rightToLeft.push(rightMessage);
      [left, leftState] = Automerge.receiveSyncMessage(
        Automerge.clone(left),
        leftState,
        rightMessage,
      );
    }
    if (!sent) break;
  }
  if (sortedHeads(left).join(",") !== sortedHeads(right).join(","))
    throw new Error("sync did not settle");
  return { left, right, leftToRight, rightToLeft };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sortedHeads(document: Automerge.Doc<unknown>): string[] {
  return Automerge.getHeads(document).slice().sort();
}

function backlogSyncVector(
  base: Automerge.Doc<PlanDocument>,
  changeCount: number,
) {
  let client = Automerge.clone(base, { actor: actorA });
  const wcID = Number(Object.keys(client.circles)[0]);
  if (!Number.isSafeInteger(wcID)) throw new Error("missing backlog circle");
  for (let index = 0; index < changeCount; index += 1) {
    const operationID = `70000000-0000-4000-8000-${(index + 1)
      .toString(16)
      .padStart(12, "0")}`;
    client = operationChange(
      client,
      actorA,
      operationID,
      {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: userA,
        payload: {
          v: 1,
          wcID,
          key: "offline.limit",
          value: index % 2 === 0 ? "東" : "西",
        },
      },
      1_786_302_000 + index,
    );
  }
  let server = Automerge.clone(base);
  let clientState = Automerge.initSyncState();
  let serverState = Automerge.initSyncState();
  let clientHave: Uint8Array | null;
  [clientState, clientHave] = Automerge.generateSyncMessage(
    client,
    clientState,
  );
  if (!clientHave) throw new Error("missing backlog have payload");
  [server, serverState] = Automerge.receiveSyncMessage(
    server,
    serverState,
    clientHave,
  );
  let serverNeed: Uint8Array | null;
  [serverState, serverNeed] = Automerge.generateSyncMessage(
    server,
    serverState,
  );
  if (!serverNeed) throw new Error("missing backlog need payload");
  [client, clientState] = Automerge.receiveSyncMessage(
    client,
    clientState,
    serverNeed,
  );
  let clientChanges: Uint8Array | null;
  [clientState, clientChanges] = Automerge.generateSyncMessage(
    client,
    clientState,
  );
  if (!clientChanges) throw new Error("missing backlog changes payload");
  const before = server;
  [server] = Automerge.receiveSyncMessage(server, serverState, clientChanges);
  if (Automerge.getChanges(before, server).length !== changeCount)
    throw new Error("backlog payload change-count mismatch");
  return {
    changeCount,
    clientDocument: base64(Automerge.save(client)),
    clientHavePayload: base64(clientHave),
    serverNeedPayload: base64(serverNeed),
    clientChangesPayload: base64(clientChanges),
    clientChangesPayloadBytes: clientChanges.byteLength,
    expected:
      changeCount <= maximumNewOperationsPerSyncFrame
        ? { status: "accepted" as const }
        : {
            status: "rejected" as const,
            closeCode: 4422,
            error: planSyncErrorEnvelope("plan_sync_backlog_limit", {
              maximumNewOperationsPerSyncFrame,
              receivedChanges: changeCount,
            }),
          },
  };
}

function changeHashForOperation(
  document: Automerge.Doc<PlanDocument>,
  operationID: string,
): string {
  const operation = document.operations[operationID];
  const objectID = operation ? Automerge.getObjectId(operation) : null;
  if (!objectID) throw new Error(`missing operation ${operationID}`);
  for (const bytes of Automerge.getAllChanges(document)) {
    const change = Automerge.decodeChange(bytes);
    for (let offset = 0; offset < change.ops.length; offset += 1)
      if (`${change.startOp + offset}@${change.actor}` === objectID)
        return change.hash;
  }
  throw new Error(`missing change for operation ${operationID}`);
}

function requiredConflictAtPath(
  conflicts: Awaited<ReturnType<typeof detectPlanConflicts>>,
  path: string[],
) {
  const conflict = conflicts.find(
    (candidate) => canonicalJSON(candidate.path) === canonicalJSON(path),
  );
  if (!conflict) throw new Error(`missing conflict at ${path.join("/")}`);
  return conflict;
}

function plainJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureUUID(prefix: string, index: number): string {
  return `${prefix.repeat(8)}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${index.toString(16).padStart(12, "0")}`;
}

function conflictVector(
  kind: string,
  descendantOperationType: string,
  base: Automerge.Doc<PlanDocument>,
  removal: Automerge.Doc<PlanDocument>,
  descendant: Automerge.Doc<PlanDocument>,
  merged: Automerge.Doc<PlanDocument>,
  conflicts: Awaited<ReturnType<typeof detectPlanConflicts>>,
) {
  return {
    kind,
    descendantOperationType,
    baseDocument: base64(Automerge.save(base)),
    removalChange: base64(Automerge.getChanges(base, removal)[0]!),
    descendantChange: base64(Automerge.getChanges(base, descendant)[0]!),
    mergedDocument: base64(Automerge.save(merged)),
    mergedHeads: sortedHeads(merged),
    conflicts,
  };
}

async function resolutionVector(
  kind: "circle" | "need",
  before: Automerge.Doc<PlanDocument>,
  operation: { operationID: string } & PlanOperation,
  time: number,
) {
  const { operationID, ...planOperation } = operation;
  const after = operationChange(
    before,
    actorA,
    operationID,
    planOperation,
    time,
  );
  const changes = Automerge.getChanges(before, after);
  if (changes.length !== 1)
    throw new Error(`${kind} parent resolution did not produce one change`);
  return {
    kind,
    operationID,
    operation: planOperation,
    beforeDocument: base64(Automerge.save(before)),
    beforeHeads: sortedHeads(before),
    beforeConflicts: await detectPlanConflicts(before),
    change: base64(changes[0]!),
    afterDocument: base64(Automerge.save(after)),
    afterHeads: sortedHeads(after),
    afterConflicts: await detectPlanConflicts(after),
  };
}
