/**
 * Cloudflare Worker entry: forwards requests to bundled static assets.
 * Requires `npm run build` before deploy so `./dist` exists.
 */
export default {
  /** @param {Request} request @param {{ ASSETS?: { fetch(request: Request): Promise<Response> } }} env */
  async fetch(request, env) {
    const assets = env.ASSETS;
    if (!assets?.fetch) {
      return new Response("ASSETS binding missing — check wrangler.toml [assets]", {
        status: 500,
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    }
    return assets.fetch(request);
  },
};
