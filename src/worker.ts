// src/worker.ts
import DEFAULT_ROUTES from "../config/routes.json" assert { type: "json" };

/** ----------------------------- Environment types ----------------------------- */
export interface Env {
  CONFIG: KVNamespace;
  AUDIT: KVNamespace;
  ADMIN_TOKEN: string;
  CONFIG_KEY_ROUTES?: string;
  CONFIG_KEY_FLAGS?: string;
  CONFIG_KEY_METADATA?: string;
  CONFIG_VERSION?: string;
}

/** ----------------------------- Configuration types ----------------------------- */
export type Device = "mobile" | "desktop" | "tablet" | "any";

export interface MatchRule {
  path?: string | string[];
  countries?: string[];
  devices?: Device[];
  bots?: boolean;
}

export interface RedirectQueryValue {
  fromPathGroup?: number;
  literal?: string;
}

export interface RedirectAction {
  type: "redirect";
  target: string;
  status?: number;
  query?: Record<string, string | number | boolean | RedirectQueryValue>;
  preserveOriginalQuery?: boolean;
  extraQuery?: Record<string, string>;
  appendCountry?: boolean;
  appendDevice?: boolean;
}

export interface ResponseAction {
  type: "response";
  status?: number;
  headers?: Record<string, string>;
  bodyHtml?: string;
  bodyText?: string;
}

export type RouteAction = RedirectAction | ResponseAction;

export interface RouteRule {
  id: string;
  enabled?: boolean;
  match: MatchRule;
  action: RouteAction;
}

export interface FlagsConfig {
  cacheTtlMs: number;
  strictBots: boolean;
  yandexBots: string[];
  googleBots: string[];
  allowedAdminIps: string[];
  uiTitle: string;
  uiReadonly: boolean;
  webhookUrl?: string;
}

export interface MetadataRecord {
  version: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ConfigBundle {
  routes: RouteRule[];
  flags: FlagsConfig;
  metadata: MetadataRecord;
  etag: string;
  loadedAt: number;
  expiresAt: number;
}

export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  prevHash?: string;
  newHash?: string;
  diffBytes?: number;
  note?: string;
  error?: string;
}

/** ----------------------------- Constants ----------------------------- */
const DEFAULT_FLAGS: FlagsConfig = {
  cacheTtlMs: 60_000,
  strictBots: true,
  yandexBots: ["YandexBot", "YandexMobileBot"],
  googleBots: ["Googlebot", "AdsBot-Google-Mobile"],
  allowedAdminIps: [],
  uiTitle: "mini-tds admin",
  uiReadonly: false,
};

const CONFIG_PREFIX = "CONFIG";
const AUDIT_PREFIX = "AUDIT";
const MIN_TTL = 5_000;

/** ----------------------------- Global state ----------------------------- */
let cachedConfig: ConfigBundle | null = null;
let initPromise: Promise<void> | null = null;

/** ----------------------------- Utilities ----------------------------- */
function nowIso(): string {
  return new Date().toISOString();
}

function configKey(env: Env, suffix: string): string {
  const key =
    suffix === "routes"
      ? env.CONFIG_KEY_ROUTES || "routes"
      : suffix === "flags"
      ? env.CONFIG_KEY_FLAGS || "flags"
      : env.CONFIG_KEY_METADATA || "metadata";
  return `${CONFIG_PREFIX}/${key}`;
}

function auditKey(): string {
  const ts = nowIso();
  const id = crypto.randomUUID();
  return `${AUDIT_PREFIX}/${ts}-${id}`;
}

async function hashText(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const arr = Array.from(new Uint8Array(digest));
  const hex = arr.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function ensureArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (typeof value === "undefined") return undefined;
  return Array.isArray(value) ? value : [value];
}

function parseJsonBody<T>(body: string | null): T {
  if (!body) throw new Error("Empty body");
  return JSON.parse(body) as T;
}

function copyHeaders(headers: Record<string, string> | undefined): Headers {
  const h = new Headers();
  if (!headers) return h;
  Object.entries(headers).forEach(([key, value]) => {
    if (value !== undefined) h.set(key, value);
  });
  return h;
}

function maskToken(token: string | undefined): string {
  if (!token) return "<empty>";
  if (token.length <= 4) return "****";
  return `${token.slice(0, 2)}****${token.slice(-2)}`;
}

function buildActor(request: Request): string {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
  return `admin@ip-${ip}`;
}

function readAdminToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  return token;
}

function isIpAllowed(ip: string | undefined | null, flags: FlagsConfig): boolean {
  if (!flags.allowedAdminIps || flags.allowedAdminIps.length === 0) return true;
  if (!ip) return false;
  return flags.allowedAdminIps.includes(ip.trim());
}

async function writeAudit(env: Env, entry: AuditEntry): Promise<void> {
  try {
    await env.AUDIT.put(auditKey(), JSON.stringify(entry));
  } catch (error) {
    console.error("Failed to write audit entry", error);
  }
}

async function loadRawConfig(env: Env): Promise<{
  routes: RouteRule[];
  flags: FlagsConfig;
  metadata: MetadataRecord;
}> {
  const [routes, flags, metadata] = await Promise.all([
    env.CONFIG.get<RouteRule[]>(configKey(env, "routes"), "json"),
    env.CONFIG.get<FlagsConfig>(configKey(env, "flags"), "json"),
    env.CONFIG.get<MetadataRecord>(configKey(env, "metadata"), "json"),
  ]);

  return {
    routes: routes ?? [],
    flags: flags ?? DEFAULT_FLAGS,
    metadata: metadata ?? {
      version: env.CONFIG_VERSION || "1",
      updatedAt: nowIso(),
      updatedBy: "unknown",
    },
  };
}

async function computeEtag(bundle: {
  routes: RouteRule[];
  flags: FlagsConfig;
  metadata: MetadataRecord;
}): Promise<string> {
  const payload = JSON.stringify({
    routes: bundle.routes,
    flags: bundle.flags,
    version: bundle.metadata.version,
  });
  return hashText(payload);
}

async function hydrateCache(env: Env, forceReload = false): Promise<ConfigBundle> {
  if (!forceReload && cachedConfig && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig;
  }
  const raw = await loadRawConfig(env);
  const etag = await computeEtag(raw);
  const ttl = Math.max(raw.flags.cacheTtlMs || 60_000, MIN_TTL);
  cachedConfig = {
    routes: raw.routes,
    flags: raw.flags,
    metadata: raw.metadata,
    etag,
    loadedAt: Date.now(),
    expiresAt: Date.now() + ttl,
  };
  return cachedConfig;
}

function invalidateCache(): void {
  cachedConfig = null;
}

async function ensureConfigInitialized(env: Env): Promise<void> {
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    const metadata = await env.CONFIG.get<MetadataRecord>(
      configKey(env, "metadata"),
      "json"
    );
    if (metadata) {
      return;
    }

    const routes = (DEFAULT_ROUTES as RouteRule[]) ?? [];
    const flags = DEFAULT_FLAGS;
    const meta: MetadataRecord = {
      version: env.CONFIG_VERSION || "1",
      updatedAt: nowIso(),
      updatedBy: "bootstrap",
    };

    await Promise.all([
      env.CONFIG.put(configKey(env, "routes"), JSON.stringify(routes)),
      env.CONFIG.put(configKey(env, "flags"), JSON.stringify(flags)),
      env.CONFIG.put(configKey(env, "metadata"), JSON.stringify(meta)),
    ]);

    await writeAudit(env, {
      ts: meta.updatedAt,
      actor: "bootstrap",
      action: "config.bootstrap",
      newHash: await computeEtag({ routes, flags, metadata: meta }),
      note: `Initialized with defaults (${routes.length} routes)`,
    });
    invalidateCache();
  })()
    .catch(async (error) => {
      await writeAudit(env, {
        ts: nowIso(),
        actor: "bootstrap",
        action: "config.bootstrap.error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      initPromise = null;
    });

  return initPromise;
}

/** ----------------------------- Matching ----------------------------- */
interface MatchContext {
  route: RouteRule;
  pathMatch: RegExpMatchArray | null;
}

function detectDevice(uaRaw: string): Device {
  const ua = uaRaw.toLowerCase();
  if (!uaRaw) return "desktop";
  const tabletKeywords = ["ipad", "tablet"];
  if (tabletKeywords.some((key) => ua.includes(key))) {
    return "tablet";
  }
  if (/\bandroid\b/i.test(uaRaw) && ua.includes("mobile")) {
    return "mobile";
  }
  if (/(iphone|ipod|windows phone|iemobile|blackberry|opera mini)/i.test(uaRaw)) {
    return "mobile";
  }
  return "desktop";
}

function isBotAgent(uaRaw: string, flags: FlagsConfig, cfBot?: boolean): boolean {
  if (!uaRaw && cfBot) return true;
  const ua = (uaRaw || "").toLowerCase();
  const knownBots = [
    ...(flags.strictBots ? flags.yandexBots : []),
    ...(flags.strictBots ? flags.googleBots : []),
  ].map((name) => name.toLowerCase());
  if (knownBots.some((sig) => ua.includes(sig.toLowerCase()))) {
    return true;
  }
  return Boolean(cfBot);
}

function matchRoute(
  rule: RouteRule,
  pathname: string,
  country: string,
  device: Device,
  isBot: boolean
): MatchContext | null {
  if (rule.enabled === false) return null;
  const match = rule.match || {};
  const paths = ensureArray(match.path);
  let pathMatch: RegExpMatchArray | null = null;
  if (paths && paths.length > 0) {
    const ok = paths.some((pattern) => {
      try {
        const re = new RegExp(pattern);
        const res = pathname.match(re);
        if (res) {
          pathMatch = res;
          return true;
        }
        return false;
      } catch {
        return false;
      }
    });
    if (!ok) return null;
  }

  if (match.countries && match.countries.length > 0) {
    if (!match.countries.includes(country)) return null;
  }
  if (match.devices && match.devices.length > 0 && !match.devices.includes("any")) {
    if (!match.devices.includes(device)) return null;
  }
  if (typeof match.bots === "boolean") {
    if (match.bots && !isBot) return null;
    if (!match.bots && isBot) return null;
  }

  return { route: rule, pathMatch };
}

/** ----------------------------- Action execution ----------------------------- */
function applyRedirect(
  action: RedirectAction,
  context: MatchContext,
  request: Request,
  country: string,
  device: Device
): Response {
  const target = new URL(action.target);
  const requestUrl = new URL(request.url);

  if (action.preserveOriginalQuery) {
    requestUrl.searchParams.forEach((value, key) => {
      target.searchParams.set(key, value);
    });
  }

  if (action.extraQuery) {
    for (const [key, value] of Object.entries(action.extraQuery)) {
      target.searchParams.set(key, value);
    }
  }

  if (action.query) {
    Object.entries(action.query).forEach(([key, value]) => {
      if (typeof value === "object" && value !== null && "fromPathGroup" in value) {
        const index = value.fromPathGroup ?? 0;
        const segment = context.pathMatch?.[index] || "";
        if (segment) {
          target.searchParams.set(key, segment);
        }
      } else if (typeof value === "object" && value !== null && "literal" in value) {
        target.searchParams.set(key, String(value.literal ?? ""));
      } else {
        target.searchParams.set(key, String(value));
      }
    });
  }

  if (action.appendCountry) {
    target.searchParams.set("country", country);
  }
  if (action.appendDevice) {
    target.searchParams.set("device", device);
  }

  const status = action.status ?? 302;
  return Response.redirect(target.toString(), status);
}

function applyResponse(action: ResponseAction): Response {
  const status = action.status ?? 200;
  const headers = copyHeaders(action.headers);
  if (!headers.has("Content-Type")) {
    headers.set(
      "Content-Type",
      action.bodyHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8"
    );
  }
  const body = action.bodyHtml ?? action.bodyText ?? "";
  return new Response(body, { status, headers });
}

function executeRoute(
  ctx: MatchContext,
  request: Request,
  country: string,
  device: Device
): Response {
  const action = ctx.route.action;
  if (!action) {
    return new Response(null, { status: 204 });
  }
  if (action.type === "redirect") {
    return applyRedirect(action, ctx, request, country, device);
  }
  if (action.type === "response") {
    return applyResponse(action);
  }
  return new Response(null, { status: 500, statusText: "Unknown action" });
}

/** ----------------------------- Validation ----------------------------- */
function validateRoutesPayload(routes: unknown): asserts routes is RouteRule[] {
  if (!Array.isArray(routes)) {
    throw new Error("routes must be an array");
  }
  routes.forEach((rule, idx) => {
    if (!rule || typeof rule !== "object") {
      throw new Error(`route[${idx}] must be object`);
    }
    if (!("id" in rule) || typeof rule.id !== "string" || rule.id.trim() === "") {
      throw new Error(`route[${idx}].id is required`);
    }
    if (!("match" in rule)) {
      throw new Error(`route[${idx}].match is required`);
    }
    if (!("action" in rule)) {
      throw new Error(`route[${idx}].action is required`);
    }
    const action = (rule as RouteRule).action;
    if ((action as RouteAction).type === "redirect") {
      if (!(action as RedirectAction).target) {
        throw new Error(`route[${idx}].action.target is required`);
      }
    }
  });
}

function validateFlagsPayload(flags: unknown): asserts flags is FlagsConfig {
  if (!flags || typeof flags !== "object") {
    throw new Error("flags must be an object");
  }
}

/** ----------------------------- Admin UI ----------------------------- */
function adminHtml(flags: FlagsConfig, tokenFromQuery?: string): string {
  const warning = tokenFromQuery
    ? `<div class="warning">Warning: token detected in the URL. It will be removed after load.</div>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${flags.uiTitle}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Cache-Control" content="no-store" />
    <style>
      :root { color-scheme: dark light; }
      body { font-family: system-ui, sans-serif; margin: 0; padding: 0; background: #111; color: #f5f5f5; }
      header { padding: 1rem; background: #1f1f1f; border-bottom: 1px solid #333; display:flex; justify-content:space-between; align-items:center; }
      h1 { margin: 0; font-size: 1.2rem; }
      main { padding: 1rem; display: grid; gap: 1rem; }
      textarea { width: 100%; min-height: 260px; font-family: "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 0.9rem; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid #333; background: #151515; color: #eee; }
      section { background: #1b1b1b; padding: 1rem; border-radius: 0.75rem; box-shadow: 0 0 0 1px #222; }
      button { padding: 0.6rem 1.2rem; border: none; border-radius: 0.5rem; background: #4c7dff; color: white; font-weight: 600; cursor: pointer; }
      button[disabled] { background: #555; cursor: not-allowed; }
      .row { display: flex; gap: 0.75rem; flex-wrap: wrap; }
      .warning { color: #ffb347; margin-bottom: 0.5rem; }
      pre { background: #0f0f0f; padding: 0.75rem; border-radius: 0.5rem; overflow-x: auto; }
      .log-item { margin-bottom: 0.5rem; border-bottom: 1px solid #222; padding-bottom: 0.5rem; }
    </style>
  </head>
  <body>
    <header>
      <h1>${flags.uiTitle}</h1>
      <div id="meta"></div>
    </header>
    <main>
      <section>
        ${warning}
        <div class="row">
          <button id="reload">Reload</button>
          <button id="publish" ${flags.uiReadonly ? "disabled" : ""}>Publish</button>
          <button id="invalidate">Invalidate cache</button>
        </div>
      </section>
      <section>
        <h2>Routes</h2>
        <textarea id="routes" ${flags.uiReadonly ? "readonly" : ""}></textarea>
      </section>
      <section>
        <h2>Flags</h2>
        <textarea id="flags" ${flags.uiReadonly ? "readonly" : ""}></textarea>
      </section>
      <section>
        <h2>Audit log</h2>
        <div id="audit"></div>
      </section>
    </main>
    <script>
      const queryToken = new URL(window.location.href).searchParams.get('token');
      if (queryToken) {
        history.replaceState(null, '', window.location.pathname);
      }
      const token = queryToken || '';
      const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
      async function api(path, options = {}) {
        const res = await fetch(path, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
            ...(options.headers || {})
          }
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(res.status + ' ' + res.statusText + '\n' + text);
        }
        if (res.status === 204) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }
      async function loadAll() {
        const metaEl = document.getElementById('meta');
        const [routes, flags, audit] = await Promise.all([
          api('/api/routes'),
          api('/api/flags'),
          api('/api/audit?limit=20')
        ]);
        document.getElementById('routes').value = JSON.stringify(routes.routes, null, 2);
        document.getElementById('flags').value = JSON.stringify(flags.flags, null, 2);
        metaEl.textContent = 'etag: ' + (routes.etag || 'n/a');
        const auditEl = document.getElementById('audit');
        auditEl.innerHTML = '';
        (audit || []).forEach(item => {
          const div = document.createElement('div');
          div.className = 'log-item';
          div.textContent = '[' + item.ts + '] ' + item.actor + ' — ' + item.action;
          auditEl.appendChild(div);
        });
      }
      document.getElementById('reload').addEventListener('click', () => loadAll().catch(err => alert(err.message)));
      document.getElementById('invalidate').addEventListener('click', () => {
        api('/api/cache/invalidate', { method: 'POST' }).then(() => alert('Cache invalidated')).catch(err => alert(err.message));
      });
      document.getElementById('publish').addEventListener('click', () => {
        const routes = document.getElementById('routes').value;
        const flags = document.getElementById('flags').value;
        Promise.all([
          api('/api/routes', { method: 'PUT', body: JSON.stringify({ routes: JSON.parse(routes) }) }),
          api('/api/flags', { method: 'PUT', body: JSON.stringify({ flags: JSON.parse(flags) }) })
        ])
          .then(() => loadAll())
          .catch(err => alert(err.message));
      });
      loadAll().catch(err => alert(err.message));
    </script>
  </body>
</html>`;
}

function adminResponse(flags: FlagsConfig, tokenFromQuery?: string): Response {
  const body = adminHtml(flags, tokenFromQuery);
  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline';");
  return new Response(body, { status: 200, headers });
}

/** ----------------------------- Admin API ----------------------------- */
async function authorize(request: Request, env: Env, flags: FlagsConfig): Promise<void> {
  const token = readAdminToken(request);
  if (!token || token !== env.ADMIN_TOKEN) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
  const ip =
    request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for");
  if (!isIpAllowed(ip, flags)) {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }
}

async function handleRoutesGet(env: Env): Promise<Response> {
  const bundle = await hydrateCache(env, true);
  return new Response(
    JSON.stringify({ routes: bundle.routes, version: bundle.metadata.version, etag: bundle.etag }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

async function updateMetadata(env: Env, actor: string): Promise<MetadataRecord> {
  const metadata: MetadataRecord = {
    version: env.CONFIG_VERSION || "1",
    updatedAt: nowIso(),
    updatedBy: actor,
  };
  await env.CONFIG.put(configKey(env, "metadata"), JSON.stringify(metadata));
  return metadata;
}

async function handleRoutesPut(
  request: Request,
  env: Env,
  actor: string
): Promise<Response> {
  const text = await request.text();
  const payload = parseJsonBody<{ routes: unknown }>(text);
  validateRoutesPayload(payload.routes);

  const current = await hydrateCache(env, true);
  const ifMatch = request.headers.get("if-match");
  if (ifMatch && ifMatch !== current.etag) {
    return new Response(JSON.stringify({ error: "etag mismatch" }), {
      status: 412,
      headers: { "Content-Type": "application/json" },
    });
  }

  const prevHash = current.etag;
  const newRoutes = payload.routes;
  await env.CONFIG.put(configKey(env, "routes"), JSON.stringify(newRoutes));
  const metadata = await updateMetadata(env, actor);
  invalidateCache();
  const reloaded = await hydrateCache(env, true);

  await writeAudit(env, {
    ts: metadata.updatedAt,
    actor,
    action: "routes.update",
    prevHash,
    newHash: reloaded.etag,
    diffBytes: JSON.stringify(newRoutes).length - JSON.stringify(current.routes).length,
  });

  return new Response(JSON.stringify({ ok: true, etag: reloaded.etag }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleRoutesValidate(request: Request): Promise<Response> {
  const text = await request.text();
  const payload = parseJsonBody<{ routes: unknown }>(text);
  validateRoutesPayload(payload.routes);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleRoutesPatch(
  request: Request,
  env: Env,
  actor: string,
  id: string
): Promise<Response> {
  const text = await request.text();
  const raw = parseJsonBody<Partial<RouteRule> | { patch: Partial<RouteRule> }>(text);
  const current = await hydrateCache(env, true);
  const existingIndex = current.routes.findIndex((route) => route.id === id);
  if (existingIndex === -1) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const patch = (("patch" in raw ? raw.patch : raw) ?? {}) as Partial<RouteRule>;
  const updated = { ...current.routes[existingIndex], ...patch } as RouteRule;
  const routes = [...current.routes];
  routes.splice(existingIndex, 1, updated);
  validateRoutesPayload(routes);
  await env.CONFIG.put(configKey(env, "routes"), JSON.stringify(routes));
  const metadata = await updateMetadata(env, actor);
  invalidateCache();
  const reloaded = await hydrateCache(env, true);
  await writeAudit(env, {
    ts: metadata.updatedAt,
    actor,
    action: "routes.patch",
    prevHash: current.etag,
    newHash: reloaded.etag,
    diffBytes: JSON.stringify(routes).length - JSON.stringify(current.routes).length,
  });
  return new Response(JSON.stringify({ ok: true, etag: reloaded.etag }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleRoutesDelete(
  env: Env,
  actor: string,
  id: string
): Promise<Response> {
  const current = await hydrateCache(env, true);
  const next = current.routes.filter((route) => route.id !== id);
  if (next.length === current.routes.length) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  await env.CONFIG.put(configKey(env, "routes"), JSON.stringify(next));
  const metadata = await updateMetadata(env, actor);
  invalidateCache();
  const reloaded = await hydrateCache(env, true);
  await writeAudit(env, {
    ts: metadata.updatedAt,
    actor,
    action: "routes.delete",
    prevHash: current.etag,
    newHash: reloaded.etag,
    diffBytes: JSON.stringify(next).length - JSON.stringify(current.routes).length,
  });
  return new Response(JSON.stringify({ ok: true, etag: reloaded.etag }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleFlagsGet(env: Env): Promise<Response> {
  const bundle = await hydrateCache(env, true);
  return new Response(JSON.stringify({ flags: bundle.flags }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleFlagsPut(
  request: Request,
  env: Env,
  actor: string
): Promise<Response> {
  const text = await request.text();
  const payload = parseJsonBody<{ flags: unknown }>(text);
  validateFlagsPayload(payload.flags);
  const flags = payload.flags as FlagsConfig;
  const current = await hydrateCache(env, true);
  await env.CONFIG.put(configKey(env, "flags"), JSON.stringify(flags));
  const metadata = await updateMetadata(env, actor);
  invalidateCache();
  const reloaded = await hydrateCache(env, true);
  await writeAudit(env, {
    ts: metadata.updatedAt,
    actor,
    action: "flags.update",
    prevHash: current.etag,
    newHash: reloaded.etag,
    diffBytes: JSON.stringify(flags).length - JSON.stringify(current.flags).length,
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleCacheInvalidate(env: Env, actor: string): Promise<Response> {
  invalidateCache();
  await writeAudit(env, {
    ts: nowIso(),
    actor,
    action: "cache.invalidate",
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleAudit(env: Env, limit: number): Promise<Response> {
  const list = await env.AUDIT.list({ prefix: `${AUDIT_PREFIX}/`, limit });
  const entries: AuditEntry[] = [];
  for (const key of list.keys) {
    const value = await env.AUDIT.get(key.name);
    if (value) {
      try {
        entries.push(JSON.parse(value) as AuditEntry);
      } catch (error) {
        entries.push({
          ts: nowIso(),
          actor: "system",
          action: "audit.parse_error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  entries.sort((a, b) => (a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0));
  return new Response(JSON.stringify(entries.slice(0, limit)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleExport(env: Env): Promise<Response> {
  const bundle = await hydrateCache(env, true);
  return new Response(
    JSON.stringify({
      routes: bundle.routes,
      flags: bundle.flags,
      metadata: bundle.metadata,
      etag: bundle.etag,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

async function handleImport(
  request: Request,
  env: Env,
  actor: string
): Promise<Response> {
  const text = await request.text();
  const payload = parseJsonBody<{
    routes: unknown;
    flags: unknown;
  }>(text);
  validateRoutesPayload(payload.routes);
  validateFlagsPayload(payload.flags);
  const current = await hydrateCache(env, true);
  await env.CONFIG.put(configKey(env, "routes"), JSON.stringify(payload.routes));
  await env.CONFIG.put(configKey(env, "flags"), JSON.stringify(payload.flags));
  const metadata = await updateMetadata(env, actor);
  invalidateCache();
  const reloaded = await hydrateCache(env, true);
  await writeAudit(env, {
    ts: metadata.updatedAt,
    actor,
    action: "config.import",
    prevHash: current.etag,
    newHash: reloaded.etag,
    diffBytes:
      JSON.stringify(payload.routes).length + JSON.stringify(payload.flags).length -
      (JSON.stringify(current.routes).length + JSON.stringify(current.flags).length),
  });
  return new Response(JSON.stringify({ ok: true, etag: reloaded.etag }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** ----------------------------- Runtime ----------------------------- */
async function handleRuntimeRequest(request: Request, env: Env): Promise<Response> {
  const bundle = await hydrateCache(env);
  const url = new URL(request.url);
  const pathname = url.pathname;
  const ua = request.headers.get("user-agent") || "";
  const country = ((request as any).cf?.country || "").toUpperCase();
  const device = detectDevice(ua);
  const isBot = isBotAgent(ua, bundle.flags, (request as any).cf?.bot);

  for (const rule of bundle.routes) {
    const ctx = matchRoute(rule, pathname, country, device, isBot);
    if (ctx) {
      return executeRoute(ctx, request, country, device);
    }
  }

  return fetch(request);
}

/** ----------------------------- Main handler ----------------------------- */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ensureConfigInitialized(env);

    const url = new URL(request.url);
    const pathname = url.pathname;
    const bundle = await hydrateCache(env);

    if (pathname === "/admin") {
      try {
        await authorize(request, env, bundle.flags);
      } catch (error) {
        const status = (error as any)?.status || 401;
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
      const tokenFromQuery = url.searchParams.get("token") || undefined;
      return adminResponse(bundle.flags, tokenFromQuery);
    }

    if (pathname.startsWith("/api/")) {
      try {
        await authorize(request, env, bundle.flags);
      } catch (error) {
        const status = (error as any)?.status || 401;
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }

      const actor = buildActor(request);
      const method = request.method.toUpperCase();

      if (pathname === "/api/routes" && method === "GET") return handleRoutesGet(env);
      if (pathname === "/api/routes" && method === "PUT")
        return handleRoutesPut(request, env, actor);
      if (pathname.startsWith("/api/routes/") && method === "PATCH") {
        const id = pathname.split("/").pop() as string;
        return handleRoutesPatch(request, env, actor, id);
      }
      if (pathname.startsWith("/api/routes/") && method === "DELETE") {
        const id = pathname.split("/").pop() as string;
        return handleRoutesDelete(env, actor, id);
      }
      if (pathname === "/api/routes/validate" && method === "POST")
        return handleRoutesValidate(request);
      if (pathname === "/api/flags" && method === "GET") return handleFlagsGet(env);
      if (pathname === "/api/flags" && method === "PUT")
        return handleFlagsPut(request, env, actor);
      if (pathname === "/api/cache/invalidate" && method === "POST")
        return handleCacheInvalidate(env, actor);
      if (pathname === "/api/audit" && method === "GET") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 20, 100) : 20;
        return handleAudit(env, limit);
      }
      if (pathname === "/api/export" && method === "GET") return handleExport(env);
      if (pathname === "/api/import" && method === "POST")
        return handleImport(request, env, actor);

      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method !== "GET") {
      return fetch(request);
    }

    return handleRuntimeRequest(request, env);
  },
};
