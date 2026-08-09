import type { CominaviIdentity } from "./cominavi-auth";
import { ServiceError } from "./service-error";

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
  await database.batch([
    database
      .prepare(
        `DELETE FROM push_devices
         WHERE apns_environment = ?1 AND bundle_id = ?2
           AND token_sha256 = ?3
           AND (user_id <> ?4 OR installation_id <> ?5)`,
      )
      .bind(
        registration.apnsEnvironment,
        registration.bundleID,
        tokenSHA256,
        identity.userID,
        installationID,
      ),
    database
      .prepare(
        `INSERT INTO push_devices (
           user_id, installation_id, token, token_sha256, apns_environment,
           bundle_id, locale, time_zone, enabled, created_at, updated_at,
           last_registered_at, invalidated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, NULL)
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
      )
      .bind(
        identity.userID,
        installationID,
        registration.token,
        tokenSHA256,
        registration.apnsEnvironment,
        registration.bundleID,
        registration.locale ?? null,
        registration.timeZone ?? null,
        registration.enabled ? 1 : 0,
        now,
      ),
  ]);
  return { installationID, enabled: registration.enabled };
}

export async function disablePushDevice(
  database: D1Database,
  identity: CominaviIdentity,
  installationID: string,
  nowMilliseconds = Date.now(),
): Promise<void> {
  const now = Math.floor(nowMilliseconds / 1_000);
  await database
    .prepare(
      `UPDATE push_devices
       SET enabled = 0, invalidated_at = ?1, updated_at = ?1
       WHERE user_id = ?2 AND installation_id = ?3`,
    )
    .bind(now, identity.userID, installationID)
    .run();
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
