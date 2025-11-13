interface TargetConfig {
  type: "query" | "path";
  base: string;
  queryParam?: string;
}

interface PathRuleConfig {
  pattern: string;
  paramFromGroup?: number;
  target: TargetConfig;
}

interface RedirectConfig {
  statusCode?: number;
  preserveOriginalQuery?: boolean;
  extraQuery?: Record<string, string>;
  appendCountry?: boolean;
  appendDevice?: boolean;
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

interface GeoRedirectConfig {
  countryAllowList: string[];
  pathRules: PathRuleConfig[];
  redirect?: RedirectConfig;
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

const DEFAULT_CONFIG_KEY = "config.json";
const DEFAULT_TTL_SECONDS = 60;

const DEFAULT_BOT_USER_AGENT_PATTERN =
  "\\b(?:adsbot-google(?:-mobile)?|mediapartners-google|feedfetcher-google|googlebot(?:[-_ ]?(?:image|video|news|mobile))?|google(?: web)?preview|bingbot|msnbot|bingpreview|yandex(?:bot|images|direct|video|mobilebot)?|baiduspider|slurp|duckduckbot|mail\\.ru_bot|applebot|petalbot|facebookexternalhit|twitterbot|discordbot|telegrambot|slackbot|linkedinbot)\\b";
const DEFAULT_BOT_USER_AGENT_REGEX = new RegExp(DEFAULT_BOT_USER_AGENT_PATTERN, "i");
const DEFAULT_BOT_ASN_SET = new Set([15169, 8075, 13238, 32934, 16509, 14618]);
const DEFAULT_MOBILE_USER_AGENT_PATTERN =
  "\\b(android|iphone|ipod|windows phone|opera mini|opera mobi|blackberry|bb10|silk/|kindle|webos|iemobile|samsungbrowser|miuibrowser|miui|huawei|oppo|oneplus|vivo|realme|poco|ucbrowser|crios|fxios|edgios)\\b";
const DEFAULT_MOBILE_USER_AGENT_REGEX = new RegExp(DEFAULT_MOBILE_USER_AGENT_PATTERN, "i");

const botUaRegexCache = new WeakMap<GeoRedirectConfig, RegExp>();
const mobileUaRegexCache = new WeakMap<GeoRedirectConfig, RegExp>();
const botAsnSetCache = new WeakMap<GeoRedirectConfig, Set<number>>();

let cachedConfig: GeoRedirectConfig | null = null;
let cacheExpiresAt = 0;

async function loadConfig(env: Env): Promise<GeoRedirectConfig | null> {
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
    const parsed = JSON.parse(raw) as GeoRedirectConfig;
    cachedConfig = parsed;
    const ttl = parsed.perf?.configTtlSeconds ?? DEFAULT_TTL_SECONDS;
    cacheExpiresAt = now + ttl * 1000;
    return parsed;
  } catch (error) {
    console.error("[tds] Failed to load config", error);
    return cachedConfig;
  }
}

function getBotUserAgentRegex(config: GeoRedirectConfig): RegExp {
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

function getMobileUserAgentRegex(config: GeoRedirectConfig): RegExp {
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

function getBotAsnSet(config: GeoRedirectConfig): Set<number> {
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

function isSeoUserAgent(userAgent: string | null, config: GeoRedirectConfig): boolean {
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

function classifyDevice(request: Request, config: GeoRedirectConfig): "mobile" | "desktop" {
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

function isBotRequest(request: CfRequest, config: GeoRedirectConfig): boolean {
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

function isCountryAllowed(config: GeoRedirectConfig, country: string): boolean {
  return config.countryAllowList.some((value) => value.toUpperCase() === country);
}

function matchPathRule(pathname: string, rules: PathRuleConfig[]): { rule: PathRuleConfig; slug: string } | null {
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern);
      const match = regex.exec(pathname);
      if (!match) {
        continue;
      }
      const groupIndex = rule.paramFromGroup ?? 1;
      const slug = match[groupIndex];
      if (!slug) {
        continue;
      }
      return { rule, slug };
    } catch (error) {
      console.error("[tds] Invalid path rule regex", { pattern: rule.pattern, error });
    }
  }
  return null;
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
  requestUrl: URL,
  slug: string,
  country: string | undefined,
  device: "mobile" | "desktop",
  rule: PathRuleConfig,
  redirectConfig: RedirectConfig | undefined
): string {
  const target = rule.target;
  const url = new URL(target.base);

  if (target.type === "path") {
    url.pathname = appendPathSegment(url.pathname, slug);
  } else {
    const paramName = target.queryParam ?? "brand";
    url.searchParams.set(paramName, slug);
  }

  if (redirectConfig?.preserveOriginalQuery) {
    requestUrl.searchParams.forEach((value, key) => {
      url.searchParams.append(key, value);
    });
  }

  if (redirectConfig?.extraQuery) {
    for (const [key, value] of Object.entries(redirectConfig.extraQuery)) {
      url.searchParams.set(key, value);
    }
  }

  if (redirectConfig?.appendCountry && country) {
    url.searchParams.set("country", country);
  }

  if (redirectConfig?.appendDevice) {
    url.searchParams.set("device", device);
  }

  return url.toString();
}

function maybeLog(config: GeoRedirectConfig, message: string, details: Record<string, unknown>): void {
  const rate = config.perf?.logSampleRate ?? 0;
  if (rate > 0 && Math.random() < rate) {
    console.log(`[tds] ${message}`, details);
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const config = await loadConfig(env);
    if (!config) {
      return fetch(request);
    }

    const country = getCountry(request as CfRequest);
    if (!country) {
      return fetch(request);
    }

    if (!isCountryAllowed(config, country)) {
      return fetch(request);
    }

    const device = classifyDevice(request, config);
    if (device !== "mobile") {
      return fetch(request);
    }

    if (isBotRequest(request as CfRequest, config)) {
      return fetch(request);
    }

    const userAgent = request.headers.get("User-Agent");
    if (isSeoUserAgent(userAgent, config)) {
      return fetch(request);
    }

    const requestUrl = new URL(request.url);
    const pathname = requestUrl.pathname;
    const match = matchPathRule(pathname, config.pathRules ?? []);
    if (!match) {
      return fetch(request);
    }

    const redirectUrl = buildRedirectUrl(
      requestUrl,
      match.slug,
      country,
      device,
      match.rule,
      config.redirect
    );

    maybeLog(config, "redirect", {
      country,
      slug: match.slug,
      target: redirectUrl,
      path: pathname,
    });

    const status = config.redirect?.statusCode ?? 302;
    const response = Response.redirect(redirectUrl, status);
    response.headers.set("Cache-Control", "no-store");
    return response;
  },
};

export default worker;
