import { z } from "zod";
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  listPlanMembers,
  parseInvitationCreate,
  parseMembershipMutation,
  parseOwnershipTransfer,
  previewInvitation,
  revokeInvitation,
  setPlanMemberRevoked,
  transferPlanOwnership,
} from "../../lib/server/shared-plans";
import { ServiceError } from "../../lib/server/service-error";
import { authenticatedProcedure, publicProcedure } from "../core";
import {
  canonicalRequestIDSchema,
  collectionPage,
  collectionQuerySchema,
  fencePlan,
  fencePlanMember,
  invitationTokenSchema,
  isoDateSchema,
  membershipMutationSchema,
  mutationReceiptSchema,
  normalizeInvitationPage,
  normalizeMemberPage,
  planIDSchema,
  planMutationResultSchema,
  planPathSchema,
  publicUserIDSchema,
  sharedPlanResourceRouter,
} from "../shared-plans";

const memberPathSchema = planPathSchema.extend({
  userID: publicUserIDSchema,
});

const invitationPathSchema = planPathSchema.extend({
  invitationID: z.uuid(),
});

const memberSchema = z.object({
  userID: publicUserIDSchema,
  displayName: z.string().min(1).max(100),
  avatarURL: z.string().min(1).optional(),
  role: z.enum(["owner", "editor"]),
  membershipStatus: z.enum(["active", "removed"]),
  joinedAt: isoDateSchema,
  removedAt: isoDateSchema.optional(),
});

const invitationSchema = z.object({
  invitationID: z.uuid(),
  createdByUserID: publicUserIDSchema,
  currentUserCanRevoke: z.boolean(),
  expiresAt: isoDateSchema,
  revokedAt: isoDateSchema.optional(),
  createdAt: isoDateSchema,
});

const invitationPreviewSchema = z.object({
  planID: planIDSchema,
  planName: z.string().min(1).max(100),
  comiketNo: z.number().int().positive().max(10_000),
  expiresAt: isoDateSchema,
});

const invitationCreateResultSchema = z.object({
  invitationID: z.uuid(),
  token: invitationTokenSchema,
  expiresAt: isoDateSchema,
  canonicalURL: z.url(),
  fallbackURL: z.string().regex(/^cominavi:\/\/join\/[A-Za-z0-9_-]{12}$/),
  receipt: mutationReceiptSchema,
});

export const previewSharedPlanInvitation = publicProcedure
  .route({
    method: "GET",
    path: "/api/v2/invitations/{token}",
    operationId: "previewSharedPlanInvitation",
    summary: "Preview a Shared Plan invitation",
    description:
      "Returns non-secret plan context for a valid invitation capability. No bearer session is required.",
    tags: ["Shared Plan Invitations"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: z.object({ token: invitationTokenSchema }) }))
  .output(invitationPreviewSchema)
  .handler(async ({ context, input }) => {
    await enforceInvitationRateLimit(context.request, context.env);
    return previewInvitation(
      context.env.COMINAVI_DB,
      input.params.token,
      context.env.COMINAVI_INVITE_TOKEN_SECRET,
    );
  });

export const acceptSharedPlanInvitation = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/invitations/{token}/accept",
    operationId: "acceptSharedPlanInvitation",
    summary: "Accept a Shared Plan invitation",
    description:
      "Admits the authenticated user as an editor and returns an exact payload-bound request receipt. Removed members require owner reinstatement.",
    tags: ["Shared Plan Invitations"],
    inputStructure: "detailed",
  })
  .input(
    z.object({
      params: z.object({ token: invitationTokenSchema }),
      body: z.object({ requestId: canonicalRequestIDSchema }),
    }),
  )
  .output(planMutationResultSchema)
  .handler(async ({ context, input }) => {
    await enforceInvitationRateLimit(context.request, context.env);
    return planMutationResultSchema.parse(
      await acceptInvitation(
        context.env.COMINAVI_DB,
        context.identity,
        input.params.token,
        input.body.requestId,
        context.env.COMINAVI_INVITE_TOKEN_SECRET,
      ),
    );
  });

export const listSharedPlanMembers = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/plans/{planID}/members",
    operationId: "listSharedPlanMembers",
    summary: "List Shared Plan members",
    tags: ["Shared Plan Members"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: planPathSchema, query: collectionQuerySchema }))
  .output(
    z.object({
      items: z.array(memberSchema),
      nextCursor: z.string().min(1).optional(),
    }),
  )
  .handler(async ({ context, input }) =>
    normalizeMemberPage(
      await listPlanMembers(
        context.env.COMINAVI_DB,
        context.identity,
        input.params.planID,
        collectionPage(input.query),
      ),
    ),
  );

export const revokeSharedPlanMember = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/api/v2/plans/{planID}/members/{userID}",
    operationId: "revokeSharedPlanMember",
    summary: "Remove a Shared Plan member",
    description:
      "Owner-only optimistic mutation that advances the membership fence and closes the removed member's live sync sessions.",
    tags: ["Shared Plan Members"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: memberPathSchema, body: membershipMutationSchema }))
  .output(planMutationResultSchema)
  .handler(async ({ context, input }) => {
    const result = await setPlanMemberRevoked(
      context.env.COMINAVI_DB,
      context.identity,
      input.params.planID,
      input.params.userID,
      parseMembershipMutation(input.body),
      true,
    );
    await fencePlanMember(
      context.env,
      input.params.planID,
      input.params.userID,
    );
    return result;
  });

export const reinstateSharedPlanMember = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/plans/{planID}/members/{userID}/reinstate",
    operationId: "reinstateSharedPlanMember",
    summary: "Reinstate a Shared Plan member",
    description:
      "Owner-only optimistic mutation that creates a fresh active membership generation.",
    tags: ["Shared Plan Members"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: memberPathSchema, body: membershipMutationSchema }))
  .output(planMutationResultSchema)
  .handler(({ context, input }) =>
    setPlanMemberRevoked(
      context.env.COMINAVI_DB,
      context.identity,
      input.params.planID,
      input.params.userID,
      parseMembershipMutation(input.body),
      false,
    ),
  );

export const transferSharedPlanOwnership = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/plans/{planID}/transfer-ownership",
    operationId: "transferSharedPlanOwnership",
    summary: "Transfer Shared Plan ownership",
    description:
      "Transfers ownership to an active editor using an optimistic revision and exact request receipt, then fences all sync sessions.",
    tags: ["Shared Plan Members"],
    inputStructure: "detailed",
  })
  .input(
    z.object({
      params: planPathSchema,
      body: membershipMutationSchema.extend({
        newOwnerUserID: publicUserIDSchema,
      }),
    }),
  )
  .output(planMutationResultSchema)
  .handler(async ({ context, input }) => {
    const result = await transferPlanOwnership(
      context.env.COMINAVI_DB,
      context.identity,
      input.params.planID,
      parseOwnershipTransfer(input.body),
    );
    await fencePlan(context.env, input.params.planID);
    return result;
  });

export const listSharedPlanInvitations = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/plans/{planID}/invitations",
    operationId: "listSharedPlanInvitations",
    summary: "List Shared Plan invitations",
    tags: ["Shared Plan Invitations"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: planPathSchema, query: collectionQuerySchema }))
  .output(
    z.object({
      items: z.array(invitationSchema),
      nextCursor: z.string().min(1).optional(),
    }),
  )
  .handler(async ({ context, input }) =>
    normalizeInvitationPage(
      await listInvitations(
        context.env.COMINAVI_DB,
        context.identity,
        input.params.planID,
        collectionPage(input.query),
      ),
    ),
  );

export const createSharedPlanInvitation = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/plans/{planID}/invitations",
    operationId: "createSharedPlanInvitation",
    summary: "Create a Shared Plan invitation",
    description:
      "Creates a reusable 12-character invitation capability. Its secret token is returned once and cannot be recovered from an exact replay.",
    tags: ["Shared Plan Invitations"],
    inputStructure: "detailed",
    successStatus: 201,
  })
  .input(
    z.object({
      params: planPathSchema,
      body: membershipMutationSchema.extend({
        expiresAt: isoDateSchema.optional(),
      }),
    }),
  )
  .output(invitationCreateResultSchema)
  .handler(async ({ context, input }) =>
    invitationCreateResultSchema.parse(
      await createInvitation(
        context.env.COMINAVI_DB,
        context.identity,
        input.params.planID,
        parseInvitationCreate(input.body),
        context.env.COMINAVI_INVITE_TOKEN_SECRET,
      ),
    ),
  );

export const revokeSharedPlanInvitation = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/api/v2/plans/{planID}/invitations/{invitationID}",
    operationId: "revokeSharedPlanInvitation",
    summary: "Revoke a Shared Plan invitation",
    description:
      "Revokes an invitation using an optimistic plan revision and exact request receipt.",
    tags: ["Shared Plan Invitations"],
    inputStructure: "detailed",
  })
  .input(
    z.object({ params: invitationPathSchema, body: membershipMutationSchema }),
  )
  .output(planMutationResultSchema)
  .handler(({ context, input }) =>
    revokeInvitation(
      context.env.COMINAVI_DB,
      context.identity,
      input.params.planID,
      input.params.invitationID,
      parseMembershipMutation(input.body),
    ),
  );

export const invitationRouter = {
  preview: previewSharedPlanInvitation,
  accept: acceptSharedPlanInvitation,
};

export const plansRouter = {
  ...sharedPlanResourceRouter,
  members: {
    list: listSharedPlanMembers,
    revoke: revokeSharedPlanMember,
    reinstate: reinstateSharedPlanMember,
    transferOwnership: transferSharedPlanOwnership,
  },
  invitations: {
    list: listSharedPlanInvitations,
    create: createSharedPlanInvitation,
    revoke: revokeSharedPlanInvitation,
  },
};

async function enforceInvitationRateLimit(
  request: Request,
  env: Cloudflare.Env,
): Promise<void> {
  const key = request.headers.get("CF-Connecting-IP") ?? "local";
  if (!(await env.COMINAVI_INVITE_RATE_LIMITER.limit({ key })).success) {
    throw new ServiceError(
      "rate_limited",
      429,
      "Too many invitation attempts.",
    );
  }
}
