import { ServiceError } from "./service-error";

const encoder = new TextEncoder();
const maximumBodyBytes = 1_000_000;
const maximumEvents = 50;
// D1 executes every statement in a batch transactionally, but each statement
// still counts as database work. Keep authenticated callbacks bounded even if
// a buggy crawler repeats many media items or circle targets.
const maximumStatements = 90;
const allowedStateValues: Record<string, ReadonlySet<string> | undefined> = {
  attendance: new Set(["attending", "absent"]),
  inventory: new Set(["available", "low_stock", "sold_out"]),
  presence: new Set(["present", "temporarily_away", "closed"]),
  shinagaki: undefined,
  cover: undefined,
};

interface CrawlerMedia {
  key: string;
  type: string;
  role: "shinagaki" | "cover" | "post_image";
  url: string;
  previewURL?: string;
  width?: number;
  height?: number;
  palette?: unknown;
  payloadSHA256?: string;
}

interface CrawlerCircle {
  comiketNo: number;
  wcID: number;
  circleID?: number;
  circleName?: string;
  penName?: string;
  day?: number;
  areaName?: string;
  blockName?: string;
  spaceNo?: number;
  spaceNoSub?: number;
  location?: string;
  catalogPayloadSHA256?: string;
  catalogRecord?: unknown;
}

interface CrawlerPost {
  id: string;
  url?: string;
  text: string;
  occurredAt: string;
  author: {
    xUserID?: string;
    handle: string;
    name?: string;
    profileImageURL?: string;
  };
  media: CrawlerMedia[];
  raw?: unknown;
}

export interface CrawlerEvent {
  eventKey: string;
  sourceRevision: number;
  updateKind: string;
  stateKind: keyof typeof allowedStateValues;
  stateValue: string;
  confidence: "high" | "medium" | "low" | "unmatched";
  notifiable: boolean;
  post: CrawlerPost;
  circles: CrawlerCircle[];
  evidence?: unknown;
}

interface CrawlerBatch {
  schemaVersion: 1;
  source: "cominavi-collector";
  observedAt: string;
  events: CrawlerEvent[];
}

export interface CrawlerIngestResult {
  duplicate: boolean;
  acceptedEvents: number;
  deliveryIDs: number[];
  cursor: number;
}

export async function authenticateCrawlerRequest(
  request: Request,
  secret: string,
  nowMilliseconds = Date.now(),
): Promise<{
  idempotencyKey: string;
  rawBody: Uint8Array;
  payloadSHA256: string;
}> {
  if (secret.length < 32) {
    throw new ServiceError(
      "crawler_authentication_unavailable",
      503,
      "Crawler authentication is not configured.",
    );
  }
  const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
  const timestampText = request.headers.get("X-ComiNavi-Timestamp") ?? "";
  const signatureText = request.headers.get("X-ComiNavi-Signature") ?? "";
  const timestamp = Number(timestampText);
  const signatureMatch = /^v1=([0-9a-f]{64})$/.exec(signatureText);
  if (
    !/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey) ||
    !Number.isSafeInteger(timestamp) ||
    !signatureMatch ||
    Math.abs(Math.floor(nowMilliseconds / 1_000) - timestamp) > 300
  ) {
    throw invalidCrawlerSignature();
  }

  const bodyBuffer = await request.arrayBuffer();
  if (bodyBuffer.byteLength === 0 || bodyBuffer.byteLength > maximumBodyBytes) {
    throw new ServiceError(
      "invalid_crawler_payload",
      413,
      "The crawler payload is empty or too large.",
    );
  }
  const rawBody = new Uint8Array(bodyBuffer);
  const signedPrefix = encoder.encode(`${timestampText}.${idempotencyKey}.`);
  const signed = new Uint8Array(signedPrefix.length + rawBody.length);
  signed.set(signedPrefix);
  signed.set(rawBody, signedPrefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, signed),
  );
  const supplied = hexBytes(signatureMatch[1]);
  if (!constantTimeEqual(expected, supplied)) throw invalidCrawlerSignature();

  return {
    idempotencyKey,
    rawBody,
    payloadSHA256: await sha256Hex(rawBody),
  };
}

export function parseCrawlerBatch(rawBody: Uint8Array): CrawlerBatch {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw invalidCrawlerPayload();
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.source !== "cominavi-collector" ||
    parseTimestamp(value.observedAt) === null ||
    !Array.isArray(value.events) ||
    value.events.length > maximumEvents
  ) {
    throw invalidCrawlerPayload();
  }
  const events = value.events.map(parseEvent);
  if (
    new Set(events.map((event) => event.eventKey)).size !== events.length ||
    crawlerStatementCount(events) > maximumStatements
  ) {
    throw invalidCrawlerPayload();
  }
  return {
    schemaVersion: 1,
    source: "cominavi-collector",
    observedAt: value.observedAt as string,
    events,
  };
}

export async function ingestCrawlerBatch(
  database: D1Database,
  input: {
    idempotencyKey: string;
    payloadSHA256: string;
    rawBody: Uint8Array;
    batch: CrawlerBatch;
  },
  nowMilliseconds = Date.now(),
): Promise<CrawlerIngestResult> {
  for (const event of input.batch.events) {
    if (event.eventKey !== (await expectedCrawlerEventKey(event))) {
      throw new ServiceError(
        "invalid_crawler_event_key",
        400,
        "A crawler event key does not match its immutable event content.",
      );
    }
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  const observedAt = requireTimestamp(input.batch.observedAt);
  const existing = await database
    .prepare(
      `SELECT id, payload_sha256
       FROM ingest_batches
       WHERE source = ?1 AND idempotency_key = ?2`,
    )
    .bind(input.batch.source, input.idempotencyKey)
    .first<{ id: number; payload_sha256: string }>();
  if (existing) {
    if (existing.payload_sha256 !== input.payloadSHA256) {
      throw idempotencyConflict();
    }
    return loadIngestResult(database, input.batch, true);
  }

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT OR IGNORE INTO ingest_batches (
           source, idempotency_key, payload_sha256, schema_version,
           observed_at, received_at, raw_payload_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        input.batch.source,
        input.idempotencyKey,
        input.payloadSHA256,
        input.batch.schemaVersion,
        observedAt,
        now,
        new TextDecoder().decode(input.rawBody),
      ),
  ];

  const events = [...input.batch.events].sort(compareEvents);
  for (const event of events) {
    const occurredAt = requireTimestamp(event.post.occurredAt);
    for (const circle of event.circles) {
      statements.push(
        database
          .prepare(
            `INSERT INTO circles (
               comiket_no, wc_id, circle_id, circle_name, pen_name, day,
               area_name, block_name, space_no, space_no_sub, location,
               catalog_payload_sha256, catalog_record_json, created_at, updated_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14
             WHERE EXISTS (
               SELECT 1 FROM ingest_batches
               WHERE source = ?15 AND idempotency_key = ?16 AND payload_sha256 = ?17
             )
             ON CONFLICT(comiket_no, wc_id) DO UPDATE SET
               circle_id = COALESCE(excluded.circle_id, circles.circle_id),
               circle_name = CASE WHEN excluded.circle_name <> '' THEN excluded.circle_name ELSE circles.circle_name END,
               pen_name = CASE WHEN excluded.pen_name <> '' THEN excluded.pen_name ELSE circles.pen_name END,
               day = COALESCE(excluded.day, circles.day),
               area_name = COALESCE(excluded.area_name, circles.area_name),
               block_name = COALESCE(excluded.block_name, circles.block_name),
               space_no = COALESCE(excluded.space_no, circles.space_no),
               space_no_sub = COALESCE(excluded.space_no_sub, circles.space_no_sub),
               location = COALESCE(excluded.location, circles.location),
               catalog_payload_sha256 = COALESCE(excluded.catalog_payload_sha256, circles.catalog_payload_sha256),
               catalog_record_json = CASE WHEN excluded.catalog_record_json <> '{}' THEN excluded.catalog_record_json ELSE circles.catalog_record_json END,
               updated_at = MAX(excluded.updated_at, circles.updated_at)`,
          )
          .bind(
            circle.comiketNo,
            circle.wcID,
            circle.circleID ?? null,
            circle.circleName ?? "",
            circle.penName ?? "",
            circle.day ?? null,
            circle.areaName ?? null,
            circle.blockName ?? null,
            circle.spaceNo ?? null,
            circle.spaceNoSub ?? null,
            circle.location ?? null,
            circle.catalogPayloadSHA256 ?? null,
            JSON.stringify(circle.catalogRecord ?? {}),
            now,
            input.batch.source,
            input.idempotencyKey,
            input.payloadSHA256,
          ),
      );
    }
    statements.push(
      postStatement(database, event, observedAt, occurredAt, input),
    );
    for (const [index, media] of event.post.media.entries()) {
      statements.push(mediaStatement(database, event, media, index, input));
    }
    statements.push(eventStatement(database, event, occurredAt, now, input));
    for (const circle of event.circles) {
      statements.push(targetStatement(database, event, circle));
    }
    statements.push(deliveryStatement(database, event, now));
    statements.push(headStatement(database, event, now));
  }

  const results = await database.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const raced = await database
      .prepare(
        `SELECT payload_sha256 FROM ingest_batches
         WHERE source = ?1 AND idempotency_key = ?2`,
      )
      .bind(input.batch.source, input.idempotencyKey)
      .first<{ payload_sha256: string }>();
    if (!raced || raced.payload_sha256 !== input.payloadSHA256) {
      throw idempotencyConflict();
    }
  }
  return loadIngestResult(database, input.batch, false);
}

async function loadIngestResult(
  database: D1Database,
  batch: CrawlerBatch,
  duplicate: boolean,
): Promise<CrawlerIngestResult> {
  const eventKeys = JSON.stringify(batch.events.map((event) => event.eventKey));
  const [events, deliveries, cursor] = await Promise.all([
    database
      .prepare(
        `SELECT count(*) AS count
         FROM circle_update_events
         WHERE event_key IN (SELECT value FROM json_each(?1))`,
      )
      .bind(eventKeys)
      .first<{ count: number }>(),
    database
      .prepare(
        `SELECT delivery.id
         FROM notification_deliveries AS delivery
         JOIN circle_update_events AS event
           ON event.id = delivery.update_event_id
         WHERE event.event_key IN (SELECT value FROM json_each(?1))
           AND delivery.status IN ('pending', 'retry')
         ORDER BY delivery.id`,
      )
      .bind(eventKeys)
      .all<{ id: number }>(),
    database
      .prepare(
        `SELECT COALESCE(max(id), 0) AS cursor FROM circle_update_events`,
      )
      .first<{ cursor: number }>(),
  ]);
  return {
    duplicate,
    acceptedEvents: events?.count ?? 0,
    deliveryIDs: deliveries.results.map((row) => row.id),
    cursor: cursor?.cursor ?? 0,
  };
}

function postStatement(
  database: D1Database,
  event: CrawlerEvent,
  observedAt: number,
  occurredAt: number,
  input: Parameters<typeof ingestCrawlerBatch>[1],
): D1PreparedStatement {
  const post = event.post;
  return database
    .prepare(
      `INSERT INTO social_posts (
         post_id, author_x_user_id, author_handle, author_name,
         author_profile_image_url, post_url, text, occurred_at,
         latest_observed_at, raw_post_json
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE EXISTS (
         SELECT 1 FROM ingest_batches
         WHERE source = ?11 AND idempotency_key = ?12 AND payload_sha256 = ?13
       )
       ON CONFLICT(post_id) DO UPDATE SET
         author_x_user_id = excluded.author_x_user_id,
         author_handle = excluded.author_handle,
         author_name = excluded.author_name,
         author_profile_image_url = excluded.author_profile_image_url,
         post_url = excluded.post_url,
         text = excluded.text,
         occurred_at = excluded.occurred_at,
         latest_observed_at = excluded.latest_observed_at,
         raw_post_json = excluded.raw_post_json
       WHERE excluded.latest_observed_at >= social_posts.latest_observed_at`,
    )
    .bind(
      post.id,
      post.author.xUserID ?? null,
      post.author.handle,
      post.author.name ?? null,
      post.author.profileImageURL ?? null,
      post.url ?? null,
      post.text,
      occurredAt,
      observedAt,
      JSON.stringify(post.raw ?? post),
      input.batch.source,
      input.idempotencyKey,
      input.payloadSHA256,
    );
}

function mediaStatement(
  database: D1Database,
  event: CrawlerEvent,
  media: CrawlerMedia,
  index: number,
  input: Parameters<typeof ingestCrawlerBatch>[1],
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO post_media (
         post_id, media_index, media_key, media_type, role, url,
         preview_url, width, height, palette_json, payload_sha256
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE EXISTS (
         SELECT 1 FROM ingest_batches
         WHERE source = ?12 AND idempotency_key = ?13 AND payload_sha256 = ?14
       )
       ON CONFLICT(post_id, media_key) DO UPDATE SET
         media_index = excluded.media_index,
         media_type = excluded.media_type,
         role = excluded.role,
         url = excluded.url,
         preview_url = excluded.preview_url,
         width = excluded.width,
         height = excluded.height,
         palette_json = excluded.palette_json,
         payload_sha256 = excluded.payload_sha256`,
    )
    .bind(
      event.post.id,
      index,
      media.key,
      media.type,
      media.role,
      media.url,
      media.previewURL ?? null,
      media.width ?? null,
      media.height ?? null,
      media.palette === undefined ? null : JSON.stringify(media.palette),
      media.payloadSHA256 ?? null,
      input.batch.source,
      input.idempotencyKey,
      input.payloadSHA256,
    );
}

function eventStatement(
  database: D1Database,
  event: CrawlerEvent,
  occurredAt: number,
  now: number,
  input: Parameters<typeof ingestCrawlerBatch>[1],
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO circle_update_events (
         event_key, ingest_batch_id, source, source_revision, post_id,
         update_kind, state_kind, state_value, confidence, occurred_at,
         notifiable, evidence_json, created_at
       )
       SELECT ?1, batch.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
       FROM ingest_batches AS batch
       WHERE batch.source = ?2 AND batch.idempotency_key = ?13
         AND batch.payload_sha256 = ?14`,
    )
    .bind(
      event.eventKey,
      input.batch.source,
      event.sourceRevision,
      event.post.id,
      event.updateKind,
      event.stateKind,
      event.stateValue,
      event.confidence,
      occurredAt,
      event.notifiable ? 1 : 0,
      JSON.stringify(event.evidence ?? {}),
      now,
      input.idempotencyKey,
      input.payloadSHA256,
    );
}

function targetStatement(
  database: D1Database,
  event: CrawlerEvent,
  circle: CrawlerCircle,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO circle_update_targets
         (update_event_id, comiket_no, wc_id)
       SELECT id, ?2, ?3 FROM circle_update_events WHERE event_key = ?1`,
    )
    .bind(event.eventKey, circle.comiketNo, circle.wcID);
}

function deliveryStatement(
  database: D1Database,
  event: CrawlerEvent,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO notification_deliveries (
         update_event_id, user_id, device_id, status, attempt_count,
         available_at, created_at, updated_at
       )
       SELECT DISTINCT event.id, favorite.user_id, device.id,
              'pending', 0, ?2, ?2, ?2
       FROM circle_update_events AS event
       JOIN circle_update_targets AS target
         ON target.update_event_id = event.id
       JOIN user_favorites AS favorite
         ON favorite.comiket_no = target.comiket_no
        AND favorite.wc_id = target.wc_id
        AND favorite.active = 1
        AND favorite.notifications_enabled = 1
       JOIN push_devices AS device
         ON device.user_id = favorite.user_id AND device.enabled = 1
       LEFT JOIN circle_state_heads AS head
         ON head.comiket_no = target.comiket_no
        AND head.wc_id = target.wc_id
        AND head.state_kind = event.state_kind
       WHERE event.event_key = ?1 AND event.notifiable = 1
         AND (head.update_event_id IS NULL OR
              event.occurred_at > head.occurred_at OR
              (event.occurred_at = head.occurred_at AND event.source_revision > head.source_revision) OR
              (event.occurred_at = head.occurred_at AND event.source_revision = head.source_revision
               AND event.event_key > head.event_key))
         AND (head.update_event_id IS NULL OR head.state_value <> event.state_value)`,
    )
    .bind(event.eventKey, now);
}

function headStatement(
  database: D1Database,
  event: CrawlerEvent,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO circle_state_heads (
         comiket_no, wc_id, state_kind, state_value, occurred_at,
         source_revision, event_key, update_event_id, updated_at
       )
       SELECT target.comiket_no, target.wc_id, event.state_kind,
              event.state_value, event.occurred_at, event.source_revision,
              event.event_key, event.id, ?2
       FROM circle_update_events AS event
       JOIN circle_update_targets AS target ON target.update_event_id = event.id
       WHERE event.event_key = ?1
       ON CONFLICT(comiket_no, wc_id, state_kind) DO UPDATE SET
         state_value = excluded.state_value,
         occurred_at = excluded.occurred_at,
         source_revision = excluded.source_revision,
         event_key = excluded.event_key,
         update_event_id = excluded.update_event_id,
         updated_at = excluded.updated_at
       WHERE excluded.occurred_at > circle_state_heads.occurred_at OR
             (excluded.occurred_at = circle_state_heads.occurred_at
              AND excluded.source_revision > circle_state_heads.source_revision) OR
             (excluded.occurred_at = circle_state_heads.occurred_at
              AND excluded.source_revision = circle_state_heads.source_revision
              AND excluded.event_key > circle_state_heads.event_key)`,
    )
    .bind(event.eventKey, now);
}

function parseEvent(value: unknown): CrawlerEvent {
  if (!isRecord(value)) throw invalidCrawlerPayload();
  const stateKind = value.stateKind;
  const allowedValues =
    typeof stateKind === "string" ? allowedStateValues[stateKind] : null;
  if (
    typeof value.eventKey !== "string" ||
    !/^[A-Za-z0-9._:-]{8,240}$/.test(value.eventKey) ||
    !Number.isSafeInteger(value.sourceRevision) ||
    Number(value.sourceRevision) <= 0 ||
    typeof value.updateKind !== "string" ||
    !/^[a-z][a-z0-9_]{1,63}$/.test(value.updateKind) ||
    typeof stateKind !== "string" ||
    !(stateKind in allowedStateValues) ||
    typeof value.stateValue !== "string" ||
    value.stateValue.length === 0 ||
    value.stateValue.length > 500 ||
    (allowedValues instanceof Set && !allowedValues.has(value.stateValue)) ||
    !["high", "medium", "low", "unmatched"].includes(
      String(value.confidence),
    ) ||
    typeof value.notifiable !== "boolean" ||
    !Array.isArray(value.circles) ||
    value.circles.length === 0 ||
    value.circles.length > 20
  ) {
    throw invalidCrawlerPayload();
  }
  const circles = value.circles.map(parseCircle);
  if (
    new Set(circles.map((circle) => `${circle.comiketNo}:${circle.wcID}`))
      .size !== circles.length
  ) {
    throw invalidCrawlerPayload();
  }
  return {
    eventKey: value.eventKey,
    sourceRevision: Number(value.sourceRevision),
    updateKind: value.updateKind,
    stateKind: stateKind as CrawlerEvent["stateKind"],
    stateValue: value.stateValue,
    confidence: value.confidence as CrawlerEvent["confidence"],
    notifiable: value.notifiable,
    post: parsePost(value.post),
    circles,
    ...(value.evidence === undefined ? {} : { evidence: value.evidence }),
  };
}

function parsePost(value: unknown): CrawlerPost {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[0-9]{1,24}$/.test(value.id) ||
    typeof value.text !== "string" ||
    value.text.length > 100_000 ||
    parseTimestamp(value.occurredAt) === null ||
    !isRecord(value.author) ||
    typeof value.author.handle !== "string" ||
    !/^[A-Za-z0-9_]{1,15}$/.test(value.author.handle) ||
    !Array.isArray(value.media) ||
    value.media.length > 20
  ) {
    throw invalidCrawlerPayload();
  }
  const media = value.media.map(parseMedia);
  if (new Set(media.map((item) => item.key)).size !== media.length) {
    throw invalidCrawlerPayload();
  }
  return {
    id: value.id,
    ...(safeHTTPSURL(value.url) ? { url: value.url as string } : {}),
    text: value.text,
    occurredAt: value.occurredAt as string,
    author: {
      ...(typeof value.author.xUserID === "string"
        ? { xUserID: value.author.xUserID }
        : {}),
      handle: value.author.handle.toLowerCase(),
      ...(typeof value.author.name === "string"
        ? { name: value.author.name.slice(0, 500) }
        : {}),
      ...(safeHTTPSURL(value.author.profileImageURL)
        ? { profileImageURL: value.author.profileImageURL as string }
        : {}),
    },
    media,
    ...(value.raw === undefined ? {} : { raw: value.raw }),
  };
}

function parseMedia(value: unknown): CrawlerMedia {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    value.key.length > 500 ||
    typeof value.type !== "string" ||
    !["shinagaki", "cover", "post_image"].includes(String(value.role)) ||
    !safeHTTPSURL(value.url)
  ) {
    throw invalidCrawlerPayload();
  }
  return {
    key: value.key,
    type: value.type.slice(0, 64),
    role: value.role as CrawlerMedia["role"],
    url: value.url as string,
    ...(safeHTTPSURL(value.previewURL)
      ? { previewURL: value.previewURL as string }
      : {}),
    ...(positiveInteger(value.width) ? { width: Number(value.width) } : {}),
    ...(positiveInteger(value.height) ? { height: Number(value.height) } : {}),
    ...(value.palette === undefined ? {} : { palette: value.palette }),
    ...(typeof value.payloadSHA256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.payloadSHA256)
      ? { payloadSHA256: value.payloadSHA256 }
      : {}),
  };
}

function parseCircle(value: unknown): CrawlerCircle {
  if (
    !isRecord(value) ||
    !positiveInteger(value.comiketNo) ||
    !positiveInteger(value.wcID) ||
    (value.circleID !== undefined && !positiveInteger(value.circleID))
  ) {
    throw invalidCrawlerPayload();
  }
  return {
    comiketNo: Number(value.comiketNo),
    wcID: Number(value.wcID),
    ...(positiveInteger(value.circleID)
      ? { circleID: Number(value.circleID) }
      : {}),
    ...(typeof value.circleName === "string"
      ? { circleName: value.circleName.slice(0, 1_000) }
      : {}),
    ...(typeof value.penName === "string"
      ? { penName: value.penName.slice(0, 1_000) }
      : {}),
    ...(positiveInteger(value.day) ? { day: Number(value.day) } : {}),
    ...(typeof value.areaName === "string" ? { areaName: value.areaName } : {}),
    ...(typeof value.blockName === "string"
      ? { blockName: value.blockName }
      : {}),
    ...(positiveInteger(value.spaceNo)
      ? { spaceNo: Number(value.spaceNo) }
      : {}),
    ...(Number.isSafeInteger(value.spaceNoSub)
      ? { spaceNoSub: Number(value.spaceNoSub) }
      : {}),
    ...(typeof value.location === "string" ? { location: value.location } : {}),
    ...(typeof value.catalogPayloadSHA256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.catalogPayloadSHA256)
      ? { catalogPayloadSHA256: value.catalogPayloadSHA256 }
      : {}),
    ...(value.catalogRecord === undefined
      ? {}
      : { catalogRecord: value.catalogRecord }),
  };
}

function compareEvents(left: CrawlerEvent, right: CrawlerEvent): number {
  return (
    requireTimestamp(left.post.occurredAt) -
      requireTimestamp(right.post.occurredAt) ||
    left.sourceRevision - right.sourceRevision ||
    left.eventKey.localeCompare(right.eventKey)
  );
}

export async function expectedCrawlerEventKey(
  event: Pick<
    CrawlerEvent,
    | "sourceRevision"
    | "updateKind"
    | "stateKind"
    | "stateValue"
    | "post"
    | "circles"
  >,
): Promise<string> {
  const targets = event.circles
    .map((circle) => [circle.comiketNo, circle.wcID] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const identity = JSON.stringify([
    event.post.id,
    event.updateKind,
    event.stateKind,
    event.stateValue,
    event.sourceRevision,
    targets,
  ]);
  const digest = await sha256Hex(encoder.encode(identity));
  return `twitterapi:${event.post.id}:${event.updateKind}:v${event.sourceRevision}:${digest}`;
}

function crawlerStatementCount(events: CrawlerEvent[]): number {
  return (
    1 +
    events.reduce(
      (count, event) =>
        count + 4 + event.circles.length * 2 + event.post.media.length,
      0,
    )
  );
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? Math.floor(milliseconds / 1_000)
    : null;
}

function requireTimestamp(value: string): number {
  const parsed = parseTimestamp(value);
  if (parsed === null) throw invalidCrawlerPayload();
  return parsed;
}

function safeHTTPSURL(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function invalidCrawlerSignature(): ServiceError {
  return new ServiceError(
    "invalid_crawler_signature",
    401,
    "The crawler signature is invalid or expired.",
  );
}

function invalidCrawlerPayload(): ServiceError {
  return new ServiceError(
    "invalid_crawler_payload",
    400,
    "The crawler payload does not match schema version 1.",
  );
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "This idempotency key was already used for a different payload.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
