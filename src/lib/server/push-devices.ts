import { AuthenticationError, type CominaviIdentity } from "./cominavi-auth";
import { sql } from "drizzle-orm";
import { runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import { pushDevices, users } from "../db/schema";
import { ServiceError } from "./service-error";

const maximumEnabledPushDevicesPerUser = 10;
const maximumRetainedPushDevicesPerUser = 20;

interface DeviceRegistration {
  token: string;
  apnsEnvironment: "sandbox" | "production";
  bundleID: string;
  locale?: string;
  timeZone?: string;
  enabled: boolean;
}

export function parseInstallationID(value: string | undefined): string {
  if (!value || !/^[0-9a-fA-F-]{16,64}$/.test(value)) {
    throw new ServiceError(
      "invalid_installation_id",
      400,
      "The app installation identifier is invalid.",
    );
  }
  return value.toLowerCase();
}

export function parseDeviceRegistration(
  value: unknown,
  allowedBundleIDs: string,
): DeviceRegistration {
  if (!isRecord(value)) throw invalidDevice();
  const { token, apnsEnvironment, bundleID, locale, timeZone } = value;
  if (
    typeof token !== "string" ||
    !/^[0-9a-fA-F]{64,256}$/.test(token) ||
    (apnsEnvironment !== "sandbox" && apnsEnvironment !== "production") ||
    typeof bundleID !== "string" ||
    !new Set(
      allowedBundleIDs
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ).has(bundleID) ||
    (locale !== undefined &&
      (typeof locale !== "string" || locale.length > 64)) ||
    (timeZone !== undefined &&
      (typeof timeZone !== "string" || timeZone.length > 64))
  ) {
    throw invalidDevice();
  }
  return {
    token: token.toLowerCase(),
    apnsEnvironment,
    bundleID,
    ...(typeof locale === "string" ? { locale } : {}),
    ...(typeof timeZone === "string" ? { timeZone } : {}),
    enabled: value.enabled !== false,
  };
}

export async function registerPushDevice(
  database: D1Database,
  identity: CominaviIdentity,
  installationID: string,
  registration: DeviceRegistration,
  nowMilliseconds = Date.now(),
): Promise<{ installationID: string; enabled: boolean }> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const tokenSHA256 = await sha256Hex(registration.token);
  const results = await runDrizzleBatch(database, [
    sql`
        DELETE FROM ${pushDevices}
         WHERE ${pushDevices.apnsEnvironment} = ${registration.apnsEnvironment}
           AND ${pushDevices.bundleID} = ${registration.bundleID}
           AND ${pushDevices.tokenSHA256} = ${tokenSHA256}
           AND (${pushDevices.userID} <> ${identity.userID}
             OR ${pushDevices.installationID} <> ${installationID})
           AND EXISTS (
             SELECT 1 FROM ${users}
             WHERE ${users.id} = ${identity.userID}
               AND ${users.authVersion} = ${identity.authVersion}
               AND ${users.deletionPendingAt} IS NULL
           )`,
    sql`
        INSERT INTO ${pushDevices} (
           user_id, installation_id, token, token_sha256, apns_environment,
           bundle_id, locale, time_zone, enabled, created_at, updated_at,
           last_registered_at, invalidated_at
         )
         SELECT ${identity.userID}, ${installationID}, ${registration.token},
                ${tokenSHA256}, ${registration.apnsEnvironment},
                ${registration.bundleID}, ${registration.locale ?? null},
                ${registration.timeZone ?? null},
                ${registration.enabled ? 1 : 0}, ${now}, ${now}, ${now}, NULL
         FROM ${users}
         WHERE ${users.id} = ${identity.userID}
           AND ${users.authVersion} = ${identity.authVersion}
           AND ${users.deletionPendingAt} IS NULL
         ON CONFLICT(user_id, installation_id) DO UPDATE SET
           token = excluded.token,
           token_sha256 = excluded.token_sha256,
           apns_environment = excluded.apns_environment,
           bundle_id = excluded.bundle_id,
           locale = excluded.locale,
           time_zone = excluded.time_zone,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at,
           last_registered_at = excluded.last_registered_at,
           invalidated_at = NULL`,
    sql`
        UPDATE ${pushDevices}
         SET enabled = 0,
             invalidated_at = COALESCE(invalidated_at, ${now}),
             updated_at = ${now}
         WHERE user_id = ${identity.userID} AND enabled = 1 AND id NOT IN (
           SELECT id FROM ${pushDevices}
           WHERE user_id = ${identity.userID} AND enabled = 1
           ORDER BY CASE WHEN installation_id = ${installationID} THEN 0 ELSE 1 END,
                    last_registered_at DESC, updated_at DESC, created_at DESC, id DESC
           LIMIT ${maximumEnabledPushDevicesPerUser}
         )
           AND EXISTS (
             SELECT 1 FROM ${users}
             WHERE ${users.id} = ${identity.userID}
               AND ${users.authVersion} = ${identity.authVersion}
               AND ${users.deletionPendingAt} IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM ${pushDevices}
             WHERE user_id = ${identity.userID}
               AND installation_id = ${installationID}
               AND token_sha256 = ${tokenSHA256}
               AND last_registered_at = ${now}
           )`,
    sql`
        DELETE FROM ${pushDevices}
         WHERE user_id = ${identity.userID} AND enabled = 0 AND id NOT IN (
           SELECT id FROM ${pushDevices}
           WHERE user_id = ${identity.userID}
           ORDER BY CASE WHEN installation_id = ${installationID} THEN 0 ELSE 1 END,
                    enabled DESC, last_registered_at DESC, updated_at DESC,
                    created_at DESC, id DESC
           LIMIT ${maximumRetainedPushDevicesPerUser}
         )
           AND EXISTS (
             SELECT 1 FROM ${users}
             WHERE ${users.id} = ${identity.userID}
               AND ${users.authVersion} = ${identity.authVersion}
               AND ${users.deletionPendingAt} IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM ${pushDevices}
             WHERE user_id = ${identity.userID}
               AND installation_id = ${installationID}
               AND token_sha256 = ${tokenSHA256}
               AND last_registered_at = ${now}
           )`,
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) {
    throw new AuthenticationError(
      "invalid_token",
      401,
      "The ComiNavi session is no longer valid.",
    );
  }
  return { installationID, enabled: registration.enabled };
}

export async function disablePushDevice(
  database: D1Database,
  identity: CominaviIdentity,
  installationID: string,
  nowMilliseconds = Date.now(),
): Promise<void> {
  const now = Math.floor(nowMilliseconds / 1_000);
  await createDatabase(database).run(sql`
       UPDATE ${pushDevices}
       SET enabled = 0, invalidated_at = ${now}, updated_at = ${now}
       WHERE user_id = ${identity.userID}
         AND installation_id = ${installationID}
         AND EXISTS (
           SELECT 1 FROM ${users}
           WHERE ${users.id} = ${identity.userID}
             AND ${users.authVersion} = ${identity.authVersion}
             AND ${users.deletionPendingAt} IS NULL
         )`);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function invalidDevice(): ServiceError {
  return new ServiceError(
    "invalid_push_device",
    400,
    "The push-device registration is invalid.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
