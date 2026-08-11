import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  claimCatalogImport,
  assertScheduledCatalogClaimAuthority,
  assertCatalogPublicationStatusAuthority,
  ingestCatalogRows,
  listPublishedCatalogs,
  loadPublishedArtifact,
  loadPublishedCatalog,
  publishCatalogVersion,
  stageCatalogVersion,
} from "../src/lib/server/catalogs";
import {
  assertCatalogMultipartUpload,
  authenticateCatalogPublisherRequest,
  beginCatalogMultipartUpload,
  bindCatalogPublisherCommand,
  loadCatalogPublisherCommandResult,
  recordCatalogMultipartUpload,
} from "../src/lib/server/catalog-publisher-auth";
import {
  circleCredentialPayloadHash,
  loadCircleCredential,
  refreshOwnedCircleCredential,
  storeCircleCredential,
  transferOwnedCircleCredential,
} from "../src/lib/server/provider-credentials";
import { SQLiteD1Database } from "./sqlite-d1";

const claimID = "11111111-1111-4111-8111-111111111111";
const versionID = `c108-v1-${"a".repeat(24)}`;

test("catalog claims are single-flight and publication atomically exposes only the derived artifact", async () => {
  const database = setup();
  await claimCatalogImport(database.binding, {
    comiketNo: 108,
    name: "Comic Market 108",
    claimID,
    sourceMD5Hint: `${"b".repeat(32)}:${"1".repeat(32)}`,
    now: 100,
  });
  await assert.rejects(
    claimCatalogImport(database.binding, {
      comiketNo: 108,
      name: "Comic Market 108",
      claimID: "22222222-2222-4222-8222-222222222222",
      sourceMD5Hint: `${"c".repeat(32)}:${"2".repeat(32)}`,
      now: 101,
    }),
    (error: unknown) => hasCode(error, "catalog_import_in_progress"),
  );
  await stageCatalogVersion(database.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    sourceUpdatedAt: 90,
    sourceMD5Hint: `${"b".repeat(32)}:${"1".repeat(32)}`,
    sourceMainSHA256: "c".repeat(64),
    sourceImageSHA256: "d".repeat(64),
    derivedSHA256: "e".repeat(64),
    derivedBytes: 1234,
    derivedObjectKey: `derived/catalogs/c108/${versionID}.sqlite`,
    privateSources: privateSourceMetadata(),
    dateCount: 1,
    mapCount: 1,
    areaCount: 1,
    blockCount: 1,
    floorCount: 1,
    mappingCount: 1,
    genreCount: 1,
    circleCount: 1,
    layoutCount: 1,
    imageCount: 2,
    now: 102,
  });
  await ingestCatalogRows(database.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    now: 102,
    data: normalizedFixture(),
  });
  assert.deepEqual(await listPublishedCatalogs(database.binding), {
    items: [],
  });
  const bucket = new HeadBucket(completeArtifacts());
  await publishCatalogVersion(database.binding, bucket.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    now: 103,
  });
  const catalog = await loadPublishedCatalog(database.binding, 108);
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/sanitized-catalog-v1.json", "utf8"),
  ) as { catalogList: unknown; catalogVersion: unknown };
  assert.deepEqual(catalog, {
    schemaVersion: 1,
    versionID,
    comiketNo: 108,
    name: "Comic Market 108",
    publishedAt: 103,
    sourceUpdatedAt: 90,
    artifact: {
      url: `/api/v2/catalogs/108/versions/${versionID}/artifact`,
      sha256: "e".repeat(64),
      bytes: 1234,
      contentType: "application/vnd.cominavi.catalog-v1+sqlite",
    },
    counts: { circles: 1, layouts: 1, images: 2 },
    capabilities: {
      stableCircleIdentity: "comiketNo+wcID",
      circleImages: true,
      commonImages: true,
    },
  });
  assert.equal("sourceMD5Hint" in catalog, false);
  assert.equal("objectKey" in catalog.artifact, false);
  assert.deepEqual(await listPublishedCatalogs(database.binding), {
    items: [catalog],
  });
  const fixtureCatalogVersion = structuredClone(
    fixture.catalogVersion,
  ) as typeof catalog;
  fixtureCatalogVersion.artifact.url = catalog.artifact.url;
  assert.deepEqual(catalog, fixtureCatalogVersion);
  const fixtureCatalogList = structuredClone(fixture.catalogList) as {
    items: Array<typeof catalog>;
  };
  assert.ok(fixtureCatalogList.items[0]);
  fixtureCatalogList.items[0].artifact.url = catalog.artifact.url;
  assert.deepEqual(
    await listPublishedCatalogs(database.binding),
    fixtureCatalogList,
  );
  assert.deepEqual(
    {
      ...(await loadPublishedArtifact(database.binding, 108, versionID)),
    },
    {
      object_key: `derived/catalogs/c108/${versionID}.sqlite`,
      sha256: "e".repeat(64),
      byte_count: 1234,
      content_type: "application/vnd.cominavi.catalog-v1+sqlite",
    },
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM catalog_import_claims")[0]
      ?.count,
    0,
  );
  assert.equal(
    await claimCatalogImport(database.binding, {
      comiketNo: 108,
      name: "Comic Market 108",
      claimID: "33333333-3333-4333-8333-333333333333",
      sourceMD5Hint: `${"b".repeat(32)}:${"1".repeat(32)}`,
      now: 104,
    }),
    false,
  );
  assert.equal(
    await claimCatalogImport(database.binding, {
      comiketNo: 108,
      name: "Comic Market 108",
      claimID: "44444444-4444-4444-8444-444444444444",
      sourceMD5Hint: `${"b".repeat(32)}:${"2".repeat(32)}`,
      now: 104,
    }),
    true,
  );
});

test("publication rejects missing or mismatched private R2 metadata without exposing the version", async () => {
  const database = setup();
  await claimAndStage(database);
  await assert.rejects(
    publishCatalogVersion(database.binding, new HeadBucket(null).binding, {
      versionID,
      comiketNo: 108,
      claimID,
      now: 103,
    }),
    (error: unknown) => hasCode(error, "catalog_artifact_invalid"),
  );
  assert.deepEqual(await listPublishedCatalogs(database.binding), {
    items: [],
  });
  assert.equal(
    database.rows("SELECT state FROM catalog_versions")[0]?.state,
    "staging",
  );
});

test("publication stores its exact response receipt in the atomic publish batch", async () => {
  const database = setup();
  await claimCatalogImport(database.binding, {
    comiketNo: 108,
    name: "Comic Market 108",
    claimID,
    now: 100,
  });
  await stageCatalogVersion(database.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    sourceMainSHA256: "c".repeat(64),
    sourceImageSHA256: "d".repeat(64),
    derivedSHA256: "e".repeat(64),
    derivedBytes: 1234,
    derivedObjectKey: `derived/catalogs/c108/${versionID}.sqlite`,
    privateSources: privateSourceMetadata(),
    dateCount: 1,
    mapCount: 1,
    areaCount: 1,
    blockCount: 1,
    floorCount: 1,
    mappingCount: 1,
    genreCount: 1,
    circleCount: 1,
    layoutCount: 1,
    imageCount: 2,
    now: 101,
  });
  await ingestCatalogRows(database.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    now: 102,
    data: normalizedFixture(),
  });
  const idempotencyKey = `${claimID}:publish`;
  const payloadSHA256 = "9".repeat(64);
  await bindCatalogPublisherCommand(
    database.binding,
    idempotencyKey,
    "catalog_publication:publish",
    payloadSHA256,
    102,
  );
  await publishCatalogVersion(
    database.binding,
    new HeadBucket(completeArtifacts()).binding,
    {
      versionID,
      comiketNo: 108,
      claimID,
      now: 103,
      commandReceipt: { idempotencyKey, payloadSHA256 },
    },
  );
  assert.deepEqual(
    await loadCatalogPublisherCommandResult(
      database.binding,
      idempotencyKey,
      "catalog_publication:publish",
      payloadSHA256,
    ),
    {
      accepted: true,
      action: "publish",
      versionID,
      comiketNo: 108,
      publishedAt: 103,
    },
  );
});

test("multipart create result replays and an expired creating receipt can recover", async () => {
  const database = setup();
  const idempotencyKey = `${claimID}:upload:create:fixture`;
  await bindCatalogPublisherCommand(
    database.binding,
    idempotencyKey,
    "catalog_artifact:create",
    "8".repeat(64),
    100,
  );
  const metadata = {
    objectKey: "derived/catalogs/c108/fixture.sqlite",
    sha256: "7".repeat(64),
    bytes: 123,
    contentType: "application/vnd.cominavi.catalog-v1+sqlite",
    visibility: "authenticated_download" as const,
    claimID,
    leaseID: "22222222-2222-4222-8222-222222222222",
    sourceMD5Hint: `${"a".repeat(32)}:${"b".repeat(32)}`,
  };
  assert.deepEqual(
    await beginCatalogMultipartUpload(
      database.binding,
      idempotencyKey,
      metadata,
      100,
    ),
    { create: true },
  );
  await assert.rejects(
    beginCatalogMultipartUpload(
      database.binding,
      idempotencyKey,
      metadata,
      101,
    ),
    (error: unknown) => hasCode(error, "catalog_multipart_create_in_progress"),
  );
  assert.deepEqual(
    await beginCatalogMultipartUpload(
      database.binding,
      idempotencyKey,
      metadata,
      160,
    ),
    { create: true },
  );
  await recordCatalogMultipartUpload(
    database.binding,
    idempotencyKey,
    metadata,
    "upload-successor",
    160,
  );
  assert.deepEqual(
    await beginCatalogMultipartUpload(
      database.binding,
      idempotencyKey,
      metadata,
      161,
    ),
    { create: false, uploadID: "upload-successor" },
  );
  await assertCatalogMultipartUpload(
    database.binding,
    metadata.objectKey,
    "upload-successor",
    metadata,
    161,
  );
  await assert.rejects(
    assertCatalogMultipartUpload(
      database.binding,
      metadata.objectKey,
      "upload-successor",
      { ...metadata, leaseID: "33333333-3333-4333-8333-333333333333" },
      161,
    ),
    (error: unknown) => hasCode(error, "catalog_multipart_upload_expired"),
  );
});

test("catalog publisher signer configuration fails closed when secrets are equal", async () => {
  await assert.rejects(
    authenticateCatalogPublisherRequest(
      new Request(
        "https://catalog.example/api/v2/internal/catalog-publications",
        {
          method: "POST",
          body: "{}",
        },
      ),
      { manual: "s".repeat(32), scheduled: "s".repeat(32) },
    ),
    (error: unknown) => hasCode(error, "catalog_publication_unavailable"),
  );
});

test("scheduled publication binds every stage to the exact live lease and source pair", async () => {
  const database = setup();
  const lease1 = "11111111-1111-4111-8111-111111111110";
  const lease2 = "22222222-2222-4222-8222-222222222220";
  const sourcePair = `${"a".repeat(32)}:${"b".repeat(32)}`;
  seedScheduledJob(database, lease1, sourcePair, 200);
  await claimCatalogImport(database.binding, {
    comiketNo: 108,
    name: "Comic Market 108",
    claimID,
    refreshLeaseID: lease1,
    sourceMD5Hint: sourcePair,
    now: 100,
    leaseSeconds: 100,
  });
  database.native
    .prepare(
      `UPDATE catalog_refresh_jobs
       SET lease_id = ?1, lease_expires_at = 400 WHERE id = ?2`,
    )
    .run(lease2, claimID);
  await claimCatalogImport(database.binding, {
    comiketNo: 108,
    name: "Comic Market 108",
    claimID,
    refreshLeaseID: lease2,
    sourceMD5Hint: sourcePair,
    now: 201,
    leaseSeconds: 100,
  });
  await assert.rejects(
    assertScheduledCatalogClaimAuthority(
      database.binding,
      claimID,
      lease1,
      sourcePair,
      202,
    ),
    (error: unknown) => hasCode(error, "catalog_publication_authority_lost"),
  );
  await assert.rejects(
    assertScheduledCatalogClaimAuthority(
      database.binding,
      claimID,
      lease2,
      `${"a".repeat(32)}:${"c".repeat(32)}`,
      202,
    ),
    (error: unknown) => hasCode(error, "catalog_publication_authority_lost"),
  );
  await assert.rejects(
    stageCatalogVersion(database.binding, {
      ...scheduledStageInput(lease1, sourcePair, 202),
    }),
    (error: unknown) => hasCode(error, "catalog_stage_conflict"),
  );
  await stageCatalogVersion(database.binding, {
    ...scheduledStageInput(lease2, sourcePair, 202),
  });
  await assert.rejects(
    ingestCatalogRows(database.binding, {
      versionID,
      comiketNo: 108,
      claimID,
      refreshLeaseID: lease1,
      sourceMD5Hint: sourcePair,
      now: 203,
      data: normalizedFixture(),
    }),
    (error: unknown) => hasCode(error, "catalog_ingest_conflict"),
  );
  await ingestCatalogRows(database.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    refreshLeaseID: lease2,
    sourceMD5Hint: sourcePair,
    now: 203,
    data: normalizedFixture(),
  });
  await assert.rejects(
    publishCatalogVersion(
      database.binding,
      new HeadBucket(completeArtifacts()).binding,
      {
        versionID,
        comiketNo: 108,
        claimID,
        refreshLeaseID: lease1,
        sourceMD5Hint: sourcePair,
        now: 204,
      },
    ),
    (error: unknown) => hasCode(error, "catalog_publication_conflict"),
  );
  assert.equal(
    database.rows("SELECT state FROM catalog_versions")[0]?.state,
    "staging",
  );
});

test("lease expiry during publish validation leaves version, event, job, and receipt unchanged", async () => {
  const database = setup();
  const leaseID = "11111111-1111-4111-8111-111111111110";
  const sourcePair = `${"a".repeat(32)}:${"b".repeat(32)}`;
  seedScheduledJob(database, leaseID, sourcePair, 150);
  await claimCatalogImport(database.binding, {
    comiketNo: 108,
    name: "Comic Market 108",
    claimID,
    refreshLeaseID: leaseID,
    sourceMD5Hint: sourcePair,
    now: 100,
    leaseSeconds: 100,
  });
  await stageCatalogVersion(database.binding, {
    ...scheduledStageInput(leaseID, sourcePair, 101),
  });
  await ingestCatalogRows(database.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    refreshLeaseID: leaseID,
    sourceMD5Hint: sourcePair,
    now: 102,
    data: normalizedFixture(),
  });
  const idempotencyKey = `${claimID}:${leaseID}:${sourcePair}:publish`;
  const payloadSHA256 = "6".repeat(64);
  await bindCatalogPublisherCommand(
    database.binding,
    idempotencyKey,
    "catalog_publication:publish",
    payloadSHA256,
    102,
  );
  let call = 0;
  await assert.rejects(
    publishCatalogVersion(
      database.binding,
      new HeadBucket(completeArtifacts()).binding,
      {
        versionID,
        comiketNo: 108,
        claimID,
        refreshLeaseID: leaseID,
        sourceMD5Hint: sourcePair,
        now: 103,
        commandReceipt: { idempotencyKey, payloadSHA256 },
      },
      () => (++call === 1 ? 140 : 151),
    ),
    (error: unknown) => hasCode(error, "catalog_publication_conflict"),
  );
  assert.deepEqual(
    database.rows(
      `SELECT version.state, event.active_version_id, job.state AS job_state,
              receipt.result_json
       FROM catalog_versions AS version
       JOIN catalog_events AS event ON event.comiket_no = version.comiket_no
       JOIN catalog_refresh_jobs AS job ON job.id = version.claim_id
       JOIN catalog_internal_command_receipts AS receipt
         ON receipt.idempotency_key = '${idempotencyKey}'`,
    ),
    [
      {
        state: "staging",
        active_version_id: null,
        job_state: "leased",
        result_json: null,
      },
    ],
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM catalog_import_claims")[0]
      ?.count,
    1,
  );
  database.native.exec(`
    UPDATE catalog_refresh_jobs SET lease_expires_at = 300
    WHERE id = '${claimID}';
    UPDATE catalog_import_claims SET lease_expires_at = 300
    WHERE claim_id = '${claimID}';
  `);
  await publishCatalogVersion(
    database.binding,
    new HeadBucket(completeArtifacts()).binding,
    {
      versionID,
      comiketNo: 108,
      claimID,
      refreshLeaseID: leaseID,
      sourceMD5Hint: sourcePair,
      now: 200,
      commandReceipt: { idempotencyKey, payloadSHA256 },
    },
    () => 200,
  );
  assert.deepEqual(
    await loadCatalogPublisherCommandResult(
      database.binding,
      idempotencyKey,
      "catalog_publication:publish",
      payloadSHA256,
    ),
    {
      accepted: true,
      action: "publish",
      versionID,
      comiketNo: 108,
      publishedAt: 200,
    },
  );
  await assertCatalogPublicationStatusAuthority(
    database.binding,
    { claimID, leaseID, sourceMD5Hint: sourcePair },
    250,
  );
  assert.deepEqual(
    database.rows(
      `SELECT state, published_lease_id, published_version_id
       FROM catalog_refresh_jobs WHERE id = '${claimID}'`,
    ),
    [
      {
        state: "published",
        published_lease_id: leaseID,
        published_version_id: versionID,
      },
    ],
  );
});

test("catalog v1 cannot stage without both retained private source artifacts", async () => {
  const database = setup();
  await claimCatalogImport(database.binding, {
    comiketNo: 108,
    name: "Comic Market 108",
    claimID,
    now: 100,
  });
  const input = { ...scheduledStageInput(null, null, 101) };
  delete (input as { privateSources?: unknown }).privateSources;
  await assert.rejects(
    stageCatalogVersion(database.binding, input),
    /Private source artifact metadata is required/,
  );
});

test("a superseded immutable artifact remains resumable after the next version publishes", async () => {
  const database = setup();
  const firstVersion = `c108-v1-${"1".repeat(24)}`;
  const secondVersion = `c108-v1-${"2".repeat(24)}`;
  database.native.exec(`
    INSERT INTO catalog_events (comiket_no, name, created_at, updated_at)
    VALUES (108, 'Comic Market 108', 1, 2);
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, derived_sha256, derived_bytes,
      date_count, map_count, area_count, block_count, floor_count,
      mapping_count, genre_count, circle_count, layout_count, image_count,
      created_at, published_at
    ) VALUES
      ('${firstVersion}', 108, 1, 'superseded', '${claimID}',
       '${"1".repeat(64)}', '${"2".repeat(64)}', '${"3".repeat(64)}', 111,
       1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1),
      ('${secondVersion}', 108, 1, 'published', '${claimID}',
       '${"4".repeat(64)}', '${"5".repeat(64)}', '${"6".repeat(64)}', 222,
       1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2);
    INSERT INTO catalog_artifacts (
      version_id, kind, visibility, object_key, sha256,
      byte_count, content_type, created_at
    ) VALUES (
      '${firstVersion}', 'derived_catalog', 'authenticated_download',
      'derived/catalogs/c108/${firstVersion}.sqlite', '${"3".repeat(64)}',
      111, 'application/vnd.cominavi.catalog-v1+sqlite', 1
    );
    UPDATE catalog_events SET active_version_id = '${secondVersion}'
    WHERE comiket_no = 108;
  `);
  assert.equal(
    (await loadPublishedArtifact(database.binding, 108, firstVersion))
      .object_key,
    `derived/catalogs/c108/${firstVersion}.sqlite`,
  );
});

test("Circle.ms credentials are encrypted and bound to their owning identity", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Owner', 1, 1, 1, 1, 1);
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (2, '${"b".repeat(32)}', 'Other', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_user_id, created_at, updated_at, last_authenticated_at
    ) VALUES (7, 1, 'circlems', 'production', '77', 77, 1, 1, 1);
  `);
  const key = encodeBase64URL(Uint8Array.from({ length: 32 }, (_, i) => i));
  await storeCircleCredential(
    database.binding,
    1,
    7,
    {
      accessToken: "private-access",
      refreshToken: "private-refresh",
      accessExpiresAt: 999,
      scopes: ["catalog", "catalog"],
    },
    key,
    10,
  );
  const persisted = database.rows(
    "SELECT nonce, ciphertext, scopes_json FROM provider_credentials",
  )[0]!;
  assert.equal(String(persisted.ciphertext).includes("private-access"), false);
  assert.equal(persisted.scopes_json, '["catalog"]');
  assert.deepEqual(await loadCircleCredential(database.binding, 1, 7, key), {
    accessToken: "private-access",
    refreshToken: "private-refresh",
    accessExpiresAt: 999,
    scopes: ["catalog"],
  });
  await assert.rejects(
    loadCircleCredential(database.binding, 2, 7, key),
    (error: unknown) => hasCode(error, "provider_credential_unavailable"),
  );
});

test("credential handoff replay cannot overwrite a backend-rotated successor", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Owner', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_user_id, created_at, updated_at, last_authenticated_at
    ) VALUES (7, 1, 'circlems', 'production', '77', 77, 1, 1, 1);
  `);
  const encryptionKey = encodeBase64URL(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  );
  const requestID = "55555555-5555-4555-8555-555555555555";
  const original = {
    accessToken: "initial-access",
    refreshToken: "initial-refresh",
    accessExpiresAt: 100,
  };
  const payloadHash = await circleCredentialPayloadHash("production", original);
  const first = await transferOwnedCircleCredential(
    database.binding,
    1,
    "production",
    "77",
    original,
    encryptionKey,
    "circlems_auth",
    requestID,
    payloadHash,
    null,
    10,
  );
  assert.equal(first.credentialRevision, 1);
  await refreshOwnedCircleCredential(
    database.binding,
    1,
    7,
    encryptionKey,
    {
      COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN: "https://auth.example",
      COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID: "client",
      COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET: "secret",
      COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN: "https://sandbox.example",
      COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID: "sandbox-client",
      COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET: "sandbox-secret",
    },
    async () =>
      Response.json({
        access_token: "successor-access",
        refresh_token: "successor-refresh",
        expires_in: 3600,
      }),
    20,
  );

  const replay = await transferOwnedCircleCredential(
    database.binding,
    1,
    "production",
    "77",
    original,
    encryptionKey,
    "circlems_auth",
    requestID,
    payloadHash,
    null,
    30,
  );
  assert.deepEqual(replay, first);
  assert.deepEqual(
    await loadCircleCredential(database.binding, 1, 7, encryptionKey),
    {
      accessToken: "successor-access",
      refreshToken: "successor-refresh",
      accessExpiresAt: 3620,
      scopes: [],
    },
  );
  const changed = { ...original, refreshToken: "different-refresh" };
  await assert.rejects(
    transferOwnedCircleCredential(
      database.binding,
      1,
      "production",
      "77",
      changed,
      encryptionKey,
      "circlems_auth",
      requestID,
      await circleCredentialPayloadHash("production", changed, null),
      null,
      31,
    ),
    (error: unknown) => hasCode(error, "idempotency_conflict"),
  );
  await assert.rejects(
    transferOwnedCircleCredential(
      database.binding,
      1,
      "production",
      "77",
      original,
      encryptionKey,
      "circlems_auth",
      "66666666-6666-4666-8666-666666666666",
      payloadHash,
      null,
      32,
    ),
    (error: unknown) => hasCode(error, "provider_credential_revision_conflict"),
  );

  const replacement = {
    accessToken: "replacement-access",
    refreshToken: "replacement-refresh",
    accessExpiresAt: 500,
  };
  const replacementReceipt = await transferOwnedCircleCredential(
    database.binding,
    1,
    "production",
    "77",
    replacement,
    encryptionKey,
    "circlems_auth",
    "77777777-7777-4777-8777-777777777777",
    await circleCredentialPayloadHash("production", replacement, 2),
    2,
    33,
  );
  assert.equal(replacementReceipt.credentialRevision, 3);
  assert.deepEqual(
    await loadCircleCredential(database.binding, 1, 7, encryptionKey),
    {
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
      accessExpiresAt: 500,
      scopes: [],
    },
  );
});

async function claimAndStage(database: SQLiteD1Database): Promise<void> {
  await claimCatalogImport(database.binding, {
    comiketNo: 108,
    name: "Comic Market 108",
    claimID,
    now: 100,
  });
  await stageCatalogVersion(database.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    sourceMainSHA256: "c".repeat(64),
    sourceImageSHA256: "d".repeat(64),
    derivedSHA256: "e".repeat(64),
    derivedBytes: 1234,
    derivedObjectKey: `derived/catalogs/c108/${versionID}.sqlite`,
    privateSources: privateSourceMetadata(),
    dateCount: 0,
    mapCount: 0,
    areaCount: 0,
    blockCount: 0,
    floorCount: 0,
    mappingCount: 0,
    genreCount: 0,
    circleCount: 0,
    layoutCount: 0,
    imageCount: 0,
    now: 102,
  });
}

function normalizedFixture() {
  return {
    dates: [{ day: 1, dateISO: "2026-08-15", weekday: 7 }],
    maps: [
      {
        mapID: 1,
        name: "East",
        width: 1000,
        height: 800,
        originX: 0,
        originY: 0,
        rotation: 0,
        artworkName: "east.png",
      },
    ],
    areas: [
      {
        areaID: 1,
        mapID: 1,
        name: "East 1",
        simpleName: "E1",
        x: 0,
        y: 0,
        width: 500,
        height: 400,
      },
    ],
    blocks: [{ blockID: 1, areaID: 1, name: "A" }],
    floors: [{ floorID: 1, day: 1, mapID: 1, name: "East day 1" }],
    mappings: [{ day: 1, blockID: 1, mapID: 1, areaID: 1, floorID: 1 }],
    genres: [{ genreID: 1, code: 100, day: null, name: "All days" }],
    layouts: [
      {
        blockID: 1,
        spaceNo: 1,
        mapID: 1,
        hallID: 1,
        x: 100,
        y: 200,
        orientation: 1,
      },
    ],
    circles: [
      {
        wcID: 9001,
        day: 1,
        blockID: 1,
        spaceNo: 1,
        spaceNoSub: 0,
        genreID: 1,
        name: "Fixture Circle",
        kana: "fixture",
        penName: "Pen",
        bookName: "Book",
        websiteURL: "https://example.com/",
        description: "Description",
        twitterURL: null,
        pixivURL: null,
        updateID: 4,
      },
    ],
    images: [
      {
        kind: "circle_cut" as const,
        assetKey: "9001",
        wcID: 9001,
        width: 211,
        height: 300,
        contentType: "image/png" as const,
        byteCount: 12,
        sha256: "f".repeat(64),
      },
      {
        kind: "common" as const,
        assetKey: "east.png",
        wcID: null,
        width: 1000,
        height: 800,
        contentType: "image/png" as const,
        byteCount: 12,
        sha256: "0".repeat(64),
      },
    ],
  };
}

function privateSourceMetadata() {
  return {
    main: { objectKey: "raw/catalogs/c108/source-main.sqlite", bytes: 100 },
    image: { objectKey: "raw/catalogs/c108/source-image.sqlite", bytes: 200 },
  };
}

function scheduledStageInput(
  leaseID: string | null,
  sourceMD5Hint: string | null,
  now: number,
) {
  return {
    versionID,
    comiketNo: 108,
    claimID,
    refreshLeaseID: leaseID,
    sourceMD5Hint,
    sourceMainSHA256: "c".repeat(64),
    sourceImageSHA256: "d".repeat(64),
    derivedSHA256: "e".repeat(64),
    derivedBytes: 1234,
    derivedObjectKey: `derived/catalogs/c108/${versionID}.sqlite`,
    privateSources: privateSourceMetadata(),
    dateCount: 1,
    mapCount: 1,
    areaCount: 1,
    blockCount: 1,
    floorCount: 1,
    mappingCount: 1,
    genreCount: 1,
    circleCount: 1,
    layoutCount: 1,
    imageCount: 2,
    now,
  };
}

function seedScheduledJob(
  database: SQLiteD1Database,
  leaseID: string,
  sourceMD5Hint: string,
  expiresAt: number,
): void {
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Owner', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_user_id, created_at, updated_at, last_authenticated_at
    ) VALUES (7, 1, 'circlems', 'production', '77', 77, 1, 1, 1);
    INSERT INTO catalog_events (
      comiket_no, name, provider_circlems_event_id, created_at, updated_at
    ) VALUES (108, 'Comic Market 108', 190, 1, 1);
    INSERT INTO catalog_refresh_jobs (
      id, user_identity_id, comiket_no, provider_circlems_event_id,
      source_md5_hint, state, lease_id, lease_expires_at,
      attempt_count, created_at, updated_at
    ) VALUES ('${claimID}', 7, 108, 190, '${sourceMD5Hint}', 'leased',
              '${leaseID}', ${expiresAt}, 1, 1, 1);
  `);
}

function completeArtifacts() {
  return [
    {
      key: `derived/catalogs/c108/${versionID}.sqlite`,
      size: 1234,
      sha256: "e".repeat(64),
      visibility: "authenticated_download",
      contentType: "application/vnd.cominavi.catalog-v1+sqlite",
    },
    {
      key: "raw/catalogs/c108/source-main.sqlite",
      size: 100,
      sha256: "c".repeat(64),
      visibility: "private_source",
      contentType: "application/vnd.sqlite3",
    },
    {
      key: "raw/catalogs/c108/source-image.sqlite",
      size: 200,
      sha256: "d".repeat(64),
      visibility: "private_source",
      contentType: "application/vnd.sqlite3",
    },
  ];
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

class HeadBucket {
  readonly binding: R2Bucket;

  constructor(
    values: Array<{
      key: string;
      size: number;
      sha256: string;
      visibility: string;
      contentType: string;
    }> | null,
  ) {
    this.binding = {
      head: async (key: string) => {
        const value = values?.find((candidate) => candidate.key === key);
        if (!value) return null;
        return {
          key,
          size: value.size,
          etag: "fixture",
          httpEtag: '"fixture"',
          uploaded: new Date(0),
          version: "fixture",
          checksums: {},
          customMetadata: {
            sha256: value.sha256,
            visibility: value.visibility,
          },
          httpMetadata: {
            contentType: value.contentType,
          },
        };
      },
    } as unknown as R2Bucket;
  }
}

function encodeBase64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
