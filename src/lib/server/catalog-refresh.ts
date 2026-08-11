import {
  loadCircleCredential,
  refreshOwnedCircleCredential,
  type CircleCredential,
  type CircleCredentialRefreshBindings,
} from "./provider-credentials";
import { ServiceError } from "./service-error";

interface RefreshCandidate {
  user_id: number;
  identity_id: number;
  provider_environment: "production" | "sandbox";
  comiket_no: number;
  provider_circlems_event_id: number | null;
  source_md5_hint: string | null;
}

export interface CatalogRefreshBindings extends CircleCredentialRefreshBindings {
  COMINAVI_DB: D1Database;
  COMINAVI_PROVIDER_CREDENTIAL_KEY_V1: string;
  COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: string;
  COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: string;
}

export async function discoverCatalogRefreshJobs(
  bindings: CatalogRefreshBindings,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1_000),
): Promise<number> {
  const db = createDatabase(bindings.COMINAVI_DB);
  const candidates = await db
    .select({
      user_id: userIdentities.userID,
      identity_id: userIdentities.id,
      provider_environment: sql<"production">`${userIdentities.providerEnvironment}`,
      comiket_no: catalogEvents.comiketNo,
      provider_circlems_event_id: catalogEvents.providerCirclemsEventID,
      source_md5_hint: catalogVersions.sourceMD5Hint,
    })
    .from(userIdentities)
    .innerJoin(
      providerCredentials,
      eq(providerCredentials.userIdentityID, userIdentities.id),
    )
    .crossJoin(catalogEvents)
    .leftJoin(
      catalogVersions,
      eq(catalogVersions.id, catalogEvents.activeVersionID),
    )
    .leftJoin(
      catalogRefreshFailures,
      and(
        eq(catalogRefreshFailures.userIdentityID, userIdentities.id),
        eq(catalogRefreshFailures.comiketNo, catalogEvents.comiketNo),
      ),
    )
    .where(
      and(
        eq(userIdentities.provider, "circlems"),
        eq(userIdentities.providerEnvironment, "production"),
        notExists(
          db
            .select({ one: sql<number>`1` })
            .from(catalogRefreshJobs)
            .where(
              and(
                eq(catalogRefreshJobs.comiketNo, catalogEvents.comiketNo),
                inArray(catalogRefreshJobs.state, ["queued", "leased"]),
              ),
            ),
        ),
        or(
          isNull(catalogRefreshFailures.nextAttemptAt),
          lte(catalogRefreshFailures.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${catalogRefreshFailures.userIdentityID} IS NULL THEN 0 ELSE 1 END`,
      asc(catalogRefreshFailures.nextAttemptAt),
      desc(userIdentities.lastAuthenticatedAt),
      desc(catalogEvents.comiketNo),
    )
    .limit(5);
  let queued = 0;
  for (const candidate of candidates) {
    try {
      let credential = await loadCircleCredential(
        bindings.COMINAVI_DB,
        candidate.user_id,
        candidate.identity_id,
        bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      );
      if (
        credential.accessExpiresAt !== null &&
        credential.accessExpiresAt <= now + 60
      ) {
        credential = await refreshOwnedCircleCredential(
          bindings.COMINAVI_DB,
          candidate.user_id,
          candidate.identity_id,
          bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
          bindings,
          fetcher,
          now,
        );
      }
      const providerEventID =
        candidate.provider_circlems_event_id ??
        (await resolveProviderEventID(
          candidate,
          credential,
          bindings,
          fetcher,
        ));
      const source = await loadCatalogSource(
        candidate,
        providerEventID,
        credential,
        bindings,
        fetcher,
      );
      if (source.md5Hint === candidate.source_md5_hint) {
        await clearRefreshFailure(bindings.COMINAVI_DB, candidate);
        continue;
      }
      const result = await db
        .insert(catalogRefreshJobs)
        .values({
          id: crypto.randomUUID(),
          userIdentityID: candidate.identity_id,
          comiketNo: candidate.comiket_no,
          providerCirclemsEventID: providerEventID,
          sourceMD5Hint: source.md5Hint,
          sourceUpdatedAt: source.updatedAt,
          state: "queued",
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      if ((result.meta.changes ?? 0) === 1) queued += 1;
      await clearRefreshFailure(bindings.COMINAVI_DB, candidate);
    } catch {
      // A provider outage or revoked owner credential must not block other
      // identities, and no token or provider URL is logged here.
      await db
        .insert(catalogRefreshFailures)
        .values({
          userIdentityID: candidate.identity_id,
          comiketNo: candidate.comiket_no,
          attemptCount: 1,
          nextAttemptAt: now + 60,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            catalogRefreshFailures.userIdentityID,
            catalogRefreshFailures.comiketNo,
          ],
          set: {
            attemptCount: sql`${catalogRefreshFailures.attemptCount} + 1`,
            nextAttemptAt: sql`${now} + min(
              3600, 60 * (1 << min(${catalogRefreshFailures.attemptCount}, 5))
            )`,
            updatedAt: now,
          },
        })
        .run();
    }
  }
  return queued;
}

async function clearRefreshFailure(
  database: D1Database,
  candidate: Pick<RefreshCandidate, "identity_id" | "comiket_no">,
): Promise<void> {
  await createDatabase(database)
    .delete(catalogRefreshFailures)
    .where(
      and(
        eq(catalogRefreshFailures.userIdentityID, candidate.identity_id),
        eq(catalogRefreshFailures.comiketNo, candidate.comiket_no),
      ),
    )
    .run();
}

export interface LeasedCatalogRefreshJob {
  id: string;
  comiketNo: number;
  sourceMD5Hint: string;
  sourceMainURL: string;
  sourceImageURL: string;
  sourceUpdatedAt: number | null;
}

export async function leaseCatalogRefreshJob(
  bindings: CatalogRefreshBindings,
  leaseID: string,
  idempotencyKey: string,
  payloadHash: string,
  fetcher: typeof fetch,
  now: number,
  clock: () => number = () => now,
): Promise<LeasedCatalogRefreshJob | null> {
  const database = bindings.COMINAVI_DB;
  const db = createDatabase(database);
  const prior = await loadRefreshCommandReceipt(
    database,
    idempotencyKey,
    "lease",
    payloadHash,
  );
  if (prior) {
    if (!prior.jobID) return null;
    return mintLeasedCatalogSource(
      bindings,
      prior.jobID,
      leaseID,
      fetcher,
      now,
      clock,
    );
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await db
      .select({ id: catalogRefreshJobs.id })
      .from(catalogRefreshJobs)
      .where(
        or(
          eq(catalogRefreshJobs.state, "queued"),
          and(
            eq(catalogRefreshJobs.state, "leased"),
            lte(catalogRefreshJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(catalogRefreshJobs.createdAt), asc(catalogRefreshJobs.id))
      .limit(1)
      .get();
    if (!candidate) {
      await db
        .insert(catalogRefreshCommandReceipts)
        .values({
          idempotencyKey,
          action: "lease",
          payloadHash,
          jobID: null,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: catalogRefreshCommandReceipts.idempotencyKey,
        })
        .run();
    } else {
      await db.batch([
        db
          .update(catalogRefreshJobs)
          .set({
            state: "leased",
            leaseID,
            leaseExpiresAt: now + 7_200,
            attemptCount: sql`${catalogRefreshJobs.attemptCount} + 1`,
            updatedAt: now,
            lastCommandKey: idempotencyKey,
            lastCommandPayloadHash: payloadHash,
          })
          .where(
            and(
              eq(catalogRefreshJobs.id, candidate.id),
              or(
                eq(catalogRefreshJobs.state, "queued"),
                and(
                  eq(catalogRefreshJobs.state, "leased"),
                  lte(catalogRefreshJobs.leaseExpiresAt, now),
                ),
              ),
            ),
          ),
        db
          .insert(catalogRefreshCommandReceipts)
          .select(
            sql`SELECT ${idempotencyKey}, 'lease', ${payloadHash},
                             ${catalogRefreshJobs.id}, NULL, ${now}
                      FROM ${catalogRefreshJobs}
                      WHERE ${catalogRefreshJobs.id} = ${candidate.id}
                        AND ${catalogRefreshJobs.leaseID} = ${leaseID}
                        AND ${catalogRefreshJobs.lastCommandKey} = ${idempotencyKey}
                        AND ${catalogRefreshJobs.lastCommandPayloadHash} = ${payloadHash}`,
          )
          .onConflictDoNothing({
            target: catalogRefreshCommandReceipts.idempotencyKey,
          }),
      ]);
    }
    const stored = await loadRefreshCommandReceipt(
      database,
      idempotencyKey,
      "lease",
      payloadHash,
    );
    if (stored) {
      return stored.jobID
        ? mintLeasedCatalogSource(
            bindings,
            stored.jobID,
            leaseID,
            fetcher,
            now,
            clock,
          )
        : null;
    }
  }
  throw refreshAuthorityLost();
}

export async function renewCatalogRefreshJob(
  database: D1Database,
  jobID: string,
  leaseID: string,
  sourceMD5Hint: string,
  idempotencyKey: string,
  payloadHash: string,
  now: number,
): Promise<number> {
  const db = createDatabase(database);
  const prior = await loadRefreshCommandReceipt(
    database,
    idempotencyKey,
    "renew",
    payloadHash,
  );
  if (prior) {
    const current = await db
      .select({ current: sql<number>`1` })
      .from(catalogRefreshJobs)
      .where(activeLeasePredicate(jobID, leaseID, sourceMD5Hint, now))
      .get();
    if (!current) throw refreshAuthorityLost();
    const result = parseRenewalResult(prior.resultJSON);
    if (!result) throw refreshAuthorityLost();
    return result.leaseExpiresAt;
  }
  const expiresAt = now + 7_200;
  await db.batch([
    db
      .update(catalogRefreshJobs)
      .set({ leaseExpiresAt: expiresAt, updatedAt: now })
      .where(activeLeasePredicate(jobID, leaseID, sourceMD5Hint, now)),
    db
      .update(catalogImportClaims)
      .set({ leaseExpiresAt: expiresAt, updatedAt: now })
      .where(sql`${catalogImportClaims.refreshJobID} = ${jobID}
        AND ${catalogImportClaims.refreshLeaseID} = ${leaseID}
        AND ${catalogImportClaims.sourceMD5Hint} = ${sourceMD5Hint}
        AND EXISTS (
          SELECT 1 FROM ${catalogRefreshJobs}
          WHERE ${catalogRefreshJobs.id} = ${jobID}
            AND ${catalogRefreshJobs.leaseID} = ${leaseID}
            AND ${catalogRefreshJobs.sourceMD5Hint} = ${sourceMD5Hint}
            AND ${catalogRefreshJobs.state} = 'leased'
            AND ${catalogRefreshJobs.leaseExpiresAt} = ${expiresAt}
        )`),
    db
      .insert(catalogRefreshCommandReceipts)
      .select(
        sql`SELECT ${idempotencyKey}, 'renew', ${payloadHash},
                         ${catalogRefreshJobs.id},
                         ${JSON.stringify({ leaseExpiresAt: expiresAt })}, ${now}
                  FROM ${catalogRefreshJobs}
                  WHERE ${catalogRefreshJobs.id} = ${jobID}
                    AND ${catalogRefreshJobs.leaseID} = ${leaseID}
                    AND ${catalogRefreshJobs.sourceMD5Hint} = ${sourceMD5Hint}
                    AND ${catalogRefreshJobs.state} = 'leased'
                    AND ${catalogRefreshJobs.leaseExpiresAt} = ${expiresAt}`,
      )
      .onConflictDoNothing({
        target: catalogRefreshCommandReceipts.idempotencyKey,
      }),
  ]);
  if (
    !(await loadRefreshCommandReceipt(
      database,
      idempotencyKey,
      "renew",
      payloadHash,
    ))
  ) {
    throw refreshAuthorityLost();
  }
  return expiresAt;
}

async function mintLeasedCatalogSource(
  bindings: CatalogRefreshBindings,
  jobID: string,
  leaseID: string,
  fetcher: typeof fetch,
  now: number,
  clock: () => number,
): Promise<LeasedCatalogRefreshJob> {
  const db = createDatabase(bindings.COMINAVI_DB);
  const row = await db
    .select({
      id: sql<string>`${catalogRefreshJobs.id}`.as("job_id"),
      comiket_no: catalogRefreshJobs.comiketNo,
      source_md5_hint: catalogRefreshJobs.sourceMD5Hint,
      source_updated_at: catalogRefreshJobs.sourceUpdatedAt,
      provider_circlems_event_id: catalogRefreshJobs.providerCirclemsEventID,
      user_id: userIdentities.userID,
      identity_id: sql<number>`${userIdentities.id}`.as("identity_id"),
      provider_environment: sql<
        "production" | "sandbox"
      >`${userIdentities.providerEnvironment}`,
    })
    .from(catalogRefreshJobs)
    .innerJoin(
      userIdentities,
      eq(userIdentities.id, catalogRefreshJobs.userIdentityID),
    )
    .where(
      and(
        eq(catalogRefreshJobs.id, jobID),
        eq(catalogRefreshJobs.leaseID, leaseID),
        eq(catalogRefreshJobs.state, "leased"),
        gt(catalogRefreshJobs.leaseExpiresAt, now),
        eq(userIdentities.provider, "circlems"),
      ),
    )
    .get();
  if (!row) throw refreshAuthorityLost();
  let credential = await loadCircleCredential(
    bindings.COMINAVI_DB,
    row.user_id,
    row.identity_id,
    bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
  );
  if (
    credential.accessExpiresAt !== null &&
    credential.accessExpiresAt <= now + 60
  ) {
    credential = await refreshOwnedCircleCredential(
      bindings.COMINAVI_DB,
      row.user_id,
      row.identity_id,
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      bindings,
      fetcher,
      now,
    );
  }
  const source = await loadCatalogSource(
    {
      user_id: row.user_id,
      identity_id: row.identity_id,
      provider_environment: row.provider_environment,
      comiket_no: row.comiket_no,
      provider_circlems_event_id: row.provider_circlems_event_id,
      source_md5_hint: row.source_md5_hint,
    },
    row.provider_circlems_event_id,
    credential,
    bindings,
    fetcher,
  );
  if (source.md5Hint !== row.source_md5_hint) {
    const mismatchNow = clock();
    const failed = await db
      .update(catalogRefreshJobs)
      .set({
        state: "failed",
        leaseID: null,
        leaseExpiresAt: null,
        lastError: "source_changed_before_download",
        updatedAt: mismatchNow,
      })
      .where(
        activeLeasePredicate(row.id, leaseID, row.source_md5_hint, mismatchNow),
      )
      .run();
    if ((failed.meta.changes ?? 0) !== 1) throw refreshAuthorityLost();
    throw new ServiceError(
      "catalog_refresh_source_changed",
      409,
      "The provider catalog changed before download; a new job is required.",
    );
  }
  const nowAfterAwait = clock();
  const stillAuthoritative = await db
    .select({ authorized: sql<number>`1` })
    .from(catalogRefreshJobs)
    .where(
      activeLeasePredicate(row.id, leaseID, row.source_md5_hint, nowAfterAwait),
    )
    .get();
  if (!stillAuthoritative) throw refreshAuthorityLost();
  return {
    id: row.id,
    comiketNo: row.comiket_no,
    sourceMD5Hint: row.source_md5_hint,
    sourceMainURL: source.mainURL,
    sourceImageURL: source.imageURL,
    sourceUpdatedAt: source.updatedAt ?? row.source_updated_at,
  };
}

export async function finishCatalogRefreshJob(
  database: D1Database,
  jobID: string,
  leaseID: string,
  versionID: string,
  idempotencyKey: string,
  payloadHash: string,
  now: number,
): Promise<void> {
  const db = createDatabase(database);
  if (
    await loadRefreshCommandReceipt(
      database,
      idempotencyKey,
      "complete",
      payloadHash,
    )
  ) {
    return;
  }
  const atomicallyPublished = await db
    .select({ published: sql<number>`1` })
    .from(catalogRefreshJobs)
    .where(
      and(
        eq(catalogRefreshJobs.id, jobID),
        eq(catalogRefreshJobs.state, "published"),
        eq(catalogRefreshJobs.publishedVersionID, versionID),
        eq(catalogRefreshJobs.publishedLeaseID, leaseID),
      ),
    )
    .get();
  if (atomicallyPublished) {
    await db
      .insert(catalogRefreshCommandReceipts)
      .values({
        idempotencyKey,
        action: "complete",
        payloadHash,
        jobID,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: catalogRefreshCommandReceipts.idempotencyKey,
      })
      .run();
    const receipt = await loadRefreshCommandReceipt(
      database,
      idempotencyKey,
      "complete",
      payloadHash,
    );
    if (!receipt) throw refreshAuthorityLost();
    return;
  }
  await db.batch([
    db.update(catalogRefreshJobs).set({
      state: "published",
      publishedVersionID: versionID,
      publishedLeaseID: leaseID,
      leaseID: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now,
      lastCommandKey: idempotencyKey,
      lastCommandPayloadHash: payloadHash,
    }).where(sql`${catalogRefreshJobs.id} = ${jobID}
        AND ${catalogRefreshJobs.leaseID} = ${leaseID}
        AND ${catalogRefreshJobs.state} = 'leased'
        AND ${catalogRefreshJobs.leaseExpiresAt} > ${now}
        AND EXISTS (
          SELECT 1 FROM ${catalogEvents}
          WHERE ${catalogEvents.comiketNo} = ${catalogRefreshJobs.comiketNo}
            AND ${catalogEvents.activeVersionID} = ${versionID}
        )`),
    db
      .insert(catalogRefreshCommandReceipts)
      .select(
        sql`SELECT ${idempotencyKey}, 'complete', ${payloadHash},
                         ${catalogRefreshJobs.id}, NULL, ${now}
                  FROM ${catalogRefreshJobs}
                  WHERE ${catalogRefreshJobs.id} = ${jobID}
                    AND ${catalogRefreshJobs.state} = 'published'
                    AND ${catalogRefreshJobs.publishedVersionID} = ${versionID}
                    AND ${catalogRefreshJobs.lastCommandKey} = ${idempotencyKey}
                    AND ${catalogRefreshJobs.publishedLeaseID} = ${leaseID}
                    AND ${catalogRefreshJobs.lastCommandPayloadHash} = ${payloadHash}`,
      )
      .onConflictDoNothing({
        target: catalogRefreshCommandReceipts.idempotencyKey,
      }),
  ]);
  if (
    !(await loadRefreshCommandReceipt(
      database,
      idempotencyKey,
      "complete",
      payloadHash,
    ))
  ) {
    throw refreshAuthorityLost();
  }
}

export async function releaseCatalogRefreshJob(
  database: D1Database,
  jobID: string,
  leaseID: string,
  errorCode: string,
  idempotencyKey: string,
  payloadHash: string,
  now: number,
): Promise<void> {
  const db = createDatabase(database);
  if (
    await loadRefreshCommandReceipt(
      database,
      idempotencyKey,
      "release",
      payloadHash,
    )
  ) {
    return;
  }
  const normalizedError = errorCode.slice(0, 100);
  await db.batch([
    db
      .update(catalogRefreshJobs)
      .set({
        state: sql`CASE WHEN ${catalogRefreshJobs.attemptCount} >= 5
                    THEN 'failed' ELSE 'queued' END`,
        leaseID: null,
        leaseExpiresAt: null,
        lastError: normalizedError,
        updatedAt: now,
        lastCommandKey: idempotencyKey,
        lastCommandPayloadHash: payloadHash,
      })
      .where(
        and(
          eq(catalogRefreshJobs.id, jobID),
          eq(catalogRefreshJobs.leaseID, leaseID),
          eq(catalogRefreshJobs.state, "leased"),
          gt(catalogRefreshJobs.leaseExpiresAt, now),
        ),
      ),
    db
      .insert(catalogRefreshCommandReceipts)
      .select(
        sql`SELECT ${idempotencyKey}, 'release', ${payloadHash},
                         ${catalogRefreshJobs.id}, NULL, ${now}
                  FROM ${catalogRefreshJobs}
                  WHERE ${catalogRefreshJobs.id} = ${jobID}
                    AND ${catalogRefreshJobs.lastError} = ${normalizedError}
                    AND ${catalogRefreshJobs.lastCommandKey} = ${idempotencyKey}
                    AND ${catalogRefreshJobs.lastCommandPayloadHash} = ${payloadHash}`,
      )
      .onConflictDoNothing({
        target: catalogRefreshCommandReceipts.idempotencyKey,
      }),
  ]);
  if (
    !(await loadRefreshCommandReceipt(
      database,
      idempotencyKey,
      "release",
      payloadHash,
    ))
  ) {
    throw refreshAuthorityLost();
  }
}

async function loadRefreshCommandReceipt(
  database: D1Database,
  idempotencyKey: string,
  action: "lease" | "renew" | "complete" | "release",
  payloadHash: string,
): Promise<{ jobID: string | null; resultJSON: string | null } | null> {
  const row = await createDatabase(database)
    .select({
      action: catalogRefreshCommandReceipts.action,
      payload_hash: catalogRefreshCommandReceipts.payloadHash,
      job_id: catalogRefreshCommandReceipts.jobID,
      result_json: catalogRefreshCommandReceipts.resultJSON,
    })
    .from(catalogRefreshCommandReceipts)
    .where(eq(catalogRefreshCommandReceipts.idempotencyKey, idempotencyKey))
    .get();
  if (!row) return null;
  if (row.action !== action || row.payload_hash !== payloadHash) {
    throw new ServiceError(
      "idempotency_conflict",
      409,
      "The internal idempotency key was used with a different command.",
    );
  }
  return { jobID: row.job_id, resultJSON: row.result_json };
}

function parseRenewalResult(
  value: string | null,
): { leaseExpiresAt: number } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { leaseExpiresAt?: unknown };
    return Number.isSafeInteger(parsed.leaseExpiresAt) &&
      Number(parsed.leaseExpiresAt) > 0
      ? { leaseExpiresAt: Number(parsed.leaseExpiresAt) }
      : null;
  } catch {
    return null;
  }
}

function refreshAuthorityLost(): ServiceError {
  return new ServiceError(
    "catalog_refresh_authority_lost",
    409,
    "The catalog refresh job lease is no longer authoritative.",
  );
}

function activeLeasePredicate(
  jobID: string,
  leaseID: string,
  sourceMD5Hint: string,
  now: number,
) {
  return and(
    eq(catalogRefreshJobs.id, jobID),
    eq(catalogRefreshJobs.leaseID, leaseID),
    eq(catalogRefreshJobs.sourceMD5Hint, sourceMD5Hint),
    eq(catalogRefreshJobs.state, "leased"),
    gt(catalogRefreshJobs.leaseExpiresAt, now),
  );
}

async function loadCatalogSource(
  candidate: RefreshCandidate,
  providerEventID: number,
  credential: CircleCredential,
  bindings: CatalogRefreshBindings,
  fetcher: typeof fetch,
): Promise<{
  md5Hint: string;
  mainURL: string;
  imageURL: string;
  updatedAt: number | null;
}> {
  const origin =
    candidate.provider_environment === "production"
      ? bindings.COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN
      : bindings.COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN;
  const url = new URL("/CatalogBase/All/", origin);
  url.searchParams.set("EventId", String(providerEventID));
  const response = await fetcher(url, {
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Invalid Circle.ms CatalogBase response.");
  }
  const parsed = parseCatalogBase(value);
  if (!response.ok || !parsed) throw new Error("Circle.ms CatalogBase failed.");
  return parsed;
}

async function resolveProviderEventID(
  candidate: RefreshCandidate,
  credential: CircleCredential,
  bindings: CatalogRefreshBindings,
  fetcher: typeof fetch,
): Promise<number> {
  const origin =
    candidate.provider_environment === "production"
      ? bindings.COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN
      : bindings.COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN;
  const response = await fetcher(new URL("/WebCatalog/GetEventList", origin), {
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Invalid Circle.ms event list response.");
  }
  if (
    !response.ok ||
    !isRecord(value) ||
    value.status !== "success" ||
    !isRecord(value.response) ||
    !Array.isArray(value.response.list)
  ) {
    throw new Error("Circle.ms event list failed.");
  }
  for (const event of value.response.list) {
    if (!isRecord(event)) continue;
    const eventNumber = numberValue(event, ["EventNo", "eventNo", "event_no"]);
    const eventID = numberValue(event, ["EventId", "eventId", "event_id"]);
    if (eventNumber === candidate.comiket_no && eventID && eventID > 0) {
      await createDatabase(bindings.COMINAVI_DB)
        .update(catalogEvents)
        .set({ providerCirclemsEventID: eventID })
        .where(
          and(
            eq(catalogEvents.comiketNo, candidate.comiket_no),
            isNull(catalogEvents.providerCirclemsEventID),
          ),
        )
        .run();
      return eventID;
    }
  }
  throw new Error("Circle.ms event ID is unavailable for this Comiket.");
}

function parseCatalogBase(value: unknown): {
  md5Hint: string;
  mainURL: string;
  imageURL: string;
  updatedAt: number | null;
} | null {
  if (
    !isRecord(value) ||
    value.status !== "success" ||
    !isRecord(value.response)
  ) {
    return null;
  }
  const response = value.response;
  if (!isRecord(response.url) || !isRecord(response.md5)) return null;
  const mainURL = stringValue(response.url, [
    "textdb_sqlite3_url_ssl",
    "textdbSqlite3UrlSsl",
  ]);
  const imageURL = stringValue(response.url, [
    "imagedb1_url_ssl",
    "imagedb1UrlSsl",
  ]);
  const mainMD5 = stringValue(response.md5, [
    "textdb_sqlite3_url_ssl",
    "textdbSqlite3UrlSsl",
  ])?.toLowerCase();
  const imageMD5 = stringValue(response.md5, [
    "imagedb1_url_ssl",
    "imagedb1UrlSsl",
  ])?.toLowerCase();
  if (
    !safeHTTPSURL(mainURL) ||
    !safeHTTPSURL(imageURL) ||
    !mainMD5 ||
    !imageMD5 ||
    !/^[0-9a-f]{32}$/.test(mainMD5) ||
    !/^[0-9a-f]{32}$/.test(imageMD5)
  ) {
    return null;
  }
  const updated = stringValue(response, ["updatedate", "updateDate"]);
  const milliseconds = updated ? Date.parse(updated) : Number.NaN;
  return {
    md5Hint: `${mainMD5}:${imageMD5}`,
    mainURL,
    imageURL,
    updatedAt: Number.isFinite(milliseconds)
      ? Math.floor(milliseconds / 1_000)
      : null,
  };
}

function stringValue(
  object: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    if (typeof object[key] === "string" && object[key]) return object[key];
  }
  return null;
}

function numberValue(
  object: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = Number(object[key]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function safeHTTPSURL(value: string | null): value is string {
  if (!value || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { createDatabase } from "../db/client";
import {
  catalogEvents,
  catalogImportClaims,
  catalogRefreshCommandReceipts,
  catalogRefreshFailures,
  catalogRefreshJobs,
  catalogVersions,
  providerCredentials,
  userIdentities,
} from "../db/schema";
