# Realtime catalog service

The Cloudflare Worker keeps identity and mutable event state out of the bundled
iOS catalog. Circle.ms remains the identity provider; ComiNavi issues a
short-lived service JWT after verifying the Circle.ms access token. D1 stores a
stable service user ID, favorites, device registrations, immutable crawler
events, and current state projections.

## Client authentication

`POST /api/v2/auth/circlems/start` starts the backend-owned Circle.ms OAuth flow
with a client instance ID and PKCE challenge. After the browser callback returns
a short-lived completion code, `POST /api/v2/auth/circlems/complete` exchanges
that code and issues the ComiNavi access and rotating refresh tokens. Circle.ms
provider credentials stay encrypted on the backend and never travel in a
callback URL. Every authenticated endpoint verifies both the ComiNavi token and
the user's current `auth_version`. `POST /api/v2/auth/logout` durably advances
that version using the exact request ID, predecessor bearer token, and refresh
token so lost-response retries return the same receipt.

No Circle.ms password, X credential, or APNs signing key is stored in D1 or sent
to the app.

## Favorites

`GET /api/v2/me/favorites/{eventNumber}` returns the current server revision and
active favorites. `PUT` replaces the user's complete snapshot:

```json
{
  "baseRevision": 4,
  "mutationID": "9fb99b20-4694-4c56-bf33-15fd642227ac",
  "favorites": [{ "wcID": 23000001, "color": 2, "notificationsEnabled": true }]
}
```

WCID is the stable public catalog identity. `baseRevision` prevents a stale
device from silently deleting a newer snapshot; replaying the same mutation ID
is idempotent. The app keeps its local favorites usable when synchronization
fails and retries after the next successful authentication.

## Device registration

`PUT /api/v2/me/devices/{installationID}` registers an APNs token, environment,
and allow-listed bundle ID. `DELETE` disables it. A token is SHA-256 indexed and
can belong to only one current service user. Logging out must disable the local
installation before discarding the service session.

## Realtime updates

`GET /api/v2/events/{eventNumber}/updates` is public. The query-free form
returns every immutable update for backward compatibility. New clients start
with `?afterCursor=0`, persist the last returned cursor, and request later pages
with `?afterCursor={cursor}`. Incremental pages are bounded to 500 updates and
report `hasMore`; clients continue from the last update while it is true. Each
event contains the source post, all retained media (including shinagaki and
covers), and every WCID target, so A+B and one-account-many mappings remain
explicit.

The stable full URL and canonical `afterCursor` page URLs are shared at
Cloudflare's edge. Browsers may reuse a response for 60 seconds; Cloudflare
serves stale data while one request revalidates in the background and may
retain the last good response during a short origin outage. Every response
emits a content-derived ETag and honors `If-None-Match`. Unknown, duplicated,
negative, or non-canonical cursor queries are rejected without caching so they
cannot poison the shared cache. The fixed page boundary lets fresh installs
converge on the same edge-cache keys instead of inventing client-selected page
sizes.

State heads are a projection, not the audit log. They advance by source post
time, source revision, then event key. Late or duplicate webhooks therefore
cannot overwrite a newer booth state.

## Crawler ingress

`POST /api/v2/internal/crawler/events` is not a user endpoint. It is described
in the generated OpenAPI document but requires all three HMAC security headers,
not a user bearer token:

```text
Idempotency-Key: twitterapi:<post-id>
X-ComiNavi-Timestamp: <unix seconds>
X-ComiNavi-Signature: v1=<HMAC-SHA256 hex>
```

The signature covers the exact bytes
`<timestamp>.<idempotency-key>.<request-body>`. Requests outside five minutes,
payloads above 1 MB, invalid state enums, unknown WCIDs, and an idempotency key
reused with different bytes fail closed. One request may contain up to 50
events and must remain within the service's bounded D1 statement budget.
Every event key is content-addressed as
`twitterapi:<post-id>:<update-kind>:v<source-revision>:<sha256>`; the digest
binds the classifier state and sorted stable WCID targets, so a revised
classification cannot partially overwrite an immutable event.

The crawler's PostgreSQL outbox retries the same signed logical request after a
network or process failure. D1 stores the immutable batch/event first, advances
each circle/state head only when the observation is newer, and creates at most
one delivery per event/user/device. An A+B update consequently produces one
notification, not two.

## APNs delivery

The D1 transaction creates durable notification deliveries before advancing
the current head. A Cloudflare Queue consumer claims them, rechecks that the
favorite and device are still active, then sends APNs with a short-lived ES256
provider token. Attendance, inventory, and presence changes use the
time-sensitive interruption level; artwork updates use active delivery.

Transient failures retry with backoff and a dead-letter queue. Expired
processing leases are put back into retry after a Worker termination. APNs responses
that prove a token is invalid disable that device. The two-minute scheduled
handler recovers due D1 deliveries that were committed before a queue publish
failed.

## Initial C108 seed

Run `pnpm seed:c108` to regenerate `seed/c108-realtime.sql` from the pinned
Circle.ms SQLite catalog and retained collector export. Apply it with Wrangler
only after verifying the active account is exactly `GalvinGao`. Seed rows are
idempotent and non-notifying.
