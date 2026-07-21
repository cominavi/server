import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { exchangeCirclemsToken } from "../../../../../lib/server/circlems-oauth";

export const prerender = false;

function isRefreshTokenRequest(
  value: unknown,
): value is { refresh_token: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "refresh_token" in value &&
    typeof value.refresh_token === "string" &&
    value.refresh_token.length > 0
  );
}

export const POST: APIRoute = async ({ request }) => {
  const body: unknown = await request.json();
  if (!isRefreshTokenRequest(body)) {
    return Response.json(
      {
        error: "refresh_token is required",
      },
      { status: 400 },
    );
  }
  const { refresh_token } = body;

  const result = await exchangeCirclemsToken(
    {
      grant_type: "refresh_token",
      refresh_token,
    },
    env,
  );

  if (result.ok) {
    return Response.json({
      status: "succeeded",
      token_type: result.token.token_type,
      access_token: result.token.access_token,
      expires_in: result.token.expires_in,
      refresh_token: result.token.refresh_token,
    });
  }

  const externalError = result.failures
    .slice()
    .reverse()
    .find((failure) => failure.oauthError)?.oauthError;
  return Response.json(
    {
      status: "failed",
      error: "authorization_code_error",
      external_error: externalError?.error,
      external_error_description: externalError?.error_description,
      external_error_uri: externalError?.error_uri,
    },
    { status: 400 },
  );
};
