import * as Automerge from "@automerge/automerge";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyPlanOperation,
  canonicalJSON,
  detectPlanConflicts,
  type PlanDocument,
  type PlanOperation,
  validatePlanMutation,
} from "../src/lib/server/plan-document";
import { sha256Hex } from "../src/lib/server/auth-sessions";

const planID = "11111111-1111-4111-8111-111111111111";
const userID = "0123456789abcdef0123456789abcdef";
const replicaID = "22222222-2222-4222-8222-222222222222";
const actorID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const actorB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const userB = "22222222222222222222222222222222";
const actorC = "cccccccccccccccccccccccccccccccc";
const userC = "33333333333333333333333333333333";
const circleOperationID = "33333333-3333-4333-8333-333333333333";
const memoOperationID = "44444444-4444-4444-8444-444444444444";

test("one typed operation reconstructs one exact Automerge change", async () => {
  const bootstrap = loadBootstrap();
  const circle = change(bootstrap, circleOperationID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const acceptedCircle = await validatePlanMutation(
    bootstrap,
    circle,
    context(),
  );
  assert.equal(acceptedCircle.operations.length, 1);
  assert.equal(acceptedCircle.operations[0]?.operationID, circleOperationID);
  assert.equal(acceptedCircle.operations[0]?.actorID, actorID);
  assert.equal(acceptedCircle.document.circles["9001"]?.memo, "");

  const memo = change(acceptedCircle.document, memoOperationID, {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "日本語 e\u0301 👩‍👩‍👧‍👦",
    },
  });
  const acceptedMemo = await validatePlanMutation(
    acceptedCircle.document,
    memo,
    context(),
  );
  assert.equal(
    acceptedMemo.document.circles["9001"]?.memo,
    "日本語 e\u0301 👩‍👩‍👧‍👦",
  );
  assert.equal(acceptedMemo.operations.length, 1);
});

test("semantic change messages bind one lowercase operation ID to one change", async () => {
  const bootstrap = loadBootstrap();
  for (const historicalChange of Automerge.getAllChanges(bootstrap))
    assert.doesNotMatch(
      Automerge.decodeChange(historicalChange).message ?? "",
      /^operation:/,
      "initialization remains nonsemantic",
    );

  const operation: PlanOperation = {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "active" },
  };
  await validatePlanMutation(
    bootstrap,
    change(bootstrap, circleOperationID, operation),
    context(),
  );

  for (const [name, message] of [
    ["missing", undefined],
    ["human prose", "Set circle presence"],
    ["uppercase prefix", `Operation:${circleOperationID}`],
    ["uppercase UUID", "operation:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
    ["mismatched UUID", `operation:${memoOperationID}`],
  ] as const) {
    const candidate = changeWithMessage(
      bootstrap,
      circleOperationID,
      operation,
      message,
    );
    await assert.rejects(
      validatePlanMutation(bootstrap, candidate, context()),
      (error: unknown) => hasCode(error, "invalid_plan_operation"),
      name,
    );
  }

  const extraOperationID = operationUUID(9_001);
  const extraMapping = Automerge.change(
    fresh(bootstrap),
    { message: `operation:${circleOperationID}` },
    (draft) => {
      applyPlanOperation(draft, circleOperationID, operation);
      draft.operations[extraOperationID] = {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "meeting.place",
          value: "東",
        },
      };
    },
  );
  await assert.rejects(
    validatePlanMutation(bootstrap, extraMapping, context()),
    (error: unknown) => hasCode(error, "invalid_plan_operation"),
  );

  const first = change(bootstrap, circleOperationID, operation);
  const duplicateMessage = changeWithMessage(
    first,
    memoOperationID,
    {
      type: "shared_plan.circle.memo.splice.v1",
      actorUserID: userID,
      payload: {
        v: 1,
        wcID: 9001,
        index: 0,
        deleteCount: 0,
        text: "重複",
      },
    },
    `operation:${circleOperationID}`,
  );
  await assert.rejects(
    validatePlanMutation(bootstrap, duplicateMessage, context()),
    (error: unknown) => hasCode(error, "invalid_plan_operation"),
  );
});

test("memo splice uses Unicode-scalar nonzero indexes and rejects repeated-character wrong positions", async () => {
  const circle = await documentWithCircle();
  const initialText = "😀aa e\u0301 👩‍👩‍👧‍👦🏳️‍🌈";
  const initial = change(circle, operationUUID(10), {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: initialText,
    },
  });
  const acceptedInitial = await validatePlanMutation(
    circle,
    initial,
    context(),
  );
  const replaced = change(acceptedInitial.document, operationUUID(11), {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      index: 1,
      deleteCount: 1,
      text: "界",
    },
  });
  const accepted = await validatePlanMutation(
    acceptedInitial.document,
    replaced,
    context(),
  );
  assert.equal(accepted.document.circles["9001"]?.memo, "😀界a e\u0301 👩‍👩‍👧‍👦🏳️‍🌈");

  const repeated = change(circle, operationUUID(12), {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "aa",
    },
  });
  const repeatedBase = (await validatePlanMutation(circle, repeated, context()))
    .document;
  const operationID = operationUUID(13);
  const operation: PlanOperation = {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "a",
    },
  };
  const wrongIndex = Automerge.change(
    Automerge.clone(repeatedBase, { actor: actorID }),
    (draft) => {
      Automerge.splice(draft, ["circles", "9001", "memo"], 1, 0, "a");
      draft.operations[operationID] = operation;
    },
  );
  assert.equal(wrongIndex.circles["9001"]?.memo, "aaa");
  await assert.rejects(
    validatePlanMutation(repeatedBase, wrongIndex, context()),
    (error: unknown) => hasCode(error, "invalid_plan_operation"),
  );
});

test("operation-only, content-only, mismatched payload, and foreign actors fail closed", async () => {
  const bootstrap = loadBootstrap();
  const operationOnly = Automerge.change(fresh(bootstrap), (draft) => {
    draft.operations[circleOperationID] = {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userID,
      payload: { v: 1, wcID: 9001, state: "active" },
    };
  });
  await rejects(operationOnly, "invalid_plan_operation");

  const contentOnly = Automerge.change(fresh(bootstrap), (draft) => {
    draft.circles["9001"] = {
      comiketNo: 108,
      WCID: 9001,
      rootOperationID: circleOperationID,
      presence: { state: "active", operationID: circleOperationID },
      memo: "",
      needs: {},
      communicationState: {},
    };
  });
  await rejects(contentOnly, "invalid_plan_operation");

  const mismatched = Automerge.change(fresh(bootstrap), (draft) => {
    applyPlanOperation(draft, circleOperationID, {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userID,
      payload: { v: 1, wcID: 9001, state: "active" },
    });
    draft.circles["9001"]!.WCID = 9002;
  });
  await rejects(mismatched, "invalid_plan_document");

  await assert.rejects(
    validatePlanMutation(
      bootstrap,
      change(bootstrap, circleOperationID, {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, state: "active" },
      }),
      {
        ...context(),
        actors: new Map(),
      },
    ),
    (error: unknown) => hasCode(error, "unregistered_plan_actor"),
  );

  const forgedPeerChange = Automerge.change(
    Automerge.clone(bootstrap, { actor: actorB }),
    { message: `operation:${circleOperationID}` },
    (draft) =>
      applyPlanOperation(draft, circleOperationID, {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userB,
        payload: { v: 1, wcID: 9001, state: "active" },
      }),
  );
  await assert.rejects(
    validatePlanMutation(bootstrap, forgedPeerChange, contextWithPeer()),
    (error: unknown) => hasCode(error, "unregistered_plan_actor"),
  );
});

test("visible-value-equivalent whole-object replacements fail exact CRDT topology validation", async () => {
  const circle = await documentWithCircle();
  const need = await documentWithNeed();
  const needID = "66666666-6666-4666-8666-666666666666";
  const cases: Array<{
    base: Automerge.Doc<PlanDocument>;
    operation: PlanOperation;
    forge(draft: PlanDocument, operationID: string): void;
  }> = [
    {
      base: circle,
      operation: {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, state: "removed" },
      },
      forge(draft, operationID) {
        draft.circles["9001"] = {
          comiketNo: 108,
          WCID: 9001,
          rootOperationID: circleOperationID,
          presence: { state: "removed", operationID },
          memo: "",
          needs: {},
          communicationState: {},
        };
      },
    },
    {
      base: circle,
      operation: {
        type: "shared_plan.circle.memo.splice.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          index: 0,
          deleteCount: 0,
          text: "hello",
        },
      },
      forge(draft) {
        draft.circles["9001"]!.memo = "hello";
      },
    },
    {
      base: circle,
      operation: {
        type: "shared_plan.need.create.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          needID,
          requesterUserID: userID,
          wantedQuantity: 3,
        },
      },
      forge(draft, operationID) {
        draft.circles["9001"]!.needs = {
          [needID]: {
            rootOperationID: operationID,
            presence: { operationID, state: "active" },
            requesterUserID: userID,
            wantedQuantity: 3,
            buyerAllocations: {},
            fulfilledQuantity: 0,
          },
        };
      },
    },
    {
      base: need,
      operation: {
        type: "shared_plan.need.delete.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, needID },
      },
      forge(draft, operationID) {
        draft.circles["9001"]!.needs[needID] = needValue(
          operationID,
          { state: "removed" },
          needID,
        );
      },
    },
    {
      base: need,
      operation: {
        type: "shared_plan.need.wanted_quantity.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, needID, wantedQuantity: 4 },
      },
      forge(draft) {
        draft.circles["9001"]!.needs[needID] = needValue(
          "55555555-5555-4555-8555-555555555555",
          { wantedQuantity: 4 },
          needID,
        );
      },
    },
    {
      base: need,
      operation: {
        type: "shared_plan.need.buyer_allocation.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          needID,
          buyerUserID: userB,
          quantity: 2,
        },
      },
      forge(draft) {
        draft.circles["9001"]!.needs[needID]!.buyerAllocations = {
          [userB]: 2,
        };
      },
    },
    {
      base: need,
      operation: {
        type: "shared_plan.need.fulfilled_quantity.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, needID, fulfilledQuantity: 1 },
      },
      forge(draft) {
        draft.circles["9001"]!.needs[needID] = needValue(
          "55555555-5555-4555-8555-555555555555",
          { fulfilledQuantity: 1 },
          needID,
        );
      },
    },
    {
      base: circle,
      operation: {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "meeting.status",
          value: "連絡済み",
        },
      },
      forge(draft) {
        draft.circles["9001"]!.communicationState = {
          "meeting.status": "連絡済み",
        };
      },
    },
  ];
  for (const [index, item] of cases.entries()) {
    const operationID = operationUUID(500 + index);
    const candidate = Automerge.change(
      Automerge.clone(item.base, { actor: actorID }),
      (draft) => {
        item.forge(draft, operationID);
        draft.operations[operationID] = item.operation;
      },
    );
    await assert.rejects(
      validatePlanMutation(item.base, candidate, contextWithPeer()),
      (error: unknown) => hasCode(error, "invalid_plan_operation"),
      item.operation.type,
    );
  }
});

test("repeated sibling values and Text identities cannot alias canonical operation IDs", async () => {
  const need = await documentWithNeed();
  const needID = "66666666-6666-4666-8666-666666666666";
  const operationID = operationUUID(519);
  const operation: PlanOperation = {
    type: "shared_plan.need.wanted_quantity.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, needID, wantedQuantity: 4 },
  };

  // requesterUserID and actorUserID intentionally contain the same Text
  // scalar sequence under independent sibling objects. Their local op IDs
  // must remain distinct while later character operations refer to them.
  const exact = change(need, operationID, operation);
  const accepted = await validatePlanMutation(need, exact, context());
  assert.equal(
    accepted.document.circles["9001"]!.needs[needID]!.requesterUserID,
    userID,
  );

  // Replacing those visible-value-equivalent sibling objects must not be able
  // to swap or alias their make/Text/map operation topology.
  const forged = Automerge.change(
    Automerge.clone(need, { actor: actorID }),
    { message: `operation:${operationID}` },
    (draft) => {
      applyPlanOperation(draft, operationID, operation);
      const target = draft.circles["9001"]!.needs[needID]!;
      delete (target as Partial<typeof target>).requesterUserID;
      target.requesterUserID = userID;
      delete (target as Partial<typeof target>).buyerAllocations;
      target.buyerAllocations = {};
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(forged.circles["9001"]!.needs[needID])),
    JSON.parse(JSON.stringify(exact.circles["9001"]!.needs[needID])),
  );
  await assert.rejects(
    validatePlanMutation(need, forged, context()),
    (error: unknown) => hasCode(error, "invalid_plan_operation"),
  );
});

test("structured needs, allocations, fulfillment, and communication are payload exact", async () => {
  let document = (
    await validatePlanMutation(
      loadBootstrap(),
      change(loadBootstrap(), circleOperationID, {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, state: "active" },
      }),
      context(),
    )
  ).document;
  const operations: Array<[string, PlanOperation]> = [
    [
      "55555555-5555-4555-8555-555555555555",
      {
        type: "shared_plan.need.create.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          needID: "66666666-6666-4666-8666-666666666666",
          requesterUserID: userID,
          wantedQuantity: 3,
        },
      },
    ],
    [
      "77777777-7777-4777-8777-777777777777",
      {
        type: "shared_plan.need.buyer_allocation.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          needID: "66666666-6666-4666-8666-666666666666",
          buyerUserID: userID,
          quantity: 2,
        },
      },
    ],
    [
      "88888888-8888-4888-8888-888888888888",
      {
        type: "shared_plan.need.fulfilled_quantity.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          needID: "66666666-6666-4666-8666-666666666666",
          fulfilledQuantity: 1,
        },
      },
    ],
    [
      "99999999-9999-4999-8999-999999999999",
      {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "meeting.status",
          value: "連絡済み",
        },
      },
    ],
  ];
  for (const [operationID, operation] of operations) {
    const candidate = change(document, operationID, operation);
    document = (await validatePlanMutation(document, candidate, context()))
      .document;
  }
  const circle = document.circles["9001"]!;
  assert.deepEqual(circle.needs["66666666-6666-4666-8666-666666666666"], {
    rootOperationID: "55555555-5555-4555-8555-555555555555",
    presence: {
      state: "active",
      operationID: "55555555-5555-4555-8555-555555555555",
    },
    requesterUserID: userID,
    wantedQuantity: 3,
    buyerAllocations: { [userID]: 2 },
    fulfilledQuantity: 1,
  });
  assert.equal(circle.communicationState["meeting.status"], "連絡済み");
});

test("circle removal conflicts with every concurrent descendant operation in either arrival order", async () => {
  const base = await documentWithNeed();
  const descendants: PlanOperation[] = [
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
        needID: "66666666-6666-4666-8666-666666666667",
        requesterUserID: userB,
        wantedQuantity: 2,
      },
    },
    {
      type: "shared_plan.need.delete.v1",
      actorUserID: userB,
      payload: {
        v: 1,
        wcID: 9001,
        needID: "66666666-6666-4666-8666-666666666666",
      },
    },
    {
      type: "shared_plan.need.wanted_quantity.v1",
      actorUserID: userB,
      payload: {
        v: 1,
        wcID: 9001,
        needID: "66666666-6666-4666-8666-666666666666",
        wantedQuantity: 4,
      },
    },
    {
      type: "shared_plan.need.buyer_allocation.v1",
      actorUserID: userB,
      payload: {
        v: 1,
        wcID: 9001,
        needID: "66666666-6666-4666-8666-666666666666",
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
        needID: "66666666-6666-4666-8666-666666666666",
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
  for (const [index, descendantOperation] of descendants.entries()) {
    const removed = changeAs(base, actorID, operationUUID(100 + index), {
      type: "shared_plan.circle.presence.v1",
      actorUserID: userID,
      payload: { v: 1, wcID: 9001, state: "removed" },
    });
    const descendant = changeAs(
      base,
      actorB,
      operationUUID(200 + index),
      descendantOperation,
    );
    const [left, right] = await validateConcurrentPair(
      base,
      removed,
      contextWithPeer(),
      descendant,
      peerContext(),
    );
    assert.deepEqual(left.conflicts[0]?.path, ["circles", "9001", "presence"]);
    assert.equal(left.conflicts[0]?.conflictID, right.conflicts[0]?.conflictID);
    assert.equal(left.document.circles["9001"]?.presence.state, "removed");
    if (index === 0) {
      for (const state of ["removed", "active"] as const) {
        const resolution = changeAs(
          left.document,
          actorID,
          operationUUID(state === "removed" ? 250 : 251),
          {
            type: "shared_plan.circle.presence.v1",
            actorUserID: userID,
            payload: { v: 1, wcID: 9001, state },
          },
          true,
        );
        const accepted = await validatePlanMutation(
          left.document,
          resolution,
          contextWithPeer(),
        );
        assert.equal(
          (await detectPlanConflicts(accepted.document)).some(
            (conflict) =>
              canonicalPath(conflict.path) ===
              canonicalPath(["circles", "9001", "presence"]),
          ),
          false,
        );
      }
    }
  }
});

test("need tombstones retain and conflict with concurrent quantity work in either arrival order", async () => {
  const base = await documentWithNeed();
  const descendants: PlanOperation[] = [
    {
      type: "shared_plan.need.wanted_quantity.v1",
      actorUserID: userB,
      payload: {
        v: 1,
        wcID: 9001,
        needID: "66666666-6666-4666-8666-666666666666",
        wantedQuantity: 4,
      },
    },
    {
      type: "shared_plan.need.buyer_allocation.v1",
      actorUserID: userB,
      payload: {
        v: 1,
        wcID: 9001,
        needID: "66666666-6666-4666-8666-666666666666",
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
        needID: "66666666-6666-4666-8666-666666666666",
        fulfilledQuantity: 1,
      },
    },
  ];
  for (const [index, descendantOperation] of descendants.entries()) {
    const deleted = changeAs(base, actorID, operationUUID(300 + index), {
      type: "shared_plan.need.delete.v1",
      actorUserID: userID,
      payload: {
        v: 1,
        wcID: 9001,
        needID: "66666666-6666-4666-8666-666666666666",
      },
    });
    const descendant = changeAs(
      base,
      actorB,
      operationUUID(400 + index),
      descendantOperation,
    );
    const [left, right] = await validateConcurrentPair(
      base,
      deleted,
      contextWithPeer(),
      descendant,
      peerContext(),
    );
    assert.deepEqual(left.conflicts[0]?.path, [
      "circles",
      "9001",
      "needs",
      "66666666-6666-4666-8666-666666666666",
      "presence",
    ]);
    assert.equal(left.conflicts[0]?.conflictID, right.conflicts[0]?.conflictID);
    const need =
      left.document.circles["9001"]!.needs[
        "66666666-6666-4666-8666-666666666666"
      ]!;
    assert.equal(need.presence.state, "removed");
    if (descendantOperation.type === "shared_plan.need.buyer_allocation.v1")
      assert.equal(need.buyerAllocations[userB], 2);
    if (index === 0) {
      const resolutions: PlanOperation[] = [
        {
          type: "shared_plan.need.delete.v1",
          actorUserID: userID,
          payload: {
            v: 1,
            wcID: 9001,
            needID: "66666666-6666-4666-8666-666666666666",
          },
        },
        {
          type: "shared_plan.need.create.v1",
          actorUserID: userID,
          payload: {
            v: 1,
            wcID: 9001,
            needID: "66666666-6666-4666-8666-666666666666",
            requesterUserID: userID,
            wantedQuantity: 4,
          },
        },
      ];
      for (const [resolutionIndex, operation] of resolutions.entries()) {
        const resolution = changeAs(
          left.document,
          actorID,
          operationUUID(450 + resolutionIndex),
          operation,
          true,
        );
        const accepted = await validatePlanMutation(
          left.document,
          resolution,
          contextWithPeer(),
        );
        assert.equal(
          (await detectPlanConflicts(accepted.document)).some(
            (conflict) => conflict.path.at(-1) === "presence",
          ),
          false,
        );
      }
    }
  }
});

test("new scalar conflicts receive deterministic path-and-change-hash IDs", async () => {
  const bootstrap = loadBootstrap();
  const base = (
    await validatePlanMutation(
      bootstrap,
      change(bootstrap, circleOperationID, {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, state: "active" },
      }),
      context(),
    )
  ).document;
  const left = operationChange(
    base,
    actorID,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    userID,
    "会場",
  );
  const right = operationChange(
    base,
    actorB,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    userB,
    "ホテル",
  );
  const acceptedLeft = await validatePlanMutation(base, left, context());
  const merged = Automerge.merge(
    Automerge.clone(left, { actor: actorID }),
    Automerge.clone(right, { actor: actorB }),
  );
  const accepted = await validatePlanMutation(
    acceptedLeft.document,
    merged,
    peerContext(),
  );
  assert.equal(accepted.operations.length, 1);
  assert.equal(accepted.conflicts.length, 1);
  assert.deepEqual(accepted.conflicts[0]?.path, [
    "circles",
    "9001",
    "communicationState",
    "meeting.place",
  ]);
  assert.match(accepted.conflicts[0]!.conflictID, /^[0-9a-f]{64}$/);
  const acceptedRight = await validatePlanMutation(base, right, peerContext());
  const reverse = await validatePlanMutation(
    acceptedRight.document,
    Automerge.merge(
      Automerge.clone(right, { actor: actorB }),
      Automerge.clone(left, { actor: actorID }),
    ),
    contextWithPeer(),
  );
  assert.equal(
    reverse.conflicts[0]?.conflictID,
    accepted.conflicts[0]?.conflictID,
  );
});

test("same-visible and competing native register values are both resolvable", async () => {
  const base = await documentWithNeed();
  const needID = "66666666-6666-4666-8666-666666666666";
  const cases: Array<{
    left: PlanOperation;
    right: PlanOperation;
    values(document: Automerge.Doc<PlanDocument>): {
      visible: string | number;
      competing: Array<string | number>;
    };
    resolution(value: string | number): PlanOperation;
    remaining(document: Automerge.Doc<PlanDocument>): number;
  }> = [
    scalarResolutionCase(
      "shared_plan.need.wanted_quantity.v1",
      "wantedQuantity",
      4,
      5,
    ),
    scalarResolutionCase(
      "shared_plan.need.fulfilled_quantity.v1",
      "fulfilledQuantity",
      1,
      2,
    ),
    {
      left: allocationOperation(userID, 2),
      right: allocationOperation(userB, 3),
      values(document) {
        const allocations =
          document.circles["9001"]!.needs[needID]!.buyerAllocations;
        return {
          visible: allocations[userB]!,
          competing: Object.values(
            Automerge.getConflicts(allocations, userB) ?? {},
          ) as number[],
        };
      },
      resolution(value) {
        return allocationOperation(userID, Number(value));
      },
      remaining(document) {
        return Object.keys(
          Automerge.getConflicts(
            document.circles["9001"]!.needs[needID]!.buyerAllocations,
            userB,
          ) ?? {},
        ).length;
      },
    },
    {
      left: communicationOperation(userID, "会場"),
      right: communicationOperation(userB, "ホテル"),
      values(document) {
        const state = document.circles["9001"]!.communicationState;
        return {
          visible: String(state["meeting.place"]),
          competing: Object.values(
            Automerge.getConflicts(state, "meeting.place") ?? {},
          ) as string[],
        };
      },
      resolution(value) {
        return communicationOperation(userID, String(value));
      },
      remaining(document) {
        return Object.keys(
          Automerge.getConflicts(
            document.circles["9001"]!.communicationState,
            "meeting.place",
          ) ?? {},
        ).length;
      },
    },
  ];
  for (const [caseIndex, item] of cases.entries()) {
    const left = changeAs(
      base,
      actorID,
      operationUUID(600 + caseIndex * 10),
      item.left,
    );
    const right = changeAs(
      base,
      actorB,
      operationUUID(601 + caseIndex * 10),
      item.right,
    );
    const [merged] = await validateConcurrentPair(
      base,
      left,
      contextWithPeer(),
      right,
      peerContext(),
    );
    const values = item.values(merged.document);
    assert.equal(values.competing.length, 2);
    const loser = values.competing.find((value) => value !== values.visible)!;
    for (const [resolutionIndex, value] of [values.visible, loser].entries()) {
      const resolution = changeAs(
        merged.document,
        actorID,
        operationUUID(605 + caseIndex * 10 + resolutionIndex),
        item.resolution(value),
      );
      const accepted = await validatePlanMutation(
        merged.document,
        resolution,
        contextWithPeer(),
      );
      assert.ok(
        item.remaining(accepted.document) <= 1,
        `${item.left.type}:${String(value)}:${item.remaining(accepted.document)}`,
      );
    }
  }

  const circle = await documentWithCircle();
  const left = changeAs(circle, actorID, operationUUID(700), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "removed" },
  });
  const rightRemoved = changeAs(circle, actorB, operationUUID(701), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, state: "removed" },
  });
  const right = changeAs(rightRemoved, actorB, operationUUID(702), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const [mergedPresence] = await validateConcurrentPair(
    circle,
    left,
    contextWithPeer(),
    right,
    peerContext(),
  );
  const presenceValues = Object.values(
    Automerge.getConflicts(
      mergedPresence.document.circles["9001"]!,
      "presence",
    ) ?? {},
  ) as Array<{ state: "active" | "removed" }>;
  assert.equal(presenceValues.length, 2);
  for (const [index, value] of presenceValues.entries()) {
    const resolution = changeAs(
      mergedPresence.document,
      actorID,
      operationUUID(703 + index),
      {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9001, state: value.state },
      },
    );
    const accepted = await validatePlanMutation(
      mergedPresence.document,
      resolution,
      contextWithPeer(),
    );
    assert.ok(
      Object.keys(
        Automerge.getConflicts(
          accepted.document.circles["9001"]!,
          "presence",
        ) ?? {},
      ).length <= 1,
    );
  }
});

test("concurrent same-WCID creation is resolved at the parent while retaining nonselected descendants", async () => {
  const bootstrap = loadBootstrap();
  const leftAdded = changeAs(bootstrap, actorID, operationUUID(800), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const leftMemo = changeAs(leftAdded, actorID, operationUUID(801), {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "左のメモ",
    },
  });
  const left = changeAs(leftMemo, actorID, operationUUID(802), {
    type: "shared_plan.need.create.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      needID: operationUUID(810),
      requesterUserID: userID,
      wantedQuantity: 1,
    },
  });
  const rightAdded = changeAs(bootstrap, actorB, operationUUID(803), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const rightMemo = changeAs(rightAdded, actorB, operationUUID(804), {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "右のメモ",
    },
  });
  const rightNeed = changeAs(rightMemo, actorB, operationUUID(805), {
    type: "shared_plan.need.create.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID: operationUUID(811),
      requesterUserID: userB,
      wantedQuantity: 2,
    },
  });
  const right = changeAs(rightNeed, actorB, operationUUID(806), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, state: "removed" },
  });
  const arrivals = await validateConcurrentPair(
    bootstrap,
    left,
    contextWithPeer(),
    right,
    peerContext(),
  );
  for (const [arrivalIndex, merged] of arrivals.entries()) {
    assert.equal(
      Object.keys(Automerge.getConflicts(merged.document.circles, "9001") ?? {})
        .length,
      2,
    );
    for (const [choiceIndex, choice] of (
      [
        { state: "active", memo: "左のメモ" },
        { state: "removed", memo: "右のメモ" },
      ] as const
    ).entries()) {
      const candidate = changeAs(
        merged.document,
        actorID,
        operationUUID(820 + arrivalIndex * 10 + choiceIndex),
        {
          type: "shared_plan.circle.resolve_parent.v1",
          actorUserID: userID,
          payload: {
            v: 1,
            wcID: 9001,
            selectedParentOperationID:
              choice.state === "active"
                ? operationUUID(800)
                : operationUUID(803),
            state: choice.state,
            nestedResolutions: [],
          },
        },
      );
      const accepted = await validatePlanMutation(
        merged.document,
        candidate,
        contextWithPeer(),
      );
      assert.ok(
        Object.keys(
          Automerge.getConflicts(accepted.document.circles, "9001") ?? {},
        ).length <= 1,
      );
      const circle = accepted.document.circles["9001"]!;
      assert.equal(circle.presence.state, choice.state);
      assert.equal(circle.memo, choice.memo);
      assert.deepEqual(Object.keys(circle.needs).sort(), [
        operationUUID(810),
        operationUUID(811),
      ]);
      assert.equal(
        (await detectPlanConflicts(accepted.document)).some(
          (conflict) =>
            canonicalPath(conflict.path) === canonicalPath(["circles", "9001"]),
        ),
        false,
      );
    }
  }
});

test("concurrent same-needID creation can choose either parent and retain disjoint allocations", async () => {
  const base = await documentWithCircle();
  const needID = operationUUID(850);
  const leftCreated = changeAs(base, actorID, operationUUID(851), {
    type: "shared_plan.need.create.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userID,
      wantedQuantity: 2,
    },
  });
  const left = changeAs(leftCreated, actorID, operationUUID(852), {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      buyerUserID: userID,
      quantity: 1,
    },
  });
  const rightCreated = changeAs(base, actorB, operationUUID(853), {
    type: "shared_plan.need.create.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userB,
      wantedQuantity: 5,
    },
  });
  const right = changeAs(rightCreated, actorB, operationUUID(854), {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      buyerUserID: userB,
      quantity: 2,
    },
  });
  const arrivals = await validateConcurrentPair(
    base,
    left,
    contextWithPeer(),
    right,
    peerContext(),
  );
  for (const [arrivalIndex, merged] of arrivals.entries()) {
    const needs = merged.document.circles["9001"]!.needs;
    assert.equal(
      Object.keys(Automerge.getConflicts(needs, needID) ?? {}).length,
      2,
    );
    for (const [choiceIndex, choice] of (
      [
        { requesterUserID: userID, wantedQuantity: 2 },
        { requesterUserID: userB, wantedQuantity: 5 },
      ] as const
    ).entries()) {
      const candidate = changeAs(
        merged.document,
        actorID,
        operationUUID(860 + arrivalIndex * 10 + choiceIndex),
        {
          type: "shared_plan.need.resolve_parent.v1",
          actorUserID: userID,
          payload: {
            v: 1,
            wcID: 9001,
            needID,
            selectedParentOperationID:
              choice.requesterUserID === userID
                ? operationUUID(851)
                : operationUUID(853),
            state: "active",
            nestedResolutions: [],
          },
        },
      );
      const accepted = await validatePlanMutation(
        merged.document,
        candidate,
        contextWithPeer(),
      );
      const resolvedNeeds = accepted.document.circles["9001"]!.needs;
      assert.ok(
        Object.keys(Automerge.getConflicts(resolvedNeeds, needID) ?? {})
          .length <= 1,
      );
      const need = resolvedNeeds[needID]!;
      assert.equal(need.requesterUserID, choice.requesterUserID);
      assert.equal(need.wantedQuantity, choice.wantedQuantity);
      assert.deepEqual(need.buyerAllocations, { [userID]: 1, [userB]: 2 });
      assert.equal(
        (await detectPlanConflicts(accepted.document)).some(
          (conflict) =>
            canonicalPath(conflict.path) ===
            canonicalPath(["circles", "9001", "needs", needID]),
        ),
        false,
      );
    }
  }
});

test("same-active parent conflicts require an explicit branch and never silently drop its memo", async () => {
  const bootstrap = loadBootstrap();
  const leftAdded = changeAs(bootstrap, actorID, operationUUID(880), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const left = changeAs(leftAdded, actorID, operationUUID(881), {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "LEFT",
    },
  });
  const rightAdded = changeAs(bootstrap, actorB, operationUUID(882), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const right = changeAs(rightAdded, actorB, operationUUID(883), {
    type: "shared_plan.circle.memo.splice.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      index: 0,
      deleteCount: 0,
      text: "RIGHT",
    },
  });
  const arrivals = await validateConcurrentPair(
    bootstrap,
    left,
    contextWithPeer(),
    right,
    peerContext(),
  );
  for (const [arrivalIndex, merged] of arrivals.entries()) {
    assert.throws(
      () =>
        changeAs(merged.document, actorID, operationUUID(884 + arrivalIndex), {
          type: "shared_plan.circle.presence.v1",
          actorUserID: userID,
          payload: { v: 1, wcID: 9001, state: "active" },
        }),
      (error: unknown) => hasCode(error, "invalid_plan_operation"),
    );
    for (const [choiceIndex, choice] of (
      [
        { selected: operationUUID(880), memo: "LEFT" },
        { selected: operationUUID(882), memo: "RIGHT" },
      ] as const
    ).entries()) {
      const explicit = changeAs(
        merged.document,
        actorID,
        operationUUID(890 + arrivalIndex * 10 + choiceIndex),
        {
          type: "shared_plan.circle.resolve_parent.v1",
          actorUserID: userID,
          payload: {
            v: 1,
            wcID: 9001,
            selectedParentOperationID: choice.selected,
            state: "active",
            nestedResolutions: [],
          },
        },
      );
      const accepted = await validatePlanMutation(
        merged.document,
        explicit,
        contextWithPeer(),
      );
      assert.equal(accepted.document.circles["9001"]!.memo, choice.memo);
      assert.ok(
        Object.keys(
          Automerge.getConflicts(accepted.document.circles, "9001") ?? {},
        ).length <= 1,
      );
    }
  }
});

test("parent resolution explicitly resolves nested communication and need-register conflicts", async () => {
  const bootstrap = loadBootstrap();
  const leftRootID = operationUUID(920);
  const leftRoot = changeAs(bootstrap, actorID, leftRootID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const leftX = changeAs(leftRoot, actorID, operationUUID(921), {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, key: "meeting.place", value: "X" },
  });
  const leftY = changeAs(leftRoot, actorB, operationUUID(922), {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, key: "meeting.place", value: "Y" },
  });
  const conflictedLeft = Automerge.merge(leftX, leftY);
  const rightRoot = changeAs(bootstrap, actorC, operationUUID(923), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userC,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const circleParents = Automerge.merge(conflictedLeft, rightRoot);
  const postMergeCircle = changeAs(circleParents, actorID, operationUUID(924), {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, key: "post.merge", value: "Z" },
  });
  const postMergeCircleAccepted = await validatePlanMutation(
    circleParents,
    postMergeCircle,
    contextWithThird(),
  );
  const circleChoice = await nestedResolutionChoice(
    conflictedLeft,
    ["circles", "9001", "communicationState", "meeting.place"],
    "X",
  );
  const circleResolution = changeAs(
    postMergeCircleAccepted.document,
    actorID,
    operationUUID(925),
    {
      type: "shared_plan.circle.resolve_parent.v1",
      actorUserID: userID,
      payload: {
        v: 1,
        wcID: 9001,
        selectedParentOperationID: leftRootID,
        state: "active",
        nestedResolutions: [circleChoice],
      },
    },
  );
  const circleAccepted = await validatePlanMutation(
    postMergeCircleAccepted.document,
    circleResolution,
    contextWithThird(),
  );
  assert.equal(
    circleAccepted.document.circles["9001"]!.communicationState[
      "meeting.place"
    ],
    "X",
  );
  assert.deepEqual(await detectPlanConflicts(circleAccepted.document), []);

  const circle = await documentWithCircle();
  const needID = operationUUID(930);
  const leftNeedID = operationUUID(931);
  const leftNeed = changeAs(circle, actorID, leftNeedID, {
    type: "shared_plan.need.create.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userID,
      wantedQuantity: 2,
    },
  });
  const wantedX = changeAs(leftNeed, actorID, operationUUID(932), {
    type: "shared_plan.need.wanted_quantity.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, needID, wantedQuantity: 4 },
  });
  const wantedY = changeAs(leftNeed, actorB, operationUUID(933), {
    type: "shared_plan.need.wanted_quantity.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, needID, wantedQuantity: 5 },
  });
  const conflictedNeed = Automerge.merge(wantedX, wantedY);
  const rightNeed = changeAs(circle, actorC, operationUUID(934), {
    type: "shared_plan.need.create.v1",
    actorUserID: userC,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userC,
      wantedQuantity: 3,
    },
  });
  const needParents = Automerge.merge(conflictedNeed, rightNeed);
  const needChoice = await nestedResolutionChoice(
    conflictedNeed,
    ["circles", "9001", "needs", needID, "wantedQuantity"],
    5,
  );
  const needResolution = changeAs(needParents, actorID, operationUUID(935), {
    type: "shared_plan.need.resolve_parent.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      selectedParentOperationID: leftNeedID,
      state: "active",
      nestedResolutions: [needChoice],
    },
  });
  const needAccepted = await validatePlanMutation(
    needParents,
    needResolution,
    contextWithThird(),
  );
  assert.equal(
    needAccepted.document.circles["9001"]!.needs[needID]!.wantedQuantity,
    5,
  );
  assert.deepEqual(await detectPlanConflicts(needAccepted.document), []);
});

test("three-root parent resolution makes overlapping descendants explicit and retains disjoint allocations", async () => {
  const bootstrap = loadBootstrap();
  const rootAID = operationUUID(940);
  const rootBID = operationUUID(941);
  const rootCID = operationUUID(942);
  const rootA = changeAs(bootstrap, actorID, rootAID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  let rootB = changeAs(bootstrap, actorB, rootBID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  rootB = changeAs(rootB, actorB, operationUUID(943), {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, key: "meeting.place", value: "B" },
  });
  const needID = operationUUID(944);
  rootB = changeAs(rootB, actorB, operationUUID(945), {
    type: "shared_plan.need.create.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userB,
      wantedQuantity: 2,
    },
  });
  rootB = changeAs(rootB, actorB, operationUUID(946), {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, needID, buyerUserID: userB, quantity: 1 },
  });
  let rootC = changeAs(bootstrap, actorC, rootCID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userC,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  rootC = changeAs(rootC, actorC, operationUUID(947), {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userC,
    payload: { v: 1, wcID: 9001, key: "meeting.place", value: "C" },
  });
  rootC = changeAs(rootC, actorC, operationUUID(948), {
    type: "shared_plan.need.create.v1",
    actorUserID: userC,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userC,
      wantedQuantity: 3,
    },
  });
  rootC = changeAs(rootC, actorC, operationUUID(949), {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userC,
    payload: { v: 1, wcID: 9001, needID, buyerUserID: userC, quantity: 1 },
  });
  const merged = Automerge.merge(Automerge.merge(rootA, rootB), rootC);
  const communicationChoice = await overlappingParentResolutionChoice(
    merged,
    ["circles", "9001", "communicationState", "meeting.place"],
    [rootBID, rootCID],
    rootBID,
    "B",
  );
  const selectedNeed = JSON.parse(
    JSON.stringify(rootB.circles["9001"]!.needs[needID]),
  ) as unknown;
  const needChoice = await overlappingParentResolutionChoice(
    merged,
    ["circles", "9001", "needs", needID],
    [rootBID, rootCID],
    rootBID,
    selectedNeed,
  );
  const resolved = changeAs(merged, actorID, operationUUID(950), {
    type: "shared_plan.circle.resolve_parent.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      selectedParentOperationID: rootAID,
      state: "active",
      nestedResolutions: [communicationChoice, needChoice],
    },
  });
  const accepted = await validatePlanMutation(
    merged,
    resolved,
    contextWithThird(),
  );
  const resolvedCircle = accepted.document.circles["9001"]!;
  assert.equal(resolvedCircle.communicationState["meeting.place"], "B");
  assert.equal(resolvedCircle.needs[needID]!.wantedQuantity, 2);
  assert.deepEqual(resolvedCircle.needs[needID]!.buyerAllocations, {
    [userB]: 1,
    [userC]: 1,
  });

  const baseCircle = await documentWithCircle();
  const needAID = operationUUID(951);
  const needBID = operationUUID(952);
  const needCID = operationUUID(953);
  const buyerID = userB;
  const needA = changeAs(baseCircle, actorID, needAID, {
    type: "shared_plan.need.create.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userID,
      wantedQuantity: 1,
    },
  });
  let needB = changeAs(baseCircle, actorB, needBID, {
    type: "shared_plan.need.create.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userB,
      wantedQuantity: 2,
    },
  });
  needB = changeAs(needB, actorB, operationUUID(954), {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, needID, buyerUserID: buyerID, quantity: 2 },
  });
  let needC = changeAs(baseCircle, actorC, needCID, {
    type: "shared_plan.need.create.v1",
    actorUserID: userC,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userC,
      wantedQuantity: 3,
    },
  });
  needC = changeAs(needC, actorC, operationUUID(955), {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID: userC,
    payload: { v: 1, wcID: 9001, needID, buyerUserID: buyerID, quantity: 3 },
  });
  const needMerged = Automerge.merge(Automerge.merge(needA, needB), needC);
  const allocationChoice = await overlappingParentResolutionChoice(
    needMerged,
    ["circles", "9001", "needs", needID, "buyerAllocations", buyerID],
    [needBID, needCID],
    needBID,
    2,
  );
  const needResolved = changeAs(needMerged, actorID, operationUUID(956), {
    type: "shared_plan.need.resolve_parent.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      selectedParentOperationID: needAID,
      state: "active",
      nestedResolutions: [allocationChoice],
    },
  });
  const needAccepted = await validatePlanMutation(
    needMerged,
    needResolved,
    contextWithThird(),
  );
  assert.equal(
    needAccepted.document.circles["9001"]!.needs[needID]!.buyerAllocations[
      buyerID
    ],
    2,
  );
});

test("selected-parent precedence and nested object conflicts resolve deterministically", async () => {
  const bootstrap = loadBootstrap();
  const selectedRootID = operationUUID(970);
  let selectedRoot = changeAs(bootstrap, actorID, selectedRootID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  selectedRoot = changeAs(selectedRoot, actorID, operationUUID(971), {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, key: "meeting.place", value: "A" },
  });
  const otherRootID = operationUUID(972);
  const otherRoot = changeAs(bootstrap, actorB, otherRootID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const otherX = changeAs(otherRoot, actorB, operationUUID(973), {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, key: "meeting.place", value: "X" },
  });
  const otherY = changeAs(otherRoot, actorC, operationUUID(974), {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID: userC,
    payload: { v: 1, wcID: 9001, key: "meeting.place", value: "Y" },
  });
  const conflictedOther = Automerge.merge(otherX, otherY);
  const merged = Automerge.merge(selectedRoot, conflictedOther);
  const nested = await detectPlanConflicts(conflictedOther);
  const conflict = nested.find(
    (candidate) =>
      JSON.stringify(candidate.path) ===
      JSON.stringify([
        "circles",
        "9001",
        "communicationState",
        "meeting.place",
      ]),
  );
  assert.ok(conflict);
  const selectedChoice = {
    conflictID: conflict.conflictID,
    path: conflict.path.map(String),
    selectedChangeHash: semanticOperationChangeHash(merged, selectedRootID),
    value: "A",
  };
  const resolution = changeAs(merged, actorID, operationUUID(975), {
    type: "shared_plan.circle.resolve_parent.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      selectedParentOperationID: selectedRootID,
      state: "active",
      nestedResolutions: [selectedChoice],
    },
  });
  const accepted = await validatePlanMutation(
    merged,
    resolution,
    contextWithThird(),
  );
  assert.equal(
    accepted.document.circles["9001"]!.communicationState["meeting.place"],
    "A",
  );

  const leftRootID = operationUUID(976);
  const leftRoot = changeAs(bootstrap, actorID, leftRootID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9002, state: "active" },
  });
  const needID = operationUUID(977);
  const needA = changeAs(leftRoot, actorID, operationUUID(978), {
    type: "shared_plan.need.create.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9002,
      needID,
      requesterUserID: userID,
      wantedQuantity: 1,
    },
  });
  const needB = changeAs(leftRoot, actorB, operationUUID(979), {
    type: "shared_plan.need.create.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9002,
      needID,
      requesterUserID: userB,
      wantedQuantity: 2,
    },
  });
  const nestedNeedConflict = Automerge.merge(needA, needB);
  const rightRootID = operationUUID(980);
  const rightRoot = changeAs(bootstrap, actorC, rightRootID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userC,
    payload: { v: 1, wcID: 9002, state: "active" },
  });
  const objectValues = Object.values(
    Automerge.getConflicts(nestedNeedConflict.circles["9002"]!.needs, needID) ??
      {},
  );
  const selectedNeedValue = JSON.parse(
    JSON.stringify(
      objectValues.find(
        (value) =>
          (value as { requesterUserID?: string }).requesterUserID === userID,
      ),
    ),
  ) as unknown;
  const objectChoice = await nestedResolutionChoice(
    nestedNeedConflict,
    ["circles", "9002", "needs", needID],
    selectedNeedValue,
  );
  const nestedParents = Automerge.merge(nestedNeedConflict, rightRoot);
  const objectResolution = changeAs(
    nestedParents,
    actorID,
    operationUUID(981),
    {
      type: "shared_plan.circle.resolve_parent.v1",
      actorUserID: userID,
      payload: {
        v: 1,
        wcID: 9002,
        selectedParentOperationID: leftRootID,
        state: "active",
        nestedResolutions: [objectChoice],
      },
    },
  );
  const objectAccepted = await validatePlanMutation(
    nestedParents,
    objectResolution,
    contextWithThird(),
  );
  assert.equal(
    objectAccepted.document.circles["9002"]!.needs[needID]!.requesterUserID,
    userID,
  );
  assert.deepEqual(await detectPlanConflicts(objectAccepted.document), []);

  const removeA = changeAs(leftRoot, actorID, operationUUID(982), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9002, state: "removed" },
  });
  const removeB = changeAs(leftRoot, actorB, operationUUID(983), {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9002, state: "removed" },
  });
  const removedBranch = Automerge.merge(removeA, removeB);
  const removalParents = Automerge.merge(removedBranch, rightRoot);
  const removalResolution = changeAs(
    removalParents,
    actorID,
    operationUUID(984),
    {
      type: "shared_plan.circle.resolve_parent.v1",
      actorUserID: userID,
      payload: {
        v: 1,
        wcID: 9002,
        selectedParentOperationID: leftRootID,
        state: "removed",
        nestedResolutions: [],
      },
    },
  );
  const removalAccepted = await validatePlanMutation(
    removalParents,
    removalResolution,
    contextWithThird(),
  );
  assert.equal(
    removalAccepted.document.circles["9002"]!.presence.state,
    "removed",
  );
  assert.deepEqual(await detectPlanConflicts(removalAccepted.document), []);
});

test("unrelated post-merge edits do not hide circle or need parent branch frontiers", async () => {
  const bootstrap = loadBootstrap();
  const leftCircleID = operationUUID(960);
  const rightCircleID = operationUUID(961);
  const leftCircle = changeAs(bootstrap, actorID, leftCircleID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  const rightCircle = changeAs(bootstrap, actorB, rightCircleID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userB,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  for (const [arrivalIndex, merged] of [
    Automerge.merge(leftCircle, rightCircle),
    Automerge.merge(rightCircle, leftCircle),
  ].entries()) {
    const postMerge = changeAs(
      merged,
      actorID,
      operationUUID(962 + arrivalIndex * 10),
      {
        type: "shared_plan.circle.presence.v1",
        actorUserID: userID,
        payload: { v: 1, wcID: 9002, state: "active" },
      },
    );
    assert.equal(Automerge.getHeads(postMerge).length, 1);
    const resolution = changeAs(
      postMerge,
      actorID,
      operationUUID(963 + arrivalIndex * 10),
      {
        type: "shared_plan.circle.resolve_parent.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          selectedParentOperationID: leftCircleID,
          state: "active",
          nestedResolutions: [],
        },
      },
    );
    const accepted = await validatePlanMutation(
      postMerge,
      resolution,
      contextWithPeer(),
    );
    assert.ok(
      Object.keys(
        Automerge.getConflicts(accepted.document.circles, "9001") ?? {},
      ).length <= 1,
    );
  }

  const circle = await documentWithCircle();
  const needID = operationUUID(980);
  const leftNeedID = operationUUID(981);
  const rightNeedID = operationUUID(982);
  const leftNeed = changeAs(circle, actorID, leftNeedID, {
    type: "shared_plan.need.create.v1",
    actorUserID: userID,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userID,
      wantedQuantity: 2,
    },
  });
  const rightNeed = changeAs(circle, actorB, rightNeedID, {
    type: "shared_plan.need.create.v1",
    actorUserID: userB,
    payload: {
      v: 1,
      wcID: 9001,
      needID,
      requesterUserID: userB,
      wantedQuantity: 5,
    },
  });
  for (const [arrivalIndex, merged] of [
    Automerge.merge(leftNeed, rightNeed),
    Automerge.merge(rightNeed, leftNeed),
  ].entries()) {
    const postMerge = changeAs(
      merged,
      actorID,
      operationUUID(983 + arrivalIndex * 10),
      {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "post.merge",
          value: "unrelated",
        },
      },
    );
    assert.equal(Automerge.getHeads(postMerge).length, 1);
    const resolution = changeAs(
      postMerge,
      actorID,
      operationUUID(984 + arrivalIndex * 10),
      {
        type: "shared_plan.need.resolve_parent.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          needID,
          selectedParentOperationID: rightNeedID,
          state: "active",
          nestedResolutions: [],
        },
      },
    );
    const accepted = await validatePlanMutation(
      postMerge,
      resolution,
      contextWithPeer(),
    );
    assert.ok(
      Object.keys(
        Automerge.getConflicts(
          accepted.document.circles["9001"]!.needs,
          needID,
        ) ?? {},
      ).length <= 1,
    );
  }
});

test("an unsplittable 1,001-change offline frame fails before reconstruction", async (t) => {
  const current = await documentWithCircle();
  let candidate = Automerge.clone(current, { actor: actorID });
  for (let index = 0; index < 1_001; index += 1) {
    candidate = Automerge.change(candidate, (draft) =>
      applyPlanOperation(draft, operationUUID(40_000 + index), {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: userID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "offline.batch",
          value: index % 2 === 0 ? "東" : "西",
        },
      }),
    );
  }
  const started = performance.now();
  await assert.rejects(
    validatePlanMutation(current, candidate, context()),
    (error: unknown) => hasCode(error, "plan_sync_backlog_limit"),
  );
  const elapsed = performance.now() - started;
  t.diagnostic(`1,001-change preflight rejection: ${elapsed.toFixed(1)}ms`);
  assert.ok(
    elapsed < 500,
    `1,001-change preflight rejection took ${elapsed}ms`,
  );
});

function change(
  document: Automerge.Doc<PlanDocument>,
  operationID: string,
  operation: PlanOperation,
): Automerge.Doc<PlanDocument> {
  return Automerge.change(
    fresh(document),
    { message: `operation:${operationID}` },
    (draft) => applyPlanOperation(draft, operationID, operation),
  );
}

function changeWithMessage(
  document: Automerge.Doc<PlanDocument>,
  operationID: string,
  operation: PlanOperation,
  message: string | undefined,
): Automerge.Doc<PlanDocument> {
  const callback = (draft: PlanDocument) =>
    applyPlanOperation(draft, operationID, operation);
  return message === undefined
    ? Automerge.change(fresh(document), callback)
    : Automerge.change(fresh(document), { message }, callback);
}

function changeAs(
  document: Automerge.Doc<PlanDocument>,
  actor: string,
  operationID: string,
  operation: PlanOperation,
  semanticResolution = false,
): Automerge.Doc<PlanDocument> {
  return Automerge.change(
    Automerge.clone(document, { actor }),
    { message: `operation:${operationID}` },
    (draft) =>
      applyPlanOperation(draft, operationID, operation, {
        semanticResolution,
      }),
  );
}

async function nestedResolutionChoice(
  document: Automerge.Doc<PlanDocument>,
  path: string[],
  value: unknown,
): Promise<{
  conflictID: string;
  path: string[];
  selectedChangeHash: string;
  value: unknown;
}> {
  const conflict = (await detectPlanConflicts(document)).find(
    (candidate) => JSON.stringify(candidate.path) === JSON.stringify(path),
  );
  assert.ok(conflict, `missing conflict at ${path.join("/")}`);
  let parent: unknown = document;
  for (const part of path.slice(0, -1)) {
    assert.ok(parent !== null && typeof parent === "object");
    parent = (parent as Record<string, unknown>)[part];
  }
  assert.ok(parent !== null && typeof parent === "object");
  const competing = Automerge.getConflicts(
    parent as object,
    path[path.length - 1]!,
  );
  assert.ok(competing);
  const match = Object.entries(competing).find(
    ([, candidate]) => JSON.stringify(candidate) === JSON.stringify(value),
  );
  assert.ok(match, `missing selected value at ${path.join("/")}`);
  const operationToHash = new Map<string, string>();
  for (const bytes of Automerge.getAllChanges(document)) {
    const decoded = Automerge.decodeChange(bytes);
    for (let offset = 0; offset < decoded.ops.length; offset += 1)
      operationToHash.set(
        `${decoded.startOp + offset}@${decoded.actor}`,
        decoded.hash,
      );
  }
  const selectedChangeHash = operationToHash.get(match[0]);
  assert.ok(selectedChangeHash);
  return {
    conflictID: conflict.conflictID,
    path,
    selectedChangeHash,
    value,
  };
}

async function overlappingParentResolutionChoice(
  document: Automerge.Doc<PlanDocument>,
  path: string[],
  parentOperationIDs: string[],
  selectedParentOperationID: string,
  value: unknown,
): Promise<{
  conflictID: string;
  path: string[];
  selectedChangeHash: string;
  value: unknown;
}> {
  const changeHashes = parentOperationIDs
    .map((operationID) => semanticOperationChangeHash(document, operationID))
    .sort();
  return {
    conflictID: await sha256Hex(
      canonicalJSON({ schemaVersion: 1, path, changeHashes }),
    ),
    path,
    selectedChangeHash: semanticOperationChangeHash(
      document,
      selectedParentOperationID,
    ),
    value,
  };
}

function semanticOperationChangeHash(
  document: Automerge.Doc<PlanDocument>,
  operationID: string,
): string {
  const objectID = Automerge.getObjectId(document.operations[operationID]);
  assert.ok(objectID);
  for (const bytes of Automerge.getAllChanges(document)) {
    const decoded = Automerge.decodeChange(bytes);
    for (let offset = 0; offset < decoded.ops.length; offset += 1)
      if (`${decoded.startOp + offset}@${decoded.actor}` === objectID)
        return decoded.hash;
  }
  assert.fail(`missing change for ${operationID}`);
}

function operationChange(
  document: Automerge.Doc<PlanDocument>,
  actor: string,
  operationID: string,
  actorUserID: string,
  value: string,
): Automerge.Doc<PlanDocument> {
  return Automerge.change(
    Automerge.clone(document, { actor }),
    { message: `operation:${operationID}` },
    (draft) =>
      applyPlanOperation(draft, operationID, {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "meeting.place",
          value,
        },
      }),
  );
}

async function documentWithNeed(): Promise<Automerge.Doc<PlanDocument>> {
  const acceptedCircle = { document: await documentWithCircle() };
  const need = change(
    acceptedCircle.document,
    "55555555-5555-4555-8555-555555555555",
    {
      type: "shared_plan.need.create.v1",
      actorUserID: userID,
      payload: {
        v: 1,
        wcID: 9001,
        needID: "66666666-6666-4666-8666-666666666666",
        requesterUserID: userID,
        wantedQuantity: 3,
      },
    },
  );
  return (await validatePlanMutation(acceptedCircle.document, need, context()))
    .document;
}

async function documentWithCircle(): Promise<Automerge.Doc<PlanDocument>> {
  const bootstrap = loadBootstrap();
  const circle = change(bootstrap, circleOperationID, {
    type: "shared_plan.circle.presence.v1",
    actorUserID: userID,
    payload: { v: 1, wcID: 9001, state: "active" },
  });
  return (await validatePlanMutation(bootstrap, circle, context())).document;
}

function needValue(
  presenceOperationID: string,
  override: {
    state?: "active" | "removed";
    wantedQuantity?: number;
    fulfilledQuantity?: number;
  } = {},
  rootOperationID = presenceOperationID,
) {
  return {
    rootOperationID,
    presence: {
      state: override.state ?? ("active" as const),
      operationID: presenceOperationID,
    },
    requesterUserID: userID,
    wantedQuantity: override.wantedQuantity ?? 3,
    buyerAllocations: {},
    fulfilledQuantity: override.fulfilledQuantity ?? 0,
  };
}

async function validateConcurrentPair(
  base: Automerge.Doc<PlanDocument>,
  left: Automerge.Doc<PlanDocument>,
  leftContext: ReturnType<typeof contextWithPeer>,
  right: Automerge.Doc<PlanDocument>,
  rightContext: ReturnType<typeof contextWithPeer>,
) {
  const acceptedLeft = await validatePlanMutation(base, left, leftContext);
  const leftMerged = Automerge.merge(
    Automerge.clone(acceptedLeft.document),
    Automerge.clone(right),
  );
  const leftResult = await validatePlanMutation(
    acceptedLeft.document,
    leftMerged,
    rightContext,
  );
  const acceptedRight = await validatePlanMutation(base, right, rightContext);
  const rightMerged = Automerge.merge(
    Automerge.clone(acceptedRight.document),
    Automerge.clone(left),
  );
  const rightResult = await validatePlanMutation(
    acceptedRight.document,
    rightMerged,
    leftContext,
  );
  return [leftResult, rightResult] as const;
}

function operationUUID(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;
}

function canonicalPath(path: Array<string | number>): string {
  return JSON.stringify(path);
}

function scalarResolutionCase(
  type:
    | "shared_plan.need.wanted_quantity.v1"
    | "shared_plan.need.fulfilled_quantity.v1",
  key: "wantedQuantity" | "fulfilledQuantity",
  leftValue: number,
  rightValue: number,
) {
  const needID = "66666666-6666-4666-8666-666666666666";
  const operation = (actorUserID: string, value: number): PlanOperation => ({
    type,
    actorUserID,
    payload: { v: 1, wcID: 9001, needID, [key]: value },
  });
  return {
    left: operation(userID, leftValue),
    right: operation(userB, rightValue),
    values(document: Automerge.Doc<PlanDocument>) {
      const need = document.circles["9001"]!.needs[needID]!;
      return {
        visible: need[key],
        competing: Object.values(
          Automerge.getConflicts(need, key) ?? {},
        ) as number[],
      };
    },
    resolution(value: string | number) {
      return operation(userID, Number(value));
    },
    remaining(document: Automerge.Doc<PlanDocument>) {
      return Object.keys(
        Automerge.getConflicts(document.circles["9001"]!.needs[needID]!, key) ??
          {},
      ).length;
    },
  };
}

function allocationOperation(
  actorUserID: string,
  quantity: number,
): PlanOperation {
  return {
    type: "shared_plan.need.buyer_allocation.v1",
    actorUserID,
    payload: {
      v: 1,
      wcID: 9001,
      needID: "66666666-6666-4666-8666-666666666666",
      buyerUserID: userB,
      quantity,
    },
  };
}

function communicationOperation(
  actorUserID: string,
  value: string,
): PlanOperation {
  return {
    type: "shared_plan.circle.communication.set.v1",
    actorUserID,
    payload: {
      v: 1,
      wcID: 9001,
      key: "meeting.place",
      value,
    },
  };
}

function fresh(
  document: Automerge.Doc<PlanDocument>,
): Automerge.Doc<PlanDocument> {
  return Automerge.clone(document, { actor: actorID });
}

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

function contextWithPeer() {
  const value = context();
  return {
    ...value,
    actors: new Map([
      ...value.actors,
      [
        actorB,
        {
          actorID: actorB,
          userID: 2,
          userPublicID: userB,
          replicaID: "44444444-4444-4444-8444-444444444444",
          authVersion: 1,
          membershipEpoch: 1,
        },
      ] as const,
    ]),
    activeMemberPublicIDs: new Set([userID, userB]),
  };
}

function peerContext() {
  return {
    ...contextWithPeer(),
    frameActorID: actorB,
    frameUserPublicID: userB,
  };
}

function contextWithThird() {
  const value = contextWithPeer();
  return {
    ...value,
    actors: new Map([
      ...value.actors,
      [
        actorC,
        {
          actorID: actorC,
          userID: 3,
          userPublicID: userC,
          replicaID: "55555555-5555-4555-8555-555555555555",
          authVersion: 1,
          membershipEpoch: 1,
        },
      ] as const,
    ]),
    activeMemberPublicIDs: new Set([userID, userB, userC]),
  };
}

async function rejects(
  candidate: Automerge.Doc<PlanDocument>,
  code: string,
): Promise<void> {
  await assert.rejects(
    validatePlanMutation(loadBootstrap(), candidate, context()),
    (error: unknown) => hasCode(error, code),
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
