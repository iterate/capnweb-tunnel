import cloudflareTunnelGateway, { CaptunServerShard, type CaptunEnv } from "../worker.js";
import { GATEWAY_CONNECT_QUERY_PARAM } from "../routing.js";
import { hostedCaptunResponse } from "./site.js";

export { CaptunServerShard };

export default {
  fetch(request: Request, env: CaptunEnv): Response | Promise<Response> {
    if (isGatewayConnectRequest(request)) {
      return cloudflareTunnelGateway.fetch(request, env);
    }

    const hostedResponse = hostedCaptunResponse(request);
    if (hostedResponse) return hostedResponse;
    return cloudflareTunnelGateway.fetch(request, env);
  },
} satisfies ExportedHandler<CaptunEnv>;

function isGatewayConnectRequest(request: Request) {
  return new URL(request.url).searchParams.get(GATEWAY_CONNECT_QUERY_PARAM) === "1";
}
