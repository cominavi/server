import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  issueAppleEntryGrant,
  validateAppleNonce,
} from "../../lib/server/apple-entry-grants";
import { ServiceError } from "../../lib/server/service-error";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const key = request.headers.get("CF-Connecting-IP") ?? "local";
    if (!(await env.COMINAVI_INVITE_RATE_LIMITER.limit({ key })).success) {
      throw new ServiceError("rate_limited", 429, "Too many entry attempts.");
    }
    const nonce = validateAppleNonce(
      new URL(request.url).searchParams.get("nonce"),
    );
    const grant = await issueAppleEntryGrant(env.COMINAVI_DB, nonce);
    const callback = new URL("cominavi://auth/apple/grant");
    callback.searchParams.set("entryGrant", grant.entryGrant);
    callback.searchParams.set("expiresAt", grant.expiresAt);
    callback.searchParams.set("nonce", nonce);
    return redirectWithoutStorage(callback.toString());
  } catch {
    return redirectWithoutStorage("/");
  }
};

function redirectWithoutStorage(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
