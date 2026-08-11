import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { loadInvitationInviterAvatar } from "../../../lib/server/shared-plans";

export const prerender = false;

const unavailableHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

export const GET: APIRoute = async ({ params, request }) => {
  const token = params.token ?? "";
  const key = request.headers.get("CF-Connecting-IP") ?? "local";
  if (!(await env.COMINAVI_INVITE_RATE_LIMITER.limit({ key })).success) {
    return new Response(null, { status: 429, headers: unavailableHeaders });
  }
  try {
    return await loadInvitationInviterAvatar(
      env.COMINAVI_DB,
      env.COMINAVI_AVATARS,
      token,
      env.COMINAVI_INVITE_TOKEN_SECRET,
    );
  } catch {
    return new Response(null, { status: 404, headers: unavailableHeaders });
  }
};
