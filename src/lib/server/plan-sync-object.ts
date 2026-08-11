import * as Automerge from "@automerge/automerge";
import { DurableObject } from "cloudflare:workers";
import { base64URL, decodeBase64URL, sha256Hex } from "./auth-sessions";
import {
  classifySyncFrame,
  hasPlanSessionCapacity,
  isCanonicalSyncUUID,
  parseSyncEnvelope,
  planSyncErrorEnvelope,
  type SocketAttachment,
} from "./sync-protocol";
import {
  hasPlanSyncAuthority,
  loadPlanSyncAuthoritySnapshot,
  type PlanSyncAuthoritySnapshot,
} from "./plan-sync-authority";
import { sendPlanSyncFrameIfAuthorized } from "./plan-sync-send-gate";
import {
  advancePlanPeerSessions,
  type PlanPeerSessionInput,
} from "./plan-sync-peer";
import { SerializedOperationQueue } from "./serialized-operation-queue";
import {
  canonicalJSON,
  operationEventPayload,
  operationI18nKey,
  PlanDocumentError,
  validatePlanMutation,
  type PlanActorAuthority,
  type PlanDocument,
  type ValidatedPlanMutation,
} from "./plan-document";
import {
  fanoutSharedPlanOutboxEvent,
  maximumNotificationAudienceMembers,
  maximumNotificationFanoutPairsPerDrain,
  notificationOutboxFitsBounds,
  type SharedPlanOutboxEvent,
  type SharedPlanOutboxRecipient,
} from "./plan-notifications";
import {
  preparePlanActorAuthorities,
  type StoredPlanActor,
} from "./plan-actor-authority";
import { compactSerializedJSONValues } from "./compact-json-batches";

interface SessionRow {
  [key: string]: SqlStorageValue;
  sync_state: ArrayBuffer;
  next_client_seq: number;
  next_server_seq: number;
  replica_id: string | null;
  actor_id: string | null;
}

interface ActorRegistryRow extends StoredPlanActor {
  [key: string]: SqlStorageValue;
  actor_id: string;
  user_id: number;
  user_public_id: string;
  replica_id: string;
  auth_version: number;
  membership_epoch: number;
}

interface LocalOutboxRow {
  [key: string]: SqlStorageValue;
  audience_id: string;
  chunk_index: number;
  events_json: string;
  event_count: number;
  event_cursor: number;
  recipient_cursor: number;
  recipients_json: string;
  recipient_count: number;
}

interface PreparedNotificationOutbox {
  audienceID: string;
  recipients: SharedPlanOutboxRecipient[];
  events: SharedPlanOutboxEvent[];
}

const maximumSyncPayloadBytes = 1024 * 1024;
const maximumSavedDocumentBytes = 1_500_000;
const maximumFrameReceiptsPerSession = 2_048;

export class PlanSyncObject extends DurableObject<Cloudflare.Env> {
  private readonly operations = new SerializedOperationQueue();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS plan_document (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        plan_id TEXT NOT NULL,
        comiket_no INTEGER NOT NULL,
        bytes BLOB NOT NULL
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sync_sessions (
        session_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        user_public_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        auth_version INTEGER NOT NULL,
        replica_id TEXT,
        actor_id TEXT,
        sync_state BLOB NOT NULL,
        next_client_seq INTEGER NOT NULL,
        next_server_seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS frame_receipts (
        user_id INTEGER NOT NULL,
        replica_id TEXT NOT NULL,
        frame_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        ack_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, replica_id, frame_id)
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS actor_registry (
        actor_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        user_public_id TEXT NOT NULL,
        replica_id TEXT NOT NULL,
        auth_version INTEGER NOT NULL,
        membership_epoch INTEGER NOT NULL,
        registered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (plan_id, user_id, replica_id)
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS operation_ledger (
        operation_id TEXT PRIMARY KEY,
        change_hash TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        committed_heads_json TEXT NOT NULL,
        membership_epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS conflict_ledger (
        conflict_id TEXT PRIMARY KEY,
        path_json TEXT NOT NULL,
        change_hashes_json TEXT NOT NULL,
        committed_heads_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      ctx.storage.sql
        .exec(`CREATE TABLE IF NOT EXISTS operation_ledger_batches_v2 (
        frame_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        entries_json TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (frame_id, chunk_index)
      )`);
      ctx.storage.sql
        .exec(`CREATE TABLE IF NOT EXISTS conflict_ledger_batches_v2 (
        frame_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        entries_json TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (frame_id, chunk_index)
      )`);
      ctx.storage.sql
        .exec(`CREATE TABLE IF NOT EXISTS local_notification_events (
        event_id TEXT PRIMARY KEY,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      ctx.storage.sql
        .exec(`CREATE TABLE IF NOT EXISTS local_notification_recipients (
        event_id TEXT NOT NULL,
        recipient_user_id INTEGER NOT NULL,
        membership_notification_epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (event_id, recipient_user_id)
      )`);
      ctx.storage.sql
        .exec(`CREATE TABLE IF NOT EXISTS local_notification_audiences_v2 (
        audience_id TEXT PRIMARY KEY,
        recipients_json TEXT NOT NULL,
        recipient_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      ctx.storage.sql
        .exec(`CREATE TABLE IF NOT EXISTS local_notification_events_v2 (
        event_id TEXT PRIMARY KEY,
        audience_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        recipient_cursor INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`);
      ctx.storage.sql
        .exec(`CREATE TABLE IF NOT EXISTS local_notification_event_batches_v3 (
        audience_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        events_json TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        event_cursor INTEGER NOT NULL DEFAULT 0,
        recipient_cursor INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (audience_id, chunk_index)
      )`);
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.runSerialized(async () => {
      const url = new URL(request.url);
      if (url.pathname === "/fence" && request.method === "POST") {
        await this.fenceSockets();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/fence-member" && request.method === "POST") {
        const publicID = request.headers.get("X-ComiNavi-User-Public-ID");
        for (const socket of this.ctx.getWebSockets()) {
          const attachment = attachmentFor(socket);
          if (
            attachment?.userPublicID === publicID &&
            !(await this.hasAuthority(attachment, true))
          ) {
            socket.close(4403, "membership_revoked");
          }
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/purge" && request.method === "POST") {
        for (const socket of this.ctx.getWebSockets()) {
          socket.close(4404, "plan_deleted");
        }
        await this.ctx.storage.deleteAll();
        return new Response(null, { status: 204 });
      }

      const authority = parseAuthorityHeaders(request);
      if (!(await this.hasAuthority(authority, false))) {
        return Response.json({ error: "plan_not_found" }, { status: 404 });
      }
      const document = this.loadOrCreateDocument(
        authority.planID,
        authority.comiketNo,
      );
      if (url.pathname === "/snapshot") {
        return Response.json({
          v: 1,
          document: base64URL(Automerge.save(document)),
          heads: Automerge.getHeads(document),
        });
      }
      if (
        url.pathname !== "/connect" ||
        request.headers.get("Upgrade") !== "websocket"
      ) {
        return new Response("Not found", { status: 404 });
      }

      this.cleanupStaleSessions();
      const activeAttachments = this.ctx
        .getWebSockets()
        .map(attachmentFor)
        .filter(
          (attachment): attachment is SocketAttachment =>
            attachment !== null && attachment.planID === authority.planID,
        );
      if (!hasPlanSessionCapacity(activeAttachments, authority.userID)) {
        return Response.json({ error: "session_limit" }, { status: 409 });
      }

      const sessionID = crypto.randomUUID();
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const attachment: SocketAttachment = {
        v: 1,
        sessionID,
        userID: authority.userID,
        userPublicID: authority.userPublicID,
        planID: authority.planID,
        authVersion: authority.authVersion,
      };
      server.serializeAttachment(attachment);
      this.ctx.acceptWebSocket(server);
      const syncState = Automerge.encodeSyncState(Automerge.initSyncState());
      this.ctx.storage.sql.exec(
        `INSERT INTO sync_sessions (
           session_id, user_id, user_public_id, plan_id, auth_version,
           replica_id, actor_id, sync_state, next_client_seq,
           next_server_seq, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 1, 1, ?)`,
        sessionID,
        authority.userID,
        authority.userPublicID,
        authority.planID,
        authority.authVersion,
        syncState.buffer,
        Math.floor(Date.now() / 1_000),
      );
      const hello = JSON.stringify({
        v: 1,
        type: "hello",
        planID: authority.planID,
        sessionID,
        nextClientSeq: 1,
        nextServerSeq: 1,
        mutationsEnabled:
          String(this.env.COMINAVI_SHARED_PLAN_MUTATIONS_ENABLED) === "true",
      });
      // Complete the HTTP 101 response before emitting the first data frame.
      // Foundation's WebSocket implementation treats a frame delivered while
      // the upgrade request is still resolving as a lost connection, even
      // though more permissive clients accept it. `waitUntil` keeps the
      // authority recheck and hello delivery alive after the response returns.
      this.ctx.waitUntil(this.sendIfAuthorized(server, attachment, hello));
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.runSerialized(async () => {
      try {
        if (typeof message !== "string" || message.length > 1450 * 1024) {
          return this.closeProtocol(socket, "invalid_sync_frame");
        }
        const attachment = attachmentFor(socket);
        if (!attachment || !(await this.hasAuthority(attachment, true))) {
          return this.closeProtocol(socket, "membership_revoked", 4403);
        }
        const envelope = parseSyncEnvelope(message, attachment);
        const session = this.ctx.storage.sql
          .exec<SessionRow>(
            `SELECT sync_state, next_client_seq, next_server_seq,
                    replica_id, actor_id
             FROM sync_sessions WHERE session_id = ?`,
            attachment.sessionID,
          )
          .toArray()[0];
        if (!session) return this.closeProtocol(socket, "sync_session_missing");
        const payload = decodeBase64URL(envelope.payload);
        if (payload.byteLength > maximumSyncPayloadBytes) {
          return this.closeProtocol(socket, "sync_payload_too_large", 4422);
        }
        const payloadHash = await sha256Hex(payload);
        const receipt = this.ctx.storage.sql
          .exec<{
            session_id: string;
            seq: number;
            payload_hash: string;
            ack_json: string;
          }>(
            `SELECT session_id, seq, payload_hash, ack_json
             FROM frame_receipts
             WHERE user_id = ? AND replica_id = ? AND frame_id = ?`,
            attachment.userID,
            envelope.replicaID,
            envelope.frameID,
          )
          .toArray()[0];
        let frameClassification: "new" | "duplicate";
        try {
          frameClassification = classifySyncFrame(
            envelope,
            payloadHash,
            session.next_client_seq,
            receipt
              ? {
                  sessionID: receipt.session_id,
                  seq: receipt.seq,
                  payloadHash: receipt.payload_hash,
                }
              : null,
          );
        } catch (error) {
          return this.closeProtocol(
            socket,
            error instanceof Error ? error.message : "invalid_sync_frame",
          );
        }
        if (frameClassification === "duplicate" && receipt) {
          this.ctx.waitUntil(
            this.runSerialized(() => this.flushNotificationOutbox()),
          );
          await this.sendIfAuthorized(socket, attachment, receipt.ack_json);
          return;
        }
        if (
          (session.replica_id !== null &&
            session.replica_id !== envelope.replicaID) ||
          (session.actor_id !== null && session.actor_id !== envelope.actorID)
        ) {
          return this.closeProtocol(socket, "sync_identity_changed");
        }

        const current = this.loadDocument();
        const priorHeads = sortedHeads(current);
        const syncState = Automerge.decodeSyncState(
          new Uint8Array(session.sync_state),
        );
        const [candidate, receivedState] = Automerge.receiveSyncMessage(
          current,
          syncState,
          payload,
        );
        const candidateHeads = sortedHeads(candidate);
        const changed = priorHeads.join(",") !== candidateHeads.join(",");
        let validated: ValidatedPlanMutation | null = null;
        let actorBinding: PlanActorAuthority | null = null;
        let outbox: PreparedNotificationOutbox | null = null;
        if (changed) {
          if (
            String(this.env.COMINAVI_SHARED_PLAN_MUTATIONS_ENABLED) !== "true"
          ) {
            const sent = await this.sendIfAuthorized(
              socket,
              attachment,
              JSON.stringify({
                v: 1,
                type: "error",
                code: "plan_mutations_feature_gated",
                message:
                  "Collaborative mutations are not enabled on this service.",
                retryable: false,
              }),
            );
            if (!sent) return;
            return socket.close(4422, "plan_mutations_feature_gated");
          }
          const prepared = await this.validateCandidateForAuthority(
            current,
            candidate,
            attachment,
            envelope.replicaID,
            envelope.actorID,
            envelope.frameID,
          );
          validated = prepared.validated;
          actorBinding = prepared.actorBinding;
          outbox = prepared.outbox;
        }

        const committedDocument = validated?.document ?? current;
        const [outgoingState, outgoing] = Automerge.generateSyncMessage(
          committedDocument,
          receivedState,
        );
        const committedHeads = sortedHeads(committedDocument);
        const ack = JSON.stringify({
          v: 1,
          type: "ack",
          sessionID: attachment.sessionID,
          ackSeq: envelope.seq,
          frameID: envelope.frameID,
          documentHeads: committedHeads,
        });
        const nextServerSeq = session.next_server_seq + (outgoing ? 1 : 0);
        const now = Math.floor(Date.now() / 1_000);
        const operationLedgerChunks = compactBatchRecords(
          compactSerializedJSONValues(
            (validated?.operations ?? []).map((operation) =>
              canonicalJSON({
                operationID: operation.operationID,
                operationType: operation.operationType,
                actorID: operation.actorID,
                actorUserID: operation.actorUserID,
                changeHash: operation.changeHash,
                payloadHash: operation.payloadHash,
                committedHeads: operation.committedHeads,
                membershipEpoch: operation.membershipEpoch,
              }),
            ),
          ),
        );
        const conflictLedgerChunks = compactBatchRecords(
          compactSerializedJSONValues(
            (validated?.conflicts ?? []).map((conflict) =>
              canonicalJSON({ ...conflict, committedHeads }),
            ),
          ),
        );
        const notificationEventChunks = compactBatchRecords(
          compactSerializedJSONValues(
            (outbox?.events ?? []).map((event) => canonicalJSON(event)),
          ),
        );
        this.ctx.storage.transactionSync(() => {
          if (validated) {
            this.ctx.storage.sql.exec(
              `UPDATE plan_document SET bytes = ? WHERE singleton = 1`,
              validated.saved.buffer,
            );
          }
          if (actorBinding) {
            this.ctx.storage.sql.exec(
              `INSERT INTO actor_registry (
                 actor_id, plan_id, user_id, user_public_id, replica_id,
                 auth_version, membership_epoch, registered_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(actor_id) DO UPDATE SET
                 auth_version = excluded.auth_version,
                 membership_epoch = excluded.membership_epoch,
                 updated_at = excluded.updated_at
               WHERE actor_registry.plan_id = excluded.plan_id
                 AND actor_registry.user_id = excluded.user_id
                 AND actor_registry.user_public_id = excluded.user_public_id
                 AND actor_registry.replica_id = excluded.replica_id`,
              actorBinding.actorID,
              attachment.planID,
              actorBinding.userID,
              actorBinding.userPublicID,
              actorBinding.replicaID,
              actorBinding.authVersion,
              actorBinding.membershipEpoch,
              now,
              now,
            );
          }
          for (const [index, chunk] of operationLedgerChunks.entries()) {
            this.ctx.storage.sql.exec(
              `INSERT INTO operation_ledger_batches_v2 (
                 frame_id, chunk_index, entries_json, entry_count, created_at
               ) VALUES (?, ?, ?, ?, ?)`,
              envelope.frameID,
              index,
              chunk.json,
              chunk.count,
              now,
            );
          }
          for (const [index, chunk] of conflictLedgerChunks.entries()) {
            this.ctx.storage.sql.exec(
              `INSERT INTO conflict_ledger_batches_v2 (
                 frame_id, chunk_index, entries_json, entry_count, created_at
               ) VALUES (?, ?, ?, ?, ?)`,
              envelope.frameID,
              index,
              chunk.json,
              chunk.count,
              now,
            );
          }
          if (outbox) {
            this.ctx.storage.sql.exec(
              `INSERT OR IGNORE INTO local_notification_audiences_v2 (
                 audience_id, recipients_json, recipient_count, created_at
               ) VALUES (?, ?, ?, ?)`,
              outbox.audienceID,
              canonicalJSON(outbox.recipients),
              outbox.recipients.length,
              now,
            );
            for (const [index, chunk] of notificationEventChunks.entries()) {
              this.ctx.storage.sql.exec(
                `INSERT INTO local_notification_event_batches_v3 (
                   audience_id, chunk_index, events_json, event_count,
                   event_cursor, recipient_cursor, created_at
                 ) VALUES (?, ?, ?, ?, 0, 0, ?)`,
                outbox.audienceID,
                index,
                chunk.json,
                chunk.count,
                now,
              );
            }
          }
          this.ctx.storage.sql.exec(
            `UPDATE sync_sessions
             SET replica_id = ?, actor_id = ?, sync_state = ?,
                 next_client_seq = ?, next_server_seq = ?
             WHERE session_id = ?`,
            envelope.replicaID,
            envelope.actorID,
            Automerge.encodeSyncState(outgoingState).buffer,
            envelope.seq + 1,
            nextServerSeq,
            attachment.sessionID,
          );
          this.ctx.storage.sql.exec(
            `INSERT INTO frame_receipts (
               user_id, replica_id, frame_id, session_id, seq,
               payload_hash, ack_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            attachment.userID,
            envelope.replicaID,
            envelope.frameID,
            attachment.sessionID,
            envelope.seq,
            payloadHash,
            ack,
            now,
          );
          this.ctx.storage.sql.exec(
            `DELETE FROM frame_receipts
             WHERE rowid IN (
               SELECT rowid FROM frame_receipts
               WHERE session_id = ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT -1 OFFSET ?
             )`,
            attachment.sessionID,
            maximumFrameReceiptsPerSession,
          );
        });
        const acknowledged = await this.sendIfAuthorized(
          socket,
          attachment,
          ack,
        );
        if (acknowledged && outgoing) {
          await this.sendIfAuthorized(
            socket,
            attachment,
            JSON.stringify({
              v: 1,
              type: "sync",
              planID: attachment.planID,
              sessionID: attachment.sessionID,
              seq: session.next_server_seq,
              frameID: crypto.randomUUID(),
              payload: base64URL(outgoing),
            }),
          );
        }
        if (validated) {
          this.ctx.waitUntil(
            this.runSerialized(() =>
              this.broadcastCommittedDocument(
                committedDocument,
                attachment.sessionID,
              ),
            ),
          );
        }
        if (outbox && outbox.events.length > 0) {
          this.ctx.waitUntil(
            this.runSerialized(() => this.flushNotificationOutbox()),
          );
        }
      } catch (error) {
        this.closeProtocol(
          socket,
          error instanceof PlanDocumentError
            ? error.code
            : "invalid_sync_frame",
          error instanceof PlanDocumentError ? 4422 : 4400,
          error instanceof PlanDocumentError ? error.details : undefined,
        );
      }
    });
  }

  async alarm(): Promise<void> {
    await this.runSerialized(async () => {
      await this.flushNotificationOutbox();
    });
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.runSerialized(async () => {
      const attachment = attachmentFor(socket);
      if (!attachment) return;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "DELETE FROM frame_receipts WHERE session_id = ?",
          attachment.sessionID,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM sync_sessions WHERE session_id = ?",
          attachment.sessionID,
        );
      });
    });
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  private async validateCandidateForAuthority(
    current: Automerge.Doc<PlanDocument>,
    candidate: Automerge.Doc<PlanDocument>,
    attachment: SocketAttachment,
    replicaID: string,
    actorID: string,
    frameID: string,
  ): Promise<{
    validated: ValidatedPlanMutation;
    actorBinding: PlanActorAuthority;
    outbox: PreparedNotificationOutbox;
  }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await loadPlanSyncAuthoritySnapshot(
        this.env.COMINAVI_DB,
        attachment,
      );
      if (!snapshot) throw new PlanDocumentError("unregistered_plan_actor");
      const preparedActors = this.actorAuthorities(
        attachment,
        replicaID,
        actorID,
        snapshot,
      );
      const validated = await validatePlanMutation(current, candidate, {
        planID: attachment.planID,
        comiketNo: current.comiketNo,
        frameActorID: actorID,
        frameUserPublicID: attachment.userPublicID,
        actors: preparedActors.actors,
        activeMemberPublicIDs: new Set(
          snapshot.members.map((member) => member.userPublicID),
        ),
        membershipEpoch: snapshot.membershipEpoch,
      });
      const outbox = await this.prepareNotificationOutbox(
        attachment,
        snapshot,
        preparedActors.actors,
        validated,
        frameID,
      );
      if (outbox.events.length > 0)
        await this.ctx.storage.setAlarm(Date.now() + 1_000);
      const confirmation = await loadPlanSyncAuthoritySnapshot(
        this.env.COMINAVI_DB,
        attachment,
      );
      if (
        confirmation &&
        authoritySnapshotDigest(confirmation) ===
          authoritySnapshotDigest(snapshot)
      ) {
        return {
          validated,
          actorBinding: preparedActors.actorBinding,
          outbox,
        };
      }
    }
    throw new PlanDocumentError("unregistered_plan_actor");
  }

  private actorAuthorities(
    attachment: SocketAttachment,
    replicaID: string,
    actorID: string,
    snapshot: PlanSyncAuthoritySnapshot,
  ): {
    actors: Map<string, PlanActorAuthority>;
    actorBinding: PlanActorAuthority;
  } {
    const rows = this.ctx.storage.sql
      .exec<ActorRegistryRow>(
        `SELECT actor_id, user_id, user_public_id, replica_id,
                auth_version, membership_epoch
         FROM actor_registry`,
      )
      .toArray();
    return preparePlanActorAuthorities(
      attachment,
      replicaID,
      actorID,
      snapshot,
      rows,
    );
  }

  private async prepareNotificationOutbox(
    attachment: SocketAttachment,
    snapshot: PlanSyncAuthoritySnapshot,
    actors: ReadonlyMap<string, PlanActorAuthority>,
    validated: ValidatedPlanMutation,
    frameID: string,
  ): Promise<PreparedNotificationOutbox> {
    const now = Math.floor(Date.now() / 1_000);
    const events: SharedPlanOutboxEvent[] = [];
    const recipients = snapshot.members
      .map((recipient) => ({
        userID: recipient.userID,
        membershipNotificationEpoch: recipient.notificationEpoch,
      }))
      .sort((left, right) => left.userID - right.userID);
    if (recipients.length > maximumNotificationAudienceMembers)
      throw new PlanDocumentError("plan_document_limit");
    const audienceID = await sha256Hex(
      canonicalJSON({
        v: 1,
        planID: attachment.planID,
        frameID,
        membershipEpoch: snapshot.membershipEpoch,
        planNotificationEpoch: snapshot.planNotificationEpoch,
        recipients,
      }),
    );
    for (const operation of validated.operations) {
      const actor = actors.get(operation.actorID);
      if (!actor) throw new PlanDocumentError("unregistered_plan_actor");
      const eventID = await sha256Hex(
        canonicalJSON({
          v: 1,
          planID: attachment.planID,
          sourceKind: "operation",
          sourceID: operation.operationID,
          eventType: operation.operationType,
        }),
      );
      const payloadJSON = canonicalJSON(
        operationEventPayload(attachment.planID, operation),
      );
      events.push({
        eventID,
        planID: attachment.planID,
        sourceKind: "operation",
        sourceID: operation.operationID,
        actorUserID: actor.userID,
        eventType: operation.operationType,
        i18nKey: operationI18nKey(operation.operationType),
        payloadVersion: 1,
        payloadJSON,
        membershipEpoch: snapshot.membershipEpoch,
        planNotificationEpoch: snapshot.planNotificationEpoch,
        createdAt: now,
      });
    }
    for (const conflict of validated.conflicts) {
      const eventID = await sha256Hex(
        canonicalJSON({
          v: 1,
          planID: attachment.planID,
          sourceKind: "conflict",
          sourceID: conflict.conflictID,
          eventType: "shared_plan.conflict.v1",
        }),
      );
      const payloadJSON = canonicalJSON({
        v: 1,
        planID: attachment.planID,
        conflictID: conflict.conflictID,
        path: conflict.path,
        changeHashes: conflict.changeHashes,
        heads: validated.heads,
        membershipEpoch: snapshot.membershipEpoch,
      });
      events.push({
        eventID,
        planID: attachment.planID,
        sourceKind: "conflict",
        sourceID: conflict.conflictID,
        actorUserID: attachment.userID,
        eventType: "shared_plan.conflict.v1",
        i18nKey: "shared_plan.conflict",
        payloadVersion: 1,
        payloadJSON,
        membershipEpoch: snapshot.membershipEpoch,
        planNotificationEpoch: snapshot.planNotificationEpoch,
        createdAt: now,
      });
    }
    if (!notificationOutboxFitsBounds(events, recipients.length)) {
      throw new PlanDocumentError("plan_document_limit");
    }
    return { audienceID, recipients, events };
  }

  private async flushNotificationOutbox(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<LocalOutboxRow>(
        `SELECT batch.audience_id, batch.chunk_index, batch.events_json,
                batch.event_count, batch.event_cursor,
                batch.recipient_cursor, audience.recipients_json,
                audience.recipient_count
         FROM local_notification_event_batches_v3 AS batch
         JOIN local_notification_audiences_v2 AS audience
           ON audience.audience_id = batch.audience_id
         ORDER BY batch.created_at, batch.audience_id, batch.chunk_index
         LIMIT 10`,
      )
      .toArray();
    let processed = 0;
    try {
      for (const row of rows) {
        const events = JSON.parse(row.events_json) as SharedPlanOutboxEvent[];
        const recipients = JSON.parse(
          row.recipients_json,
        ) as SharedPlanOutboxRecipient[];
        if (
          events.length !== row.event_count ||
          events.length < 1 ||
          recipients.length !== row.recipient_count ||
          recipients.length < 1 ||
          recipients.length > maximumNotificationAudienceMembers ||
          row.event_cursor < 0 ||
          row.event_cursor > events.length ||
          row.recipient_cursor < 0 ||
          row.recipient_cursor >= recipients.length ||
          (row.event_cursor === events.length && row.recipient_cursor !== 0)
        )
          throw new Error("invalid_local_notification_audience");
        let eventCursor = row.event_cursor;
        let recipientCursor = row.recipient_cursor;
        while (
          eventCursor < events.length &&
          processed < maximumNotificationFanoutPairsPerDrain
        ) {
          const event = events[eventCursor]!;
          const recipient = recipients[recipientCursor]!;
          await fanoutSharedPlanOutboxEvent(
            this.env.COMINAVI_DB,
            this.env.COMINAVI_PUSH_QUEUE,
            event,
            recipient,
          );
          const priorEventCursor = eventCursor;
          const priorRecipientCursor = recipientCursor;
          recipientCursor += 1;
          if (recipientCursor === recipients.length) {
            eventCursor += 1;
            recipientCursor = 0;
          }
          this.ctx.storage.sql.exec(
            `UPDATE local_notification_event_batches_v3
             SET event_cursor = ?, recipient_cursor = ?
             WHERE audience_id = ? AND chunk_index = ?
               AND event_cursor = ? AND recipient_cursor = ?`,
            eventCursor,
            recipientCursor,
            row.audience_id,
            row.chunk_index,
            priorEventCursor,
            priorRecipientCursor,
          );
          processed += 1;
        }
        if (eventCursor === events.length) {
          this.ctx.storage.sql.exec(
            `DELETE FROM local_notification_event_batches_v3
             WHERE audience_id = ? AND chunk_index = ?
               AND event_cursor = ? AND recipient_cursor = 0`,
            row.audience_id,
            row.chunk_index,
            eventCursor,
          );
        }
        if (processed >= maximumNotificationFanoutPairsPerDrain) break;
      }
    } finally {
      this.ctx.storage.sql.exec(
        `DELETE FROM local_notification_audiences_v2
         WHERE NOT EXISTS (
           SELECT 1 FROM local_notification_event_batches_v3 AS batch
           WHERE batch.audience_id = local_notification_audiences_v2.audience_id
         )`,
      );
      const remaining = this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT count(*) AS count FROM local_notification_event_batches_v3`,
        )
        .one().count;
      if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
  }

  private async broadcastCommittedDocument(
    document: Automerge.Doc<PlanDocument>,
    originSessionID: string,
  ): Promise<void> {
    const peers: PlanPeerSessionInput[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (!attachment || attachment.sessionID === originSessionID) continue;
      const session = this.ctx.storage.sql
        .exec<SessionRow>(
          `SELECT sync_state, next_client_seq, next_server_seq,
                  replica_id, actor_id
           FROM sync_sessions WHERE session_id = ?`,
          attachment.sessionID,
        )
        .toArray()[0];
      if (!session) {
        socket.close(4400, "sync_session_missing");
        continue;
      }
      peers.push({
        document,
        encodedSyncState: new Uint8Array(session.sync_state),
        nextServerSequence: session.next_server_seq,
        planID: attachment.planID,
        sessionID: attachment.sessionID,
        frameID: crypto.randomUUID(),
        hasAuthority: () => this.hasAuthority(attachment, true),
        persist: (encodedSyncState, nextServerSequence) => {
          this.ctx.storage.sql.exec(
            `UPDATE sync_sessions
             SET sync_state = ?, next_server_seq = ?
             WHERE session_id = ?`,
            encodedSyncState.buffer,
            nextServerSequence,
            attachment.sessionID,
          );
        },
        socket,
      });
    }
    await advancePlanPeerSessions(peers);
  }

  private cleanupStaleSessions(): void {
    const activeSessionIDs = new Set(
      this.ctx
        .getWebSockets()
        .map(attachmentFor)
        .filter(
          (attachment): attachment is SocketAttachment => attachment !== null,
        )
        .map((attachment) => attachment.sessionID),
    );
    const stored = this.ctx.storage.sql
      .exec<{ session_id: string }>("SELECT session_id FROM sync_sessions")
      .toArray();
    this.ctx.storage.transactionSync(() => {
      for (const session of stored) {
        if (activeSessionIDs.has(session.session_id)) continue;
        this.ctx.storage.sql.exec(
          "DELETE FROM frame_receipts WHERE session_id = ?",
          session.session_id,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM sync_sessions WHERE session_id = ?",
          session.session_id,
        );
      }
    });
  }

  private loadOrCreateDocument(
    planID: string,
    comiketNo: number,
  ): Automerge.Doc<PlanDocument> {
    const row = this.ctx.storage.sql
      .exec<{ plan_id: string; comiket_no: number; bytes: ArrayBuffer }>(
        "SELECT plan_id, comiket_no, bytes FROM plan_document WHERE singleton = 1",
      )
      .toArray()[0];
    if (row) {
      if (row.plan_id !== planID || row.comiket_no !== comiketNo) {
        throw new Error("Durable Object plan identity mismatch.");
      }
      return Automerge.load<PlanDocument>(new Uint8Array(row.bytes));
    }
    const document = Automerge.from<PlanDocument>(
      {
        schemaVersion: 1,
        planID: new Automerge.ImmutableString(planID),
        comiketNo,
        circles: {},
        operations: {},
      },
      { actor: randomActorID() },
    );
    const saved = Automerge.save(document);
    if (saved.byteLength > maximumSavedDocumentBytes)
      throw new Error("Document too large.");
    this.ctx.storage.sql.exec(
      `INSERT INTO plan_document (singleton, plan_id, comiket_no, bytes)
       VALUES (1, ?, ?, ?)`,
      planID,
      comiketNo,
      saved.buffer,
    );
    return document;
  }

  private loadDocument(): Automerge.Doc<PlanDocument> {
    const row = this.ctx.storage.sql
      .exec<{ bytes: ArrayBuffer }>(
        "SELECT bytes FROM plan_document WHERE singleton = 1",
      )
      .one();
    return Automerge.load<PlanDocument>(new Uint8Array(row.bytes));
  }

  private async hasAuthority(
    authority: {
      userID: number;
      userPublicID: string;
      planID: string;
      authVersion: number;
    },
    requireActivePlan: boolean,
  ): Promise<boolean> {
    return hasPlanSyncAuthority(
      this.env.COMINAVI_DB,
      authority,
      requireActivePlan,
    );
  }

  private async fenceSockets(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (!attachment || !(await this.hasAuthority(attachment, true))) {
        socket.close(4403, "authority_changed");
      }
    }
  }

  private async sendIfAuthorized(
    socket: WebSocket,
    authority: SocketAttachment,
    message: string,
  ): Promise<boolean> {
    return sendPlanSyncFrameIfAuthorized(
      () => this.hasAuthority(authority, true),
      socket,
      message,
    );
  }

  private closeProtocol(
    socket: WebSocket,
    code: string,
    closeCode = 4400,
    details?: Readonly<Record<string, unknown>>,
  ): void {
    socket.send(JSON.stringify(planSyncErrorEnvelope(code, details)));
    socket.close(closeCode, code.slice(0, 120));
  }

  private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    return this.operations.run(operation);
  }
}

function parseAuthorityHeaders(request: Request): {
  userID: number;
  userPublicID: string;
  planID: string;
  authVersion: number;
  comiketNo: number;
} {
  const userID = Number(request.headers.get("X-ComiNavi-User-ID"));
  const authVersion = Number(request.headers.get("X-ComiNavi-Auth-Version"));
  const comiketNo = Number(request.headers.get("X-ComiNavi-Comiket-No"));
  const userPublicID = request.headers.get("X-ComiNavi-User-Public-ID") ?? "";
  const planID = request.headers.get("X-ComiNavi-Plan-ID") ?? "";
  if (
    !Number.isSafeInteger(userID) ||
    userID < 1 ||
    !Number.isSafeInteger(authVersion) ||
    authVersion < 1 ||
    !Number.isSafeInteger(comiketNo) ||
    comiketNo < 1 ||
    !/^[0-9a-f]{32}$/.test(userPublicID) ||
    !isUUID(planID)
  ) {
    throw new Error("Invalid internal plan authority.");
  }
  return { userID, userPublicID, planID, authVersion, comiketNo };
}

function attachmentFor(socket: WebSocket): SocketAttachment | null {
  const value: unknown = socket.deserializeAttachment();
  return isRecord(value) && value.v === 1
    ? (value as unknown as SocketAttachment)
    : null;
}

function sortedHeads(document: Automerge.Doc<unknown>): string[] {
  return Automerge.getHeads(document).slice().sort();
}

function compactBatchRecords(
  chunks: readonly string[],
): Array<{ json: string; count: number }> {
  return chunks.map((json) => {
    const values: unknown = JSON.parse(json);
    if (!Array.isArray(values) || values.length < 1)
      throw new Error("invalid_compact_json_batch");
    return { json, count: values.length };
  });
}

function authoritySnapshotDigest(snapshot: PlanSyncAuthoritySnapshot): string {
  return canonicalJSON({
    membershipEpoch: snapshot.membershipEpoch,
    planNotificationEpoch: snapshot.planNotificationEpoch,
    members: snapshot.members.map((member) => ({
      userID: member.userID,
      userPublicID: member.userPublicID,
      authVersion: member.authVersion,
      notificationEpoch: member.notificationEpoch,
    })),
  });
}

function randomActorID(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isUUID(value: unknown): value is string {
  return isCanonicalSyncUUID(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
