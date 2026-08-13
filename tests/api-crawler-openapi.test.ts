import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHomepageApp } from "../src/api/app";
import { generateOpenAPIDocument } from "../src/api/openapi";
import { SQLiteD1Database } from "./sqlite-d1";

const secret = "crawler-openapi-test-secret-at-least-32-bytes";
const idempotencyKey = "twitterapi:2090000000000000001";
const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

const payload = {
  schemaVersion: 1,
  source: "cominavi-collector",
  observedAt: "2026-08-15T03:00:00Z",
  events: [
    {
      eventKey:
        "twitterapi:2090000000000000001:inventory_sold_out:v1:2289b74a43739072f734a567011aac7ec20c78ee3f962e7f4a2889e80aa1587c",
      sourceRevision: 1,
      updateKind: "inventory_sold_out",
      stateKind: "inventory",
      stateValue: "sold_out",
      confidence: "high",
      notifiable: true,
      post: {
        id: "2090000000000000001",
        url: "https://x.com/circle/status/2090000000000000001",
        text: "新刊は完売しました",
        occurredAt: "2026-08-15T03:00:00Z",
        author: { xUserID: "9", handle: "circle", name: "Circle" },
        media: [],
      },
      circles: [
        {
          comiketNo: 108,
          wcID: 10,
          circleID: 1,
          circleName: "Circle",
          day: 1,
          spaceNo: 1,
          spaceNoSub: 0,
        },
      ],
      evidence: { policy: "realtime-state-v2" },
    },
  ],
};

test("OpenAPI documents crawler HMAC as three required headers and both receipt statuses", async () => {
  const document = await generateOpenAPIDocument();
  const operation = document.paths?.["/api/v2/internal/crawler/events"]?.post;
  assert.equal(operation?.operationId, "ingestCrawlerEvents");
  assert.deepEqual(operation?.security, [
    {
      crawlerSignature: [],
      crawlerTimestamp: [],
      crawlerIdempotencyKey: [],
    },
  ]);
  assert.ok(operation?.responses?.["200"]);
  assert.ok(operation?.responses?.["202"]);
  assert.equal(
    operation?.responses?.["200"]?.description,
    "The exact crawler batch was already accepted.",
  );
  assert.equal(
    operation?.responses?.["202"]?.description,
    "The crawler batch was accepted for the first time.",
  );

  const schemes = document.components?.securitySchemes;
  assert.deepEqual(schemes?.crawlerSignature, {
    type: "apiKey",
    in: "header",
    name: "X-ComiNavi-Signature",
    description:
      "Versioned lowercase HMAC-SHA256 signature: `v1=<64 lowercase hex characters>`. The signed bytes are `<X-ComiNavi-Timestamp>.<Idempotency-Key>.<exact request body>`.",
  });
  assert.equal(
    schemes?.crawlerTimestamp && "name" in schemes.crawlerTimestamp
      ? schemes.crawlerTimestamp.name
      : undefined,
    "X-ComiNavi-Timestamp",
  );
  assert.equal(
    schemes?.crawlerIdempotencyKey && "name" in schemes.crawlerIdempotencyKey
      ? schemes.crawlerIdempotencyKey.name
      : undefined,
    "Idempotency-Key",
  );
});

test("v2 crawler ingress authenticates exact bytes and returns 202 then 200 replay", async () => {
  const database = setup();
  const queue = new RecordingQueue();
  const app = createHomepageApp(() => new Response("astro"));
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = sign(timestamp, body);
  const env = {
    COMINAVI_DB: database.binding,
    COMINAVI_CRAWLER_WEBHOOK_SECRET: secret,
    COMINAVI_PUSH_QUEUE: queue.binding,
  } as Cloudflare.Env;
  const call = (requestBody: string, requestSignature = signature) =>
    app.fetch(
      new Request("https://cominavi.net/api/v2/internal/crawler/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-ComiNavi-Timestamp": timestamp,
          "X-ComiNavi-Signature": `v1=${requestSignature}`,
        },
        body: requestBody,
      }),
      env,
      executionContext,
    );

  const accepted = await call(body);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    acceptedEvents: 1,
    duplicate: false,
    cursor: 1,
    queuedDeliveries: 0,
  });

  const replay = await call(body);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    acceptedEvents: 1,
    duplicate: true,
    cursor: 1,
    queuedDeliveries: 0,
  });
  assert.deepEqual(queue.messages, []);

  const tampered = await call(`${body} `);
  assert.equal(tampered.status, 401);
  assert.deepEqual(await tampered.json(), {
    error: "invalid_crawler_signature",
    message: "The crawler signature is invalid or expired.",
  });
});

test("crawler ingress rejects an open oversized request stream without waiting on a cloned tee", async () => {
  const database = setup();
  const app = createHomepageApp(() => new Response("astro"));
  const env = {
    COMINAVI_DB: database.binding,
    COMINAVI_CRAWLER_WEBHOOK_SECRET: secret,
    COMINAVI_PUSH_QUEUE: new RecordingQueue().binding,
  } as Cloudflare.Env;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_000_001));
    },
    cancel() {
      cancelled = true;
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const request = new Request(
    "https://cominavi.net/api/v2/internal/crawler/events",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-ComiNavi-Timestamp": timestamp,
        "X-ComiNavi-Signature": `v1=${"0".repeat(64)}`,
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      app.fetch(request, env, executionContext),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("oversized crawler body rejection timed out")),
          1_000,
        );
      }),
    ]);
    assert.equal(response.status, 413);
    assert.equal(
      (await response.json<{ error: string }>()).error,
      "invalid_crawler_payload",
    );
    assert.equal(cancelled, true);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
});

function sign(timestamp: string, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${idempotencyKey}.`)
    .update(body)
    .digest("hex");
}

function setup(): SQLiteD1Database {
  return new SQLiteD1Database(
    [
      "migrations/0001_following_imports.sql",
      "migrations/0002_realtime_service.sql",
      "migrations/0003_accounts_shared_plans.sql",
      "migrations/0004_sanitized_catalog.sql",
      "migrations/0005_shared_plan_crdt_notifications.sql",
      "migrations/0006_notification_inbox.sql",
      "migrations/0007_catalog_genres_all_days.sql",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
}

class RecordingQueue {
  readonly messages: unknown[] = [];
  readonly binding = {
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      this.messages.push(...Array.from(messages, (message) => message.body));
    },
  } as unknown as Queue<unknown>;
}
