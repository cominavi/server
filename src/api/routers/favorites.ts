import { z } from "zod";
import {
  loadFavoriteSnapshot,
  parseEventNumber,
  parseFavoriteSnapshotBody,
  replaceFavoriteSnapshot,
} from "../../lib/server/favorites";
import { loadCirclemsFavoriteImportPage } from "../../lib/server/circlems-favorite-import";
import { syncFavoritesToCirclems } from "../../lib/server/circlems-favorite-sync";
import { authenticatedProcedure } from "../core";

const eventNumberSchema = z.coerce.number().int().positive().max(10_000);

const favoriteSchema = z.object({
  wcID: z.number().int().positive(),
  color: z.number().int().min(0).max(9),
  notificationsEnabled: z.boolean(),
});

const favoriteSnapshotSchema = z.object({
  eventNumber: eventNumberSchema,
  revision: z.number().int().nonnegative(),
  favorites: z.array(favoriteSchema).max(30_000),
});

const favoritePathSchema = z.object({ eventNumber: eventNumberSchema });

const circlemsFavoriteImportPageSchema = z.object({
  eventNumber: eventNumberSchema,
  items: z.array(
    z.object({
      wcID: z.number().int().positive(),
      updateID: z.number().int().positive(),
      circleName: z.string().max(200),
      color: z.number().int().min(0).max(9),
      memo: z.string().max(65_536),
    }),
  ),
  nextCursor: z.string().min(1).optional(),
});

const circlemsFavoriteSyncResultSchema = z.object({
  eventNumber: eventNumberSchema,
  revision: z.number().int().nonnegative(),
  favoriteCount: z.number().int().nonnegative(),
  addedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  skippedMemoOnlyCount: z.number().int().nonnegative(),
});

export const getFavoriteSnapshot = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/me/favorites/{eventNumber}",
    operationId: "getFavoriteSnapshot",
    summary: "Get favorite snapshot",
    description:
      "Returns the authenticated user's canonical favorites and revision from one database snapshot.",
    tags: ["Favorites"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: favoritePathSchema }))
  .output(favoriteSnapshotSchema)
  .handler(({ context, input }) =>
    loadFavoriteSnapshot(
      context.env.COMINAVI_DB,
      context.identity,
      parseEventNumber(String(input.params.eventNumber)),
    ),
  );

export const replaceFavoriteSnapshotOperation = authenticatedProcedure
  .route({
    method: "PUT",
    path: "/api/v2/me/favorites/{eventNumber}",
    operationId: "replaceFavoriteSnapshot",
    summary: "Replace favorite snapshot",
    description:
      "Atomically replaces canonical favorites using revision and request-ID idempotency fences.",
    tags: ["Favorites"],
    inputStructure: "detailed",
  })
  .input(
    z.object({
      params: favoritePathSchema,
      body: z.object({
        baseRevision: z.number().int().nonnegative(),
        mutationID: z.uuid(),
        favorites: z.array(favoriteSchema).max(30_000),
      }),
    }),
  )
  .output(favoriteSnapshotSchema)
  .handler(({ context, input }) =>
    replaceFavoriteSnapshot(
      context.env.COMINAVI_DB,
      context.identity,
      parseEventNumber(String(input.params.eventNumber)),
      parseFavoriteSnapshotBody(input.body),
    ),
  );

export const listCirclemsFavoriteImport = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/me/circlems-favorites/{eventNumber}",
    operationId: "listCirclemsFavoriteImport",
    summary: "List Circle.ms favorites for import",
    description:
      "Loads one backend-authorized Circle.ms favorite page without exposing provider credentials to the client.",
    tags: ["Favorites"],
    inputStructure: "detailed",
  })
  .input(
    z.object({
      params: favoritePathSchema,
      query: z.object({ cursor: z.string().min(1).max(256).optional() }),
    }),
  )
  .output(circlemsFavoriteImportPageSchema)
  .handler(async ({ context, input }) => {
    const result = await loadCirclemsFavoriteImportPage(
      context.env,
      context.identity,
      parseEventNumber(String(input.params.eventNumber)),
      input.query.cursor ?? null,
    );
    return {
      ...result,
      nextCursor: result.nextCursor ?? undefined,
    };
  });

export const syncCirclemsFavorites = authenticatedProcedure
  .route({
    method: "POST",
    path: "/api/v2/me/circlems-favorites/{eventNumber}/sync",
    operationId: "syncCirclemsFavorites",
    summary: "Sync ComiNavi favorites to Circle.ms",
    description:
      "Adds or updates the current canonical ComiNavi favorites in the linked Circle.ms account without deleting unrelated provider favorites or overwriting provider memos.",
    tags: ["Favorites"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: favoritePathSchema }))
  .output(circlemsFavoriteSyncResultSchema)
  .handler(({ context, input }) =>
    syncFavoritesToCirclems(
      context.env,
      context.identity,
      parseEventNumber(String(input.params.eventNumber)),
    ),
  );

export const favoritesRouter = {
  get: getFavoriteSnapshot,
  replace: replaceFavoriteSnapshotOperation,
  circlemsImport: listCirclemsFavoriteImport,
  circlemsSync: syncCirclemsFavorites,
};
