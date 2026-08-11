import { env } from "cloudflare:workers";
import type { CominaviIdentity } from "./cominavi-auth";
import { authenticateRequestWithBindings } from "./authenticated-request-core";

export { authenticateRequestWithBindings } from "./authenticated-request-core";

export async function authenticateRequest(
  request: Request,
  bindings: Pick<Cloudflare.Env, "COMINAVI_DB" | "COMINAVI_JWT_SECRET"> = env,
): Promise<CominaviIdentity> {
  return authenticateRequestWithBindings(request, bindings);
}
