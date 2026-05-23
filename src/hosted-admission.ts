import {
  HOSTED_CAPTUN_HOSTNAME,
  TUNNEL_OWNER_TOKEN_HEADER,
  TUNNEL_OWNER_TOKEN_QUERY_PARAM,
} from "./routing.js";

export type HostedAdmissionEnv = {
  CAPTUN_SECRET?: string;
  CUSTOM_HOSTNAME?: string;
};

export type TunnelAdmission =
  | { ok: true; ownerToken: string | undefined }
  | { ok: false; response: Response };

export function decideTunnelAdmission(input: {
  request: Request;
  env: HostedAdmissionEnv;
  activeOwnerToken: string | undefined;
}): TunnelAdmission {
  const expected = input.env.CAPTUN_SECRET ? `Bearer ${input.env.CAPTUN_SECRET}` : undefined;
  if (expected && !constantTimeEqual(input.request.headers.get("authorization") || "", expected)) {
    return { ok: false, response: new Response("Unauthorized\n", { status: 401 }) };
  }

  const ownerToken = hostedAnonymousOwnerToken(input.request, input.env);
  if (ownerToken instanceof Response) return { ok: false, response: ownerToken };

  if (input.activeOwnerToken && input.activeOwnerToken !== ownerToken) {
    return { ok: false, response: reject("Tunnel name is already connected\n", 409) };
  }

  return { ok: true, ownerToken };
}

function hostedAnonymousOwnerToken(
  request: Request,
  env: HostedAdmissionEnv,
): string | Response | undefined {
  if (env.CUSTOM_HOSTNAME !== HOSTED_CAPTUN_HOSTNAME) return undefined;
  if (env.CAPTUN_SECRET) return undefined;

  const token =
    request.headers.get(TUNNEL_OWNER_TOKEN_HEADER) ||
    new URL(request.url).searchParams.get(TUNNEL_OWNER_TOKEN_QUERY_PARAM) ||
    "";
  if (!token) return reject("Missing tunnel ownership token\n", 400);
  if (!/^[a-zA-Z0-9._~-]{1,128}$/.test(token)) {
    return reject("Invalid tunnel ownership token\n", 400);
  }

  return token;
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
  let diff = actualBytes.length ^ expectedBytes.length;
  const length = Math.max(actualBytes.length, expectedBytes.length);
  for (let index = 0; index < length; index++) {
    diff |= (actualBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }
  return diff === 0;
}
