export interface SocketAttachment {
  v: 1;
  sessionID: string;
  userID: number;
  userPublicID: string;
  planID: string;
  authVersion: number;
}

export interface SyncEnvelope {
  v: 1;
  type: "sync";
  planID: string;
  sessionID: string;
  replicaID: string;
  actorID: string;
  seq: number;
  frameID: string;
  payload: string;
}

export interface SyncFrameReceipt {
  sessionID: string;
  seq: number;
  payloadHash: string;
}

export class SyncProtocolError extends Error {
  constructor(
    readonly code: "frame_receipt_violation" | "sync_sequence_violation",
  ) {
    super(code);
  }
}

export function planSyncErrorEnvelope(
  code: string,
  details?: Readonly<Record<string, unknown>>,
): {
  v: 1;
  type: "error";
  code: string;
  message: string;
  retryable: false;
  details?: Readonly<Record<string, unknown>>;
} {
  return {
    v: 1,
    type: "error",
    code,
    message: syncErrorMessage(code),
    retryable: false,
    ...(details ? { details } : {}),
  };
}

function syncErrorMessage(code: string): string {
  switch (code) {
    case "invalid_plan_operation":
      return "One or more saved changes could not be verified. They remain available on this device for export or recovery.";
    case "invalid_plan_document":
      return "This saved plan copy is not compatible with the server. The local copy remains available for export.";
    case "unregistered_plan_actor":
      return "This editing session is no longer authorized. Reopen the plan to start a new session.";
    case "plan_compaction_required":
      return "This plan has reached its retained-history limit. Export or rebuild the local copy before syncing again.";
    case "plan_sync_backlog_limit":
      // Kept stable because this exact envelope is part of the frozen v1
      // transport/backlog interoperability fixture.
      return "The sync session cannot continue.";
    case "membership_revoked":
    case "plan_membership_required":
      return "Your access to this plan has changed. Unsynced local changes remain available for export.";
    case "role_changed":
    case "owner_required":
    case "plan_archived":
      return "Your editing access changed. Reload the plan before making more changes.";
    default:
      return "The sync session ended safely. Reopen the plan to try again.";
  }
}

export function classifySyncFrame(
  envelope: SyncEnvelope,
  payloadHash: string,
  expectedSequence: number,
  receipt: SyncFrameReceipt | null,
): "new" | "duplicate" {
  if (receipt) {
    if (
      receipt.sessionID !== envelope.sessionID ||
      receipt.seq !== envelope.seq ||
      receipt.payloadHash !== payloadHash
    ) {
      throw new SyncProtocolError("frame_receipt_violation");
    }
    return "duplicate";
  }
  if (envelope.seq !== expectedSequence)
    throw new SyncProtocolError("sync_sequence_violation");
  return "new";
}

export function parseSyncEnvelope(
  value: string,
  attachment: SocketAttachment,
): SyncEnvelope {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Invalid sync envelope.");
  const planID = canonicalUUID(parsed.planID);
  const sessionID = canonicalUUID(parsed.sessionID);
  const replicaID = canonicalUUID(parsed.replicaID);
  const frameID = canonicalUUID(parsed.frameID);
  const actorID = typeof parsed.actorID === "string" ? parsed.actorID : "";
  if (
    parsed.v !== 1 ||
    parsed.type !== "sync" ||
    planID !== attachment.planID ||
    sessionID !== attachment.sessionID ||
    replicaID === null ||
    frameID === null ||
    !/^[0-9a-f]{16,128}$/.test(actorID) ||
    !Number.isSafeInteger(parsed.seq) ||
    Number(parsed.seq) < 1 ||
    typeof parsed.payload !== "string" ||
    parsed.payload.length > 1400 * 1024
  ) {
    throw new Error("Invalid sync envelope.");
  }
  return {
    v: 1,
    type: "sync",
    planID,
    sessionID,
    replicaID,
    actorID,
    seq: Number(parsed.seq),
    frameID,
    payload: parsed.payload,
  };
}

export function isCanonicalSyncUUID(value: unknown): value is string {
  return canonicalUUID(value) !== null;
}

export function hasPlanSessionCapacity(
  sessions: ReadonlyArray<{ userID: number }>,
  userID: number,
): boolean {
  return (
    sessions.length < 100 &&
    sessions.filter((session) => session.userID === userID).length < 5
  );
}

function canonicalUUID(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  )
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
