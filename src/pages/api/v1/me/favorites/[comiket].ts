import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  apiErrorResponse,
  jsonResponse,
  readRequestJSON,
} from "../../../../../lib/server/api-response";
import { authenticateRequest } from "../../../../../lib/server/authenticated-request";
import {
  loadFavoriteSnapshot,
  parseEventNumber,
  parseFavoriteSnapshotBody,
  replaceFavoriteSnapshot,
} from "../../../../../lib/server/favorites";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const identity = await authenticateRequest(request);
    const eventNumber = parseEventNumber(params.comiket);
    return jsonResponse(
      await loadFavoriteSnapshot(env.COMINAVI_DB, identity, eventNumber),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const identity = await authenticateRequest(request);
    const eventNumber = parseEventNumber(params.comiket);
    const input = parseFavoriteSnapshotBody(await readRequestJSON(request));
    return jsonResponse(
      await replaceFavoriteSnapshot(
        env.COMINAVI_DB,
        identity,
        eventNumber,
        input,
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
};
