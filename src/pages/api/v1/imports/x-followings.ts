import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  apiErrorResponse,
  isRecord,
  jsonResponse,
  readRequestJSON,
} from "../../../../lib/server/api-response";
import {
  bearerToken,
  verifyCominaviJWT,
} from "../../../../lib/server/cominavi-auth";
import {
  FollowingImportError,
  importFollowingSnapshot,
} from "../../../../lib/server/following-import";
import { assertCurrentAuthVersion } from "../../../../lib/server/users";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const identity = await verifyCominaviJWT(
      bearerToken(request),
      env.COMINAVI_JWT_SECRET,
    );
    await assertCurrentAuthVersion(env.COMINAVI_DB, identity);
    const body = await readRequestJSON(request);
    if (!isRecord(body) || typeof body.userName !== "string") {
      throw new FollowingImportError(
        "invalid_twitter_username",
        400,
        "An X username is required.",
      );
    }

    const result = await importFollowingSnapshot(identity, body.userName, env);
    return jsonResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
};
