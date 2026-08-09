import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  authenticateCrawlerRequest,
  expectedCrawlerEventKey,
  parseCrawlerBatch,
} from "../src/lib/server/crawler-ingest";

const secret = "0123456789abcdef0123456789abcdef";
const timestamp = 1_786_255_200;
const idempotencyKey = "twitterapi:2090000000000000001";
const validPayload = {
  schemaVersion: 1,
  source: "cominavi-collector",
  observedAt: "2026-08-15T03:00:00Z",
  events: [
    {
      eventKey: "twitterapi:2090000000000000001:inventory_sold_out",
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
        media: [
          {
            key: "a".repeat(64),
            type: "photo",
            role: "post_image",
            url: "https://pbs.twimg.com/media/example.jpg",
          },
        ],
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

test("crawler batch accepts the collector contract and stable WCID", () => {
  const parsed = parseCrawlerBatch(
    new TextEncoder().encode(JSON.stringify(validPayload)),
  );
  assert.equal(parsed.events[0]?.circles[0]?.wcID, 10);
  assert.equal(parsed.events[0]?.stateValue, "sold_out");
});

test("crawler event identity binds the classifier result and stable WCIDs", async () => {
  const parsed = parseCrawlerBatch(
    new TextEncoder().encode(JSON.stringify(validPayload)),
  );
  const event = parsed.events[0]!;
  assert.equal(
    await expectedCrawlerEventKey(event),
    "twitterapi:2090000000000000001:inventory_sold_out:v1:2289b74a43739072f734a567011aac7ec20c78ee3f962e7f4a2889e80aa1587c",
  );

  const changed = { ...event, stateValue: "low_stock" };
  assert.notEqual(
    await expectedCrawlerEventKey(changed),
    await expectedCrawlerEventKey(event),
  );
});

test("crawler batch rejects a state value outside the versioned contract", () => {
  const invalid = structuredClone(validPayload);
  invalid.events[0]!.stateValue = "probably_sold_out";
  assert.throws(() =>
    parseCrawlerBatch(new TextEncoder().encode(JSON.stringify(invalid))),
  );
});

test("crawler HMAC covers timestamp, idempotency key, and exact body", async () => {
  const body = JSON.stringify(validPayload);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${idempotencyKey}.`)
    .update(body)
    .digest("hex");
  const request = new Request("https://cominavi.net/api/v1/crawler/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "X-ComiNavi-Timestamp": String(timestamp),
      "X-ComiNavi-Signature": `v1=${signature}`,
    },
    body,
  });
  const authenticated = await authenticateCrawlerRequest(
    request,
    secret,
    timestamp * 1_000,
  );
  assert.equal(authenticated.idempotencyKey, idempotencyKey);

  const tampered = new Request("https://cominavi.net/api/v1/crawler/events", {
    method: "POST",
    headers: request.headers,
    body: `${body} `,
  });
  await assert.rejects(() =>
    authenticateCrawlerRequest(tampered, secret, timestamp * 1_000),
  );
});
