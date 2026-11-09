# Nova

Nova is an all-in-one web app with a proxy browser, games, AI, chat, and member features. This README describes how to host Nova and, where needed, its separate Wisp tunnel service: [johnnywalker100/nova-wisp](https://github.com/johnnywalker100/nova-wisp).

## Hosting

### Before you deploy

Nova requires Node.js 20 or later for a regular Node deployment. Configure the required `NOVA_*` environment variables listed in the source README/configuration (including the Google OAuth client, allowed email list, app path, cookie secret, and database settings). Do not commit secrets. Set the Google OAuth authorized redirect URI to `https://YOUR-NOVA-HOST/api/google`.

The `server.js` in this repository already hosts a Wisp endpoint at `/wisp/`. If you run Nova as a regular Node server, that built-in tunnel is the simplest arrangement. The separate [nova-wisp](https://github.com/johnnywalker100/nova-wisp) service is useful when the Nova website is hosted somewhere that cannot keep WebSocket connections open, such as Vercel serverless functions.

### Fly.io

Fly.io can run persistent Node/Docker services with WebSocket upgrades. Free allowances and eligibility may change; check Fly.io's current pricing before deploying.

**Run Nova and its built-in Wisp together (recommended):**

1. Install and sign in to the [Fly.io CLI](https://fly.io/docs/flyctl/install/).
2. From the Nova repository, run `fly launch --no-deploy`. Choose an app name and region. Use the included `Dockerfile` when prompted or configure Fly to build it. The Docker image listens on port `8080`; make sure the generated `fly.toml` exposes that internal port and enables HTTPS.
3. Set the required secrets, for example: `fly secrets set NOVA_WORD='...' NOVA_EMAILS='...' NOVA_GOOGLE_CLIENT_ID='...' NOVA_APP_PATH='...' NOVA_RETURN_WORD='...' NOVA_SECRET='...' NOVA_APPROVE_PIN='...' NOVA_ADMINS='...' NOVA_DB_URL='...' NOVA_DB_ANON='...' NOVA_DB_KEY='...'`.
4. Deploy with `fly deploy`, then open the HTTPS URL Fly assigns to the app. Add its `/api/google` URL to the Google OAuth client redirect URIs.
5. Check the deployment's `/api/health` endpoint and test the Browser proxy; its Wisp endpoint is on the same origin at `/wisp/`.

Use a persistent machine configuration that does not scale to zero while a WebSocket session is active. The app uses the host-provided `PORT` (or port 8080 in the Docker image).

**Run Nova-Wisp separately:**

1. Create a second Fly app from [johnnywalker100/nova-wisp](https://github.com/johnnywalker100/nova-wisp), with Node.js 20+, and deploy it as a persistent service. Its `npm start` command starts the service; expose the port supplied through `PORT` and allow WebSocket upgrades.
2. Set `ALLOWED_ORIGINS` on Nova-Wisp to Nova's exact HTTPS origin, with no trailing slash, e.g. `https://your-nova.fly.dev`.
3. For Nova hosted on Vercel, set `WISP_URL` in the Vercel project to `wss://your-wisp.fly.dev/wisp/` and redeploy. The Vercel build embeds this value into the browser configuration. When Nova itself runs with its ordinary Node server, it defaults to its own Wisp endpoint; using a separate tunnel there requires configuring the client-side `NOVA_WISP` value in `public/config.js` and rebuilding/redeploying.

### Wasmer.io

Wasmer's supported Node.js and networking capabilities can vary by deployment mode. Nova-Wisp requires a persistent Node.js process, WebSocket upgrade support, and outbound TCP/TLS networking. Do not assume a Wasmer HTTP deployment supports those features just because it can run JavaScript. Confirm the selected Wasmer service supports all of them before using it for a live tunnel.

If the selected Wasmer deployment supports those requirements:

1. Create a persistent Node.js service from [johnnywalker100/nova-wisp](https://github.com/johnnywalker100/nova-wisp), using Node.js 20 or later, `npm install` (or `npm ci`) as the install command, and `npm start` as the start command. Configure it to listen on the platform's `PORT` and enable WebSocket upgrades.
2. Set `ALLOWED_ORIGINS` to Nova's exact HTTPS origin, such as `https://your-nova.example`.
3. Confirm the platform gives the service a public TLS endpoint that supports WebSockets. The browser URL must use `wss://` and end in `/wisp/`.
4. Deploy Nova separately. Vercel is one option for the website: set `WISP_URL` to that secure WebSocket URL in Vercel's environment settings and redeploy. Configure Nova's required `NOVA_*` variables and Google OAuth redirect URI as above.
5. Test the Wisp WebSocket from the deployed Nova origin and open a site in Nova's Browser. A successful ordinary HTTP health/status request does not by itself prove WebSocket upgrades work.

If Wasmer cannot provide the persistent WebSocket service, host Nova-Wisp on Fly.io or Render instead and point Nova's `WISP_URL` there.

### Render (free-tier option, where available)

Render's free Web Services may sleep when idle and can have cold-start delays or current plan limits. Check current plan details. Nova's included `render.yaml` is a Blueprint for the Nova service, but you still need to add the required `NOVA_*` environment variables in Render's dashboard.

To deploy Nova and Nova-Wisp as separate services:

1. Create a Render Web Service from this repository for Nova. Use `npm ci` as the build command and `npm start` as the start command; set the Nova environment variables. Nova's own Node server includes Wisp, so this service can instead run the site and tunnel together.
2. If separating the tunnel, create another Web Service from [johnnywalker100/nova-wisp](https://github.com/johnnywalker100/nova-wisp), with `npm ci` for build and `npm start` for start.
3. Set Nova-Wisp's `ALLOWED_ORIGINS` to Nova's exact HTTPS origin. Set Nova's client `NOVA_WISP` URL to `wss://YOUR-WISP-SERVICE.onrender.com/wisp/` (or set `WISP_URL` at build time for a Vercel-hosted Nova). For a regular Node-hosted Nova, `public/config.js` is the client config to edit if using an external tunnel.
4. Add Nova's `/api/google` endpoint to the Google OAuth redirect URIs, deploy both services, and verify the Wisp WebSocket and proxy browser.

### Vercel (website) with Fly.io, Render, or Wasmer Wisp

Vercel builds Nova's static files using `build.mjs` and serves API functions from `api/` with the access gate in `middleware.js`. Vercel cannot host the persistent Wisp tunnel, so run [johnnywalker100/nova-wisp](https://github.com/johnnywalker100/nova-wisp) as a separate service on a host that supports WebSockets.

1. Import this repository into Vercel and add the required `NOVA_*` variables.
2. Deploy Nova-Wisp to Fly.io, Render, or another persistent Node/WebSocket host. Set its `ALLOWED_ORIGINS` to the exact Vercel site origin.
3. Add `WISP_URL=wss://YOUR-WISP-HOST/wisp/` to the Vercel environment variables and redeploy Nova. `build.mjs` embeds `WISP_URL` in the built client configuration.
4. Add `https://YOUR-VERCEL-DOMAIN/api/google` to the Google OAuth authorized redirect URIs.

The Vercel site and Wisp service must use HTTPS/WSS, and Nova-Wisp must allow the deployed site's origin. The app's Games and AI can work without the tunnel, but its proxy Browser needs the Wisp connection.

### Other hosts and Docker

Any host that provides Node.js 20+, a persistent process, HTTPS, and WebSocket upgrades can run Nova directly with `npm ci` followed by `npm start`. Railway, Koyeb, and similar providers may have changing free tiers or usage limits; check current pricing and confirm WebSocket support before choosing one. Configure the required environment variables and make sure the host forwards its assigned `PORT`.

The included Dockerfile can be used on a VPS or any container host:

```bash
docker build -t nova .
docker run -p 8080:8080 --env-file .env nova
```

Keep the container running persistently and put it behind HTTPS (for example, through the host's TLS proxy). With this setup Nova and its built-in Wisp endpoint run in the same service; no separate Nova-Wisp deployment is necessary.
