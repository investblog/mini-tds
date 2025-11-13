interface RouteMatchConfig {
  path?: string[];
  countries?: string[];
  devices?: Array<"mobile" | "desktop">;
}

interface RouteConfig {
  id: string;
  match?: RouteMatchConfig;
  target: string;
  stripPathPrefix?: string;
  appendPath?: boolean;
  forwardQuery?: boolean;
  extraParams?: Record<string, string>;
  status?: number;
}

interface SeoConfig {
  uaAllowList?: string[];
  respectNoArchive?: boolean;
}

interface PerfConfig {
  configTtlSeconds?: number;
  logSampleRate?: number;
}

interface FilterConfig {
  botUserAgentPattern?: string;
  botAsnList?: number[];
  mobileUserAgentPattern?: string;
}

interface FallbackConfig {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

interface RoutesConfig {
  routes: RouteConfig[];
  fallback?: FallbackConfig;
  seo?: SeoConfig;
  perf?: PerfConfig;
  filters?: FilterConfig;
}

interface Env {
  CONFIG: KVNamespace;
}

type CfRequest = Request & {
  cf?: {
    country?: string;
    asn?: number;
  };
};

const DEFAULT_CONFIG_KEY = "routes.json";
const DEFAULT_TTL_SECONDS = 60;

const DEFAULT_BOT_USER_AGENT_PATTERN =
  "\\b(?:adsbot-google(?:-mobile)?|mediapartners-google|feedfetcher-google|googlebot(?:[-_ ]?(?:image|video|news|mobile))?|google(?: web)?preview|bingbot|msnbot|bingpreview|yandex(?:bot|images|direct|video|mobilebot)?|baiduspider|slurp|duckduckbot|mail\\.ru_bot|applebot|petalbot|facebookexternalhit|twitterbot|discordbot|telegrambot|slackbot|linkedinbot)\\b";
const DEFAULT_BOT_USER_AGENT_REGEX = new RegExp(DEFAULT_BOT_USER_AGENT_PATTERN, "i");
const DEFAULT_BOT_ASN_SET = new Set([15169, 8075, 13238, 32934, 16509, 14618]);
const DEFAULT_MOBILE_USER_AGENT_PATTERN =
  "\\b(android|iphone|ipod|windows phone|opera mini|opera mobi|blackberry|bb10|silk/|kindle|webos|iemobile|samsungbrowser|miuibrowser|miui|huawei|oppo|oneplus|vivo|realme|poco|ucbrowser|crios|fxios|edgios)\\b";
const DEFAULT_MOBILE_USER_AGENT_REGEX = new RegExp(DEFAULT_MOBILE_USER_AGENT_PATTERN, "i");

const botUaRegexCache = new WeakMap<RoutesConfig, RegExp>();
const mobileUaRegexCache = new WeakMap<RoutesConfig, RegExp>();
const botAsnSetCache = new WeakMap<RoutesConfig, Set<number>>();

let cachedConfig: RoutesConfig | null = null;
let cacheExpiresAt = 0;

async function loadConfig(env: Env): Promise<RoutesConfig | null> {
  const now = Date.now();
  if (cachedConfig && now < cacheExpiresAt) {
    return cachedConfig;
  }

  try {
    const raw = await env.CONFIG.get(DEFAULT_CONFIG_KEY, "text");
    if (!raw) {
      console.error("[tds] Config not found in KV");
      return cachedConfig;
    }
    const parsed = JSON.parse(raw) as RoutesConfig;
    cachedConfig = parsed;
    const ttl = parsed.perf?.configTtlSeconds ?? DEFAULT_TTL_SECONDS;
    cacheExpiresAt = now + ttl * 1000;
    return parsed;
  } catch (error) {
    console.error("[tds] Failed to load config", error);
    return cachedConfig;
  }
}

function getBotUserAgentRegex(config: RoutesConfig): RegExp {
  const cached = botUaRegexCache.get(config);
  if (cached) {
    return cached;
  }
  const pattern = config.filters?.botUserAgentPattern;
  if (pattern) {
    try {
      const compiled = new RegExp(pattern, "i");
      botUaRegexCache.set(config, compiled);
      return compiled;
    } catch (error) {
      console.error("[tds] Invalid bot user agent pattern", { pattern, error });
    }
  }
  botUaRegexCache.set(config, DEFAULT_BOT_USER_AGENT_REGEX);
  return DEFAULT_BOT_USER_AGENT_REGEX;
}

function getMobileUserAgentRegex(config: RoutesConfig): RegExp {
  const cached = mobileUaRegexCache.get(config);
  if (cached) {
    return cached;
  }
  const pattern = config.filters?.mobileUserAgentPattern;
  if (pattern) {
    try {
      const compiled = new RegExp(pattern, "i");
      mobileUaRegexCache.set(config, compiled);
      return compiled;
    } catch (error) {
      console.error("[tds] Invalid mobile user agent pattern", { pattern, error });
    }
  }
  mobileUaRegexCache.set(config, DEFAULT_MOBILE_USER_AGENT_REGEX);
  return DEFAULT_MOBILE_USER_AGENT_REGEX;
}

function getBotAsnSet(config: RoutesConfig): Set<number> {
  const cached = botAsnSetCache.get(config);
  if (cached) {
    return cached;
  }
  const list = config.filters?.botAsnList;
  if (list && Array.isArray(list) && list.length > 0) {
    const compiled = new Set(list);
    botAsnSetCache.set(config, compiled);
    return compiled;
  }
  botAsnSetCache.set(config, DEFAULT_BOT_ASN_SET);
  return DEFAULT_BOT_ASN_SET;
}

function isSeoUserAgent(userAgent: string | null, config: RoutesConfig): boolean {
  if (!userAgent) {
    return false;
  }
  const allowList = config.seo?.uaAllowList;
  if (!allowList || allowList.length === 0) {
    return false;
  }
  const loweredAgent = userAgent.toLowerCase();
  return allowList.some((needle) => loweredAgent.includes(needle.toLowerCase()));
}

function classifyDevice(request: Request, config: RoutesConfig): "mobile" | "desktop" {
  const chMobile = request.headers.get("Sec-CH-UA-Mobile");
  if (chMobile) {
    const normalized = chMobile.trim();
    if (normalized === "?1" || normalized === "1") {
      return "mobile";
    }
    if (normalized === "?0" || normalized === "0") {
      return "desktop";
    }
  }

  const userAgent = request.headers.get("User-Agent") ?? "";
  if (!userAgent) {
    return "desktop";
  }

  const negativeRegex = /(iPad|Tablet|X11|Macintosh(?!.*iPhone))/i;
  if (negativeRegex.test(userAgent)) {
    return "desktop";
  }

  if (/\bMobile\b/i.test(userAgent)) {
    return "mobile";
  }

  const mobileRegex = getMobileUserAgentRegex(config);
  return mobileRegex.test(userAgent) ? "mobile" : "desktop";
}

function isBotRequest(request: CfRequest, config: RoutesConfig): boolean {
  const userAgent = request.headers.get("User-Agent");
  if (userAgent && getBotUserAgentRegex(config).test(userAgent)) {
    return true;
  }

  const asn = request.cf?.asn;
  if (typeof asn === "number") {
    const botAsn = getBotAsnSet(config);
    if (botAsn.has(asn)) {
      return true;
    }
  }

  return false;
}

function getCountry(request: CfRequest): string | undefined {
  const country = request.cf?.country;
  if (!country) {
    return undefined;
  }
  return country.toUpperCase();
}

function matchesCountry(match: RouteMatchConfig | undefined, country: string | undefined): boolean {
  if (!match?.countries || match.countries.length === 0) {
    return true;
  }
  if (!country) {
    return false;
  }
  const upper = country.toUpperCase();
  return match.countries.some((value) => value.toUpperCase() === upper);
}

function matchesDevice(match: RouteMatchConfig | undefined, device: "mobile" | "desktop"): boolean {
  if (!match?.devices || match.devices.length === 0) {
    return true;
  }
  return match.devices.includes(device);
}

function wildcardMatch(pattern: string, pathname: string): boolean {
  const normalizedPattern = pattern.startsWith("/") ? pattern : `/${pattern}`;
  if (normalizedPattern.endsWith("*")) {
    const prefix = normalizedPattern.slice(0, -1);
    return pathname.startsWith(prefix);
  }
  return pathname === normalizedPattern;
}

function matchesPath(match: RouteMatchConfig | undefined, pathname: string): boolean {
  if (!match?.path || match.path.length === 0) {
    return true;
  }
  return match.path.some((pattern) => wildcardMatch(pattern, pathname));
}

function decodeSlug(slug: string): string {
  if (!slug) {
    return slug;
  }
  return slug
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function extractSlug(pathname: string, stripPathPrefix: string | undefined): string {
  if (!stripPathPrefix) {
    return "";
  }

  const normalizedPrefix = stripPathPrefix.startsWith("/")
    ? stripPathPrefix
    : `/${stripPathPrefix}`;
  if (!pathname.startsWith(normalizedPrefix)) {
    return "";
  }

  const raw = pathname.slice(normalizedPrefix.length);
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return decodeSlug(trimmed);
}

function appendPathSegment(basePath: string, slug: string): string {
  const sanitizedSlug = slug
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const trimmedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (trimmedBase === "" || trimmedBase === "/") {
    return `/${sanitizedSlug}`;
  }
  return `${trimmedBase}/${sanitizedSlug}`;
}

function buildRedirectUrl(
  route: RouteConfig,
  requestUrl: URL,
  slug: string
): string {
  const url = new URL(route.target);

  const shouldAppendPath = route.appendPath !== false;
  if (shouldAppendPath && slug) {
    url.pathname = appendPathSegment(url.pathname, slug);
  } else if (!shouldAppendPath && route.stripPathPrefix && slug) {
    url.searchParams.set("bonus", slug);
  }

  if (route.forwardQuery) {
    requestUrl.searchParams.forEach((value, key) => {
      url.searchParams.append(key, value);
    });
  }

  if (route.extraParams) {
    for (const [key, value] of Object.entries(route.extraParams)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

function maybeLog(config: RoutesConfig, message: string, details: Record<string, unknown>): void {
  const rate = config.perf?.logSampleRate ?? 0;
  if (rate > 0 && Math.random() < rate) {
    console.log(`[tds] ${message}`, details);
  }
}

function findMatchingRoute(
  config: RoutesConfig,
  pathname: string,
  country: string | undefined,
  device: "mobile" | "desktop"
): { route: RouteConfig; slug: string } | null {
  for (const route of config.routes ?? []) {
    if (!matchesCountry(route.match, country)) {
      continue;
    }
    if (!matchesDevice(route.match, device)) {
      continue;
    }
    if (!matchesPath(route.match, pathname)) {
      continue;
    }

    const slug = extractSlug(pathname, route.stripPathPrefix);
    return { route, slug };
  }
  return null;
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const config = await loadConfig(env);
    if (!config) {
      return fetch(request);
    }

    const country = getCountry(request as CfRequest);

    const device = classifyDevice(request, config);

    if (isBotRequest(request as CfRequest, config)) {
      return fetch(request);
    }

    const userAgent = request.headers.get("User-Agent");
    if (isSeoUserAgent(userAgent, config)) {
      return fetch(request);
    }

    const requestUrl = new URL(request.url);
    const pathname = requestUrl.pathname;
    const match = findMatchingRoute(config, pathname, country, device);
    if (!match) {
      if (config.fallback) {
        const fallbackHeaders = new Headers(config.fallback.headers);
        if (!fallbackHeaders.has("Cache-Control")) {
          fallbackHeaders.set("Cache-Control", "no-store");
        }
        return new Response(config.fallback.body ?? "Not matched", {
          status: config.fallback.status ?? 404,
          headers: fallbackHeaders,
        });
      }
      return fetch(request);
    }

    const redirectUrl = buildRedirectUrl(match.route, requestUrl, match.slug);

    maybeLog(config, "redirect", {
      country,
      device,
      routeId: match.route.id,
      slug: match.slug,
      target: redirectUrl,
      path: pathname,
    });

    const status = match.route.status ?? 302;
    const response = Response.redirect(redirectUrl, status);
    response.headers.set("Cache-Control", "no-store");
    return response;
  },
};

export default worker;
