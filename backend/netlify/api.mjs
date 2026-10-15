/* =========================================================
   BACKEND · АДАПТЕР ДЛЯ NETLIFY FUNCTIONS
   Обрабатывает и API (/api/*), и раздачу медиа (/img/*) —
   на Netlify обе задачи решают функции, потому что файловая
   система публикации доступна только для чтения.

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

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
};

/* ---------- подготовка рантайма (один раз на инстанс) ---------- */
let wired = false;
function wireStorage() {
  if (wired) return;
  ensureSecret();
  try { ensureDirs(); } catch (e) { /* /tmp может быть недоступен — не критично */ }
  if (blobs.isAvailable()) {
    store.setBackend({ readDB: blobs.readDB, writeDB: blobs.writeDB });
    media.setDriver(blobs.blobsDriver);
    audit.log("runtime.blobs", { store: blobs.STORE_NAME });
  } else {
    /* Blobs недоступны (локальный запуск netlify dev без контекста сайта):
       остаёмся на файлах в /tmp — работать будет, но данные эфемерны. */
    audit.log("runtime.ephemeral", { reason: "blobs-unavailable" });
  }
  wired = true;
}

/* Первый админ из переменных окружения: в них хэш scrypt, а не пароль */
async function bootstrapAdmin() {
  const login = process.env.DF_BOOTSTRAP_LOGIN;
  const hash = process.env.DF_BOOTSTRAP_HASH;
  if (!login || !hash) return null;
  const auth = require(serverFile("auth.js"));
  if (!auth.isHashFormatValid(hash)) {
    audit.log("bootstrap.rejected", { reason: "bad-hash-format" });
    return null;
  }
  const existing = store.read((db) => db.admins.length);
  if (existing > 0) return null;
  const loginErr = auth.validateLogin(login);
  if (loginErr) {
    audit.log("bootstrap.rejected", { reason: loginErr });
    return null;
  }
  await store.update((db) => {
    db.admins.push({
      id: require("node:crypto").randomBytes(8).toString("hex"),
      login: String(login).trim(),
      loginNorm: auth.normalizeLogin(login),
      passHash: hash,
      createdAt: Date.now(),
      mustChangePassword: true,      // предложим сменить при первом входе
    });
  });
  audit.log("bootstrap.created", { login: String(login).trim() });
  return String(login).trim();
}

async function ensureReady() {
  wireStorage();
  try {
    await store.hydrate();
    await bootstrapAdmin();
  } catch (e) {
    /* Хранилище недоступно (нет контекста сайта, сбой Blobs). Сайт должен
       остаться живым — возвращаемся к файлам в /tmp. Данные при этом
       эфемерны, поэтому пишем заметное предупреждение в лог функции:
       его видно в Netlify → Logs → Functions. */
    const msg = "Хранилище Netlify Blobs недоступно (" + (e && e.message) + ") — работаю в эфемерном режиме /tmp, правки НЕ сохранятся";
    console.error("[dubravin-flowers] " + msg);
    audit.log("runtime.blobs-failed", { message: String(e && e.message).slice(0, 200) });
    store.setBackend(null);
    try { await store.hydrate(); } catch (e2) {}
  }
}

/* ---------- разбор запроса ---------- */
function parseEvent(event) {
  const rawPath = event.rawUrl || event.path || "/";
  let url;
  try { url = new URL(rawPath, "http://localhost"); } catch (e) { url = new URL("/", "http://localhost"); }

  const headers = Object.assign({}, event.headers || {});
  if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = "https";

  /* Разбор пути. Возможны два варианта:
       a) /​.netlify/functions/api/api/content — полный путь внутри splat;
       b) /health — Netlify передаёт путь ОТНОСИТЕЛЬНО имени функции
          (функция api.mjs обслуживает /api/*, img.mjs — /img/*).
     В случае (b) восстанавливаем префикс по имени функции.            */
  const FN_PREFIX = "/.netlify/functions/";
  let pathname = url.pathname;
  if (pathname.startsWith(FN_PREFIX)) {
    const rest = pathname.slice(FN_PREFIX.length);
    const slash = rest.indexOf("/");
    const fnName = slash === -1 ? rest : rest.slice(0, slash);
    const sub = slash === -1 ? "" : rest.slice(slash);
    if (/^\/(api|img)(\/|$)/.test(sub)) pathname = sub;                       // вариант (a)
    else pathname = "/" + fnName.replace(/[^A-Za-z0-9_-]/g, "") + (sub || "/"); // вариант (b)
  }
  if (!pathname.startsWith("/")) pathname = "/" + pathname;

  const ip =
    (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) ||
    headers["x-forwarded-for"] || headers["client-ip"] || "unknown";

  let body = Buffer.alloc(0);
  if (event.body) body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");

  return { headers, pathname, ip: String(ip).slice(0, 45), body, url,
    method: String(event.httpMethod || (event.requestContext && event.requestContext.httpMethod) || "GET").toUpperCase() };
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
      "Content-Length": String(buf.length),
      "Cache-Control": "public, max-age=2592000",
      "X-Content-Type-Options": "nosniff",
    },
    body: buf.toString("base64"),
    isBase64Encoded: true,
  };
}

/* ---------- обработчик ---------- */
export default async function handler(event) {
  const req = parseEvent(event);
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
