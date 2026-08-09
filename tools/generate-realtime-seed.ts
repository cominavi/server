import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface CatalogRow {
  comiketNo: number;
  id: number;
  WCId: number;
  circleName: string | null;
  penName: string | null;
  day: number | null;
  areaName: string | null;
  blockName: string | null;
  spaceNo: number | null;
  spaceNoSub: number | null;
}

interface SelectedPost {
  tweet_id: string;
  tweet_url?: string;
  text: string;
  created_at?: string;
  author_handle: string;
  author_name?: string;
  author?: {
    id?: string;
    profile_picture?: string;
  };
  media?: Array<{
    kind: string;
    url: string;
    preview_url?: string;
  }>;
  post_confidence: "high" | "medium" | "low" | "unmatched";
  post_reasons?: string[];
  matched_circles?: Array<{
    comiket_no: number;
    circle_id: number;
    wc_id?: number;
  }>;
}

const root = resolve(import.meta.dirname, "../..");
const catalogPath = resolve(
  process.argv[2] ?? `${root}/collector/out/catalog-seed/webcatalog108.db`,
);
const selectedPostsPath = resolve(
  process.argv[3] ?? `${root}/collector/out/c108-enriched/selected-posts.json`,
);
const outputPath = resolve(
  process.argv[4] ?? `${root}/homepage/seed/c108-realtime.sql`,
);
const metadataPath = resolve(
  process.argv[5] ?? `${root}/collector/out/catalog-seed/metadata.json`,
);

const [selectedBytes, metadataBytes] = await Promise.all([
  readFile(selectedPostsPath),
  readFile(metadataPath),
]);
await access(catalogPath);
const selectedPosts = JSON.parse(
  selectedBytes.toString("utf8"),
) as SelectedPost[];
const metadata = JSON.parse(metadataBytes.toString("utf8")) as {
  files?: { database?: { sha256?: string } };
};
const catalogDigest = metadata.files?.database?.sha256 ?? null;
const selectedDigest = sha256(selectedBytes.toString("utf8"));
const seedKey = `c108:${catalogDigest ?? "unknown"}:${selectedDigest}`;
const seedDigest = sha256(seedKey);
const now = Math.floor(Date.now() / 1_000);

const database = new DatabaseSync(catalogPath);
const rows = database
  .prepare(
    `SELECT circle.comiketNo, circle.id, extension.WCId,
            circle.circleName, circle.penName, circle.day,
            area.simpleName AS areaName, block.name AS blockName,
            circle.spaceNo, circle.spaceNoSub
     FROM ComiketCircleWC AS circle
     JOIN ComiketCircleExtend AS extension
       ON extension.comiketNo = circle.comiketNo AND extension.id = circle.id
     LEFT JOIN ComiketBlockWC AS block
       ON block.comiketNo = circle.comiketNo AND block.id = circle.blockId
     LEFT JOIN ComiketAreaWC AS area
       ON area.comiketNo = block.comiketNo AND area.id = block.areaId
     WHERE circle.comiketNo = 108
     ORDER BY extension.WCId`,
  )
  .all() as unknown as CatalogRow[];
database.close();
const circleByWCID = new Map(rows.map((row) => [row.WCId, row]));

const sql: string[] = [
  "PRAGMA foreign_keys = ON;",
  `-- Generated from ${catalogPath} and ${selectedPostsPath}.`,
  `-- Seed key: ${seedKey}`,
];

for (const row of rows) {
  const location = [
    row.day ? `${row.day}日目` : null,
    row.areaName,
    row.blockName && row.spaceNo
      ? `${row.blockName}${String(row.spaceNo).padStart(2, "0")}${row.spaceNoSub === 1 ? "b" : "a"}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  const record = {
    comiketNo: row.comiketNo,
    id: row.id,
    wcID: row.WCId,
    circleName: row.circleName,
    penName: row.penName,
    day: row.day,
    areaName: row.areaName,
    blockName: row.blockName,
    spaceNo: row.spaceNo,
    spaceNoSub: row.spaceNoSub,
  };
  sql.push(
    `INSERT INTO circles (comiket_no,wc_id,circle_id,circle_name,pen_name,day,area_name,block_name,space_no,space_no_sub,location,catalog_payload_sha256,catalog_record_json,created_at,updated_at) VALUES (${row.comiketNo},${row.WCId},${row.id},${quote(row.circleName ?? "")},${quote(row.penName ?? "")},${numberOrNull(row.day)},${quote(row.areaName)},${quote(row.blockName)},${numberOrNull(row.spaceNo)},${numberOrNull(row.spaceNoSub)},${quote(location)},${quote(catalogDigest)},${quote(JSON.stringify(record))},${now},${now}) ON CONFLICT(comiket_no,wc_id) DO UPDATE SET circle_id=excluded.circle_id,circle_name=excluded.circle_name,pen_name=excluded.pen_name,day=excluded.day,area_name=excluded.area_name,block_name=excluded.block_name,space_no=excluded.space_no,space_no_sub=excluded.space_no_sub,location=excluded.location,catalog_payload_sha256=excluded.catalog_payload_sha256,catalog_record_json=excluded.catalog_record_json,updated_at=excluded.updated_at;`,
  );
}

const source = "seed:c108-local";
const batchKey = seedKey;
const rawBatch = JSON.stringify({
  seed: true,
  eventNumber: 108,
  catalogDigest,
  selectedPostsDigest: selectedDigest,
});
sql.push(
  `INSERT OR IGNORE INTO ingest_batches (source,idempotency_key,payload_sha256,schema_version,observed_at,received_at,raw_payload_json) VALUES (${quote(source)},${quote(batchKey)},${quote(seedDigest)},1,${now},${now},${quote(rawBatch)});`,
);

let postCount = 0;
let updateCount = 0;
const heads = new Map<
  string,
  { eventKey: string; occurredAt: number; sourceRevision: number }
>();

for (const post of selectedPosts) {
  const circles = uniqueCircles(post.matched_circles ?? []).filter((circle) =>
    circleByWCID.has(circle.wcID),
  );
  const media = (post.media ?? []).filter((item) => isHTTPS(item.url));
  const reasons = post.post_reasons ?? [];
  const isShinagaki =
    circles.length > 0 &&
    media.length > 0 &&
    ["high", "medium"].includes(post.post_confidence) &&
    reasons.some((reason) =>
      ["shinagaki_keyword", "menu_like_product_summary"].includes(reason),
    ) &&
    !reasons.includes("future_shinagaki_reference");
  const isCover =
    circles.length > 0 &&
    media.length > 0 &&
    /表紙|カバー|書影|cover|新刊サンプル/i.test(post.text);
  if (!isShinagaki && !isCover) continue;

  const occurredAt = timestamp(post.created_at) ?? now;
  postCount += 1;
  const normalizedPost = {
    id: post.tweet_id,
    url: post.tweet_url,
    text: post.text,
    occurredAt: new Date(occurredAt * 1_000).toISOString(),
    authorHandle: post.author_handle,
  };
  sql.push(
    `INSERT INTO social_posts (post_id,author_x_user_id,author_handle,author_name,author_profile_image_url,post_url,text,occurred_at,latest_observed_at,raw_post_json) VALUES (${quote(post.tweet_id)},${quote(post.author?.id)},${quote(post.author_handle.toLowerCase())},${quote(post.author_name)},${quote(post.author?.profile_picture)},${quote(post.tweet_url)},${quote(post.text)},${occurredAt},${now},${quote(JSON.stringify(normalizedPost))}) ON CONFLICT(post_id) DO UPDATE SET author_handle=excluded.author_handle,author_name=excluded.author_name,author_profile_image_url=excluded.author_profile_image_url,post_url=excluded.post_url,text=excluded.text,occurred_at=excluded.occurred_at,latest_observed_at=MAX(social_posts.latest_observed_at,excluded.latest_observed_at),raw_post_json=excluded.raw_post_json;`,
  );
  const primaryRole = isCover ? "cover" : "shinagaki";
  for (const [index, item] of media.entries()) {
    const mediaKey = sha256(item.url);
    sql.push(
      `INSERT INTO post_media (post_id,media_index,media_key,media_type,role,url,preview_url) VALUES (${quote(post.tweet_id)},${index},${quote(mediaKey)},${quote(item.kind || "photo")},${quote(primaryRole)},${quote(item.url)},${quote(item.preview_url)}) ON CONFLICT(post_id,media_key) DO UPDATE SET media_index=excluded.media_index,media_type=excluded.media_type,role=excluded.role,url=excluded.url,preview_url=excluded.preview_url;`,
    );
  }

  const classifications = [
    ...(isShinagaki
      ? [
          {
            stateKind: "shinagaki",
            stateValue: post.tweet_id,
            updateKind: "shinagaki_published",
          },
        ]
      : []),
    ...(isCover
      ? [
          {
            stateKind: "cover",
            stateValue: post.tweet_id,
            updateKind: "cover_published",
          },
        ]
      : []),
  ];
  for (const classification of classifications) {
    const eventKey = `${source}:${post.tweet_id}:${classification.stateKind}:v1`;
    const evidence = JSON.stringify({
      seeded: true,
      postReasons: reasons,
      matchingPolicyID: "retained-c108-seed-v1",
    });
    sql.push(
      `INSERT OR IGNORE INTO circle_update_events (event_key,ingest_batch_id,source,source_revision,post_id,update_kind,state_kind,state_value,confidence,occurred_at,notifiable,evidence_json,created_at) SELECT ${quote(eventKey)},id,${quote(source)},1,${quote(post.tweet_id)},${quote(classification.updateKind)},${quote(classification.stateKind)},${quote(classification.stateValue)},${quote(post.post_confidence)},${occurredAt},0,${quote(evidence)},${now} FROM ingest_batches WHERE source=${quote(source)} AND idempotency_key=${quote(batchKey)};`,
    );
    updateCount += 1;
    for (const circle of circles) {
      sql.push(
        `INSERT OR IGNORE INTO circle_update_targets (update_event_id,comiket_no,wc_id) SELECT id,${circle.comiketNo},${circle.wcID} FROM circle_update_events WHERE event_key=${quote(eventKey)};`,
      );
      const headKey = `${circle.comiketNo}:${circle.wcID}:${classification.stateKind}`;
      const current = heads.get(headKey);
      if (
        !current ||
        occurredAt > current.occurredAt ||
        (occurredAt === current.occurredAt && eventKey > current.eventKey)
      ) {
        heads.set(headKey, { eventKey, occurredAt, sourceRevision: 1 });
      }
    }
  }
}

for (const [key, head] of heads) {
  const [comiketNo, wcID, stateKind] = key.split(":");
  sql.push(
    `INSERT INTO circle_state_heads (comiket_no,wc_id,state_kind,state_value,occurred_at,source_revision,event_key,update_event_id,updated_at) SELECT ${comiketNo},${wcID},${quote(stateKind)},state_value,occurred_at,source_revision,event_key,id,${now} FROM circle_update_events WHERE event_key=${quote(head.eventKey)} ON CONFLICT(comiket_no,wc_id,state_kind) DO UPDATE SET state_value=excluded.state_value,occurred_at=excluded.occurred_at,source_revision=excluded.source_revision,event_key=excluded.event_key,update_event_id=excluded.update_event_id,updated_at=excluded.updated_at WHERE excluded.occurred_at > circle_state_heads.occurred_at OR (excluded.occurred_at=circle_state_heads.occurred_at AND excluded.event_key>circle_state_heads.event_key);`,
  );
}

sql.push(
  `INSERT OR REPLACE INTO seed_imports (seed_key,payload_sha256,imported_at,circle_count,post_count,update_count) VALUES (${quote(seedKey)},${quote(seedDigest)},${now},${rows.length},${postCount},${updateCount});`,
);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${sql.join("\n")}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      outputPath,
      seedKey,
      catalogDigest,
      selectedDigest,
      circles: rows.length,
      posts: postCount,
      updates: updateCount,
      heads: heads.size,
      bytes: Buffer.byteLength(sql.join("\n")),
    },
    null,
    2,
  ),
);

function uniqueCircles(
  circles: NonNullable<SelectedPost["matched_circles"]>,
): Array<{ comiketNo: number; circleID: number; wcID: number }> {
  const values = new Map<
    string,
    { comiketNo: number; circleID: number; wcID: number }
  >();
  for (const circle of circles) {
    if (
      circle.comiket_no !== 108 ||
      !Number.isSafeInteger(circle.circle_id) ||
      !Number.isSafeInteger(circle.wc_id) ||
      Number(circle.wc_id) <= 0
    ) {
      continue;
    }
    values.set(`${circle.comiket_no}:${circle.wc_id}`, {
      comiketNo: circle.comiket_no,
      circleID: circle.circle_id,
      wcID: Number(circle.wc_id),
    });
  }
  return Array.from(values.values());
}

function quote(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  const normalized = String(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[ \t]+(?=\n|$)/g, "");
  return `'${normalized.replaceAll("'", "''")}'`;
}

function numberOrNull(value: number | null): string {
  return Number.isSafeInteger(value) ? String(value) : "NULL";
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

function isHTTPS(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
