import routesConfig from "../config/routes.json";

type DeviceType = "mobile" | "desktop" | "bot" | "tablet";

type RouteResponseConfig = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
};

type RouteMatchConfig = {
  path?: string[];
  countries?: string[];
  languages?: string[];
  devices?: DeviceType[];
  query?: Record<string, string[]>;
  headers?: Record<string, string[]>;
  referrers?: string[];
};

type RouteConfig = {
  id: string;
  target?: string;
  response?: RouteResponseConfig;
  trackingParam?: string;
  trackingValue?: string;
  appendPath?: boolean;
  stripPathPrefix?: string;
  forwardQuery?: boolean | string[];
  extraParams?: Record<string, string>;
  status?: number;
  match?: RouteMatchConfig;
};

type RoutesConfig = {
  routes: RouteConfig[];
  fallback?: Omit<RouteConfig, "id">;
};

interface Env {}

const config: RoutesConfig = routesConfig as unknown as RoutesConfig;

function isWildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (!pattern.includes("*")) {
    return value === pattern;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`);
  return regex.test(value);
}

function matchPath(pathname: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  const normalized = pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
  return patterns.some((pattern) => {
    if (pattern === "/") {
      return normalized === "/";
    }
    const normalizedPattern = pattern.endsWith("/") && pattern !== "/" ? pattern.slice(0, -1) : pattern;
    if (normalizedPattern.startsWith("/")) {
      return isWildcardMatch(normalized, normalizedPattern);
    }
    return isWildcardMatch(normalized, `/${normalizedPattern}`);
  });
}

function parseLanguages(header?: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean);
}

function detectDevice(userAgent: string | null): DeviceType {
  if (!userAgent) {
    return "desktop";
  }
  const ua = userAgent.toLowerCase();
  if (/(googlebot|bingbot|yandexbot|duckduckbot|baiduspider|sogou|bot|crawler|spider)/.test(ua)) {
    return "bot";
  }
  if (/(ipad|tablet|kindle)/.test(ua)) {
    return "tablet";
  }
  if (/(iphone|android|mobile|blackberry|phone)/.test(ua)) {
    return "mobile";
  }
  return "desktop";
}

function matchListCondition(actual: string | undefined, expected?: string[]): boolean {
  if (!expected || expected.length === 0) return true;
  if (!actual) return false;
  return expected.some((candidate) => candidate.toLowerCase() === actual.toLowerCase());
}

function matchLanguages(actual: string[], expected?: string[]): boolean {
  if (!expected || expected.length === 0) return true;
  const normalized = new Set(actual.map((language) => language.toLowerCase()));
  return expected.some((language) => normalized.has(language.toLowerCase()));
}

function matchQuery(url: URL, config?: Record<string, string[]>): boolean {
  if (!config) return true;
  return Object.entries(config).every(([key, values]) => {
    if (!url.searchParams.has(key)) return false;
    if (!values || values.length === 0) return true;
    const actualValues = url.searchParams.getAll(key).map((value) => value.toLowerCase());
    return values.some((value) => actualValues.includes(value.toLowerCase()));
  });
}

function matchHeaders(request: Request, config?: Record<string, string[]>): boolean {
  if (!config) return true;
  return Object.entries(config).every(([name, expectedValues]) => {
    const actual = request.headers.get(name);
    if (!actual) return false;
    if (!expectedValues || expectedValues.length === 0) return true;
    return expectedValues.some((expected) => actual.toLowerCase().includes(expected.toLowerCase()));
  });
}

function matchReferrers(request: Request, referrers?: string[]): boolean {
  if (!referrers || referrers.length === 0) return true;
  const refererHeader = request.headers.get("Referer") || request.headers.get("Referrer");
  if (!refererHeader) return false;
  try {
    const refererUrl = new URL(refererHeader);
    const host = refererUrl.hostname.toLowerCase();
    return referrers.some((ref) => host.includes(ref.toLowerCase()));
  } catch (error) {
    return false;
  }
}

function doesRouteMatch(request: Request, route: RouteConfig): boolean {
  const match = route.match;
  if (!match) {
    return true;
  }

  const url = new URL(request.url);
  const pathMatches = matchPath(url.pathname, match.path);
  if (!pathMatches) return false;

  const country = (request as Request & { cf?: { country?: string } }).cf?.country;
  if (!matchListCondition(country, match.countries)) return false;

  const languages = parseLanguages(request.headers.get("Accept-Language"));
  if (!matchLanguages(languages, match.languages)) return false;

  const device = detectDevice(request.headers.get("User-Agent"));
  if (!matchListCondition(device, match.devices)) return false;

  if (!matchQuery(url, match.query)) return false;
  if (!matchHeaders(request, match.headers)) return false;
  if (!matchReferrers(request, match.referrers)) return false;

  return true;
}

function joinPaths(base: string, appended: string): string {
  const trimmedBase = base === "/" ? "" : base.replace(/\/$/, "");
  const normalizedAppended = appended.startsWith("/") ? appended : `/${appended}`;
  const combined = `${trimmedBase}${normalizedAppended}`;
  return combined === "" ? "/" : combined;
}

function applyStripPrefix(pathname: string, prefix?: string): string {
  if (!prefix) return pathname;
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const ensuredPrefix = normalizedPrefix.startsWith("/") ? normalizedPrefix : `/${normalizedPrefix}`;
  if (pathname === ensuredPrefix) {
    return "/";
  }
  const prefixWithSeparator = `${ensuredPrefix}/`;
  if (pathname.startsWith(prefixWithSeparator)) {
    const stripped = pathname.slice(prefixWithSeparator.length - 1);
    return stripped || "/";
  }
  return pathname;
}

function buildRedirectUrl(route: RouteConfig, requestUrl: URL): string {
  if (!route.target) {
    throw new Error(`Route ${route.id} is missing target URL`);
  }
  const targetUrl = new URL(route.target);
  const originalPath = applyStripPrefix(requestUrl.pathname, route.stripPathPrefix);

  if (route.appendPath) {
    targetUrl.pathname = joinPaths(targetUrl.pathname, originalPath);
  }

  const shouldForwardAllQuery = route.forwardQuery === true;
  const shouldForwardSelected = Array.isArray(route.forwardQuery)
    ? (route.forwardQuery as string[])
    : undefined;
  if (shouldForwardAllQuery || shouldForwardSelected) {
    requestUrl.searchParams.forEach((value, key) => {
      if (shouldForwardAllQuery || shouldForwardSelected?.includes(key)) {
        targetUrl.searchParams.append(key, value);
      }
    });
  }

  if (route.extraParams) {
    for (const [key, value] of Object.entries(route.extraParams)) {
      targetUrl.searchParams.set(key, value);
    }
  }

  if (route.trackingParam) {
    const trackingValue = route.trackingValue ?? route.id;
    targetUrl.searchParams.set(route.trackingParam, trackingValue);
  }

  return targetUrl.toString();
}

function handleRoute(request: Request, route: RouteConfig): Response {
  if (route.response) {
    const { body = "", status = 200, headers = {} } = route.response;
    return new Response(body, { status, headers });
  }

  const requestUrl = new URL(request.url);
  const redirectUrl = buildRedirectUrl(route, requestUrl);
  const status = route.status ?? 302;
  return Response.redirect(redirectUrl, status);
}

function handleFallback(request: Request, fallback?: Omit<RouteConfig, "id">): Response {
  if (!fallback) {
    return new Response("Not Found", { status: 404 });
  }
  const fallbackRoute: RouteConfig = { id: "fallback", ...fallback };
  return handleRoute(request, fallbackRoute);
}

const worker: ExportedHandler<Env> = {
  async fetch(request) {
    for (const route of config.routes) {
      if (doesRouteMatch(request, route)) {
        return handleRoute(request, route);
      }
    }
    return handleFallback(request, config.fallback);
  },
};

export default worker;
