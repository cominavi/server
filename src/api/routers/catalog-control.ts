import { z } from "zod";
import {
  authenticateCatalogPublisherRequest,
  assertCatalogMultipartUpload,
  beginCatalogMultipartUpload,
  bindCatalogPublisherCommand,
  completeCatalogMultipartUploadReceipt,
  loadCatalogPublisherCommandResult,
  recordCatalogMultipartUpload,
} from "../../lib/server/catalog-publisher-auth";
import {
  finishCatalogRefreshJob,
  leaseCatalogRefreshJob,
  releaseCatalogRefreshJob,
  renewCatalogRefreshJob,
} from "../../lib/server/catalog-refresh";
import {
  assertCatalogPublicationAuthority,
  assertCatalogPublicationStatusAuthority,
  assertScheduledCatalogClaimAuthority,
  claimCatalogImport,
  ingestCatalogRows,
  loadCatalogPublicationStatus,
  publishCatalogVersion,
  stageCatalogVersion,
  type CatalogImportClaimInput,
  type CatalogNormalizedDataV1,
  type CatalogStageInput,
} from "../../lib/server/catalogs";
import { ServiceError } from "../../lib/server/service-error";
import {
  catalogPublisherProcedure,
  type APIContext,
  type AuthenticatedCatalogPublisherRequest,
} from "../core";

const maximumPartBytes = 10 * 1024 * 1024;
const jsonCommandInputSchema = z.object({ body: z.unknown() });
const publicationStateSchema = z.enum([
  "staging",
  "published",
  "superseded",
  "failed",
]);
const hmacDescription =
  "Authenticate the exact request bytes with the catalog publisher HMAC headers. The signature binds the newline-separated timestamp, idempotency key, method, path plus query, and request-body SHA-256 digest.";

const publicationResponseSchema = z.object({
  accepted: z.literal(true),
  action: z.enum(["claim", "stage", "ingest", "publish", "status"]),
  claimed: z.boolean().optional(),
  state: publicationStateSchema.optional(),
});

const refreshJobSchema = z.object({
  id: z.uuid(),
  comiketNo: z.number().int().positive(),
  sourceMD5Hint: z.string().min(1),
  sourceMainURL: z.url(),
  sourceImageURL: z.url(),
  sourceUpdatedAt: z.number().int().optional(),
});

const refreshResponseSchema = z.object({
  accepted: z.literal(true).optional(),
  leaseExpiresAt: z.number().int().optional(),
  job: refreshJobSchema.optional(),
});

const multipartResponseSchema = z.object({
  alreadyComplete: z.boolean().optional(),
  uploadID: z.string().min(1).optional(),
  completed: z.literal(true).optional(),
});

const artifactPartBodySchema = z.instanceof(Blob);
const artifactPartBinaryMedia = {
  "application/octet-stream": {
    schema: { type: "string", format: "binary" },
  },
} as const;

export const executeCatalogPublication = catalogPublisherProcedure
  .route({
    method: "POST",
    path: "/api/v2/internal/catalog-publications",
    operationId: "executeCatalogPublication",
    summary: "Execute a catalog publication command",
    description: `${hmacDescription} Manual commands and scheduled commands use distinct signing secrets; scheduled commands must retain their live refresh claim and lease.`,
    tags: ["Internal Catalog Control"],
    inputStructure: "detailed",
    outputStructure: "detailed",
    successStatus: 202,
    successDescription: "The publication command was accepted or replayed.",
  })
  .input(jsonCommandInputSchema)
  .output(
    z.object({
      status: z.literal(202),
      body: publicationResponseSchema,
    }),
  )
  .handler(async ({ context }) => ({
    status: 202 as const,
    body: await handleCatalogPublication(context),
  }));

export const executeCatalogRefreshJob = catalogPublisherProcedure
  .route({
    method: "POST",
    path: "/api/v2/internal/catalog-refresh-jobs",
    operationId: "executeCatalogRefreshJob",
    summary: "Lease or update a catalog refresh job",
    description: `${hmacDescription} Only the scheduled catalog publisher signer may execute refresh-job commands.`,
    tags: ["Internal Catalog Control"],
    inputStructure: "detailed",
  })
  .input(jsonCommandInputSchema)
  .output(refreshResponseSchema)
  .handler(({ context }) => handleCatalogRefreshJob(context));

export const executeCatalogMultipartUpload = catalogPublisherProcedure
  .route({
    method: "POST",
    path: "/api/v2/internal/catalog-artifacts/multipart",
    operationId: "executeCatalogMultipartUpload",
    summary: "Create or complete a catalog multipart upload",
    description: `${hmacDescription} Creation is payload-bound and replayable; completion rechecks live publication authority around object-storage work.`,
    tags: ["Internal Catalog Control"],
    inputStructure: "detailed",
    outputStructure: "detailed",
    successStatus: 200,
    successDescription:
      "The object already matched the command or the multipart upload completed.",
    spec: (operation) => ({
      ...operation,
      responses: {
        ...operation.responses,
        "201": {
          ...operation.responses?.["200"],
          description: "A multipart upload was created or recovered.",
        },
      },
    }),
  })
  .input(jsonCommandInputSchema)
  .output(
    z.object({
      status: z.literal(201).optional(),
      body: multipartResponseSchema,
    }),
  )
  .handler(({ context }) => handleCatalogMultipart(context));

export const uploadCatalogMultipartPart = catalogPublisherProcedure
  .route({
    method: "PUT",
    path: "/api/v2/internal/catalog-artifacts/multipart/{uploadID}/{partNumber}",
    operationId: "uploadCatalogMultipartPart",
    summary: "Upload one catalog multipart part",
    description: `${hmacDescription} The raw part is limited to 10 MiB and remains bound to the current publication claim, lease, source pair, object key, upload, and part number.`,
    tags: ["Internal Catalog Control"],
    inputStructure: "detailed",
    spec: (operation) => ({
      ...operation,
      requestBody: {
        required: true,
        content: artifactPartBinaryMedia,
      },
    }),
  })
  .input(
    z.object({
      params: z.object({
        uploadID: z.string().min(1),
        partNumber: z.coerce.number().int().min(1).max(10_000),
      }),
      query: z.object({
        key: z.string().min(1),
        claimID: z.string().min(1).optional(),
        leaseID: z.string().min(1).optional(),
        sourceMD5Hint: z.string().min(1).optional(),
      }),
      body: artifactPartBodySchema,
    }),
  )
  .output(
    z.object({
      partNumber: z.number().int().min(1).max(10_000),
      etag: z.string().min(1),
    }),
  )
  .handler(({ context, input }) =>
    handleCatalogMultipartPart(context, input.params, input.query),
  );

export const catalogControlRouter = {
  publications: executeCatalogPublication,
  refreshJobs: executeCatalogRefreshJob,
  multipart: executeCatalogMultipartUpload,
  multipartPart: uploadCatalogMultipartPart,
};

async function handleCatalogPublication(
  context: APIContext,
): Promise<z.infer<typeof publicationResponseSchema>> {
  const authenticated = await authenticatedCatalogRequest(context);
  const command = parsePublicationCommand(authenticated.rawBody);
  const now = Math.floor(Date.now() / 1_000);
  await bindCatalogPublisherCommand(
    context.env.COMINAVI_DB,
    authenticated.idempotencyKey,
    `catalog_publication:${command.action}`,
    authenticated.payloadSHA256,
    now,
  );
  if (command.action === "publish") {
    const replay = await loadCatalogPublisherCommandResult<
      z.infer<typeof publicationResponseSchema>
    >(
      context.env.COMINAVI_DB,
      authenticated.idempotencyKey,
      "catalog_publication:publish",
      authenticated.payloadSHA256,
    );
    if (replay) return replay;
  }
  if (authenticated.signerScope === "scheduled") {
    if (
      !command.input.refreshLeaseID ||
      !command.input.claimID ||
      !command.input.sourceMD5Hint
    ) {
      throw scheduledAuthorityRequired();
    }
    if (command.action === "status") {
      await assertCatalogPublicationStatusAuthority(
        context.env.COMINAVI_DB,
        {
          claimID: command.input.claimID,
          leaseID: command.input.refreshLeaseID,
          sourceMD5Hint: command.input.sourceMD5Hint,
        },
        now,
      );
    } else if (command.action === "claim") {
      await assertCatalogPublicationAuthority(
        context.env.COMINAVI_DB,
        {
          claimID: command.input.claimID,
          leaseID: command.input.refreshLeaseID,
          sourceMD5Hint: command.input.sourceMD5Hint,
        },
        now,
      );
    } else {
      await assertScheduledCatalogClaimAuthority(
        context.env.COMINAVI_DB,
        command.input.claimID,
        command.input.refreshLeaseID,
        command.input.sourceMD5Hint,
        now,
      );
    }
  } else if (command.input.refreshLeaseID) {
    throw scheduledAuthorityRequired();
  }

  if (command.action === "claim") {
    return {
      accepted: true,
      action: command.action,
      claimed: await claimCatalogImport(context.env.COMINAVI_DB, {
        ...command.input,
        now,
      }),
    };
  }
  if (command.action === "stage") {
    await stageCatalogVersion(context.env.COMINAVI_DB, {
      ...command.input,
      now,
    });
  } else if (command.action === "ingest") {
    await ingestCatalogRows(
      context.env.COMINAVI_DB,
      { ...command.input, now },
      () => Math.floor(Date.now() / 1_000),
    );
  } else if (command.action === "publish") {
    await publishCatalogVersion(
      context.env.COMINAVI_DB,
      context.env.COMINAVI_CATALOGS,
      {
        ...command.input,
        now,
        commandReceipt: {
          idempotencyKey: authenticated.idempotencyKey,
          payloadSHA256: authenticated.payloadSHA256,
        },
      },
      () => Math.floor(Date.now() / 1_000),
    );
  } else {
    const state = await loadCatalogPublicationStatus(
      context.env.COMINAVI_DB,
      command.input.versionID,
    );
    return {
      accepted: true,
      action: command.action,
      ...(state ? { state } : {}),
    };
  }
  return { accepted: true, action: command.action };
}

async function handleCatalogRefreshJob(
  context: APIContext,
): Promise<z.infer<typeof refreshResponseSchema>> {
  const authenticated = await authenticatedCatalogRequest(context);
  if (authenticated.signerScope !== "scheduled") {
    throw new ServiceError(
      "invalid_catalog_publication_signature",
      401,
      "Catalog refresh jobs require the scheduled publisher signer.",
    );
  }
  const command = parseRefreshCommand(authenticated.rawBody);
  const now = Math.floor(Date.now() / 1_000);
  if (command.action === "lease") {
    const job = await leaseCatalogRefreshJob(
      context.env,
      command.leaseID,
      authenticated.idempotencyKey,
      authenticated.payloadSHA256,
      fetch,
      now,
      () => Math.floor(Date.now() / 1_000),
    );
    const normalizedJob = job
      ? {
          id: job.id,
          comiketNo: job.comiketNo,
          sourceMD5Hint: job.sourceMD5Hint,
          sourceMainURL: job.sourceMainURL,
          sourceImageURL: job.sourceImageURL,
          ...(job.sourceUpdatedAt === null
            ? {}
            : { sourceUpdatedAt: job.sourceUpdatedAt }),
        }
      : undefined;
    return {
      ...(normalizedJob ? { job: normalizedJob } : {}),
    };
  }
  if (command.action === "renew") {
    return {
      accepted: true,
      leaseExpiresAt: await renewCatalogRefreshJob(
        context.env.COMINAVI_DB,
        command.jobID,
        command.leaseID,
        command.sourceMD5Hint,
        authenticated.idempotencyKey,
        authenticated.payloadSHA256,
        now,
      ),
    };
  }
  if (command.action === "complete") {
    await finishCatalogRefreshJob(
      context.env.COMINAVI_DB,
      command.jobID,
      command.leaseID,
      command.versionID,
      authenticated.idempotencyKey,
      authenticated.payloadSHA256,
      now,
    );
  } else {
    await releaseCatalogRefreshJob(
      context.env.COMINAVI_DB,
      command.jobID,
      command.leaseID,
      command.errorCode,
      authenticated.idempotencyKey,
      authenticated.payloadSHA256,
      now,
    );
  }
  return { accepted: true };
}

async function handleCatalogMultipart(context: APIContext): Promise<{
  status?: 201;
  body: z.infer<typeof multipartResponseSchema>;
}> {
  const authenticated = await authenticatedCatalogRequest(context);
  const command = parseArtifactCommand(authenticated.rawBody);
  assertSignerAuthority(authenticated.signerScope, command);
  await bindCatalogPublisherCommand(
    context.env.COMINAVI_DB,
    authenticated.idempotencyKey,
    `catalog_artifact:${command.action}`,
    authenticated.payloadSHA256,
  );
  await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, command);
  if (command.action === "create") {
    const existing = await context.env.COMINAVI_CATALOGS.head(
      command.objectKey,
    );
    await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, command);
    if (matches(existing, command)) {
      return { body: { alreadyComplete: true } };
    }
    if (existing) throw artifactConflict();
    const receipt = await beginCatalogMultipartUpload(
      context.env.COMINAVI_DB,
      authenticated.idempotencyKey,
      command,
    );
    await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, command);
    if (!receipt.create) {
      return {
        status: 201,
        body: { alreadyComplete: false, uploadID: receipt.uploadID },
      };
    }
    const upload = await context.env.COMINAVI_CATALOGS.createMultipartUpload(
      command.objectKey,
      {
        httpMetadata: { contentType: command.contentType },
        customMetadata: {
          sha256: command.sha256,
          visibility: command.visibility,
        },
      },
    );
    await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, command);
    await recordCatalogMultipartUpload(
      context.env.COMINAVI_DB,
      authenticated.idempotencyKey,
      command,
      upload.uploadId,
    );
    await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, command);
    return {
      status: 201,
      body: { alreadyComplete: false, uploadID: upload.uploadId },
    };
  }

  const upload = context.env.COMINAVI_CATALOGS.resumeMultipartUpload(
    command.objectKey,
    command.uploadID,
  );
  await assertCatalogMultipartUpload(
    context.env.COMINAVI_DB,
    command.objectKey,
    command.uploadID,
    command,
  );
  await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, command);
  try {
    await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, command);
    await upload.complete(command.parts);
  } catch (error) {
    const existing = await context.env.COMINAVI_CATALOGS.head(
      command.objectKey,
    );
    if (!matches(existing, command)) throw error;
  }
  await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, command);
  const completed = await context.env.COMINAVI_CATALOGS.head(command.objectKey);
  await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, command);
  if (!matches(completed, command)) throw artifactConflict();
  await completeCatalogMultipartUploadReceipt(
    context.env.COMINAVI_DB,
    command.objectKey,
    command.uploadID,
  );
  return { body: { completed: true } };
}

async function handleCatalogMultipartPart(
  context: APIContext,
  params: { uploadID: string; partNumber: number },
  query: {
    key: string;
    claimID?: string;
    leaseID?: string;
    sourceMD5Hint?: string;
  },
): Promise<{ partNumber: number; etag: string }> {
  const authenticated = await authenticatedCatalogRequest(
    context,
    maximumPartBytes,
  );
  const authority = {
    ...(query.claimID ? { claimID: query.claimID } : {}),
    ...(query.leaseID ? { leaseID: query.leaseID } : {}),
    ...(query.sourceMD5Hint ? { sourceMD5Hint: query.sourceMD5Hint } : {}),
  };
  assertSignerAuthority(authenticated.signerScope, authority);
  await bindCatalogPublisherCommand(
    context.env.COMINAVI_DB,
    authenticated.idempotencyKey,
    `catalog_artifact:part:${new URL(context.request.url).pathname}${new URL(context.request.url).search}`,
    authenticated.payloadSHA256,
  );
  if (
    (!query.key.startsWith("raw/catalogs/") &&
      !query.key.startsWith("derived/catalogs/")) ||
    authenticated.rawBody.byteLength < 1
  ) {
    throw invalidArtifactPart();
  }
  await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, authority);
  await assertCatalogMultipartUpload(
    context.env.COMINAVI_DB,
    query.key,
    params.uploadID,
    authority,
  );
  await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, authority);
  const upload = context.env.COMINAVI_CATALOGS.resumeMultipartUpload(
    query.key,
    params.uploadID,
  );
  const part = await upload.uploadPart(
    params.partNumber,
    Uint8Array.from(authenticated.rawBody).buffer,
  );
  await assertCatalogPublicationAuthority(context.env.COMINAVI_DB, authority);
  return { partNumber: part.partNumber, etag: part.etag };
}

async function authenticatedCatalogRequest(
  context: APIContext,
  maximumBodyBytes?: number,
): Promise<AuthenticatedCatalogPublisherRequest> {
  if (context.authenticatedCatalogPublisherRequest) {
    return context.authenticatedCatalogPublisherRequest;
  }
  return authenticateCatalogPublisherRequest(
    context.request.clone() as unknown as Request,
    {
      manual: context.env.COMINAVI_CATALOG_PUBLISH_SECRET,
      scheduled: context.env.COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET,
    },
    maximumBodyBytes,
  );
}

type CatalogCommand =
  | { action: "claim"; input: Omit<CatalogImportClaimInput, "now"> }
  | { action: "stage"; input: Omit<CatalogStageInput, "now"> }
  | {
      action: "ingest";
      input: {
        versionID: string;
        comiketNo: number;
        claimID: string;
        refreshLeaseID: string | null;
        sourceMD5Hint: string | null;
        data: CatalogNormalizedDataV1;
      };
    }
  | {
      action: "publish";
      input: {
        versionID: string;
        comiketNo: number;
        claimID: string;
        refreshLeaseID: string | null;
        sourceMD5Hint: string | null;
      };
    }
  | {
      action: "status";
      input: {
        versionID: string;
        claimID?: string;
        refreshLeaseID?: string | null;
        sourceMD5Hint?: string | null;
      };
    };

function parsePublicationCommand(bytes: Uint8Array): CatalogCommand {
  const value = parseJSONObject(bytes, invalidPublicationCommand);
  if (
    value.schemaVersion !== 1 ||
    !["claim", "stage", "ingest", "publish", "status"].includes(
      String(value.action),
    ) ||
    !isRecord(value.input)
  ) {
    throw invalidPublicationCommand();
  }
  if (value.action === "ingest") {
    const data = value.input.data;
    if (!isRecord(data)) throw invalidPublicationCommand();
    for (const collection of [
      "dates",
      "maps",
      "areas",
      "blocks",
      "floors",
      "mappings",
      "genres",
      "layouts",
      "circles",
      "images",
    ]) {
      const rows = data[collection];
      if (!Array.isArray(rows) || rows.length > 100) {
        throw invalidPublicationCommand();
      }
    }
  }
  const input = {
    ...value.input,
    refreshLeaseID: value.input.refreshLeaseID ?? null,
    sourceMD5Hint: value.input.sourceMD5Hint ?? null,
    ...(value.action === "stage"
      ? { sourceUpdatedAt: value.input.sourceUpdatedAt ?? null }
      : {}),
  };
  return { action: value.action, input } as CatalogCommand;
}

type RefreshCommand =
  | { action: "lease"; leaseID: string }
  | {
      action: "renew";
      jobID: string;
      leaseID: string;
      sourceMD5Hint: string;
    }
  | {
      action: "complete";
      jobID: string;
      leaseID: string;
      versionID: string;
    }
  | {
      action: "release";
      jobID: string;
      leaseID: string;
      errorCode: string;
    };

function parseRefreshCommand(bytes: Uint8Array): RefreshCommand {
  const value = parseJSONObject(bytes, invalidRefreshCommand);
  if (
    value.schemaVersion !== 1 ||
    (value.action !== "lease" &&
      value.action !== "renew" &&
      value.action !== "complete" &&
      value.action !== "release") ||
    typeof value.leaseID !== "string"
  ) {
    throw invalidRefreshCommand();
  }
  return value as RefreshCommand;
}

type ArtifactMetadata = {
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
  visibility: "private_source" | "authenticated_download";
  claimID?: string;
  leaseID?: string;
  sourceMD5Hint?: string;
};

type ArtifactCommand =
  | ({ action: "create" } & ArtifactMetadata)
  | ({
      action: "complete";
      uploadID: string;
      parts: R2UploadedPart[];
    } & ArtifactMetadata);

function parseArtifactCommand(bytes: Uint8Array): ArtifactCommand {
  const value = parseJSONObject(bytes, invalidArtifact);
  if (
    value.schemaVersion !== 1 ||
    (value.action !== "create" && value.action !== "complete") ||
    typeof value.objectKey !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 1 ||
    !validArtifactLocation(value.objectKey, value.contentType, value.visibility)
  ) {
    throw invalidArtifact();
  }
  const authorityValues = [value.claimID, value.leaseID, value.sourceMD5Hint];
  if (
    authorityValues.some((item) => item !== undefined) &&
    authorityValues.some((item) => typeof item !== "string")
  ) {
    throw invalidArtifact();
  }
  if (
    value.action === "complete" &&
    (typeof value.uploadID !== "string" ||
      !Array.isArray(value.parts) ||
      value.parts.length < 1 ||
      value.parts.some(
        (part) =>
          !isRecord(part) ||
          !Number.isSafeInteger(part.partNumber) ||
          typeof part.etag !== "string",
      ))
  ) {
    throw invalidArtifact();
  }
  return value as ArtifactCommand;
}

function parseJSONObject(
  bytes: Uint8Array,
  invalid: () => ServiceError,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isRecord(value)) return value;
  } catch {
    // Use the stable endpoint-specific error below.
  }
  throw invalid();
}

function validArtifactLocation(
  key: string,
  contentType: unknown,
  visibility: unknown,
): boolean {
  return (
    (key.startsWith("raw/catalogs/") &&
      contentType === "application/vnd.sqlite3" &&
      visibility === "private_source") ||
    (key.startsWith("derived/catalogs/") &&
      contentType === "application/vnd.cominavi.catalog-v1+sqlite" &&
      visibility === "authenticated_download")
  );
}

function matches(object: R2Object | null, metadata: ArtifactMetadata): boolean {
  return (
    object?.size === metadata.bytes &&
    object.httpMetadata?.contentType === metadata.contentType &&
    object.customMetadata?.sha256 === metadata.sha256 &&
    object.customMetadata?.visibility === metadata.visibility
  );
}

function assertSignerAuthority(
  signer: "manual" | "scheduled",
  command: Pick<ArtifactMetadata, "claimID" | "leaseID" | "sourceMD5Hint">,
): void {
  const scheduledAuthority = Boolean(
    command.claimID && command.leaseID && command.sourceMD5Hint,
  );
  if (
    (signer === "scheduled" && !scheduledAuthority) ||
    (signer === "manual" && scheduledAuthority)
  ) {
    throw new ServiceError(
      "catalog_publication_authority_lost",
      409,
      "The catalog signer does not match the publication authority scope.",
    );
  }
}

function invalidPublicationCommand(): ServiceError {
  return new ServiceError(
    "invalid_catalog_publication",
    400,
    "The catalog publication command is invalid.",
  );
}

function scheduledAuthorityRequired(): ServiceError {
  return new ServiceError(
    "catalog_publication_authority_lost",
    409,
    "Scheduled publication requires its current refresh lease authority.",
  );
}

function invalidRefreshCommand(): ServiceError {
  return new ServiceError(
    "invalid_catalog_refresh_job",
    400,
    "The catalog refresh job command is invalid.",
  );
}

function invalidArtifact(): ServiceError {
  return new ServiceError(
    "invalid_catalog_artifact",
    400,
    "The private catalog artifact command is invalid.",
  );
}

function invalidArtifactPart(): ServiceError {
  return new ServiceError(
    "invalid_catalog_artifact_part",
    400,
    "The catalog artifact part is invalid.",
  );
}

function artifactConflict(): ServiceError {
  return new ServiceError(
    "catalog_artifact_conflict",
    409,
    "The content-addressed catalog artifact conflicts with existing metadata.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
