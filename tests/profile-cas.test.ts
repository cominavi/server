import assert from "node:assert/strict";
import test from "node:test";

import {
  importProviderAvatar,
  loadAvatar,
  replaceAvatar,
} from "../src/lib/server/avatars";
import type { CominaviIdentity } from "../src/lib/server/cominavi-auth";
import {
  loadUserProfile,
  parseProfileUpdate,
  upsertExternalIdentity,
  updateUserProfile,
} from "../src/lib/server/users";
import { processPendingAvatarCleanup } from "../src/lib/server/avatar-cleanup";
import { SQLiteD1Database } from "./sqlite-d1";

const identity: CominaviIdentity = {
  subject: "00000000000000000000000000000001",
  userID: 1,
  authVersion: 1,
};

test("profile names use Unicode scalar limits", async () => {
  const accepted = parseProfileUpdate({
    requestId: "12345678-1234-4123-8123-123456789abc",
    baseRevision: 1,
    displayName: "😀".repeat(80),
  });
  assert.equal(Array.from(accepted.displayName).length, 80);
  assert.throws(() =>
    parseProfileUpdate({
      requestId: "12345678-1234-4123-8123-123456789abc",
      baseRevision: 1,
      displayName: "😀".repeat(81),
    }),
  );
  const database = setup();
  await upsertExternalIdentity(database.binding, {
    provider: "google",
    environment: "",
    subject: "emoji-provider",
    displayName: "😀".repeat(81),
  });
  const seeded = String(
    database.rows(
      "SELECT display_name FROM users WHERE id <> 1 ORDER BY id DESC LIMIT 1",
    )[0]?.display_name,
  );
  assert.equal(Array.from(seeded).length, 80);
  assert.equal(seeded.endsWith("😀"), true);
});

test("two profile writes at one base revision leave no false receipt for the loser", async () => {
  const database = setup();
  const writes = await Promise.allSettled([
    updateUserProfile(database.binding, identity, {
      requestID: "profile-request-one",
      baseRevision: 1,
      displayName: "First",
    }),
    updateUserProfile(database.binding, identity, {
      requestID: "profile-request-two",
      baseRevision: 1,
      displayName: "Second",
    }),
  ]);
  assert.equal(
    writes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = writes.find((result) => result.status === "rejected");
  assert.ok(rejected);
  if (rejected.status === "rejected") {
    assertCurrentUserConflict(rejected.reason, 2);
  }
  const losingRequest =
    writes[0]?.status === "rejected"
      ? "profile-request-one"
      : "profile-request-two";
  assert.equal(
    (
      database.native
        .prepare(
          "SELECT count(*) AS count FROM shared_plan_requests WHERE request_id = ?",
        )
        .get(losingRequest) as { count: number }
    ).count,
    0,
  );
  await assert.rejects(
    () =>
      updateUserProfile(database.binding, identity, {
        requestID: losingRequest,
        baseRevision: 1,
        displayName: losingRequest.endsWith("one") ? "First" : "Second",
      }),
    (error: unknown) => hasCode(error, "profile_revision_conflict"),
  );
});

test("logout or deletion fencing between profile pre-read and batch prevents the write", async () => {
  const database = setup();
  database.beforeNextBatch = () => {
    database.native.exec(
      `UPDATE users SET auth_version = 2, deletion_pending_at = 100
       WHERE id = 1`,
    );
  };
  await assert.rejects(
    () =>
      updateUserProfile(database.binding, identity, {
        requestID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0",
        baseRevision: 1,
        displayName: "Must not commit",
      }),
    (error: unknown) => hasCode(error, "profile_revision_conflict"),
  );
  assert.deepEqual(
    database.rows(
      `SELECT display_name, profile_revision FROM users WHERE id = 1`,
    ),
    [{ display_name: "Original", profile_revision: 1 }],
  );
  assert.deepEqual(
    database.rows("SELECT request_id FROM shared_plan_requests"),
    [],
  );
});

test("logout or deletion fencing after avatar upload prevents pointer and receipt commit", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  database.beforeNextBatch = () => {
    database.native.exec(
      `UPDATE users SET auth_version = 2, deletion_pending_at = 100
       WHERE id = 1`,
    );
  };
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  await assert.rejects(() =>
    replaceAvatar(
      database.binding,
      bucket.binding,
      identity,
      new Request("https://cominavi.net/api/v2/me/avatar", {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "If-Match": '"profile:1"',
          "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
        },
        body: bytes,
      }),
    ),
  );
  assert.deepEqual(
    database.rows(
      `SELECT avatar_object_key, profile_revision FROM users WHERE id = 1`,
    ),
    [{ avatar_object_key: null, profile_revision: 1 }],
  );
  assert.deepEqual(
    database.rows("SELECT request_id FROM shared_plan_requests"),
    [],
  );
  assert.equal(bucket.objects.size, 0);
});

test("stale identical avatar uploads cannot delete the authoritative object", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  const upload = (requestID: string) =>
    replaceAvatar(
      database.binding,
      bucket.binding,
      identity,
      new Request("https://cominavi.net/api/v2/me/avatar", {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(bytes.byteLength),
          "If-Match": '"profile:1"',
          "Idempotency-Key": requestID,
        },
        body: bytes,
      }),
    );
  const writes = await Promise.allSettled([
    upload("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"),
    upload("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"),
  ]);
  assert.equal(
    writes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(bucket.objects.size, 1);
  const pointer = database.native
    .prepare("SELECT avatar_object_key FROM users WHERE id = 1")
    .get() as { avatar_object_key: string };
  assert.ok(pointer.avatar_object_key);
  assert.ok(bucket.objects.has(pointer.avatar_object_key));
});

test("provider avatars stay behind the controlled authenticated endpoint", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  database.native
    .prepare("UPDATE users SET avatar_provider_url = ? WHERE id = 1")
    .run("https://lh3.googleusercontent.com/fixture");
  const profile = await loadUserProfile(database.binding, 1);
  assert.equal(profile.avatarURL, null);
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  assert.equal(
    await importProviderAvatar(
      database.binding,
      bucket.binding,
      identity,
      "https://lh3.googleusercontent.com/fixture",
      async () =>
        new Response(bytes, {
          headers: { "Content-Length": String(bytes.byteLength) },
        }),
    ),
    true,
  );
  const imported = await loadUserProfile(database.binding, 1);
  assert.equal(imported.avatarURL, `/api/v2/users/${identity.subject}/avatar`);
  const response = await loadAvatar(
    database.binding,
    bucket.binding,
    identity,
    1,
  );
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("replaced avatar objects enter the durable cleanup outbox", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const upload = (revision: number, requestID: string, trailer: number) => {
    const bytes = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      trailer,
    ]);
    return replaceAvatar(
      database.binding,
      bucket.binding,
      identity,
      new Request("https://cominavi.net/api/v2/me/avatar", {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "If-Match": `"profile:${revision}"`,
          "Idempotency-Key": requestID,
        },
        body: bytes,
      }),
    );
  };
  await upload(1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", 1);
  const originalKey = (
    database.native
      .prepare("SELECT avatar_object_key FROM users WHERE id = 1")
      .get() as { avatar_object_key: string }
  ).avatar_object_key;
  await upload(2, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", 2);
  assert.deepEqual(
    database.rows("SELECT object_key FROM avatar_object_cleanup"),
    [{ object_key: originalKey }],
  );
  assert.ok(bucket.objects.has(originalKey));
  assert.equal(
    await processPendingAvatarCleanup(database.binding, bucket.binding),
    1,
  );
  assert.equal(bucket.objects.has(originalKey), false);
  assert.deepEqual(database.rows("SELECT * FROM avatar_object_cleanup"), []);
});

test("profile mutation IDs must already be lowercase canonical UUIDs", () => {
  assert.equal(
    parseProfileUpdate({
      requestId: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      baseRevision: 1,
      displayName: "Updated",
    }).requestID,
    "abcdefab-cdef-4abc-8def-abcdefabcdef",
  );
  assert.throws(
    () =>
      parseProfileUpdate({
        requestId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
        baseRevision: 1,
        displayName: "Updated",
      }),
    (error: unknown) => hasCode(error, "invalid_request_id"),
  );
});

test("avatar Idempotency-Key rejects uppercase UUIDs before upload", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  await assert.rejects(
    () =>
      replaceAvatar(
        database.binding,
        bucket.binding,
        identity,
        new Request("https://cominavi.net/api/v2/me/avatar", {
          method: "PUT",
          headers: {
            "Content-Type": "image/png",
            "If-Match": '"profile:1"',
            "Idempotency-Key": "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
          },
          body: bytes,
        }),
      ),
    (error: unknown) => hasCode(error, "invalid_request_id"),
  );
  assert.equal(bucket.objects.size, 0);
});

test("failed stale-upload cleanup is durable without masking the CAS error", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  bucket.failDeletes = true;
  database.native
    .prepare("UPDATE users SET profile_revision = 2 WHERE id = 1")
    .run();
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  await assert.rejects(
    () =>
      replaceAvatar(
        database.binding,
        bucket.binding,
        identity,
        new Request("https://cominavi.net/api/v2/me/avatar", {
          method: "PUT",
          headers: {
            "Content-Type": "image/png",
            "If-Match": '"profile:1"',
            "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7",
          },
          body: bytes,
        }),
      ),
    (error: unknown) => hasCode(error, "profile_revision_conflict"),
  );
  const orphanKey = [...bucket.objects.keys()][0];
  assert.ok(orphanKey);
  assert.deepEqual(
    database.rows("SELECT object_key FROM avatar_object_cleanup"),
    [{ object_key: orphanKey }],
  );
});

test("provider-import CAS loss durably records failed orphan deletion", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  bucket.failDeletes = true;
  bucket.afterPut = () => {
    database.native
      .prepare("UPDATE users SET avatar_edited = 1 WHERE id = 1")
      .run();
  };
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  assert.equal(
    await importProviderAvatar(
      database.binding,
      bucket.binding,
      identity,
      "https://lh3.googleusercontent.com/fixture",
      async () => new Response(bytes),
    ),
    false,
  );
  const orphanKey = [...bucket.objects.keys()][0];
  assert.ok(orphanKey);
  assert.deepEqual(
    database.rows("SELECT object_key FROM avatar_object_cleanup"),
    [{ object_key: orphanKey }],
  );
});

test("a user-avatar isolate exit after R2 PUT leaves a durable prewrite cleanup intent", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const startedAt = Date.now();
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  await assert.rejects(
    replaceAvatar(
      database.binding,
      bucket.binding,
      identity,
      new Request("https://cominavi.net/api/v2/me/avatar", {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "If-Match": '"profile:1"',
          "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10",
        },
        body: bytes,
      }),
      {
        afterObjectStored: async () => {
          throw new Error("simulated_isolate_exit");
        },
      },
    ),
    /simulated_isolate_exit/,
  );
  const objectKey = [...bucket.objects.keys()][0]!;
  assert.ok(objectKey);
  assert.deepEqual(
    database.rows(
      "SELECT object_key, state, last_error FROM avatar_object_cleanup",
    ),
    [
      {
        object_key: objectKey,
        state: "queued",
        last_error: "prewrite_cleanup",
      },
    ],
  );
  assert.equal(
    database.rows("SELECT avatar_object_key FROM users WHERE id = 1")[0]
      ?.avatar_object_key,
    null,
  );
  database.native.exec("DELETE FROM users WHERE id = 1");
  assert.equal(
    await processPendingAvatarCleanup(
      database.binding,
      bucket.binding,
      startedAt + 700_000,
    ),
    1,
  );
  assert.equal(bucket.objects.has(objectKey), false);
});

test("a provider-avatar isolate exit after R2 PUT survives account erasure and is garbage-collected", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const startedAt = Date.now();
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  await assert.rejects(
    importProviderAvatar(
      database.binding,
      bucket.binding,
      identity,
      "https://lh3.googleusercontent.com/fixture",
      async () => new Response(bytes),
      undefined,
      {
        afterObjectStored: async () => {
          throw new Error("simulated_provider_import_exit");
        },
      },
    ),
    /simulated_provider_import_exit/,
  );
  const objectKey = [...bucket.objects.keys()][0]!;
  assert.ok(objectKey);
  assert.deepEqual(
    database.rows("SELECT object_key, state FROM avatar_object_cleanup"),
    [{ object_key: objectKey, state: "queued" }],
  );
  database.native.exec("DELETE FROM users WHERE id = 1");
  assert.equal(
    await processPendingAvatarCleanup(
      database.binding,
      bucket.binding,
      startedAt + 700_000,
    ),
    1,
  );
  assert.equal(bucket.objects.has(objectKey), false);
});

test("avatar cleanup leased before pointer publication makes publication fail closed", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const startedAt = Date.now();
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  let cleanupCount = -1;
  await assert.rejects(
    replaceAvatar(
      database.binding,
      bucket.binding,
      identity,
      new Request("https://cominavi.net/api/v2/me/avatar", {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "If-Match": '"profile:1"',
          "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11",
        },
        body: bytes,
      }),
      {
        afterObjectStored: async () => {
          cleanupCount = await processPendingAvatarCleanup(
            database.binding,
            bucket.binding,
            startedAt + 700_000,
          );
        },
      },
    ),
    (error: unknown) => hasCode(error, "profile_revision_conflict"),
  );
  assert.equal(cleanupCount, 1);
  assert.equal(bucket.objects.size, 0);
  assert.deepEqual(
    database.rows(
      "SELECT avatar_object_key, profile_revision FROM users WHERE id = 1",
    ),
    [{ avatar_object_key: null, profile_revision: 1 }],
  );
  assert.deepEqual(database.rows("SELECT * FROM avatar_object_cleanup"), []);
});

test("postcommit profile hydration failure cannot delete the authoritative avatar", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  database.beforeNextBatch = () => {
    database.beforeNextFirst = (query) => {
      assert.ok(query.includes("SELECT id, public_id, display_name"));
      throw new Error("transient_profile_hydration_failure");
    };
  };
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  const profile = await replaceAvatar(
    database.binding,
    bucket.binding,
    identity,
    new Request("https://cominavi.net/api/v2/me/avatar", {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        "If-Match": '"profile:1"',
        "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
      },
      body: bytes,
    }),
  );
  const committed = database.rows(
    `SELECT avatar_object_key, profile_revision, last_mutation_request_id
     FROM users WHERE id = 1`,
  )[0]!;
  const objectKey = committed.avatar_object_key as string;
  assert.equal(profile.revision, 2);
  assert.deepEqual(committed, {
    avatar_object_key: objectKey,
    profile_revision: 2,
    last_mutation_request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
  });
  assert.ok(bucket.objects.has(objectKey));
  assert.equal(
    database.rows(
      `SELECT count(*) AS count FROM shared_plan_requests
       WHERE request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12'`,
    )[0]?.count,
    1,
  );
  assert.deepEqual(database.rows("SELECT * FROM avatar_object_cleanup"), []);
});

test("provider avatar reconciles a committed D1 batch whose response is lost", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const committedThenLost = {
    prepare: database.binding.prepare.bind(database.binding),
    batch: async (statements: D1PreparedStatement[]) => {
      await database.binding.batch(statements);
      throw new Error("simulated_d1_response_loss");
    },
  } as unknown as D1Database;
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  assert.equal(
    await importProviderAvatar(
      committedThenLost,
      bucket.binding,
      identity,
      "https://lh3.googleusercontent.com/fixture",
      async () => new Response(bytes),
    ),
    true,
  );
  const pointer = database.rows(
    "SELECT avatar_object_key, profile_revision FROM users WHERE id = 1",
  )[0]!;
  const objectKey = pointer.avatar_object_key as string;
  assert.deepEqual(pointer, {
    avatar_object_key: objectKey,
    profile_revision: 2,
  });
  assert.ok(bucket.objects.has(objectKey));
  assert.deepEqual(database.rows("SELECT * FROM avatar_object_cleanup"), []);
});

test("provider display refresh advances revision until the user explicitly edits", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_display_name, created_at, updated_at, last_authenticated_at
    ) VALUES (1, 1, 'google', '', 'google-subject', 'Original', 0, 0, 0);
  `);
  await upsertExternalIdentity(database.binding, {
    provider: "google",
    environment: "",
    subject: "google-subject",
    displayName: "Alicia",
  });
  const refreshed = await loadUserProfile(database.binding, 1);
  assert.equal(refreshed.displayName, "Alicia");
  assert.equal(refreshed.revision, 2);
  await assert.rejects(
    () =>
      updateUserProfile(database.binding, identity, {
        requestID: "provider-name-stale",
        baseRevision: 1,
        displayName: "Stale",
      }),
    (error: unknown) => {
      assertCurrentUserConflict(error, 2, "Alicia");
      return true;
    },
  );
  database.native
    .prepare("UPDATE users SET display_name_edited = 1 WHERE id = 1")
    .run();
  await upsertExternalIdentity(database.binding, {
    provider: "google",
    environment: "",
    subject: "google-subject",
    displayName: "Provider overwrite",
  });
  const explicit = await loadUserProfile(database.binding, 1);
  assert.equal(explicit.displayName, "Alicia");
  assert.equal(explicit.revision, 2);
});

test("provider avatar refresh replaces only provider-owned controlled objects", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const providerBytes = (trailer: number) =>
    Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      trailer,
    ]);
  const fetchAvatar = (trailer: number) => async () =>
    new Response(providerBytes(trailer));
  assert.equal(
    await importProviderAvatar(
      database.binding,
      bucket.binding,
      identity,
      "https://lh3.googleusercontent.com/one",
      fetchAvatar(1),
    ),
    true,
  );
  const first = database.native
    .prepare(
      "SELECT avatar_object_key, profile_revision FROM users WHERE id = 1",
    )
    .get() as { avatar_object_key: string; profile_revision: number };
  assert.equal(first.profile_revision, 2);
  assert.equal(
    await importProviderAvatar(
      database.binding,
      bucket.binding,
      identity,
      "https://lh3.googleusercontent.com/two",
      fetchAvatar(2),
    ),
    true,
  );
  const second = database.native
    .prepare(
      "SELECT avatar_object_key, profile_revision FROM users WHERE id = 1",
    )
    .get() as { avatar_object_key: string; profile_revision: number };
  assert.notEqual(second.avatar_object_key, first.avatar_object_key);
  assert.equal(second.profile_revision, 3);
  assert.deepEqual(
    database.rows("SELECT object_key FROM avatar_object_cleanup"),
    [{ object_key: first.avatar_object_key }],
  );

  await replaceAvatar(
    database.binding,
    bucket.binding,
    identity,
    new Request("https://cominavi.net/api/v2/me/avatar", {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        "If-Match": '"profile:3"',
        "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8",
      },
      body: providerBytes(3),
    }),
  );
  const explicit = database.native
    .prepare(
      "SELECT avatar_object_key, avatar_edited, profile_revision FROM users WHERE id = 1",
    )
    .get() as {
    avatar_object_key: string;
    avatar_edited: number;
    profile_revision: number;
  };
  assert.equal(explicit.avatar_edited, 1);
  assert.equal(explicit.profile_revision, 4);
  assert.equal(
    await importProviderAvatar(
      database.binding,
      bucket.binding,
      identity,
      "https://lh3.googleusercontent.com/three",
      fetchAvatar(4),
    ),
    false,
  );
  const afterProvider = database.native
    .prepare(
      "SELECT avatar_object_key, profile_revision FROM users WHERE id = 1",
    )
    .get() as { avatar_object_key: string; profile_revision: number };
  assert.equal(afterProvider.avatar_object_key, explicit.avatar_object_key);
  assert.equal(afterProvider.profile_revision, 4);
});

function setup(): SQLiteD1Database {
  return new SQLiteD1Database(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      public_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_provider_url TEXT,
      avatar_object_key TEXT,
      avatar_content_type TEXT,
      display_name_edited INTEGER NOT NULL DEFAULT 0,
      avatar_edited INTEGER NOT NULL DEFAULT 0,
      avatar_removed INTEGER NOT NULL DEFAULT 0,
      profile_revision INTEGER NOT NULL,
      auth_version INTEGER NOT NULL,
      deletion_pending_at INTEGER,
      last_mutation_scope TEXT,
      last_mutation_request_id TEXT,
      last_mutation_payload_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_authenticated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_identities (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_environment TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      provider_user_id INTEGER,
      provider_email TEXT,
      provider_display_name TEXT,
      provider_avatar_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_authenticated_at INTEGER NOT NULL,
      UNIQUE (provider, provider_environment, provider_subject)
    );
    CREATE TABLE shared_plan_requests (
      user_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      request_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      result_revision INTEGER,
      result_status TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, scope, request_id)
    );
    CREATE TABLE shared_plan_members (
      plan_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE avatar_object_cleanup (
      id TEXT PRIMARY KEY,
      object_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL,
      lease_id TEXT,
      lease_expires_at INTEGER,
      available_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at
    ) VALUES (1, '${identity.subject}', 'Original', 1, 1, 0, 0);
  `);
}

class RecordingBucket {
  readonly objects = new Map<string, Uint8Array>();
  failDeletes = false;
  afterPut: (() => void) | undefined;
  readonly binding = {
    put: async (key: string, value: Uint8Array) => {
      this.objects.set(key, Uint8Array.from(value));
      this.afterPut?.();
      return {};
    },
    delete: async (key: string) => {
      if (this.failDeletes) throw new Error("fixture delete failure");
      this.objects.delete(key);
    },
    get: async (key: string) => {
      const bytes = this.objects.get(key);
      if (!bytes) return null;
      return {
        body: new Response(Uint8Array.from(bytes).buffer).body,
        size: bytes.byteLength,
        httpEtag: '"fixture"',
      };
    },
  } as unknown as R2Bucket;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function assertCurrentUserConflict(
  error: unknown,
  revision: number,
  displayName?: string,
): void {
  assert.ok(hasCode(error, "profile_revision_conflict"));
  if (typeof error !== "object" || error === null || !("details" in error)) {
    assert.fail("Profile conflict must include typed details.");
  }
  const details = (error as { details: Record<string, unknown> }).details;
  assert.equal(details.currentRevision, revision);
  const currentUser = details.currentUser as Record<string, unknown>;
  assert.equal(currentUser.revision, revision);
  assert.equal(currentUser.id, identity.subject);
  if (displayName) assert.equal(currentUser.displayName, displayName);
  assert.equal(
    currentUser.avatarURL === null ||
      currentUser.avatarURL === `/api/v2/users/${identity.subject}/avatar`,
    true,
  );
}
