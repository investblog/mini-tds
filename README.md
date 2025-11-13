# mini-tds

Cloudflare Worker для мобильного гео-редиректа. Скрипт читает конфигурацию из KV,
определяет страну и тип устройства, извлекает оконечник из пути и перенаправляет
мобильный трафик на нужный лендинг, добавляя метки в query.

## Как это работает

1. Worker поднимается на маршруте домена (Cloudflare Pages/Proxy).
2. При каждом запросе конфигурация берётся из KV (с локальным TTL-кэшем).
3. Проверяется страна (`request.cf.country`) и тип устройства:
   - приоритет у Client Hints `Sec-CH-UA-Mobile`;
   - fallback по `User-Agent` с положительными/отрицательными регекспами.
4. Путь сравнивается с регулярками из `pathRules`; первая совпавшая даёт slug для
   передачи в целевой URL.
5. Если все условия выполнены — генерируется 302/307 редирект с нужными
   параметрами и заголовком `Cache-Control: no-store`. Иначе запрос просто
   проксируется дальше (через `fetch`).
6. Для SEO-ботов из allow-list редирект никогда не срабатывает.
7. Логи пишутся с выборкой `perf.logSampleRate`, чтобы избежать спама.

## Структура конфигурации

Конфиг хранится в KV под ключом `config.json`. Пример — в
`config/config.example.json`:

```json
{
  "countryAllowList": ["RU", "KZ", "BY"],
  "pathRules": [
    {
      "pattern": "^/casino/([^/?#]+)",
      "paramFromGroup": 1,
      "target": {
        "type": "query",
        "base": "https://bookieranks.com/go",
        "queryParam": "brand"
      }
    }
  ],
  "redirect": {
    "statusCode": 302,
    "preserveOriginalQuery": false,
    "extraQuery": {
      "src": "mobile-geo"
    },
    "appendCountry": true,
    "appendDevice": true
  },
  "seo": {
    "uaAllowList": ["Googlebot", "Bingbot", "DuckDuckBot"],
    "respectNoArchive": false
  },
  "perf": {
    "configTtlSeconds": 60,
    "logSampleRate": 0.01
  }
}
```

Основные поля:

- `countryAllowList` — ISO-2 страны, где должен срабатывать редирект.
- `pathRules` — список правил для извлечения slug из пути. Используется первая
  совпавшая регулярка (`paramFromGroup` — номер захватываемой группы).
- `target.type` — `query` (slug кладётся в query) или `path` (slug добавляется к
  пути `base`).
- `redirect` — статус редиректа, нужно ли добавлять исходные query,
  дополнительные метки и флаги `country`/`device`.
- `seo.uaAllowList` — User-Agent подсроки краулеров, которым редирект делать нельзя.
- `perf` — TTL локального кэша конфига и sampling для логов.

## Подготовка окружения

1. Установите зависимости:

   ```bash
   npm install
   ```

2. Создайте KV namespace и привяжите его к воркеру. **Важно:** биндинг
   должен называться `CONFIG`, воркер читает конфиг через `env.CONFIG`.

   ```bash
   npx wrangler kv:namespace create CONFIG
   ```

   Скопируйте `id` и `preview_id` в `wrangler.toml` в секцию:

   ```toml
   [[kv_namespaces]]
   binding = "CONFIG"
   id = "..."
   preview_id = "..."
   ```

3. Загрузите конфиг в KV (по умолчанию используется ключ `config.json`):

   ```bash
   ./scripts/upload-config.sh config/config.example.json
   ```

   Скрипт вызывает `wrangler kv:key put --binding CONFIG ...`. Можно передать
   вторым аргументом другое имя биндинга, если оно отличается.

4. Запустите локально:

   ```bash
   npm run dev
   ```

   Worker будет доступен на `http://127.0.0.1:8787`. Для проверки мобильного
   сценария меняйте заголовки `Sec-CH-UA-Mobile`/`User-Agent`.

5. Деплой в Cloudflare:

   ```bash
   npm run deploy
   ```

6. Настройте Routes: привяжите Worker к нужному пути домена (например,
   `example.com/*`). Редирект сработает только для мобильных пользователей из
   стран allow-list и по путям, подходящим под регулярки.

### Примечания

- Редиректы всегда отдаются с `Cache-Control: no-store`, чтобы Cloudflare не
  кэшировал ответ.
- Если конфиг не найден или регулярка не вытаскивает slug, запрос будет
  проксирован без изменений.
- Для дополнительной фильтрации ботов используйте Cloudflare WAF/Rulesets.
