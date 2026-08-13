import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateOpenAPIDocument } from "../src/api/openapi";
import { parseAccountDeletion } from "../src/lib/server/account-deletion";
import { jsonResponse } from "../src/lib/server/api-response";
import { validateAppleNonce } from "../src/lib/server/apple-entry-grants";
import { parseLogoutRequest } from "../src/lib/server/auth-sessions";
import { parseCanonicalRequestID } from "../src/lib/server/request-id";
import {
  parseCollectionPage,
  parseInvitationCreate,
  parseMembershipMutation,
  parseOwnershipTransfer,
} from "../src/lib/server/shared-plans";
import { GET as getAppleAssociation } from "../src/pages/.well-known/apple-app-site-association";

test("the direct profile fixture exposes only controlled public avatar URLs", () => {
  const profile = JSON.parse(
    readFileSync("tests/fixtures/profile-v1.json", "utf8"),
  ) as Record<string, unknown>;
  assert.equal(profile.id, "0123456789abcdef0123456789abcdef");
  assert.equal(
    profile.avatarURL,
    "/api/v1/users/0123456789abcdef0123456789abcdef/avatar",
  );
  assert.equal("user" in profile, false);
});

test("the Shared Plans REST fixture uses live parsers and frozen mutation, replay, and pagination shapes", async () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/shared-plan-rest-v1.json", "utf8"),
  ) as {
    create: {
      plan: Record<string, unknown>;
      syncBootstrap: { document: string };
    };
    list: { items: unknown[]; nextCursor: null };
    preview: Record<string, unknown>;
    accept: { plan: Record<string, unknown> };
    members: {
      firstPage: FixturePage;
      nextPage: FixturePage;
      afterRevocation: FixturePage;
    };
    memberRevocation: FixtureMutation;
    memberReinstatement: FixtureMutation;
    ownershipTransfer: FixtureMutation;
    invitations: {
      listAsOwner: FixturePage;
      listAsEditor: FixturePage;
      create: {
        request: FixtureRequest;
        responseHTTPStatus: number;
        response: Record<string, unknown>;
        lostResponseReplayHTTPStatus: number;
        lostResponseReplay: Record<string, unknown>;
      };
      revoke: FixtureMutation;
    };
    errors: {
      ownerRequired: FixtureError;
      revisionConflict: FixtureError;
    };
  };
  assert.equal(fixture.create.plan.status, "active");
  assert.equal("archived" in fixture.create.plan, false);
  assert.equal("ownerUserID" in fixture.create.plan, false);
  assert.equal(fixture.list.nextCursor, null);
  assert.equal("invitation" in fixture.preview, false);
  assert.equal(fixture.accept.plan.role, "editor");
  assert.match(fixture.create.syncBootstrap.document, /^[A-Za-z0-9_-]+$/);

  const membersFirst = parseFixturePage(fixture.members.firstPage);
  assert.deepEqual(membersFirst, { limit: 1, cursor: null });
  const membersNext = parseFixturePage(fixture.members.nextPage);
  assert.equal(membersNext.limit, 1);
  assert.equal(
    membersNext.cursor,
    fixture.members.firstPage.response.nextCursor,
  );
  assert.equal(fixture.members.nextPage.response.nextCursor, null);
  const removedMember = fixture.members.afterRevocation.response.items.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "membershipStatus" in item &&
      item.membershipStatus === "removed",
  ) as Record<string, unknown> | undefined;
  assert.equal(removedMember?.userID, "00000000000000000000000000000002");
  assert.equal(removedMember?.removedAt, "2026-08-09T12:10:00.000Z");

  assert.deepEqual(
    parseMembershipMutation(fixture.memberRevocation.request.body),
    {
      requestID: "22222222-2222-4222-8222-222222222221",
      baseRevision: 1,
    },
  );
  assert.deepEqual(
    parseMembershipMutation(fixture.memberReinstatement.request.body),
    {
      requestID: "22222222-2222-4222-8222-222222222222",
      baseRevision: 2,
    },
  );
  assert.deepEqual(
    parseOwnershipTransfer(fixture.ownershipTransfer.request.body),
    {
      requestID: "33333333-3333-4333-8333-333333333331",
      baseRevision: 3,
      newOwnerUserID: "00000000000000000000000000000002",
    },
  );
  assert.deepEqual(
    parseInvitationCreate(fixture.invitations.create.request.body),
    {
      requestID: "44444444-4444-4444-8444-444444444441",
      baseRevision: 4,
      expiresAt: 1_786_882_380,
    },
  );
  assert.deepEqual(
    parseMembershipMutation(fixture.invitations.revoke.request.body),
    {
      requestID: "44444444-4444-4444-8444-444444444442",
      baseRevision: 5,
    },
  );

  for (const mutation of [
    fixture.memberRevocation,
    fixture.memberReinstatement,
    fixture.ownershipTransfer,
    fixture.invitations.revoke,
  ]) {
    assert.equal(mutation.response.receipt.replayed, false);
    assert.equal(mutation.exactReplayResponse.receipt.replayed, true);
    assert.deepEqual(mutation.exactReplayResponse.plan, mutation.response.plan);
    assert.deepEqual(
      omitReplayed(mutation.exactReplayResponse.receipt),
      omitReplayed(mutation.response.receipt),
    );
  }

  assert.equal(fixture.invitations.create.responseHTTPStatus, 201);
  assert.match(
    String(fixture.invitations.create.response.token),
    /^[A-Za-z0-9_-]{12}$/,
  );
  assert.equal("token" in fixture.invitations.create.lostResponseReplay, false);
  assert.deepEqual(fixture.invitations.create.lostResponseReplay.details, {
    invitationID: "55555555-5555-4555-8555-555555555555",
  });
  assert.deepEqual(
    fixture.invitations.listAsOwner.response.items.map(
      (item) => (item as Record<string, unknown>).currentUserCanRevoke,
    ),
    [true, true],
  );
  assert.deepEqual(
    fixture.invitations.listAsEditor.response.items.map(
      (item) => (item as Record<string, unknown>).currentUserCanRevoke,
    ),
    [true, false],
  );
  for (const page of [
    fixture.invitations.listAsOwner,
    fixture.invitations.listAsEditor,
  ]) {
    for (const item of page.response.items) {
      assert.equal("token" in (item as Record<string, unknown>), false);
      assert.match(
        String((item as Record<string, unknown>).createdByUserID),
        /^[0-9a-f]{32}$/,
      );
    }
  }
  assert.equal(fixture.errors.ownerRequired.httpStatus, 403);
  assert.equal(fixture.errors.revisionConflict.httpStatus, 409);
  assert.equal(
    fixture.errors.revisionConflict.response.error,
    "plan_revision_conflict",
  );

  const serialized = jsonResponse(
    fixture.invitations.create.response,
    fixture.invitations.create.responseHTTPStatus,
  );
  assert.equal(serialized.status, 201);
  assert.equal(serialized.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(
    await serialized.json(),
    fixture.invitations.create.response,
  );
});

interface FixtureRequest {
  method: string;
  path: string;
  body?: unknown;
}

interface FixturePage {
  request: FixtureRequest;
  response: { items: unknown[]; nextCursor: string | null };
}

interface FixtureMutation {
  request: FixtureRequest & { body: unknown };
  response: {
    plan: Record<string, unknown>;
    receipt: Record<string, unknown> & { replayed: boolean };
  };
  exactReplayResponse: {
    plan: Record<string, unknown>;
    receipt: Record<string, unknown> & { replayed: boolean };
  };
}

interface FixtureError {
  httpStatus: number;
  response: Record<string, unknown>;
}

function parseFixturePage(page: FixturePage) {
  return parseCollectionPage(
    new Request(`https://cominavi.net${page.request.path}`),
  );
}

function omitReplayed(receipt: Record<string, unknown>) {
  const { replayed: _, ...rest } = receipt;
  return rest;
}

test("the notification inbox fixture freezes typed list and bodyless read DTOs", () => {
  const fixtureBytes = readFileSync(
    "tests/fixtures/notification-inbox-v1.json",
    "utf8",
  );
  assert.equal(
    fixtureBytes,
    readFileSync(
      "../meta/fixtures/shared-plans/notification-inbox-v1.json",
      "utf8",
    ),
  );
  assert.equal(
    createHash("sha256").update(fixtureBytes).digest("hex"),
    "beb160007a9422d8e2f0e2ddbde4ede1cefe466de56cae3260a928130478f723",
  );
  const fixture = JSON.parse(fixtureBytes) as {
    list: {
      request: { method: string; path: string };
      response: {
        items: Array<Record<string, unknown>>;
        nextCursor: string;
      };
    };
    read: {
      request: { method: string; path: string; body: null };
      response: Record<string, unknown>;
      exactReplayResponse: Record<string, unknown>;
    };
  };
  assert.equal(fixture.list.request.method, "GET");
  assert.match(fixture.list.request.path, /\?limit=2$/);
  assert.match(fixture.list.response.nextCursor, /^[A-Za-z0-9_-]+$/);
  for (const item of fixture.list.response.items) {
    assert.deepEqual(Object.keys(item), [
      "id",
      "kind",
      "planID",
      "eventType",
      "i18nKey",
      "payloadVersion",
      "payload",
      "createdAt",
      "readAt",
    ]);
    assert.equal(item.kind, "sharedPlanEvent");
    assert.equal(typeof item.payload, "object");
    assert.equal("message" in item, false);
  }
  assert.equal(fixture.read.request.method, "PUT");
  assert.equal(fixture.read.request.body, null);
  assert.deepEqual(fixture.read.exactReplayResponse, fixture.read.response);
});

test("AASA is direct JSON for every supported app and deliberate entry path", async () => {
  const response = await getAppleAssociation({} as never);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.headers.get("Location"), null);
  const body = (await response.json()) as {
    applinks: { details: Array<{ appID: string; paths: string[] }> };
    webcredentials: { apps: string[] };
  };
  assert.deepEqual(
    body.applinks.details.map((detail) => detail.appID),
    [
      "F25GFFJL49.llc.mikunet.cominavi",
      "F25GFFJL49.llc.mikunet.cominavi.staging",
      "F25GFFJL49.llc.mikunet.cominavi.debug",
    ],
  );
  assert.deepEqual(body.applinks.details[0]?.paths, [
    "/join/*",
    "/auth/google",
    "/auth/apple",
  ]);
  assert.deepEqual(body.webcredentials.apps, [
    "F25GFFJL49.llc.mikunet.cominavi",
  ]);
});

test("dynamic app and API routes run before the static asset edge", () => {
  const source = readFileSync("wrangler.jsonc", "utf8");
  const routes = source.match(/"run_worker_first"\s*:\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(routes, "run_worker_first routes");
  assert.deepEqual(
    Array.from(routes.matchAll(/"([^"]+)"/g), (match) => match[1]),
    ["/.well-known/*", "/api/*", "/auth/*", "/join/*", "/oauth/*"],
  );
});

test("join capabilities are crawlable but never cached, referred, or indexed", () => {
  const source = readFileSync("src/pages/join/[token].astro", "utf8");
  const robots = readFileSync("public/robots.txt", "utf8");
  assert.match(source, /Cache-Control", "no-store/);
  assert.match(source, /Referrer-Policy", "no-referrer/);
  assert.match(source, /X-Robots-Tag", "noindex, nofollow, noarchive/);
  assert.match(robots, /^User-agent:\s*\*\s*$/m);
  assert.doesNotMatch(robots, /^Disallow:\s*\/join(?:\/|\s*$)/m);
  assert.match(source, /invitation\.expiresAt/);
  assert.match(source, /invitation\.inviter\.displayName/);
  assert.match(source, /invitation\.inviter\.avatarURL/);
  assert.match(source, /class="invite-title__plan"/);
  assert.match(source, /class="invite-title__action">に参加/);
  assert.doesNotMatch(source, /「\{invitation\.planName\}」/);
});

test("join page sends beta testers to the current TestFlight build", () => {
  const pageSource = readFileSync("src/pages/join/[token].astro", "utf8");
  const homeSource = readFileSync("src/pages/index.astro", "utf8");
  const homeComponentSource = readFileSync(
    "src/components/pages/HomePage.tsx",
    "utf8",
  );
  const wranglerSource = readFileSync("wrangler.jsonc", "utf8");
  assert.match(pageSource, /env\.COMINAVI_TESTFLIGHT_URL/);
  assert.match(homeSource, /env\.COMINAVI_TESTFLIGHT_URL/);
  assert.match(homeComponentSource, /href=\{testFlightURL\}/);
  assert.match(homeComponentSource, /TestFlight で試す/);
  assert.match(pageSource, /TestFlight で試す/);
  assert.match(pageSource, /TestFlight を開く/);
  assert.doesNotMatch(
    `${homeSource}\n${homeComponentSource}\n${pageSource}`,
    /App Store/,
  );
  assert.match(
    wranglerSource,
    /"COMINAVI_TESTFLIGHT_URL": "https:\/\/testflight\.apple\.com\/join\/HrDC1xuC"/,
  );
});

test("provider auth fixture freezes parser-valid Circle, logout, and Apple request DTOs", () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/auth-providers-v1.json", "utf8"),
  ) as {
    circlems: {
      startRequest: Record<string, unknown>;
      callbackSuccess: string;
      authCompleteResponse: Record<string, unknown>;
    };
    apple: {
      specialEntryURL: string;
      entryGrantRequest: { nonce: string; inviteToken: string };
      entryGrantResponse: { entryGrant: string; expiresAt: string };
      entryCallback: string;
      request: Record<string, unknown> & {
        requestId: string;
        entryGrant: string;
        nonce: string;
      };
    };
    logout: {
      request: Record<string, unknown>;
      response: { receipt: Record<string, unknown> };
    };
    accountDeletion: {
      request: Record<string, unknown>;
      acceptedResponse: Record<string, unknown>;
    };
  };
  assert.equal(
    fixture.circlems.startRequest.clientInstanceID !== undefined,
    true,
  );
  assert.equal("state" in fixture.circlems.startRequest, false);
  assert.match(
    fixture.circlems.callbackSuccess,
    /^cominavi:\/\/oauth\/circlems\/landing\?status=succeeded&completionCode=/,
  );
  assert.equal("access_token" in fixture.circlems.authCompleteResponse, false);
  assert.equal(fixture.circlems.authCompleteResponse.authVersion, 1);
  assert.deepEqual(Object.keys(fixture.logout.request), [
    "requestId",
    "refreshToken",
  ]);
  assert.deepEqual(fixture.logout.response.receipt, {
    requestId: "66666666-6666-4666-8666-666666666666",
    replayed: false,
    authVersion: 2,
  });
  assert.deepEqual(parseLogoutRequest(fixture.logout.request), {
    requestID: "66666666-6666-4666-8666-666666666666",
    refreshToken: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
  });
  assert.equal(
    parseCanonicalRequestID(fixture.apple.request.requestId),
    fixture.apple.request.requestId,
  );
  assert.equal(
    validateAppleNonce(fixture.apple.entryGrantRequest.nonce),
    fixture.apple.request.nonce,
  );
  assert.match(
    fixture.apple.entryGrantRequest.inviteToken,
    /^[A-Za-z0-9_-]{12}$/,
  );
  assert.match(
    fixture.apple.entryGrantResponse.entryGrant,
    /^[A-Za-z0-9_-]{43}$/,
  );
  assert.equal(
    fixture.apple.entryGrantResponse.entryGrant,
    fixture.apple.request.entryGrant,
  );
  assert.equal(fixture.apple.request.authorizationCode !== undefined, true);
  assert.deepEqual(parseAccountDeletion(fixture.accountDeletion.request), {
    requestID: "55555555-5555-4555-8555-555555555555",
    confirmation: "DELETE",
  });
  assert.equal(
    fixture.accountDeletion.acceptedResponse.status,
    "deletion_pending",
  );
});

test("Apple entry callback and full session replay DTOs match the route serializers", async () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/auth-providers-v1.json", "utf8"),
  ) as {
    apple: {
      specialEntryURL: string;
      entryGrantRequest: { nonce: string };
      entryGrantResponse: { entryGrant: string; expiresAt: string };
      entryCallback: string;
      authResponse: Record<string, unknown> & {
        refreshToken: string;
        user: { identities: Array<Record<string, unknown>> };
      };
      exactReplayResponse: Record<string, unknown>;
    };
  };
  assert.deepEqual(Object.keys(fixture.apple.authResponse), [
    "tokenType",
    "authVersion",
    "accessToken",
    "expiresAt",
    "refreshToken",
    "refreshExpiresAt",
    "user",
  ]);
  assert.match(fixture.apple.authResponse.refreshToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(fixture.apple.authResponse.user.identities, [
    {
      provider: "apple",
      email: "private-user@privaterelay.appleid.com",
    },
  ]);
  assert.equal("credentialReceipt" in fixture.apple.authResponse, false);
  assert.deepEqual(
    fixture.apple.exactReplayResponse,
    fixture.apple.authResponse,
    "exact Apple replay returns the same immutable session, without a second code exchange",
  );

  const specialEntry = new URL(fixture.apple.specialEntryURL);
  assert.equal(specialEntry.pathname, "/auth/apple");
  assert.equal(
    specialEntry.searchParams.get("nonce"),
    fixture.apple.entryGrantRequest.nonce,
  );
  const callback = new URL(fixture.apple.entryCallback);
  assert.equal(callback.protocol, "cominavi:");
  assert.equal(callback.host, "auth");
  assert.equal(callback.pathname, "/apple/grant");
  assert.equal(
    callback.searchParams.get("entryGrant"),
    fixture.apple.entryGrantResponse.entryGrant,
  );
  assert.equal(
    callback.searchParams.get("expiresAt"),
    fixture.apple.entryGrantResponse.expiresAt,
  );
  assert.equal(
    callback.searchParams.get("nonce"),
    fixture.apple.entryGrantRequest.nonce,
  );

  const serialized = jsonResponse(fixture.apple.authResponse);
  assert.equal(serialized.status, 200);
  assert.equal(serialized.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await serialized.json(), fixture.apple.authResponse);
  const document = await generateOpenAPIDocument();
  const authentication = document.paths?.["/api/v2/auth/apple"]?.post;
  assert.equal(authentication?.operationId, "authenticateWithApple");
  assert.deepEqual(authentication?.security, []);
  assert.ok(authentication?.responses?.["200"]);
  const entryGrant = document.paths?.["/api/v2/auth/apple/entry-grant"]?.post;
  assert.equal(entryGrant?.operationId, "issueAppleAuthenticationEntryGrant");
  assert.deepEqual(entryGrant?.security, []);
  assert.ok(entryGrant?.responses?.["200"]);
  const callbackRoute = readFileSync("src/pages/auth/apple.ts", "utf8");
  for (const field of ["entryGrant", "expiresAt", "nonce"])
    assert.match(callbackRoute, new RegExp(`searchParams\\.set\\("${field}"`));
});

test("account deletion first execution and lost-response replay are identical 202 DTOs", async () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/auth-providers-v1.json", "utf8"),
  ) as {
    accountDeletion: {
      acceptedHTTPStatus: number;
      acceptedResponse: Record<string, unknown>;
      exactReplayHTTPStatus: number;
      exactReplayResponse: Record<string, unknown>;
    };
  };
  assert.equal(fixture.accountDeletion.acceptedHTTPStatus, 202);
  assert.equal(fixture.accountDeletion.exactReplayHTTPStatus, 202);
  assert.deepEqual(
    fixture.accountDeletion.exactReplayResponse,
    fixture.accountDeletion.acceptedResponse,
  );
  assert.deepEqual(Object.keys(fixture.accountDeletion.acceptedResponse), [
    "status",
    "requestId",
    "deletedOwnedPlanIDs",
  ]);
  const serialized = jsonResponse(
    fixture.accountDeletion.acceptedResponse,
    fixture.accountDeletion.acceptedHTTPStatus,
  );
  assert.equal(serialized.status, 202);
  assert.deepEqual(
    await serialized.json(),
    fixture.accountDeletion.acceptedResponse,
  );
  const document = await generateOpenAPIDocument();
  const operation = document.paths?.["/api/v2/me"]?.delete;
  assert.equal(operation?.operationId, "deleteCurrentUserAccount");
  assert.deepEqual(operation?.security, [{ bearerAuth: [] }]);
  assert.ok(operation?.responses?.["202"]);
});
