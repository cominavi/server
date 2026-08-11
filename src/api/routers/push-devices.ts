import { z } from "zod";
import {
  disablePushDevice,
  parseDeviceRegistration,
  parseInstallationID,
  registerPushDevice,
} from "../../lib/server/push-devices";
import { authenticatedProcedure } from "../core";

const installationIDSchema = z.string().regex(/^[0-9a-fA-F-]{16,64}$/);

const pushDeviceRegistrationSchema = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{64,256}$/),
  apnsEnvironment: z.enum(["sandbox", "production"]),
  bundleID: z.string().min(1),
  locale: z.string().max(64).optional(),
  timeZone: z.string().max(64).optional(),
  enabled: z.boolean().default(true),
});

const pushDeviceReceiptSchema = z.object({
  installationID: installationIDSchema,
  enabled: z.boolean(),
});

export const registerPushDeviceOperation = authenticatedProcedure
  .route({
    method: "PUT",
    path: "/api/v2/me/devices/{installationID}",
    operationId: "registerPushDevice",
    summary: "Register a push installation",
    description:
      "Registers or replaces the authenticated user's APNs installation. At most 10 installations remain enabled and at most 20 are retained per user.",
    tags: ["Push Devices"],
    inputStructure: "detailed",
  })
  .input(
    z.object({
      params: z.object({ installationID: installationIDSchema }),
      body: pushDeviceRegistrationSchema,
    }),
  )
  .output(pushDeviceReceiptSchema)
  .handler(({ context, input }) => {
    const installationID = parseInstallationID(input.params.installationID);
    const registration = parseDeviceRegistration(
      input.body,
      context.env.COMINAVI_APNS_BUNDLE_IDS,
    );
    return registerPushDevice(
      context.env.COMINAVI_DB,
      context.identity,
      installationID,
      registration,
    );
  });

export const disablePushDeviceOperation = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/api/v2/me/devices/{installationID}",
    operationId: "disablePushDevice",
    summary: "Disable a push installation",
    description:
      "Idempotently disables the authenticated user's APNs installation without affecting another user's installation.",
    tags: ["Push Devices"],
    inputStructure: "detailed",
    successDescription: "The installation is disabled.",
  })
  .input(
    z.object({
      params: z.object({ installationID: installationIDSchema }),
    }),
  )
  .output(pushDeviceReceiptSchema)
  .handler(async ({ context, input }) => {
    const installationID = parseInstallationID(input.params.installationID);
    await disablePushDevice(
      context.env.COMINAVI_DB,
      context.identity,
      installationID,
    );
    return { installationID, enabled: false };
  });

export const pushDeviceRouter = {
  register: registerPushDeviceOperation,
  disable: disablePushDeviceOperation,
};
