import astro from "@astrojs/cloudflare/entrypoints/server";
import { processPushQueueMessage } from "./lib/server/apns";
import {
  enqueuePendingPushDeliveries,
  type PushQueueMessage,
} from "./lib/server/push-queue";
import { processPendingAvatarCleanup } from "./lib/server/avatar-cleanup";
import { discoverCatalogRefreshJobs } from "./lib/server/catalog-refresh";
import { processProviderAvatarImports } from "./lib/server/provider-avatar-import";
import { processAccountDeletionJobs } from "./lib/server/account-deletion";
import { processAppleRevocations } from "./lib/server/apple-auth-flow";
import { processFollowingSnapshotCleanup } from "./lib/server/following-import";
import { processExpiredCirclemsOAuth } from "./lib/server/circlems-oauth-flow";
import { processPendingCircleTagOverlayCleanup } from "./lib/server/tag-overlay-cleanup";
import { createHomepageApp } from "./api/app";
export { PlanSyncObject } from "./lib/server/plan-sync-object";

const app = createHomepageApp(astro.fetch);

export default {
  fetch: app.fetch,

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
      Promise.all([
        enqueuePendingPushDeliveries(env.COMINAVI_DB, env.COMINAVI_PUSH_QUEUE),
        processPendingAvatarCleanup(env.COMINAVI_DB, env.COMINAVI_AVATARS),
        processProviderAvatarImports(env.COMINAVI_DB, env.COMINAVI_AVATARS),
        processAppleRevocations(
          env.COMINAVI_DB,
          env,
          env.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
        ),
        processFollowingSnapshotCleanup(
          env.COMINAVI_DB,
          env.COMINAVI_FOLLOWING_SNAPSHOTS,
        ),
        processExpiredCirclemsOAuth(env.COMINAVI_DB),
        processPendingCircleTagOverlayCleanup(
          env.COMINAVI_DB,
          env.COMINAVI_CATALOGS,
        ),
        processAccountDeletionJobs(
          env.COMINAVI_DB,
          env.COMINAVI_PLAN_SYNC,
          env.COMINAVI_FOLLOWING_SNAPSHOTS,
          env.COMINAVI_AVATARS,
          env,
          env.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
        ),
        discoverCatalogRefreshJobs(env),
      ]).then(() => undefined),
    );
  },
} satisfies ExportedHandler<Cloudflare.Env, PushQueueMessage>;
