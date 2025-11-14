# No-CLI Setup Guide

This guide walks through deploying `mini-tds` using only the Cloudflare
Dashboard—no Wrangler CLI required. You will build the Worker bundle locally (or
in any environment with Node.js), upload it through the Dashboard, and finish
configuration with point-and-click steps.

## 1. Prepare your repository

1. Fork the `mini-tds` repository into your own GitHub account (or create a new
   private copy).
2. Review `config/routes.json` and update the default rules to match the initial
   behavior you want after the Worker boots for the first time. You can always
   change them later from the admin UI.

## 2. Build the Worker bundle

1. Install dependencies and bundle the Worker module:

   ```bash
   npm install
   npm run build
   ```

2. The compiled Worker is written to `dist/worker.js`. This is the single file
   you will upload to Cloudflare.

> Tip: You can run the build in GitHub Codespaces or any online Node.js
> environment if you do not want to set up Node locally.

## 3. Create the Worker in Cloudflare Dashboard

1. Sign in to the Cloudflare Dashboard and navigate to **Workers & Pages**.
2. Click **Create application → Worker** and choose **Deploy a Worker → Upload**.
3. Select **Module Worker** when prompted, then upload the `dist/worker.js`
   bundle.
4. Give the Worker a name and click **Deploy**. Cloudflare will assign a
   temporary `*.workers.dev` hostname that you can use to verify the Worker.

## 4. Verify the Worker is live

1. Visit the `*.workers.dev` URL created in the previous step. You should see
   the origin website load (or the fallback response if no origin routes are
   configured yet).
2. Append `/admin` to the Worker hostname. You should see the admin UI with a
   banner explaining that bindings are not configured yet. This confirms the
   bundle is active.

## 5. Bind your production domain or route

1. In the Worker view, open the **Triggers** tab.
2. Under **Routes**, click **Add route** and specify the hostname and path
   pattern (for example, `https://example.com/*`) that should run through the
   Worker.
3. Save the trigger. Requests matching the pattern now invoke `mini-tds`.

## 6. Create the KV namespaces

1. Open the **Settings → Bindings** tab for the Worker.
2. Under **KV Namespace Bindings**, click **Add binding**.
3. Set **Variable name** to `CONFIG` and click **Create a namespace**. Give the
   namespace a recognizable name (for example, `mini-tds-config`) and save.
4. Repeat the process to create a second namespace with **Variable name** set to
   `AUDIT`.

## 7. Add the admin token secret

1. While still in **Settings → Bindings**, scroll to **Secrets**.
2. Click **Add**, set **Variable name** to `ADMIN_TOKEN`, and paste a strong
   random token value.
3. Save the secret. You will use this token to authenticate against the admin UI
   and API.

## 8. Boot the configuration

1. Open `https://<your-worker-hostname>/admin?token=<ADMIN_TOKEN>`. Replace the
   placeholders with the actual hostname and token value you just configured.
2. The admin UI will automatically copy `config/routes.json` into the `CONFIG`
   namespace (together with default flags) and refresh the view once data is in
   place.
3. Use the **Publish** button to save any changes you make to routes or flags.
   Every mutation is logged to the `AUDIT` namespace.

## 9. Ongoing maintenance

- **Updating Worker code.** Whenever you change the codebase, rebuild the bundle
  with `npm run build`, upload the new `dist/worker.js`, and publish a new
  deployment from the Dashboard.
- **Editing routes.** Use the `/admin` UI or call the authenticated `/api/*`
  endpoints. No redeploy is necessary for configuration changes.
- **Restoring defaults.** Delete the `CONFIG` keys from the Dashboard KV browser
  and reload `/admin` to copy the defaults from the repository again.

## Troubleshooting checklist

- The admin UI refuses to save changes: confirm both `CONFIG` and `AUDIT`
  bindings are attached and the Worker has permission to write to them.
- `/admin` returns `401 Unauthorized`: make sure you pass the `ADMIN_TOKEN` in
  the `Authorization: Bearer <token>` header or via the `?token=` query string
  parameter.
- Requests to your SPA routes return the origin content instead of redirects:
  verify that your custom rule `match.path` expressions actually match those
  URLs. Unmatched requests intentionally fall back to the origin to avoid
  breaking existing applications.
