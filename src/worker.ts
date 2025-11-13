// src/worker.ts
import ROUTES from "../config/routes.json" assert { type: "json" };

/** ----------------------------- Типы ----------------------------- */
type Device = "mobile" | "desktop" | "tablet" | "any";

type MatchRule = {
  path?: string[];
  pattern?: string[];
  countries?: string[];
  devices?: Device[];
  bot?: boolean;
};

type RouteRule = {
  id?: string;
  match: MatchRule;
  target: string;
  status?: number;
  forwardQuery?: boolean;
  appendPath?: boolean;
  extraParams?: Record<string, unknown>;
  trackingParam?: string;
  trackingValue?: string;
};

type RoutesConfig = {
  rules: RouteRule[];
};

/** ----------------------------- Детекторы ----------------------------- */
function isSearchBot(uaRaw: string): boolean {
  const ua = (uaRaw || "").toLowerCase();
  const bots = [
    "yandexbot",
    "yandexmobilebot",
    "yandeximages",
    "yandexvideo",
    "yandexnews",
    "yandexwebmaster",
    "googlebot",
    "google-structured-data-testing-tool",
    "bingbot",
    "msnbot",
    "bingpreview",
    "duckduckbot",
    "baiduspider",
    "sogou",
    "exabot",
    "mj12bot",
    "semrushbot",
  ];
  return bots.some((sig) => ua.includes(sig));
}

function isTabletUA(uaRaw: string): boolean {
  const ua = (uaRaw || "").toLowerCase();
  if (ua.includes("ipad")) return true;
  if (ua.includes("tablet")) return true;
  if (ua.includes("android") && !ua.includes("mobile")) return true;
  return false;
}

function isMobileUA(uaRaw: string): boolean {
  if (!uaRaw) return false;
  const ua = uaRaw.toLowerCase();
  if (/(iphone|ipod|windows phone|iemobile|blackberry|opera mini)/i.test(uaRaw)) return true;
  if (ua.includes("android")) return ua.includes("mobile");
  if (/\bmobile\b/i.test(uaRaw)) return true;
  if (ua.includes("ipad") || ua.includes("tablet")) return false;
  return false;
}

/** ----------------------------- Матчинг путей ----------------------------- */
function matchPathSimple(pattern: string, pathname: string): boolean {
  if (!pattern) return false;
  if (pattern.endsWith("*")) {
    const base = pattern.slice(0, -1); // '/casino/*' -> '/casino/'
    return pathname.startsWith(base);
  }
  return pathname === pattern;
}

function matchRegExpStrings(patterns: string[] | undefined, pathname: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((src) => {
    try {
      const re = new RegExp(src);
      return re.test(pathname);
    } catch {
      return false;
    }
  });
}

function matchRule(
  rule: MatchRule,
  pathname: string,
  country: string,
  device: Device,
  isBot: boolean
): boolean {
  if (rule.path && rule.path.length > 0) {
    const ok = rule.path.some((p) => matchPathSimple(p, pathname));
    if (!ok) return false;
  }
  if (!matchRegExpStrings(rule.pattern, pathname)) return false;

  if (rule.countries && rule.countries.length > 0) {
    if (!rule.countries.includes(country)) return false;
  }
  if (rule.devices && rule.devices.length > 0 && !rule.devices.includes("any")) {
    if (!rule.devices.includes(device)) return false;
  }
  if (typeof rule.bot === "boolean") {
    if (rule.bot === true && !isBot) return false;
    if (rule.bot === false && isBot) return false;
  }
  return true;
}

/** ----------------------------- Сборка редиректа ----------------------------- */
function copyQueryParams(from: URL, to: URL) {
  from.searchParams.forEach((value, key) => {
    to.searchParams.set(key, value);
  });
}

function appendPath(base: URL, extraPath: string) {
  if (!extraPath) return;
  const joined =
    base.pathname.endsWith("/") || extraPath.startsWith("/")
      ? `${base.pathname}${extraPath}`
      : `${base.pathname}/${extraPath}`;
  base.pathname = joined;
}

function applyPathToParam(
  dstUrl: URL,
  srcPath: string,
  opts?: { stripPrefix?: string; paramName?: string }
) {
  const stripPrefix = opts?.stripPrefix || "";
  const paramName = opts?.paramName || "";
  if (!paramName) return;

  let path = srcPath || "/";
  if (stripPrefix && path.startsWith(stripPrefix)) {
    path = path.slice(stripPrefix.length);
  }
  const seg = path.split("/").filter(Boolean)[0];
  if (seg) {
    dstUrl.searchParams.set(paramName, seg);
  }
}

function buildRedirectUrl(rule: RouteRule, reqUrl: URL): URL {
  const target = new URL(rule.target);

  if (rule.appendPath) {
    appendPath(target, reqUrl.pathname);
  }
  if (rule.forwardQuery) {
    copyQueryParams(reqUrl, target);
  }
  if (rule.extraParams) {
    for (const [k, v] of Object.entries(rule.extraParams)) {
      if (k.startsWith("__")) continue;
      target.searchParams.set(k, String(v));
    }
  }
  const pathToParam = (rule.extraParams?.["__pathToParam"] ?? "") as string;
  if (pathToParam) {
    const stripPrefix = (rule.extraParams?.["__stripPrefix"] ?? "") as string;
    applyPathToParam(target, reqUrl.pathname, {
      stripPrefix,
      paramName: pathToParam,
    });
  }
  if (rule.trackingParam && rule.trackingValue) {
    target.searchParams.set(rule.trackingParam, rule.trackingValue);
  }
  return target;
}

/** ----------------------------- Worker ----------------------------- */
export default {
  async fetch(request: Request): Promise<Response> {
    const cfg = (ROUTES as RoutesConfig) || { rules: [] };
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1) По умолчанию работаем ПРОЗРАЧНО: любые методы кроме GET — проксируем.
    if (request.method !== "GET") {
      return fetch(request);
    }

    const ua = request.headers.get("user-agent") || "";
    const isBot = isSearchBot(ua);
    const country = ((request as any).cf?.country || "").toUpperCase();

    let device: Device = "desktop";
    if (isTabletUA(ua)) device = "tablet";
    else if (isMobileUA(ua)) device = "mobile";

    // 2) Находим правило
    const rule = cfg.rules.find((r) => {
      try {
        return matchRule(r.match || {}, pathname, country, device, isBot);
      } catch {
        return false;
      }
    });

    // 3) Если правило не найдено — проксируем на origin (НЕ 204!)
    if (!rule) {
      return fetch(request);
    }

    // 4) Доп. гарантия: если требуется параметр из пути — и сегмента нет, то не редиректим.
    const needParam = (rule.extraParams?.["__pathToParam"] ?? "") as string;
    if (needParam) {
      const stripPrefix = (rule.extraParams?.["__stripPrefix"] ?? "") as string;
      let path = pathname;
      if (stripPrefix && path.startsWith(stripPrefix)) {
        path = path.slice(stripPrefix.length);
      }
      const seg = path.split("/").filter(Boolean)[0];
      if (!seg) {
        return fetch(request);
      }
    }

    // 5) Редирект
    const redirectUrl = buildRedirectUrl(rule, url);
    const code = rule.status ?? 302;
    return Response.redirect(redirectUrl.toString(), code);
  },
};
