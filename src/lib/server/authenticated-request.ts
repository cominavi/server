import { env } from "cloudflare:workers";
import {
  bearerToken,
  verifyCominaviJWT,
  type CominaviIdentity,
} from "./cominavi-auth";
import { assertCurrentAuthVersion } from "./users";

export async function authenticateRequest(
  request: Request,
  bindings: Pick<Cloudflare.Env, "COMINAVI_DB" | "COMINAVI_JWT_SECRET"> = env,
): Promise<CominaviIdentity> {
  const identity = await verifyCominaviJWT(
    bearerToken(request),
    bindings.COMINAVI_JWT_SECRET,
  );
  await assertCurrentAuthVersion(bindings.COMINAVI_DB, identity);
  return identity;
}
