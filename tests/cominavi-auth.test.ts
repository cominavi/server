import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthenticationError,
  authenticateCirclems,
  issueCominaviJWT,
  verifyCominaviJWT,
  type CominaviAuthBindings,
  type CominaviIdentity,
} from "../src/lib/server/cominavi-auth";

const secret = "a-development-only-secret-that-is-long-enough";
const identity: CominaviIdentity = {
  subject: "0123456789abcdef0123456789abcdef",
  userID: 7,
  authVersion: 1,
};

test("ComiNavi JWT carries only provider-neutral public identity and auth epoch", async () => {
  const issued = await issueCominaviJWT(identity, secret, 1_000_000);
  const verified = await verifyCominaviJWT(issued.token, secret, 1_001_000);
  assert.deepEqual(verified, {
    subject: identity.subject,
    authVersion: identity.authVersion,
  });
  const claims = JSON.parse(
    Buffer.from(issued.token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(claims.sub, identity.subject);
  assert.equal("user_id" in claims, false);
  assert.equal(
    issued.expiresAt,
    new Date((1_000 + 15 * 60) * 1_000).toISOString(),
  );
});

test("ComiNavi JWT rejects tampering and expiration", async () => {
  const issued = await issueCominaviJWT(identity, secret, 1_000_000);
  await assert.rejects(
    verifyCominaviJWT(`${issued.token.slice(0, -1)}x`, secret, 1_001_000),
    (error: unknown) =>
      error instanceof AuthenticationError && error.code === "invalid_token",
  );
  await assert.rejects(
    verifyCominaviJWT(issued.token, secret, 1_901_000),
    (error: unknown) =>
      error instanceof AuthenticationError && error.code === "expired_token",
  );
});

test("Circle.ms authentication validates the bearer token against User Info", async () => {
  const bindings: CominaviAuthBindings = {
    COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: "https://api1.circle.ms",
    COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: "https://api1-sandbox.circle.ms",
    COMINAVI_JWT_SECRET: secret,
  };
  let request: Request | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      status: "success",
      response: { pid: "42", nickname: "Galvin" },
    });
  };

  const result = await authenticateCirclems(
    "circle-token",
    "production",
    bindings,
    fetcher,
  );
  assert.equal(request?.url, "https://api1.circle.ms/User/Info");
  assert.equal(request?.headers.get("Authorization"), "Bearer circle-token");
  assert.deepEqual(result, {
    subject: "circlems:production:42",
    circlemsEnvironment: "production",
    circlemsUserID: 42,
    nickname: "Galvin",
  });
});
