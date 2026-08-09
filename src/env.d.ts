/// <reference path="../.astro/types.d.ts" />

interface CominaviWorkerEnv {
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN: string;
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID: string;
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET: string;
  COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: string;
  COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: string;
  COMINAVI_JWT_SECRET: string;
  COMINAVI_CRAWLER_WEBHOOK_SECRET: string;
  COMINAVI_APNS_KEY_ID: string;
  COMINAVI_APNS_TEAM_ID: string;
  COMINAVI_APNS_PRIVATE_KEY: string;
  COMINAVI_APNS_BUNDLE_IDS: string;
  TWITTERAPI_IO_API_KEY: string;
  COMINAVI_DB: D1Database;
  COMINAVI_FOLLOWING_SNAPSHOTS: KVNamespace;
  COMINAVI_PUSH_QUEUE: Queue<
    import("./lib/server/push-queue").PushQueueMessage
  >;
}

interface Env extends CominaviWorkerEnv {}

declare namespace Cloudflare {
  interface Env extends CominaviWorkerEnv {}
}
