import { z } from "zod";
import { parseEventNumber } from "../../lib/server/favorites";
import { loadRealtimeUpdates } from "../../lib/server/realtime-api";
import { authenticatedProcedure } from "../core";

const eventNumberSchema = z.coerce.number().int().positive().max(10_000);
const wcIDSchema = z.coerce.number().int().positive();
const wcIDQuerySchema = z.preprocess((value) => {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) =>
    typeof item === "string" ? item.split(",").filter(Boolean) : [item],
  );
}, z.array(wcIDSchema).max(500));

const realtimeMediaSchema = z.object({
  key: z.string().min(1).max(500),
  type: z.string().max(64),
  role: z.enum(["shinagaki", "cover", "post_image"]),
  url: z.url(),
  previewURL: z.url().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  palette: z.unknown().optional(),
  payloadSHA256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

const realtimeCircleSchema = z.object({
  eventNumber: z.number().int().positive().max(10_000),
  wcID: z.number().int().positive(),
  circleID: z.number().int().positive().optional(),
  circleName: z.string().max(1_000),
  day: z.number().int().positive().optional(),
  areaName: z.string().optional(),
  blockName: z.string().optional(),
  spaceNo: z.number().int().positive().optional(),
  spaceNoSub: z.number().int().optional(),
  location: z.string().optional(),
});

const realtimeUpdateSchema = z.object({
  cursor: z.number().int().positive(),
  eventKey: z.string().min(1),
  updateKind: z.string().min(1),
  stateKind: z.enum([
    "attendance",
    "inventory",
    "presence",
    "shinagaki",
    "cover",
  ]),
  stateValue: z.string().min(1),
  confidence: z.enum(["high", "medium", "low", "unmatched"]),
  occurredAt: z.iso.datetime(),
  sourceRevision: z.number().int().positive(),
  post: z.object({
    id: z.string().min(1),
    url: z.url().optional(),
    text: z.string().max(100_000),
    author: z.object({
      xUserID: z.string().min(1).optional(),
      handle: z.string().min(1).max(15),
      name: z.string().max(500).optional(),
      profileImageURL: z.url().optional(),
    }),
    media: z.array(realtimeMediaSchema).max(20),
  }),
  circles: z.array(realtimeCircleSchema).max(20),
});

const realtimePageSchema = z.object({
  eventNumber: z.number().int().positive().max(10_000),
  updates: z.array(realtimeUpdateSchema).max(500),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  serverTime: z.iso.datetime(),
});

interface RawRealtimeMedia {
  key: string;
  type: string;
  role: "shinagaki" | "cover" | "post_image";
  url: string;
  previewURL: string | null;
  width: number | null;
  height: number | null;
  palette: unknown;
  payloadSHA256: string | null;
}

interface RawRealtimeCircle {
  eventNumber: number;
  wcID: number;
  circleID: number | null;
  circleName: string;
  day: number | null;
  areaName: string | null;
  blockName: string | null;
  spaceNo: number | null;
  spaceNoSub: number | null;
  location: string | null;
}

interface RawRealtimeUpdate {
  cursor: number;
  eventKey: string;
  updateKind: string;
  stateKind: "attendance" | "inventory" | "presence" | "shinagaki" | "cover";
  stateValue: string;
  confidence: "high" | "medium" | "low" | "unmatched";
  occurredAt: string;
  sourceRevision: number;
  post: {
    id: string;
    url: string | null;
    text: string;
    author: {
      xUserID: string | null;
      handle: string;
      name: string | null;
      profileImageURL: string | null;
    };
    media: RawRealtimeMedia[];
  };
  circles: RawRealtimeCircle[];
}

export const listRealtimeUpdates = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/events/{eventNumber}/updates",
    operationId: "listRealtimeUpdates",
    summary: "List realtime event updates",
    description:
      "Returns a stable cursor page of realtime circle updates for one Comiket. The optional WCID filter accepts at most 500 entries, deduplicates them, and each page contains at most 500 updates.",
    tags: ["Realtime"],
    inputStructure: "detailed",
  })
  .input(
    z.object({
      params: z.object({ eventNumber: eventNumberSchema }),
      query: z.object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        wcID: wcIDQuerySchema.optional(),
      }),
    }),
  )
  .output(realtimePageSchema)
  .handler(async ({ context, input }) => {
    const eventNumber = parseEventNumber(String(input.params.eventNumber));
    const result = await loadRealtimeUpdates(
      context.env.COMINAVI_DB,
      eventNumber,
      {
        after: input.query.after,
        limit: input.query.limit,
        wcIDs: Array.from(new Set(input.query.wcID ?? [])).sort(
          (left, right) => left - right,
        ),
      },
    );
    return {
      ...result,
      updates: (result.updates as RawRealtimeUpdate[]).map(normalizeUpdate),
    };
  });

export const realtimeUpdatesRouter = {
  list: listRealtimeUpdates,
};

function normalizeUpdate(update: RawRealtimeUpdate) {
  return {
    ...update,
    post: {
      id: update.post.id,
      ...(update.post.url === null ? {} : { url: update.post.url }),
      text: update.post.text,
      author: {
        ...(update.post.author.xUserID === null
          ? {}
          : { xUserID: update.post.author.xUserID }),
        handle: update.post.author.handle,
        ...(update.post.author.name === null
          ? {}
          : { name: update.post.author.name }),
        ...(update.post.author.profileImageURL === null
          ? {}
          : { profileImageURL: update.post.author.profileImageURL }),
      },
      media: update.post.media.map((media) => ({
        key: media.key,
        type: media.type,
        role: media.role,
        url: media.url,
        ...(media.previewURL === null ? {} : { previewURL: media.previewURL }),
        ...(media.width === null ? {} : { width: media.width }),
        ...(media.height === null ? {} : { height: media.height }),
        ...(media.palette === null ? {} : { palette: media.palette }),
        ...(media.payloadSHA256 === null
          ? {}
          : { payloadSHA256: media.payloadSHA256 }),
      })),
    },
    circles: update.circles.map((circle) => ({
      eventNumber: circle.eventNumber,
      wcID: circle.wcID,
      ...(circle.circleID === null ? {} : { circleID: circle.circleID }),
      circleName: circle.circleName,
      ...(circle.day === null ? {} : { day: circle.day }),
      ...(circle.areaName === null ? {} : { areaName: circle.areaName }),
      ...(circle.blockName === null ? {} : { blockName: circle.blockName }),
      ...(circle.spaceNo === null ? {} : { spaceNo: circle.spaceNo }),
      ...(circle.spaceNoSub === null ? {} : { spaceNoSub: circle.spaceNoSub }),
      ...(circle.location === null ? {} : { location: circle.location }),
    })),
  };
}
