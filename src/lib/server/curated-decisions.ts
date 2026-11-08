import { and, asc, eq, gt, like, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import { createDatabase, type CominaviDatabase } from "../db/client";
import {
  catalogEditionCapabilities,
  catalogEditionCircles,
  curatedDecisionHeads,
  curatedDecisionReasonCodes,
  curatedDecisionRequestReceipts,
  curatedDecisions,
  curatedDecisionTypes,
  curatedEditionLedgerHeads,
} from "../db/schema";
import { sha256Hex } from "./auth-sessions";
import {
  isCatalogEventKey,
  isCircleKey,
  type CatalogCapabilityName,
} from "./catalog-identity";
import { ServiceError } from "./service-error";

/**
 * Curated-decision authority ledger (#49).
 * Contract: cominavi/cominavi docs/proposals/catalog-contracts.md §3.2–§3.4.
 *
 * Not exposed over HTTP yet: every mutation must carry a verified operator
 * identity, and operator authentication (#55) does not exist. Callers pass the
 * verified actor; it is never read from the request body.
 */

export type CuratedDecisionType = (typeof curatedDecisionTypes)[number];
export type CuratedDecisionActor = {
  kind: "operator" | "system" | "legacy_import";
  subject: string;
};

const requestIDPattern =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-hjkmnp-tv-z]{26})$/;

const accountRefSchema = z
  .object({
    xUserID: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .optional(),
    handle: z
      .string()
      .regex(/^[a-z0-9_]{1,15}$/, "handle must be normalized lowercase"),
  })
  .strict();

const payloadSchemas = {
  x_account_attach: z
    .object({
      accountRef: accountRefSchema,
      role: z.enum(["primary", "secondary"]),
    })
    .strict(),
  x_account_suppress: z.object({ accountRef: accountRefSchema }).strict(),
  attendance_assert: z
    .object({
      status: z.enum(["attending", "withdrawn"]),
      day: z.number().int().positive().max(100).optional(),
    })
    .strict(),
  attendance_claim_suppress: z
    .object({
      claimRef: z
        .object({
          postID: z.string().regex(/^[1-9][0-9]{0,23}$/),
          claimKey: z.string().min(1).max(160),
        })
        .strict(),
    })
    .strict(),
  circle_identity_link: z
    .object({
      providerRef: z.string().min(1).max(100),
      circleKey: z.string().refine(isCircleKey, "invalid circleKey"),
    })
    .strict(),
} satisfies Record<CuratedDecisionType, z.ZodType>;

const reasonSchema = z
  .object({
    code: z.enum(curatedDecisionReasonCodes),
    text: z.string(),
    reportID: z.string().min(1).max(64).optional(),
    evidenceRefs: z.array(z.string().min(1).max(200)).max(50),
  })
  .strict();

const requestSchema = z
  .object({
    requestID: z
      .string()
      .regex(requestIDPattern, "requestID must be a lowercase UUID or ULID"),
    subject: z
      .object({
        catalogEventKey: z.string().min(3).max(64),
        circleKey: z.string().min(1).max(64),
      })
      .strict(),
    slot: z.string().min(1).max(200),
    operation: z.enum(["assert", "reverse"]),
    decisionType: z.enum(curatedDecisionTypes),
    payloadSchemaVersion: z.literal(1),
    payload: z.record(z.string(), z.unknown()),
    baseRevision: z.number().int().min(0),
    reason: reasonSchema,
  })
  .strict();

export type CuratedDecisionRequest = z.infer<typeof requestSchema>;

/** The capability that must be supported for an edition to accept a type. */
const requiredCapability: Record<CuratedDecisionType, CatalogCapabilityName> = {
  x_account_attach: "socialEnrichment",
  x_account_suppress: "socialEnrichment",
  attendance_assert: "attendanceStatus",
  attendance_claim_suppress: "attendanceStatus",
  circle_identity_link: "catalogArtifact",
};

export type CuratedDecisionRecord = {
  decisionID: string;
  catalogEventKey: string;
  circleKey: string;
  slot: string;
  slotRevision: number;
  operation: "assert" | "reverse";
  decisionType: CuratedDecisionType;
  payloadSchemaVersion: number;
  payload: Record<string, unknown>;
  actor: CuratedDecisionActor;
  reason: {
    code: string;
    text: string;
    reportID?: string;
    evidenceRefs: string[];
  };
  ledgerSeq: number;
  createdAt: number;
};

export type CuratedDecisionResult = {
  decision: CuratedDecisionRecord;
  slotRevision: number;
  activeDecisionID: string | null;
  ledgerSeq: number;
};

export type CuratedDecisionCommit = {
  status: 200 | 201;
  replayed: boolean;
  result: CuratedDecisionResult;
};

function invalid(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ServiceError {
  return new ServiceError(code, 422, message, details);
}

/** Fixed-order canonical payload (fixtures/catalog-contracts/README.md). */
export function canonicalCuratedPayload(
  type: CuratedDecisionType,
  operation: "assert" | "reverse",
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (operation === "reverse") {
    if (Object.keys(payload).length > 0)
      throw invalid(
        "invalid_decision_payload",
        "A reverse decision has an empty payload.",
      );
    return {};
  }
  const parsed = payloadSchemas[type].safeParse(payload);
  if (!parsed.success)
    throw invalid(
      "invalid_decision_payload",
      "The decision payload is invalid for its type.",
      {
        issues: parsed.error.issues.map(
          (issue) => issue.path.join(".") || issue.message,
        ),
      },
    );
  const value = parsed.data as Record<string, any>;
  const account = (ref: { xUserID?: string; handle: string }) => ({
    ...(ref.xUserID === undefined ? {} : { xUserID: ref.xUserID }),
    handle: ref.handle,
  });
  switch (type) {
    case "x_account_attach":
      return { accountRef: account(value.accountRef), role: value.role };
    case "x_account_suppress":
      return { accountRef: account(value.accountRef) };
    case "attendance_assert":
      return {
        status: value.status,
        ...(value.day === undefined ? {} : { day: value.day }),
      };
    case "attendance_claim_suppress":
      return {
        claimRef: {
          postID: value.claimRef.postID,
          claimKey: value.claimRef.claimKey,
        },
      };
    case "circle_identity_link":
      return { providerRef: value.providerRef, circleKey: value.circleKey };
  }
}

function canonicalReason(reason: CuratedDecisionRequest["reason"]) {
  return {
    code: reason.code,
    text: reason.text,
    ...(reason.reportID === undefined ? {} : { reportID: reason.reportID }),
    evidenceRefs: reason.evidenceRefs,
  };
}

/** SHA-256 over the canonical request without `requestID` (§3.3). */
export async function curatedDecisionRequestSHA256(
  request: CuratedDecisionRequest,
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      subject: {
        catalogEventKey: request.subject.catalogEventKey,
        circleKey: request.subject.circleKey,
      },
      slot: request.slot,
      operation: request.operation,
      decisionType: request.decisionType,
      payloadSchemaVersion: request.payloadSchemaVersion,
      payload: canonicalCuratedPayload(
        request.decisionType,
        request.operation,
        request.payload,
      ),
      baseRevision: request.baseRevision,
      reason: canonicalReason(request.reason),
    }),
  );
}

/** The slot an assert of `type` with `payload` controls (§3.2). */
export function curatedDecisionSlot(
  type: CuratedDecisionType,
  payload: Record<string, any>,
): string | null {
  switch (type) {
    case "x_account_attach":
    case "x_account_suppress":
      return payload.accountRef.xUserID
        ? `x_account:id:${payload.accountRef.xUserID}`
        : `x_account:handle:${payload.accountRef.handle}`;
    case "attendance_assert":
      return "attendance";
    case "attendance_claim_suppress":
      return `attendance_claim:${payload.claimRef.postID}:${payload.claimRef.claimKey}`;
    case "circle_identity_link":
      return null;
  }
}

function slotAcceptsType(slot: string, type: CuratedDecisionType): boolean {
  if (slot.startsWith("x_account:"))
    return type === "x_account_attach" || type === "x_account_suppress";
  if (slot === "attendance") return type === "attendance_assert";
  if (slot.startsWith("attendance_claim:"))
    return type === "attendance_claim_suppress";
  if (slot.startsWith("identity:")) return type === "circle_identity_link";
  return false;
}

function validateReason(request: CuratedDecisionRequest): void {
  const length = [...request.reason.text].length;
  const minimum =
    request.reason.code === "other" || request.operation === "reverse" ? 10 : 1;
  if (
    request.reason.text.trim().length === 0 ||
    length < minimum ||
    length > 1000
  )
    throw invalid(
      "invalid_reason",
      `Reason text must be ${minimum}–1000 characters.`,
      { minimum },
    );
  if (
    request.reason.code === "report_confirmed" &&
    request.reason.reportID === undefined
  )
    throw invalid("invalid_reason", "report_confirmed requires a reportID.");
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A server-minted ULID (48-bit millisecond time + 80 random bits). */
export function mintCuratedDecisionID(nowMilliseconds = Date.now()): string {
  let time = nowMilliseconds;
  let timePart = "";
  for (let index = 0; index < 10; index += 1) {
    timePart = crockford[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let randomPart = "";
  for (let index = 0; index < 16; index += 1)
    randomPart += crockford[random[index] % 32];
  return timePart + randomPart;
}

/**
 * Commits one create/reverse request in a single D1 batch: the decision, the
 * slot-head CAS, the edition ledger sequence, and the receipt. The receipt's
 * foreign key to the decision is the batch's assertion: when the conditional
 * decision insert matches no row (stale base or concurrent sequence), the
 * receipt insert fails and the whole batch rolls back.
 */
export async function commitCuratedDecision(
  database: D1Database,
  input: unknown,
  actor: CuratedDecisionActor,
  options: { now: number; mintID?: () => string },
): Promise<CuratedDecisionCommit> {
  if (actor.subject.trim().length === 0 || actor.subject.length > 200)
    throw new ServiceError(
      "operator_identity_required",
      403,
      "A verified actor is required.",
    );
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    throw invalid(
      "invalid_decision_request",
      "The decision request is invalid.",
      {
        issues: parsed.error.issues.map(
          (issue) => issue.path.join(".") || issue.message,
        ),
      },
    );
  const request = parsed.data;
  const requestSHA256 = await curatedDecisionRequestSHA256(request);
  const db = createDatabase(database);

  const replay = await readReceipt(db, request.requestID, requestSHA256);
  if (replay) return replay;

  const { catalogEventKey: key, circleKey } = request.subject;
  if (!isCatalogEventKey(key, "comiket") && !isCatalogEventKey(key, "fixture"))
    throw invalid(
      "unknown_circle",
      "The subject circle is not in the edition's history.",
    );
  const [circle] = await db
    .select({ key: catalogEditionCircles.circleKey })
    .from(catalogEditionCircles)
    .where(
      and(
        eq(catalogEditionCircles.catalogEventKey, key),
        eq(catalogEditionCircles.circleKey, circleKey),
      ),
    );
  if (!circle)
    throw invalid(
      "unknown_circle",
      "The subject circle is not in the edition's history.",
    );

  const capability = requiredCapability[request.decisionType];
  const [capabilityRow] = await db
    .select({ state: catalogEditionCapabilities.state })
    .from(catalogEditionCapabilities)
    .where(
      and(
        eq(catalogEditionCapabilities.catalogEventKey, key),
        eq(catalogEditionCapabilities.capability, capability),
      ),
    );
  if (capabilityRow?.state !== "supported")
    throw invalid(
      "capability_unsupported",
      "The edition does not support this decision type.",
      {
        capability,
      },
    );

  const payload = canonicalCuratedPayload(
    request.decisionType,
    request.operation,
    request.payload,
  );
  validateReason(request);
  if (!slotAcceptsType(request.slot, request.decisionType))
    throw invalid(
      "invalid_slot",
      "The slot does not accept this decision type.",
    );
  if (request.operation === "assert") {
    const expected = curatedDecisionSlot(request.decisionType, payload);
    if (expected !== null && expected !== request.slot)
      throw invalid("invalid_slot", "The slot does not match the payload.", {
        expectedSlot: expected,
      });
    if (
      request.decisionType === "circle_identity_link" &&
      !/^identity:[A-Za-z0-9._-]{1,160}:/.test(request.slot)
    )
      throw invalid(
        "invalid_slot",
        "An identity slot is identity:{versionID}:{providerRef}.",
      );
    if (
      request.decisionType === "circle_identity_link" &&
      !request.slot.endsWith(`:${payload.providerRef}`)
    )
      throw invalid("invalid_slot", "The slot does not match the payload.");
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Edition sequence fence first: every check below (slot head, active
    // decision, cross-slot primary) is invalidated by any ledger commit after
    // this snapshot, because the batch's decision insert is conditional on it.
    const [ledger] = await db
      .select({ ledgerSeq: curatedEditionLedgerHeads.ledgerSeq })
      .from(curatedEditionLedgerHeads)
      .where(eq(curatedEditionLedgerHeads.catalogEventKey, key));
    const previousSeq = ledger?.ledgerSeq ?? 0;
    const head = await readHead(db, key, circleKey, request.slot);
    const currentRevision = head?.slotRevision ?? 0;
    if (currentRevision !== request.baseRevision)
      return replayOrStale(db, request.requestID, requestSHA256, head);
    try {
      await validateAgainstCurrentState(db, request, payload, head);
    } catch (error) {
      // A conflict observed after the first receipt lookup may have been
      // caused by this exact request committing concurrently (and being
      // superseded since): replay its receipt before reporting the conflict.
      const replay = await readReceipt(db, request.requestID, requestSHA256);
      if (replay) return replay;
      throw error;
    }

    const ledgerSeq = previousSeq + 1;
    const slotRevision = request.baseRevision + 1;
    const decisionID = (
      options.mintID ?? (() => mintCuratedDecisionID(options.now * 1000))
    )();
    const record: CuratedDecisionRecord = {
      decisionID,
      catalogEventKey: key,
      circleKey,
      slot: request.slot,
      slotRevision,
      operation: request.operation,
      decisionType: request.decisionType,
      payloadSchemaVersion: request.payloadSchemaVersion,
      payload,
      actor,
      reason: canonicalReason(request.reason),
      ledgerSeq,
      createdAt: options.now,
    };
    const result: CuratedDecisionResult = {
      decision: record,
      slotRevision,
      activeDecisionID: request.operation === "assert" ? decisionID : null,
      ledgerSeq,
    };
    const payloadJSON = JSON.stringify(payload);
    const statements: BatchItem<"sqlite">[] = [
      db.insert(curatedDecisions).select(sql`
        SELECT ${decisionID}, ${key}, ${circleKey}, ${request.slot}, ${slotRevision},
               ${request.operation}, ${request.decisionType}, ${request.payloadSchemaVersion},
               ${payloadJSON}, ${await sha256Hex(payloadJSON)}, ${actor.kind}, ${actor.subject},
               ${request.reason.code}, ${request.reason.text}, ${request.reason.reportID ?? null},
               ${JSON.stringify(request.reason.evidenceRefs)}, ${request.requestID},
               ${requestSHA256}, ${ledgerSeq}, ${options.now}
        WHERE COALESCE((
                SELECT ${curatedDecisionHeads.slotRevision} FROM ${curatedDecisionHeads}
                WHERE ${curatedDecisionHeads.catalogEventKey} = ${key}
                  AND ${curatedDecisionHeads.circleKey} = ${circleKey}
                  AND ${curatedDecisionHeads.slot} = ${request.slot}), 0) = ${request.baseRevision}
          AND COALESCE((
                SELECT ${curatedEditionLedgerHeads.ledgerSeq} FROM ${curatedEditionLedgerHeads}
                WHERE ${curatedEditionLedgerHeads.catalogEventKey} = ${key}), 0) = ${previousSeq}`),
      db
        .insert(curatedDecisionHeads)
        .values({
          catalogEventKey: key,
          circleKey,
          slot: request.slot,
          slotRevision,
          activeDecisionID: result.activeDecisionID,
        })
        .onConflictDoUpdate({
          target: [
            curatedDecisionHeads.catalogEventKey,
            curatedDecisionHeads.circleKey,
            curatedDecisionHeads.slot,
          ],
          set: { slotRevision, activeDecisionID: result.activeDecisionID },
          setWhere: sql`${curatedDecisionHeads.slotRevision} = ${request.baseRevision}`,
        }),
      db
        .insert(curatedEditionLedgerHeads)
        .values({ catalogEventKey: key, ledgerSeq, publishedThroughSeq: 0 })
        .onConflictDoUpdate({
          target: curatedEditionLedgerHeads.catalogEventKey,
          set: { ledgerSeq },
          setWhere: sql`${curatedEditionLedgerHeads.ledgerSeq} = ${previousSeq}`,
        }),
      db.insert(curatedDecisionRequestReceipts).values({
        requestID: request.requestID,
        requestSHA256,
        decisionID,
        responseJSON: JSON.stringify(result),
        createdAt: options.now,
      }),
    ];
    try {
      await db.batch(
        statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
      );
      return { status: 201, replayed: false, result };
    } catch (error) {
      // Head before receipt: an identical request that committed after our
      // first receipt lookup is visible by the time its head is.
      const now = await readHead(db, key, circleKey, request.slot);
      const recovered = await readReceipt(db, request.requestID, requestSHA256);
      if (recovered) return recovered;
      if ((now?.slotRevision ?? 0) !== request.baseRevision)
        throw await staleBase(db, now);
      // The edition sequence advanced concurrently: retry against it.
      if (attempt === 4) throw error;
    }
  }
  throw new ServiceError(
    "ledger_contention",
    503,
    "The ledger is busy; retry the same request.",
  );
}

async function readReceipt(
  db: CominaviDatabase,
  requestID: string,
  requestSHA256: string,
): Promise<CuratedDecisionCommit | null> {
  const [receipt] = await db
    .select()
    .from(curatedDecisionRequestReceipts)
    .where(eq(curatedDecisionRequestReceipts.requestID, requestID));
  if (!receipt) return null;
  if (receipt.requestSHA256 !== requestSHA256)
    throw new ServiceError(
      "request_payload_conflict",
      409,
      "This requestID was already used with a different payload.",
    );
  return {
    status: 200,
    replayed: true,
    result: JSON.parse(receipt.responseJSON),
  };
}

async function validateAgainstCurrentState(
  db: CominaviDatabase,
  request: CuratedDecisionRequest,
  payload: Record<string, unknown>,
  head: { slotRevision: number; activeDecisionID: string | null } | null,
): Promise<void> {
  const { catalogEventKey: key, circleKey } = request.subject;
  const active = head?.activeDecisionID
    ? await readDecision(db, head.activeDecisionID)
    : null;
  if (request.operation === "reverse") {
    if (!active)
      throw new ServiceError(
        "nothing_to_reverse",
        409,
        "The slot has no active decision.",
        {
          currentRevision: head?.slotRevision ?? 0,
        },
      );
    if (active.decisionType !== request.decisionType)
      throw invalid(
        "invalid_slot",
        "A reverse names the active decision's type.",
        {
          activeDecisionType: active.decisionType,
        },
      );
  } else if (
    request.decisionType === "x_account_attach" &&
    payload.role === "primary"
  ) {
    await assertNoOtherPrimary(db, key, circleKey, request.slot);
  }
}

/**
 * A changed slot head is a stale base only if this exact request did not
 * commit it: recheck the receipt (after the head read) before conflicting.
 */
async function replayOrStale(
  db: CominaviDatabase,
  requestID: string,
  requestSHA256: string,
  head: { slotRevision: number; activeDecisionID: string | null } | null,
): Promise<CuratedDecisionCommit> {
  const replay = await readReceipt(db, requestID, requestSHA256);
  if (replay) return replay;
  throw await staleBase(db, head);
}

async function readHead(
  db: CominaviDatabase,
  key: string,
  circleKey: string,
  slot: string,
) {
  const [head] = await db
    .select()
    .from(curatedDecisionHeads)
    .where(
      and(
        eq(curatedDecisionHeads.catalogEventKey, key),
        eq(curatedDecisionHeads.circleKey, circleKey),
        eq(curatedDecisionHeads.slot, slot),
      ),
    );
  return head ?? null;
}

async function staleBase(
  db: CominaviDatabase,
  head: { slotRevision: number; activeDecisionID: string | null } | null,
): Promise<ServiceError> {
  const currentDecision = head?.activeDecisionID
    ? await readDecision(db, head.activeDecisionID)
    : null;
  return new ServiceError(
    "stale_base_revision",
    409,
    "The slot changed since its base revision.",
    {
      currentRevision: head?.slotRevision ?? 0,
      currentDecision,
    },
  );
}

type DecisionRow = typeof curatedDecisions.$inferSelect;

function decisionRecord(row: DecisionRow): CuratedDecisionRecord {
  return {
    decisionID: row.decisionID,
    catalogEventKey: row.catalogEventKey,
    circleKey: row.circleKey,
    slot: row.slot,
    slotRevision: row.slotRevision,
    operation: row.operation,
    decisionType: row.decisionType,
    payloadSchemaVersion: row.payloadSchemaVersion,
    payload: JSON.parse(row.payloadJSON),
    actor: { kind: row.actorKind, subject: row.actorSubject },
    reason: {
      code: row.reasonCode,
      text: row.reasonText,
      ...(row.reportID === null ? {} : { reportID: row.reportID }),
      evidenceRefs: JSON.parse(row.evidenceRefsJSON),
    },
    ledgerSeq: row.ledgerSeq,
    createdAt: row.createdAt,
  };
}

async function readDecision(
  db: CominaviDatabase,
  decisionID: string,
): Promise<CuratedDecisionRecord | null> {
  const [row] = await db
    .select()
    .from(curatedDecisions)
    .where(eq(curatedDecisions.decisionID, decisionID));
  return row ? decisionRecord(row) : null;
}

async function assertNoOtherPrimary(
  db: CominaviDatabase,
  key: string,
  circleKey: string,
  slot: string,
): Promise<void> {
  const rows = await db
    .select({
      slot: curatedDecisionHeads.slot,
      payloadJSON: curatedDecisions.payloadJSON,
    })
    .from(curatedDecisionHeads)
    .innerJoin(
      curatedDecisions,
      eq(curatedDecisions.decisionID, curatedDecisionHeads.activeDecisionID),
    )
    .where(
      and(
        eq(curatedDecisionHeads.catalogEventKey, key),
        eq(curatedDecisionHeads.circleKey, circleKey),
        like(curatedDecisionHeads.slot, "x_account:%"),
        eq(curatedDecisions.decisionType, "x_account_attach"),
      ),
    );
  const other = rows.find(
    (row) =>
      row.slot !== slot && JSON.parse(row.payloadJSON).role === "primary",
  );
  if (other)
    throw new ServiceError(
      "primary_account_conflict",
      409,
      "The circle already has an active primary X account; reverse or demote it first.",
      { primarySlot: other.slot },
    );
}

/** Full history of one circle, oldest first. */
export async function readCuratedDecisionHistory(
  database: D1Database,
  subject: { catalogEventKey: string; circleKey: string },
): Promise<CuratedDecisionRecord[]> {
  const rows = await createDatabase(database)
    .select()
    .from(curatedDecisions)
    .where(
      and(
        eq(curatedDecisions.catalogEventKey, subject.catalogEventKey),
        eq(curatedDecisions.circleKey, subject.circleKey),
      ),
    )
    .orderBy(asc(curatedDecisions.ledgerSeq));
  return rows.map(decisionRecord);
}

/** Ledger entries of one edition after `afterSeq`, in sequence order. */
export async function readCuratedLedger(
  database: D1Database,
  catalogEventKey: string,
  afterSeq: number,
  limit = 100,
): Promise<CuratedDecisionRecord[]> {
  const rows = await createDatabase(database)
    .select()
    .from(curatedDecisions)
    .where(
      and(
        eq(curatedDecisions.catalogEventKey, catalogEventKey),
        gt(curatedDecisions.ledgerSeq, afterSeq),
      ),
    )
    .orderBy(asc(curatedDecisions.ledgerSeq))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(decisionRecord);
}
