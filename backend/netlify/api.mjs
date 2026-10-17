/* =========================================================
   BACKEND · АДАПТЕР ДЛЯ NETLIFY FUNCTIONS (Runtime v2)
   Обрабатывает и API (/api/*), и раздачу медиа (/img/*) —
   на Netlify обе задачи решают функции, потому что файловая
   система публикации доступна только для чтения.

   Runtime v2 (современный стандарт Netlify Functions):
     • вход — веб-объект Request + context;
     • выход — веб-объект Response.
   Старый «лямбда-формат» ({statusCode, headers, body}) платформой
   больше не принимается (Lambda compatibility mode снят с поддержки),
   поэтому ответ конвертируется в Response здесь же. Для локальных
   тестов и старых инструментов сохранён и путь v1-события.

   Хранилище: Netlify Blobs (постоянное, без внешних аккаунтов).
   Данные переживают выгрузку инстанса и деплои.

   Порядок на каждый вызов:
     1. hydrate()   — прочитать БД из блоба в память (чтения в коде
                      бэкенда синхронные, поэтому гидратация обязательна);
     2. bootstrap   — если админов ещё нет, создать из DF_BOOTSTRAP_*;
     3. api.handle() — общая для Node и Netlify маршрутизация;
     4. flush()     — дождаться записи в блоб ДО возврата ответа.
        Без этого инстанс может быть заморожен, и правка потеряется.
   ========================================================= */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* Статический импорт: esbuild гарантированно включает @netlify/blobs в бандл
   функции. Ленивый require() в рантайме Netlify пакет не находил, из-за чего
   хранилище откатывалось на эфемерный /tmp ("storage":"fs") и правки CMS
   терялись между вызовами функции. */
import * as netlifyBlobs from "@netlify/blobs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/* Файлы backend/server/*.js подтягиваются в рантайм (included_files),
   а раскладка каталогов отличается:
     • локально / netlify dev — эта функция лежит в backend/netlify;
     • в деплое Netlify — бандл в /var/task, а included_files повторяет
       структуру репозитория: /var/task/backend/server/…
   Поэтому путь ищем по нескольким кандидатам. */
function serverFile(name) {
  const candidates = [
    path.join(here, "..", "server", name),
    path.join(here, "backend", "server", name),
    path.join(process.cwd(), "backend", "server", name),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* пробуем следующий */ }
  }
  return candidates[0];
}

const api = require(serverFile("api.js"));
const httpx = require(serverFile("http.js"));
const store = require(serverFile("store.js"));
const media = require(serverFile("media.js"));
const audit = require(serverFile("audit.js"));
const blobs = require(serverFile("store-blobs.js"));
const { config, ensureDirs, ensureSecret } = require(serverFile("config.js"));

blobs.setBlobsModule(netlifyBlobs);

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
};

/* ---------- подготовка рантайма (НА КАЖДЫЙ вызов функции) ----------
   Привязка хранилища перепроверяется каждый вызов: если Blobs временно
   ошиблись (например, истёк токен «тёплого» инстанса), следующий вызов
   снова попробует Blobs, а не останется навсегда в эфемерном /tmp. */
let lastStorageMode = null;
function logStorage(mode) {
  if (mode !== lastStorageMode) {
    lastStorageMode = mode;
    (mode === "blobs" ? console.log : console.error)(
      "[dubravin-flowers] хранилище: " + (mode === "blobs" ? "Netlify Blobs («" + blobs.STORE_NAME + "»)" : "ФАЙЛЫ /tmp — данные эфемерны, правки НЕ сохраняются между вызовами!")
    );
  }
}
function wireStorage() {
  ensureSecret();
  try { ensureDirs(); } catch (e) { /* /tmp может быть недоступен — не критично */ }
  if (blobs.isAvailable()) {
    store.setBackend({ readDB: blobs.readDB, writeDB: blobs.writeDB });
    media.setDriver(blobs.blobsDriver);
    logStorage("blobs");
    return true;
  }
  store.setBackend(null);
  media.setDriver(media.fsDriver);
  logStorage("ephemeral");
  return false;
}

/* Первый админ из переменных окружения: в них хэш scrypt, а не пароль.

   Обычный режим: учётка создаётся ОДИН раз, пока админов нет (иначе env-
   переменные позволяли бы бесконечно сбрасывать пароль).

   Аварийный режим DF_BOOTSTRAP_FORCE=1: если учётка с таким логином уже
   есть — её хэш пароля заменяется на хэш из переменной (старые сессии
   гасятся). Используется, когда пароль утерян/утёк. Флаг идемпотентен
   (повторные вызовы БД не переписывают) и после входа переменные
   DF_BOOTSTRAP_* вместе с FORCE нужно удалить. */
async function bootstrapAdmin() {
  const login = process.env.DF_BOOTSTRAP_LOGIN;
  const hash = process.env.DF_BOOTSTRAP_HASH;
  if (!login || !hash) return null;
  const auth = require(serverFile("auth.js"));
  if (!auth.isHashFormatValid(hash)) {
    audit.log("bootstrap.rejected", { reason: "bad-hash-format" });
    console.error("[dubravin-flowers] bootstrap ОТКЛОНЁН: DF_BOOTSTRAP_HASH повреждён/обрезан при копировании (ожидается scrypt$N$r$p$<32hex>$<128hex> одной строкой)");
    return null;
  }
  const loginErr = auth.validateLogin(login);
  if (loginErr) {
    audit.log("bootstrap.rejected", { reason: loginErr });
    console.error("[dubravin-flowers] bootstrap ОТКЛОНЁН: недопустимый DF_BOOTSTRAP_LOGIN (" + loginErr + ")");
    return null;
  }
  const force = /^(1|true|yes|on)$/i.test(String(process.env.DF_BOOTSTRAP_FORCE || ""));
  const existing = store.read((db) => db.admins.length);
  if (existing > 0 && !force) return null;
  const norm = auth.normalizeLogin(login);
  /* Идемпотентность FORCE: если хэш уже применён, БД не трогаем вовсе
     (иначе каждый запрос переписывал бы блоб из-за meta-счётчиков). */
  if (existing > 0) {
    const applied = store.read((db) => db.admins.find((a) => a.loginNorm === norm && a.passHash === hash));
    if (applied) return null;
  }
  let action = "created";
  await store.update((db) => {
    const cur = db.admins.find((a) => a.loginNorm === norm);
    if (cur) {
      cur.login = String(login).trim();
      cur.passHash = hash;
      cur.mustChangePassword = true;
      cur.passChangedAt = Date.now();
      db.sessions = [];                    // старые сессии аннулируем
      action = "updated";
    } else {
      db.admins.push({
        id: require("node:crypto").randomBytes(8).toString("hex"),
        login: String(login).trim(),
        loginNorm: norm,
        passHash: hash,
        createdAt: Date.now(),
        mustChangePassword: true,          // предложим сменить при первом входе
      });
    }
  });
  audit.log("bootstrap." + action, { login: String(login).trim() });
  console.log("[dubravin-flowers] bootstrap: учётка «" + String(login).trim() + "» " + (action === "updated" ? "ОБНОВЛЕНА (пароль сброшен из env)" : "создана"));
  return String(login).trim();
}

async function ensureReady() {
  const usingBlobs = wireStorage();
  try {
    await store.hydrate();
    await bootstrapAdmin();
  } catch (e) {
    /* Сбой Blobs в ЭТОМ вызове (сеть, токен и т.п.). Сайт должен остаться
       живым — данный вызов дорабатывает на файлах в /tmp, но следующая
       функция снова попробует Blobs (wireStorage вызывается каждый раз).
       Подробная причина — в логах Netlify → Logs → Functions. */
    console.error("[dubravin-flowers] Хранилище Netlify Blobs недоступно в этом вызове (" + (e && e.message) + ") — разовый откат на /tmp, правки этого вызова НЕ сохранятся");
    audit.log("runtime.blobs-failed", { message: String(e && e.message).slice(0, 200) });
    if (usingBlobs) {
      store.setBackend(null);
      media.setDriver(media.fsDriver);
      try { await store.hydrate(); } catch (e2) {}
      try { await bootstrapAdmin(); } catch (e3) {}
    }
  }
}

/* ---------- разбор пути ---------- */
function normalizePathname(rawPathname) {
  let pathname = String(rawPathname || "/");
  /* Возможны варианты:
       a) /api/health — при rewrite с публичного адреса (Runtime v2 передаёт
          оригинальный URL) или полный путь внутри splat;
       b) /.netlify/functions/api/… — прямой вызов функции.
     В случае (b) восстанавливаем префикс по имени функции.            */
  const FN_PREFIX = "/.netlify/functions/";
  if (pathname.startsWith(FN_PREFIX)) {
    const rest = pathname.slice(FN_PREFIX.length);
    const slash = rest.indexOf("/");
    const fnName = slash === -1 ? rest : rest.slice(0, slash);
    const sub = slash === -1 ? "" : rest.slice(slash);
    if (/^\/(api|img)(\/|$)/.test(sub)) pathname = sub;                        // вариант (a)
    else pathname = "/" + fnName.replace(/[^A-Za-z0-9_-]/g, "") + (sub || "/"); // вариант (b)
  }
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return pathname;
}

/* ---------- v1-событие (локальные тесты, старые инструменты) ---------- */
function parseEvent(event) {
  const rawPath = event.rawUrl || event.path || "/";
  let url;
  try { url = new URL(rawPath, "http://localhost"); } catch (e) { url = new URL("/", "http://localhost"); }

  const headers = Object.assign({}, event.headers || {});
  if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = "https";

  const ip =
    (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) ||
    headers["x-forwarded-for"] || headers["client-ip"] || "unknown";

  let body = Buffer.alloc(0);
  if (event.body) body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");

  return {
    headers, pathname: normalizePathname(url.pathname), ip: String(ip).slice(0, 45), body, url,
    method: String(event.httpMethod || (event.requestContext && event.requestContext.httpMethod) || "GET").toUpperCase(),
  };
}

/* ---------- v2: веб-Request → внутренний формат ---------- */
async function parseRequest(request, context) {
  const url = new URL(request.url, "http://localhost");
  const headers = {};
  try { request.headers.forEach((v, k) => { headers[String(k).toLowerCase()] = v; }); } catch (e) { /* Headers недоступен — работаем пустыми */ }
  if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = "https";

  const method = String(request.method || "GET").toUpperCase();
  let body = Buffer.alloc(0);
  if (method !== "GET" && method !== "HEAD") {
    try { body = Buffer.from(await request.arrayBuffer()); } catch (e) { body = Buffer.alloc(0); }
  }

  const ip =
    (context && (context.ip || (context.requestContext && context.requestContext.identity && context.requestContext.identity.sourceIp))) ||
    headers["x-forwarded-for"] || headers["client-ip"] || "unknown";

  return { headers, pathname: normalizePathname(url.pathname), ip: String(ip).slice(0, 45), body, url, method };
}

/* ---------- раздача медиа из Blobs ---------- */
async function serveMedia(req, res, pathname) {
  const driver = media.getDriver();
  if (driver.name !== "netlify-blobs") return null;
  const rel = pathname.replace(/^\/+/, "");
  if (!blobs.mediaKey(rel)) return null;
  const buf = await driver.get(rel);
  if (!buf) return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: "not-found" }) };
  const ext = path.extname(rel).toLowerCase();
  return {
    statusCode: 200,
    headers: {
      "Content-Type": MIME[ext] || "application/octet-stream",
      /* Витрина добавляет к URL ?v=<rev>, поэтому содержимое адреса
         никогда не меняется — можно кэшировать агрессивно: повторные
         запросы (в т.ч. при переключении подборок) идут из кэша CDN
         и не дёргают функцию. */
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
    body: buf,          // Buffer — toWebResponse() отдаст его как есть
    binary: true,
  };
}

/* ---------- общая обработка (формат v1-объекта) ---------- */
async function processReq(req) {
  try {
    await ensureReady();

    /* /img/* — медиа из Blobs (на статике его нет, поэтому отдаёт функция) */
    if (req.pathname.startsWith("/img/") && req.method === "GET") {
      const m = await serveMedia(req, null, req.pathname);
      if (m) return m;
    }

    if (req.pathname !== "/api" && !req.pathname.startsWith("/api/")) {
      return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: "not-found" }) };
    }

    const isMultipart = /^multipart\/form-data/i.test(String(req.headers["content-type"] || ""));
    let json;
    if (!isMultipart && req.body.length) {
      try {
        const parsed = JSON.parse(req.body.toString("utf8"));
        json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? httpx.stripDangerousKeys(parsed) : null;
      } catch (e) {
        await store.flush();
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: "invalid-json" }) };
      }
    }

    const ctx = {
      method: req.method,
      pathname: req.pathname,
      query: Object.fromEntries(req.url.searchParams),
      headers: req.headers,
      ip: req.ip,
      body: req.body,
      stream: null,          // в serverless тело уже буферизовано
      json,
    };

    let out;
    try {
      out = await api.handle(ctx);
    } catch (e) {
      const status = e && Number.isInteger(e.status) ? e.status : 500;
      audit.log("netlify.error", { path: req.pathname, status, message: String(e && e.message).slice(0, 200) });
      await store.flush();
      return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: status === 500 ? "internal" : e.message }) };
    }

    /* КРИТИЧНО: дожидаемся записи в Blobs до возврата ответа */
    await store.flush();

    const respHeaders = Object.assign({}, JSON_HEADERS, { "Cache-Control": "no-store" },
      httpx.securityHeaders({ headers: req.headers, socket: {} }), out.headers || {});
    delete respHeaders["X-Clear-Session"];

    const cookies = [];
    if (out.setSession) {
      cookies.push(
        `${config.cookieName}=${encodeURIComponent(out.setSession.token)}; Path=/; HttpOnly; Secure; SameSite=${config.sameSite}; Expires=${new Date(out.setSession.expiresAt).toUTCString()}`
      );
      if (out.json && out.json.csrf) cookies.push(`df-csrf=${out.json.csrf}; Path=/; Secure; SameSite=${config.sameSite}`);
    }
    if (out.headers && out.headers["X-Clear-Session"]) {
      cookies.push(`${config.cookieName}=; Path=/; HttpOnly; Secure; SameSite=${config.sameSite}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    }
    if (cookies.length) respHeaders["Set-Cookie"] = cookies;

    return {
      statusCode: out.status,
      headers: respHeaders,
      body: JSON.stringify(out.json === undefined ? null : out.json),
    };
  } catch (e) {
    audit.log("netlify.fatal", { message: String(e && e.message).slice(0, 300) });
    try { await store.flush(); } catch (e2) {}
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: "internal" }) };
  }
}

/* ---------- конвертация в веб-Response (Runtime v2) ---------- */
function toWebResponse(out) {
  const status = Number.isInteger(out.statusCode) ? out.statusCode : 200;
  const headers = new Headers();
  for (const [k, v] of Object.entries(out.headers || {})) {
    if (v === undefined || v === null) continue;
    const key = String(k);
    if (key.toLowerCase() === "content-length") continue;   // рантайм посчитает сам
    if (Array.isArray(v)) { for (const x of v) headers.append(key, String(x)); }
    else headers.set(key, String(v));
  }
  const nullBody = status === 204 || status === 205 || status === 304;
  let body = null;
  if (!nullBody) {
    if (out.binary || Buffer.isBuffer(out.body)) body = new Uint8Array(out.body);
    else body = out.body === undefined || out.body === null ? "" : String(out.body);
  }
  return new Response(body, { status, headers });
}

/* ---------- обработчик ---------- */
export default async function handler(input, context) {
  /* Runtime v2 (Netlify): на вход — веб-Request, на выход — веб-Response. */
  const isWebRequest =
    (typeof Request !== "undefined" && input instanceof Request) ||
    (input && typeof input === "object" && typeof input.method === "string" && typeof input.url === "string" && !input.httpMethod);
  if (isWebRequest) {
    const req = await parseRequest(input, context);
    const out = await processReq(req);
    return toWebResponse(out);
  }
  /* Legacy v1-событие: локальные тесты, старые версии netlify dev. */
  const req = parseEvent(input || {});
  return processReq(req);
}
