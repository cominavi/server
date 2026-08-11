import { z } from "zod";
import {
  logoutSession,
  parseLogoutRequest,
  rotateSession,
} from "../lib/server/auth-sessions";
import {
  authenticateApple,
  exchangeAppleAuthorizationCode,
} from "../lib/server/apple-auth";
import { authenticateAppleRequest } from "../lib/server/apple-auth-flow";
import {
  issueAppleEntryGrant,
  validateAppleNonce,
} from "../lib/server/apple-entry-grants";
import {
  completeCirclemsAuthentication,
  parseCirclemsOAuthCompleteInput,
  parseCirclemsOAuthStartInput,
  startCirclemsOAuth,
} from "../lib/server/circlems-oauth-flow";
import {
  AuthenticationError,
  bearerToken,
  verifyCominaviJWT,
  verifyCominaviJWTForDeletionReceipt,
} from "../lib/server/cominavi-auth";
import { authenticateGoogle } from "../lib/server/google-auth";
import { authenticateGoogleRequest } from "../lib/server/google-auth-flow";
import {
  issueGoogleEntryGrant,
  validateGoogleNonce,
} from "../lib/server/google-entry-grants";
import { parseCanonicalRequestID } from "../lib/server/request-id";
import { ServiceError } from "../lib/server/service-error";
import { isValidInvitationToken } from "../lib/server/shared-plans";
import {
  documentBearerOperation,
  documentPublicOperation,
  predecessorTokenProcedure,
  publicProcedure,
} from "./core";

const canonicalRequestIDSchema = z.uuid();
const opaqueTokenSchema = z.string().min(1).max(16_384);
const isoDateSchema = z.iso.datetime();

const identitySchema = z.object({
  provider: z.enum(["circlems", "google", "apple"]),
  environment: z.enum(["production", "sandbox"]).optional(),
  providerUserID: z.number().int().positive().optional(),
  email: z.string().optional(),
});

const userProfileSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  displayName: z.string().min(1),
  avatarURL: z.string().optional(),
  revision: z.number().int().positive(),
  identities: z.array(identitySchema),
});

const sessionSchema = z.object({
  tokenType: z.literal("Bearer"),
  authVersion: z.number().int().positive(),
  accessToken: z.string().min(1),
  expiresAt: isoDateSchema,
  refreshToken: z.string().min(1),
  refreshExpiresAt: isoDateSchema,
  user: userProfileSchema,
});

const entryGrantSchema = z.object({
  entryGrant: z.string().min(1),
  expiresAt: isoDateSchema,
});

const circlemsCredentialReceiptSchema = z.object({
  requestId: canonicalRequestIDSchema,
  clientInstanceID: canonicalRequestIDSchema,
  provider: z.literal("circlems"),
  environment: z.enum(["production", "sandbox"]),
  subject: z.string().min(1),
  credentialRevision: z.number().int().positive(),
});

export const startCirclemsAuthentication = publicProcedure
  .route({
    method: "POST",
    path: "/api/v2/auth/circlems/start",
    operationId: "startCirclemsAuthentication",
    summary: "Start Circle.ms authentication",
    description:
      "Starts a backend-owned Circle.ms OAuth flow bound to the client instance and PKCE challenge.",
    tags: ["Authentication"],
  })
  .input(
    z.object({
      requestId: canonicalRequestIDSchema,
      clientInstanceID: canonicalRequestIDSchema,
      environment: z.enum(["production", "sandbox"]),
      codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    }),
  )
  .output(
    z.object({
      authorizationURL: z.url(),
      expiresAt: isoDateSchema,
    }),
  )
  .handler(async ({ context, input }) => {
    await enforcePublicRateLimit(
      context.request,
      context.env,
      "Too many sign-in attempts.",
    );
    return startCirclemsOAuth(
      context.env,
      "authenticate",
      parseCirclemsOAuthStartInput(input),
    );
  });

export const completeCirclemsAuthenticationProcedure = publicProcedure
  .route({
    method: "POST",
    path: "/api/v2/auth/circlems/complete",
    operationId: "completeCirclemsAuthentication",
    summary: "Complete Circle.ms authentication",
    description:
      "Consumes the short-lived OAuth completion code and installs the backend-owned Circle.ms credential before issuing a ComiNavi session.",
    tags: ["Authentication"],
  })
  .input(
    z.object({
      requestId: canonicalRequestIDSchema,
      clientInstanceID: canonicalRequestIDSchema,
      completionCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    }),
  )
  .output(
    sessionSchema.extend({
      credentialReceipt: circlemsCredentialReceiptSchema,
    }),
  )
  .handler(async ({ context, input }) =>
    normalizeSession(
      await completeCirclemsAuthentication(
        context.env,
        parseCirclemsOAuthCompleteInput(input),
      ),
    ),
  );

const entryGrantInputSchema = z.object({
  nonce: z.string().min(1).max(128),
  inviteToken: z.string().min(1).max(128),
});

export const issueGoogleAuthenticationEntryGrant = publicProcedure
  .route({
    method: "POST",
    path: "/api/v2/auth/google/entry-grant",
    operationId: "issueGoogleAuthenticationEntryGrant",
    summary: "Issue a Google authentication entry grant",
    description:
      "Consumes invitation-gated entry authority and binds a one-time Google sign-in grant to the supplied nonce.",
    tags: ["Authentication"],
  })
  .input(entryGrantInputSchema)
  .output(entryGrantSchema)
  .handler(async ({ context, input }) => {
    await enforcePublicRateLimit(
      context.request,
      context.env,
      "Too many entry attempts.",
    );
    const nonce = validateGoogleNonce(input.nonce);
    if (
      !(await isValidInvitationToken(
        context.env.COMINAVI_DB,
        input.inviteToken,
        context.env.COMINAVI_INVITE_TOKEN_SECRET,
      ))
    ) {
      throw new ServiceError(
        "google_entry_unavailable",
        404,
        "This Google sign-in entry is not available.",
      );
    }
    return issueGoogleEntryGrant(context.env.COMINAVI_DB, nonce);
  });

export const authenticateWithGoogle = publicProcedure
  .route({
    method: "POST",
    path: "/api/v2/auth/google",
    operationId: "authenticateWithGoogle",
    summary: "Authenticate with Google",
    description:
      "Verifies a nonce-bound Google ID token and atomically issues or recovers the payload-bound ComiNavi session.",
    tags: ["Authentication"],
  })
  .input(
    z.object({
      requestId: canonicalRequestIDSchema,
      idToken: opaqueTokenSchema,
      entryGrant: opaqueTokenSchema,
      nonce: z.string().min(1).max(128),
    }),
  )
  .output(sessionSchema)
  .handler(async ({ context, input }) => {
    if (!input.idToken || !input.entryGrant) {
      throw new AuthenticationError(
        "invalid_google_token",
        401,
        "Google sign-in credentials are required.",
      );
    }
    const requestID = parseCanonicalRequestID(input.requestId);
    const nonce = validateGoogleNonce(input.nonce);
    const completed = await authenticateGoogleRequest(
      context.env.COMINAVI_DB,
      {
        idToken: input.idToken,
        entryGrant: input.entryGrant,
        nonce,
        requestID,
      },
      context.env.COMINAVI_JWT_SECRET,
      context.env.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      () => authenticateGoogle(input.idToken, context.env, nonce),
    );
    return normalizeSession(completed.response);
  });

export const issueAppleAuthenticationEntryGrant = publicProcedure
  .route({
    method: "POST",
    path: "/api/v2/auth/apple/entry-grant",
    operationId: "issueAppleAuthenticationEntryGrant",
    summary: "Issue an Apple authentication entry grant",
    description:
      "Consumes invitation-gated entry authority and binds a one-time Apple sign-in grant to the supplied nonce.",
    tags: ["Authentication"],
  })
  .input(entryGrantInputSchema)
  .output(entryGrantSchema)
  .handler(async ({ context, input }) => {
    await enforcePublicRateLimit(
      context.request,
      context.env,
      "Too many entry attempts.",
    );
    const nonce = validateAppleNonce(input.nonce);
    if (
      !(await isValidInvitationToken(
        context.env.COMINAVI_DB,
        input.inviteToken,
        context.env.COMINAVI_INVITE_TOKEN_SECRET,
      ))
    ) {
      throw new ServiceError(
        "apple_entry_unavailable",
        404,
        "This Apple sign-in entry is not available.",
      );
    }
    return issueAppleEntryGrant(context.env.COMINAVI_DB, nonce);
  });

export const authenticateWithApple = publicProcedure
  .route({
    method: "POST",
    path: "/api/v2/auth/apple",
    operationId: "authenticateWithApple",
    summary: "Authenticate with Apple",
    description:
      "Verifies Apple identity proof, durably claims the one-time authorization code, and atomically issues or recovers the payload-bound ComiNavi session.",
    tags: ["Authentication"],
  })
  .input(
    z.object({
      requestId: canonicalRequestIDSchema,
      identityToken: opaqueTokenSchema,
      authorizationCode: opaqueTokenSchema,
      entryGrant: opaqueTokenSchema,
      nonce: z.string().min(1).max(128),
      displayName: z.string().max(200).optional(),
    }),
  )
  .output(sessionSchema)
  .handler(async ({ context, input }) => {
    const requestID = parseCanonicalRequestID(input.requestId);
    const nonce = validateAppleNonce(input.nonce);
    let verifiedIdentity:
      Awaited<ReturnType<typeof authenticateApple>> | undefined;
    const completed = await authenticateAppleRequest(
      context.env.COMINAVI_DB,
      {
        requestID,
        identityToken: input.identityToken,
        authorizationCode: input.authorizationCode,
        entryGrant: input.entryGrant,
        nonce,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
      context.env.COMINAVI_JWT_SECRET,
      context.env.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      async () => {
        verifiedIdentity = await authenticateApple(
          input.identityToken,
          context.env,
          nonce,
        );
        return verifiedIdentity;
      },
      async (identity) =>
        exchangeAppleAuthorizationCode(
          input.authorizationCode,
          verifiedIdentity ?? identity,
          nonce,
          context.env,
        ),
    );
    return normalizeSession(completed.response);
  });

export const refreshAuthenticationSession = publicProcedure
  .route({
    method: "POST",
    path: "/api/v2/auth/refresh",
    operationId: "refreshAuthenticationSession",
    summary: "Refresh a ComiNavi session",
    description:
      "Atomically rotates a single-use ComiNavi refresh token and returns the successor session.",
    tags: ["Authentication"],
  })
  .input(z.object({ refreshToken: opaqueTokenSchema }))
  .output(sessionSchema)
  .handler(async ({ context, input }) =>
    normalizeSession(
      await rotateSession(
        context.env.COMINAVI_DB,
        input.refreshToken,
        context.env.COMINAVI_JWT_SECRET,
      ),
    ),
  );

export const logoutAuthenticationSession = predecessorTokenProcedure
  .route({
    method: "POST",
    path: "/api/v2/auth/logout",
    operationId: "logoutAuthenticationSession",
    summary: "Log out a ComiNavi session",
    description:
      "Durably advances the account authentication epoch. The bearer token is predecessor proof, not ordinary live-session authorization: an expired but correctly signed predecessor JWT may recover only the exact payload-bound logout receipt, or initiate logout when the submitted refresh token remains live.",
    tags: ["Authentication"],
  })
  .input(
    z.object({
      requestId: canonicalRequestIDSchema,
      refreshToken: opaqueTokenSchema,
    }),
  )
  .output(
    z.object({
      receipt: z.object({
        requestId: canonicalRequestIDSchema,
        replayed: z.boolean(),
        authVersion: z.number().int().positive(),
      }),
    }),
  )
  .handler(async ({ context, input }) => {
    const parsed = parseLogoutRequest(input);
    const token = bearerToken(context.request);
    const predecessor = await verifyCominaviJWTForDeletionReceipt(
      token,
      context.env.COMINAVI_JWT_SECRET,
    );
    let accessTokenIsLive = false;
    try {
      await verifyCominaviJWT(token, context.env.COMINAVI_JWT_SECRET);
      accessTokenIsLive = true;
    } catch {
      // Exact receipt recovery and still-live refresh authority are checked by
      // logoutSession; predecessor proof alone grants no other authority.
    }
    return logoutSession(
      context.env.COMINAVI_DB,
      predecessor,
      parsed,
      context.env.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      accessTokenIsLive,
    );
  });

export const authRouter = {
  circlems: {
    start: documentPublicOperation(startCirclemsAuthentication),
    complete: documentPublicOperation(completeCirclemsAuthenticationProcedure),
  },
  google: {
    entryGrant: documentPublicOperation(issueGoogleAuthenticationEntryGrant),
    authenticate: documentPublicOperation(authenticateWithGoogle),
  },
  apple: {
    entryGrant: documentPublicOperation(issueAppleAuthenticationEntryGrant),
    authenticate: documentPublicOperation(authenticateWithApple),
  },
  refresh: documentPublicOperation(refreshAuthenticationSession),
  logout: documentBearerOperation(logoutAuthenticationSession),
};

async function enforcePublicRateLimit(
  request: Request,
  env: Cloudflare.Env,
  message: string,
): Promise<void> {
  const key = request.headers.get("CF-Connecting-IP") ?? "local";
  if (!(await env.COMINAVI_INVITE_RATE_LIMITER.limit({ key })).success) {
    throw new ServiceError("rate_limited", 429, message);
  }
}

function normalizeSession<T extends { user: { avatarURL: string | null } }>(
  session: T,
) {
  const { avatarURL, ...user } = session.user;
  return {
    ...session,
    user: {
      ...user,
      ...(avatarURL ? { avatarURL } : {}),
    },
  };
}
