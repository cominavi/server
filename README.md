# Cominavi Homepage

The public website and Circle.ms OAuth endpoints for Cominavi, built with Astro and deployed as a Cloudflare Worker at [cominavi.net](https://cominavi.net).

## Setup

The project uses the Node.js version in `.node-version` and pnpm through Corepack.

```sh
corepack enable
pnpm install --frozen-lockfile
```

For local OAuth development, create `.dev.vars` with:

```dotenv
COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID=...
COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET=...
COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID=...
COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET=...
COMINAVI_JWT_SECRET=...
TWITTERAPI_IO_API_KEY=...
COMINAVI_CRAWLER_WEBHOOK_SECRET=...
COMINAVI_APNS_KEY_ID=...
COMINAVI_APNS_TEAM_ID=...
COMINAVI_APNS_PRIVATE_KEY=...
```

The following-import API additionally needs local D1 and KV bindings named
`COMINAVI_DB` and `COMINAVI_FOLLOWING_SNAPSHOTS`. Its request/response contract,
privacy boundary, cooldown behavior, and cost model are documented in
[`docs/following-import-api.md`](docs/following-import-api.md).
Realtime updates, favorites, APNs devices, and crawler ingestion are documented
in [`docs/realtime-api.md`](docs/realtime-api.md).

## Commands

| Command          | Action                                                     |
| :--------------- | :--------------------------------------------------------- |
| `pnpm dev`       | Generate Worker types and start Astro locally              |
| `pnpm typegen`   | Regenerate Cloudflare Worker types                         |
| `pnpm build`     | Type-check and create the production Worker bundle         |
| `pnpm seed:c108` | Regenerate the idempotent D1 seed from local retained data |
| `pnpm preview`   | Preview the production build locally                       |
| `pnpm deploy`    | Build and deploy to Cloudflare Workers                     |

## Deployment

The `cominavi.net` custom domain and its account ID are declared in
`wrangler.jsonc`. Before invoking Wrangler, verify that its active account name
is exactly `GalvinGao`; an account ID in the repository is not sufficient proof
of the current CLI identity. Production and sandbox use the same Worker routes.
OAuth token exchanges try production first and sandbox second, using separate
origins and credentials for each attempt.

Configure all four OAuth secrets:

```sh
pnpm exec wrangler secret put COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID
pnpm exec wrangler secret put COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET
pnpm exec wrangler secret put COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID
pnpm exec wrangler secret put COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET
pnpm exec wrangler secret put COMINAVI_JWT_SECRET
pnpm exec wrangler secret put TWITTERAPI_IO_API_KEY
pnpm exec wrangler secret put COMINAVI_CRAWLER_WEBHOOK_SECRET
pnpm exec wrangler secret put COMINAVI_APNS_KEY_ID
pnpm exec wrangler secret put COMINAVI_APNS_TEAM_ID
pnpm exec wrangler secret put COMINAVI_APNS_PRIVATE_KEY
```

Create and bind the D1 database, KV namespaces, and push queue, then apply every
versioned D1 migration before deploying. Resource IDs belong in
`wrangler.jsonc`; credentials never do. The current C108 seed is generated from
the collector's pinned catalog and selected-post export; it creates no push
deliveries because historical update rows are non-notifying.

The Astro Cloudflare adapter automatically provisions its `SESSION` KV namespace during deployment.
