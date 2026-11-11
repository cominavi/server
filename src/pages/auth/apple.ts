import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  handleEntryPageGET,
  handleEntryPagePOST,
} from "../../lib/server/sign-in-entry-page";

export const prerender = false;

export const GET: APIRoute = ({ request }) =>
  handleEntryPageGET("apple", request, env);

export const POST: APIRoute = ({ request }) =>
  handleEntryPagePOST("apple", request, env);
