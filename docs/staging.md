# Hosted staging (`staging.cominavi.net`)

Staging is a second Worker, `cominavi-homepage-staging`, built from the same
code as production and declared as `env.staging` in `wrangler.jsonc`. It exists
so agents, Debug builds, and the staging TestFlight lane can test against
production-shaped data without touching production state or production auth.
Owner decisions: data-layering proposal §7, Q8, and Q9 (cominavi/cominavi#67).

## What is separate

Nothing is shared with production. Wrangler does not inherit bindings, vars,
routes, or triggers into an environment, so `env.staging` redeclares each one,
and `tests/wrangler-environments.test.ts` fails if a staging binding is
missing or reuses a production resource.

| Kind                              | Production                           | Staging                                              |
| --------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| Worker                            | `cominavi-homepage`                  | `cominavi-homepage-staging`                          |
| Route                             | `cominavi.net`                       | `staging.cominavi.net` (custom domain)               |
| `ENVIRONMENT` var                 | `production`                         | `staging`                                            |
| D1 `COMINAVI_DB`                  | `cominavi`                           | `cominavi-staging`                                   |
| KV `SESSION`                      | production namespace                 | `cominavi-staging-session`                           |
| KV `COMINAVI_FOLLOWING_SNAPSHOTS` | production namespace                 | `cominavi-staging-following-snapshots`               |
| R2 `COMINAVI_AVATARS`             | `cominavi-avatars`                   | `cominavi-avatars-staging`                           |
| R2 `COMINAVI_CATALOGS`            | `cominavi-catalogs-private`          | `cominavi-catalogs-private-staging`                  |
| R2 `COMINAVI_CATALOG_DOWNLOADS`   | `cominavi-catalog-downloads`         | `cominavi-catalog-downloads-staging`                 |
| Durable Object `PlanSyncObject`   | per Worker                           | per Worker (automatic)                               |
| Queue + DLQ                       | `cominavi-push`, `cominavi-push-dlq` | `cominavi-push-staging`, `cominavi-push-staging-dlq` |
| Rate limiter namespace            | `1001`                               | `1002`                                               |
| Secrets                           | production values                    | distinct values, never copied from production        |
| APNs / Apple bundle IDs           | production, staging, debug           | staging, debug only                                  |

`ENVIRONMENT` is the switch for environment-gated code. Code that must never
run in production (for example the test identity provider) must fail closed:
allow only an explicit non-production value, never "anything but
`production`".

## Building and deploying

The Astro Cloudflare adapter picks the environment at **build** time from
`CLOUDFLARE_ENV` and writes a flattened `dist/server/wrangler.json` plus a
`.wrangler/deploy/config.json` redirect. `wrangler deploy` then deploys that
build. So the environment must be the same for the build and the deploy:

```sh
pnpm deploy:staging   # build with CLOUDFLARE_ENV=staging, apply staging D1 migrations, deploy
```

The production pipeline (`.github/workflows/deploy.yml`, `pnpm deploy`) does
not set `CLOUDFLARE_ENV` and is unchanged. Never run `pnpm deploy` with
`CLOUDFLARE_ENV=staging` exported, or the reverse.

Commands other than `deploy` (D1, secrets, R2) should pass
`-c wrangler.jsonc --env staging`. The explicit `-c` skips the build redirect,
so the selected environment never depends on which environment was built
last.

## One-time setup (owner/operator; not done by agents)

Creating these resources, DNS, and secrets is an outward action on Cloudflare
account `bee683f3…`. Run them once, from this repository with Node from
`.node-version`.

### 1. Resources

```sh
npx wrangler d1 create cominavi-staging
npx wrangler kv namespace create cominavi-staging-session
npx wrangler kv namespace create cominavi-staging-following-snapshots
npx wrangler r2 bucket create cominavi-avatars-staging
npx wrangler r2 bucket create cominavi-catalogs-private-staging
npx wrangler r2 bucket create cominavi-catalog-downloads-staging
npx wrangler queues create cominavi-push-staging
npx wrangler queues create cominavi-push-staging-dlq
```

Then replace the zero placeholder IDs in `env.staging` (`database_id`, both KV
`id`s) with the printed IDs in a follow-up commit. The Durable Object
namespace and rate limiter need no creation step.

### 2. Schema

```sh
npx wrangler d1 migrations apply COMINAVI_DB -c wrangler.jsonc --env staging --remote
```

Catalog and overlay data come from the production→staging mirror tool
(below), not from the committed seed.

### 3. Secrets

Every value is generated fresh for staging. None is copied from production.
The two catalog-signing secrets must differ from each other.

```sh
for name in COMINAVI_JWT_SECRET COMINAVI_INVITE_TOKEN_SECRET \
  COMINAVI_CATALOG_PUBLISH_SECRET COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET \
  COMINAVI_CRAWLER_WEBHOOK_SECRET COMINAVI_CRAWLER_SNAPSHOT_SECRET; do
  openssl rand -base64 48 | tr -d '\n' |
    npx wrangler secret put "$name" -c wrangler.jsonc --env staging
done

# AES-256-GCM key: exactly 32 bytes, base64url without padding
openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n' |
  npx wrangler secret put COMINAVI_PROVIDER_CREDENTIAL_KEY_V1 -c wrangler.jsonc --env staging
```

Optional, only if staging should offer these features:

- Circle.ms sandbox OAuth: `COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID`,
  `COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET`. This needs a Circle.ms
  sandbox client registration and a redirect fix (the redirect is hardcoded
  to `https://cominavi.net/oauth/circlems/landing`). Not needed for agents:
  the test identity provider replaces it.
- APNs sandbox: `COMINAVI_APNS_KEY_ID`, `COMINAVI_APNS_TEAM_ID`,
  `COMINAVI_APNS_PRIVATE_KEY`. Staging bundle IDs register sandbox tokens.
- Google / Apple sign-in: `COMINAVI_GOOGLE_CLIENT_IDS`, `COMINAVI_APPLE_KEY_ID`,
  `COMINAVI_APPLE_PRIVATE_KEY_P8_BASE64URL`.
- `TWITTERAPI_IO_API_KEY` for the following import.

A missing optional secret disables that feature on staging; it never falls
back to production.

### 4. DNS and first deploy

```sh
pnpm deploy:staging
```

The custom-domain route creates the `staging.cominavi.net` record in the
`cominavi.net` zone on first deploy. Check it with
`curl -sI https://staging.cominavi.net/api/openapi.json`.

## Production → staging mirror

`tools/mirror-published-data.ts` copies **published, sanitized** catalog and
overlay data one way, from production into staging or a local dev server
(proposal §7, Q9). It replaces the committed C108 seed and the review-demo
cherry-pick for local work.

```sh
# 1. Export from production (read-only) into a local bundle directory.
COMINAVI_MIRROR_SOURCE_API_TOKEN=... pnpm mirror:export --out ../mirror-bundle

# 2a. Import into local dev state (after `wrangler d1 migrations apply --local`).
pnpm mirror:import --bundle ../mirror-bundle --target local

# 2b. Or import into staging (after its migrations are applied).
pnpm mirror:import --bundle ../mirror-bundle --target staging
```

What it copies: catalog events, editions, capabilities and provider aliases;
published and superseded version metadata; the normalized rows and the
derived (client-download) artifact of each **active** version, plus the
normalized rows of any superseded version a current tag overlay is still bound
to; stable and
edition circles; the current tag-overlay and crawler-snapshot heads with their
objects. Object metadata is rebuilt from the D1 rows, and every object's
SHA-256 and size are checked against its row on export and import.

What it never copies: raw Circle.ms source files (`raw/…`, `private_source`
artifacts), users, identities, sessions, tokens, favorites, Shared Plans,
devices, notifications, receipts, jobs, or any table not listed above.

Safety:

- **Export** talks to the Cloudflare REST API with
  `COMINAVI_MIRROR_SOURCE_API_TOKEN`: one D1 `query` endpoint for SELECTs and
  R2 object GETs. The tool refuses any SQL that is not a single `SELECT` and
  any non-GET object request. Give it a dedicated token with the least
  privilege the API accepts: Workers R2 Storage Read, plus D1 access for the
  `cominavi` database. If Cloudflare requires D1 Edit for the query endpoint,
  the tool still never issues a write.
- **Import** writes through Worker bindings (`getPlatformProxy`): local
  miniflare state for `local`, or remote bindings to exactly the staging D1
  and the two staging catalog buckets for `staging`. It refuses a target that
  shares a Worker name, database name or ID, or bucket name with production,
  and refuses the zero placeholder database ID. Every production bucket counts,
  not only the two catalog buckets. Staging import uses the
  operator's Wrangler auth (`wrangler login` or `CLOUDFLARE_API_TOKEN`).
- Both steps are idempotent: objects already present with the same size,
  content type and metadata are skipped; immutable rows use
  `INSERT OR IGNORE`; rows whose state changes in production (events,
  editions, capabilities, aliases, version state, stable/edition circles,
  overlay and snapshot heads) are upserted only when they differ. Target-only
  rows are never deleted.
- Publication is the last step: new versions are written as invisible
  `staging` rows, and version states plus event activation
  (`catalog_events.active_version_id`) are applied together in one atomic
  batch after every other table. A failed or partial import leaves the
  previous catalog active and published. Alias retirements are applied before
  live replacements.
- Crawler snapshots are installed in that same final batch.
  `publication_cursor` points into production's realtime log, which is not
  mirrored, so it is set to the target's own log position, read inside the
  batch: the imported snapshot replaces every target event committed before
  it. The snapshot generation is part of the canonical object and is never
  rewritten: if the target already has a different snapshot at the same
  generation (its own history), that event's snapshot is skipped with a
  warning and the rest of the bundle still imports. An older bundle never moves a snapshot head back to a lower generation.
  Re-importing the same
  snapshot keeps its original fence.
- Export reads are not one transaction. If production publishes a catalog
  between two reads, the export notices the inconsistent snapshot and reads
  everything again (up to three attempts).
- `CLOUDFLARE_ENV` is ignored: the source is always the top-level
  (production) config, and the target is chosen only by `--target`.

## Known production-pinned values

These still name `cominavi.net` on staging and are out of scope for the
environment split itself:

- JWT `iss` is `cominavi.net` on both. Tokens never cross environments because
  the signing secrets differ.
- Invitation `canonicalURL` is `https://cominavi.net/join/<token>`.
- The Circle.ms OAuth `redirect_uri` is pinned to production (see above).
- `/api/openapi.json` lists `https://cominavi.net` as its server.

## Tearing down

Delete the Worker (`npx wrangler delete -c wrangler.jsonc --env staging`), the
resources above, and the `env.staging` block. Production is unaffected.
