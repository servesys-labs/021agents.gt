/**
 * Portal worker — serves static assets + exposes CF Access token endpoint.
 *
 * CF Access sets CF_Authorization as HttpOnly, so client JS can't read it.
 * This worker reads the cookie server-side and returns the JWT to the client.
 */

interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Expose CF Access token to the client SPA
    if (url.pathname === "/__auth/token") {
      const cookie = request.headers.get("Cookie") || "";
      const match = cookie.match(/CF_Authorization=([^;]+)/);
      const cfToken = match?.[1] || "";

      // Also check the header (belt + suspenders)
      const headerToken = request.headers.get("Cf-Access-Jwt-Assertion") || "";

      const token = cfToken || headerToken;
      if (!token) {
        return Response.json({ token: null }, { status: 401 });
      }
      return Response.json({ token });
    }

    // Everything else: serve static assets
    return env.ASSETS.fetch(request);
  },
};
