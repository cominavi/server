# X following import API

The native app authenticates with its existing Circle.ms session, receives a short-lived ComiNavi token, and asks the backend to fetch the public accounts followed by one X account. Catalog matching stays on the device: the backend never receives the user's local catalog or circle matches.

## Endpoints

### `POST /api/v1/auth/circlems`

Headers:

```text
Authorization: Bearer <Circle.ms access token>
Content-Type: application/json
```

Body:

```json
{ "environment": "production" }
```

`environment` is `production` or `sandbox`. The endpoint validates the bearer token with Circle.ms `/User/Info` and returns a 15-minute HS256 JWT scoped to the verified Circle.ms user.

### `POST /api/v1/imports/x-followings`

Headers:

```text
Authorization: Bearer <ComiNavi JWT>
Content-Type: application/json
```

Body:

```json
{ "userName": "example" }
```

The response contains only the basic fields needed for on-device matching and presentation: stable X user ID, username, display name, canonical X URL, and optional profile image URL.

## Caching and cost boundary

- D1 atomically enforces one TwitterAPI.io fetch attempt per authenticated Circle.ms user every six hours.
- Requests made inside the interval return the last successful snapshot for the same X username. A different username receives `429 import_cooldown`.
- Failed imports never replace or delete the last successful KV snapshot. The app likewise retains its last successful local union.
- Pagination uses 200 accounts per request and fails closed on provider errors, missing cursors, repeated cursors, or more than 100 pages.
- TwitterAPI.io currently charges one credit per following, with a 60-credit minimum per request. A 1,000-account following list normally costs roughly 1,000 credits across five pages; the six-hour lease caps each authenticated user at four attempts per day.

## Cloudflare bindings

The Worker requires:

- secret `COMINAVI_JWT_SECRET` (at least 32 random characters)
- secret `TWITTERAPI_IO_API_KEY`
- D1 binding `COMINAVI_DB`
- KV binding `COMINAVI_FOLLOWING_SNAPSHOTS`

Apply `migrations/0001_following_imports.sql` to the bound D1 database before deployment. Never put either secret in `wrangler.jsonc` or the iOS application.

Before running any Wrangler command for this project, verify that the active Cloudflare account is `GalvinGao`.
