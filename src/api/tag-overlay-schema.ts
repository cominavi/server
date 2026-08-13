import { z } from "zod";

import { tagOverlayKinds } from "../lib/server/tag-overlays";

export const tagOverlayRevisionSchema = z.union([
  z.literal("none"),
  z.string().regex(/^[0-9a-f]{64}$/),
]);

const tagIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const tagLabelSchema = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 &&
      Array.from(value).length <= 200 &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(value),
    "Tag labels must contain 1-200 Unicode scalar values and no control characters.",
  );

export const circleTagOverlaySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    catalogPayloadSHA256: z.string().regex(/^[0-9a-f]{64}$/),
    taxonomyRevision: tagIdentifierSchema,
    matchingPolicyRevision: tagIdentifierSchema,
    evaluatedCircleCount: z.number().int().nonnegative().max(1_000_000),
    taggedCircleCount: z.number().int().nonnegative().max(100_000),
    terms: z
      .array(
        z
          .object({
            id: tagIdentifierSchema,
            label: tagLabelSchema,
            kind: z.enum(tagOverlayKinds),
          })
          .strict(),
      )
      .max(10_000),
    circles: z
      .array(
        z
          .object({
            wcID: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            tagIDs: z.array(tagIdentifierSchema).min(1).max(512),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();
