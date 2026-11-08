import { and, eq, not, sql } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { userIdentities } from "../db/schema";
import { ServiceError } from "./service-error";

/**
 * Production catalog data may be read only by an account that holds at least
 * one identity other than a Circle.ms sandbox identity. A sandbox Circle.ms
 * account proves nothing about the person's Circle.ms production entitlement,
 * so a session whose only identities are sandbox identities is refused.
 *
 * This is the narrow pre-tier rule (data-layering proposal F-S2). Full access
 * tiers (A1) replace it with a server-derived capability check.
 */
export async function assertCatalogReader(
  database: D1Database,
  userID: number,
): Promise<void> {
  const qualifying = await createDatabase(database)
    .select({ value: sql<number>`1` })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userID, userID),
        not(
          and(
            eq(userIdentities.provider, "circlems"),
            eq(userIdentities.providerEnvironment, "sandbox"),
          )!,
        ),
      ),
    )
    .limit(1)
    .get();
  if (!qualifying) {
    throw new ServiceError(
      "catalog_access_denied",
      403,
      "Circle.ms sandbox accounts cannot read production catalogs.",
    );
  }
}
