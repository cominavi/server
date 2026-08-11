import {
  bearerToken,
  verifyCominaviJWT,
  type CominaviIdentity,
} from "./cominavi-auth";
import { resolveAuthenticatedUser } from "./users";

export async function authenticateRequestWithBindings(
  request: Request,
  bindings: Pick<Cloudflare.Env, "COMINAVI_DB" | "COMINAVI_JWT_SECRET">,
): Promise<CominaviIdentity> {
  const tokenIdentity = await verifyCominaviJWT(
    bearerToken(request),
    bindings.COMINAVI_JWT_SECRET,
  );
  return resolveAuthenticatedUser(bindings.COMINAVI_DB, tokenIdentity);
}
