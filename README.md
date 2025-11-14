# mini-tds

`mini-tds` is a Cloudflare Worker for geo/device-based redirects with a lightweight
admin surface. The Worker automatically bootstraps its configuration into Cloudflare
KV, keeps an in-memory cache with TTL, and exposes a protected HTTP API plus a small
`/admin` UI so you can change the routing rules without redeploying the Worker.

## Key features

- **Bootstrap from repo defaults.** On the first request the Worker copies
  `config/routes.json` (and default flags) into the `CONFIG` KV namespace and writes
  an audit entry to the `AUDIT` namespace.
- **Hot reload with cache.** Configuration is read from KV on demand and cached in
  memory for `flags.cacheTtlMs` (defaults to 60 s). Cache can be invalidated through
  the API or UI.
- **Admin API & UI.** Authenticated endpoints (`/api/routes`, `/api/flags`,
  `/api/audit`, `/api/cache/invalidate`, `/api/import`, `/api/export`) plus a single
  page app served at `/admin`. All mutations are logged to the `AUDIT` namespace.
- **ETag & audit trail.** Updates require matching `If-Match` headers to avoid lost
  updates, and every change is persisted in KV with hashes and actor metadata.
- **Safety defaults.** `/admin` responses are non-cacheable and ship with CSP and
  frame-busting headers. Admin access requires the `ADMIN_TOKEN` secret and can be
  limited to specific IPs via flags.

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

Update the file to adjust the default routing logic. The Worker will copy these rules
to KV automatically if the namespace is empty, so redeployments keep your manual
changes intact.

## Runtime configuration storage

All mutable data lives in KV:

| Namespace | Keys                     | Description                               |
|-----------|--------------------------|-------------------------------------------|
| `CONFIG`  | `CONFIG/routes`, `CONFIG/flags`, `CONFIG/metadata` | Active routes, feature flags, metadata |
| `AUDIT`   | `AUDIT/<ts>-<uuid>`      | Append-only audit log for admin actions    |

The Worker keeps an in-memory snapshot with TTL (`flags.cacheTtlMs`). Cache can be
invalidated by calling `POST /api/cache/invalidate` or clicking the button in the UI.

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
2. **Provision KV namespaces**
   ```bash
   npx wrangler kv:namespace create CONFIG
   npx wrangler kv:namespace create AUDIT
   ```
   Copy the generated IDs into `wrangler.toml` under the `[[kv_namespaces]]`
   sections.
3. **Configure the admin secret**
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```
4. **Review `wrangler.toml`**
   - Set `name` to your Worker name.
   - Configure `main` (entry script) and `compatibility_date` if needed.
   - Under `routes`, add the domains or zone patterns (for example,
     `https://example.com/*`) that should trigger the Worker.
5. **Build and publish**
   ```bash
   npm run deploy
   ```
   This command builds the Worker, embeds the fallback routes, and uploads the
   bundle to Cloudflare.
6. **Verify routing**
   Use `npx wrangler tail` to monitor requests in real time and confirm that your
   redirect rules behave as expected. Adjust `config/routes.json` and redeploy as
   needed.

## Admin API reference

All admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>` and, optionally,
will enforce an IP allow list (`flags.allowedAdminIps`).

| Method & path              | Description                              |
|--------------------------- |------------------------------------------|
| `GET /api/routes`          | Fetch current routes + ETag               |
| `PUT /api/routes`          | Replace routes (requires `If-Match`)      |
| `PATCH /api/routes/:id`    | Patch a single route                      |
| `DELETE /api/routes/:id`   | Remove a route                            |
| `POST /api/routes/validate`| Validate payload without saving           |
| `GET/PUT /api/flags`       | Fetch or update feature flags             |
| `POST /api/import`         | Import `{ routes, flags }` bundle         |
| `GET /api/export`          | Export bundle with metadata & ETag        |
| `POST /api/cache/invalidate` | Drop in-memory cache                   |
| `GET /api/audit?limit=N`   | Fetch latest audit entries                |

The `/admin` page offers a minimal UI over the same endpoints and shows audit
history.

## Cloudflare Pages / CDN configuration tips

- When connecting the Worker to an existing site, create a route in the Cloudflare
  dashboard or in `wrangler.toml` to intercept only the paths you want to manage.
- If you prefer to trigger redirects only for specific hostnames, use multiple
  routes like `https://m.example.com/*` and `https://www.example.com/casino/*`.
- For staged environments, define `[env.staging]` sections in `wrangler.toml` with
  their own `routes` and run `npm run deploy -- --env staging`.

## KV import helper

`scripts/upload-config.sh` can seed the `CONFIG` namespace without hitting the admin
API. Pass either a legacy array (`config/routes.json`) or an export bundle produced by
`GET /api/export`:

```bash
./scripts/upload-config.sh export.json
./scripts/upload-config.sh config/routes.json CONFIG
```

The script writes `CONFIG/routes`, `CONFIG/flags`, and `CONFIG/metadata` keys so the
Worker sees the new configuration on the next request.
