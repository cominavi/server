import { z } from "zod";
import {
  assertPlanMember,
  createSharedPlan,
  listSharedPlans,
  loadSharedPlan,
  parseCreatePlan,
  parsePlanArchive,
  parsePlanUpdate,
  updateSharedPlan,
  type CollectionPage,
} from "../lib/server/shared-plans";
import { ServiceError } from "../lib/server/service-error";
import { authenticatedProcedure, type AuthenticatedAPIContext } from "./core";

export const canonicalRequestIDSchema = z.uuid();
export const planIDSchema = z.uuid();
export const publicUserIDSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{12}$/);
export const isoDateSchema = z.iso.datetime();

export const planSchema = z.object({
  id: planIDSchema,
  name: z.string().min(1).max(100),
  comiketNo: z.number().int().positive().max(10_000),
  role: z.enum(["owner", "editor"]),
  status: z.enum(["active", "archived"]),
  revision: z.number().int().positive(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

export const mutationReceiptSchema = z.object({
  requestId: canonicalRequestIDSchema,
  replayed: z.boolean(),
  resultRevision: z.number().int().positive(),
  resultStatus: z.enum(["active", "archived"]),
});

export const planMutationResultSchema = z.object({
  plan: planSchema,
  receipt: mutationReceiptSchema,
});

export const collectionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(1_024).optional(),
});

export const planPathSchema = z.object({ planID: planIDSchema });

export const membershipMutationSchema = z.object({
  requestId: canonicalRequestIDSchema,
  baseRevision: z.number().int().positive(),
});

export const syncSnapshotSchema = z.object({
  v: z.literal(1),
  document: z.string().regex(/^[A-Za-z0-9_-]+$/),
  heads: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
});

export const listSharedPlansOperation = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/plans",
    operationId: "listSharedPlans",
    summary: "List Shared Plans",
    description:
      "Lists active and archived Shared Plans visible to the authenticated member in stable cursor order.",
    tags: ["Shared Plans"],
    inputStructure: "detailed",
  })
  .input(z.object({ query: collectionQuerySchema }))
  .output(
    z.object({
      items: z.array(planSchema),
      nextCursor: z.string().min(1).optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    const result = await listSharedPlans(
      context.env.COMINAVI_DB,
      context.identity,
      collectionPage(input.query),
    );
    return {
      items: result.items,
      nextCursor: result.nextCursor ?? undefined,
    };
  });

export const createSharedPlanOperation = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/plans",
    operationId: "createSharedPlan",
    summary: "Create a Shared Plan",
    description:
      "Creates a plan with a payload-bound request receipt and returns the initial HTTP Automerge snapshot. Exact retries recover the same plan receipt.",
    tags: ["Shared Plans"],
    successStatus: 201,
  })
  .input(
    z.object({
      requestId: canonicalRequestIDSchema,
      name: z.string().trim().min(1).max(100),
      comiketNo: z.number().int().positive().max(10_000),
    }),
  )
  .output(
    planMutationResultSchema.extend({ syncBootstrap: syncSnapshotSchema }),
  )
  .handler(async ({ context, input }) => {
    const result = await createSharedPlan(
      context.env.COMINAVI_DB,
      context.identity,
      parseCreatePlan(input),
    );
    return {
      ...result,
      syncBootstrap: await loadPlanSyncSnapshot(context, result.plan.id),
    };
  });

export const getSharedPlan = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/plans/{planID}",
    operationId: "getSharedPlan",
    summary: "Get a Shared Plan",
    tags: ["Shared Plans"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: planPathSchema }))
  .output(z.object({ plan: planSchema }))
  .handler(async ({ context, input }) => ({
    plan: await loadSharedPlan(
      context.env.COMINAVI_DB,
      context.identity,
      input.params.planID,
    ),
  }));

export const updateSharedPlanOperation = authenticatedProcedure
  .route({
    method: "PATCH",
    path: "/api/v2/plans/{planID}",
    operationId: "updateSharedPlan",
    summary: "Update a Shared Plan",
    description:
      "Updates plan metadata or archive state using an optimistic revision and exact request receipt.",
    tags: ["Shared Plans"],
    inputStructure: "detailed",
  })
  .input(
    z.object({
      params: planPathSchema,
      body: membershipMutationSchema
        .extend({
          name: z.string().trim().min(1).max(100).optional(),
          archived: z.boolean().optional(),
        })
        .refine(
          (body) => body.name !== undefined || body.archived !== undefined,
        ),
    }),
  )
  .output(planMutationResultSchema)
  .handler(async ({ context, input }) => {
    const result = await updateSharedPlan(
      context.env.COMINAVI_DB,
      context.identity,
      input.params.planID,
      parsePlanUpdate(input.body),
    );
    if (result.plan.status === "archived") {
      await fencePlan(context.env, input.params.planID);
    }
    return result;
  });

export const archiveSharedPlan = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/api/v2/plans/{planID}",
    operationId: "archiveSharedPlan",
    summary: "Archive a Shared Plan",
    description:
      "Archives the plan using an optimistic revision, revokes invitations, and fences active sync sessions. This does not delete retained CRDT history.",
    tags: ["Shared Plans"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: planPathSchema, body: membershipMutationSchema }))
  .output(planMutationResultSchema)
  .handler(async ({ context, input }) => {
    const result = await updateSharedPlan(
      context.env.COMINAVI_DB,
      context.identity,
      input.params.planID,
      parsePlanArchive(input.body),
    );
    await fencePlan(context.env, input.params.planID);
    return result;
  });

export const getSharedPlanSyncSnapshot = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/plans/{planID}/sync",
    operationId: "getSharedPlanSyncSnapshot",
    summary: "Get Shared Plan sync snapshot",
    description:
      "Returns the current JSON-encoded Automerge bootstrap snapshot. The binary WebSocket sync protocol is a separate transport and is intentionally not represented by this OpenAPI operation.",
    tags: ["Shared Plan Sync"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: planPathSchema }))
  .output(syncSnapshotSchema)
  .handler(({ context, input }) =>
    loadPlanSyncSnapshot(context, input.params.planID),
  );

export const sharedPlanResourceRouter = {
  list: listSharedPlansOperation,
  create: createSharedPlanOperation,
  get: getSharedPlan,
  update: updateSharedPlanOperation,
  archive: archiveSharedPlan,
  syncSnapshot: getSharedPlanSyncSnapshot,
};

export function collectionPage(input: {
  limit: number;
  cursor?: string;
}): CollectionPage {
  return { limit: input.limit, cursor: input.cursor ?? null };
}

export function normalizeMemberPage(result: {
  items: unknown[];
  nextCursor: string | null;
}) {
  return {
    items: result.items.map((item) => {
      const member = item as {
        userID: string;
        displayName: string;
        avatarURL: string | null;
        role: "owner" | "editor";
        membershipStatus: "active" | "removed";
        joinedAt: string;
        removedAt: string | null;
      };
      return {
        ...member,
        avatarURL: member.avatarURL ?? undefined,
        removedAt: member.removedAt ?? undefined,
      };
    }),
    nextCursor: result.nextCursor ?? undefined,
  };
}

export function normalizeInvitationPage(result: {
  items: unknown[];
  nextCursor: string | null;
}) {
  return {
    items: result.items.map((item) => {
      const invitation = item as {
        invitationID: string;
        createdByUserID: string;
        currentUserCanRevoke: boolean;
        expiresAt: string;
        revokedAt: string | null;
        createdAt: string;
      };
      return { ...invitation, revokedAt: invitation.revokedAt ?? undefined };
    }),
    nextCursor: result.nextCursor ?? undefined,
  };
}

export async function loadPlanSyncSnapshot(
  context: AuthenticatedAPIContext,
  planID: string,
): Promise<z.infer<typeof syncSnapshotSchema>> {
  const membership = await assertPlanMember(
    context.env.COMINAVI_DB,
    context.identity.userID,
    planID,
  );
  let response: Response;
  try {
    response = await planSyncStub(context.env, planID).fetch(
      "https://plan-sync.internal/snapshot",
      {
        method: "GET",
        headers: planAuthorityHeaders(context, planID, membership.comiketNo),
      },
    );
  } catch {
    throw planSyncUnavailable("snapshot");
  }
  if (!response.ok) throw planSyncUnavailable("snapshot");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw planSyncUnavailable("snapshot");
  }
  const parsed = syncSnapshotSchema.safeParse(payload);
  if (!parsed.success) throw planSyncUnavailable("snapshot");
  return parsed.data;
}

export async function fencePlan(
  env: Cloudflare.Env,
  planID: string,
): Promise<void> {
  let response: Response;
  try {
    response = await planSyncStub(env, planID).fetch(
      "https://plan-sync.internal/fence",
      { method: "POST" },
    );
  } catch {
    throw planSyncUnavailable("fence");
  }
  if (!response.ok) throw planSyncUnavailable("fence");
}

export async function fencePlanMember(
  env: Cloudflare.Env,
  planID: string,
  userPublicID: string,
): Promise<void> {
  let response: Response;
  try {
    response = await planSyncStub(env, planID).fetch(
      "https://plan-sync.internal/fence-member",
      {
        method: "POST",
        headers: { "X-ComiNavi-User-Public-ID": userPublicID },
      },
    );
  } catch {
    throw planSyncUnavailable("member_fence");
  }
  if (!response.ok) throw planSyncUnavailable("member_fence");
}

function planSyncStub(env: Cloudflare.Env, planID: string) {
  return env.COMINAVI_PLAN_SYNC.get(env.COMINAVI_PLAN_SYNC.idFromName(planID));
}

function planAuthorityHeaders(
  context: AuthenticatedAPIContext,
  planID: string,
  comiketNo: number,
): HeadersInit {
  return {
    "X-ComiNavi-User-ID": String(context.identity.userID),
    "X-ComiNavi-User-Public-ID": context.identity.subject,
    "X-ComiNavi-Auth-Version": String(context.identity.authVersion),
    "X-ComiNavi-Plan-ID": planID,
    "X-ComiNavi-Comiket-No": String(comiketNo),
  };
}

function planSyncUnavailable(action: string): ServiceError {
  return new ServiceError(
    "plan_sync_unavailable",
    503,
    "Shared Plan synchronization is temporarily unavailable.",
    { action },
  );
}
