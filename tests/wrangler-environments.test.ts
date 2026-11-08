import assert from "node:assert/strict";
import test from "node:test";
import { unstable_readConfig } from "wrangler";

// The subset of the resolved Wrangler config these tests compare.
interface EnvironmentConfig {
  name?: string;
  routes?: Array<string | { pattern: string }>;
  vars: Record<string, unknown>;
  d1_databases: Array<{
    binding: string;
    database_name?: string;
    database_id?: string;
  }>;
  kv_namespaces: Array<{ binding: string; id?: string }>;
  r2_buckets: Array<{ binding: string; bucket_name?: string }>;
  durable_objects: { bindings: Array<{ name: string }> };
  queues: {
    producers?: Array<{ binding: string; queue: string }>;
    consumers?: Array<{ queue: string; dead_letter_queue?: string }>;
  };
  ratelimits: Array<{ name: string; namespace_id: string }>;
}

// Read wrangler.jsonc directly (never the redirected build output), so the
// assertions hold no matter which environment was built last.
function readEnvironment(env?: string): EnvironmentConfig {
  return unstable_readConfig({
    config: "wrangler.jsonc",
    env,
  }) as unknown as EnvironmentConfig;
}

const production = readEnvironment();
const staging = readEnvironment("staging");

test("production keeps its name, origin, and ENVIRONMENT", () => {
  assert.equal(production.name, "cominavi-homepage");
  assert.deepEqual(
    production.routes?.map((route) =>
      typeof route === "string" ? route : route.pattern,
    ),
    ["cominavi.net"],
  );
  assert.equal(production.vars.ENVIRONMENT, "production");
});

test("staging is a separate Worker on staging.cominavi.net", () => {
  assert.equal(staging.name, "cominavi-homepage-staging");
  assert.deepEqual(
    staging.routes?.map((route) =>
      typeof route === "string" ? route : route.pattern,
    ),
    ["staging.cominavi.net"],
  );
  assert.equal(staging.vars.ENVIRONMENT, "staging");
});

test("staging declares every production binding and shares no resource", () => {
  const bindingNames = (config: EnvironmentConfig) =>
    [
      ...config.d1_databases.map((database) => database.binding),
      ...config.kv_namespaces.map((namespace) => namespace.binding),
      ...config.r2_buckets.map((bucket) => bucket.binding),
      ...config.durable_objects.bindings.map((binding) => binding.name),
      ...config.queues.producers!.map((producer) => producer.binding),
      ...config.ratelimits.map((limiter) => limiter.name),
      ...Object.keys(config.vars),
    ].sort();
  assert.deepEqual(bindingNames(staging), bindingNames(production));

  const resources = (config: EnvironmentConfig) => [
    ...config.d1_databases.flatMap((database) => [
      database.database_name,
      database.database_id,
    ]),
    ...config.kv_namespaces.map((namespace) => namespace.id),
    ...config.r2_buckets.map((bucket) => bucket.bucket_name),
    ...config.queues.producers!.map((producer) => producer.queue),
    ...config.queues.consumers!.flatMap((consumer) => [
      consumer.queue,
      consumer.dead_letter_queue,
    ]),
    ...config.ratelimits.map((limiter) => limiter.namespace_id),
  ];
  const productionResources = new Set(resources(production));
  for (const resource of resources(staging)) {
    assert.ok(resource, "every staging resource is named");
    assert.ok(
      !productionResources.has(resource),
      `staging must not share ${resource} with production`,
    );
  }
});

test("staging never accepts the production App Store bundle for APNs or Apple", () => {
  for (const key of ["COMINAVI_APNS_BUNDLE_IDS", "COMINAVI_APPLE_CLIENT_IDS"]) {
    const ids = String(staging.vars[key]).split(",");
    assert.ok(!ids.includes("llc.mikunet.cominavi"), key);
  }
});
