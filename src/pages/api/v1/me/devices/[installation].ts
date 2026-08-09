import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  apiErrorResponse,
  jsonResponse,
  readRequestJSON,
} from "../../../../../lib/server/api-response";
import { authenticateRequest } from "../../../../../lib/server/authenticated-request";
import {
  disablePushDevice,
  parseDeviceRegistration,
  parseInstallationID,
  registerPushDevice,
} from "../../../../../lib/server/push-devices";

export const prerender = false;

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const identity = await authenticateRequest(request);
    const installationID = parseInstallationID(params.installation);
    const registration = parseDeviceRegistration(
      await readRequestJSON(request),
      env.COMINAVI_APNS_BUNDLE_IDS,
    );
    return jsonResponse(
      await registerPushDevice(
        env.COMINAVI_DB,
        identity,
        installationID,
        registration,
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const identity = await authenticateRequest(request);
    const installationID = parseInstallationID(params.installation);
    await disablePushDevice(env.COMINAVI_DB, identity, installationID);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
};
