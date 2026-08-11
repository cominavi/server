import * as Automerge from "@automerge/automerge";
import { sha256Hex } from "./auth-sessions";
import { isCanonicalSyncUUID } from "./sync-protocol";

export interface PlanDocument {
  [key: string]: unknown;
  schemaVersion: 1;
  planID: Automerge.ImmutableString;
  comiketNo: number;
  circles: Record<string, PlanCircle>;
  operations: Record<string, PlanOperation>;
}

export interface PlanCircle {
  [key: string]: unknown;
  comiketNo: number;
  WCID: number;
  rootOperationID: string;
  presence: { state: "active" | "removed"; operationID: string };
  memo: string;
  needs: Record<string, PlanNeed>;
  communicationState: Record<string, CommunicationValue>;
}

export interface PlanNeed {
  [key: string]: unknown;
  rootOperationID: string;
  presence: { state: "active" | "removed"; operationID: string };
  requesterUserID: string;
  itemName?: string;
  unitPrice?: number | null;
  wantedQuantity: number;
  buyerAllocations: Record<string, number>;
  fulfilledQuantity: number;
}

export type CommunicationValue = string | number | boolean | null;

interface NestedConflictResolution {
  conflictID: string;
  path: string[];
  selectedChangeHash: string;
  value: unknown;
}

export interface PlanOperation {
  [key: string]: unknown;
  type: PlanOperationType;
  actorUserID: string;
  payload: Record<string, unknown>;
}

export type PlanOperationType =
  | "shared_plan.circle.presence.v1"
  | "shared_plan.circle.resolve_parent.v1"
  | "shared_plan.circle.memo.splice.v1"
  | "shared_plan.need.create.v1"
  | "shared_plan.need.delete.v1"
  | "shared_plan.need.resolve_parent.v1"
  | "shared_plan.need.wanted_quantity.v1"
  | "shared_plan.need.buyer_allocation.v1"
  | "shared_plan.need.fulfilled_quantity.v1"
  | "shared_plan.circle.communication.set.v1";

export interface PlanActorAuthority {
  actorID: string;
  userID: number;
  userPublicID: string;
  replicaID: string;
  authVersion: number;
  membershipEpoch: number;
}

export interface PlanMutationValidationContext {
  planID: string;
  comiketNo: number;
  frameActorID: string;
  frameUserPublicID: string;
  actors: ReadonlyMap<string, PlanActorAuthority>;
  activeMemberPublicIDs: ReadonlySet<string>;
  membershipEpoch: number;
}

export interface ValidatedPlanOperation {
  operationID: string;
  operationType: PlanOperationType;
  actorID: string;
  actorUserID: string;
  changeHash: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  committedHeads: string[];
  membershipEpoch: number;
}

export interface PlanConflict {
  conflictID: string;
  path: Array<string | number>;
  changeHashes: string[];
}

export interface ValidatedPlanMutation {
  document: Automerge.Doc<PlanDocument>;
  operations: ValidatedPlanOperation[];
  conflicts: PlanConflict[];
  heads: string[];
  saved: Uint8Array;
}

export class PlanDocumentError extends Error {
  constructor(
    readonly code:
      | "invalid_plan_document"
      | "invalid_plan_operation"
      | "plan_document_limit"
      | "plan_compaction_required"
      | "plan_sync_backlog_limit"
      | "unregistered_plan_actor",
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
  }
}

type PlanOperationRejectionReason =
  | "change_set"
  | "change_order"
  | "change_binding"
  | "change_application"
  | "operation_binding"
  | "operation_payload"
  | "member_reference"
  | "parent_resolution"
  | "exact_change_proof"
  | "final_consistency";

const maximumSavedDocumentBytes = 1_500_000;
const maximumMemoBytes = 64 * 1024;
const maximumCircles = 2_000;
const maximumOperations = 10_000;
export const maximumRetainedOperationPayloadBytes = 512 * 1024;
export const maximumNewOperationsPerSyncFrame = 1_000;
const maximumNeedsPerCircle = 500;
const maximumAllocationsPerNeed = 100;
const maximumCommunicationFields = 64;
const maximumCommunicationBytes = 16 * 1024;
const maximumConflicts = 2_000;
const maximumQuantity = 999;
const maximumItemNameCharacters = 80;
const maximumItemNameBytes = 512;
const maximumUnitPrice = 9_999_999;
const publicIDPattern = /^[0-9a-f]{32}$/;
const actorIDPattern = /^[0-9a-f]{16,128}$/;
const changeHashPattern = /^[0-9a-f]{64}$/;
const communicationKeyPattern = /^[a-z][a-zA-Z0-9_.-]{0,63}$/;

export async function validatePlanMutation(
  current: Automerge.Doc<PlanDocument>,
  candidate: Automerge.Doc<PlanDocument>,
  context: PlanMutationValidationContext,
): Promise<ValidatedPlanMutation> {
  // The Durable Object is the sole writer of the current operation ledger.
  // Every incoming change below is reconstructed exactly before it can become
  // current, so revalidating every immutable historical payload would make a
  // legal near-cap edit linear in the entire retained operation history.
  validateDocumentStructure(current, context.planID, context.comiketNo, false);
  validateDocumentStructure(
    candidate,
    context.planID,
    context.comiketNo,
    false,
  );

  let changes: Uint8Array[];
  try {
    changes = Automerge.getChanges(current, candidate);
  } catch {
    throw invalidOperation("change_set");
  }
  if (changes.length === 0) throw invalidOperation("change_set");
  if (changes.length > maximumNewOperationsPerSyncFrame)
    throw new PlanDocumentError("plan_sync_backlog_limit", {
      maximumNewOperationsPerSyncFrame,
      receivedChanges: changes.length,
    });
  const sorted = withInvalidOperationReason("change_order", () =>
    topologicalChanges(current, changes),
  );
  const semanticOperationIDsByChange = withInvalidOperationReason(
    "change_binding",
    () => assertSemanticChangeMessages(current, candidate, sorted),
  );
  const finalHeads = sortedHeads(candidate);
  const operations: ValidatedPlanOperation[] = [];
  let validationWorking = Automerge.clone(current);
  let expectedWorking = Automerge.clone(current, {
    actor: validationActorID(current),
  });
  let expectedToActualOperationID = new Map<string, string>();

  for (const item of sorted) {
    const actor = context.actors.get(item.decoded.actor);
    if (
      !actor ||
      !actorIDPattern.test(item.decoded.actor) ||
      item.decoded.actor !== context.frameActorID ||
      actor.userPublicID !== context.frameUserPublicID
    )
      throw new PlanDocumentError("unregistered_plan_actor");
    if (!context.activeMemberPublicIDs.has(actor.userPublicID))
      throw new PlanDocumentError("unregistered_plan_actor");

    let before: Automerge.Doc<PlanDocument>;
    let after: Automerge.Doc<PlanDocument>;
    const advancesWorking =
      canonicalJSON(sortedHeads(validationWorking)) ===
      canonicalJSON(item.decoded.deps.slice().sort());
    try {
      if (advancesWorking) {
        before = validationWorking;
        [after] = Automerge.applyChanges(validationWorking, [item.bytes]);
        validationWorking = after;
      } else {
        before = Automerge.view(candidate, item.decoded.deps);
        after = Automerge.view(candidate, [item.decoded.hash]);
      }
    } catch {
      throw invalidOperation("change_application");
    }
    const beforeOperations = before.operations;
    const afterOperations = after.operations;
    const inserted = Object.keys(afterOperations).filter(
      (operationID) => !(operationID in beforeOperations),
    );
    if (inserted.length !== 1) throw invalidOperation("operation_binding");
    const operationID = inserted[0]!;
    if (
      !isCanonicalSyncUUID(operationID) ||
      semanticOperationIDsByChange.get(item.decoded.hash) !== operationID
    )
      throw invalidOperation("operation_binding");
    const operation = withInvalidOperationReason("operation_payload", () => {
      assertNoOperationConflict(after, operationID);
      return parseOperation(afterOperations[operationID]);
    });
    if (operation.actorUserID !== actor.userPublicID)
      throw invalidOperation("member_reference");
    withInvalidOperationReason("member_reference", () =>
      validateOperationMemberReferences(
        operation,
        context.activeMemberPublicIDs,
      ),
    );
    await withInvalidOperationReasonAsync("parent_resolution", () =>
      assertParentResolutionDoesNotCollapseNestedConflicts(before, operation),
    );
    withInvalidOperationReason("exact_change_proof", () => {
      if (advancesWorking) {
        const reconstructed = reconstructSequentialExactPatch(
          expectedWorking,
          operationID,
          operation,
          item.decoded,
          expectedToActualOperationID,
          hasUnresolvedSemanticConflict(before, operation),
        );
        expectedWorking = reconstructed.document;
        expectedToActualOperationID = reconstructed.expectedToActualOperationID;
      } else {
        reconstructExactPatch(before, operationID, operation, item.decoded);
      }
    });
    const payloadHash = await sha256Hex(canonicalJSON(operation.payload));
    operations.push({
      operationID,
      operationType: operation.type,
      actorID: item.decoded.actor,
      actorUserID: operation.actorUserID,
      changeHash: item.decoded.hash,
      payloadHash,
      payload: operation.payload,
      committedHeads: finalHeads,
      membershipEpoch: context.membershipEpoch,
    });
    if (!advancesWorking) {
      try {
        [validationWorking] = Automerge.applyChanges(validationWorking, [
          item.bytes,
        ]);
      } catch {
        throw invalidOperation("change_application");
      }
      expectedWorking = Automerge.clone(validationWorking, {
        actor: validationActorID(validationWorking),
      });
      expectedToActualOperationID = new Map();
    }
  }

  if (
    canonicalJSON(sortedHeads(validationWorking)) !== canonicalJSON(finalHeads)
  )
    throw invalidOperation("final_consistency");
  const working = validationWorking;
  if (
    canonicalJSON(contentProjection(expectedWorking)) !==
    canonicalJSON(contentProjection(working))
  )
    throw invalidOperation("final_consistency");
  validateDocumentStructure(working, context.planID, context.comiketNo, false);
  const saved = Automerge.save(working);
  if (saved.byteLength > maximumSavedDocumentBytes)
    throw new PlanDocumentError("plan_document_limit");
  const conflicts = await newlyIntroducedConflicts(current, working);
  return { document: working, operations, conflicts, heads: finalHeads, saved };
}

export async function detectPlanConflicts(
  document: Automerge.Doc<PlanDocument>,
): Promise<PlanConflict[]> {
  return documentConflicts(document);
}

export function applyPlanOperation(
  draft: PlanDocument,
  operationID: string,
  operation: PlanOperation,
  options: { semanticResolution?: boolean } = {},
): void {
  const payload = operation.payload;
  const wcID = requiredInteger(payload.wcID, 1, Number.MAX_SAFE_INTEGER);
  const circleKey = String(wcID);
  const circle = draft.circles[circleKey];
  switch (operation.type) {
    case "shared_plan.circle.presence.v1": {
      const state = requiredEnum(payload.state, ["active", "removed"] as const);
      const competingCircles = parentConflictValues<PlanCircle>(
        draft.circles,
        circleKey,
      );
      if (competingCircles.length > 1) {
        throw invalidOperation();
      } else if (!circle) {
        if (state !== "active") throw invalidOperation();
        writeStoredValue(draft.circles, circleKey, {
          comiketNo: draft.comiketNo,
          WCID: wcID,
          rootOperationID: operationID,
          presence: { state, operationID },
          memo: "",
          needs: {},
          communicationState: {},
        });
      } else {
        if (
          circle.presence.state === state &&
          !hasRegisterConflict(circle, "presence") &&
          !options.semanticResolution
        )
          throw invalidOperation();
        circle.presence = { state, operationID };
      }
      break;
    }
    case "shared_plan.circle.resolve_parent.v1": {
      const state = requiredEnum(payload.state, ["active", "removed"] as const);
      const selectedParentOperationID = requiredUUID(
        payload.selectedParentOperationID,
      );
      const nestedResolutions = requiredNestedConflictResolutions(
        payload.nestedResolutions,
      );
      const competing = parentConflictValues<PlanCircle>(
        draft.circles,
        circleKey,
      );
      if (competing.length <= 1) throw invalidOperation();
      const resolved = resolveCircleParent(
        competing,
        selectedParentOperationID,
        state,
        operationID,
      );
      applyNestedConflictResolutions(
        resolved,
        ["circles", circleKey],
        nestedResolutions,
        true,
      );
      mergeDisjointCircleDescendants(resolved, competing);
      applyNestedConflictResolutions(
        resolved,
        ["circles", circleKey],
        nestedResolutions,
        false,
      );
      forceParentWrite(draft.circles, circleKey, resolved);
      break;
    }
    case "shared_plan.circle.memo.splice.v1": {
      const active = requiredActiveCircle(circle);
      const index = requiredInteger(payload.index, 0, Number.MAX_SAFE_INTEGER);
      const deleteCount = requiredInteger(
        payload.deleteCount,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const text = requiredString(payload.text, maximumMemoBytes);
      const length = Array.from(active.memo).length;
      if (index > length || deleteCount > length - index)
        throw invalidOperation();
      if (deleteCount === 0 && text.length === 0) throw invalidOperation();
      Automerge.splice(
        draft,
        ["circles", circleKey, "memo"],
        index,
        deleteCount,
        text,
      );
      break;
    }
    case "shared_plan.need.create.v1": {
      const active = requiredActiveCircle(circle);
      const needID = requiredUUID(payload.needID);
      const requesterUserID = requiredPublicID(payload.requesterUserID);
      const wantedQuantity = requiredQuantity(payload.wantedQuantity);
      const hasItemDetails = "itemName" in payload || "unitPrice" in payload;
      const itemName = hasItemDetails
        ? requiredItemName(payload.itemName)
        : undefined;
      const unitPrice = hasItemDetails
        ? requiredOptionalUnitPrice(payload.unitPrice)
        : undefined;
      const existing = active.needs[needID];
      const competingNeeds = parentConflictValues<PlanNeed>(
        active.needs,
        needID,
      );
      if (competingNeeds.length > 1) {
        throw invalidOperation();
      } else if (existing) {
        if (existing.presence.state === "active" && !options.semanticResolution)
          throw invalidOperation();
        existing.presence = { state: "active", operationID };
        existing.requesterUserID = requesterUserID;
        if (itemName !== undefined) {
          existing.itemName = itemName;
          existing.unitPrice = unitPrice ?? null;
        }
        writeStoredValue(existing, "wantedQuantity", wantedQuantity);
      } else {
        writeStoredValue(active.needs, needID, {
          rootOperationID: operationID,
          presence: { state: "active", operationID },
          requesterUserID,
          ...(itemName === undefined
            ? {}
            : { itemName, unitPrice: unitPrice ?? null }),
          wantedQuantity,
          buyerAllocations: {},
          fulfilledQuantity: 0,
        });
      }
      break;
    }
    case "shared_plan.need.delete.v1": {
      const active = requiredActiveCircle(circle);
      const needID = requiredUUID(payload.needID);
      const need = active.needs[needID];
      const competingNeeds = parentConflictValues<PlanNeed>(
        active.needs,
        needID,
      );
      if (
        !need ||
        (need.presence.state !== "active" &&
          !hasRegisterConflict(need, "presence") &&
          competingNeeds.length <= 1 &&
          !options.semanticResolution)
      )
        throw invalidOperation();
      if (competingNeeds.length > 1) {
        throw invalidOperation();
      } else need.presence = { state: "removed", operationID };
      break;
    }
    case "shared_plan.need.resolve_parent.v1": {
      const active = requiredActiveCircle(circle);
      const needID = requiredUUID(payload.needID);
      const state = requiredEnum(payload.state, ["active", "removed"] as const);
      const selectedParentOperationID = requiredUUID(
        payload.selectedParentOperationID,
      );
      const nestedResolutions = requiredNestedConflictResolutions(
        payload.nestedResolutions,
      );
      const competing = parentConflictValues<PlanNeed>(active.needs, needID);
      if (competing.length <= 1) throw invalidOperation();
      const resolved = resolveNeedParent(
        competing,
        selectedParentOperationID,
        operationID,
        state,
      );
      applyNestedConflictResolutions(
        resolved,
        ["circles", circleKey, "needs", needID],
        nestedResolutions,
        true,
      );
      mergeDisjointNeedAllocations(resolved, competing);
      applyNestedConflictResolutions(
        resolved,
        ["circles", circleKey, "needs", needID],
        nestedResolutions,
        false,
      );
      forceParentWrite(active.needs, needID, resolved);
      break;
    }
    case "shared_plan.need.wanted_quantity.v1": {
      const need = requiredNeed(circle, payload.needID);
      const quantity = requiredQuantity(payload.wantedQuantity);
      if (
        need.wantedQuantity === quantity &&
        !hasRegisterConflict(need, "wantedQuantity")
      )
        throw invalidOperation();
      if (
        need.wantedQuantity === quantity &&
        hasRegisterConflict(need, "wantedQuantity")
      )
        forceRegisterWrite(draft, need, "wantedQuantity", quantity);
      else writeStoredValue(need, "wantedQuantity", quantity);
      break;
    }
    case "shared_plan.need.buyer_allocation.v1": {
      const need = requiredNeed(circle, payload.needID);
      const buyerUserID = requiredPublicID(payload.buyerUserID);
      const quantity = requiredQuantity(payload.quantity);
      if (
        (need.buyerAllocations[buyerUserID] ?? 0) === quantity &&
        !hasRegisterConflict(need.buyerAllocations, buyerUserID)
      )
        throw invalidOperation();
      if (
        (need.buyerAllocations[buyerUserID] ?? 0) === quantity &&
        hasRegisterConflict(need.buyerAllocations, buyerUserID)
      )
        forceRegisterWrite(draft, need.buyerAllocations, buyerUserID, quantity);
      else writeStoredValue(need.buyerAllocations, buyerUserID, quantity);
      break;
    }
    case "shared_plan.need.fulfilled_quantity.v1": {
      const need = requiredNeed(circle, payload.needID);
      const quantity = requiredQuantity(payload.fulfilledQuantity);
      if (
        need.fulfilledQuantity === quantity &&
        !hasRegisterConflict(need, "fulfilledQuantity")
      )
        throw invalidOperation();
      if (
        need.fulfilledQuantity === quantity &&
        hasRegisterConflict(need, "fulfilledQuantity")
      )
        forceRegisterWrite(draft, need, "fulfilledQuantity", quantity);
      else writeStoredValue(need, "fulfilledQuantity", quantity);
      break;
    }
    case "shared_plan.circle.communication.set.v1": {
      const active = requiredActiveCircle(circle);
      const key = requiredString(payload.key, 64);
      if (!communicationKeyPattern.test(key)) throw invalidOperation();
      const value = requiredCommunicationValue(payload.value);
      if (
        canonicalJSON(active.communicationState[key]) ===
          canonicalJSON(value) &&
        !hasRegisterConflict(active.communicationState, key)
      )
        throw invalidOperation();
      if (
        canonicalJSON(active.communicationState[key]) ===
          canonicalJSON(value) &&
        hasRegisterConflict(active.communicationState, key)
      )
        forceRegisterWrite(draft, active.communicationState, key, value);
      else writeStoredValue(active.communicationState, key, value);
      break;
    }
    default:
      throw invalidOperation();
  }
  writeStoredValue(draft.operations, operationID, operation);
}

export function operationI18nKey(type: PlanOperationType): string {
  return type.replace(/\.v1$/, "");
}

export function operationEventPayload(
  planID: string,
  operation: ValidatedPlanOperation,
): Record<string, unknown> {
  return {
    v: 1,
    planID,
    operationID: operation.operationID,
    operationType: operation.operationType,
    actorUserID: operation.actorUserID,
    payload: boundedNotificationPayload(operation),
    heads: operation.committedHeads,
    membershipEpoch: operation.membershipEpoch,
  };
}

function boundedNotificationPayload(
  operation: ValidatedPlanOperation,
): Record<string, unknown> {
  const payload = operation.payload;
  if (operation.operationType === "shared_plan.circle.memo.splice.v1") {
    const text = requiredString(payload.text, maximumMemoBytes);
    return {
      v: 1,
      wcID: payload.wcID,
      index: payload.index,
      deleteCount: payload.deleteCount,
      insertedTextUTF8Bytes: utf8Bytes(text),
      insertedTextPreview: utf8Preview(text, 256),
    };
  }
  if (
    operation.operationType === "shared_plan.circle.resolve_parent.v1" ||
    operation.operationType === "shared_plan.need.resolve_parent.v1"
  ) {
    const nested = requiredNestedConflictResolutions(payload.nestedResolutions);
    return {
      v: 1,
      wcID: payload.wcID,
      ...(operation.operationType === "shared_plan.need.resolve_parent.v1"
        ? { needID: payload.needID }
        : {}),
      selectedParentOperationID: payload.selectedParentOperationID,
      state: payload.state,
      nestedConflictCount: nested.length,
    };
  }
  if (operation.operationType === "shared_plan.circle.communication.set.v1") {
    const value = payload.value;
    return {
      v: 1,
      wcID: payload.wcID,
      key: payload.key,
      value:
        typeof value === "string"
          ? {
              type: "string",
              utf8Bytes: utf8Bytes(value),
              preview: utf8Preview(value, 256),
            }
          : value,
    };
  }
  return payload;
}

function utf8Preview(value: string, maximumBytes: number): string {
  let preview = "";
  let bytes = 0;
  for (const scalar of value) {
    const scalarBytes = utf8Bytes(scalar);
    if (bytes + scalarBytes > maximumBytes) break;
    preview += scalar;
    bytes += scalarBytes;
  }
  return preview;
}

export function canonicalJSON(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Automerge.ImmutableString)
    return JSON.stringify(value.val);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJSON(item)).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function topologicalChanges(
  _current: Automerge.Doc<PlanDocument>,
  changes: Uint8Array[],
): Array<{
  bytes: Uint8Array;
  decoded: ReturnType<typeof Automerge.decodeChange>;
}> {
  const pending = new Map(
    changes.map((bytes) => {
      const decoded = Automerge.decodeChange(bytes);
      return [decoded.hash, { bytes, decoded }] as const;
    }),
  );
  if (pending.size !== changes.length) throw invalidOperation();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [hash, item] of pending) {
    let incoming = 0;
    for (const dependency of item.decoded.deps) {
      if (pending.has(dependency)) {
        incoming += 1;
        const children = dependents.get(dependency) ?? [];
        children.push(hash);
        dependents.set(dependency, children);
      }
    }
    indegree.set(hash, incoming);
  }
  const ready = Array.from(pending.keys())
    .filter((hash) => indegree.get(hash) === 0)
    .sort()
    .reverse();
  const result: Array<{
    bytes: Uint8Array;
    decoded: ReturnType<typeof Automerge.decodeChange>;
  }> = [];
  while (ready.length > 0) {
    const hash = ready.pop()!;
    const item = pending.get(hash);
    if (!item) throw invalidOperation();
    pending.delete(hash);
    result.push(item);
    for (const dependent of dependents.get(hash) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  if (pending.size > 0) throw invalidOperation();
  return result;
}

function assertSemanticChangeMessages(
  current: Automerge.Doc<PlanDocument>,
  candidate: Automerge.Doc<PlanDocument>,
  changes: Array<{
    bytes: Uint8Array;
    decoded: ReturnType<typeof Automerge.decodeChange>;
  }>,
): Map<string, string> {
  const operationsObjectID = Automerge.getObjectId(current.operations);
  if (!operationsObjectID) throw invalidOperation();
  const insertedOperationIDs = new Set(
    Object.keys(candidate.operations).filter(
      (operationID) => !(operationID in current.operations),
    ),
  );
  if (insertedOperationIDs.size !== changes.length) throw invalidOperation();

  const seenMessageOperationIDs = new Set<string>();
  const operationIDByChange = new Map<string, string>();
  for (const { decoded } of changes) {
    if (
      typeof decoded.message !== "string" ||
      !decoded.message.startsWith("operation:")
    )
      throw invalidOperation();
    const operationID = decoded.message.slice("operation:".length);
    if (
      decoded.message !== `operation:${operationID}` ||
      !isCanonicalSyncUUID(operationID) ||
      seenMessageOperationIDs.has(operationID) ||
      !insertedOperationIDs.has(operationID)
    )
      throw invalidOperation();

    const directlyInsertedOperationIDs = decoded.ops.flatMap((operation) =>
      operation.action === "makeMap" &&
      operation.obj === operationsObjectID &&
      typeof operation.key === "string" &&
      insertedOperationIDs.has(operation.key)
        ? [operation.key]
        : [],
    );
    if (
      directlyInsertedOperationIDs.length !== 1 ||
      directlyInsertedOperationIDs[0] !== operationID
    )
      throw invalidOperation();

    seenMessageOperationIDs.add(operationID);
    operationIDByChange.set(decoded.hash, operationID);
  }
  if (seenMessageOperationIDs.size !== insertedOperationIDs.size)
    throw invalidOperation();
  return operationIDByChange;
}

function reconstructExactPatch(
  before: Automerge.Doc<PlanDocument>,
  operationID: string,
  operation: PlanOperation,
  actualChange: ReturnType<typeof Automerge.decodeChange>,
): void {
  const expected = Automerge.change(
    Automerge.clone(before, { actor: validationActorID(before) }),
    (draft) =>
      applyPlanOperation(draft, operationID, operation, {
        semanticResolution: hasUnresolvedSemanticConflict(before, operation),
      }),
  );
  const expectedBytes = Automerge.getLastLocalChange(expected);
  if (!expectedBytes) throw invalidOperation();
  const expectedChange = Automerge.decodeChange(expectedBytes);
  const actualCanonical = canonicalChangeOps(actualChange);
  const expectedCanonical = canonicalChangeOps(expectedChange);
  if (
    canonicalJSON(actualChange.deps.slice().sort()) !==
      canonicalJSON(expectedChange.deps.slice().sort()) ||
    canonicalJSON(actualCanonical.operations) !==
      canonicalJSON(expectedCanonical.operations)
  ) {
    throw invalidOperation();
  }
}

function reconstructSequentialExactPatch(
  expectedBefore: Automerge.Doc<PlanDocument>,
  operationID: string,
  operation: PlanOperation,
  actualChange: ReturnType<typeof Automerge.decodeChange>,
  expectedToActualOperationID: Map<string, string>,
  semanticResolution: boolean,
): {
  document: Automerge.Doc<PlanDocument>;
  expectedToActualOperationID: Map<string, string>;
} {
  const expected = Automerge.change(expectedBefore, (draft) =>
    applyPlanOperation(draft, operationID, operation, { semanticResolution }),
  );
  const expectedBytes = Automerge.getLastLocalChange(expected);
  if (!expectedBytes) throw invalidOperation();
  const expectedChange = Automerge.decodeChange(expectedBytes);
  const actualCanonical = canonicalChangeOps(actualChange);
  const expectedCanonical = canonicalChangeOps(
    expectedChange,
    expectedToActualOperationID,
  );
  if (
    canonicalJSON(actualCanonical.operations) !==
    canonicalJSON(expectedCanonical.operations)
  ) {
    throw invalidOperation();
  }
  const actualByCanonicalID = new Map(
    Array.from(
      actualCanonical.canonicalIDByOperationID,
      ([operationID, canonicalID]) => [canonicalID, operationID],
    ),
  );
  for (const [
    expectedOperationID,
    canonicalID,
  ] of expectedCanonical.canonicalIDByOperationID) {
    const actualOperationID = actualByCanonicalID.get(canonicalID);
    if (!actualOperationID) throw invalidOperation();
    expectedToActualOperationID.set(expectedOperationID, actualOperationID);
  }
  return { document: expected, expectedToActualOperationID };
}

function canonicalChangeOps(
  change: ReturnType<typeof Automerge.decodeChange>,
  externalReferences: ReadonlyMap<string, string> = new Map(),
): {
  operations: Array<Record<string, unknown>>;
  canonicalIDByOperationID: Map<string, string>;
} {
  const localIDs = new Set<string>();
  for (let index = 0; index < change.ops.length; index += 1) {
    localIDs.add(`${change.startOp + index}@${change.actor}`);
  }
  const operationsByID = new Map(
    change.ops.map((operation, index) => [
      `${change.startOp + index}@${change.actor}`,
      operation as unknown as Record<string, unknown>,
    ]),
  );
  const canonicalIDs = new Map<string, string>();
  const canonical: Array<Record<string, unknown>> = [];
  let nextCanonicalID = 0;

  const reference = (value: string): string => {
    if (localIDs.has(value)) {
      const canonicalID = canonicalIDs.get(value);
      if (!canonicalID) throw invalidOperation();
      return canonicalID;
    }
    return externalReferences.get(value) ?? value;
  };
  const localReferences = (operation: Record<string, unknown>): string[] => {
    const result: string[] = [];
    for (const key of ["obj", "key", "elemId"] as const) {
      const value = operation[key];
      if (typeof value === "string" && localIDs.has(value)) result.push(value);
    }
    if (Array.isArray(operation.pred)) {
      for (const value of operation.pred) {
        const reference = String(value);
        if (localIDs.has(reference)) result.push(reference);
      }
    }
    return result;
  };
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [operationID, operation] of operationsByID) {
    const dependencies = new Set(localReferences(operation));
    indegree.set(operationID, dependencies.size);
    for (const dependency of dependencies) {
      const items = dependents.get(dependency) ?? [];
      items.push(operationID);
      dependents.set(dependency, items);
    }
  }
  const normalized = (
    operation: Record<string, unknown>,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(operation as unknown as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => {
          if (
            (key === "obj" || key === "key" || key === "elemId") &&
            typeof value === "string"
          )
            return [key, reference(value)];
          if (key === "pred" && Array.isArray(value))
            return [
              key,
              value
                .map((item) => reference(String(item)))
                .sort((left, right) => left.localeCompare(right)),
            ];
          return [key, value];
        }),
    );

  let readyOperationIDs = Array.from(indegree)
    .filter(([, count]) => count === 0)
    .map(([operationID]) => operationID);
  let processed = 0;
  while (readyOperationIDs.length > 0) {
    const ready = readyOperationIDs.map((operationID) => ({
      operationID,
      operation: normalized(operationsByID.get(operationID)!),
    }));
    ready.sort((left, right) =>
      canonicalJSON(left.operation).localeCompare(
        canonicalJSON(right.operation),
      ),
    );
    let previous: string | null = null;
    for (const item of ready) {
      const encoded = canonicalJSON(item.operation);
      if (encoded === previous) throw invalidOperation();
      const canonicalID = `#${nextCanonicalID}`;
      nextCanonicalID += 1;
      previous = encoded;
      canonicalIDs.set(item.operationID, canonicalID);
      canonical.push(item.operation);
      processed += 1;
    }
    const nextReady: string[] = [];
    for (const item of ready) {
      for (const dependent of dependents.get(item.operationID) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (next === 0) nextReady.push(dependent);
      }
    }
    readyOperationIDs = nextReady;
  }
  if (processed !== operationsByID.size) throw invalidOperation();
  return {
    operations: canonical.sort((left, right) =>
      canonicalJSON(left).localeCompare(canonicalJSON(right)),
    ),
    canonicalIDByOperationID: canonicalIDs,
  };
}

function validationActorID(_document: Automerge.Doc<PlanDocument>): string {
  // Wire actors are restricted to at most 128 hexadecimal characters. The
  // validator uses a reserved out-of-wire namespace so choosing its actor is
  // O(1) even at the retained-history ceiling and cannot collide with an
  // accepted client change.
  return "f".repeat(256);
}

function contentProjection(document: Automerge.Doc<PlanDocument>): unknown {
  return {
    schemaVersion: document.schemaVersion,
    planID: document.planID.val,
    comiketNo: document.comiketNo,
    circles: plainValue(document.circles),
  };
}

function plainValue(value: unknown): unknown {
  if (value instanceof Automerge.ImmutableString) return value.val;
  if (Array.isArray(value)) return value.map(plainValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, plainValue(child)]),
    );
  return value;
}

function validateDocumentStructure(
  document: Automerge.Doc<PlanDocument>,
  planID: string,
  comiketNo: number,
  validateOperations = true,
): void {
  if (
    document.schemaVersion !== 1 ||
    !(document.planID instanceof Automerge.ImmutableString) ||
    document.planID.val !== planID ||
    document.comiketNo !== comiketNo ||
    !isPlainRecord(document.circles) ||
    !isPlainRecord(document.operations) ||
    !hasExactKeys(document, [
      "schemaVersion",
      "planID",
      "comiketNo",
      "circles",
      "operations",
    ])
  ) {
    throw invalidDocument();
  }
  const circles = Object.entries(document.circles);
  if (circles.length > maximumCircles) throw documentLimit();
  for (const [key, circle] of circles) {
    if (
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      !isPlainRecord(circle) ||
      !hasExactKeys(circle, [
        "comiketNo",
        "WCID",
        "rootOperationID",
        "presence",
        "memo",
        "needs",
        "communicationState",
      ]) ||
      circle.comiketNo !== comiketNo ||
      !isSafeInteger(circle.WCID, 1, Number.MAX_SAFE_INTEGER) ||
      String(circle.WCID) !== key ||
      !isCanonicalSyncUUID(circle.rootOperationID) ||
      !isPlainRecord(circle.presence) ||
      !hasExactKeys(circle.presence, ["state", "operationID"]) ||
      !["active", "removed"].includes(String(circle.presence.state)) ||
      !isCanonicalSyncUUID(circle.presence.operationID) ||
      typeof circle.memo !== "string" ||
      utf8Bytes(circle.memo) > maximumMemoBytes ||
      !isPlainRecord(circle.needs) ||
      !isPlainRecord(circle.communicationState)
    ) {
      throw invalidDocument();
    }
    const needs = Object.entries(circle.needs);
    if (needs.length > maximumNeedsPerCircle) throw documentLimit();
    for (const [needID, need] of needs) validateNeed(needID, need);
    const communication = Object.entries(circle.communicationState);
    if (
      communication.length > maximumCommunicationFields ||
      utf8Bytes(canonicalJSON(circle.communicationState)) >
        maximumCommunicationBytes
    ) {
      throw documentLimit();
    }
    for (const [communicationKey, value] of communication) {
      if (
        !communicationKeyPattern.test(communicationKey) ||
        !isCommunicationValue(value)
      ) {
        throw invalidDocument();
      }
    }
  }
  const operations = Object.entries(document.operations);
  if (operations.length > maximumOperations) throw documentLimit();
  let retainedPayloadBytes = 0;
  for (const [, operation] of operations) {
    retainedPayloadBytes += utf8Bytes(
      canonicalJSON(isPlainRecord(operation) ? operation.payload : undefined),
    );
    if (retainedPayloadBytes > maximumRetainedOperationPayloadBytes)
      throw new PlanDocumentError("plan_compaction_required");
  }
  if (validateOperations) {
    for (const [operationID, operation] of operations) {
      if (!isCanonicalSyncUUID(operationID)) throw invalidDocument();
      assertNoOperationConflict(document, operationID);
      parseOperation(operation);
    }
  }
}

function validateNeed(needID: string, value: unknown): void {
  const legacyKeys = [
    "requesterUserID",
    "rootOperationID",
    "wantedQuantity",
    "buyerAllocations",
    "fulfilledQuantity",
    "presence",
  ];
  const currentKeys = [...legacyKeys, "itemName", "unitPrice"];
  if (
    !isCanonicalSyncUUID(needID) ||
    !isPlainRecord(value) ||
    (!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, currentKeys)) ||
    !isPlainRecord(value.presence) ||
    !isCanonicalSyncUUID(value.rootOperationID) ||
    !hasExactKeys(value.presence, ["state", "operationID"]) ||
    !["active", "removed"].includes(String(value.presence.state)) ||
    !isCanonicalSyncUUID(value.presence.operationID) ||
    !publicIDPattern.test(String(value.requesterUserID)) ||
    ("itemName" in value &&
      (() => {
        try {
          requiredItemName(value.itemName);
          requiredOptionalUnitPrice(value.unitPrice);
          return false;
        } catch {
          return true;
        }
      })()) ||
    !isSafeInteger(value.wantedQuantity, 0, maximumQuantity) ||
    !isSafeInteger(value.fulfilledQuantity, 0, maximumQuantity) ||
    !isPlainRecord(value.buyerAllocations)
  ) {
    throw invalidDocument();
  }
  const allocations = Object.entries(value.buyerAllocations);
  if (allocations.length > maximumAllocationsPerNeed) throw documentLimit();
  for (const [userID, quantity] of allocations) {
    if (
      !publicIDPattern.test(userID) ||
      !isSafeInteger(quantity, 0, maximumQuantity)
    ) {
      throw invalidDocument();
    }
  }
}

function parseOperation(value: unknown): PlanOperation {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["type", "actorUserID", "payload"]) ||
    !isOperationType(value.type) ||
    !publicIDPattern.test(String(value.actorUserID)) ||
    !isPlainRecord(value.payload)
  ) {
    throw invalidOperation();
  }
  const operation = value as unknown as PlanOperation;
  validatePayload(operation);
  return operation;
}

function validatePayload(operation: PlanOperation): void {
  const payload = operation.payload;
  if (payload.v !== 1) throw invalidOperation();
  const common = ["v", "wcID"];
  requiredInteger(payload.wcID, 1, Number.MAX_SAFE_INTEGER);
  switch (operation.type) {
    case "shared_plan.circle.presence.v1":
      exactPayload(payload, [...common, "state"]);
      requiredEnum(payload.state, ["active", "removed"] as const);
      break;
    case "shared_plan.circle.resolve_parent.v1":
      exactPayload(payload, [
        ...common,
        "selectedParentOperationID",
        "state",
        "nestedResolutions",
      ]);
      requiredUUID(payload.selectedParentOperationID);
      requiredEnum(payload.state, ["active", "removed"] as const);
      requiredNestedConflictResolutions(payload.nestedResolutions);
      break;
    case "shared_plan.circle.memo.splice.v1":
      exactPayload(payload, [...common, "index", "deleteCount", "text"]);
      requiredInteger(payload.index, 0, Number.MAX_SAFE_INTEGER);
      requiredInteger(payload.deleteCount, 0, Number.MAX_SAFE_INTEGER);
      requiredString(payload.text, maximumMemoBytes);
      break;
    case "shared_plan.need.create.v1":
      if (
        !hasExactKeys(payload, [
          ...common,
          "needID",
          "requesterUserID",
          "wantedQuantity",
        ])
      ) {
        exactPayload(payload, [
          ...common,
          "needID",
          "requesterUserID",
          "itemName",
          "unitPrice",
          "wantedQuantity",
        ]);
        requiredItemName(payload.itemName);
        requiredOptionalUnitPrice(payload.unitPrice);
      }
      requiredUUID(payload.needID);
      requiredPublicID(payload.requesterUserID);
      requiredQuantity(payload.wantedQuantity);
      break;
    case "shared_plan.need.delete.v1":
      exactPayload(payload, [...common, "needID"]);
      requiredUUID(payload.needID);
      break;
    case "shared_plan.need.resolve_parent.v1":
      exactPayload(payload, [
        ...common,
        "needID",
        "selectedParentOperationID",
        "state",
        "nestedResolutions",
      ]);
      requiredUUID(payload.needID);
      requiredUUID(payload.selectedParentOperationID);
      requiredEnum(payload.state, ["active", "removed"] as const);
      requiredNestedConflictResolutions(payload.nestedResolutions);
      break;
    case "shared_plan.need.wanted_quantity.v1":
      exactPayload(payload, [...common, "needID", "wantedQuantity"]);
      requiredUUID(payload.needID);
      requiredQuantity(payload.wantedQuantity);
      break;
    case "shared_plan.need.buyer_allocation.v1":
      exactPayload(payload, [...common, "needID", "buyerUserID", "quantity"]);
      requiredUUID(payload.needID);
      requiredPublicID(payload.buyerUserID);
      requiredQuantity(payload.quantity);
      break;
    case "shared_plan.need.fulfilled_quantity.v1":
      exactPayload(payload, [...common, "needID", "fulfilledQuantity"]);
      requiredUUID(payload.needID);
      requiredQuantity(payload.fulfilledQuantity);
      break;
    case "shared_plan.circle.communication.set.v1":
      exactPayload(payload, [...common, "key", "value"]);
      if (!communicationKeyPattern.test(requiredString(payload.key, 64)))
        throw invalidOperation();
      requiredCommunicationValue(payload.value);
      break;
  }
}

function validateOperationMemberReferences(
  operation: PlanOperation,
  members: ReadonlySet<string>,
): void {
  if (
    operation.type === "shared_plan.need.create.v1" &&
    (!members.has(String(operation.payload.requesterUserID)) ||
      ("itemName" in operation.payload &&
        operation.actorUserID !== operation.payload.requesterUserID))
  ) {
    throw invalidOperation();
  }
  if (
    operation.type === "shared_plan.need.buyer_allocation.v1" &&
    !members.has(String(operation.payload.buyerUserID))
  ) {
    throw invalidOperation();
  }
}

function assertNoOperationConflict(
  document: Automerge.Doc<PlanDocument>,
  operationID: string,
): void {
  const conflicts = Automerge.getConflicts(document.operations, operationID);
  if (conflicts && Object.keys(conflicts).length > 1) throw invalidOperation();
}

async function newlyIntroducedConflicts(
  before: Automerge.Doc<PlanDocument>,
  after: Automerge.Doc<PlanDocument>,
): Promise<PlanConflict[]> {
  const beforeConflicts = await nativeDocumentConflicts(before);
  const afterConflicts = await nativeDocumentConflicts(after);
  const known = new Set(beforeConflicts.map((conflict) => conflict.conflictID));
  const introducedOperationIDs = new Set(
    Object.keys(after.operations).filter(
      (operationID) => !(operationID in before.operations),
    ),
  );
  return uniqueConflicts([
    ...afterConflicts.filter((conflict) => !known.has(conflict.conflictID)),
    ...(await semanticDeletionConflicts(after, introducedOperationIDs)),
  ]);
}

async function documentConflicts(
  document: Automerge.Doc<PlanDocument>,
): Promise<PlanConflict[]> {
  return uniqueConflicts([
    ...(await nativeDocumentConflicts(document)),
    ...(await semanticDeletionConflicts(document)),
  ]);
}

async function nativeDocumentConflicts(
  document: Automerge.Doc<PlanDocument>,
): Promise<PlanConflict[]> {
  const descriptors: Array<{
    path: Array<string | number>;
    operationIDs: string[];
  }> = [];
  const visit = (value: unknown, path: Array<string | number>) => {
    if (
      value === null ||
      typeof value !== "object" ||
      value instanceof Automerge.ImmutableString ||
      Automerge.getObjectId(value) === null
    )
      return;
    for (const key of Object.keys(value as object)) {
      if (path.length === 0 && key === "operations") continue;
      const competing = Automerge.getConflicts(value as object, key);
      if (competing && Object.keys(competing).length > 1) {
        descriptors.push({
          path: [...path, key],
          operationIDs: Object.keys(competing),
        });
      }
      visit((value as Record<string, unknown>)[key], [...path, key]);
    }
  };
  visit(document, []);
  if (descriptors.length === 0) return [];
  const decodedChanges = decodedDocumentChanges(document);
  const changeByOperation = changeHashByOperationID(document, decodedChanges);
  return Promise.all(
    descriptors.flatMap(({ path, operationIDs }) => {
      const changeHashes = Array.from(
        new Set(
          operationIDs
            .map((operationID) => changeByOperation.get(operationID))
            .filter((hash): hash is string => Boolean(hash)),
        ),
      ).sort();
      return changeHashes.length > 1
        ? [
            sha256Hex(
              canonicalJSON({ schemaVersion: 1, path, changeHashes }),
            ).then((conflictID) => ({ conflictID, path, changeHashes })),
          ]
        : [];
    }),
  );
}

function uniqueConflicts(conflicts: PlanConflict[]): PlanConflict[] {
  const unique = Array.from(
    new Map(
      conflicts.map((conflict) => [conflict.conflictID, conflict]),
    ).values(),
  );
  if (unique.length > maximumConflicts) throw documentLimit();
  return unique.sort((left, right) =>
    left.conflictID.localeCompare(right.conflictID),
  );
}

async function semanticDeletionConflicts(
  document: Automerge.Doc<PlanDocument>,
  introducedOperationIDs?: ReadonlySet<string>,
): Promise<PlanConflict[]> {
  return Promise.all(
    semanticDeletionConflictDescriptors(document, introducedOperationIDs).map(
      (conflict) =>
        semanticConflict(
          conflict.path,
          conflict.changeHashes[0]!,
          conflict.changeHashes[1]!,
        ),
    ),
  );
}

function semanticDeletionConflictDescriptors(
  document: Automerge.Doc<PlanDocument>,
  introducedOperationIDs?: ReadonlySet<string>,
): Array<{ path: Array<string | number>; changeHashes: [string, string] }> {
  const operationEntries = Object.entries(document.operations);
  const rawTypes = operationEntries.map(([, value]) =>
    isPlainRecord(value) ? value.type : undefined,
  );
  const hasCircleRemoval = operationEntries.some(
    ([, value]) =>
      isPlainRecord(value) &&
      ((value.type === "shared_plan.circle.presence.v1" &&
        isPlainRecord(value.payload) &&
        value.payload.state === "removed") ||
        (value.type === "shared_plan.circle.resolve_parent.v1" &&
          isPlainRecord(value.payload) &&
          value.payload.state === "removed")),
  );
  const hasCircleDescendant = rawTypes.some(
    (type) =>
      typeof type === "string" &&
      type !== "shared_plan.circle.presence.v1" &&
      type !== "shared_plan.circle.resolve_parent.v1",
  );
  const hasNeedRemoval = operationEntries.some(
    ([, value]) =>
      isPlainRecord(value) &&
      (value.type === "shared_plan.need.delete.v1" ||
        (value.type === "shared_plan.need.resolve_parent.v1" &&
          isPlainRecord(value.payload) &&
          value.payload.state === "removed")),
  );
  const hasNeedDescendant = rawTypes.some(
    (type) =>
      type === "shared_plan.need.wanted_quantity.v1" ||
      type === "shared_plan.need.buyer_allocation.v1" ||
      type === "shared_plan.need.fulfilled_quantity.v1",
  );
  if (
    (!hasCircleRemoval || !hasCircleDescendant) &&
    (!hasNeedRemoval || !hasNeedDescendant)
  ) {
    return [];
  }
  const decodedChanges = decodedDocumentChanges(document);
  const changeByOperation = changeHashByOperationID(document, decodedChanges);
  const operations = operationEntries.map(([operationID, value]) => {
    const operation = parseOperation(value);
    const objectID = Automerge.getObjectId(value);
    const changeHash = objectID ? changeByOperation.get(objectID) : undefined;
    if (!changeHash) throw invalidOperation();
    return { operationID, operation, changeHash };
  });
  const graph = changeAncestry(document, decodedChanges);
  const conflicts: Array<{
    path: Array<string | number>;
    changeHashes: [string, string];
  }> = [];
  const removals = operations.filter(
    ({ operation }) =>
      (operation.type === "shared_plan.circle.presence.v1" ||
        operation.type === "shared_plan.circle.resolve_parent.v1") &&
      operation.payload.state === "removed",
  );
  const circleDescendants = operations.filter(({ operation }) =>
    isCircleDescendantOperation(operation.type),
  );
  const circleResolvers = operations.filter(
    ({ operation }) =>
      operation.type === "shared_plan.circle.presence.v1" ||
      operation.type === "shared_plan.circle.resolve_parent.v1",
  );
  for (const [removal, descendant] of pairsWithIntroducedOperation(
    removals,
    circleDescendants,
    introducedOperationIDs,
  )) {
    const wcID = requiredInteger(
      removal.operation.payload.wcID,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      descendant.operation.payload.wcID === wcID &&
      graph.concurrent(removal.changeHash, descendant.changeHash) &&
      !circleResolvers.some(
        (resolver) =>
          resolver.changeHash !== removal.changeHash &&
          resolver.operation.payload.wcID === wcID &&
          graph.descendsFromBoth(
            resolver.changeHash,
            removal.changeHash,
            descendant.changeHash,
          ),
      )
    ) {
      conflicts.push({
        path: ["circles", String(wcID), "presence"],
        changeHashes: [removal.changeHash, descendant.changeHash].sort() as [
          string,
          string,
        ],
      });
      if (conflicts.length > maximumConflicts) throw documentLimit();
    }
  }
  const needRemovals = operations.filter(
    ({ operation }) =>
      operation.type === "shared_plan.need.delete.v1" ||
      (operation.type === "shared_plan.need.resolve_parent.v1" &&
        operation.payload.state === "removed"),
  );
  const needDescendants = operations.filter(({ operation }) =>
    isNeedDescendantOperation(operation.type),
  );
  const needResolvers = operations.filter(
    ({ operation }) =>
      operation.type === "shared_plan.need.create.v1" ||
      operation.type === "shared_plan.need.delete.v1" ||
      operation.type === "shared_plan.need.resolve_parent.v1",
  );
  for (const [removal, descendant] of pairsWithIntroducedOperation(
    needRemovals,
    needDescendants,
    introducedOperationIDs,
  )) {
    const wcID = requiredInteger(
      removal.operation.payload.wcID,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const needID = requiredUUID(removal.operation.payload.needID);
    if (
      descendant.operation.payload.wcID === wcID &&
      descendant.operation.payload.needID === needID &&
      graph.concurrent(removal.changeHash, descendant.changeHash) &&
      !needResolvers.some(
        (resolver) =>
          resolver.changeHash !== removal.changeHash &&
          resolver.operation.payload.wcID === wcID &&
          resolver.operation.payload.needID === needID &&
          graph.descendsFromBoth(
            resolver.changeHash,
            removal.changeHash,
            descendant.changeHash,
          ),
      )
    ) {
      conflicts.push({
        path: ["circles", String(wcID), "needs", needID, "presence"],
        changeHashes: [removal.changeHash, descendant.changeHash].sort() as [
          string,
          string,
        ],
      });
      if (conflicts.length > maximumConflicts) throw documentLimit();
    }
  }
  return conflicts;
}

function* pairsWithIntroducedOperation<
  Left extends { operationID: string },
  Right extends { operationID: string },
>(
  left: readonly Left[],
  right: readonly Right[],
  introducedOperationIDs?: ReadonlySet<string>,
): Generator<readonly [Left, Right]> {
  if (!introducedOperationIDs) {
    for (const leftValue of left)
      for (const rightValue of right) yield [leftValue, rightValue] as const;
    return;
  }
  const introducedLeft = left.filter((value) =>
    introducedOperationIDs.has(value.operationID),
  );
  const historicalLeft = left.filter(
    (value) => !introducedOperationIDs.has(value.operationID),
  );
  const introducedRight = right.filter((value) =>
    introducedOperationIDs.has(value.operationID),
  );
  for (const leftValue of introducedLeft)
    for (const rightValue of right) yield [leftValue, rightValue] as const;
  for (const leftValue of historicalLeft)
    for (const rightValue of introducedRight)
      yield [leftValue, rightValue] as const;
}

function hasUnresolvedSemanticConflict(
  document: Automerge.Doc<PlanDocument>,
  operation: PlanOperation,
): boolean {
  if (
    operation.type !== "shared_plan.circle.presence.v1" &&
    operation.type !== "shared_plan.need.create.v1" &&
    operation.type !== "shared_plan.need.delete.v1"
  )
    return false;
  const wcID = String(
    requiredInteger(operation.payload.wcID, 1, Number.MAX_SAFE_INTEGER),
  );
  const path =
    operation.type === "shared_plan.circle.presence.v1"
      ? ["circles", wcID, "presence"]
      : [
          "circles",
          wcID,
          "needs",
          requiredUUID(operation.payload.needID),
          "presence",
        ];
  return semanticDeletionConflictDescriptors(document).some(
    (conflict) => canonicalJSON(conflict.path) === canonicalJSON(path),
  );
}

function isCircleDescendantOperation(type: PlanOperationType): boolean {
  return (
    type !== "shared_plan.circle.presence.v1" &&
    type !== "shared_plan.circle.resolve_parent.v1"
  );
}

function isNeedDescendantOperation(type: PlanOperationType): boolean {
  return (
    type === "shared_plan.need.wanted_quantity.v1" ||
    type === "shared_plan.need.buyer_allocation.v1" ||
    type === "shared_plan.need.fulfilled_quantity.v1"
  );
}

function hasRegisterConflict(value: object, key: string): boolean {
  const conflicts = Automerge.getConflicts(value, key);
  return Boolean(conflicts && Object.keys(conflicts).length > 1);
}

function parentConflictValues<T extends object>(
  value: object,
  key: string,
): T[] {
  const conflicts = Automerge.getConflicts(value, key);
  return conflicts ? (Object.values(conflicts) as T[]) : [];
}

function resolveCircleParent(
  competing: PlanCircle[],
  selectedParentOperationID: string,
  state: "active" | "removed",
  operationID: string,
): PlanCircle {
  const matching = competing.filter(
    (candidate) => candidate.rootOperationID === selectedParentOperationID,
  );
  if (matching.length !== 1) throw invalidOperation();
  const selected = matching[0]!;
  const resolved = cloneCircle(selected);
  for (const candidate of canonicalOrder(competing)) {
    for (const [needID, need] of Object.entries(candidate.needs)) {
      if (!(needID in resolved.needs)) resolved.needs[needID] = cloneNeed(need);
    }
    for (const [key, value] of Object.entries(candidate.communicationState)) {
      if (!(key in resolved.communicationState))
        resolved.communicationState[key] = value;
    }
  }
  resolved.presence = { state, operationID };
  return resolved;
}

function resolveNeedParent(
  competing: PlanNeed[],
  selectedParentOperationID: string,
  operationID: string,
  state: "active" | "removed" = "active",
): PlanNeed {
  const matching = competing.filter(
    (candidate) => candidate.rootOperationID === selectedParentOperationID,
  );
  if (matching.length !== 1) throw invalidOperation();
  const selected = matching[0]!;
  const resolved = cloneNeed(selected);
  for (const candidate of canonicalOrder(competing)) {
    for (const [buyerUserID, quantity] of Object.entries(
      candidate.buyerAllocations,
    )) {
      if (!(buyerUserID in resolved.buyerAllocations))
        resolved.buyerAllocations[buyerUserID] = quantity;
    }
  }
  resolved.presence = { state, operationID };
  return resolved;
}

function mergeDisjointCircleDescendants(
  resolved: PlanCircle,
  competing: PlanCircle[],
): void {
  for (const candidate of canonicalOrder(competing)) {
    for (const [needID, need] of Object.entries(candidate.needs)) {
      if (!(needID in resolved.needs)) resolved.needs[needID] = cloneNeed(need);
      else mergeDisjointNeedAllocations(resolved.needs[needID]!, [need]);
    }
    for (const [key, value] of Object.entries(candidate.communicationState))
      if (!(key in resolved.communicationState))
        resolved.communicationState[key] = value;
  }
}

function mergeDisjointNeedAllocations(
  resolved: PlanNeed,
  competing: PlanNeed[],
): void {
  for (const candidate of canonicalOrder(competing))
    for (const [buyerUserID, quantity] of Object.entries(
      candidate.buyerAllocations,
    ))
      if (!(buyerUserID in resolved.buyerAllocations))
        resolved.buyerAllocations[buyerUserID] = quantity;
}

function canonicalOrder<T extends object>(values: T[]): T[] {
  return values
    .slice()
    .sort((left, right) =>
      canonicalJSON(plainValue(left)).localeCompare(
        canonicalJSON(plainValue(right)),
      ),
    );
}

function cloneCircle(value: PlanCircle): PlanCircle {
  return {
    comiketNo: value.comiketNo,
    WCID: value.WCID,
    rootOperationID: String(value.rootOperationID),
    presence: {
      state: value.presence.state,
      operationID: String(value.presence.operationID),
    },
    memo: String(value.memo),
    needs: Object.fromEntries(
      Object.entries(value.needs).map(([needID, need]) => [
        needID,
        cloneNeed(need),
      ]),
    ),
    communicationState: Object.fromEntries(
      Object.entries(value.communicationState),
    ),
  };
}

function cloneNeed(value: PlanNeed): PlanNeed {
  return {
    rootOperationID: String(value.rootOperationID),
    presence: {
      state: value.presence.state,
      operationID: String(value.presence.operationID),
    },
    requesterUserID: String(value.requesterUserID),
    ...(value.itemName === undefined
      ? {}
      : {
          itemName: String(value.itemName),
          unitPrice: value.unitPrice ?? null,
        }),
    wantedQuantity: value.wantedQuantity,
    buyerAllocations: Object.fromEntries(
      Object.entries(value.buyerAllocations),
    ),
    fulfilledQuantity: value.fulfilledQuantity,
  };
}

function forceParentWrite<T extends object>(
  object: Record<string, T>,
  key: string,
  value: T,
): void {
  delete object[key];
  writeStoredValue(object, key, value);
}

async function assertParentResolutionDoesNotCollapseNestedConflicts(
  document: Automerge.Doc<PlanDocument>,
  operation: PlanOperation,
): Promise<void> {
  if (
    operation.type !== "shared_plan.circle.resolve_parent.v1" &&
    operation.type !== "shared_plan.need.resolve_parent.v1"
  )
    return;
  const circleKey = String(
    requiredInteger(operation.payload.wcID, 1, Number.MAX_SAFE_INTEGER),
  );
  const parentPath: string[] = ["circles", circleKey];
  let parentConflicts = Automerge.getConflicts(document.circles, circleKey);
  if (operation.type === "shared_plan.need.resolve_parent.v1") {
    if (
      !document.circles[circleKey] ||
      hasRegisterConflict(document.circles, circleKey)
    )
      throw invalidOperation();
    const needID = requiredUUID(operation.payload.needID);
    parentPath.push("needs", needID);
    parentConflicts = Automerge.getConflicts(
      document.circles[circleKey]!.needs,
      needID,
    );
  }
  if (!parentConflicts || Object.keys(parentConflicts).length <= 1)
    throw invalidOperation();
  const resolutions = requiredNestedConflictResolutions(
    operation.payload.nestedResolutions,
  );
  const changeByOperation = changeHashByOperationID(document);
  const selectedParentOperationID = requiredUUID(
    operation.payload.selectedParentOperationID,
  );
  const roots = Object.keys(parentConflicts).map((operationID) => {
    const hash = changeByOperation.get(operationID);
    if (!hash) throw invalidOperation();
    return hash;
  });
  const graph = changeAncestry(document);
  const parentValues: Array<PlanCircle | PlanNeed> = [];
  for (const root of roots) {
    const frontier = graph.exclusiveFrontier(
      root,
      roots.filter((other) => other !== root),
    );
    if (frontier.length === 0) throw invalidOperation();
    const branch = Automerge.view(document, frontier);
    const parentValue = valueAtDocumentPath(branch, parentPath);
    if (
      parentValue === null ||
      typeof parentValue !== "object" ||
      !("presence" in parentValue)
    )
      throw invalidOperation();
    parentValues.push(parentValue as PlanCircle | PlanNeed);
  }
  const selectedParents = parentValues.filter(
    (value) => value.rootOperationID === selectedParentOperationID,
  );
  if (selectedParents.length !== 1) throw invalidOperation();
  const selectedParent = selectedParents[0]!;
  const selectedParentIndex = parentValues.indexOf(selectedParent);
  const selectedParentRootHash = roots[selectedParentIndex]!;
  const nestedByID = new Map<
    string,
    PlanConflict & { valuesByChangeHash: Map<string, unknown> }
  >();
  for (const conflict of await nestedConflictsInParentValues(
    parentValues,
    parentPath,
    changeByOperation,
  )) {
    if (
      conflict.path.length === parentPath.length + 1 &&
      conflict.path[conflict.path.length - 1] === "presence"
    )
      continue;
    nestedByID.set(conflict.conflictID, conflict);
  }
  for (const conflict of await overlappingParentDescendantConflicts(
    parentValues,
    selectedParent,
    roots,
    parentPath,
    changeByOperation,
    operation.type,
  ))
    nestedByID.set(conflict.conflictID, conflict);
  if (resolutions.length !== nestedByID.size) throw invalidOperation();
  const seen = new Set<string>();
  for (const resolution of resolutions) {
    if (seen.has(resolution.conflictID)) throw invalidOperation();
    seen.add(resolution.conflictID);
    const conflict = nestedByID.get(resolution.conflictID);
    if (
      !conflict ||
      canonicalJSON(conflict.path) !== canonicalJSON(resolution.path)
    )
      throw invalidOperation();
  }
  const conflictsByPath = new Map<
    string,
    Array<PlanConflict & { valuesByChangeHash: Map<string, unknown> }>
  >();
  for (const conflict of nestedByID.values()) {
    const key = canonicalJSON(conflict.path);
    const grouped = conflictsByPath.get(key) ?? [];
    grouped.push(conflict);
    conflictsByPath.set(key, grouped);
  }
  const resolutionsByPath = new Map<string, NestedConflictResolution[]>();
  for (const resolution of resolutions) {
    const key = canonicalJSON(resolution.path);
    const grouped = resolutionsByPath.get(key) ?? [];
    grouped.push(resolution);
    resolutionsByPath.set(key, grouped);
  }
  for (const [key, conflicts] of conflictsByPath) {
    const grouped = resolutionsByPath.get(key);
    if (!grouped || grouped.length !== conflicts.length)
      throw invalidOperation();
    const selectedHash = grouped[0]!.selectedChangeHash;
    const selectedValue = grouped[0]!.value;
    if (
      grouped.some(
        (resolution) =>
          resolution.selectedChangeHash !== selectedHash ||
          canonicalJSON(resolution.value) !== canonicalJSON(selectedValue),
      )
    )
      throw invalidOperation();
    const selectedAssignments = assignmentsAtPath(
      selectedParent,
      parentPath,
      conflicts[0]!.path,
      changeByOperation,
      selectedParentRootHash,
    );
    const allowed =
      selectedAssignments.size > 0
        ? selectedAssignments
        : new Map(
            conflicts.flatMap((conflict) => [
              ...conflict.valuesByChangeHash.entries(),
            ]),
          );
    if (
      !allowed.has(selectedHash) ||
      canonicalJSON(allowed.get(selectedHash)) !== canonicalJSON(selectedValue)
    )
      throw invalidOperation();
  }
}

function valueAtDocumentPath(
  document: Automerge.Doc<PlanDocument>,
  path: string[],
): unknown {
  let value: unknown = document;
  for (const part of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

async function nestedConflictsInParentValues(
  values: object[],
  parentPath: string[],
  changeByOperation: ReadonlyMap<string, string>,
): Promise<Array<PlanConflict & { valuesByChangeHash: Map<string, unknown> }>> {
  const descriptors = new Map<
    string,
    { path: string[]; valuesByChangeHash: Map<string, unknown> }
  >();
  const visited = new Set<string>();
  const visit = (value: unknown, path: string[]) => {
    if (
      value === null ||
      typeof value !== "object" ||
      value instanceof Automerge.ImmutableString
    )
      return;
    const objectID = Automerge.getObjectId(value);
    const visitID = objectID ? `${canonicalJSON(path)}:${objectID}` : null;
    if (visitID && visited.has(visitID)) return;
    if (visitID) visited.add(visitID);
    for (const key of Object.keys(value as object)) {
      const childPath = [...path, key];
      const competing = Automerge.getConflicts(value as object, key);
      if (competing && Object.keys(competing).length > 1) {
        const valuesByChangeHash = new Map<string, unknown>();
        for (const [operationID, competingValue] of Object.entries(competing)) {
          const hash = changeByOperation.get(operationID);
          if (!hash) throw invalidOperation();
          valuesByChangeHash.set(hash, plainValue(competingValue));
        }
        const changeHashes = Array.from(valuesByChangeHash.keys()).sort();
        if (changeHashes.length > 1) {
          const key = canonicalJSON({ path: childPath, changeHashes });
          const existing = descriptors.get(key);
          if (existing) {
            for (const [hash, competingValue] of valuesByChangeHash)
              existing.valuesByChangeHash.set(hash, competingValue);
          } else {
            descriptors.set(key, { path: childPath, valuesByChangeHash });
          }
        }
        visit((value as Record<string, unknown>)[key], childPath);
      } else {
        visit((value as Record<string, unknown>)[key], childPath);
      }
    }
  };
  for (const value of values) visit(value, parentPath);
  return Promise.all(
    Array.from(descriptors.values()).map(async (descriptor) => {
      const changeHashes = Array.from(
        descriptor.valuesByChangeHash.keys(),
      ).sort();
      return {
        conflictID: await sha256Hex(
          canonicalJSON({
            schemaVersion: 1,
            path: descriptor.path,
            changeHashes,
          }),
        ),
        path: descriptor.path,
        changeHashes,
        valuesByChangeHash: descriptor.valuesByChangeHash,
      };
    }),
  );
}

function assignmentsAtPath(
  parentValue: object,
  parentPath: string[],
  absolutePath: Array<string | number>,
  changeByOperation: ReadonlyMap<string, string>,
  fallbackHash: string,
): Map<string, unknown> {
  if (
    absolutePath.length <= parentPath.length ||
    parentPath.some((part, index) => absolutePath[index] !== part)
  )
    throw invalidOperation();
  const relative = absolutePath.slice(parentPath.length).map(String);
  let parent: unknown = parentValue;
  for (const part of relative.slice(0, -1)) {
    if (parent === null || typeof parent !== "object") return new Map();
    if (!(part in parent)) return new Map();
    parent = (parent as Record<string, unknown>)[part];
  }
  if (parent === null || typeof parent !== "object") return new Map();
  const key = relative[relative.length - 1]!;
  if (!(key in parent)) return new Map();
  const competing = Automerge.getConflicts(parent as object, key);
  if (!competing || Object.keys(competing).length === 0)
    return new Map([
      [fallbackHash, plainValue((parent as Record<string, unknown>)[key])],
    ]);
  const result = new Map<string, unknown>();
  for (const [operationID, value] of Object.entries(competing)) {
    const hash = changeByOperation.get(operationID);
    if (!hash) throw invalidOperation();
    result.set(hash, plainValue(value));
  }
  return result;
}

async function overlappingParentDescendantConflicts(
  parentValues: Array<PlanCircle | PlanNeed>,
  selectedParent: PlanCircle | PlanNeed,
  parentRootHashes: string[],
  parentPath: string[],
  changeByOperation: ReadonlyMap<string, string>,
  operationType:
    | "shared_plan.circle.resolve_parent.v1"
    | "shared_plan.need.resolve_parent.v1",
): Promise<Array<PlanConflict & { valuesByChangeHash: Map<string, unknown> }>> {
  const paths: string[][] = [];
  if (operationType === "shared_plan.circle.resolve_parent.v1") {
    const circles = parentValues as PlanCircle[];
    const selected = selectedParent as PlanCircle;
    const communicationKeys = new Set(
      circles.flatMap((circle) => Object.keys(circle.communicationState)),
    );
    for (const key of communicationKeys)
      if (!(key in selected.communicationState))
        paths.push([...parentPath, "communicationState", key]);
    const needIDs = new Set(
      circles.flatMap((circle) => Object.keys(circle.needs)),
    );
    for (const needID of needIDs)
      if (!(needID in selected.needs))
        paths.push([...parentPath, "needs", needID]);
  } else {
    const needs = parentValues as PlanNeed[];
    const selected = selectedParent as PlanNeed;
    const buyerIDs = new Set(
      needs.flatMap((need) => Object.keys(need.buyerAllocations)),
    );
    for (const buyerID of buyerIDs)
      if (!(buyerID in selected.buyerAllocations))
        paths.push([...parentPath, "buyerAllocations", buyerID]);
  }
  const results: Array<
    PlanConflict & { valuesByChangeHash: Map<string, unknown> }
  > = [];
  for (const path of paths) {
    const valuesByChangeHash = new Map<string, unknown>();
    for (const [index, value] of parentValues.entries())
      for (const [hash, candidate] of assignmentsAtPath(
        value,
        parentPath,
        path,
        changeByOperation,
        parentRootHashes[index]!,
      ))
        valuesByChangeHash.set(hash, candidate);
    const distinct = new Set(
      Array.from(valuesByChangeHash.values(), (value) => canonicalJSON(value)),
    );
    if (distinct.size <= 1) continue;
    const changeHashes = Array.from(valuesByChangeHash.keys()).sort();
    results.push({
      conflictID: await sha256Hex(
        canonicalJSON({ schemaVersion: 1, path, changeHashes }),
      ),
      path,
      changeHashes,
      valuesByChangeHash,
    });
  }
  return results;
}

function applyNestedConflictResolutions(
  parent: object,
  parentPath: string[],
  resolutions: readonly NestedConflictResolution[],
  structural: boolean,
): void {
  const byPath = new Map<string, NestedConflictResolution>();
  for (const resolution of resolutions) {
    const key = canonicalJSON(resolution.path);
    const existing = byPath.get(key);
    if (
      existing &&
      (existing.selectedChangeHash !== resolution.selectedChangeHash ||
        canonicalJSON(existing.value) !== canonicalJSON(resolution.value))
    )
      throw invalidOperation();
    byPath.set(key, resolution);
  }
  for (const resolution of Array.from(byPath.values()).sort(
    (left, right) => left.path.length - right.path.length,
  )) {
    if (isPlainRecord(resolution.value) !== structural) continue;
    if (
      resolution.path.length <= parentPath.length ||
      parentPath.some((part, index) => resolution.path[index] !== part)
    )
      throw invalidOperation();
    const relative = resolution.path.slice(parentPath.length);
    let target: unknown = parent;
    for (const part of relative.slice(0, -1)) {
      if (target === null || typeof target !== "object")
        throw invalidOperation();
      target = (target as Record<string, unknown>)[part];
    }
    if (target === null || typeof target !== "object") throw invalidOperation();
    const key = relative[relative.length - 1]!;
    (target as Record<string, unknown>)[key] = cloneResolutionValue(
      resolution.value,
    );
  }
}

function cloneResolutionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneResolutionValue);
  if (isPlainRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        cloneResolutionValue(child),
      ]),
    );
  return value;
}

function forceRegisterWrite(
  _draft: PlanDocument,
  object: object,
  key: string,
  value: CommunicationValue,
): void {
  const register = object as Record<string, CommunicationValue>;
  delete register[key];
  writeStoredValue(register, key, value);
}

function writeStoredValue(object: object, key: string, value: unknown): void {
  const target = object as Record<string, unknown>;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    target[key] = new Automerge.Int(value);
  } else if (Array.isArray(value)) {
    target[key] = [];
    const stored = target[key] as unknown[];
    for (const child of value) appendStoredValue(stored, child);
  } else if (isPlainRecord(value)) {
    target[key] = {};
    const stored = target[key] as Record<string, unknown>;
    for (const [childKey, child] of Object.entries(value))
      writeStoredValue(stored, childKey, child);
  } else {
    target[key] = value;
  }
}

function appendStoredValue(values: unknown[], value: unknown): void {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    values.push(new Automerge.Int(value));
  } else if (Array.isArray(value)) {
    values.push([]);
    const stored = values[values.length - 1] as unknown[];
    for (const child of value) appendStoredValue(stored, child);
  } else if (isPlainRecord(value)) {
    values.push({});
    const stored = values[values.length - 1] as Record<string, unknown>;
    for (const [key, child] of Object.entries(value))
      writeStoredValue(stored, key, child);
  } else {
    values.push(value);
  }
}

async function semanticConflict(
  path: Array<string | number>,
  leftHash: string,
  rightHash: string,
): Promise<PlanConflict> {
  const changeHashes = [leftHash, rightHash].sort();
  return {
    conflictID: await sha256Hex(
      canonicalJSON({ schemaVersion: 1, path, changeHashes }),
    ),
    path,
    changeHashes,
  };
}

type DecodedDocumentChange = ReturnType<typeof Automerge.decodeChange>;

function decodedDocumentChanges(
  document: Automerge.Doc<PlanDocument>,
): DecodedDocumentChange[] {
  return Automerge.getAllChanges(document).map((bytes) =>
    Automerge.decodeChange(bytes),
  );
}

function changeAncestry(
  document: Automerge.Doc<PlanDocument>,
  decodedChanges?: readonly DecodedDocumentChange[],
): {
  concurrent(left: string, right: string): boolean;
  descendsFromBoth(descendant: string, left: string, right: string): boolean;
  descendsFrom(descendant: string, ancestor: string): boolean;
  exclusiveFrontier(root: string, excludedRoots: readonly string[]): string[];
} {
  const decoded = decodedChanges ?? decodedDocumentChanges(document);
  const byHash = new Map(decoded.map((change) => [change.hash, change]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const change of decoded) {
    indegree.set(change.hash, change.deps.length);
    for (const dependency of change.deps) {
      if (!byHash.has(dependency)) throw invalidOperation();
      const children = dependents.get(dependency) ?? [];
      children.push(change.hash);
      dependents.set(dependency, children);
    }
  }
  const ready = decoded
    .filter((change) => change.deps.length === 0)
    .map((change) => change.hash);
  let visited = 0;
  while (ready.length > 0) {
    const hash = ready.pop()!;
    visited += 1;
    for (const dependent of dependents.get(hash) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  if (visited !== decoded.length) throw invalidOperation();
  const ancestry = new Map<string, Set<string>>();
  const ancestors = (descendant: string): Set<string> => {
    const cached = ancestry.get(descendant);
    if (cached) return cached;
    if (!byHash.has(descendant)) throw invalidOperation();
    const result = new Set<string>();
    const pending = [descendant];
    while (pending.length > 0) {
      const hash = pending.pop()!;
      if (result.has(hash)) continue;
      result.add(hash);
      const change = byHash.get(hash);
      if (!change) throw invalidOperation();
      pending.push(...change.deps);
    }
    ancestry.set(descendant, result);
    return result;
  };
  const includes = (ancestor: string, descendant: string): boolean => {
    if (!byHash.has(ancestor)) throw invalidOperation();
    return ancestors(descendant).has(ancestor);
  };
  return {
    concurrent: (left, right) =>
      left !== right && !includes(left, right) && !includes(right, left),
    descendsFromBoth: (descendant, left, right) =>
      descendant !== left &&
      descendant !== right &&
      includes(left, descendant) &&
      includes(right, descendant),
    descendsFrom: (descendant, ancestor) => includes(ancestor, descendant),
    exclusiveFrontier: (root, excludedRoots) => {
      const candidates = new Set(
        decoded
          .map((change) => change.hash)
          .filter(
            (hash) =>
              includes(root, hash) &&
              excludedRoots.every((excluded) => !includes(excluded, hash)),
          ),
      );
      return Array.from(candidates)
        .filter((hash) =>
          (dependents.get(hash) ?? []).every(
            (dependent) => !candidates.has(dependent),
          ),
        )
        .sort();
    },
  };
}

function changeHashByOperationID(
  document: Automerge.Doc<PlanDocument>,
  decodedChanges?: readonly DecodedDocumentChange[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const change of decodedChanges ?? decodedDocumentChanges(document)) {
    for (let offset = 0; offset < change.ops.length; offset += 1) {
      result.set(`${change.startOp + offset}@${change.actor}`, change.hash);
    }
  }
  return result;
}

function requiredActiveCircle(value: PlanCircle | undefined): PlanCircle {
  if (!value || value.presence.state !== "active") throw invalidOperation();
  return value;
}

function requiredNeed(
  circle: PlanCircle | undefined,
  value: unknown,
): PlanNeed {
  const active = requiredActiveCircle(circle);
  const need = active.needs[requiredUUID(value)];
  if (!need || need.presence.state !== "active") throw invalidOperation();
  return need;
}

function requiredQuantity(value: unknown): number {
  return requiredInteger(value, 0, maximumQuantity);
}

function requiredItemName(value: unknown): string {
  const itemName = requiredString(value, maximumItemNameBytes).trim();
  if (
    itemName.length === 0 ||
    Array.from(itemName).length > maximumItemNameCharacters
  ) {
    throw invalidOperation();
  }
  return itemName;
}

function requiredOptionalUnitPrice(value: unknown): number | null {
  if (value === null) return null;
  return requiredInteger(value, 0, maximumUnitPrice);
}

function requiredInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (!isSafeInteger(value, minimum, maximum)) throw invalidOperation();
  return value;
}

function requiredString(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || utf8Bytes(value) > maximumBytes)
    throw invalidOperation();
  return value;
}

function requiredUUID(value: unknown): string {
  if (!isCanonicalSyncUUID(value)) throw invalidOperation();
  return value;
}

function requiredPublicID(value: unknown): string {
  if (typeof value !== "string" || !publicIDPattern.test(value))
    throw invalidOperation();
  return value;
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  options: T,
): T[number] {
  if (typeof value !== "string" || !options.includes(value))
    throw invalidOperation();
  return value as T[number];
}

function requiredCommunicationValue(value: unknown): CommunicationValue {
  if (!isCommunicationValue(value)) throw invalidOperation();
  if (typeof value === "string" && utf8Bytes(value) > 4_096)
    throw invalidOperation();
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw invalidOperation();
  return value;
}

function requiredNestedConflictResolutions(
  value: unknown,
): NestedConflictResolution[] {
  if (!Array.isArray(value) || value.length > maximumConflicts)
    throw invalidOperation();
  return value.map((item) => {
    if (
      !isPlainRecord(item) ||
      !hasExactKeys(item, [
        "conflictID",
        "path",
        "selectedChangeHash",
        "value",
      ]) ||
      typeof item.conflictID !== "string" ||
      !changeHashPattern.test(item.conflictID) ||
      typeof item.selectedChangeHash !== "string" ||
      !changeHashPattern.test(item.selectedChangeHash) ||
      !Array.isArray(item.path) ||
      item.path.length < 1 ||
      item.path.length > 16 ||
      item.path.some(
        (part) =>
          typeof part !== "string" || part.length < 1 || part.length > 64,
      )
    )
      throw invalidOperation();
    return {
      conflictID: item.conflictID,
      path: item.path.slice() as string[],
      selectedChangeHash: item.selectedChangeHash,
      value: requiredResolutionValue(item.value),
    };
  });
}

function requiredResolutionValue(value: unknown): unknown {
  const plain = plainValue(value);
  const visit = (item: unknown, depth: number): void => {
    if (depth > 16) throw invalidOperation();
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isSafeInteger(item))
    )
      return;
    if (typeof item === "string") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (isPlainRecord(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (key.length < 1 || key.length > 128) throw invalidOperation();
        visit(child, depth + 1);
      }
      return;
    }
    throw invalidOperation();
  };
  visit(plain, 0);
  if (utf8Bytes(canonicalJSON(plain)) > maximumSavedDocumentBytes)
    throw invalidOperation();
  return plain;
}

function isCommunicationValue(value: unknown): value is CommunicationValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function exactPayload(payload: Record<string, unknown>, keys: string[]): void {
  if (!hasExactKeys(payload, keys)) throw invalidOperation();
}

function hasExactKeys(value: object, keys: string[]): boolean {
  return (
    canonicalJSON(Object.keys(value).sort()) ===
    canonicalJSON(keys.slice().sort())
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isOperationType(value: unknown): value is PlanOperationType {
  return [
    "shared_plan.circle.presence.v1",
    "shared_plan.circle.resolve_parent.v1",
    "shared_plan.circle.memo.splice.v1",
    "shared_plan.need.create.v1",
    "shared_plan.need.delete.v1",
    "shared_plan.need.resolve_parent.v1",
    "shared_plan.need.wanted_quantity.v1",
    "shared_plan.need.buyer_allocation.v1",
    "shared_plan.need.fulfilled_quantity.v1",
    "shared_plan.circle.communication.set.v1",
  ].includes(String(value));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sortedHeads(document: Automerge.Doc<unknown>): string[] {
  return Automerge.getHeads(document).slice().sort();
}

function invalidDocument(): PlanDocumentError {
  return new PlanDocumentError("invalid_plan_document");
}

function invalidOperation(
  reason?: PlanOperationRejectionReason,
): PlanDocumentError {
  return new PlanDocumentError(
    "invalid_plan_operation",
    reason
      ? {
          reason,
          recovery: "export_and_rebuild_local_copy",
          localChangesPreserved: true,
          supportCode: operationRejectionSupportCode(reason),
        }
      : undefined,
  );
}

function withInvalidOperationReason<T>(
  reason: PlanOperationRejectionReason,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof PlanDocumentError &&
      error.code === "invalid_plan_operation" &&
      !error.details?.reason
    ) {
      throw invalidOperation(reason);
    }
    throw error;
  }
}

async function withInvalidOperationReasonAsync<T>(
  reason: PlanOperationRejectionReason,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof PlanDocumentError &&
      error.code === "invalid_plan_operation" &&
      !error.details?.reason
    ) {
      throw invalidOperation(reason);
    }
    throw error;
  }
}

function operationRejectionSupportCode(
  reason: PlanOperationRejectionReason,
): string {
  const codes: Record<PlanOperationRejectionReason, string> = {
    change_set: "SP-OP-101",
    change_order: "SP-OP-102",
    change_binding: "SP-OP-103",
    change_application: "SP-OP-104",
    operation_binding: "SP-OP-201",
    operation_payload: "SP-OP-202",
    member_reference: "SP-OP-203",
    parent_resolution: "SP-OP-301",
    exact_change_proof: "SP-OP-302",
    final_consistency: "SP-OP-401",
  };
  return codes[reason];
}

function documentLimit(): PlanDocumentError {
  return new PlanDocumentError("plan_document_limit");
}
