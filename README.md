# mini-tds

`mini-tds` is a Cloudflare Worker for geo/device-based redirects with a lightweight
admin surface. The Worker automatically bootstraps its configuration into Cloudflare
KV, keeps an in-memory cache with TTL, and exposes a protected HTTP API plus a small
`/admin` UI so you can change the routing rules without redeploying the Worker.

## Key features

- **Bootstrap from repo defaults.** On the first request the Worker copies
  `config/routes.json` (and default flags) into the `CONFIG` KV namespace and writes
  an audit entry to the `AUDIT` namespace.
- **Out-of-the-box fallback.** Without KV bindings the Worker serves the embedded
  routes in read-only mode, keeps the admin UI disabled for mutations, and shows a
  setup banner so you can attach bindings later.
- **Hot reload with cache.** Configuration is read from KV on demand and cached in
  memory for `flags.cacheTtlMs` (defaults to 60 s). Cache can be invalidated through
  the API or UI.
- **Admin API & UI.** Authenticated endpoints (`/api/routes`, `/api/routes/:id`,
  `/api/routes/validate`, `/api/flags`, `/api/audit`, `/api/cache/invalidate`,
  `/api/import`, `/api/export`) plus a single page app served at `/admin`. All
  mutations are logged to the `AUDIT` namespace.
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
   device, bot flag, and path. `match.path` values are interpreted as JavaScript
   regular expressions.
5. Execute the configured action: build a redirect URL (optionally copying the
   original query string, projecting regex capture groups, or appending country
   and device) or return a custom response.
6. Return the action result. If no rule matches, transparently proxy the request
   to the origin.

## Configuration schema

The Worker ships with `config/routes.json`. On first run the bundle is written to the
`CONFIG` namespace together with default flags, so you can edit data in KV without
redeploying.

### Route rules

Routes are stored as an array of `RouteRule` objects. A rule has the shape:

```json
{
  "id": "rule-id",
  "enabled": true,
  "match": {
    "path": ["^/casino/([^/?#]+)"],
    "countries": ["RU"],
    "devices": ["mobile"],
    "bots": false
  },
  "action": {
    "type": "redirect",
    "target": "https://example.com/landing",
    "query": {
      "bonus": { "fromPathGroup": 1 },
      "campaign": { "literal": "spring" }
    },
    "preserveOriginalQuery": false,
    "extraQuery": { "src": "mobile-geo" },
    "appendCountry": true,
    "appendDevice": true,
    "status": 302
  }
}
```

#### `match`

- `path` – string or array of strings. Each entry is treated as a JavaScript regular
  expression executed against `request.pathname`. Capture groups can later be used in
  the redirect query string.
- `countries` – optional ISO country allow list (uppercase two-letter codes).
- `devices` – optional list of allowed device types (`mobile`, `desktop`, `tablet`, or
  `any`).
- `bots` – optional boolean. When `true` the rule applies only to bots; when `false`
  bots are excluded.

#### `action`

Two action types are supported:

- `redirect`
  - `target` – absolute URL the request should be redirected to.
  - `status` – HTTP status code (defaults to `302`).
  - `query` – optional object that maps parameter names to:
    - a primitive value (`string`, `number`, or `boolean`),
    - `{ "fromPathGroup": n }` to copy the `n`-th capture group from the matched
      path (defaults to `0`), or
    - `{ "literal": value }` to set a fixed string.
  - `preserveOriginalQuery` – when `true`, copy the incoming query string to the
    redirect target.
  - `extraQuery` – additional static query parameters.
  - `appendCountry` / `appendDevice` – when `true`, append detected values as
    `country` / `device` query params.
- `response`
  - `status` – HTTP status code (defaults to `200`).
  - `headers` – optional response headers.
  - `bodyHtml` / `bodyText` – HTML or plain text payload.

Set `enabled` to `false` to skip a rule without removing it.

### Flags

Flags are stored under `CONFIG/flags` and follow this structure:

| Flag | Description |
|------|-------------|
| `cacheTtlMs` | TTL for the in-memory config cache (minimum 5 s). |
| `strictBots` | When `true`, augment bot detection with `googleBots` and `yandexBots`. |
| `yandexBots`, `googleBots` | Lists of substrings that identify search bots. |
| `allowedAdminIps` | Optional allow list for admin IPs. Empty list disables the check. |
| `uiTitle` | `<title>` for the admin UI. |
| `uiReadonly` | Disable mutations from the admin UI while keeping read access. |
| `uiReadOnlyBanner` | Optional message displayed above the controls when the UI is read-only. |
| `webhookUrl` | Optional callback URL for future integrations (not used yet). |

Metadata describing the last update is stored under `CONFIG/metadata`.

## Runtime configuration storage

All mutable data lives in KV:

| Namespace | Keys | Description |
|-----------|------|-------------|
| `CONFIG`  | `CONFIG/routes`, `CONFIG/flags`, `CONFIG/metadata` | Active routes, feature flags, metadata |
| `AUDIT`   | `AUDIT/<ts>-<uuid>` | Append-only audit log for admin actions |

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

> Need to deploy entirely from the Cloudflare Dashboard without Wrangler? Follow
> the [No-CLI Setup Guide](docs/no-cli-setup.md).

1. **Authenticate Wrangler**
   ```bash
   npm install
   npx wrangler login
   ```
   Log into your Cloudflare account to let Wrangler manage Workers on your
   behalf.
2. **Provision KV namespaces**
   ```bash
   npx wrangler kv:namespace create --namespace mini-tds-config --binding CONFIG
   npx wrangler kv:namespace create --namespace mini-tds-audit --binding AUDIT
   ```
   Feel free to tweak the namespace names, but keep them distinct. Copy the
   generated IDs into `wrangler.toml` under the `[[kv_namespaces]]` sections.
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

### Attaching bindings in Cloudflare Dashboard

If you deploy the Worker from the Dashboard (or want to add bindings after the
fact) you do not need to redeploy:

1. Open **Workers & Pages → _Your worker_ → Settings → Bindings**.
2. Under **KV Namespace Bindings**, click **Add**, set **Binding name** to
   `CONFIG`, and create or select a namespace. Repeat for the `AUDIT` binding.
3. Under **Secrets**, click **Add**, set **Variable name** to `ADMIN_TOKEN`, and
   supply your admin token value.

### Manual bundle for dashboard uploads

If you prefer to upload the Worker bundle manually (for example when using the
Cloudflare Dashboard), build the module locally:

```bash
npm install
npm run build
```

The compiled Worker is written to `dist/worker.js`. Upload that file via
**Workers & Pages → Your worker → Deployments → Upload Worker** and publish the
new revision.

## Origin compatibility

The Worker is safe to attach to existing single page applications:

- All non-`GET` requests are forwarded straight to the origin without any
  matching logic.
- `GET` requests that do not match a routing rule are proxied as-is to the
  origin.

These behaviors guarantee that API calls, form submissions, and SPA client-side
routes continue to work unless you explicitly configure a matching rule.

As soon as the bindings are attached Cloudflare updates the environment
automatically. Refresh `/admin?token=…`: the Worker will bootstrap KV with the
embedded defaults (if it hasn't already) and unlock full CRUD functionality in
the admin UI.

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
