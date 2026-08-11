import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { finishCirclemsOAuthCallback } from "../../../lib/server/circlems-oauth-flow";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) {
    return callbackRedirect(false);
  }
  try {
    const completionCode = await finishCirclemsOAuthCallback(env, state, code);
    return callbackRedirect(true, completionCode);
  } catch {
    return callbackRedirect(false);
  }
};

function callbackRedirect(
  succeeded: boolean,
  completionCode?: string,
): Response {
  const target = new URL("cominavi://oauth/circlems/landing");
  target.searchParams.set("status", succeeded ? "succeeded" : "failed");
  if (succeeded && completionCode) {
    target.searchParams.set("completionCode", completionCode);
  } else {
    target.searchParams.set("error", "authorization_failed");
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: target.toString(),
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
