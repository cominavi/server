import type { APIRoute } from "astro";

export const prerender = false;

const appIDs = [
  "F25GFFJL49.llc.mikunet.cominavi",
  "F25GFFJL49.llc.mikunet.cominavi.staging",
  "F25GFFJL49.llc.mikunet.cominavi.debug",
];

export const GET: APIRoute = async () =>
  new Response(
    JSON.stringify({
      applinks: {
        apps: [],
        details: appIDs.map((appID) => ({
          appID,
          paths: ["/join/*", "/auth/google", "/auth/apple"],
        })),
      },
      webcredentials: {
        apps: ["F25GFFJL49.llc.mikunet.cominavi"],
      },
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
