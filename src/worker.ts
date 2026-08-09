import astro from "@astrojs/cloudflare/entrypoints/server";
import { processPushQueueMessage } from "./lib/server/apns";
import {
  enqueuePendingPushDeliveries,
  type PushQueueMessage,
} from "./lib/server/push-queue";

export default {
  fetch: astro.fetch,

  async queue(
    batch: MessageBatch<PushQueueMessage>,
    env: Cloudflare.Env,
  ): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        await processPushQueueMessage(message, env);
      }),
    );
  },

  async scheduled(
    _controller: ScheduledController,
    env: Cloudflare.Env,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(
      enqueuePendingPushDeliveries(env.COMINAVI_DB, env.COMINAVI_PUSH_QUEUE).then(
        () => undefined,
      ),
    );
  },
} satisfies ExportedHandler<Cloudflare.Env, PushQueueMessage>;
