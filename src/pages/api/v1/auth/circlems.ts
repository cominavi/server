import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  apiErrorResponse,
  isRecord,
  jsonResponse,
  readRequestJSON,
} from "../../../../lib/server/api-response";
import {
  authenticateCirclems,
  bearerToken,
  issueCominaviJWT,
  type CirclemsEnvironment,
} from "../../../../lib/server/cominavi-auth";
import { FollowingImportError } from "../../../../lib/server/following-import";
import { upsertAuthenticatedUser } from "../../../../lib/server/users";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await readRequestJSON(request);
    if (!isRecord(body) || !isCirclemsEnvironment(body.environment)) {
      throw new FollowingImportError(
        "invalid_circlems_environment",
        400,
        "Circle.ms environment must be production or sandbox.",
      );
    }

    const circlemsIdentity = await authenticateCirclems(
      bearerToken(request),
      body.environment,
      env,
    );
    const identity = await upsertAuthenticatedUser(
      env.COMINAVI_DB,
      circlemsIdentity,
    );
    const jwt = await issueCominaviJWT(identity, env.COMINAVI_JWT_SECRET);
    return jsonResponse({
      tokenType: "Bearer",
      accessToken: jwt.token,
      expiresAt: jwt.expiresAt,
      user: {
        id: identity.userID,
        circlemsUserID: identity.circlemsUserID,
        nickname: identity.nickname,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
};

function isCirclemsEnvironment(value: unknown): value is CirclemsEnvironment {
  return value === "production" || value === "sandbox";
}
