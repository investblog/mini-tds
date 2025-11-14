# Route configuration guide

The Worker ships with a single default rule that targets Russian mobile traffic
and skips bots. Requests that do not match **any** rule fall back to your
origin, so you can safely deploy the Worker before wiring every route.

```json
[
  {
    "id": "rule-ru-mobile-casino",
    "enabled": true,
    "match": {
      "path": "^/casino/([^/?#]+)",
      "countries": ["RU"],
      "devices": ["mobile"],
      "bots": false
    },
    "action": {
      "type": "redirect",
      "target": "https://bxxd.ru/tds/go.cgi?6",
      "query": {
        "bonus": { "fromPathGroup": 1 }
      },
      "status": 302,
      "preserveOriginalQuery": false,
      "extraQuery": {
        "src": "mobile-geo"
      },
      "appendCountry": true,
      "appendDevice": true
    }
  }
]
```

Because the default rule explicitly sets `"bots": false`, automated crawlers
receive the unmodified origin instead of a placeholder HTML page.

## Working with routes

1. **Start from the defaults.** Copy `config/routes.json` into KV (or use the
   admin UI) and adjust the rule IDs so they remain unique.
2. **Add specific rules first.** The router stops on the first match. Place
   more specific path filters (for example, country-specific promos) at the top
   of the array, and keep broader fallbacks last.
3. **Use capture groups deliberately.** When you reference
   `{ "fromPathGroup": 1 }`, make sure the associated `match.path` expression
   actually includes at least one capture group. Prefer non-greedy patterns like
   `([^/?#]+)` for slugs.
4. **Keep bot handling explicit.** Set `"bots": false` on rules that should not
   trigger for crawlers. Create a dedicated rule with `"bots": true` only when
   you have a custom destination or need to block bot traffic.
5. **Validate before publishing.** Use the admin UI preview or call
   `POST /api/routes/validate` to check the payload before overwriting existing
   routes.

## Example scenarios

### 1. Country-based split by path prefix

Redirect Russian and Kazakh mobile visitors from `/slots/<brand>` to separate
campaigns while leaving other traffic untouched:

```json
[
  {
    "id": "ru-slots",
    "match": {
      "path": "^/slots/([^/?#]+)",
      "countries": ["RU"],
      "devices": ["mobile"],
      "bots": false
    },
    "action": {
      "type": "redirect",
      "target": "https://example.ru/offer",
      "query": {
        "brand": { "fromPathGroup": 1 },
        "campaign": { "literal": "ru-mobile" }
      },
      "appendCountry": true,
      "appendDevice": true
    }
  },
  {
    "id": "kz-slots",
    "match": {
      "path": "^/slots/([^/?#]+)",
      "countries": ["KZ"],
      "devices": ["mobile"],
      "bots": false
    },
    "action": {
      "type": "redirect",
      "target": "https://example.kz/offer",
      "query": {
        "brand": { "fromPathGroup": 1 }
      }
    }
  }
]
```

### 2. Desktop fallback to origin with analytics tag

Send desktop visitors back to the origin but tag the request with a source
parameter. Because the rule is a redirect, clients will hit the origin via the
redirect URL:

```json
{
  "id": "desktop-pass-through",
  "match": {
    "devices": ["desktop"],
    "bots": false
  },
  "action": {
    "type": "redirect",
    "target": "https://origin.example.com$requestPath",
    "preserveOriginalQuery": true,
    "extraQuery": {
      "src": "desktop-tds"
    }
  }
}
```

The literal `$requestPath` placeholder is not expanded automatically. When you
need to reuse the original path, add `^/(.*)` to the `match.path` and project the
capture via `"fromPathGroup"`.

### 3. Dedicated response for bots

If you do want a bot landing page, add it explicitly as the last rule:

```json
{
  "id": "bots-hold",
  "match": {
    "bots": true
  },
  "action": {
    "type": "response",
    "status": 200,
    "headers": {
      "Content-Type": "text/html; charset=utf-8"
    },
    "bodyHtml": "<!doctype html><title>OK</title><h1>Site is fine</h1>"
  }
}
```

Placing the rule at the end ensures that business routes remain unaffected while
still keeping an option to serve custom content to crawlers when required.
