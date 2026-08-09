import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  apiErrorResponse,
  jsonResponse,
} from "../../../../../lib/server/api-response";
import { authenticateRequest } from "../../../../../lib/server/authenticated-request";
import { parseEventNumber } from "../../../../../lib/server/favorites";
import {
  loadRealtimeUpdates,
  parseRealtimeQuery,
} from "../../../../../lib/server/realtime-api";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authenticateRequest(request);
    const eventNumber = parseEventNumber(params.comiket);
    const query = parseRealtimeQuery(new URL(request.url));
    return jsonResponse(
      await loadRealtimeUpdates(env.COMINAVI_DB, eventNumber, query),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
};
