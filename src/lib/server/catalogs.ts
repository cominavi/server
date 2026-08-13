import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { createDatabase } from "../db/client";
import {
  catalogAreas,
  catalogArtifacts,
  catalogBlocks,
  catalogCircles,
  catalogDates,
  catalogEvents,
  catalogFloors,
  catalogGenres,
  catalogImageAssets,
  catalogImportClaims,
  catalogInternalCommandReceipts,
  catalogLayouts,
  catalogMappings,
  catalogMaps,
  catalogRefreshJobs,
  catalogStableCircles,
  catalogVersions,
} from "../db/schema";
import { ServiceError } from "./service-error";

const catalogSchemaVersion = 1;
const derivedContentType = "application/vnd.cominavi.catalog-v1+sqlite";

export interface CatalogIndexItemV1 {
  schemaVersion: 1;
  versionID: string;
  comiketNo: number;
  name: string;
  publishedAt: number;
  sourceUpdatedAt: number | null;
  sourceMainSHA256: string;
  artifact: {
    url: string;
    sha256: string;
    bytes: number;
    contentType: typeof derivedContentType;
  };
  counts: {
    circles: number;
    layouts: number;
    images: number;
  };
  capabilities: {
    stableCircleIdentity: "comiketNo+wcID";
    circleImages: true;
    commonImages: true;
  };
}

interface CatalogRow {
  id: string;
  comiket_no: number;
  name: string;
  source_updated_at: number | null;
  source_main_sha256: string;
  derived_sha256: string;
  derived_bytes: number;
  circle_count: number;
  layout_count: number;
  image_count: number;
  published_at: number;
}

const catalogRowSelection = {
  id: catalogVersions.id,
  comiket_no: catalogVersions.comiketNo,
  name: catalogEvents.name,
  source_updated_at: catalogVersions.sourceUpdatedAt,
  source_main_sha256: catalogVersions.sourceMainSHA256,
  derived_sha256: sql<string>`${catalogVersions.derivedSHA256}`,
  derived_bytes: sql<number>`${catalogVersions.derivedBytes}`,
  circle_count: catalogVersions.circleCount,
  layout_count: catalogVersions.layoutCount,
  image_count: catalogVersions.imageCount,
  published_at: sql<number>`${catalogVersions.publishedAt}`,
};

function publishedCatalogPredicate() {
  return and(
    eq(catalogVersions.state, "published"),
    eq(catalogVersions.schemaVersion, catalogSchemaVersion),
    isNotNull(catalogVersions.derivedSHA256),
    isNotNull(catalogVersions.derivedBytes),
    isNotNull(catalogVersions.publishedAt),
  );
}

interface ArtifactRow {
  object_key: string;
  sha256: string;
  byte_count: number;
  content_type: string;
}

export interface CatalogPublicationAuthority {
  claimID?: string;
  leaseID?: string;
  sourceMD5Hint?: string;
}

export async function assertCatalogPublicationAuthority(
  database: D1Database,
  authority: CatalogPublicationAuthority,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  if (
    authority.claimID === undefined &&
    authority.leaseID === undefined &&
    authority.sourceMD5Hint === undefined
  ) {
    return;
  }
  if (
    !authority.claimID ||
    !authority.leaseID ||
    !authority.sourceMD5Hint ||
    !/^[0-9a-f-]{36}$/.test(authority.claimID) ||
    !/^[0-9a-f-]{36}$/.test(authority.leaseID) ||
    !/^[0-9a-f]{32}:[0-9a-f]{32}$/.test(authority.sourceMD5Hint)
  ) {
    throw publicationAuthorityLost();
  }
  const row = await createDatabase(database)
    .select({ authorized: sql<number>`1` })
    .from(catalogRefreshJobs)
    .where(
      and(
        eq(catalogRefreshJobs.id, authority.claimID),
        eq(catalogRefreshJobs.leaseID, authority.leaseID),
        eq(catalogRefreshJobs.sourceMD5Hint, authority.sourceMD5Hint),
        eq(catalogRefreshJobs.state, "leased"),
        gt(catalogRefreshJobs.leaseExpiresAt, now),
      ),
    )
    .get();
  if (!row) throw publicationAuthorityLost();
}

export async function assertCatalogPublicationStatusAuthority(
  database: D1Database,
  authority: Required<CatalogPublicationAuthority>,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  if (
    !/^[0-9a-f-]{36}$/.test(authority.claimID) ||
    !/^[0-9a-f-]{36}$/.test(authority.leaseID) ||
    !/^[0-9a-f]{32}:[0-9a-f]{32}$/.test(authority.sourceMD5Hint)
  ) {
    throw publicationAuthorityLost();
  }
  const row = await createDatabase(database)
    .select({ authorized: sql<number>`1` })
    .from(catalogRefreshJobs)
    .where(
      and(
        eq(catalogRefreshJobs.id, authority.claimID),
        eq(catalogRefreshJobs.sourceMD5Hint, authority.sourceMD5Hint),
        or(
          and(
            eq(catalogRefreshJobs.state, "leased"),
            eq(catalogRefreshJobs.leaseID, authority.leaseID),
            gt(catalogRefreshJobs.leaseExpiresAt, now),
          ),
          and(
            eq(catalogRefreshJobs.state, "published"),
            eq(catalogRefreshJobs.publishedLeaseID, authority.leaseID),
          ),
        ),
      ),
    )
    .get();
  if (!row) throw publicationAuthorityLost();
}

export async function assertScheduledCatalogClaimAuthority(
  database: D1Database,
  claimID: string,
  leaseID: string,
  sourceMD5Hint: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const row = await createDatabase(database)
    .select({ authorized: sql<number>`1` })
    .from(catalogImportClaims)
    .innerJoin(
      catalogRefreshJobs,
      eq(catalogRefreshJobs.id, catalogImportClaims.refreshJobID),
    )
    .where(
      and(
        eq(catalogImportClaims.claimID, claimID),
        eq(catalogImportClaims.refreshLeaseID, leaseID),
        eq(catalogImportClaims.sourceMD5Hint, sourceMD5Hint),
        eq(catalogImportClaims.refreshLeaseID, catalogRefreshJobs.leaseID),
        eq(catalogImportClaims.sourceMD5Hint, catalogRefreshJobs.sourceMD5Hint),
        gt(catalogImportClaims.leaseExpiresAt, now),
        gt(catalogRefreshJobs.leaseExpiresAt, now),
        eq(catalogRefreshJobs.state, "leased"),
      ),
    )
    .get();
  if (!row) throw publicationAuthorityLost();
}

export async function listPublishedCatalogs(
  database: D1Database,
): Promise<{ items: CatalogIndexItemV1[] }> {
  const rows = await createDatabase(database)
    .select(catalogRowSelection)
    .from(catalogEvents)
    .innerJoin(
      catalogVersions,
      eq(catalogVersions.id, catalogEvents.activeVersionID),
    )
    .where(publishedCatalogPredicate())
    .orderBy(desc(catalogVersions.comiketNo));
  return { items: rows.map(publicCatalog) };
}

export async function loadPublishedCatalog(
  database: D1Database,
  comiketNo: number,
): Promise<CatalogIndexItemV1> {
  if (!Number.isSafeInteger(comiketNo) || comiketNo < 1) throw notFound();
  const row = await createDatabase(database)
    .select(catalogRowSelection)
    .from(catalogEvents)
    .innerJoin(
      catalogVersions,
      eq(catalogVersions.id, catalogEvents.activeVersionID),
    )
    .where(
      and(eq(catalogEvents.comiketNo, comiketNo), publishedCatalogPredicate()),
    )
    .get();
  if (!row) throw notFound();
  return publicCatalog(row);
}

export async function loadPublishedArtifact(
  database: D1Database,
  comiketNo: number,
  versionID: string,
): Promise<ArtifactRow> {
  if (!Number.isSafeInteger(comiketNo) || comiketNo < 1) throw notFound();
  const row = await createDatabase(database)
    .select({
      object_key: catalogArtifacts.objectKey,
      sha256: catalogArtifacts.sha256,
      byte_count: catalogArtifacts.byteCount,
      content_type: catalogArtifacts.contentType,
    })
    .from(catalogEvents)
    .innerJoin(
      catalogVersions,
      eq(catalogVersions.comiketNo, catalogEvents.comiketNo),
    )
    .innerJoin(
      catalogArtifacts,
      eq(catalogArtifacts.versionID, catalogVersions.id),
    )
    .where(
      and(
        eq(catalogEvents.comiketNo, comiketNo),
        eq(catalogVersions.id, versionID),
        inArray(catalogVersions.state, ["published", "superseded"]),
        eq(catalogArtifacts.kind, "derived_catalog"),
        eq(catalogArtifacts.visibility, "authenticated_download"),
      ),
    )
    .get();
  if (!row || row.content_type !== derivedContentType) throw notFound();
  return row;
}

export interface CatalogImportClaimInput {
  comiketNo: number;
  name: string;
  claimID: string;
  sourceMD5Hint?: string | null;
  refreshLeaseID?: string | null;
  now: number;
  leaseSeconds?: number;
}

export async function claimCatalogImport(
  database: D1Database,
  input: CatalogImportClaimInput,
): Promise<boolean> {
  validateClaim(input);
  const db = createDatabase(database);
  if (input.sourceMD5Hint) {
    const unchanged = await db
      .select({ unchanged: sql<number>`1` })
      .from(catalogEvents)
      .innerJoin(
        catalogVersions,
        eq(catalogVersions.id, catalogEvents.activeVersionID),
      )
      .where(
        and(
          eq(catalogEvents.comiketNo, input.comiketNo),
          eq(catalogVersions.state, "published"),
          eq(catalogVersions.sourceMD5Hint, input.sourceMD5Hint),
        ),
      )
      .get();
    if (unchanged) return false;
  }
  const leaseExpiresAt = input.now + (input.leaseSeconds ?? 900);
  const results = await db.batch([
    db
      .insert(catalogEvents)
      .values({
        comiketNo: input.comiketNo,
        name: input.name.trim(),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: catalogEvents.comiketNo }),
    db
      .insert(catalogImportClaims)
      .select(
        sql`SELECT ${input.comiketNo}, ${input.claimID}, ${input.sourceMD5Hint ?? null},
                   CASE WHEN ${input.refreshLeaseID ?? null} IS NULL
                     THEN NULL ELSE ${input.claimID} END,
                   ${input.refreshLeaseID ?? null}, ${leaseExpiresAt},
                   ${input.now}, ${input.now}
            WHERE ${input.refreshLeaseID ?? null} IS NULL OR EXISTS (
              SELECT 1 FROM ${catalogRefreshJobs}
              WHERE ${catalogRefreshJobs.id} = ${input.claimID}
                AND ${catalogRefreshJobs.leaseID} = ${input.refreshLeaseID ?? null}
                AND ${catalogRefreshJobs.state} = 'leased'
                AND ${catalogRefreshJobs.leaseExpiresAt} > ${input.now}
                AND ${catalogRefreshJobs.sourceMD5Hint} = ${input.sourceMD5Hint ?? null}
            )`,
      )
      .onConflictDoUpdate({
        target: catalogImportClaims.comiketNo,
        set: {
          claimID: sql.raw("excluded.claim_id"),
          sourceMD5Hint: sql.raw("excluded.source_md5_hint"),
          refreshJobID: sql.raw("excluded.refresh_job_id"),
          refreshLeaseID: sql.raw("excluded.refresh_lease_id"),
          leaseExpiresAt: sql.raw("excluded.lease_expires_at"),
          createdAt: sql.raw("excluded.created_at"),
          updatedAt: sql.raw("excluded.updated_at"),
        },
        where: or(
          lte(catalogImportClaims.leaseExpiresAt, input.now),
          eq(catalogImportClaims.claimID, sql.raw("excluded.claim_id")),
        ),
      }),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) {
    throw new ServiceError(
      "catalog_import_in_progress",
      409,
      "A catalog import is already in progress.",
    );
  }
  return true;
}

export interface CatalogStageInput {
  versionID: string;
  comiketNo: number;
  claimID: string;
  refreshLeaseID?: string | null;
  sourceUpdatedAt?: number | null;
  sourceMD5Hint?: string | null;
  sourceMainSHA256: string;
  sourceImageSHA256: string;
  derivedSHA256: string;
  derivedBytes: number;
  derivedObjectKey: string;
  dateCount: number;
  mapCount: number;
  areaCount: number;
  blockCount: number;
  floorCount: number;
  mappingCount: number;
  genreCount: number;
  circleCount: number;
  layoutCount: number;
  imageCount: number;
  privateSources: {
    main: { objectKey: string; bytes: number };
    image: { objectKey: string; bytes: number };
  };
  now: number;
}

export async function stageCatalogVersion(
  database: D1Database,
  input: CatalogStageInput,
): Promise<void> {
  validateStage(input);
  const db = createDatabase(database);
  const existing = await db
    .select({
      state: catalogVersions.state,
      comiket_no: catalogVersions.comiketNo,
      claim_id: catalogVersions.claimID,
      source_main_sha256: catalogVersions.sourceMainSHA256,
      source_image_sha256: catalogVersions.sourceImageSHA256,
      derived_sha256: catalogVersions.derivedSHA256,
      derived_bytes: catalogVersions.derivedBytes,
      date_count: catalogVersions.dateCount,
      map_count: catalogVersions.mapCount,
      area_count: catalogVersions.areaCount,
      block_count: catalogVersions.blockCount,
      floor_count: catalogVersions.floorCount,
      mapping_count: catalogVersions.mappingCount,
      genre_count: catalogVersions.genreCount,
      circle_count: catalogVersions.circleCount,
      layout_count: catalogVersions.layoutCount,
      image_count: catalogVersions.imageCount,
      object_key: catalogArtifacts.objectKey,
    })
    .from(catalogVersions)
    .innerJoin(
      catalogArtifacts,
      eq(catalogArtifacts.versionID, catalogVersions.id),
    )
    .where(
      and(
        eq(catalogVersions.id, input.versionID),
        eq(catalogArtifacts.kind, "derived_catalog"),
      ),
    )
    .get();
  if (existing) {
    if (
      (existing.state === "staging" || existing.state === "published") &&
      existing.comiket_no === input.comiketNo &&
      existing.claim_id === input.claimID &&
      existing.source_main_sha256 === input.sourceMainSHA256 &&
      existing.source_image_sha256 === input.sourceImageSHA256 &&
      existing.derived_sha256 === input.derivedSHA256 &&
      existing.derived_bytes === input.derivedBytes &&
      existing.date_count === input.dateCount &&
      existing.map_count === input.mapCount &&
      existing.area_count === input.areaCount &&
      existing.block_count === input.blockCount &&
      existing.floor_count === input.floorCount &&
      existing.mapping_count === input.mappingCount &&
      existing.genre_count === input.genreCount &&
      existing.circle_count === input.circleCount &&
      existing.layout_count === input.layoutCount &&
      existing.image_count === input.imageCount &&
      existing.object_key === input.derivedObjectKey
    ) {
      return;
    }
    throw new ServiceError(
      "catalog_stage_conflict",
      409,
      "The catalog version conflicts with an existing staged version.",
    );
  }
  const statements = [
    db.insert(catalogVersions).select(sql`
      SELECT ${input.versionID}, ${input.comiketNo}, 1, 'staging', ${input.claimID},
             ${input.sourceUpdatedAt ?? null}, ${input.sourceMD5Hint ?? null},
             ${input.sourceMainSHA256}, ${input.sourceImageSHA256},
             ${input.derivedSHA256}, ${input.derivedBytes}, ${input.dateCount},
             ${input.mapCount}, ${input.areaCount}, ${input.blockCount},
             ${input.floorCount}, ${input.mappingCount}, ${input.genreCount},
             ${input.circleCount}, ${input.layoutCount}, ${input.imageCount},
             ${input.now}, NULL
      FROM ${catalogImportClaims}
      WHERE ${catalogImportClaims.comiketNo} = ${input.comiketNo}
        AND ${catalogImportClaims.claimID} = ${input.claimID}
        AND ${catalogImportClaims.leaseExpiresAt} > ${input.now}
        AND ((${catalogImportClaims.refreshJobID} IS NULL
              AND ${input.refreshLeaseID ?? null} IS NULL)
          OR (${catalogImportClaims.refreshLeaseID} = ${input.refreshLeaseID ?? null}
              AND ${catalogImportClaims.sourceMD5Hint} = ${input.sourceMD5Hint ?? null}))
        AND (${catalogImportClaims.refreshJobID} IS NULL OR EXISTS (
          SELECT 1 FROM ${catalogRefreshJobs}
          WHERE ${catalogRefreshJobs.id} = ${catalogImportClaims.refreshJobID}
            AND ${catalogRefreshJobs.leaseID} = ${catalogImportClaims.refreshLeaseID}
            AND ${catalogRefreshJobs.state} = 'leased'
            AND ${catalogRefreshJobs.leaseExpiresAt} > ${input.now}
            AND ${catalogRefreshJobs.sourceMD5Hint} = ${catalogImportClaims.sourceMD5Hint}
        ))`),
    db.insert(catalogArtifacts).select(sql`
      SELECT ${input.versionID}, 'derived_catalog', 'authenticated_download',
             ${input.derivedObjectKey}, ${input.derivedSHA256}, NULL,
             ${input.derivedBytes}, ${derivedContentType}, ${input.now}
      FROM ${catalogVersions}
      WHERE ${catalogVersions.id} = ${input.versionID}
        AND ${catalogVersions.comiketNo} = ${input.comiketNo}
        AND ${catalogVersions.claimID} = ${input.claimID}
        AND ${catalogVersions.state} = 'staging'`),
  ];
  for (const [kind, source, sha256] of [
    ["source_main", input.privateSources.main, input.sourceMainSHA256],
    ["source_image", input.privateSources.image, input.sourceImageSHA256],
  ] as const) {
    statements.push(
      db.insert(catalogArtifacts).select(sql`
        SELECT ${input.versionID}, ${kind}, 'private_source', ${source.objectKey},
               ${sha256}, ${input.sourceMD5Hint ?? null}, ${source.bytes},
               'application/vnd.sqlite3', ${input.now}
        FROM ${catalogVersions}
        WHERE ${catalogVersions.id} = ${input.versionID}
          AND ${catalogVersions.comiketNo} = ${input.comiketNo}
          AND ${catalogVersions.claimID} = ${input.claimID}
          AND ${catalogVersions.state} = 'staging'`),
    );
  }
  const results = await db.batch(
    statements as [(typeof statements)[0], ...typeof statements],
  );
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ServiceError(
      "catalog_stage_conflict",
      409,
      "The catalog version could not be staged for this import claim.",
    );
  }
}

export async function loadCatalogPublicationStatus(
  database: D1Database,
  versionID: string,
): Promise<"staging" | "published" | "superseded" | "failed" | null> {
  const row = await createDatabase(database)
    .select({ state: catalogVersions.state })
    .from(catalogVersions)
    .where(eq(catalogVersions.id, versionID))
    .get();
  return row?.state ?? null;
}

export interface CatalogNormalizedDataV1 {
  dates: Array<{ day: number; dateISO: string; weekday: number }>;
  maps: Array<{
    mapID: number;
    name: string;
    width: number;
    height: number;
    originX: number;
    originY: number;
    rotation: number;
    artworkName: string | null;
  }>;
  areas: Array<{
    areaID: number;
    mapID: number;
    name: string;
    simpleName: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  blocks: Array<{ blockID: number; areaID: number; name: string }>;
  floors: Array<{ floorID: number; day: number; mapID: number; name: string }>;
  mappings: Array<{
    day: number;
    blockID: number;
    mapID: number;
    areaID: number;
    floorID: number;
  }>;
  genres: Array<{
    genreID: number;
    code: number | null;
    day: number | null;
    name: string;
  }>;
  layouts: Array<{
    blockID: number;
    spaceNo: number;
    mapID: number;
    hallID: number | null;
    x: number;
    y: number;
    orientation: number;
  }>;
  circles: Array<{
    wcID: number;
    day: number;
    blockID: number;
    spaceNo: number;
    spaceNoSub: number;
    genreID: number;
    name: string;
    kana: string;
    penName: string;
    bookName: string;
    websiteURL: string | null;
    description: string;
    twitterURL: string | null;
    pixivURL: string | null;
    updateID: number | null;
  }>;
  images: Array<{
    kind: "circle_cut" | "common";
    assetKey: string;
    wcID: number | null;
    width: number;
    height: number;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    byteCount: number;
    sha256: string;
  }>;
}

export async function ingestCatalogRows(
  database: D1Database,
  input: {
    versionID: string;
    comiketNo: number;
    claimID: string;
    refreshLeaseID?: string | null;
    sourceMD5Hint?: string | null;
    now: number;
    data: CatalogNormalizedDataV1;
  },
  clock: () => number = () => input.now,
): Promise<void> {
  const db = createDatabase(database);
  await runStatementChunks(
    db,
    input.data.dates.map(
      (row) => () =>
        db
          .insert(catalogDates)
          .select(
            guardedCatalogSelect(input, clock(), [
              row.day,
              row.dateISO,
              row.weekday,
            ]),
          )
          .onConflictDoUpdate({
            target: [catalogDates.versionID, catalogDates.day],
            set: {
              dateISO: sql.raw("excluded.date_iso"),
              weekday: sql.raw("excluded.weekday"),
            },
          }),
    ),
  );
  await runStatementChunks(
    db,
    input.data.maps.map(
      (row) => () =>
        db
          .insert(catalogMaps)
          .select(
            guardedCatalogSelect(input, clock(), [
              row.mapID,
              row.name,
              row.width,
              row.height,
              row.originX,
              row.originY,
              row.rotation,
              row.artworkName,
            ]),
          )
          .onConflictDoUpdate({
            target: [catalogMaps.versionID, catalogMaps.mapID],
            set: {
              name: sql.raw("excluded.name"),
              width: sql.raw("excluded.width"),
              height: sql.raw("excluded.height"),
              originX: sql.raw("excluded.origin_x"),
              originY: sql.raw("excluded.origin_y"),
              rotation: sql.raw("excluded.rotation"),
              artworkName: sql.raw("excluded.artwork_name"),
            },
          }),
    ),
  );
  await runStatementChunks(
    db,
    input.data.areas.map(
      (row) => () =>
        db
          .insert(catalogAreas)
          .select(
            guardedCatalogSelect(input, clock(), [
              row.areaID,
              row.mapID,
              row.name,
              row.simpleName,
              row.x,
              row.y,
              row.width,
              row.height,
            ]),
          )
          .onConflictDoUpdate({
            target: [catalogAreas.versionID, catalogAreas.areaID],
            set: {
              mapID: sql.raw("excluded.map_id"),
              name: sql.raw("excluded.name"),
              simpleName: sql.raw("excluded.simple_name"),
              x: sql.raw("excluded.x"),
              y: sql.raw("excluded.y"),
              width: sql.raw("excluded.width"),
              height: sql.raw("excluded.height"),
            },
          }),
    ),
  );
  await runStatementChunks(
    db,
    input.data.blocks.map(
      (row) => () =>
        db
          .insert(catalogBlocks)
          .select(
            guardedCatalogSelect(input, clock(), [
              row.blockID,
              row.areaID,
              row.name,
            ]),
          )
          .onConflictDoUpdate({
            target: [catalogBlocks.versionID, catalogBlocks.blockID],
            set: {
              areaID: sql.raw("excluded.area_id"),
              name: sql.raw("excluded.name"),
            },
          }),
    ),
  );
  await runStatementChunks(
    db,
    input.data.floors.map(
      (row) => () =>
        db
          .insert(catalogFloors)
          .select(
            guardedCatalogSelect(input, clock(), [
              row.floorID,
              row.day,
              row.mapID,
              row.name,
            ]),
          )
          .onConflictDoUpdate({
            target: [catalogFloors.versionID, catalogFloors.floorID],
            set: {
              day: sql.raw("excluded.day"),
              mapID: sql.raw("excluded.map_id"),
              name: sql.raw("excluded.name"),
            },
          }),
    ),
  );
  await runStatementChunks(
    db,
    input.data.mappings.map(
      (row) => () =>
        db
          .insert(catalogMappings)
          .select(
            guardedCatalogSelect(input, clock(), [
              row.day,
              row.blockID,
              row.mapID,
              row.areaID,
              row.floorID,
            ]),
          )
          .onConflictDoUpdate({
            target: [
              catalogMappings.versionID,
              catalogMappings.day,
              catalogMappings.blockID,
            ],
            set: {
              mapID: sql.raw("excluded.map_id"),
              areaID: sql.raw("excluded.area_id"),
              floorID: sql.raw("excluded.floor_id"),
            },
          }),
    ),
  );
  await runStatementChunks(
    db,
    input.data.genres.map(
      (row) => () =>
        db
          .insert(catalogGenres)
          .select(
            guardedCatalogSelect(input, clock(), [
              row.genreID,
              row.code,
              row.day,
              row.name,
            ]),
          )
          .onConflictDoUpdate({
            target: [catalogGenres.versionID, catalogGenres.genreID],
            set: {
              code: sql.raw("excluded.code"),
              day: sql.raw("excluded.day"),
              name: sql.raw("excluded.name"),
            },
          }),
    ),
  );
  await runStatementChunks(
    db,
    input.data.layouts.map(
      (row) => () =>
        db
          .insert(catalogLayouts)
          .select(
            guardedCatalogSelect(input, clock(), [
              row.blockID,
              row.spaceNo,
              row.mapID,
              row.hallID,
              row.x,
              row.y,
              row.orientation,
            ]),
          )
          .onConflictDoUpdate({
            target: [
              catalogLayouts.versionID,
              catalogLayouts.blockID,
              catalogLayouts.spaceNo,
            ],
            set: {
              mapID: sql.raw("excluded.map_id"),
              hallID: sql.raw("excluded.hall_id"),
              x: sql.raw("excluded.x"),
              y: sql.raw("excluded.y"),
              orientation: sql.raw("excluded.orientation"),
            },
          }),
    ),
  );
  await runStatementChunks(
    db,
    input.data.circles.map(
      (row) => () =>
        db
          .insert(catalogCircles)
          .select(
            guardedCatalogSelect(input, clock(), [
              input.comiketNo,
              row.wcID,
              row.day,
              row.blockID,
              row.spaceNo,
              row.spaceNoSub,
              row.genreID,
              row.name,
              row.kana,
              row.penName,
              row.bookName,
              row.websiteURL,
              row.description,
              row.twitterURL,
              row.pixivURL,
              row.updateID,
            ]),
          )
          .onConflictDoUpdate({
            target: [catalogCircles.versionID, catalogCircles.wcID],
            set: {
              day: sql.raw("excluded.day"),
              blockID: sql.raw("excluded.block_id"),
              spaceNo: sql.raw("excluded.space_no"),
              spaceNoSub: sql.raw("excluded.space_no_sub"),
              genreID: sql.raw("excluded.genre_id"),
              name: sql.raw("excluded.name"),
              kana: sql.raw("excluded.kana"),
              penName: sql.raw("excluded.pen_name"),
              bookName: sql.raw("excluded.book_name"),
              websiteURL: sql.raw("excluded.website_url"),
              description: sql.raw("excluded.description"),
              twitterURL: sql.raw("excluded.twitter_url"),
              pixivURL: sql.raw("excluded.pixiv_url"),
              updateID: sql.raw("excluded.update_id"),
            },
          }),
    ),
  );
  await runStatementChunks(
    db,
    input.data.images.map(
      (row) => () =>
        db
          .insert(catalogImageAssets)
          .select(
            guardedCatalogSelect(input, clock(), [
              row.kind,
              row.assetKey,
              row.wcID,
              row.width,
              row.height,
              row.contentType,
              row.byteCount,
              row.sha256,
            ]),
          )
          .onConflictDoUpdate({
            target: [
              catalogImageAssets.versionID,
              catalogImageAssets.kind,
              catalogImageAssets.assetKey,
            ],
            set: {
              wcID: sql.raw("excluded.wc_id"),
              width: sql.raw("excluded.width"),
              height: sql.raw("excluded.height"),
              contentType: sql.raw("excluded.content_type"),
              byteCount: sql.raw("excluded.byte_count"),
              sha256: sql.raw("excluded.sha256"),
            },
          }),
    ),
  );
}
type CatalogIngestInput = Parameters<typeof ingestCatalogRows>[1];

function guardedCatalogSelect(
  input: CatalogIngestInput,
  now: number,
  values: unknown[],
) {
  return sql`SELECT ${input.versionID}, ${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}
    WHERE EXISTS (
      SELECT 1 FROM ${catalogVersions}
      JOIN ${catalogImportClaims}
        ON ${catalogImportClaims.comiketNo} = ${catalogVersions.comiketNo}
       AND ${catalogImportClaims.claimID} = ${catalogVersions.claimID}
      WHERE ${catalogVersions.id} = ${input.versionID}
        AND ${catalogVersions.comiketNo} = ${input.comiketNo}
        AND ${catalogVersions.claimID} = ${input.claimID}
        AND ${catalogVersions.state} = 'staging'
        AND ${catalogImportClaims.leaseExpiresAt} > ${now}
        AND ((${catalogImportClaims.refreshJobID} IS NULL
              AND ${input.refreshLeaseID ?? null} IS NULL)
          OR (${catalogImportClaims.refreshLeaseID} = ${input.refreshLeaseID ?? null}
              AND ${catalogImportClaims.sourceMD5Hint} = ${input.sourceMD5Hint ?? null}))
        AND (${catalogImportClaims.refreshJobID} IS NULL OR EXISTS (
          SELECT 1 FROM ${catalogRefreshJobs}
          WHERE ${catalogRefreshJobs.id} = ${catalogImportClaims.refreshJobID}
            AND ${catalogRefreshJobs.leaseID} = ${catalogImportClaims.refreshLeaseID}
            AND ${catalogRefreshJobs.state} = 'leased'
            AND ${catalogRefreshJobs.leaseExpiresAt} > ${now}
            AND ${catalogRefreshJobs.sourceMD5Hint} = ${catalogImportClaims.sourceMD5Hint}
        ))
    )`;
}

async function runStatementChunks(
  db: ReturnType<typeof createDatabase>,
  statements: Array<() => import("drizzle-orm/batch").BatchItem<"sqlite">>,
): Promise<void> {
  for (let start = 0; start < statements.length; start += 100) {
    const chunk = statements
      .slice(start, start + 100)
      .map((statement) => statement());
    if (chunk.length === 0) continue;
    const results = await db.batch([chunk[0], ...chunk.slice(1)] as [
      (typeof chunk)[0],
      ...typeof chunk,
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new ServiceError(
        "catalog_ingest_conflict",
        409,
        "Normalized catalog rows could not be staged for this import claim.",
      );
    }
  }
}

export async function publishCatalogVersion(
  database: D1Database,
  bucket: R2Bucket,
  input: Pick<
    CatalogStageInput,
    | "versionID"
    | "comiketNo"
    | "claimID"
    | "refreshLeaseID"
    | "sourceMD5Hint"
    | "now"
  > & {
    commandReceipt?: {
      idempotencyKey: string;
      payloadSHA256: string;
    };
  },
  clock: () => number = () => input.now,
): Promise<void> {
  const db = createDatabase(database);
  const alreadyPublished = await db
    .select({ published: sql<number>`1` })
    .from(catalogEvents)
    .innerJoin(
      catalogVersions,
      eq(catalogVersions.id, catalogEvents.activeVersionID),
    )
    .where(
      and(
        eq(catalogEvents.comiketNo, input.comiketNo),
        eq(catalogVersions.id, input.versionID),
        eq(catalogVersions.claimID, input.claimID),
        eq(catalogVersions.state, "published"),
      ),
    )
    .get();
  if (alreadyPublished) return;
  const artifacts = await db
    .select({
      kind: catalogArtifacts.kind,
      visibility: catalogArtifacts.visibility,
      object_key: catalogArtifacts.objectKey,
      sha256: catalogArtifacts.sha256,
      byte_count: catalogArtifacts.byteCount,
      content_type: catalogArtifacts.contentType,
    })
    .from(catalogArtifacts)
    .where(eq(catalogArtifacts.versionID, input.versionID))
    .orderBy(catalogArtifacts.kind);
  if (
    artifacts.length !== 3 ||
    !artifacts.some(
      (artifact) =>
        artifact.kind === "derived_catalog" &&
        artifact.visibility === "authenticated_download",
    ) ||
    !artifacts.some(
      (artifact) =>
        artifact.kind === "source_main" &&
        artifact.visibility === "private_source",
    ) ||
    !artifacts.some(
      (artifact) =>
        artifact.kind === "source_image" &&
        artifact.visibility === "private_source",
    )
  ) {
    throw publicationConflict();
  }
  for (const artifact of artifacts) {
    const object = await bucket.head(artifact.object_key);
    if (
      !object ||
      object.size !== artifact.byte_count ||
      object.customMetadata?.sha256 !== artifact.sha256 ||
      object.customMetadata?.visibility !== artifact.visibility ||
      object.httpMetadata?.contentType !== artifact.content_type
    ) {
      throw new ServiceError(
        "catalog_artifact_invalid",
        409,
        "A private catalog object does not match its staged metadata.",
      );
    }
  }
  const authorityNow = clock();
  const counts = await db.get<{
    date_count: number;
    map_count: number;
    area_count: number;
    block_count: number;
    floor_count: number;
    mapping_count: number;
    genre_count: number;
    circle_count: number;
    layout_count: number;
    image_count: number;
    actual_dates: number;
    actual_maps: number;
    actual_areas: number;
    actual_blocks: number;
    actual_floors: number;
    actual_mappings: number;
    actual_genres: number;
    actual_circles: number;
    actual_layouts: number;
    actual_images: number;
    circles_without_layout: number;
    circles_without_image: number;
  }>(sql`SELECT version.date_count, version.map_count, version.area_count,
              version.block_count, version.floor_count, version.mapping_count,
              version.genre_count, version.circle_count, version.layout_count,
              version.image_count,
              (SELECT count(*) FROM catalog_dates WHERE version_id = version.id) AS actual_dates,
              (SELECT count(*) FROM catalog_maps WHERE version_id = version.id) AS actual_maps,
              (SELECT count(*) FROM catalog_areas WHERE version_id = version.id) AS actual_areas,
              (SELECT count(*) FROM catalog_blocks WHERE version_id = version.id) AS actual_blocks,
              (SELECT count(*) FROM catalog_floors WHERE version_id = version.id) AS actual_floors,
              (SELECT count(*) FROM catalog_mappings WHERE version_id = version.id) AS actual_mappings,
              (SELECT count(*) FROM catalog_genres WHERE version_id = version.id) AS actual_genres,
              (SELECT count(*) FROM catalog_circles WHERE version_id = version.id) AS actual_circles,
              (SELECT count(*) FROM catalog_layouts WHERE version_id = version.id) AS actual_layouts,
              (SELECT count(*) FROM catalog_image_assets WHERE version_id = version.id) AS actual_images
              ,(SELECT count(*) FROM catalog_circles AS circle
                WHERE circle.version_id = version.id AND NOT EXISTS (
                  SELECT 1 FROM catalog_layouts AS layout
                  WHERE layout.version_id = circle.version_id
                    AND layout.block_id = circle.block_id
                    AND layout.space_no = circle.space_no
                )) AS circles_without_layout
              ,(SELECT count(*) FROM catalog_circles AS circle
                WHERE circle.version_id = version.id AND NOT EXISTS (
                  SELECT 1 FROM catalog_image_assets AS image
                  WHERE image.version_id = circle.version_id
                    AND image.kind = 'circle_cut' AND image.wc_id = circle.wc_id
                )) AS circles_without_image
       FROM catalog_versions AS version
       JOIN catalog_import_claims AS claim
         ON claim.comiket_no = version.comiket_no AND claim.claim_id = version.claim_id
       WHERE version.id = ${input.versionID} AND version.comiket_no = ${input.comiketNo}
         AND version.claim_id = ${input.claimID} AND version.state = 'staging'
         AND claim.lease_expires_at > ${authorityNow}
         AND ((claim.refresh_job_id IS NULL AND ${input.refreshLeaseID ?? null} IS NULL)
           OR (claim.refresh_lease_id = ${input.refreshLeaseID ?? null}
             AND claim.source_md5_hint = ${input.sourceMD5Hint ?? null}))
         AND (claim.refresh_job_id IS NULL OR EXISTS (
           SELECT 1 FROM catalog_refresh_jobs AS refresh_job
           WHERE refresh_job.id = claim.refresh_job_id
             AND refresh_job.lease_id = claim.refresh_lease_id
             AND refresh_job.state = 'leased'
             AND refresh_job.lease_expires_at > ${authorityNow}
             AND refresh_job.source_md5_hint = claim.source_md5_hint
         ))`);
  if (
    !counts ||
    counts.date_count !== counts.actual_dates ||
    counts.map_count !== counts.actual_maps ||
    counts.area_count !== counts.actual_areas ||
    counts.block_count !== counts.actual_blocks ||
    counts.floor_count !== counts.actual_floors ||
    counts.mapping_count !== counts.actual_mappings ||
    counts.genre_count !== counts.actual_genres ||
    counts.circle_count !== counts.actual_circles ||
    counts.layout_count !== counts.actual_layouts ||
    counts.image_count !== counts.actual_images ||
    counts.date_count < 1 ||
    counts.map_count < 1 ||
    counts.area_count < 1 ||
    counts.block_count < 1 ||
    counts.floor_count < 1 ||
    counts.mapping_count < 1 ||
    counts.genre_count < 1 ||
    counts.circle_count < 1 ||
    counts.layout_count < 1 ||
    counts.image_count < counts.circle_count ||
    counts.circles_without_layout !== 0 ||
    counts.circles_without_image !== 0
  ) {
    throw publicationConflict();
  }
  const publicationNow = clock();
  const scheduled =
    input.refreshLeaseID !== undefined && input.refreshLeaseID !== null;
  const resultJSON = JSON.stringify({
    accepted: true,
    action: "publish",
    versionID: input.versionID,
    comiketNo: input.comiketNo,
    publishedAt: publicationNow,
  });
  const statements = [
    db
      .update(catalogVersions)
      .set({ state: "published", publishedAt: publicationNow })
      .where(sql`${catalogVersions.id} = ${input.versionID}
        AND ${catalogVersions.comiketNo} = ${input.comiketNo}
        AND ${catalogVersions.claimID} = ${input.claimID}
        AND ${catalogVersions.state} = 'staging'
        AND EXISTS (
          SELECT 1 FROM ${catalogImportClaims}
          WHERE ${catalogImportClaims.comiketNo} = ${input.comiketNo}
            AND ${catalogImportClaims.claimID} = ${input.claimID}
            AND ${catalogImportClaims.leaseExpiresAt} > ${publicationNow}
            AND ((${catalogImportClaims.refreshJobID} IS NULL
                  AND ${input.refreshLeaseID ?? null} IS NULL)
              OR (${catalogImportClaims.refreshLeaseID} = ${input.refreshLeaseID ?? null}
                  AND ${catalogImportClaims.sourceMD5Hint} = ${input.sourceMD5Hint ?? null}))
            AND (${catalogImportClaims.refreshJobID} IS NULL OR EXISTS (
              SELECT 1 FROM ${catalogRefreshJobs}
              WHERE ${catalogRefreshJobs.id} = ${catalogImportClaims.refreshJobID}
                AND ${catalogRefreshJobs.leaseID} = ${catalogImportClaims.refreshLeaseID}
                AND ${catalogRefreshJobs.state} = 'leased'
                AND ${catalogRefreshJobs.leaseExpiresAt} > ${publicationNow}
                AND ${catalogRefreshJobs.sourceMD5Hint} = ${catalogImportClaims.sourceMD5Hint}
            ))
        )`),
    db
      .insert(catalogStableCircles)
      .select(
        sql`SELECT circle.comiket_no, circle.wc_id, circle.version_id,
                         circle.version_id, ${publicationNow}, ${publicationNow}
                  FROM catalog_circles AS circle
                  JOIN catalog_versions AS version ON version.id = circle.version_id
                  WHERE circle.version_id = ${input.versionID}
                    AND version.comiket_no = ${input.comiketNo}
                    AND version.claim_id = ${input.claimID}
                    AND version.state = 'published'`,
      )
      .onConflictDoUpdate({
        target: [catalogStableCircles.comiketNo, catalogStableCircles.wcID],
        set: {
          lastVersionID: sql.raw("excluded.last_version_id"),
          lastPublishedAt: sql.raw("excluded.last_published_at"),
        },
      }),
    db.update(catalogVersions).set({ state: "superseded" })
      .where(sql`${catalogVersions.comiketNo} = ${input.comiketNo}
        AND ${catalogVersions.state} = 'published'
        AND ${catalogVersions.id} <> ${input.versionID}
        AND EXISTS (
          SELECT 1 FROM ${catalogVersions}
          WHERE ${catalogVersions.id} = ${input.versionID}
            AND ${catalogVersions.state} = 'published'
            AND ${catalogVersions.claimID} = ${input.claimID}
        )`),
    db
      .update(catalogEvents)
      .set({ activeVersionID: input.versionID, updatedAt: publicationNow })
      .where(sql`${catalogEvents.comiketNo} = ${input.comiketNo}
        AND EXISTS (
          SELECT 1 FROM ${catalogVersions}
          WHERE ${catalogVersions.id} = ${input.versionID}
            AND ${catalogVersions.state} = 'published'
            AND ${catalogVersions.claimID} = ${input.claimID}
        ) AND NOT EXISTS (
          SELECT 1 FROM ${catalogCircles}
          WHERE ${catalogCircles.versionID} = ${input.versionID}
            AND NOT EXISTS (
              SELECT 1 FROM ${catalogStableCircles}
              WHERE ${catalogStableCircles.comiketNo} = ${input.comiketNo}
                AND ${catalogStableCircles.wcID} = ${catalogCircles.wcID}
            )
        ) AND EXISTS (
          SELECT 1 FROM ${catalogImportClaims}
          WHERE ${catalogImportClaims.comiketNo} = ${input.comiketNo}
            AND ${catalogImportClaims.claimID} = ${input.claimID}
            AND ((${catalogImportClaims.refreshJobID} IS NULL
                  AND ${input.refreshLeaseID ?? null} IS NULL)
              OR (${catalogImportClaims.refreshLeaseID} = ${input.refreshLeaseID ?? null}
                  AND ${catalogImportClaims.sourceMD5Hint} = ${input.sourceMD5Hint ?? null}))
        )`),
    db.update(catalogRefreshJobs).set({
      state: "published",
      publishedVersionID: input.versionID,
      publishedLeaseID: sql`${catalogRefreshJobs.leaseID}`,
      leaseID: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: publicationNow,
    }).where(sql`${catalogRefreshJobs.id} = (
          SELECT ${catalogImportClaims.refreshJobID} FROM ${catalogImportClaims}
          WHERE ${catalogImportClaims.comiketNo} = ${input.comiketNo}
            AND ${catalogImportClaims.claimID} = ${input.claimID}
            AND ${catalogImportClaims.refreshJobID} IS NOT NULL
            AND ${catalogImportClaims.refreshLeaseID} = ${input.refreshLeaseID ?? null}
            AND ${catalogImportClaims.sourceMD5Hint} = ${input.sourceMD5Hint ?? null}
        ) AND ${catalogRefreshJobs.state} = 'leased'
          AND ${catalogRefreshJobs.leaseExpiresAt} > ${publicationNow}
          AND EXISTS (
            SELECT 1 FROM ${catalogEvents}
            WHERE ${catalogEvents.comiketNo} = ${input.comiketNo}
              AND ${catalogEvents.activeVersionID} = ${input.versionID}
          )`),
    db.update(catalogInternalCommandReceipts).set({ resultJSON })
      .where(sql`${catalogInternalCommandReceipts.idempotencyKey} = ${input.commandReceipt?.idempotencyKey ?? ""}
        AND ${catalogInternalCommandReceipts.actionScope} = 'catalog_publication:publish'
        AND ${catalogInternalCommandReceipts.payloadHash} = ${input.commandReceipt?.payloadSHA256 ?? ""}
        AND ${catalogInternalCommandReceipts.resultJSON} IS NULL
        AND EXISTS (
          SELECT 1 FROM ${catalogEvents}
          WHERE ${catalogEvents.comiketNo} = ${input.comiketNo}
            AND ${catalogEvents.activeVersionID} = ${input.versionID}
        ) AND (${scheduled ? 1 : 0} = 0 OR EXISTS (
          SELECT 1 FROM ${catalogRefreshJobs}
          WHERE ${catalogRefreshJobs.id} = ${input.claimID}
            AND ${catalogRefreshJobs.state} = 'published'
            AND ${catalogRefreshJobs.publishedLeaseID} = ${input.refreshLeaseID ?? null}
            AND ${catalogRefreshJobs.publishedVersionID} = ${input.versionID}
        ))`),
    db.delete(catalogImportClaims)
      .where(sql`${catalogImportClaims.comiketNo} = ${input.comiketNo}
        AND ${catalogImportClaims.claimID} = ${input.claimID}
        AND EXISTS (
          SELECT 1 FROM ${catalogEvents}
          WHERE ${catalogEvents.comiketNo} = ${input.comiketNo}
            AND ${catalogEvents.activeVersionID} = ${input.versionID}
        ) AND ((${catalogImportClaims.refreshJobID} IS NULL
                AND ${input.refreshLeaseID ?? null} IS NULL)
          OR (${catalogImportClaims.refreshLeaseID} = ${input.refreshLeaseID ?? null}
              AND ${catalogImportClaims.sourceMD5Hint} = ${input.sourceMD5Hint ?? null}))`),
  ];
  if (!input.commandReceipt) statements.splice(5, 1);
  const results = await db.batch([
    statements[0],
    statements[1],
    statements[2],
    statements[3],
    statements[4],
    ...statements.slice(5),
  ] as [(typeof statements)[0], ...typeof statements]);
  const jobResultIndex = 4;
  const receiptResultIndex = input.commandReceipt ? 5 : null;
  const deleteResultIndex = input.commandReceipt ? 6 : 5;
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== counts.circle_count ||
    (results[3]?.meta.changes ?? 0) !== 1 ||
    (results[jobResultIndex]?.meta.changes ?? 0) !== (scheduled ? 1 : 0) ||
    (receiptResultIndex !== null &&
      (results[receiptResultIndex]?.meta.changes ?? 0) !== 1) ||
    (results[deleteResultIndex]?.meta.changes ?? 0) !== 1
  ) {
    throw publicationConflict();
  }
}

function publicCatalog(row: CatalogRow): CatalogIndexItemV1 {
  return {
    schemaVersion: 1,
    versionID: row.id,
    comiketNo: row.comiket_no,
    name: row.name,
    publishedAt: row.published_at,
    sourceUpdatedAt: row.source_updated_at,
    sourceMainSHA256: row.source_main_sha256,
    artifact: {
      url: `/api/v2/catalogs/${row.comiket_no}/versions/${encodeURIComponent(row.id)}/artifact`,
      sha256: row.derived_sha256,
      bytes: row.derived_bytes,
      contentType: derivedContentType,
    },
    counts: {
      circles: row.circle_count,
      layouts: row.layout_count,
      images: row.image_count,
    },
    capabilities: {
      stableCircleIdentity: "comiketNo+wcID",
      circleImages: true,
      commonImages: true,
    },
  };
}

function validateClaim(input: CatalogImportClaimInput): void {
  if (!Number.isSafeInteger(input.comiketNo) || input.comiketNo < 1)
    throw new TypeError("Invalid Comiket number.");
  if (input.name.trim().length < 1 || input.name.trim().length > 100)
    throw new TypeError("Invalid catalog event name.");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.claimID,
    )
  )
    throw new TypeError("Invalid catalog claim ID.");
  if (
    input.sourceMD5Hint &&
    !/^[0-9a-f]{32}:[0-9a-f]{32}$/.test(input.sourceMD5Hint)
  )
    throw new TypeError("Invalid source MD5 change hint.");
  if (
    input.refreshLeaseID !== undefined &&
    input.refreshLeaseID !== null &&
    (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.refreshLeaseID,
    ) ||
      !input.sourceMD5Hint)
  ) {
    throw new TypeError("Invalid catalog refresh lease authority.");
  }
  if (!Number.isSafeInteger(input.now) || input.now < 1)
    throw new TypeError("Invalid claim time.");
  if (
    input.leaseSeconds !== undefined &&
    (!Number.isSafeInteger(input.leaseSeconds) ||
      input.leaseSeconds < 60 ||
      input.leaseSeconds > 7_200)
  ) {
    throw new TypeError("Invalid catalog claim lease.");
  }
}

function validateStage(input: CatalogStageInput): void {
  validateClaim({
    comiketNo: input.comiketNo,
    name: "staged",
    claimID: input.claimID,
    sourceMD5Hint: input.sourceMD5Hint,
    refreshLeaseID: input.refreshLeaseID,
    now: input.now,
  });
  if (!/^c[1-9][0-9]*-v1-[0-9a-f]{24}$/.test(input.versionID))
    throw new TypeError("Invalid catalog version ID.");
  for (const digest of [
    input.sourceMainSHA256,
    input.sourceImageSHA256,
    input.derivedSHA256,
  ]) {
    if (!/^[0-9a-f]{64}$/.test(digest))
      throw new TypeError("Invalid catalog SHA-256 digest.");
  }
  for (const count of [
    input.derivedBytes,
    input.dateCount,
    input.mapCount,
    input.areaCount,
    input.blockCount,
    input.floorCount,
    input.mappingCount,
    input.genreCount,
    input.circleCount,
    input.layoutCount,
    input.imageCount,
  ]) {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new TypeError("Invalid catalog count.");
  }
  if (input.derivedBytes < 1) throw new TypeError("Empty catalog artifact.");
  if (!input.derivedObjectKey.startsWith("derived/catalogs/"))
    throw new TypeError(
      "Derived catalog object must use the private derived prefix.",
    );
  if (!input.privateSources) {
    throw new TypeError("Private source artifact metadata is required.");
  }
  for (const source of [
    input.privateSources.main,
    input.privateSources.image,
  ]) {
    if (
      !source.objectKey.startsWith("raw/catalogs/") ||
      !Number.isSafeInteger(source.bytes) ||
      source.bytes < 1
    ) {
      throw new TypeError("Invalid private source artifact metadata.");
    }
  }
}

function notFound(): ServiceError {
  return new ServiceError("catalog_not_found", 404, "Catalog not found.");
}

function publicationConflict(): ServiceError {
  return new ServiceError(
    "catalog_publication_conflict",
    409,
    "The catalog version is not ready for atomic publication.",
  );
}

function publicationAuthorityLost(): ServiceError {
  return new ServiceError(
    "catalog_publication_authority_lost",
    409,
    "The scheduled catalog publication lease is no longer authoritative.",
  );
}
