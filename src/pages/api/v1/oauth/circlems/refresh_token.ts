import type { APIRoute } from "astro";

export const prerender = false;

export interface AuthorizationCodeSuccessResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: unknown;
}

function isAuthorizationCodeSuccessResponse(
  response: any,
): response is AuthorizationCodeSuccessResponse {
  return (
    typeof response === "object" &&
    typeof response.access_token === "string" &&
    typeof response.token_type === "string" &&
    typeof response.refresh_token === "string" &&
    Object.hasOwn(response, "expires_in")
  );
}

interface AuthorizationCodeErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
}

function isAuthorizationCodeErrorResponse(
  response: any,
): response is AuthorizationCodeErrorResponse {
  return typeof response === "object" && typeof response.error === "string";
}

function verifyCirclemsOrigin(origin: string): URL | null {
  const u = new URL(origin);
  if (u.protocol !== "https:" || !u.hostname.endsWith("circle.ms")) {
    return null;
  }
  return u;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const {
    COMINAVI_CIRCLEMS_ORIGIN,
    COMINAVI_OAUTH_CIRCLEMS_CLIENT_ID,
    COMINAVI_OAUTH_CIRCLEMS_CLIENT_SECRET,
  } = locals.runtime.env;

  const origin = verifyCirclemsOrigin(COMINAVI_CIRCLEMS_ORIGIN);
  if (!origin) {
    return Response.json(
      {
        error:
          "Invalid COMINAVI_CIRCLEMS_ORIGIN. Please check the configuration.",
      },
      { status: 500 },
    );
  }

  const { refresh_token } = await request.json();
  if (!refresh_token) {
    return Response.json(
      {
        error: "refresh_token is required",
      },
      { status: 400 },
    );
  }

  const response = await fetch(new URL(`${origin.origin}/OAuth2/Token`), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh_token,
      client_id: COMINAVI_OAUTH_CIRCLEMS_CLIENT_ID,
      client_secret: COMINAVI_OAUTH_CIRCLEMS_CLIENT_SECRET,
    }),
  });

  const text = await response.text();
  if (
    (response.headers.get("Content-Type") ?? "").indexOf("application/json") ===
    -1
  ) {
    console.error(
      "Failed to fetch token: server responded with non-JSON content. status:",
      response.status,
      "content:",
      text,
    );
    return Response.json(
      {
        error: "invalid_server_response_text",
      },
      { status: 500 },
    );
  }

  const json = JSON.parse(text);

  if (isAuthorizationCodeErrorResponse(json)) {
    return Response.json(
      {
        error: "authorization_code_error",
        external_error: json.error,
        external_error_description: json.error_description,
        external_error_uri: json.error_uri,
      },
      { status: 400 },
    );
  }

  if (isAuthorizationCodeSuccessResponse(json)) {
    return Response.json({
      status: "succeeded",
      token_type: json.token_type,
      access_token: json.access_token,
      expires_in: json.expires_in,
      refresh_token: json.refresh_token,
    });
  }

  return Response.json(
    {
      status: "failed",
      error: "invalid_server_response",
    },
    { status: 400 },
  );
};
