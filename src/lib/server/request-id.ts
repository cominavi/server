import { ServiceError } from "./service-error";

const canonicalUUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseCanonicalRequestID(value: unknown): string {
  if (typeof value !== "string") throw invalidRequestID();
  if (!canonicalUUID.test(value)) throw invalidRequestID();
  return value;
}

function invalidRequestID(): ServiceError {
  return new ServiceError(
    "invalid_request_id",
    400,
    "requestId must be a canonical UUID.",
  );
}
