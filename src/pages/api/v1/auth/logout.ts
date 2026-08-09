import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { apiErrorResponse } from "../../../../lib/server/api-response";
import { authenticateRequest } from "../../../../lib/server/authenticated-request";
import { revokeAuthenticatedSessions } from "../../../../lib/server/users";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const identity = await authenticateRequest(request);
    await revokeAuthenticatedSessions(env.COMINAVI_DB, identity);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
};
