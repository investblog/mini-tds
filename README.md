# mini-tds

`mini-tds` is a minimal Cloudflare Worker for geo/device-based redirects. All routing
rules live in `config/routes.json` and are embedded at build time, so the Worker
always serves the latest configuration without relying on KV storage.

## Worker workflow

1. Forward every non-`GET` request directly to the origin.
2. Collect request context from Cloudflare (country) and headers (`User-Agent`,
   `Sec-CH-UA-*`).
3. Detect the device type (`desktop`, `mobile`, `tablet`) and whether the request
   was issued by a search bot.
4. Pick the first rule from `config/routes.json` that matches the country,
   device, bot flag, and path (`*` masks and regular expressions are supported).
5. Build a target URL, optionally appending the original path, forwarding the
   query string, or extracting the first path segment into a custom parameter.
6. Return a 30x redirect. If no rule matches, transparently proxy the request to
   the origin.

## Editing `config/routes.json`

Each rule contains:

- `match.path` – list of glob masks (for example `/casino/*`) that must match the
  request `pathname`.
- `match.pattern` – additional regular expressions (optional).
- `match.countries` – ISO country codes (optional).
- `match.devices` – allowed devices (`mobile`, `desktop`, `tablet`, `any`).
- `match.bot` – when `false`, the rule ignores search bots.
- `target` – base redirect URL.
- `appendPath` – append the original path to `target`.
- `forwardQuery` – forward the original query string.
- `extraParams` – extra query parameters. Keys that start with `__` are reserved
  for advanced options such as `__pathToParam` (store the first path segment in a
  query parameter) and `__stripPrefix` (remove a prefix before extraction).
- `trackingParam` / `trackingValue` – quick way to add a tracking tag.

Update the file to reflect your routing logic, rebuild, and redeploy the Worker.

## Local development

```bash
npm install
npm run dev
```

The Worker runs at `http://127.0.0.1:8787`. Change the `User-Agent` or
`Sec-CH-UA-Mobile` headers to emulate different devices.

## Cloudflare deployment guide

1. **Authenticate Wrangler**
   ```bash
   npm install
   npx wrangler login
   ```
   Log into your Cloudflare account to let Wrangler manage Workers on your
   behalf.
2. **Review `wrangler.toml`**
   - Set `name` to your Worker name.
   - Configure `main` (entry script) and `compatibility_date` if needed.
   - Under `routes`, add the domains or zone patterns (for example,
     `https://example.com/*`) that should trigger the Worker.
3. **Build and publish**
   ```bash
   npm run deploy
   ```
   This command builds the Worker, embeds `config/routes.json`, and uploads the
   bundle to Cloudflare.
4. **Bind environment variables (optional)**
   If you need KV namespaces, Durable Objects, or secrets for your own workflow,
   add them to `wrangler.toml` and bind via `npx wrangler kv:namespace create`,
   `npx wrangler deploy --env production`, or `npx wrangler secret put`.
5. **Verify routing**
   Use `npx wrangler tail` to monitor requests in real time and confirm that your
   redirect rules behave as expected. Adjust `config/routes.json` and redeploy as
   needed.

## Cloudflare Pages / CDN configuration tips

- When connecting the Worker to an existing site, create a route in the Cloudflare
  dashboard or in `wrangler.toml` to intercept only the paths you want to manage.
- If you prefer to trigger redirects only for specific hostnames, use multiple
  routes like `https://m.example.com/*` and `https://www.example.com/casino/*`.
- For staged environments, define `[env.staging]` sections in `wrangler.toml` with
  their own `routes` and run `npm run deploy -- --env staging`.

## Legacy KV upload script

The script `scripts/upload-config.sh` remains for backwards compatibility. It
publishes `config/config.json` to a KV namespace bound as `CONFIG`. Use it if you
still maintain a heavier configuration in KV or need to sync with external
systems.
