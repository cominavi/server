import { z } from "zod";

import { catalogEditionCapabilityNames } from "../db/schema";

/**
 * Provider-neutral catalog identity vocabulary.
 * Contract: cominavi/cominavi docs/proposals/catalog-contracts.md §2.2–§2.6.
 */

const catalogEventKeyPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const comiketEditionKeyPattern = /^comiket-[0-9]+$/;
const circleKeyPattern = /^(?:[1-9][0-9]*|m[0-9abcdefghjkmnpqrstvwxyz]{16})$/;

export const catalogSeriesKeys = ["comiket", "fixture"] as const;
export type CatalogSeriesKey = (typeof catalogSeriesKeys)[number];

/** True when `key` is a valid `catalogEventKey` for `series` (§2.2). */
export function isCatalogEventKey(
  key: string,
  series: CatalogSeriesKey,
): boolean {
  return (
    key.length >= 3 &&
    key.length <= 64 &&
    catalogEventKeyPattern.test(key) &&
    !/^c[0-9]+$/.test(key) &&
    !key.startsWith("event-") &&
    (series === "comiket" || !comiketEditionKeyPattern.test(key))
  );
}

/** True when `key` is a canonical decimal WCID or a minted key (§2.3). */
export function isCircleKey(key: string): boolean {
  return circleKeyPattern.test(key);
}

/** The creation-time key rule for Comiket editions. Never parse it back. */
export function comiketEditionKey(comiketNo: number): string {
  if (!Number.isSafeInteger(comiketNo) || comiketNo <= 0)
    throw new RangeError(`invalid Comiket number: ${comiketNo}`);
  return `comiket-${comiketNo}`;
}

/** The Circle.ms circle key: canonical decimal WCID (§2.3). */
export function circlemsCircleKey(wcID: number): string {
  if (!Number.isSafeInteger(wcID) || wcID <= 0)
    throw new RangeError(`invalid WCID: ${wcID}`);
  return String(wcID);
}

const localizedNameSchema = z
  .object({
    ja: z.string().trim().min(1).max(100),
    en: z.string().trim().min(1).max(100),
  })
  .strict();

export const catalogVenueKeys = ["tokyo-big-sight", "unknown"] as const;

/** Edition metadata v1 (§2.5), stored in `catalog_editions.metadata_json`. */
export const catalogEditionMetadataSchema = z
  .object({
    metadataSchemaVersion: z.literal(1),
    catalogEventKey: z.string(),
    seriesKey: z.enum(catalogSeriesKeys),
    legacyComiketNo: z.number().int().positive().max(10000).nullable(),
    displayName: localizedNameSchema,
    shortName: localizedNameSchema,
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "timeZone must be an IANA time zone"),
    days: z.array(
      z
        .object({
          day: z.number().int().positive(),
          date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
        })
        .strict(),
    ),
    venue: z
      .object({
        venueKey: z.enum(catalogVenueKeys),
        displayName: localizedNameSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (!isCatalogEventKey(metadata.catalogEventKey, metadata.seriesKey))
      context.addIssue({
        code: "custom",
        path: ["catalogEventKey"],
        message: "invalid catalogEventKey for this series",
      });
    if (
      (metadata.seriesKey === "comiket") !==
      (metadata.legacyComiketNo !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["legacyComiketNo"],
        message: "legacyComiketNo is required exactly for the comiket series",
      });
    const days = metadata.days.map(({ day }) => day);
    if (days.some((day, index) => index > 0 && day <= days[index - 1]))
      context.addIssue({
        code: "custom",
        path: ["days"],
        message: "days must be unique and ascending",
      });
  });

export type CatalogEditionMetadata = z.infer<
  typeof catalogEditionMetadataSchema
>;

export type CatalogCapabilityName =
  (typeof catalogEditionCapabilityNames)[number];
export type CatalogCapabilityMap = Record<CatalogCapabilityName, boolean>;

/**
 * Reads a published capability map fail closed (§2.6): missing, unknown, or
 * malformed states are unsupported, and unknown names are ignored.
 */
export function readCatalogCapabilities(value: unknown): CatalogCapabilityMap {
  const source =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    catalogEditionCapabilityNames.map((name) => [
      name,
      Object.hasOwn(source, name) && source[name] === "supported",
    ]),
  ) as CatalogCapabilityMap;
}

/** Metadata for a Comiket edition backfilled from legacy catalog rows. */
export function comiketEditionMetadata(input: {
  comiketNo: number;
  name: string;
  days: readonly { day: number; date: string }[];
}): CatalogEditionMetadata {
  return catalogEditionMetadataSchema.parse({
    metadataSchemaVersion: 1,
    catalogEventKey: comiketEditionKey(input.comiketNo),
    seriesKey: "comiket",
    legacyComiketNo: input.comiketNo,
    displayName: {
      ja: input.name,
      en: `Comic Market ${input.comiketNo}`,
    },
    shortName: { ja: `C${input.comiketNo}`, en: `C${input.comiketNo}` },
    timeZone: "Asia/Tokyo",
    days: input.days.map(({ day, date }) => ({ day, date })),
    venue: {
      venueKey: "tokyo-big-sight",
      displayName: { ja: "東京ビッグサイト", en: "Tokyo Big Sight" },
    },
  });
}
