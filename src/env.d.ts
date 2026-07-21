/// <reference path="../.astro/types.d.ts" />

interface CominaviWorkerEnv {
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN: string;
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID: string;
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET: string;
}

interface Env extends CominaviWorkerEnv {}

declare namespace Cloudflare {
  interface Env extends CominaviWorkerEnv {}
}
