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
```

## Commands

| Command        | Action                                             |
| :------------- | :------------------------------------------------- |
| `pnpm dev`     | Generate Worker types and start Astro locally      |
| `pnpm typegen` | Regenerate Cloudflare Worker types                 |
| `pnpm build`   | Type-check and create the production Worker bundle |
| `pnpm preview` | Preview the production build locally               |
| `pnpm deploy`  | Build and deploy to Cloudflare Workers             |

## Deployment

Wrangler is pinned to the GalvinGao Cloudflare account and the `cominavi.net` custom domain in `wrangler.jsonc`. Production and sandbox use the same Worker routes. Token exchanges try production first and sandbox second, using separate origins and credentials for each attempt.

Configure all four OAuth secrets:

```sh
pnpm exec wrangler secret put COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID
pnpm exec wrangler secret put COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET
pnpm exec wrangler secret put COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID
pnpm exec wrangler secret put COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET
```

The Astro Cloudflare adapter automatically provisions its `SESSION` KV namespace during deployment.
