import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  discoverCatalogRefreshJobs,
  finishCatalogRefreshJob,
  leaseCatalogRefreshJob,
  releaseCatalogRefreshJob,
  renewCatalogRefreshJob,
} from "../src/lib/server/catalog-refresh";
import { storeCircleCredential } from "../src/lib/server/provider-credentials";
import { SQLiteD1Database } from "./sqlite-d1";

test("scheduled discovery resolves provider event ID separately from Comiket number", async () => {
  const database = setup();
  await seedCredential(database, 1_000);
  const requests: URL[] = [];
  const queued = await discoverCatalogRefreshJobs(
    bindings(database),
    async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/WebCatalog/GetEventList") {
        return Response.json({
          status: "success",
          response: { list: [{ EventId: 190, EventNo: 108 }] },
        });
      }
      assert.equal(url.pathname, "/CatalogBase/All/");
      assert.equal(url.searchParams.get("EventId"), "190");
      return catalogBaseResponse();
    },
    100,
  );
  assert.equal(queued, 1);
  assert.deepEqual(
    database.rows(
      `SELECT provider_circlems_event_id FROM catalog_events WHERE comiket_no = 108`,
    ),
    [{ provider_circlems_event_id: 190 }],
  );
  assert.deepEqual(
    database.rows(
      `SELECT comiket_no, provider_circlems_event_id, source_md5_hint, state
       FROM catalog_refresh_jobs`,
    ),
    [
      {
        comiket_no: 108,
        provider_circlems_event_id: 190,
        source_md5_hint: `${"a".repeat(32)}:${"b".repeat(32)}`,
        state: "queued",
      },
    ],
  );
  assert.deepEqual(
    requests.map((url) => url.pathname),
    ["/WebCatalog/GetEventList", "/CatalogBase/All/"],
  );
  const job = await leaseCatalogRefreshJob(
    bindings(database),
    "22222222-2222-4222-8222-222222222222",
    "22222222-2222-4222-8222-222222222222:lease",
    "1".repeat(64),
    async () => catalogBaseResponse("fresh"),
    800,
  );
  assert.equal(job?.comiketNo, 108);
  assert.equal(
    job?.sourceMainURL,
    "https://downloads.example/fresh-main.sqlite.gz",
  );
  await releaseCatalogRefreshJob(
    database.binding,
    job!.id,
    "22222222-2222-4222-8222-222222222222",
    "fixture_failure",
    "22222222-2222-4222-8222-222222222222:release",
    "2".repeat(64),
    801,
  );
  assert.equal(
    database.rows("SELECT state FROM catalog_refresh_jobs")[0]?.state,
    "queued",
  );
});

test("refresh command receipts prevent lease drift and replay terminal commands", async () => {
  const database = setup();
  await seedCredential(database, 10_000);
  database.native.exec(`
    INSERT INTO catalog_events (
      comiket_no, name, provider_circlems_event_id, created_at, updated_at
    ) VALUES (109, 'Comic Market 109', 191, 1, 1);
    INSERT INTO catalog_refresh_jobs (
      id, user_identity_id, comiket_no, provider_circlems_event_id,
      source_md5_hint, state, attempt_count, created_at, updated_at
    ) VALUES
      ('11111111-1111-4111-8111-111111111111', 7, 108, 190,
       '${"a".repeat(32)}:${"b".repeat(32)}', 'queued', 0, 1, 1),
      ('22222222-2222-4222-8222-222222222222', 7, 109, 191,
       '${"a".repeat(32)}:${"b".repeat(32)}', 'queued', 0, 2, 2);
  `);
  const leaseID = "33333333-3333-4333-8333-333333333333";
  const key = `${leaseID}:lease`;
  const payload = "3".repeat(64);
  const fetchSource = async () => catalogBaseResponse("leased");
  const first = await leaseCatalogRefreshJob(
    bindings(database),
    leaseID,
    key,
    payload,
    fetchSource,
    100,
  );
  const replay = await leaseCatalogRefreshJob(
    bindings(database),
    leaseID,
    key,
    payload,
    fetchSource,
    101,
  );
  assert.equal(first?.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(replay?.id, first?.id);
  assert.equal(
    database.rows(
      `SELECT lease_expires_at FROM catalog_refresh_jobs
       WHERE id = '${first!.id}'`,
    )[0]?.lease_expires_at,
    7_300,
  );
  const renewedUntil = await renewCatalogRefreshJob(
    database.binding,
    first!.id,
    leaseID,
    `${"a".repeat(32)}:${"b".repeat(32)}`,
    `${leaseID}:renew:1`,
    "a".repeat(64),
    102,
  );
  assert.equal(renewedUntil, 7_302);
  assert.equal(
    await renewCatalogRefreshJob(
      database.binding,
      first!.id,
      leaseID,
      `${"a".repeat(32)}:${"b".repeat(32)}`,
      `${leaseID}:renew:1`,
      "a".repeat(64),
      103,
    ),
    7_302,
  );
  assert.equal(
    database.rows(
      `SELECT lease_expires_at FROM catalog_refresh_jobs
       WHERE id = '${first!.id}'`,
    )[0]?.lease_expires_at,
    7_302,
  );
  await assert.rejects(
    renewCatalogRefreshJob(
      database.binding,
      first!.id,
      leaseID,
      `${"a".repeat(32)}:${"b".repeat(32)}`,
      `${leaseID}:renew:1`,
      "a".repeat(64),
      7_302,
    ),
    (error: unknown) => hasCode(error, "catalog_refresh_authority_lost"),
  );
  assert.deepEqual(
    database.rows(
      "SELECT id, state FROM catalog_refresh_jobs ORDER BY created_at",
    ),
    [
      { id: "11111111-1111-4111-8111-111111111111", state: "leased" },
      { id: "22222222-2222-4222-8222-222222222222", state: "queued" },
    ],
  );
  await assert.rejects(
    leaseCatalogRefreshJob(
      bindings(database),
      leaseID,
      key,
      "4".repeat(64),
      fetchSource,
      102,
    ),
    (error: unknown) => hasCode(error, "idempotency_conflict"),
  );

  const releaseKey = `${leaseID}:release`;
  await releaseCatalogRefreshJob(
    database.binding,
    first!.id,
    leaseID,
    "fixture_failure",
    releaseKey,
    "5".repeat(64),
    103,
  );
  await releaseCatalogRefreshJob(
    database.binding,
    first!.id,
    leaseID,
    "fixture_failure",
    releaseKey,
    "5".repeat(64),
    104,
  );
  await assert.rejects(
    releaseCatalogRefreshJob(
      database.binding,
      first!.id,
      leaseID,
      "changed",
      releaseKey,
      "6".repeat(64),
      105,
    ),
    (error: unknown) => hasCode(error, "idempotency_conflict"),
  );

  const secondLeaseID = "44444444-4444-4444-8444-444444444444";
  const leasedAgain = await leaseCatalogRefreshJob(
    bindings(database),
    secondLeaseID,
    `${secondLeaseID}:lease`,
    "7".repeat(64),
    fetchSource,
    106,
  );
  const versionID = `c108-v1-${"9".repeat(24)}`;
  database.native.exec(`
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, derived_sha256, derived_bytes,
      created_at, published_at
    ) VALUES ('${versionID}', 108, 1, 'published', '${leasedAgain!.id}',
      '${"a".repeat(64)}', '${"b".repeat(64)}', '${"c".repeat(64)}', 1, 1, 106);
    UPDATE catalog_events SET active_version_id = '${versionID}'
    WHERE comiket_no = 108;
  `);
  const completeKey = `${secondLeaseID}:complete`;
  await finishCatalogRefreshJob(
    database.binding,
    leasedAgain!.id,
    secondLeaseID,
    versionID,
    completeKey,
    "8".repeat(64),
    107,
  );
  await finishCatalogRefreshJob(
    database.binding,
    leasedAgain!.id,
    secondLeaseID,
    versionID,
    completeKey,
    "8".repeat(64),
    108,
  );
  await assert.rejects(
    finishCatalogRefreshJob(
      database.binding,
      leasedAgain!.id,
      secondLeaseID,
      versionID,
      completeKey,
      "9".repeat(64),
      109,
    ),
    (error: unknown) => hasCode(error, "idempotency_conflict"),
  );
});

test("expired owner credential refreshes before CatalogBase discovery", async () => {
  const database = setup();
  await seedCredential(database, 99);
  const authorizations: string[] = [];
  const queued = await discoverCatalogRefreshJobs(
    bindings(database),
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/OAuth2/Token") {
        assert.equal(String(init?.body).includes("private-refresh"), true);
        return Response.json({
          access_token: "refreshed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }
      authorizations.push(
        new Headers(init?.headers).get("Authorization") ?? "",
      );
      if (url.pathname === "/WebCatalog/GetEventList") {
        return Response.json({
          status: "success",
          response: { list: [{ EventId: 190, EventNo: 108 }] },
        });
      }
      return catalogBaseResponse();
    },
    100,
  );
  assert.equal(queued, 1);
  assert.deepEqual(authorizations, [
    "Bearer refreshed-access",
    "Bearer refreshed-access",
  ]);
  assert.equal(
    String(
      database.rows("SELECT ciphertext FROM provider_credentials")[0]
        ?.ciphertext,
    ).includes("refreshed-access"),
    false,
  );
});

test("catalog discovery prioritizes an untried valid identity over five retried failures", async () => {
  const database = setup();
  await seedCredential(database, 10_000);
  for (let identityID = 8; identityID <= 12; identityID += 1) {
    const userID = identityID - 6;
    database.native
      .prepare(
        `INSERT INTO users (
           id, public_id, display_name, profile_revision, auth_version,
           created_at, updated_at, last_authenticated_at
         ) VALUES (?1, ?2, ?3, 1, 1, 1, 1, ?4)`,
      )
      .run(
        userID,
        String(identityID).padStart(32, "0"),
        `Owner ${identityID}`,
        identityID === 12 ? 1 : 100 + identityID,
      );
    database.native
      .prepare(
        `INSERT INTO user_identities (
           id, user_id, provider, provider_environment, provider_subject,
           provider_user_id, created_at, updated_at, last_authenticated_at
         ) VALUES (?1, ?2, 'circlems', 'production', ?3, ?4, 1, 1, ?5)`,
      )
      .run(
        identityID,
        userID,
        String(identityID),
        identityID,
        identityID === 12 ? 1 : 100 + identityID,
      );
    await storeCircleCredential(
      database.binding,
      userID,
      identityID,
      {
        accessToken: identityID === 12 ? "good" : `bad-${identityID}`,
        refreshToken: null,
        accessExpiresAt: 10_000,
        scopes: ["catalog"],
      },
      key(),
      1,
    );
  }
  const fetcher: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get("Authorization");
    if (authorization !== "Bearer good") {
      return Response.json({ status: "failed" }, { status: 401 });
    }
    if (new URL(String(input)).pathname === "/WebCatalog/GetEventList") {
      return Response.json({
        status: "success",
        response: { list: [{ EventId: 190, EventNo: 108 }] },
      });
    }
    return catalogBaseResponse("fair");
  };
  assert.equal(
    await discoverCatalogRefreshJobs(bindings(database), fetcher, 100),
    0,
  );
  assert.equal(
    await discoverCatalogRefreshJobs(bindings(database), fetcher, 160),
    1,
  );
  assert.equal(
    database.rows(
      `SELECT user_identity_id FROM catalog_refresh_jobs WHERE state = 'queued'`,
    )[0]?.user_identity_id,
    12,
  );
});

test("scheduled public catalogs exclude sandbox identities and keep one live job per Comiket", async () => {
  const database = setup();
  await seedCredential(database, 10_000);
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES
      (2, '${"b".repeat(32)}', 'Second production owner', 1, 1, 1, 1, 20),
      (3, '${"c".repeat(32)}', 'Sandbox owner', 1, 1, 1, 1, 30);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_user_id, created_at, updated_at, last_authenticated_at
    ) VALUES
      (8, 2, 'circlems', 'production', '88', 88, 1, 1, 20),
      (9, 3, 'circlems', 'sandbox', '99', 99, 1, 1, 30);
  `);
  await storeCircleCredential(
    database.binding,
    2,
    8,
    { accessToken: "production-second", accessExpiresAt: 10_000 },
    key(),
    1,
  );
  await storeCircleCredential(
    database.binding,
    3,
    9,
    { accessToken: "sandbox-newest", accessExpiresAt: 10_000 },
    key(),
    1,
  );
  const seen: string[] = [];
  const queued = await discoverCatalogRefreshJobs(
    bindings(database),
    async (input, init) => {
      const authorization =
        new Headers(init?.headers).get("Authorization") ?? "";
      seen.push(authorization);
      assert.notEqual(authorization, "Bearer sandbox-newest");
      if (new URL(String(input)).pathname === "/WebCatalog/GetEventList") {
        return Response.json({
          status: "success",
          response: { list: [{ EventId: 190, EventNo: 108 }] },
        });
      }
      return authorization === "Bearer production-second"
        ? Response.json({
            status: "success",
            response: {
              url: {
                textdb_sqlite3_url_ssl:
                  "https://downloads.example/second-main.gz",
                imagedb1_url_ssl: "https://downloads.example/second-image.gz",
              },
              md5: {
                textdb_sqlite3_url_ssl: "c".repeat(32),
                imagedb1_url_ssl: "d".repeat(32),
              },
            },
          })
        : catalogBaseResponse();
    },
    100,
  );
  assert.equal(queued, 1);
  assert.equal(
    database.rows(
      `SELECT count(*) AS count FROM catalog_refresh_jobs
       WHERE state IN ('queued', 'leased') AND comiket_no = 108`,
    )[0]?.count,
    1,
  );
  assert.ok(seen.length >= 2);
});

test("a failed unpublished source pair can be queued again after backoff", async () => {
  const database = setup();
  await seedCredential(database, 10_000);
  const pair = `${"a".repeat(32)}:${"b".repeat(32)}`;
  database.native
    .prepare(
      `INSERT INTO catalog_refresh_jobs (
         id, user_identity_id, comiket_no, provider_circlems_event_id,
         source_md5_hint, state, attempt_count, created_at, updated_at
       ) VALUES (?1, 7, 108, 190, ?2, 'failed', 5, 1, 1)`,
    )
    .run("99999999-9999-4999-8999-999999999999", pair);
  assert.equal(
    await discoverCatalogRefreshJobs(
      bindings(database),
      async (input) =>
        new URL(String(input)).pathname === "/WebCatalog/GetEventList"
          ? Response.json({
              status: "success",
              response: { list: [{ EventId: 190, EventNo: 108 }] },
            })
          : catalogBaseResponse("retry"),
      100,
    ),
    1,
  );
  assert.deepEqual(
    database.rows(
      `SELECT state, count(*) AS count FROM catalog_refresh_jobs
       GROUP BY state ORDER BY state`,
    ),
    [
      { state: "failed", count: 1 },
      { state: "queued", count: 1 },
    ],
  );
});

async function seedCredential(
  database: SQLiteD1Database,
  expiresAt: number,
): Promise<void> {
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Owner', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_user_id, created_at, updated_at, last_authenticated_at
    ) VALUES (7, 1, 'circlems', 'production', '77', 77, 1, 1, 10);
    INSERT INTO catalog_events (comiket_no, name, created_at, updated_at)
    VALUES (108, 'Comic Market 108', 1, 1);
  `);
  await storeCircleCredential(
    database.binding,
    1,
    7,
    {
      accessToken: "private-access",
      refreshToken: "private-refresh",
      accessExpiresAt: expiresAt,
      scopes: ["catalog"],
    },
    key(),
    1,
  );
}

function bindings(database: SQLiteD1Database) {
  return {
    COMINAVI_DB: database.binding,
    COMINAVI_PROVIDER_CREDENTIAL_KEY_V1: key(),
    COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: "https://api.example",
    COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: "https://sandbox-api.example",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN: "https://auth.example",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID: "client",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET: "secret",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN: "https://sandbox-auth.example",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID: "sandbox-client",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET: "sandbox-secret",
  };
}

function catalogBaseResponse(label = ""): Response {
  const prefix = label ? `${label}-` : "";
  return Response.json({
    status: "success",
    response: {
      url: {
        textdb_sqlite3_url_ssl: `https://downloads.example/${prefix}main.sqlite.gz`,
        imagedb1_url_ssl: `https://downloads.example/${prefix}image.sqlite.gz`,
      },
      md5: {
        textdb_sqlite3_url_ssl: "a".repeat(32),
        imagedb1_url_ssl: "b".repeat(32),
      },
      updatedate: "2026-08-09T00:00:00Z",
    },
  });
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function key(): string {
  let binary = "";
  for (let index = 0; index < 32; index += 1) {
    binary += String.fromCharCode(index);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function setup(): SQLiteD1Database {
  return new SQLiteD1Database(
    [
      "migrations/0001_following_imports.sql",
      "migrations/0002_realtime_service.sql",
      "migrations/0003_accounts_shared_plans.sql",
      "migrations/0004_sanitized_catalog.sql",
      "migrations/0005_shared_plan_crdt_notifications.sql",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
}
