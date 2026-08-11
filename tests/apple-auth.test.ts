import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateApple,
  exchangeAppleAuthorizationCode,
  revokeAppleRefreshToken,
} from "../src/lib/server/apple-auth";
import { base64URL, sha256Hex } from "../src/lib/server/auth-sessions";

test("Apple JWT nonce/audience verification, code exchange, and revocation use exact provider contracts", async () => {
  const now = 100_000;
  const nonce = "n".repeat(43);
  const rsa = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const identityToken = await signedJWT(
    { alg: "RS256", kid: "apple-rsa-key" },
    {
      iss: "https://appleid.apple.com",
      aud: "llc.mikunet.cominavi",
      sub: "apple.subject.fixture",
      iat: 99,
      exp: 200,
      nonce: await sha256Hex(nonce),
      email: "relay@privaterelay.appleid.com",
      email_verified: "true",
    },
    rsa.privateKey,
    { name: "RSASSA-PKCS1-v1_5" },
  );
  const ec = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const bindings = {
    COMINAVI_APPLE_CLIENT_IDS: "llc.mikunet.cominavi",
    COMINAVI_APPLE_TEAM_ID: "F25GFFJL49",
    COMINAVI_APPLE_KEY_ID: "APPLEKEY1",
    COMINAVI_APPLE_PRIVATE_KEY_P8_BASE64URL: base64URL(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", ec.privateKey)),
    ),
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/auth/keys") {
      return Response.json(
        {
          keys: [
            {
              ...(await crypto.subtle.exportKey("jwk", rsa.publicKey)),
              kid: "apple-rsa-key",
            },
          ],
        },
        { headers: { "Cache-Control": "public, max-age=300" } },
      );
    }
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("client_id"), "llc.mikunet.cominavi");
    assert.equal(form.get("client_secret")?.split(".").length, 3);
    if (url.pathname === "/auth/token") {
      assert.equal(form.get("code"), "single-use-code");
      assert.equal(form.get("grant_type"), "authorization_code");
      return Response.json({
        refresh_token: "apple-refresh",
        id_token: identityToken,
      });
    }
    assert.equal(url.pathname, "/auth/revoke");
    assert.equal(form.get("token"), "apple-refresh");
    assert.equal(form.get("token_type_hint"), "refresh_token");
    return new Response(null, { status: 200 });
  };
  const identity = await authenticateApple(
    identityToken,
    bindings,
    nonce,
    now,
    fetcher,
  );
  assert.deepEqual(identity, {
    provider: "apple",
    environment: "",
    subject: "apple.subject.fixture",
    clientID: "llc.mikunet.cominavi",
    issuedAt: 99,
    email: "relay@privaterelay.appleid.com",
  });
  await assert.rejects(
    authenticateApple(identityToken, bindings, "x".repeat(43), now, fetcher),
  );
  assert.deepEqual(
    await exchangeAppleAuthorizationCode(
      "single-use-code",
      identity,
      nonce,
      bindings,
      now,
      fetcher,
    ),
    { refreshToken: "apple-refresh", clientID: "llc.mikunet.cominavi" },
  );
  await revokeAppleRefreshToken(
    "apple-refresh",
    identity.clientID,
    bindings,
    now,
    fetcher,
  );
  assert.deepEqual(calls, ["/auth/keys", "/auth/token", "/auth/revoke"]);
});

async function signedJWT(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams,
): Promise<string> {
  const encodedHeader = base64URL(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const encodedPayload = base64URL(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const value = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    algorithm,
    privateKey,
    new TextEncoder().encode(value),
  );
  return `${value}.${base64URL(new Uint8Array(signature))}`;
}
