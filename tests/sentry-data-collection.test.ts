import assert from "node:assert/strict";
import test from "node:test";
import {
  createHomepageSentryOptions,
  sentrySensitiveCrawlerRequestHeaders,
} from "../src/api/app";

test("Sentry never collects crawler authentication headers", async () => {
  const options = createHomepageSentryOptions();
  assert.deepEqual(options.dataCollection?.httpHeaders?.request, {
    deny: [...sentrySensitiveCrawlerRequestHeaders],
  });

  const event = {
    type: undefined,
    request: {
      headers: {
        "X-ComiNavi-Signature": "signature-must-not-leave-the-worker",
        "x-cominavi-timestamp": "timestamp-must-not-leave-the-worker",
        "Idempotency-Key": "request-id-must-not-leave-the-worker",
        "User-Agent": "ComiNavi collector",
      },
    },
    spans: [
      {
        span_id: "0123456789abcdef",
        start_timestamp: 1_700_000_000,
        trace_id: "0123456789abcdef0123456789abcdef",
        data: {
          "http.request.header.x_cominavi_signature":
            "signature-must-not-leave-the-worker",
          "http.request.header.x_cominavi_timestamp":
            "timestamp-must-not-leave-the-worker",
          "http.request.header.idempotency_key":
            "request-id-must-not-leave-the-worker",
          "http.request.header.user_agent": "ComiNavi collector",
        },
      },
    ],
  };

  const scrubbed = await options.beforeSend?.(event, {});
  assert.ok(scrubbed);
  assert.deepEqual(scrubbed.request?.headers, {
    "User-Agent": "ComiNavi collector",
  });
  assert.deepEqual(scrubbed.spans?.[0]?.data, {
    "http.request.header.user_agent": "ComiNavi collector",
  });

  const serialized = JSON.stringify(scrubbed);
  assert.doesNotMatch(serialized, /signature-must-not-leave-the-worker/);
  assert.doesNotMatch(serialized, /timestamp-must-not-leave-the-worker/);
  assert.doesNotMatch(serialized, /request-id-must-not-leave-the-worker/);

  const scrubbedSpan = options.beforeSendSpan?.({
    span_id: "fedcba9876543210",
    start_timestamp: 1_700_000_000,
    trace_id: "fedcba9876543210fedcba9876543210",
    data: {
      "http.request.header.x_cominavi_signature":
        "streamed-signature-must-not-leave-the-worker",
      "http.request.header.user_agent": "ComiNavi collector",
    },
  });
  assert.deepEqual(scrubbedSpan?.data, {
    "http.request.header.user_agent": "ComiNavi collector",
  });
});
