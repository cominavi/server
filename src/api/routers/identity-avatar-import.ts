import { eq } from "drizzle-orm";
import { eventIterator } from "@orpc/server";
import { z } from "zod";
import { createDatabase } from "../../lib/db/client";
import { users } from "../../lib/db/schema";
import {
  completeCirclemsLink,
  parseCirclemsOAuthCompleteInput,
  parseCirclemsOAuthStartInput,
  startCirclemsOAuth,
} from "../../lib/server/circlems-oauth-flow";
import {
  loadAvatar,
  removeAvatar,
  replaceAvatar,
} from "../../lib/server/avatars";
import {
  FollowingImportError,
  importFollowingSnapshot,
  streamFollowingSnapshot,
} from "../../lib/server/following-import";
import { ServiceError } from "../../lib/server/service-error";
import type { UserProfile } from "../../lib/server/users";
import { authenticatedProcedure, expectedAPIError } from "../core";

const canonicalRequestIDSchema = z.uuid();
const isoDateSchema = z.iso.datetime();
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

const circlemsStartInputSchema = z.object({
  requestId: canonicalRequestIDSchema,
  clientInstanceID: canonicalRequestIDSchema,
  environment: z.enum(["production", "sandbox"]),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const circlemsCompleteInputSchema = z.object({
  requestId: canonicalRequestIDSchema,
  clientInstanceID: canonicalRequestIDSchema,
  completionCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});

const circlemsCredentialReceiptSchema = z.object({
  requestId: canonicalRequestIDSchema,
  clientInstanceID: canonicalRequestIDSchema,
  provider: z.literal("circlems"),
  environment: z.enum(["production", "sandbox"]),
  subject: z.string().min(1),
  credentialRevision: z.number().int().positive(),
});

const profileMutationHeadersSchema = z.object({
  "if-match": z.string().regex(/^"profile:[1-9][0-9]*"$/),
  "idempotency-key": canonicalRequestIDSchema,
});

const avatarContentTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const avatarUploadHeadersSchema = profileMutationHeadersSchema.extend({
  "content-type": avatarContentTypeSchema,
  "content-length": z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
});

const avatarResponseHeadersSchema = z.object({
  "Cache-Control": z.string().min(1),
  "Content-Length": z.string().regex(/^[0-9]+$/),
  "Content-Type": avatarContentTypeSchema,
  ETag: z.string().min(1),
  "X-Content-Type-Options": z.literal("nosniff"),
});

const avatarResponseBodySchema = z.custom<ReadableStream<Uint8Array>>(
  (value) => value instanceof ReadableStream,
);

const avatarBinaryMedia = {
  "image/jpeg": { schema: { type: "string", format: "binary" } },
  "image/png": { schema: { type: "string", format: "binary" } },
  "image/webp": { schema: { type: "string", format: "binary" } },
} as const;

const followingSchema = z.object({
  id: z.string().min(1),
  userName: z.string().regex(/^[a-z0-9_]{1,15}$/),
  name: z.string(),
  url: z.url(),
  profilePicture: z.url().optional(),
});

const followingImportResponseSchema = z.object({
  twitterUserName: z.string().regex(/^[a-z0-9_]{1,15}$/),
  importedAt: isoDateSchema,
  nextAllowedAt: isoDateSchema,
  followings: z.array(followingSchema),
  source: z.enum(["twitterapi.io", "cache"]),
});

const followingImportProgressSchema = z.object({
  page: z.number().int().min(1).max(25),
  fetchedCount: z.number().int().min(0).max(5_000),
  maximumCount: z.literal(5_000),
  followings: z.array(followingSchema),
});

export const startCirclemsIdentityLink = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/me/identities/circlems/start",
    operationId: "startCirclemsIdentityLink",
    summary: "Start Circle.ms identity linking",
    description:
      "Starts a backend-owned Circle.ms OAuth link flow bound to the authenticated user, auth epoch, client instance, and PKCE challenge.",
    tags: ["Identity Linking"],
  })
  .input(circlemsStartInputSchema)
  .output(
    z.object({
      authorizationURL: z.url(),
      expiresAt: isoDateSchema,
    }),
  )
  .handler(({ context, input }) =>
    startCirclemsOAuth(
      context.env,
      "link",
      parseCirclemsOAuthStartInput(input),
      context.identity,
    ),
  );

export const completeCirclemsIdentityLink = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/me/identities/circlems/complete",
    operationId: "completeCirclemsIdentityLink",
    summary: "Complete Circle.ms identity linking",
    description:
      "Consumes the short-lived OAuth completion code and atomically attaches the backend-owned Circle.ms identity and credential to the authenticated account.",
    tags: ["Identity Linking"],
  })
  .input(circlemsCompleteInputSchema)
  .output(
    z.object({
      user: userProfileSchema,
      credentialReceipt: circlemsCredentialReceiptSchema,
    }),
  )
  .handler(async ({ context, input }) => {
    const result = await completeCirclemsLink(
      context.env,
      parseCirclemsOAuthCompleteInput(input),
      context.identity,
    );
    return { ...result, user: generatedUserProfile(result.user) };
  });

export const replaceCurrentUserAvatar = authenticatedProcedure
  .route({
    method: "PUT",
    path: "/api/v2/me/avatar",
    operationId: "replaceCurrentUserAvatar",
    summary: "Replace current user avatar",
    description:
      "Replaces the avatar with raw JPEG, PNG, or WebP bytes under profile-revision and request-id idempotency fences.",
    tags: ["Profile"],
    inputStructure: "detailed",
    spec: (operation) => ({
      ...operation,
      requestBody: {
        required: true,
        content: avatarBinaryMedia,
      },
    }),
  })
  .input(
    z.object({
      headers: avatarUploadHeadersSchema,
      body: z.instanceof(Blob),
    }),
  )
  .output(z.object({ user: userProfileSchema }))
  .handler(async ({ context, input }) => ({
    user: generatedUserProfile(
      await replaceAvatar(
        context.env.COMINAVI_DB,
        context.env.COMINAVI_AVATARS,
        context.identity,
        rebuiltAvatarUploadRequest(context.request, input.body),
      ),
    ),
  }));

export const removeCurrentUserAvatar = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/api/v2/me/avatar",
    operationId: "removeCurrentUserAvatar",
    summary: "Remove current user avatar",
    description:
      "Removes the current avatar under profile-revision and request-id idempotency fences.",
    tags: ["Profile"],
    inputStructure: "detailed",
  })
  .input(z.object({ headers: profileMutationHeadersSchema }))
  .output(z.object({ user: userProfileSchema }))
  .handler(async ({ context }) => ({
    user: generatedUserProfile(
      await removeAvatar(
        context.env.COMINAVI_DB,
        context.identity,
        context.request,
      ),
    ),
  }));

export const getUserAvatar = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/users/{userID}/avatar",
    operationId: "getUserAvatar",
    summary: "Get a user avatar",
    description:
      "Streams controlled avatar bytes when the authenticated requester may view the target public user.",
    tags: ["Profile"],
    inputStructure: "detailed",
    outputStructure: "detailed",
    spec: (operation) => ({
      ...operation,
      responses: {
        ...operation.responses,
        "200": {
          ...operation.responses?.["200"],
          description: "Avatar image",
          content: avatarBinaryMedia,
        },
      },
    }),
  })
  .input(z.object({ params: z.object({ userID: publicUserIDSchema }) }))
  .output(
    z.object({
      status: z.literal(200),
      headers: avatarResponseHeadersSchema,
      body: avatarResponseBodySchema,
    }),
  )
  .handler(async ({ context, input }) => {
    const target = await createDatabase(context.env.COMINAVI_DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.publicID, input.params.userID))
      .get();
    if (!target) throw avatarNotFound();
    const response = await loadAvatar(
      context.env.COMINAVI_DB,
      context.env.COMINAVI_AVATARS,
      context.identity,
      target.id,
    );
    if (response.status !== 200 || !response.body) {
      throw invalidAvatarResponse(response.status);
    }
    return {
      status: 200 as const,
      headers: avatarResponseHeaders(response),
      body: response.body,
    };
  });

export const importXFollowings = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/imports/x-followings",
    operationId: "importXFollowings",
    summary: "Import X followings",
    description:
      "Imports or returns the authenticated user's cached X following snapshot under the six-hour lease and cooldown fence.",
    tags: ["Imports"],
  })
  .input(z.object({ userName: z.string().min(1).max(64) }))
  .output(followingImportResponseSchema)
  .handler(({ context, input }) =>
    importFollowingSnapshot(context.identity, input.userName, context.env),
  );

export const streamXFollowings = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/imports/x-followings/stream",
    operationId: "streamXFollowings",
    summary: "Stream X following import progress",
    description:
      "Streams each fetched X following page with Server-Sent Events, then returns the same completed snapshot shape as the non-streaming import endpoint.",
    tags: ["Imports"],
  })
  .input(z.object({ userName: z.string().min(1).max(64) }))
  .output(
    eventIterator(followingImportProgressSchema, followingImportResponseSchema),
  )
  .handler(async function* ({ context, input }) {
    try {
      return yield* streamFollowingSnapshot(
        context.identity,
        input.userName,
        context.env,
      );
    } catch (error) {
      // Middleware finishes before an async iterator is consumed, so translate
      // deferred domain errors at the stream boundary as well.
      if (error instanceof FollowingImportError) {
        throw expectedAPIError(error);
      }
      throw error;
    }
  });

export const identityAvatarImportRouter = {
  circlemsLink: {
    start: startCirclemsIdentityLink,
    complete: completeCirclemsIdentityLink,
  },
  currentUserAvatar: {
    replace: replaceCurrentUserAvatar,
    remove: removeCurrentUserAvatar,
  },
  userAvatar: getUserAvatar,
  xFollowingImport: importXFollowings,
  xFollowingImportStream: streamXFollowings,
};

function generatedUserProfile(
  profile: UserProfile,
): z.infer<typeof userProfileSchema> {
  return {
    ...profile,
    avatarURL: profile.avatarURL ?? undefined,
  };
}

function rebuiltAvatarUploadRequest(request: Request, body: Blob): Request {
  return new Request(request.url, {
    method: "PUT",
    headers: request.headers,
    body,
  });
}

function avatarResponseHeaders(
  response: Response,
): z.infer<typeof avatarResponseHeadersSchema> {
  const contentType = response.headers.get("Content-Type");
  if (
    contentType !== "image/jpeg" &&
    contentType !== "image/png" &&
    contentType !== "image/webp"
  ) {
    throw invalidAvatarResponse(response.status);
  }
  return {
    "Cache-Control": requiredHeader(response, "Cache-Control"),
    "Content-Length": requiredHeader(response, "Content-Length"),
    "Content-Type": contentType,
    ETag: requiredHeader(response, "ETag"),
    "X-Content-Type-Options": "nosniff",
  };
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw invalidAvatarResponse(response.status);
  return value;
}

function avatarNotFound(): ServiceError {
  return new ServiceError("avatar_not_found", 404, "Avatar not found.");
}

function invalidAvatarResponse(status: number): ServiceError {
  return new ServiceError(
    "avatar_invalid_response",
    500,
    `The avatar service returned an invalid ${status} response.`,
  );
}
