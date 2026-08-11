import { z } from "zod";
import {
  type CatalogIndexItemV1,
  listPublishedCatalogs,
  loadPublishedCatalog,
} from "../../lib/server/catalogs";
import { serveCatalogArtifact } from "../../lib/server/catalog-download";
import { ServiceError } from "../../lib/server/service-error";
import { authenticatedProcedure, serviceErrorDataSchema } from "../core";

const catalogContentType = "application/vnd.cominavi.catalog-v1+sqlite";
const catalogVersionIDSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._-]+$/);
const comiketNoSchema = z.coerce.number().int().positive().max(10_000);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const catalogManifestSchema = z.object({
  schemaVersion: z.literal(1),
  versionID: catalogVersionIDSchema,
  comiketNo: comiketNoSchema,
  name: z.string().min(1),
  publishedAt: z.number().int().nonnegative(),
  sourceUpdatedAt: z.number().int().nonnegative().optional(),
  artifact: z.object({
    url: z
      .string()
      .regex(
        /^\/api\/v2\/catalogs\/[1-9][0-9]*\/versions\/[A-Za-z0-9._-]+\/artifact$/,
      ),
    sha256: sha256Schema,
    bytes: z.number().int().positive(),
    contentType: z.literal(catalogContentType),
  }),
  counts: z.object({
    circles: z.number().int().nonnegative(),
    layouts: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
  }),
  capabilities: z.object({
    stableCircleIdentity: z.literal("comiketNo+wcID"),
    circleImages: z.literal(true),
    commonImages: z.literal(true),
  }),
});

const artifactPathSchema = z.object({
  comiketNo: comiketNoSchema,
  versionID: catalogVersionIDSchema,
});

const artifactRequestHeadersSchema = z.object({
  range: z.string().min(1).max(256).optional(),
  "if-range": z.string().min(1).max(256).optional(),
  "if-none-match": z.string().min(1).max(256).optional(),
});

const artifactHeadRequestHeadersSchema = z.object({
  "if-none-match": z.string().min(1).max(256).optional(),
});

const artifactIdentityHeadersSchema = z.object({
  "Accept-Ranges": z.literal("bytes"),
  "Cache-Control": z.string().min(1),
  "Content-Disposition": z.string().min(1),
  "Content-Length": z.string().regex(/^[0-9]+$/),
  "Content-Type": z.literal(catalogContentType),
  Digest: z.string().min(1),
  ETag: z.string().min(1),
  "X-Content-Type-Options": z.literal("nosniff"),
});

const artifactPartialHeadersSchema = artifactIdentityHeadersSchema.extend({
  "Content-Range": z.string().regex(/^bytes [0-9]+-[0-9]+\/[0-9]+$/),
});

const artifactBodySchema = z.custom<ReadableStream<Uint8Array>>(
  (value) => value instanceof ReadableStream,
);

const artifactGetOutputSchema = z.union([
  z.object({
    status: z.literal(200).describe("Complete artifact"),
    headers: artifactIdentityHeadersSchema,
    body: artifactBodySchema,
  }),
  z.object({
    status: z.literal(206).describe("Requested byte range"),
    headers: artifactPartialHeadersSchema,
    body: artifactBodySchema,
  }),
  z.object({
    status: z.literal(304).describe("Artifact ETag is unchanged"),
    headers: artifactIdentityHeadersSchema,
  }),
]);

const artifactHeadOutputSchema = z.union([
  z.object({
    status: z.literal(200).describe("Artifact metadata"),
    headers: artifactIdentityHeadersSchema,
  }),
  z.object({
    status: z.literal(304).describe("Artifact ETag is unchanged"),
    headers: artifactIdentityHeadersSchema,
  }),
]);

const rangeErrorMap = {
  RANGE_NOT_SATISFIABLE: {
    status: 416,
    message: "The requested catalog byte range is not satisfiable.",
    data: serviceErrorDataSchema,
  },
} as const;

const binaryContent = {
  [catalogContentType]: {
    schema: { type: "string", format: "binary" },
  },
} as const;

export const listCatalogIndex = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/catalogs",
    operationId: "listCatalogs",
    summary: "List published catalogs",
    description:
      "Lists the current sanitized ComiNavi catalog manifest for every published Comiket.",
    tags: ["Catalogs"],
  })
  .input(z.object({}))
  .output(z.object({ items: z.array(catalogManifestSchema) }))
  .handler(async ({ context }) => ({
    items: (await listPublishedCatalogs(context.env.COMINAVI_DB)).items.map(
      generatedCatalogManifest,
    ),
  }));

export const getCatalogManifest = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/catalogs/{comiketNo}",
    operationId: "getCatalogManifest",
    summary: "Get a published catalog manifest",
    description:
      "Returns the current immutable sanitized catalog version and authenticated artifact URL for one Comiket.",
    tags: ["Catalogs"],
    inputStructure: "detailed",
  })
  .input(z.object({ params: z.object({ comiketNo: comiketNoSchema }) }))
  .output(catalogManifestSchema)
  .handler(async ({ context, input }) =>
    generatedCatalogManifest(
      await loadPublishedCatalog(
        context.env.COMINAVI_DB,
        input.params.comiketNo,
      ),
    ),
  );

export const downloadCatalogArtifact = authenticatedProcedure
  .errors(rangeErrorMap)
  .route({
    method: "GET",
    path: "/api/v2/catalogs/{comiketNo}/versions/{versionID}/artifact",
    operationId: "downloadCatalogArtifact",
    summary: "Download a published catalog artifact",
    description:
      "Streams an immutable SQLite artifact. Supports ETag validation, If-Range, suffix ranges, and resumable byte ranges.",
    tags: ["Catalogs"],
    inputStructure: "detailed",
    outputStructure: "detailed",
    spec: (operation) => ({
      ...operation,
      responses: {
        ...operation.responses,
        "200": {
          ...operation.responses?.["200"],
          description: "Complete artifact",
          content: binaryContent,
        },
        "206": {
          ...operation.responses?.["206"],
          description: "Requested byte range",
          content: binaryContent,
        },
        "416": {
          ...operation.responses?.["416"],
          description: "Requested byte range is not satisfiable",
          headers: {
            "Content-Range": {
              required: false,
              schema: {
                type: "string",
                pattern: "^bytes \\*/[0-9]+$",
              },
            },
          },
        },
      },
    }),
  })
  .input(
    z.object({
      params: artifactPathSchema,
      headers: artifactRequestHeadersSchema,
    }),
  )
  .output(artifactGetOutputSchema)
  .handler(async ({ context, input, errors }) => {
    const response = await serveCatalogArtifact(
      context.request,
      context.env.COMINAVI_DB,
      context.env.COMINAVI_CATALOGS,
      input.params.comiketNo,
      input.params.versionID,
    );
    if (response.status === 416) {
      throw errors.RANGE_NOT_SATISFIABLE({
        data: {
          error: "catalog_range_not_satisfiable",
          details: {
            contentRange: response.headers.get("Content-Range") ?? "",
          },
        },
      });
    }
    if (response.status === 304) {
      return {
        status: 304 as const,
        headers: artifactIdentityHeaders(response),
      };
    }
    const body = requiredArtifactBody(response);
    if (response.status === 206) {
      return {
        status: 206 as const,
        headers: {
          ...artifactIdentityHeaders(response),
          "Content-Range": requiredHeader(response, "Content-Range"),
        },
        body,
      };
    }
    if (response.status === 200) {
      return {
        status: 200 as const,
        headers: artifactIdentityHeaders(response),
        body,
      };
    }
    throw invalidArtifactResponse(response.status);
  });

export const headCatalogArtifact = authenticatedProcedure
  .route({
    method: "HEAD",
    path: "/api/v2/catalogs/{comiketNo}/versions/{versionID}/artifact",
    operationId: "headCatalogArtifact",
    summary: "Inspect a published catalog artifact",
    description:
      "Returns immutable artifact identity and length headers without downloading SQLite bytes.",
    tags: ["Catalogs"],
    inputStructure: "detailed",
    outputStructure: "detailed",
  })
  .input(
    z.object({
      params: artifactPathSchema,
      headers: artifactHeadRequestHeadersSchema,
    }),
  )
  .output(artifactHeadOutputSchema)
  .handler(async ({ context, input }) => {
    const response = await serveCatalogArtifact(
      context.request,
      context.env.COMINAVI_DB,
      context.env.COMINAVI_CATALOGS,
      input.params.comiketNo,
      input.params.versionID,
    );
    if (response.status !== 200 && response.status !== 304) {
      throw invalidArtifactResponse(response.status);
    }
    return {
      status: response.status,
      headers: artifactIdentityHeaders(response),
    };
  });

export const catalogsRouter = {
  list: listCatalogIndex,
  manifest: getCatalogManifest,
  artifact: {
    download: downloadCatalogArtifact,
    head: headCatalogArtifact,
  },
};

function generatedCatalogManifest(
  catalog: CatalogIndexItemV1,
): z.infer<typeof catalogManifestSchema> {
  return {
    schemaVersion: catalog.schemaVersion,
    versionID: catalog.versionID,
    comiketNo: catalog.comiketNo,
    name: catalog.name,
    publishedAt: catalog.publishedAt,
    ...(catalog.sourceUpdatedAt === null
      ? {}
      : { sourceUpdatedAt: catalog.sourceUpdatedAt }),
    artifact: {
      ...catalog.artifact,
      url: catalogArtifactPath(catalog.comiketNo, catalog.versionID),
    },
    counts: catalog.counts,
    capabilities: catalog.capabilities,
  };
}

function catalogArtifactPath(comiketNo: number, versionID: string): string {
  return `/api/v2/catalogs/${comiketNo}/versions/${versionID}/artifact`;
}

function artifactIdentityHeaders(
  response: Response,
): z.infer<typeof artifactIdentityHeadersSchema> {
  return {
    "Accept-Ranges": "bytes",
    "Cache-Control": requiredHeader(response, "Cache-Control"),
    "Content-Disposition": requiredHeader(response, "Content-Disposition"),
    "Content-Length": requiredHeader(response, "Content-Length"),
    "Content-Type": catalogContentType,
    Digest: requiredHeader(response, "Digest"),
    ETag: requiredHeader(response, "ETag"),
    "X-Content-Type-Options": "nosniff",
  };
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw invalidArtifactResponse(response.status);
  return value;
}

function requiredArtifactBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw invalidArtifactResponse(response.status);
  return response.body;
}

function invalidArtifactResponse(status: number): ServiceError {
  return new ServiceError(
    "catalog_artifact_invalid_response",
    500,
    `The catalog artifact service returned an invalid ${status} response.`,
  );
}
