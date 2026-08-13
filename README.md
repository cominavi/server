# Cominavi Server

The public website and backend APIs for Cominavi, built with Astro and deployed
as a Cloudflare Worker at [cominavi.net](https://cominavi.net).

## Setup

The project uses the Node.js version in `.node-version` and pnpm through Corepack.

```sh
corepack enable
pnpm install --frozen-lockfile
```

## Runtime architecture

One Cloudflare Worker serves the whole `cominavi.net` origin:

- `src/worker.ts` exports a Hono `fetch` handler alongside the existing queue,
  scheduled, and Durable Object entrypoints.
- Hono owns `/api/v2` and sends those requests to oRPC's fetch-based
  `OpenAPIHandler`. These are ordinary HTTP/OpenAPI operations; the project does
  not expose an oRPC `RPCHandler` or use `RPCLink`.
- `GET /api/openapi.json` is generated from the same oRPC router and Zod schemas
  by `OpenAPIGenerator`, so route validation, server types, and the published
  OpenAPI 3.1 document cannot drift independently.
- Requests outside the v2 API are delegated to Astro's Cloudflare entrypoint.
  The home and privacy routes therefore stay on the same Worker and subdomain;
  their `.astro` files are thin layout wrappers around server-rendered React
  TSX page components, with no client hydration unless a component explicitly
  requests it.
- D1 access for the typed API is created with `drizzle-orm/d1` and the mirrored
  schema in `src/lib/db`. Existing SQL migrations remain the deployment-order
  authority while the unreleased API is migrated incrementally; there is no
  separate database service or API host.

The mobile contract is exclusively the generated oRPC/OpenAPI surface under
`/api/v2`; retired `/api/v1` paths fall through to Astro and return `404`. The
API stays in this Worker rather than a parallel service or RPC-only transport.
Architecture regressions are covered by `tests/api-architecture.test.ts`,
including the v1 tombstone, generated OpenAPI, Drizzle-backed D1 access, and an
explicit ban on `RPCLink`/`RPCHandler`.

The internal catalog publisher and scheduled refresh runner also use generated
OpenAPI operations: `POST /api/v2/internal/catalog-publications`, `POST
/api/v2/internal/catalog-refresh-jobs`, `POST
/api/v2/internal/catalog-artifacts/multipart`, and `PUT
/api/v2/internal/catalog-artifacts/multipart/{uploadID}/{partNumber}`. These
operations are not bearer- or publicly authenticated. Their three documented
API-key headers bind an HMAC signature to the timestamp, idempotency key, HTTP
method, exact path plus query, and SHA-256 digest of the exact request body.
Manual publication and scheduled refresh use distinct secrets; command
receipts and live claim/lease checks remain server-authoritative across replay
and multipart storage work.

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
COMINAVI_GOOGLE_CLIENT_IDS=...
COMINAVI_APPLE_KEY_ID=...
COMINAVI_APPLE_PRIVATE_KEY_P8_BASE64URL=...
COMINAVI_INVITE_TOKEN_SECRET=...
COMINAVI_PROVIDER_CREDENTIAL_KEY_V1=...
COMINAVI_CATALOG_PUBLISH_SECRET=...
COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET=...
```

The following-import API additionally needs local D1 and KV bindings named
`COMINAVI_DB` and `COMINAVI_FOLLOWING_SNAPSHOTS`. Its request/response contract,
privacy boundary, cooldown behavior, and cost model are documented in
[`docs/following-import-api.md`](docs/following-import-api.md).
Realtime updates, favorites, APNs devices, and crawler ingestion are documented
in [`docs/realtime-api.md`](docs/realtime-api.md).

Provider-neutral accounts, profiles, rotating refresh sessions, private R2
avatars, Shared Plans, invitations, and per-plan Durable Object sync are exposed
under `/api/v2`. The historical v1 wire/storage design is retained in
[`../meta/docs/shared-plans-v1.md`](../meta/docs/shared-plans-v1.md). Plan
creation returns the exact `syncBootstrap` bytes from the canonical Durable
Object root; clients must persist them before editing. Inbound Automerge
document mutation is enabled in production through
`COMINAVI_SHARED_PLAN_MUTATIONS_ENABLED`. Keep that flag coordinated with the
iOS `SharedPlanPresentationFeatures.production` gate; setting the Worker flag
to any value other than the literal `true` remains a fail-closed rollback.
Writable rollout requires iOS to consume the canonical
`tests/fixtures/automerge-sync-v1.json` operation and transport vectors, the adjacent
`tests/fixtures/automerge-swift-authored-v1.json` vectors, and every Swift/JS
cross-runtime gate. The adjacent
`tests/fixtures/automerge-swift-scalar-conflicts-v1.json` fixture is also
mandatory: its 15 Swift-authored scalar-resolution changes cover visible and
losing candidates, new values, presence same-state resolution, exact saved
documents and heads, and strict JavaScript topology validation (SHA-256
`01371acb866aa39e020b1964b6730d918a3f4a83d186a87e7c9ea530110bcbf8`).
The primary fixture is JavaScript-authored (SHA-256
`37a4890ce67e656ea39adfbd1c4605a20d323ab5cac4f5620846f4022a6665a9`).
The supplementary fixture is authored by automerge-swift 0.7.2 (SHA-256
`3637744f756aa9594771ff282705591b7b8401b1c55ec186b6e5551b75ed94d7`),
pins the primary fixture digest, and contains literal changes for all eight
content operations, four resolver scenarios, both sync directions, receipts,
restart behavior, and Unicode Text. Those gates are implemented and remain
mandatory release regressions. The backend enforces the
immutable semantic-operation ledger, actor provenance, exact patch
reconstruction, and the atomic notification outbox. A plan is capped at 50
active members, five live sessions per member, and 100 live sessions total.
The v1 document accepts ten typed operations: the original eight content
operations plus explicit circle-parent and need-parent resolution operations.
Each semantic Automerge change has the exact message
`operation:<lowercase operationID UUID>` and inserts that one matching operation
record; missing, malformed, duplicate, extra, or mismatched mappings fail before
patch reconstruction. Bootstrap initialization remains nonsemantic.
Parent resolution names the selected immutable parent-root operation and
enumerates every nested conflict by deterministic conflict ID, selected change
hash, and chosen typed value. It retains disjoint descendants and rejects a
resolution that would silently collapse an overlapping or unresolved nested
value. Normally the selected change hash names one of the nested conflict's
competing changes. When the selected parent root already assigns that same
output path, selected-parent precedence applies instead: the hash names the
selected parent root and the value must exactly equal that parent's assignment,
even though the hash is not one of the nested conflict's competing changes.
Both fixtures include non-empty scalar, object-valued, and three-root
nested-resolution vectors, including a literal selected-parent-precedence
vector. The mutation flag remains false until the production iOS client also
enforces the frozen payload/object encodings, conflict choices, backlog limit,
and recovery behavior exercised by these literals.
Notification payloads are stored once per event. Each accepted frame atomically
stores one compact, immutable membership-generation audience snapshot; the
Durable Object alarm expands event/recipient pairs to D1 in bounded idempotent
chunks, so an unsplittable offline Automerge backlog is never rejected merely
because it has many notification recipients.
The retained semantic-operation history is independently capped at 512 KiB,
computed as `sum(utf8(canonical-json(operation.payload)))` in one linear
preflight. This decoded budget is separate from the 10,000-operation cap and
compressed document/sync byte limits. Crossing it returns the typed
`plan_compaction_required` error so clients can present compaction UX instead
of retrying an unsplittable history. Ledger batches retain payload digests, and
notification payloads retain bounded typed previews, rather than duplicating
full memo text.
One inbound sync frame may introduce at most 1,000 Automerge changes since the
last server-acknowledged heads. The backend counts `Automerge.getChanges`
before topological sorting or exact reconstruction and closes an oversized
frame with code 4422 and typed `plan_sync_backlog_limit`. The canonical fixture
contains literal accepted-1,000 and rejected-1,001 sync dialogues and the exact
error details `maximumNewOperationsPerSyncFrame` and `receivedChanges`. This
pre-launch cap is not a standalone recovery mechanism:
the mutation flag must remain false until iOS enforces the same limit before
local commit, quarantines/exports an over-limit draft, and never retries the
same unsplittable raw backlog.
For the Swift interop gate, the root `planID` is an Automerge immutable
scalar/RawString; schema, version, index, and quantity numbers use signed `int`
encoding; operation metadata and payload strings use the JS Text/string
encoding; and memo splice offsets count Unicode scalars, including combining
marks and ZWJ sequences as their constituent scalars.
Plan, member, and invitation collections use opaque cursor pagination (50 items
by default, at most 100); a cursor is valid only for the endpoint that issued
it. Every REST mutation `requestId`/`Idempotency-Key` is a lowercase canonical
UUID. Google avatar bytes are validated and copied into immutable private R2
objects during sign-in rather than proxied from the provider; replaced objects
enter the durable D1 cleanup outbox and the scheduled Worker retries deletion.

## Commands

| Command                  | Action                                                     |
| :----------------------- | :--------------------------------------------------------- |
| `pnpm dev`               | Generate Worker types and start Astro locally              |
| `pnpm typegen`           | Regenerate Cloudflare Worker types                         |
| `pnpm build`             | Type-check and create the production Worker bundle         |
| `pnpm check`             | Run Astro and TypeScript diagnostics                       |
| `pnpm test`              | Run deterministic service, migration, and race tests       |
| `pnpm fixture:automerge` | Regenerate the Automerge 3.2.6 wire vectors                |
| `pnpm seed:c108`         | Regenerate the idempotent D1 seed from local retained data |
| `pnpm preview`           | Preview the production build locally                       |
| `pnpm deploy`            | Build and deploy to Cloudflare Workers                     |

## Deployment

GitHub Actions deploys production after every push to `main`, with a manual
`workflow_dispatch` fallback. The workflow installs the locked dependencies,
runs the test suite and production build, applies pending remote D1 migrations,
and then deploys the Worker. Deployments are serialized so two pushes cannot
race the same production resources. This path intentionally does not run the
Sentry source-map upload included in `pnpm deploy`.

Configure one GitHub Actions repository secret named
`CLOUDFLARE_API_TOKEN`. Start from Cloudflare's **Edit Cloudflare Workers**
token template, add account-level **D1 Edit** and **Queues Edit**, and limit the
token to the `GalvinGao` account and `cominavi.net` zone. The non-secret account
ID remains declared once in `wrangler.jsonc`. Existing Worker runtime secrets
remain in Cloudflare and are not copied into GitHub Actions.

The `cominavi.net` custom domain and its account ID are declared in
`wrangler.jsonc`. Before invoking Wrangler, verify that its active account name
is exactly `GalvinGao`; an account ID in the repository is not sufficient proof
of the current CLI identity. Production and sandbox use the same Worker routes,
but every Circle.ms request is bound to one explicit environment and never
probes or falls back to the other. Scheduled public catalog refresh accepts
production Circle.ms credentials only.

Workers Caching is enabled for the default entrypoint. API responses are
`private, no-store` unless a route deliberately opts into shared caching; the
canonical realtime snapshot uses separate browser and Cloudflare SWR headers.
Keep authentication, invitation, OAuth, and other user-specific responses
explicitly non-cacheable when adding routes handled by the Worker.

Configure the required secrets. `COMINAVI_PROVIDER_CREDENTIAL_KEY_V1` is an
exact 32-byte AES key encoded as unpadded base64url; retain an old key version
until all values encrypted by it have been rotated. Apple supplies the Key ID
and `.p8` private key; encode the complete `.p8` file as unpadded base64url. The
manual and scheduled catalog signer secrets must each contain at least 32
characters and must be different.

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
pnpm exec wrangler secret put COMINAVI_GOOGLE_CLIENT_IDS
pnpm exec wrangler secret put COMINAVI_APPLE_KEY_ID
pnpm exec wrangler secret put COMINAVI_APPLE_PRIVATE_KEY_P8_BASE64URL
pnpm exec wrangler secret put COMINAVI_INVITE_TOKEN_SECRET
pnpm exec wrangler secret put COMINAVI_PROVIDER_CREDENTIAL_KEY_V1
pnpm exec wrangler secret put COMINAVI_CATALOG_PUBLISH_SECRET
pnpm exec wrangler secret put COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET
```

`COMINAVI_APPLE_CLIENT_IDS` and `COMINAVI_APPLE_TEAM_ID` are nonsecret,
deployment-specific values in `wrangler.jsonc`. Before deployment, verify every
required binding is present without printing secret values.

Circle.ms does not expose a provider revocation endpoint in the integrated API.
Completed OAuth flows atomically erase their staged provider ciphertext after
installing the owner-bound credential, and the scheduled Worker erases expired
unclaimed starts/completions. This is an erase-only cleanup boundary; it cannot
remotely revoke a refresh token that was issued but never claimed.

Create and bind the D1 database, KV namespaces, private avatar R2 bucket,
`PlanSyncObject` Durable Object, invitation rate limiter, and push queue, then
apply every versioned D1 migration before deploying. Resource IDs belong in
`wrangler.jsonc`; credentials never do. The current C108 seed is generated from
the collector's pinned catalog and selected-post export; it creates no push
deliveries because historical update rows are non-notifying.

Catalog publication runs from a trusted Node version matching `.node-version`.
Use `pnpm catalog:publish -- --help` for a manual, explicitly authorized
publication. Scheduled refresh uses
`pnpm catalog:refresh -- <https-backend-base-url> <durable-work-root>` with the
scheduled signer secret. The work root must be durable and exclusive to the
runner; it retains resumable download and multipart state until the backend
confirms atomic publication. Never point either tool at a non-loopback HTTP
origin, and never place raw provider databases in a public R2 prefix.

The Astro Cloudflare adapter automatically provisions its `SESSION` KV namespace during deployment.
