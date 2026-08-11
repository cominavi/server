import * as Automerge from "@automerge/automerge";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256Hex } from "../src/lib/server/auth-sessions";
import {
  canonicalJSON,
  type PlanDocument,
  type PlanOperation,
  validatePlanMutation,
} from "../src/lib/server/plan-document";
import {
  classifySyncFrame,
  parseSyncEnvelope,
} from "../src/lib/server/sync-protocol";

const fixturePath = "tests/fixtures/automerge-swift-authored-v1.json";
const sourceFixturePath = "tests/fixtures/automerge-sync-v1.json";
const fixtureSHA256 =
  "3637744f756aa9594771ff282705591b7b8401b1c55ec186b6e5551b75ed94d7";
const primaryUserPublicID = "11111111111111111111111111111111";

test("all literal Swift-authored changes pass strict JS topology validation", async () => {
  const fixture = swiftFixture();
  assert.equal(digest(readFileSync(fixturePath, "utf8")), fixtureSHA256);
  assert.equal(
    fixture.sourceFixtureSHA256,
    digest(readFileSync(sourceFixturePath, "utf8")),
  );
  assert.deepEqual(fixture.producer, {
    package: "automerge-swift",
    runtime: "Swift",
    version: "0.7.2",
  });
  assert.equal(fixture.operationVectors.length, 8);
  assert.equal(fixture.resolverVectors.length, 4);

  for (const vector of [
    ...fixture.operationVectors,
    ...fixture.resolverVectors,
  ]) {
    const before = loadDocument(vector.beforeDocument);
    assert.deepEqual(sortedHeads(before), vector.beforeHeads);
    const changeBytes = bytes(vector.change);
    const decoded = Automerge.decodeChange(changeBytes);
    assert.equal(decoded.actor, vector.changeActorID);
    assert.equal(decoded.hash, vector.changeHash);
    assert.equal(decoded.message, vector.changeMessage);
    assert.equal(decoded.message, `operation:${vector.operationID}`);
    assert.equal(decoded.time, vector.changeTimestampUnixSeconds);
    const [after] = Automerge.applyChanges(Automerge.clone(before), [
      changeBytes,
    ]);
    assert.equal(base64(Automerge.save(after)), vector.afterDocument);
    assert.deepEqual(sortedHeads(after), vector.afterHeads);

    const validated = await validatePlanMutation(
      before,
      after,
      validationContext(fixture),
    );
    assert.equal(validated.operations.length, 1, vector.operationID);
    assert.equal(validated.operations[0]!.operationID, vector.operationID);
    assert.equal(validated.operations[0]!.actorID, vector.changeActorID);
    assert.equal(
      canonicalJSON({
        type: validated.operations[0]!.operationType,
        actorUserID: validated.operations[0]!.actorUserID,
        payload: validated.operations[0]!.payload,
      }),
      canonicalJSON(vector.operation),
      vector.operationID,
    );
  }
});

test("JS consumes the literal Swift sync dialogue and returns its frozen response", async () => {
  const fixture = swiftFixture();
  const dialogue = fixture.javascriptSync;
  assert.equal(dialogue.status, "complete");
  assert.equal(
    dialogue.clientToServerPayloads.length,
    dialogue.responsePayloads.length,
  );
  let server = loadDocument(dialogue.beforeDocument);
  let client = loadDocument(dialogue.clientDocument, fixture.actorID);
  let serverState = Automerge.initSyncState();
  let clientState = Automerge.initSyncState();
  let acceptedOperations = 0;

  for (
    let index = 0;
    index < dialogue.clientToServerPayloads.length;
    index += 1
  ) {
    let message: Uint8Array | null;
    [clientState, message] = Automerge.generateSyncMessage(client, clientState);
    assert.ok(message);
    const swiftMessage = bytes(dialogue.clientToServerPayloads[index]!);
    const before = server;
    [server, serverState] = Automerge.receiveSyncMessage(
      Automerge.clone(server),
      serverState,
      swiftMessage,
    );
    if (Automerge.getChanges(before, server).length > 0) {
      const validated = await validatePlanMutation(
        before,
        server,
        validationContext(fixture),
      );
      acceptedOperations += validated.operations.length;
    }
    [serverState, message] = Automerge.generateSyncMessage(server, serverState);
    assert.equal(base64(message!), dialogue.responsePayloads[index]);
    [client, clientState] = Automerge.receiveSyncMessage(
      Automerge.clone(client, { actor: fixture.actorID }),
      clientState,
      message!,
    );
  }

  assert.equal(acceptedOperations, 8);
  assert.deepEqual(sortedHeads(server), dialogue.convergedHeads);
  assert.deepEqual(sortedHeads(client), dialogue.convergedHeads);
  assert.equal(base64(Automerge.save(server)), dialogue.serverDocument);
  assert.equal(base64(Automerge.save(client)), dialogue.convergedDocument);
});

test("JS replays the Swift transport, receipt, Unicode, and restart literals", async () => {
  const fixture = swiftFixture();
  const sync = fixture.swiftSync;
  const replayed = replayLiteralSync(
    loadDocument(sync.clientBeforeDocument, fixture.actorID),
    loadDocument(sync.serverBeforeDocument),
    sync.clientToServerPayloads,
    sync.serverToClientPayloads,
  );
  assert.deepEqual(sortedHeads(replayed.client), sync.convergedHeads);
  assert.deepEqual(sortedHeads(replayed.server), sync.convergedHeads);
  assert.equal(
    base64(Automerge.save(replayed.client)),
    sync.clientAfterDocument,
  );
  assert.equal(
    base64(Automerge.save(replayed.server)),
    sync.serverAfterDocument,
  );

  const memoDocument = loadDocument(fixture.javascriptSync.convergedDocument);
  const memoCircle = Object.values(memoDocument.circles).find(
    (circle) => circle.memo === fixture.unicode.memo,
  );
  assert.ok(memoCircle);
  assert.equal(
    Array.from(fixture.unicode.memo).length,
    fixture.unicode.unicodeScalarCount,
  );
  assert.equal(
    Buffer.byteLength(fixture.unicode.memo),
    fixture.unicode.utf8ByteCount,
  );

  const transport = fixture.transportReceipts;
  const attachment = {
    v: 1 as const,
    planID: fixture.planID,
    sessionID: transport.acceptedEnvelope.sessionID,
    userID: 1,
    userPublicID: primaryUserPublicID,
    authVersion: 1,
  };
  const accepted = parseSyncEnvelope(
    JSON.stringify(transport.acceptedEnvelope),
    attachment,
  );
  const payloadHash = await sha256Hex(bytes(accepted.payload));
  assert.equal(classifySyncFrame(accepted, payloadHash, 2, null), "new");
  const receipt = {
    sessionID: accepted.sessionID,
    seq: accepted.seq,
    payloadHash,
  };
  assert.equal(
    classifySyncFrame(
      parseSyncEnvelope(
        JSON.stringify(transport.exactDuplicateEnvelope),
        attachment,
      ),
      payloadHash,
      3,
      receipt,
    ),
    "duplicate",
  );
  const violation = parseSyncEnvelope(
    JSON.stringify(transport.receiptViolationEnvelope),
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
    JSON.stringify(transport.sequenceGapEnvelope),
    attachment,
  );
  assert.throws(
    () => classifySyncFrame(gap, payloadHash, 3, null),
    /sync_sequence_violation/,
  );
  assert.deepEqual(
    transport.acknowledgement.documentHeads,
    sync.convergedHeads,
  );
  assert.deepEqual(transport.restart, {
    discardsPriorFrameID: transport.acceptedEnvelope.frameID,
    newSessionID: "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
    requiresFreshFrameID: true,
    requiresFreshSyncState: true,
  });
});

function replayLiteralSync(
  initialClient: Automerge.Doc<PlanDocument>,
  initialServer: Automerge.Doc<PlanDocument>,
  clientMessages: string[],
  serverMessages: string[],
): {
  client: Automerge.Doc<PlanDocument>;
  server: Automerge.Doc<PlanDocument>;
} {
  let client = initialClient;
  let server = initialServer;
  let clientState = Automerge.initSyncState();
  let serverState = Automerge.initSyncState();
  assert.ok(serverMessages.length <= clientMessages.length);
  for (let index = 0; index < clientMessages.length; index += 1) {
    let generated: Uint8Array | null;
    [clientState, generated] = Automerge.generateSyncMessage(
      client,
      clientState,
    );
    assert.ok(generated);
    [server, serverState] = Automerge.receiveSyncMessage(
      Automerge.clone(server),
      serverState,
      bytes(clientMessages[index]!),
    );
    [serverState, generated] = Automerge.generateSyncMessage(
      server,
      serverState,
    );
    const serverMessage = serverMessages[index];
    if (serverMessage !== undefined) {
      assert.ok(generated);
      [client, clientState] = Automerge.receiveSyncMessage(
        Automerge.clone(client, { actor: fixtureActor(client) }),
        clientState,
        bytes(serverMessage),
      );
    } else {
      assert.equal(index, clientMessages.length - 1);
      assert.deepEqual(sortedHeads(client), sortedHeads(server));
    }
  }
  return { client, server };
}

function fixtureActor(document: Automerge.Doc<unknown>): string {
  return Automerge.getActorId(document);
}

function validationContext(fixture: SwiftAuthoredFixture) {
  return {
    planID: fixture.planID,
    comiketNo: fixture.comiketNo,
    frameActorID: fixture.actorID,
    frameUserPublicID: primaryUserPublicID,
    actors: new Map([
      [
        fixture.actorID,
        {
          actorID: fixture.actorID,
          userID: 1,
          userPublicID: primaryUserPublicID,
          replicaID: fixture.replicaID,
          authVersion: 1,
          membershipEpoch: 1,
        },
      ],
    ]),
    activeMemberPublicIDs: new Set([
      primaryUserPublicID,
      "22222222222222222222222222222222",
      "33333333333333333333333333333333",
    ]),
    membershipEpoch: 1,
  };
}

function swiftFixture(): SwiftAuthoredFixture {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as SwiftAuthoredFixture;
}

function loadDocument(
  value: string,
  actor?: string,
): Automerge.Doc<PlanDocument> {
  return Automerge.load<PlanDocument>(bytes(value), actor ? { actor } : {});
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

interface SwiftAuthoredFixture {
  fixtureVersion: 1;
  producer: { package: string; runtime: string; version: string };
  sourceFixtureSHA256: string;
  planID: string;
  comiketNo: number;
  replicaID: string;
  actorID: string;
  operationVectors: SwiftChangeVector[];
  resolverVectors: Array<
    SwiftChangeVector & { kind: string; scenario: string }
  >;
  unicode: {
    memo: string;
    memoOperationID: string;
    unicodeScalarCount: number;
    utf8ByteCount: number;
  };
  swiftSync: SyncDialogue & {
    clientBeforeDocument: string;
    serverBeforeDocument: string;
    clientAfterDocument: string;
    serverAfterDocument: string;
    serverToClientPayloads: string[];
  };
  javascriptSync: {
    beforeDocument: string;
    clientDocument: string;
    clientToServerPayloads: string[];
    responsePayloads: string[];
    status: string;
    convergedDocument: string;
    serverDocument: string;
    convergedHeads: string[];
  };
  transportReceipts: {
    acceptedEnvelope: SyncEnvelope;
    exactDuplicateEnvelope: SyncEnvelope;
    receiptViolationEnvelope: SyncEnvelope;
    sequenceGapEnvelope: SyncEnvelope;
    acknowledgement: { documentHeads: string[] };
    restart: {
      discardsPriorFrameID: string;
      newSessionID: string;
      requiresFreshFrameID: boolean;
      requiresFreshSyncState: boolean;
    };
  };
}

interface SwiftChangeVector {
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
}

interface SyncDialogue {
  clientToServerPayloads: string[];
  convergedHeads: string[];
}

interface SyncEnvelope {
  v: number;
  type: string;
  planID: string;
  sessionID: string;
  replicaID: string;
  actorID: string;
  seq: number;
  frameID: string;
  payload: string;
}
