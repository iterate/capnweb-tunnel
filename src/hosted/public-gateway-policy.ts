import { CONNECT_TOKEN_QUERY_PARAM } from "../routing.js";
import type { TunnelAdmission } from "../worker.js";

export type PublicGatewayPolicyEnv = {
  CAPTUN_TOKEN?: string;
};

export function decidePublicTunnelAdmission(input: {
  request: Request;
  env: PublicGatewayPolicyEnv;
  activeToken: string | undefined;
}): TunnelAdmission {
  const configuredToken = input.env.CAPTUN_TOKEN;
  const token = connectToken(input.request) || undefined;
  if (configuredToken) {
    if (!token || !constantTimeEqual(token, configuredToken)) {
      return { ok: false, response: reject("Unauthorized\n", 401) };
    }
    return { ok: true, token };
  }

  if (!token) return { ok: false, response: reject("Missing tunnel token\n", 400) };
  if (!/^[a-zA-Z0-9._~-]{1,128}$/.test(token)) {
    return { ok: false, response: reject("Invalid tunnel token\n", 400) };
  }
  if (input.activeToken && input.activeToken !== token) {
    return { ok: false, response: reject("Tunnel name is already connected\n", 409) };
  }

  return { ok: true, token };
}

function connectToken(request: Request) {
  return new URL(request.url).searchParams.get(CONNECT_TOKEN_QUERY_PARAM);
}

function reject(body: string, status: number) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function constantTimeEqual(actual: string, expected: string) {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  let diff = 0;
  for (let index = 0; index < actualBytes.length; index++) {
    diff |= actualBytes[index]! ^ expectedBytes[index]!;
  }
  return diff === 0;
}
