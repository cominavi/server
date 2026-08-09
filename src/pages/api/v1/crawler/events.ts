import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  apiErrorResponse,
  jsonResponse,
} from "../../../../lib/server/api-response";
import {
  authenticateCrawlerRequest,
  ingestCrawlerBatch,
  parseCrawlerBatch,
} from "../../../../lib/server/crawler-ingest";
import { enqueuePushDeliveries } from "../../../../lib/server/push-queue";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const authenticated = await authenticateCrawlerRequest(
      request,
      env.COMINAVI_CRAWLER_WEBHOOK_SECRET,
    );
    const batch = parseCrawlerBatch(authenticated.rawBody);
    const result = await ingestCrawlerBatch(env.COMINAVI_DB, {
      ...authenticated,
      batch,
    });
    await enqueuePushDeliveries(env.COMINAVI_PUSH_QUEUE, result.deliveryIDs);
    return jsonResponse(
      {
        acceptedEvents: result.acceptedEvents,
        duplicate: result.duplicate,
        cursor: result.cursor,
        queuedDeliveries: result.deliveryIDs.length,
      },
      result.duplicate ? 200 : 202,
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
};
