import * as Automerge from "@automerge/automerge";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256Hex } from "../src/lib/server/auth-sessions";
import {
  applyPlanOperation,
  detectPlanConflicts,
  maximumNewOperationsPerSyncFrame,
  maximumRetainedOperationPayloadBytes,
  type PlanDocument,
  validatePlanMutation,
} from "../src/lib/server/plan-document";
import {
  classifySyncFrame,
  hasPlanSessionCapacity,
  parseSyncEnvelope,
  planSyncErrorEnvelope,
} from "../src/lib/server/sync-protocol";
import { SerializedOperationQueue } from "../src/lib/server/serialized-operation-queue";
import { sendPlanSyncFrameIfAuthorized } from "../src/lib/server/plan-sync-send-gate";
import {
  advancePlanPeerSession,
  advancePlanPeerSessions,
} from "../src/lib/server/plan-sync-peer";
import { preparePlanActorAuthorities } from "../src/lib/server/plan-actor-authority";
import {
  notificationOutboxFitsBounds,
  type SharedPlanOutboxEvent,
} from "../src/lib/server/plan-notifications";

test("the Swift/JS bootstrap fixture encodes immutable planID as a scalar RawString", () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/automerge-bootstrap-v1.json", "utf8"),
  ) as {
    planID: string;
    comiketNo: number;
    document: string;
    heads: string[];
  };
  const document = Automerge.load<{
    planID: Automerge.ImmutableString;
    comiketNo: number;
  }>(Uint8Array.from(Buffer.from(fixture.document, "base64url")));
  assert.ok(document.planID instanceof Automerge.ImmutableString);
  assert.equal(document.planID.val, fixture.planID);
  assert.equal(document.comiketNo, fixture.comiketNo);
  assert.deepEqual(Automerge.getHeads(document), fixture.heads);
});

test("sync frames reject uppercase UUID wire identifiers", () => {
  const planID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sessionID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const base = {
    v: 1,
    type: "sync",
    planID,
    sessionID,
    replicaID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    actorID: "0123456789abcdef",
    seq: 1,
    frameID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    payload: "AA",
  };
  const attachment = {
    v: 1 as const,
    planID,
    sessionID,
    userID: 1,
    userPublicID: "00000000000000000000000000000001",
    authVersion: 1,
  };
  assert.equal(
    parseSyncEnvelope(JSON.stringify(base), attachment).frameID,
    base.frameID,
  );
  assert.throws(() =>
    parseSyncEnvelope(
      JSON.stringify({ ...base, frameID: base.frameID.toUpperCase() }),
      attachment,
    ),
  );
});

test("a revocation that commits during frame work prevents every later send", async () => {
  let finishAuthorityCheck!: (value: boolean) => void;
  const authority = new Promise<boolean>((resolve) => {
    finishAuthorityCheck = resolve;
  });
  const sent: string[] = [];
  const closed: Array<[number, string]> = [];
  const pending = sendPlanSyncFrameIfAuthorized(
    () => authority,
    {
      send: (message) => sent.push(String(message)),
      close: (code, reason) => closed.push([code, reason]),
    },
    "document-bytes",
  );

  // Models D1 membership revocation linearizing while SHA/Automerge work is
  // suspended, before the outbound continuation is allowed to run.
  finishAuthorityCheck(false);
  assert.equal(await pending, false);
  assert.deepEqual(sent, []);
  assert.deepEqual(closed, [[4403, "membership_revoked"]]);
});

test("an accepted commit advances an idle negotiated peer durably before send", async () => {
  const fixture = syncFixture();
  const bootstrap = loadDocument(fixture.bootstrap.document);
  const peer = loadDocument(
    fixture.bootstrap.document,
    fixture.actors[1]!.actorID,
  );
  const negotiated = settleDocuments(bootstrap, peer);
  const committed = loadDocument(fixture.initialSession.acceptedDocument);
  const order: string[] = [];
  let persistedState: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let persistedSequence = 0;
  let frame = "";
  const result = await advancePlanPeerSession({
    document: committed,
    encodedSyncState: Automerge.encodeSyncState(negotiated.leftState),
    nextServerSequence: 7,
    planID: fixture.planID,
    sessionID: "22222222-2222-4222-8222-222222222223",
    frameID: "55555555-5555-4555-8555-555555555556",
    hasAuthority: async () => true,
    persist(encoded, nextSequence) {
      order.push("persist");
      persistedState = encoded;
      persistedSequence = nextSequence;
    },
    socket: {
      send(value) {
        order.push("send");
        frame = value;
      },
      close() {
        throw new Error("authorized peer unexpectedly closed");
      },
    },
  });
  assert.equal(result, "sent");
  assert.deepEqual(order, ["persist", "send"]);
  assert.equal(persistedSequence, 8);
  assert.ok(persistedState.byteLength > 0);
  const envelope = JSON.parse(frame) as { payload: string; seq: number };
  assert.equal(envelope.seq, 7);
  let [updatedPeer, updatedPeerState] = Automerge.receiveSyncMessage(
    Automerge.clone(negotiated.right, {
      actor: fixture.actors[1]!.actorID,
    }),
    negotiated.rightState,
    bytes(envelope.payload),
  );
  let continuedServer = committed;
  let continuedServerState = Automerge.decodeSyncState(persistedState);
  for (let round = 0; round < 10; round += 1) {
    let message: Uint8Array | null;
    [updatedPeerState, message] = Automerge.generateSyncMessage(
      updatedPeer,
      updatedPeerState,
    );
    if (!message) break;
    [continuedServer, continuedServerState] = Automerge.receiveSyncMessage(
      Automerge.clone(continuedServer),
      continuedServerState,
      message,
    );
    [continuedServerState, message] = Automerge.generateSyncMessage(
      continuedServer,
      continuedServerState,
    );
    if (message) {
      [updatedPeer, updatedPeerState] = Automerge.receiveSyncMessage(
        Automerge.clone(updatedPeer, {
          actor: fixture.actors[1]!.actorID,
        }),
        updatedPeerState,
        message,
      );
    }
  }
  assert.deepEqual(sortedHeads(updatedPeer), sortedHeads(committed));
});

test("a peer revoked after durable session advancement receives no document bytes", async () => {
  const fixture = syncFixture();
  const bootstrap = loadDocument(fixture.bootstrap.document);
  const negotiated = settleDocuments(
    bootstrap,
    loadDocument(fixture.bootstrap.document, fixture.actors[1]!.actorID),
  );
  const checks = [true, false];
  const sent: string[] = [];
  const closed: Array<[number, string]> = [];
  let persisted = false;
  const result = await advancePlanPeerSession({
    document: loadDocument(fixture.initialSession.acceptedDocument),
    encodedSyncState: Automerge.encodeSyncState(negotiated.leftState),
    nextServerSequence: 1,
    planID: fixture.planID,
    sessionID: "22222222-2222-4222-8222-222222222223",
    frameID: "55555555-5555-4555-8555-555555555556",
    hasAuthority: async () => checks.shift() ?? false,
    persist() {
      persisted = true;
    },
    socket: {
      send(value) {
        sent.push(value);
      },
      close(code, reason) {
        closed.push([code, reason]);
      },
    },
  });
  assert.equal(result, "revoked");
  assert.equal(persisted, true);
  assert.deepEqual(sent, []);
  assert.deepEqual(closed, [[4403, "membership_revoked"]]);
});

test("100 peer authority checks run in bounded parallel after the origin ack", async () => {
  const document = Automerge.from<PlanDocument>({
    schemaVersion: 1,
    planID: new Automerge.ImmutableString(
      "11111111-1111-4111-8111-111111111111",
    ),
    comiketNo: 108,
    circles: {},
    operations: {},
  });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let authorityCalls = 0;
  let sends = 0;
  const broadcast = advancePlanPeerSessions(
    Array.from({ length: 100 }, (_, index) => ({
      document,
      encodedSyncState: Automerge.encodeSyncState(Automerge.initSyncState()),
      nextServerSequence: 1,
      planID: "11111111-1111-4111-8111-111111111111",
      sessionID: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      frameID: `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      hasAuthority: async () => {
        authorityCalls += 1;
        if (authorityCalls <= 100) await delayed;
        return true;
      },
      persist: () => undefined,
      socket: {
        send: () => {
          sends += 1;
        },
        close: () => assert.fail("authorized peer must stay open"),
      },
    })),
  );
  await Promise.resolve();
  assert.equal(authorityCalls, 100);
  release();
  await broadcast;
  assert.equal(authorityCalls, 200);
  assert.equal(sends, 100);

  const source = readFileSync("src/lib/server/plan-sync-object.ts", "utf8");
  const transaction = source.indexOf("const committedDocument =");
  const ack = source.indexOf(
    "const acknowledged = await this.sendIfAuthorized",
    transaction,
  );
  const peerFanout = source.indexOf("this.broadcastCommittedDocument(", ack);
  assert.ok(ack > transaction && peerFanout > ack);
});

test("literal 3.2.6 transport vectors negotiate, mutate, acknowledge, and apply the JS response", async () => {
  const fixture = syncFixture();
  assert.deepEqual(fixture.producer, {
    package: "@automerge/automerge",
    version: "3.2.6",
    runtime: "JavaScript",
  });
  assert.deepEqual(fixture.swiftInterop, {
    targetPackage: "automerge-swift",
    targetVersion: "0.7.2",
    status: "pending-swift-authored-vectors",
    requiredBeforeMutationEnablement: true,
  });
  assert.deepEqual(fixture.limits, {
    retainedOperationPayloadUTF8Bytes: maximumRetainedOperationPayloadBytes,
    retainedOperationPayloadCanonicalForm:
      "sum(utf8(canonical-json(operation.payload)))",
    compactionError: "plan_compaction_required",
    maximumOperations: 10_000,
    maximumNewOperationsPerSyncFrame,
    backlogError: "plan_sync_backlog_limit",
  });
  let server = loadDocument(fixture.bootstrap.document);
  let client = loadDocument(
    fixture.initialSession.acceptedDocument,
    fixture.actors[0]!.actorID,
  );
  let serverState = Automerge.initSyncState();
  let clientState = Automerge.initSyncState();

  const clientNegotiation = bytes(
    fixture.initialSession.clientNegotiationEnvelope.payload,
  );
  [server, serverState] = Automerge.receiveSyncMessage(
    Automerge.clone(server),
    serverState,
    clientNegotiation,
  );
  let serverNeed: Uint8Array | null;
  [serverState, serverNeed] = Automerge.generateSyncMessage(
    server,
    serverState,
  );
  assert.equal(
    base64(serverNeed!),
    fixture.initialSession.serverNeedEnvelope.payload,
  );
  [client, clientState] = Automerge.receiveSyncMessage(
    Automerge.clone(client, { actor: fixture.actors[0]!.actorID }),
    clientState,
    serverNeed!,
  );
  let clientChanges: Uint8Array | null;
  [clientState, clientChanges] = Automerge.generateSyncMessage(
    client,
    clientState,
  );
  assert.equal(
    base64(clientChanges!),
    fixture.initialSession.acceptedEnvelope.payload,
  );
  const beforeMutation = server;
  [server, serverState] = Automerge.receiveSyncMessage(
    Automerge.clone(server),
    serverState,
    clientChanges!,
  );
  assert.deepEqual(sortedHeads(server), fixture.initialSession.acceptedHeads);
  const validated = await validatePlanMutation(beforeMutation, server, {
    planID: fixture.planID,
    comiketNo: fixture.comiketNo,
    frameActorID: fixture.actors[0]!.actorID,
    frameUserPublicID: fixture.actors[0]!.userPublicID,
    actors: actorMap(fixture),
    activeMemberPublicIDs: new Set(
      fixture.actors.map((actor) => actor.userPublicID),
    ),
    membershipEpoch: 1,
  });
  assert.equal(validated.operations.length, 1);
  let serverResponse: Uint8Array | null;
  [serverState, serverResponse] = Automerge.generateSyncMessage(
    server,
    serverState,
  );
  assert.equal(
    base64(serverResponse!),
    fixture.initialSession.serverResponseEnvelope.payload,
  );
  [client] = Automerge.receiveSyncMessage(
    Automerge.clone(client, { actor: fixture.actors[0]!.actorID }),
    clientState,
    serverResponse!,
  );
  assert.deepEqual(sortedHeads(client), fixture.initialSession.acceptedHeads);
  assert.deepEqual(
    fixture.initialSession.ack.documentHeads,
    sortedHeads(server),
  );
});

test("a raw 21-change offline backlog converges with a compact 50-member audience", async () => {
  const fixture = syncFixture();
  for (const backlogLength of [21]) {
    const activeBase = loadDocument(
      fixture.initialSession.acceptedDocument,
      fixture.actors[0]!.actorID,
    );
    const wcID = Number(Object.keys(activeBase.circles)[0]);
    assert.ok(Number.isSafeInteger(wcID));
    let offline = activeBase;
    for (let index = 0; index < backlogLength; index += 1) {
      const operationID = `60000000-0000-4000-8000-${(index + 1)
        .toString(16)
        .padStart(12, "0")}`;
      offline = Automerge.change(
        offline,
        { message: `operation:${operationID}` },
        (draft) =>
          applyPlanOperation(draft, operationID, {
            type: "shared_plan.circle.communication.set.v1",
            actorUserID: fixture.actors[0]!.userPublicID,
            payload: {
              v: 1,
              wcID,
              key: "offline.batch",
              value: index % 2 === 0 ? "東" : "西",
            },
          }),
      );
    }

    let server = Automerge.clone(activeBase);
    let client = offline;
    let serverState = Automerge.initSyncState();
    let clientState = Automerge.initSyncState();
    let message: Uint8Array | null;
    [clientState, message] = Automerge.generateSyncMessage(client, clientState);
    assert.ok(message);
    [server, serverState] = Automerge.receiveSyncMessage(
      server,
      serverState,
      message,
    );
    [serverState, message] = Automerge.generateSyncMessage(server, serverState);
    assert.ok(message);
    [client, clientState] = Automerge.receiveSyncMessage(
      client,
      clientState,
      message,
    );
    [clientState, message] = Automerge.generateSyncMessage(client, clientState);
    assert.ok(message);
    const beforeBatch = server;
    [server] = Automerge.receiveSyncMessage(server, serverState, message);
    assert.equal(
      Automerge.getChanges(beforeBatch, server).length,
      backlogLength,
    );

    const validation = validatePlanMutation(activeBase, server, {
      planID: fixture.planID,
      comiketNo: fixture.comiketNo,
      frameActorID: fixture.actors[0]!.actorID,
      frameUserPublicID: fixture.actors[0]!.userPublicID,
      actors: actorMap(fixture),
      activeMemberPublicIDs: new Set(
        fixture.actors.map((actor) => actor.userPublicID),
      ),
      membershipEpoch: 2,
    });
    const accepted = await validation;
    assert.equal(accepted.operations.length, backlogLength);
    const events: SharedPlanOutboxEvent[] = accepted.operations.map(
      (operation, index) => ({
        eventID: index.toString(16).padStart(64, "0"),
        planID: fixture.planID,
        sourceKind: "operation",
        sourceID: operation.operationID,
        actorUserID: 1,
        eventType: operation.operationType,
        i18nKey: "shared_plan.circle.communication.set",
        payloadVersion: 1,
        payloadJSON: JSON.stringify(operation),
        membershipEpoch: 2,
        planNotificationEpoch: 1,
        createdAt: 100,
      }),
    );
    assert.equal(notificationOutboxFitsBounds(events, 50), true);
  }
});

test("literal 1,000/1,001 sync messages freeze the pre-reconstruction backlog boundary", async () => {
  const fixture = syncFixture();
  assert.deepEqual(
    fixture.backlogLimitVectors.vectors.map((vector) => vector.changeCount),
    [maximumNewOperationsPerSyncFrame, maximumNewOperationsPerSyncFrame + 1],
  );
  for (const vector of fixture.backlogLimitVectors.vectors) {
    let server = loadDocument(fixture.backlogLimitVectors.baseDocument);
    let client = loadDocument(
      vector.clientDocument,
      fixture.actors[0]!.actorID,
    );
    let serverState = Automerge.initSyncState();
    let clientState = Automerge.initSyncState();
    let message: Uint8Array | null;
    [clientState, message] = Automerge.generateSyncMessage(client, clientState);
    assert.equal(base64(message!), vector.clientHavePayload);
    [server, serverState] = Automerge.receiveSyncMessage(
      server,
      serverState,
      message!,
    );
    [serverState, message] = Automerge.generateSyncMessage(server, serverState);
    assert.equal(base64(message!), vector.serverNeedPayload);
    [client, clientState] = Automerge.receiveSyncMessage(
      client,
      clientState,
      message!,
    );
    [clientState, message] = Automerge.generateSyncMessage(client, clientState);
    assert.equal(base64(message!), vector.clientChangesPayload);
    assert.equal(message!.byteLength, vector.clientChangesPayloadBytes);
    const before = server;
    [server] = Automerge.receiveSyncMessage(server, serverState, message!);
    assert.equal(
      Automerge.getChanges(before, server).length,
      vector.changeCount,
    );
    const validation = validatePlanMutation(before, server, {
      planID: fixture.planID,
      comiketNo: fixture.comiketNo,
      frameActorID: fixture.actors[0]!.actorID,
      frameUserPublicID: fixture.actors[0]!.userPublicID,
      actors: actorMap(fixture),
      activeMemberPublicIDs: new Set(
        fixture.actors.map((actor) => actor.userPublicID),
      ),
      membershipEpoch: 2,
    });
    if (vector.expected.status === "accepted") {
      assert.equal((await validation).operations.length, vector.changeCount);
    } else {
      assert.deepEqual(vector.expected, {
        status: "rejected",
        closeCode: 4422,
        error: planSyncErrorEnvelope("plan_sync_backlog_limit", {
          maximumNewOperationsPerSyncFrame,
          receivedChanges: vector.changeCount,
        }),
      });
      await assert.rejects(validation, (error: unknown) =>
        hasCode(error, "plan_sync_backlog_limit"),
      );
    }
  }
});

test("literal receipt vectors distinguish exact retry, changed bytes, and sequence gaps", async () => {
  const fixture = syncFixture();
  const attachment = {
    v: 1 as const,
    planID: fixture.planID,
    sessionID: fixture.initialSession.hello.sessionID,
    userID: 1,
    userPublicID: fixture.actors[0]!.userPublicID,
    authVersion: 1,
  };
  const accepted = parseSyncEnvelope(
    JSON.stringify(fixture.initialSession.acceptedEnvelope),
    attachment,
  );
  const payloadHash = await sha256Hex(bytes(accepted.payload));
  const receipt = {
    sessionID: accepted.sessionID,
    seq: accepted.seq,
    payloadHash,
  };
  assert.equal(
    classifySyncFrame(
      parseSyncEnvelope(
        JSON.stringify(fixture.transportReceipts.exactDuplicateEnvelope),
        attachment,
      ),
      payloadHash,
      3,
      receipt,
    ),
    "duplicate",
  );
  const violation = parseSyncEnvelope(
    JSON.stringify(fixture.transportReceipts.receiptViolationEnvelope),
    attachment,
  );
  await assert.rejects(
    async () =>
      classifySyncFrame(
        violation,
        await sha256Hex(bytes(violation.payload)),
        3,
        receipt,
      ),
    /frame_receipt_violation/,
  );
  const gap = parseSyncEnvelope(
    JSON.stringify(fixture.transportReceipts.sequenceGapEnvelope),
    attachment,
  );
  assert.throws(
    () => classifySyncFrame(gap, payloadHash, 3, null),
    /sync_sequence_violation/,
  );
});

test("live session and receipt authority is bounded and purged with its session", () => {
  assert.equal(
    hasPlanSessionCapacity(
      Array.from({ length: 4 }, () => ({ userID: 1 })),
      1,
    ),
    true,
  );
  assert.equal(
    hasPlanSessionCapacity(
      Array.from({ length: 5 }, () => ({ userID: 1 })),
      1,
    ),
    false,
  );
  assert.equal(
    hasPlanSessionCapacity(
      Array.from({ length: 100 }, (_, index) => ({ userID: index + 1 })),
      101,
    ),
    false,
  );
  const source = readFileSync("src/lib/server/plan-sync-object.ts", "utf8");
  assert.match(source, /maximumFrameReceiptsPerSession = 2_048/);
  assert.match(
    source,
    /DELETE FROM frame_receipts WHERE session_id = \?[^]*DELETE FROM sync_sessions WHERE session_id = \?/,
  );
  assert.match(source, /LIMIT -1 OFFSET \?/);
});

test("revocation generation rejects an offline old actor after reinstatement and admits a fresh replica", async () => {
  const fixture = syncFixture();
  const oldActor = fixture.actors[0]!;
  const attachment = {
    v: 1 as const,
    planID: fixture.planID,
    sessionID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    userID: 1,
    userPublicID: oldActor.userPublicID,
    authVersion: 1,
  };
  const snapshot = {
    membershipEpoch: 4,
    planNotificationEpoch: 1,
    members: [
      {
        userID: 1,
        userPublicID: oldActor.userPublicID,
        authVersion: 1,
        notificationEpoch: 3,
      },
    ],
  };
  const stored = [
    {
      actor_id: oldActor.actorID,
      user_id: 1,
      user_public_id: oldActor.userPublicID,
      replica_id: oldActor.replicaID,
      auth_version: 1,
      membership_epoch: 1,
    },
  ];
  assert.throws(
    () =>
      preparePlanActorAuthorities(
        attachment,
        oldActor.replicaID,
        oldActor.actorID,
        snapshot,
        stored,
      ),
    (error: unknown) => hasCode(error, "unregistered_plan_actor"),
  );

  const freshActorID = "cccccccccccccccccccccccccccccccc";
  const freshReplicaID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const prepared = preparePlanActorAuthorities(
    attachment,
    freshReplicaID,
    freshActorID,
    snapshot,
    stored,
  );
  assert.equal(prepared.actors.has(oldActor.actorID), false);
  assert.equal(prepared.actorBinding.membershipEpoch, 3);

  const base = loadDocument(fixture.initialSession.acceptedDocument);
  const offlineOldOperationID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
  const offlineOld = Automerge.change(
    Automerge.clone(base, { actor: oldActor.actorID }),
    { message: `operation:${offlineOldOperationID}` },
    (draft) =>
      applyPlanOperation(draft, offlineOldOperationID, {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: oldActor.userPublicID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "membership.window",
          value: "revoked",
        },
      }),
  );
  await assert.rejects(
    validatePlanMutation(base, offlineOld, {
      planID: fixture.planID,
      comiketNo: fixture.comiketNo,
      frameActorID: oldActor.actorID,
      frameUserPublicID: oldActor.userPublicID,
      actors: prepared.actors,
      activeMemberPublicIDs: new Set([oldActor.userPublicID]),
      membershipEpoch: snapshot.membershipEpoch,
    }),
    (error: unknown) => hasCode(error, "unregistered_plan_actor"),
  );

  const freshOperationID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
  const fresh = Automerge.change(
    Automerge.clone(base, { actor: freshActorID }),
    { message: `operation:${freshOperationID}` },
    (draft) =>
      applyPlanOperation(draft, freshOperationID, {
        type: "shared_plan.circle.communication.set.v1",
        actorUserID: oldActor.userPublicID,
        payload: {
          v: 1,
          wcID: 9001,
          key: "membership.window",
          value: "reinstated",
        },
      }),
  );
  const accepted = await validatePlanMutation(base, fresh, {
    planID: fixture.planID,
    comiketNo: fixture.comiketNo,
    frameActorID: freshActorID,
    frameUserPublicID: oldActor.userPublicID,
    actors: prepared.actors,
    activeMemberPublicIDs: new Set([oldActor.userPublicID]),
    membershipEpoch: snapshot.membershipEpoch,
  });
  assert.equal(accepted.operations[0]!.actorID, freshActorID);
});

test("a close queued during suspended frame work purges the completed session receipt", async () => {
  const queue = new SerializedOperationQueue();
  const rows = new Set<string>(["session"]);
  let resume!: () => void;
  const suspended = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const mutation = queue.run(async () => {
    await suspended;
    assert.equal(rows.has("session"), true);
    rows.add("receipt");
  });
  const close = queue.run(async () => {
    rows.delete("receipt");
    rows.delete("session");
  });
  await Promise.resolve();
  assert.deepEqual([...rows], ["session"]);
  resume();
  await Promise.all([mutation, close]);
  assert.deepEqual([...rows], []);
  const source = readFileSync("src/lib/server/plan-sync-object.ts", "utf8");
  const closeStart = source.indexOf("async webSocketClose");
  const closeEnd = source.indexOf("async webSocketError", closeStart);
  assert.match(source.slice(closeStart, closeEnd), /runSerialized/);
});

test("literal operation vectors cover and validate every writable v1 operation", async () => {
  const fixture = syncFixture();
  assert.deepEqual(
    fixture.operationExamples.map((operation) => operation.type),
    [
      "shared_plan.circle.presence.v1",
      "shared_plan.circle.memo.splice.v1",
      "shared_plan.need.create.v1",
      "shared_plan.need.wanted_quantity.v1",
      "shared_plan.need.buyer_allocation.v1",
      "shared_plan.need.fulfilled_quantity.v1",
      "shared_plan.circle.communication.set.v1",
      "shared_plan.need.delete.v1",
    ],
  );
  assert.equal(fixture.operationVectors.length, 8);
  assert.equal(
    fixture.operationVectors.length + fixture.parentResolutionVectors.length,
    10,
  );
  for (const vector of fixture.operationVectors) {
    const before = loadDocument(vector.beforeDocument);
    const decodedChange = Automerge.decodeChange(bytes(vector.change));
    const [after] = Automerge.applyChanges(Automerge.clone(before), [
      bytes(vector.change),
    ]);
    assert.deepEqual(sortedHeads(before), vector.beforeHeads);
    assert.deepEqual(sortedHeads(after), vector.afterHeads);
    assert.equal(
      base64(Automerge.save(after)),
      vector.afterDocument,
      vector.operationID,
    );
    assert.equal(decodedChange.actor, fixture.actors[0]!.actorID);
    assert.equal(decodedChange.message, `operation:${vector.operationID}`);
    const validated = await validatePlanMutation(before, after, {
      planID: fixture.planID,
      comiketNo: fixture.comiketNo,
      frameActorID: fixture.actors[0]!.actorID,
      frameUserPublicID: fixture.actors[0]!.userPublicID,
      actors: actorMap(fixture),
      activeMemberPublicIDs: new Set(
        fixture.actors.map((actor) => actor.userPublicID),
      ),
      membershipEpoch: 3,
    });
    assert.equal(validated.operations.length, 1);
    assert.equal(validated.operations[0]!.operationID, vector.operationID);
    assert.equal(validated.operations[0]!.operationType, vector.operation.type);
  }
  assert.deepEqual(
    fixture.parentResolutionVectors.map((vector) => vector.operation.type),
    [
      "shared_plan.circle.resolve_parent.v1",
      "shared_plan.need.resolve_parent.v1",
    ],
  );
  for (const vector of fixture.parentResolutionVectors) {
    const before = loadDocument(vector.beforeDocument);
    assert.equal(
      Automerge.decodeChange(bytes(vector.change)).message,
      `operation:${vector.operationID}`,
    );
    const [after] = Automerge.applyChanges(Automerge.clone(before), [
      bytes(vector.change),
    ]);
    assert.deepEqual(await detectPlanConflicts(before), vector.beforeConflicts);
    assert.deepEqual(await detectPlanConflicts(after), vector.afterConflicts);
    assert.equal(vector.beforeConflicts.length, 1);
    assert.equal(vector.afterConflicts.length, 0);
    assert.equal(base64(Automerge.save(after)), vector.afterDocument);
    const validated = await validatePlanMutation(before, after, {
      planID: fixture.planID,
      comiketNo: fixture.comiketNo,
      frameActorID: fixture.actors[0]!.actorID,
      frameUserPublicID: fixture.actors[0]!.userPublicID,
      actors: actorMap(fixture),
      activeMemberPublicIDs: new Set(
        fixture.actors.map((actor) => actor.userPublicID),
      ),
      membershipEpoch: 5,
    });
    assert.equal(validated.operations[0]!.operationID, vector.operationID);
  }
  assert.deepEqual(
    fixture.nestedParentResolutionVectors.map((vector) => vector.scenario),
    [
      "nested-scalar",
      "nested-scalar",
      "three-root-object",
      "selected-parent-precedence",
    ],
  );
  for (const vector of fixture.nestedParentResolutionVectors) {
    assert.ok(vector.operation.payload.nestedResolutions.length > 0);
    const before = loadDocument(vector.beforeDocument);
    assert.equal(
      Automerge.decodeChange(bytes(vector.change)).message,
      `operation:${vector.operationID}`,
    );
    const [after] = Automerge.applyChanges(Automerge.clone(before), [
      bytes(vector.change),
    ]);
    assert.deepEqual(await detectPlanConflicts(before), vector.beforeConflicts);
    assert.deepEqual(await detectPlanConflicts(after), vector.afterConflicts);
    assert.equal(vector.afterConflicts.length, 0);
    assert.equal(base64(Automerge.save(after)), vector.afterDocument);
    const validated = await validatePlanMutation(before, after, {
      planID: fixture.planID,
      comiketNo: fixture.comiketNo,
      frameActorID: fixture.actors[0]!.actorID,
      frameUserPublicID: fixture.actors[0]!.userPublicID,
      actors: actorMap(fixture),
      activeMemberPublicIDs: new Set(
        fixture.actors.map((actor) => actor.userPublicID),
      ),
      membershipEpoch: 5,
    });
    assert.equal(validated.operations[0]!.operationID, vector.operationID);
  }

  const precedence = fixture.nestedParentResolutionVectors.find(
    (vector) => vector.scenario === "selected-parent-precedence",
  );
  assert.ok(precedence);
  const choice = precedence.operation.payload.nestedResolutions[0];
  assert.ok(choice);
  const competingNestedConflict = precedence.beforeConflicts.find(
    (conflict) => conflict.conflictID === choice.conflictID,
  );
  assert.ok(competingNestedConflict);
  assert.equal(competingNestedConflict.changeHashes.length, 2);
  assert.equal(
    competingNestedConflict.changeHashes.includes(choice.selectedChangeHash),
    false,
  );
  assert.equal(choice.value, "選択した親A");
});

test("literal semantic conflict vectors cover every deletion-descendant fork", async () => {
  const fixture = syncFixture();
  assert.equal(fixture.semanticConflictVectors.length, 10);
  for (const vector of fixture.semanticConflictVectors) {
    const base = loadDocument(vector.baseDocument);
    const removalChange = bytes(vector.removalChange);
    const descendantChange = bytes(vector.descendantChange);
    const [removed] = Automerge.applyChanges(Automerge.clone(base), [
      removalChange,
    ]);
    const removalActor = Automerge.decodeChange(removalChange).actor;
    const acceptedRemoval = await validatePlanMutation(base, removed, {
      planID: fixture.planID,
      comiketNo: fixture.comiketNo,
      frameActorID: removalActor,
      frameUserPublicID: fixture.actors[0]!.userPublicID,
      actors: actorMap(fixture),
      activeMemberPublicIDs: new Set(
        fixture.actors.map((actor) => actor.userPublicID),
      ),
      membershipEpoch: 4,
    });
    const [merged] = Automerge.applyChanges(
      Automerge.clone(acceptedRemoval.document),
      [descendantChange],
    );
    const descendantActor = Automerge.decodeChange(descendantChange).actor;
    const accepted = await validatePlanMutation(
      acceptedRemoval.document,
      merged,
      {
        planID: fixture.planID,
        comiketNo: fixture.comiketNo,
        frameActorID: descendantActor,
        frameUserPublicID: fixture.actors[1]!.userPublicID,
        actors: actorMap(fixture),
        activeMemberPublicIDs: new Set(
          fixture.actors.map((actor) => actor.userPublicID),
        ),
        membershipEpoch: 4,
      },
    );
    assert.deepEqual(accepted.conflicts, vector.conflicts);
    assert.deepEqual(
      await detectPlanConflicts(accepted.document),
      vector.conflicts,
    );
    assert.equal(
      base64(Automerge.save(accepted.document)),
      vector.mergedDocument,
    );
  }
});

test("restart uses fresh sync state and concurrent Japanese, combining-mark, and emoji Text converges", async () => {
  const fixture = syncFixture();
  const restarted = replayDialogue(
    loadDocument(fixture.restart.serverDocument),
    loadDocument(fixture.restart.clientDocument, fixture.actors[0]!.actorID),
    fixture.restart.clientToServerPayloads,
    fixture.restart.serverToClientPayloads,
  );
  assert.deepEqual(sortedHeads(restarted.left), fixture.restart.convergedHeads);
  assert.deepEqual(
    sortedHeads(restarted.right),
    fixture.restart.convergedHeads,
  );

  const concurrent = replayDialogue(
    loadDocument(
      fixture.offlineConcurrentText.clientADocument,
      fixture.actors[0]!.actorID,
    ),
    loadDocument(
      fixture.offlineConcurrentText.clientBDocument,
      fixture.actors[1]!.actorID,
    ),
    fixture.offlineConcurrentText.clientAToBPayloads,
    fixture.offlineConcurrentText.clientBToAPayloads,
  );
  assert.deepEqual(
    sortedHeads(concurrent.left),
    fixture.offlineConcurrentText.convergedHeads,
  );
  assert.deepEqual(
    sortedHeads(concurrent.right),
    fixture.offlineConcurrentText.convergedHeads,
  );
  assert.equal(
    concurrent.left.circles["9001"]?.memo,
    fixture.offlineConcurrentText.convergedMemo,
  );
  assert.match(fixture.offlineConcurrentText.convergedMemo, /日本語/);
  assert.match(fixture.offlineConcurrentText.convergedMemo, /e\u0301/);
  assert.match(fixture.offlineConcurrentText.convergedMemo, /👩‍👩‍👧‍👦/);
  const clientAValidated = await validatePlanMutation(
    loadDocument(fixture.offlineConcurrentText.baseDocument),
    loadDocument(
      fixture.offlineConcurrentText.clientADocument,
      fixture.actors[0]!.actorID,
    ),
    {
      planID: fixture.planID,
      comiketNo: fixture.comiketNo,
      frameActorID: fixture.actors[0]!.actorID,
      frameUserPublicID: fixture.actors[0]!.userPublicID,
      actors: actorMap(fixture),
      activeMemberPublicIDs: new Set(
        fixture.actors.map((actor) => actor.userPublicID),
      ),
      membershipEpoch: 2,
    },
  );
  const clientBValidated = await validatePlanMutation(
    loadDocument(fixture.offlineConcurrentText.baseDocument),
    loadDocument(
      fixture.offlineConcurrentText.clientBDocument,
      fixture.actors[1]!.actorID,
    ),
    {
      planID: fixture.planID,
      comiketNo: fixture.comiketNo,
      frameActorID: fixture.actors[1]!.actorID,
      frameUserPublicID: fixture.actors[1]!.userPublicID,
      actors: actorMap(fixture),
      activeMemberPublicIDs: new Set(
        fixture.actors.map((actor) => actor.userPublicID),
      ),
      membershipEpoch: 2,
    },
  );
  assert.deepEqual(
    [...clientAValidated.operations, ...clientBValidated.operations]
      .map((operation) => operation.operationID)
      .sort(),
    fixture.offlineConcurrentText.operationIDs.slice().sort(),
  );
});

test("the live socket queues hello behind the HTTP 101 response", () => {
  const source = readFileSync("src/lib/server/plan-sync-object.ts", "utf8");
  const hello = source.indexOf('type: "hello"');
  const deferredSend = source.indexOf(
    "this.ctx.waitUntil(this.sendIfAuthorized(server, attachment, hello))",
    hello,
  );
  const upgradeResponse = source.indexOf(
    "return new Response(null, { status: 101, webSocket: client })",
    deferredSend,
  );
  assert.ok(hello > 0 && deferredSend > hello && upgradeResponse > deferredSend);
  assert.equal(
    source.includes("await this.sendIfAuthorized(server, attachment, hello)"),
    false,
  );
});

test("the production writable DO path commits every authority record atomically", () => {
  const source = readFileSync("src/lib/server/plan-sync-object.ts", "utf8");
  assert.equal(source.includes("semantic_validation_unavailable"), false);
  const commitStart = source.indexOf("const committedDocument =");
  const transactionStart = source.indexOf(
    "this.ctx.storage.transactionSync(() => {",
    commitStart,
  );
  const acknowledgementSend = source.indexOf(
    "const acknowledged = await this.sendIfAuthorized(",
    transactionStart,
  );
  assert.ok(commitStart > 0 && transactionStart > commitStart);
  assert.ok(acknowledgementSend > transactionStart);
  const transaction = source.slice(transactionStart, acknowledgementSend);
  for (const authority of [
    "plan_document",
    "actor_registry",
    "operation_ledger_batches_v2",
    "conflict_ledger_batches_v2",
    "local_notification_audiences_v2",
    "local_notification_event_batches_v3",
    "sync_sessions",
    "frame_receipts",
  ]) {
    assert.ok(transaction.includes(authority), authority);
  }
  assert.equal(
    transaction.match(/canonicalJSON\(outbox\.recipients\)/g)?.length,
    1,
  );
  assert.equal(transaction.includes("local_notification_recipients ("), false);
  assert.equal(transaction.includes("INSERT INTO operation_ledger ("), false);
  assert.match(
    readFileSync("wrangler.jsonc", "utf8"),
    /"COMINAVI_SHARED_PLAN_MUTATIONS_ENABLED": "true"/,
  );
});

interface SyncFixture {
  producer: { package: string; version: string; runtime: string };
  swiftInterop: {
    targetPackage: string;
    targetVersion: string;
    status: string;
    requiredBeforeMutationEnablement: boolean;
  };
  limits: {
    retainedOperationPayloadUTF8Bytes: number;
    retainedOperationPayloadCanonicalForm: string;
    compactionError: string;
    maximumOperations: number;
    maximumNewOperationsPerSyncFrame: number;
    backlogError: string;
  };
  planID: string;
  comiketNo: number;
  actors: Array<{
    actorID: string;
    replicaID: string;
    userPublicID: string;
  }>;
  operationExamples: Array<{ operationID: string; type: string }>;
  operationVectors: Array<{
    operationID: string;
    operation: { type: string };
    beforeDocument: string;
    beforeHeads: string[];
    change: string;
    afterDocument: string;
    afterHeads: string[];
  }>;
  parentResolutionVectors: Array<{
    kind: "circle" | "need";
    operationID: string;
    operation: { type: string };
    beforeDocument: string;
    beforeHeads: string[];
    beforeConflicts: Array<{
      conflictID: string;
      path: Array<string | number>;
      changeHashes: string[];
    }>;
    change: string;
    afterDocument: string;
    afterHeads: string[];
    afterConflicts: Array<{
      conflictID: string;
      path: Array<string | number>;
      changeHashes: string[];
    }>;
  }>;
  nestedParentResolutionVectors: Array<{
    scenario: string;
    kind: "circle" | "need";
    operationID: string;
    operation: {
      type: string;
      payload: {
        nestedResolutions: Array<{
          conflictID: string;
          path: string[];
          selectedChangeHash: string;
          value: unknown;
        }>;
      };
    };
    beforeDocument: string;
    beforeHeads: string[];
    beforeConflicts: Array<{
      conflictID: string;
      path: Array<string | number>;
      changeHashes: string[];
    }>;
    change: string;
    afterDocument: string;
    afterHeads: string[];
    afterConflicts: Array<{
      conflictID: string;
      path: Array<string | number>;
      changeHashes: string[];
    }>;
  }>;
  semanticConflictVectors: Array<{
    kind: string;
    descendantOperationType: string;
    baseDocument: string;
    removalChange: string;
    descendantChange: string;
    mergedDocument: string;
    mergedHeads: string[];
    conflicts: Array<{
      conflictID: string;
      path: Array<string | number>;
      changeHashes: string[];
    }>;
  }>;
  backlogLimitVectors: {
    baseDocument: string;
    vectors: Array<{
      changeCount: number;
      clientDocument: string;
      clientHavePayload: string;
      serverNeedPayload: string;
      clientChangesPayload: string;
      clientChangesPayloadBytes: number;
      expected:
        | { status: "accepted" }
        | {
            status: "rejected";
            closeCode: number;
            error: {
              v: number;
              type: string;
              code: string;
              message: string;
              retryable: boolean;
              details: {
                maximumNewOperationsPerSyncFrame: number;
                receivedChanges: number;
              };
            };
          };
    }>;
  };
  bootstrap: { document: string; heads: string[] };
  initialSession: {
    hello: { sessionID: string };
    clientNegotiationEnvelope: Record<string, unknown> & { payload: string };
    serverNeedEnvelope: Record<string, unknown> & { payload: string };
    acceptedEnvelope: Record<string, unknown> & { payload: string };
    serverResponseEnvelope: Record<string, unknown> & { payload: string };
    ack: { documentHeads: string[] };
    acceptedDocument: string;
    acceptedHeads: string[];
  };
  transportReceipts: {
    exactDuplicateEnvelope: Record<string, unknown>;
    receiptViolationEnvelope: Record<string, unknown>;
    sequenceGapEnvelope: Record<string, unknown>;
  };
  restart: {
    serverDocument: string;
    clientDocument: string;
    clientToServerPayloads: string[];
    serverToClientPayloads: string[];
    convergedHeads: string[];
  };
  offlineConcurrentText: {
    baseDocument: string;
    clientADocument: string;
    clientBDocument: string;
    clientAToBPayloads: string[];
    clientBToAPayloads: string[];
    convergedHeads: string[];
    convergedMemo: string;
    operationIDs: string[];
  };
}

function syncFixture(): SyncFixture {
  return JSON.parse(
    readFileSync("tests/fixtures/automerge-sync-v1.json", "utf8"),
  ) as SyncFixture;
}

function loadDocument(
  encoded: string,
  actor?: string,
): Automerge.Doc<PlanDocument> {
  return Automerge.load<PlanDocument>(bytes(encoded), actor ? { actor } : {});
}

function replayDialogue(
  initialLeft: Automerge.Doc<PlanDocument>,
  initialRight: Automerge.Doc<PlanDocument>,
  leftMessages: string[],
  rightMessages: string[],
): {
  left: Automerge.Doc<PlanDocument>;
  right: Automerge.Doc<PlanDocument>;
} {
  let left = initialLeft;
  let right = initialRight;
  let leftState = Automerge.initSyncState();
  let rightState = Automerge.initSyncState();
  const rounds = Math.max(leftMessages.length, rightMessages.length);
  for (let index = 0; index < rounds; index += 1) {
    const leftMessage = leftMessages[index];
    if (leftMessage) {
      [right, rightState] = Automerge.receiveSyncMessage(
        Automerge.clone(right),
        rightState,
        bytes(leftMessage),
      );
    }
    const rightMessage = rightMessages[index];
    if (rightMessage) {
      [left, leftState] = Automerge.receiveSyncMessage(
        Automerge.clone(left),
        leftState,
        bytes(rightMessage),
      );
    }
  }
  return { left, right };
}

function settleDocuments(
  initialLeft: Automerge.Doc<PlanDocument>,
  initialRight: Automerge.Doc<PlanDocument>,
) {
  let left = initialLeft;
  let right = initialRight;
  let leftState = Automerge.initSyncState();
  let rightState = Automerge.initSyncState();
  for (let round = 0; round < 20; round += 1) {
    let sent = false;
    let message: Uint8Array | null;
    [leftState, message] = Automerge.generateSyncMessage(left, leftState);
    if (message) {
      sent = true;
      [right, rightState] = Automerge.receiveSyncMessage(
        Automerge.clone(right),
        rightState,
        message,
      );
    }
    [rightState, message] = Automerge.generateSyncMessage(right, rightState);
    if (message) {
      sent = true;
      [left, leftState] = Automerge.receiveSyncMessage(
        Automerge.clone(left),
        leftState,
        message,
      );
    }
    if (!sent) break;
  }
  return { left, right, leftState, rightState };
}

function actorMap(fixture: SyncFixture) {
  return new Map(
    fixture.actors.map((actor, index) => [
      actor.actorID,
      {
        actorID: actor.actorID,
        userID: index + 1,
        userPublicID: actor.userPublicID,
        replicaID: actor.replicaID,
        authVersion: 1,
        membershipEpoch: 1,
      },
    ]),
  );
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

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
