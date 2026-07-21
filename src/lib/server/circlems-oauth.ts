export interface CirclemsTokenSuccessResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: unknown;
}

export interface CirclemsTokenErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
}

interface CirclemsTokenEndpoint {
  environment: "production" | "sandbox";
  origin: string;
  clientId: string;
  clientSecret: string;
}

export interface CirclemsEnvironmentBindings {
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN: string;
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID: string;
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET: string;
}

export interface CirclemsTokenExchangeFailure {
  environment: CirclemsTokenEndpoint["environment"];
  kind: "configuration" | "network" | "non_json" | "oauth" | "invalid_response";
  status?: number;
  oauthError?: CirclemsTokenErrorResponse;
}

export type CirclemsTokenExchangeResult =
  | {
      ok: true;
      environment: CirclemsTokenEndpoint["environment"];
      token: CirclemsTokenSuccessResponse;
    }
  | {
      ok: false;
      failures: CirclemsTokenExchangeFailure[];
    };

function getTokenEndpoints(
  bindings: CirclemsEnvironmentBindings,
): readonly CirclemsTokenEndpoint[] {
  return [
    {
      environment: "production",
      origin: bindings.COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN,
      clientId: bindings.COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID,
      clientSecret: bindings.COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET,
    },
    {
      environment: "sandbox",
      origin: bindings.COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN,
      clientId: bindings.COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID,
      clientSecret: bindings.COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET,
    },
  ];
}

function isTokenSuccessResponse(
  response: unknown,
): response is CirclemsTokenSuccessResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "access_token" in response &&
    typeof response.access_token === "string" &&
    "token_type" in response &&
    typeof response.token_type === "string" &&
    "refresh_token" in response &&
    typeof response.refresh_token === "string" &&
    "expires_in" in response
  );
}

function isTokenErrorResponse(
  response: unknown,
): response is CirclemsTokenErrorResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "error" in response &&
    typeof response.error === "string"
  );
}

export async function exchangeCirclemsToken(
  parameters: Record<string, string>,
  bindings: CirclemsEnvironmentBindings,
): Promise<CirclemsTokenExchangeResult> {
  const failures: CirclemsTokenExchangeFailure[] = [];

  for (const endpoint of getTokenEndpoints(bindings)) {
    if (!endpoint.origin || !endpoint.clientId || !endpoint.clientSecret) {
      failures.push({
        environment: endpoint.environment,
        kind: "configuration",
      });
      continue;
    }

    try {
      const response = await fetch(new URL("/OAuth2/Token", endpoint.origin), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          ...parameters,
          client_id: endpoint.clientId,
          client_secret: endpoint.clientSecret,
        }),
      });

      const contentType = response.headers.get("Content-Type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        failures.push({
          environment: endpoint.environment,
          kind: "non_json",
          status: response.status,
        });
        continue;
      }

      const body: unknown = await response.json();
      if (response.ok && isTokenSuccessResponse(body)) {
        return {
          ok: true,
          environment: endpoint.environment,
          token: body,
        };
      }

      failures.push({
        environment: endpoint.environment,
        kind: isTokenErrorResponse(body) ? "oauth" : "invalid_response",
        status: response.status,
        oauthError: isTokenErrorResponse(body) ? body : undefined,
      });
    } catch {
      failures.push({
        environment: endpoint.environment,
        kind: "network",
      });
    }
  }

  console.error(
    "Circle.ms token exchange failed in every environment:",
    failures.map(({ environment, kind, status, oauthError }) => ({
      environment,
      kind,
      status,
      externalError: oauthError?.error,
    })),
  );

  return { ok: false, failures };
}
