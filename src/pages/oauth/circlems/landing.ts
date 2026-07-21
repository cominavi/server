import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { exchangeCirclemsToken } from "../../../lib/server/circlems-oauth";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) {
    return Response.redirect(
      "cominavi://oauth/circlems/landing?status=failed&error=invalid_request_missing_code_or_state",
      307,
    );
  }

  const result = await exchangeCirclemsToken(
    {
      grant_type: "authorization_code",
      code,
    },
    env,
  );

  if (result.ok) {
    const s = new URLSearchParams();
    s.set("status", "succeeded");
    s.set("state", state); // Pass the state back to the app
    s.set("token_type", result.token.token_type);
    s.set("access_token", result.token.access_token);
    s.set("expires_in", `${result.token.expires_in}`);
    s.set("refresh_token", result.token.refresh_token);
    return Response.redirect(
      `cominavi://oauth/circlems/landing?${s.toString()}`,
      307,
    );
  }

  const externalError = result.failures
    .slice()
    .reverse()
    .find((failure) => failure.oauthError)?.oauthError;
  const s = new URLSearchParams({
    status: "failed",
    state,
    error: "authorization_code_error",
  });
  if (externalError) {
    s.set("external_error", externalError.error);
    if (externalError.error_description) {
      s.set("external_error_description", externalError.error_description);
    }
    if (externalError.error_uri) {
      s.set("external_error_uri", externalError.error_uri);
    }
  }
  return Response.redirect(
    `cominavi://oauth/circlems/landing?${s.toString()}`,
    307,
  );
};
