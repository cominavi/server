import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  handleEntryPageGET,
  handleEntryPagePOST,
} from "../../lib/server/sign-in-entry-page";

export const prerender = false;

// Response headers include "Cache-Control: no-store" (sign-in-entry-page.ts).
export const GET: APIRoute = ({ request }) =>
  handleEntryPageGET("google", request, env);

export const POST: APIRoute = ({ request }) =>
  handleEntryPagePOST("google", request, env);
