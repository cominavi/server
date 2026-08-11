import { z } from "zod";
import {
  loadUserProfile,
  parseProfileUpdate,
  resolveAuthenticatedUser,
  updateUserProfile,
} from "../../lib/server/users";
import {
  loadAccountDeletionReplay,
  parseAccountDeletion,
  requestAccountDeletion,
} from "../../lib/server/account-deletion";
import {
  bearerToken,
  verifyCominaviJWT,
  verifyCominaviJWTForDeletionReceipt,
} from "../../lib/server/cominavi-auth";
import { authenticatedProcedure, predecessorTokenProcedure } from "../core";

const publicUserIDSchema = z.string().regex(/^[0-9a-f]{32}$/);

const profileIdentitySchema = z.object({
  provider: z.enum(["circlems", "google", "apple"]),
  environment: z.enum(["production", "sandbox"]).optional(),
  providerUserID: z.number().int().positive().optional(),
  email: z.email().optional(),
});

const userProfileSchema = z.object({
  id: publicUserIDSchema,
  displayName: z.string().min(1).max(100),
  avatarURL: z.string().min(1).optional(),
  revision: z.number().int().positive(),
  identities: z.array(profileIdentitySchema),
});

function generatedProfile(
  profile: Awaited<ReturnType<typeof loadUserProfile>>,
): z.infer<typeof userProfileSchema> {
  return {
    ...profile,
    avatarURL: profile.avatarURL ?? undefined,
  };
}

export const getCurrentUserProfile = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/me",
    operationId: "getCurrentUserProfile",
    summary: "Get current user profile",
    tags: ["Profile"],
  })
  .input(z.object({}))
  .output(userProfileSchema)
  .handler(async ({ context }) =>
    generatedProfile(
      await loadUserProfile(context.env.COMINAVI_DB, context.identity.userID),
    ),
  );

export const updateCurrentUserProfile = authenticatedProcedure
  .route({
    method: "PATCH",
    path: "/api/v2/me",
    operationId: "updateCurrentUserProfile",
    summary: "Update current user profile",
    description:
      "Updates the display name with an exact request-ID receipt and optimistic profile revision.",
    tags: ["Profile"],
  })
  .input(
    z.object({
      requestId: z.uuid(),
      baseRevision: z.number().int().positive(),
      displayName: z.string().trim().min(1).max(100),
    }),
  )
  .output(z.object({ user: userProfileSchema }))
  .handler(async ({ context, input }) => ({
    user: generatedProfile(
      await updateUserProfile(
        context.env.COMINAVI_DB,
        context.identity,
        parseProfileUpdate(input),
      ),
    ),
  }));

export const deleteCurrentUserAccount = predecessorTokenProcedure
  .route({
    method: "DELETE",
    path: "/api/v2/me",
    operationId: "deleteCurrentUserAccount",
    summary: "Delete current account",
    description:
      "Durably fences the account, removes owned plans, and schedules retryable external cleanup. Exact receipt replay is supported with the predecessor token.",
    tags: ["Profile"],
    successStatus: 202,
  })
  .input(
    z.object({
      requestId: z.uuid(),
      confirmation: z.literal("DELETE"),
    }),
  )
  .output(
    z.object({
      status: z.literal("deletion_pending"),
      requestId: z.uuid(),
      deletedOwnedPlanIDs: z.array(z.uuid()),
    }),
  )
  .handler(async ({ context, input }) => {
    const deletion = parseAccountDeletion(input);
    const token = bearerToken(context.request);
    const receiptIdentity = await verifyCominaviJWTForDeletionReceipt(
      token,
      context.env.COMINAVI_JWT_SECRET,
    );
    const replay = await loadAccountDeletionReplay(
      context.env.COMINAVI_DB,
      receiptIdentity,
      deletion,
    );
    const tokenIdentity = replay
      ? receiptIdentity
      : await verifyCominaviJWT(token, context.env.COMINAVI_JWT_SECRET);
    const result = replay
      ? replay
      : await requestAccountDeletion(
          context.env.COMINAVI_DB,
          await resolveAuthenticatedUser(
            context.env.COMINAVI_DB,
            tokenIdentity,
          ),
          deletion,
          context.env.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
        );
    await Promise.allSettled(
      result.deletedOwnedPlanIDs.map((planID) =>
        context.env.COMINAVI_PLAN_SYNC.get(
          context.env.COMINAVI_PLAN_SYNC.idFromName(planID),
        ).fetch("https://plan-sync.internal/fence", { method: "POST" }),
      ),
    );
    return result;
  });

export const profileRouter = {
  get: getCurrentUserProfile,
  update: updateCurrentUserProfile,
  delete: deleteCurrentUserAccount,
};
