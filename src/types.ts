/** Fetch is all you need!
 *
 * Cap'n Web let us pass this fetcher from the
 * tunnel client to the server via fetch (via websockets)
 * Then the server can just fetch into the client like normal.
 * This is all possible because Cap'n Web can pass Request and Response object
 * across the websocket RPC boundary transparently
 **/
export interface Fetcher {
  fetch(request: Request): Response | Promise<Response>;
}
