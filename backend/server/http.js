"use strict";
/* =========================================================
   BACKEND · HTTP-УТИЛИТЫ
   Чтение тела с лимитом, cookie, IP, ответы, заголовки
   безопасности, защита от CSRF.
   ========================================================= */
const crypto = require("node:crypto");
const { config } = require("./config.js");

/* ---------- тело запроса ---------- */
function readBody(req, limit = config.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        /* Тело дальше не копим, но и соединение не рвём: клиент должен
           получить честный 413, а не «socket hang up». */
        if (!overflow) { overflow = true; chunks.length = 0; }
        return;
      }
      if (!overflow) chunks.push(c);
    });
    req.on("end", () => {
      if (overflow) return reject(Object.assign(new Error("payload-too-large"), { status: 413 }));
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => reject(Object.assign(e, { status: 400 })));
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw Object.assign(new Error("invalid-json"), { status: 400 });
  }
  /* Только объекты: массив/строка/число на вход API не принимаем.
     JSON.parse сам по себе не загрязняет прототип, но __proto__ как
     обычное поле нам тоже не нужно — вычищаем. */
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("invalid-json-shape"), { status: 400 });
  }
  return stripDangerousKeys(parsed);
}

function stripDangerousKeys(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((x) => stripDangerousKeys(x, depth + 1));
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = stripDangerousKeys(obj[k], depth + 1);
  }
  return out;
}

/* ---------- ответы ---------- */
function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload === undefined ? null : payload);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }, extraHeaders || {}));
  res.end(body);
}

function sendText(res, status, text, headers) {
  const body = String(text);
  res.writeHead(status, Object.assign({
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  }, headers || {}));
  res.end(body);
}

/* Ошибки отдаём в едином формате, без стеков и деталей наружу */
function sendError(res, status, reason, details) {
  sendJson(res, status, {
    ok: false,
    error: reason,
    ...(details ? { details } : {}),
  });
}

/* ---------- cookie ---------- */
function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!k || k === "__proto__" || k === "constructor") continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function cookieName(req) {
  /* __Host- требует Secure и отсутствия Domain/Path!=/ — используем на HTTPS */
  return isHttps(req) ? config.cookieName : config.cookieNameDev;
}

function sessionCookie(res, req, token, expiresAt) {
  const name = cookieName(req);
  const parts = [
    name + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=" + config.sameSite,
  ];
  if (isHttps(req)) parts.push("Secure");
  if (expiresAt) parts.push("Expires=" + new Date(expiresAt).toUTCString());
  const value = parts.join("; ");
  const prev = res.getHeader("Set-Cookie");
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(value);
  res.setHeader("Set-Cookie", list);
}

function clearSessionCookie(res, req) {
  sessionCookie(res, req, "", Date.now() - 1000);
}

/* ---------- HTTPS / IP ---------- */
function isHttps(req) {
  if (req && req.socket && req.socket.encrypted) return true;
  if (config.trustProxy) {
    const fwd = req && req.headers && req.headers["x-forwarded-proto"];
    if (typeof fwd === "string" && fwd.split(",")[0].trim().toLowerCase() === "https") return true;
  }
  return false;
}

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length) {
      const first = fwd.split(",")[0].trim();
      if (/^[0-9a-fA-F:.]{3,45}$/.test(first)) return first;
    }
  }
  const addr = (req.socket && req.socket.remoteAddress) || "";
  return String(addr).slice(0, 45);
}

/* ---------- CSRF ----------
   Основная защита — не кука, а заголовок Authorization: Bearer <token>.
   Кастомный заголовок невозможно отправить с чужого сайта без CORS-префлайта,
   а CORS мы не разрешаем. Кука поддерживается для удобства, но любой
   изменяющий запрос ОБЯЗАН содержать один из:
     • Authorization: Bearer <токен сессии>
     • X-CSRF-Token: <csrf-токен из куки df-csrf>
   Плюс SameSite=Strict как третий рубеж.                              */
function csrfTokenFor(sessionId) {
  return crypto.createHmac("sha256", config.secret || "dev").update("csrf:" + sessionId).digest("base64url");
}

function issueCsrfCookie(res, req, sessionId) {
  const token = csrfTokenFor(sessionId);
  const secure = isHttps(req) ? "; Secure" : "";
  const list = res.getHeader("Set-Cookie");
  const arr = list ? (Array.isArray(list) ? list : [list]) : [];
  arr.push("df-csrf=" + token + "; Path=/; SameSite=" + config.sameSite + secure);
  res.setHeader("Set-Cookie", arr);
  return token;
}

/* Проверяем изменяющий запрос. Возвращает { ok, reason, token } */
function verifyCsrf(req, cookies, session) {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^Bearer\s+\S+$/i.test(auth)) return { ok: true, via: "bearer" };

  const header = req.headers["x-csrf-token"];
  const fromCookie = cookies["df-csrf"];
  if (typeof header === "string" && header.length >= 16 && fromCookie && header === fromCookie) {
    return { ok: true, via: "double-submit" };
  }
  if (session && typeof header === "string" && header === csrfTokenFor(session.id)) {
    return { ok: true, via: "token" };
  }
  return { ok: false, reason: "csrf" };
}

/* ---------- заголовки безопасности для API ---------- */
function securityHeaders(req) {
  const h = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
    /* API не должен встраиваться в iframe и не исполняет ничего своего */
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  if (isHttps(req)) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  /* CORS не разрешаем по умолчанию: API работает только со своего origin.
     DF_CORS_ORIGIN нужен лишь на время переезда, когда витрина и API
     временно на разных доменах. */
  const origin = process.env.DF_CORS_ORIGIN;
  if (origin && req.headers.origin === origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Credentials"] = "true";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-CSRF-Token, If-Match";
    h["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
    h["Vary"] = "Origin";
  }
  return h;
}

module.exports = {
  readBody, readJson, stripDangerousKeys,
  sendJson, sendText, sendError,
  parseCookies, cookieName, sessionCookie, clearSessionCookie,
  isHttps, clientIp,
  csrfTokenFor, issueCsrfCookie, verifyCsrf,
  securityHeaders,
};
