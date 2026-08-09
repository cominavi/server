import { AuthenticationError } from "./cominavi-auth";
import { FollowingImportError } from "./following-import";
import { ServiceError } from "./service-error";

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function apiErrorResponse(error: unknown): Response {
  if (
    error instanceof AuthenticationError ||
    error instanceof FollowingImportError ||
    error instanceof ServiceError
  ) {
    return jsonResponse(
      {
        error: error.code,
        message: error.message,
        ...(error instanceof FollowingImportError && error.nextAllowedAt
          ? { nextAllowedAt: error.nextAllowedAt }
          : {}),
        ...(error instanceof ServiceError && error.details
          ? { details: error.details }
          : {}),
      },
      error.status,
    );
  }

  console.error(
    "Unhandled ComiNavi API error",
    error instanceof Error ? error.message : error,
  );
  return jsonResponse(
    { error: "internal_error", message: "The request could not be completed." },
    500,
  );
}

export async function readRequestJSON(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new FollowingImportError(
      "invalid_content_type",
      415,
      "Content-Type must be application/json.",
    );
  }
  try {
    return await request.json();
  } catch {
    throw new FollowingImportError(
      "invalid_json",
      400,
      "The request body is not valid JSON.",
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
