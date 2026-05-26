import cloudflareTunnelGateway, { CaptunServerShard, type CaptunEnv } from "../worker.js";
import { hostedCaptunResponse } from "./site.js";

export { CaptunServerShard };

export default {
  fetch(request: Request, env: CaptunEnv): Response | Promise<Response> {
    const hostedResponse = hostedCaptunResponse(request);
    if (hostedResponse) return hostedResponse;
    return cloudflareTunnelGateway.fetch(request, env);
  },
} satisfies ExportedHandler<CaptunEnv>;
