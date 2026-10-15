"use strict";
/* =========================================================
   BACKEND · МАРШРУТИЗАТОР API
   Одна и та же логика используется в двух окружениях:
     • Node-сервер на VPS (backend/server/server.js) — потоки, статика;
     • Netlify Functions (backend/netlify/api.mjs) — буферизованное тело.
   Поэтому роутер принимает уже подготовленный ctx и возвращает
   описание ответа, а не работает с res напрямую.

   ctx = { method, pathname, query, headers, ip, body: Buffer, stream? }
   →   { status, json?, text?, headers?, multipart?: { productId, replace } }
   ========================================================= */
const http = require("./http.js");
const auth = require("./auth.js");
const content = require("./content.js");
const media = require("./media.js");
const store = require("./store.js");
const audit = require("./audit.js");
const { config } = require("./config.js");
const sanitize = require("./sanitize.js");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/* ---------- извлечение сессии ---------- */
function bearerToken(headers) {
  const a = headers["authorization"];
  if (typeof a === "string") {
    const m = /^Bearer\s+([A-Za-z0-9_\-\.=]+)$/i.exec(a.trim());
    if (m) return m[1].slice(0, 200);
  }
  return null;
}

async function getSession(ctx) {
  const cookies = http.parseCookies(ctx.headers["cookie"]);
  const token = bearerToken(ctx.headers) || cookies[http.cookieName({ headers: ctx.headers, socket: ctx.socket })] || null;
  if (!token) return { user: null, token: null, cookies };
  const user = auth.sessionUser(token);
  if (user) await auth.touchSession(token);   // скользящий таймаут (до ответа клиенту)
  return { user, token, cookies };
}

async function requireAuth(ctx) {
  const s = await getSession(ctx);
  if (!s.user) return { error: { status: 401, error: "unauthorized" }, session: s };
  return { session: s };
}

/* ---------- вспомогательные ответы ---------- */
const json = (status, payload, headers) => ({ status, json: payload, headers });
const err = (status, error, details) => ({ status, json: { ok: false, error, ...(details ? { details } : {}) } });

/* ---------- маршруты ---------- */
async function handle(ctx) {
  const { method, pathname } = ctx;

  /* CORS-префлайт: 204 только для явно разрешённого origin. Иначе 405 —
     иначе браузер сочтёт предварительный запрос успешным. */
  if (method === "OPTIONS") {
    const origin = process.env.DF_CORS_ORIGIN;
    if (origin && ctx.headers.origin === origin) return { status: 204, json: null, headers: { "Content-Length": "0" } };
    return err(405, "method-not-allowed");
  }

  /* Метод не поддерживается для известного пути → 405, а не 404/200 */
  const ALLOWED = {
    "/api/health": ["GET", "HEAD"],
    "/api/content": ["GET", "HEAD"],
    "/api/auth/login": ["POST"],
    "/api/auth/logout": ["POST"],
    "/api/auth/reset": ["POST"],
    "/api/auth/me": ["GET", "HEAD"],
    "/api/admin/content": ["GET", "PUT", "POST"],
    "/api/admin/hero": ["GET", "PUT", "PATCH"],
    "/api/admin/collections": ["GET", "PUT", "POST"],
    "/api/admin/products": ["GET", "POST"],
    "/api/admin/admins": ["GET", "POST"],
    "/api/admin/password": ["POST"],
    "/api/admin/recovery-token": ["POST"],
    "/api/admin/reset": ["POST"],
    "/api/admin/media/orphans": ["POST"],
    "/api/admin/audit": ["GET", "HEAD"],
  };
  const dynamic = [
    [/^\/api\/admin\/products\/[A-Za-z0-9_-]{1,64}$/, ["GET", "PUT", "PATCH", "DELETE"]],
    [/^\/api\/admin\/products\/[A-Za-z0-9_-]{1,64}\/photos$/, ["POST", "DELETE"]],
    [/^\/api\/admin\/collections\/[A-Za-z0-9_-]{1,64}$/, ["PUT", "PATCH", "DELETE"]],
  ];
  const allowed = ALLOWED[pathname] || (dynamic.find(([re]) => re.test(pathname)) || [])[1];
  if (allowed && !allowed.includes(method)) return err(405, "method-not-allowed");

  /* --- публичные --- */
  if (pathname === "/api/health") {
    return json(200, {
      ok: true,
      name: "dubravin-flowers-api",
      version: 1,
      env: config.env,
      time: new Date().toISOString(),
      storage: media.getDriver().name,
      cms: "server",
    });
  }

  if (pathname === "/api/content" && method === "GET") {
    const { content: c, rev } = await content.getAll();
    /* Публично отдаём только санитизированный контент: даже если БД правили
       вручную или восстановили из повреждённого бэкапа, наружу не уйдёт ни
       javascript: URL, ни посторонних полей. */
    const safe = sanitize.sanitizeContent(c);
    return json(200, { ok: true, rev, ...safe }, { ETag: 'W/"r' + rev + '"' });
  }

  if (pathname === "/api/auth/login" && method === "POST") return loginRoute(ctx);
  if (pathname === "/api/auth/reset" && method === "POST") return resetRoute(ctx);

  /* --- сессия --- */
  if (pathname === "/api/auth/logout" && method === "POST") {
    const s = await getSession(ctx);
    if (s.token) await auth.logout(s.token);
    return { status: 200, json: { ok: true }, headers: { "X-Clear-Session": "1" } };
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    const s = await getSession(ctx);
    if (!s.user) return err(401, "unauthorized");
    /* token возвращаем, чтобы панель могла восстановить сессию после
       перезагрузки вкладки: токен живёт только в памяти страницы, а
       httpOnly-кука недоступна скриптам. */
    return json(200, { ok: true, admin: s.user.admin, token: s.token, expiresAt: s.user.session.expiresAt, csrf: http.csrfTokenFor(s.user.session.id) });
  }

  /* --- всё остальное требует авторизации --- */
  const gated = await requireAuth(ctx);
  if (gated.error) return err(gated.error.status, gated.error.error);
  const session = gated.session;

  /* Изменяющие методы: обязательная проверка CSRF */
  if (!SAFE_METHODS.has(method)) {
    const csrf = http.verifyCsrf({ headers: ctx.headers }, session.cookies, session.user.session);
    if (!csrf.ok) {
      audit.log("api.csrf-rejected", { ip: ctx.ip, path: pathname, method });
      return err(403, "csrf");
    }
  }

  const expectedRev = ctx.headers["if-match"] ? String(ctx.headers["if-match"]).replace(/[^\d]/g, "") : null;

  /* --- контент --- */
  if (pathname === "/api/admin/content") {
    if (method === "GET") { const r = await content.getAll(); return json(200, { ok: true, ...r }); }
    if (method === "PUT" || method === "POST") {
      const body = ctx.json || await readJsonCtx(ctx);
      return wrap(await content.replaceAll(body, expectedRev === null ? undefined : Number(expectedRev)));
    }
    return err(405, "method-not-allowed");
  }

  if (pathname === "/api/admin/hero") {
    if (method === "GET") { const r = await content.getAll(); return json(200, { ok: true, hero: r.content.hero, rev: r.rev }); }
    if (method === "PUT" || method === "PATCH") {
      const body = ctx.json || await readJsonCtx(ctx);
      return wrap(await content.setHero(body));
    }
    return err(405, "method-not-allowed");
  }

  if (pathname === "/api/admin/collections") {
    if (method === "GET") { const r = await content.getAll(); return json(200, { ok: true, collections: r.content.collections, rev: r.rev }); }
    if (method === "PUT") { const body = ctx.json || await readJsonCtx(ctx); return wrap(await content.setCollections(body.collections || body)); }
    if (method === "POST") { const body = ctx.json || await readJsonCtx(ctx); return wrap(await content.upsertCollection(body)); }
    return err(405, "method-not-allowed");
  }

  const colMatch = /^\/api\/admin\/collections\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  if (colMatch) {
    if (method === "PUT" || method === "PATCH") {
      const body = ctx.json || await readJsonCtx(ctx);
      return wrap(await content.upsertCollection({ ...body, id: colMatch[1] }));
    }
    if (method === "DELETE") return wrap(await content.deleteCollection(colMatch[1]));
    return err(405, "method-not-allowed");
  }

  if (pathname === "/api/admin/products") {
    if (method === "GET") { const r = await content.listProducts(); return json(200, { ok: true, ...r }); }
    if (method === "POST") { const body = ctx.json || await readJsonCtx(ctx); return wrap(await content.createProduct(body)); }
    return err(405, "method-not-allowed");
  }

  const prodMatch = /^\/api\/admin\/products\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  if (prodMatch) {
    const pid = prodMatch[1];
    if (method === "GET") { const r = await content.getProduct(pid); return r.ok === false ? err(r.status, r.reason) : json(200, { ok: true, ...r }); }
    if (method === "PUT" || method === "PATCH") { const body = ctx.json || await readJsonCtx(ctx); return wrap(await content.updateProduct(pid, body)); }
    if (method === "DELETE") return wrap(await content.deleteProduct(pid));
    return err(405, "method-not-allowed");
  }

  /* --- медиа --- */
  const photoMatch = /^\/api\/admin\/products\/([A-Za-z0-9_-]{1,64})\/photos$/.exec(pathname);
  if (photoMatch && method === "POST") {
    /* Тело — multipart. В Node-режиме ctx.stream есть, в serverless — ctx.body. */
    let parsed;
    try {
      parsed = ctx.stream
        ? await media.parseMultipart(ctx.stream, { maxFiles: config.maxPhotosPerProduct })
        : await media.parseMultipartBuffer(ctx.body, ctx.headers, { maxFiles: config.maxPhotosPerProduct });
    } catch (e) {
      return err(e.status || 400, e.message === "upload-too-large" ? "upload-too-large" : "multipart-invalid");
    }
    const replace = String(parsed.fields.replace || "true") !== "false";
    const res = await content.attachPhotos({ productId: photoMatch[1], files: parsed.files, replace });
    if (res && res.ok === false) {
      return { status: res.status || 400, json: { ok: false, error: res.reason || "error", rejected: res.rejected || [] } };
    }
    return wrap(res, 200);
  }

  const photoDelMatch = /^\/api\/admin\/products\/([A-Za-z0-9_-]{1,64})\/photos$/.exec(pathname);
  if (photoDelMatch && method === "DELETE") {
    const body = ctx.json || await readJsonCtx(ctx);
    return wrap(await content.removePhoto({ productId: photoDelMatch[1], url: body.url, index: Number.isInteger(body.index) ? body.index : null }));
  }

  if (pathname === "/api/admin/media/orphans" && method === "POST") {
    const { content: c } = await content.getAll();
    const r = await media.pruneOrphans(c);
    return json(200, { ok: true, ...r });
  }

  /* --- сброс к встроенному каталогу --- */
  if (pathname === "/api/admin/reset" && method === "POST") return wrap(await content.resetToSeed());

  /* --- управление учётками (только авторизованный админ) --- */
  if (pathname === "/api/admin/admins" && method === "GET") {
    return json(200, { ok: true, admins: auth.listAdmins() });
  }
  if (pathname === "/api/admin/admins" && method === "POST") {
    const body = ctx.json || await readJsonCtx(ctx);
    const loginErr = auth.validateLogin(body.login);
    if (loginErr) return err(400, loginErr);
    const passErr = auth.validatePassword(body.password);
    if (passErr) return err(400, passErr);
    const r = await auth.createAdmin({ login: body.login, password: body.password, mustChangePassword: !!body.mustChangePassword });
    return wrap(r, 201);
  }

  if (pathname === "/api/admin/password" && method === "POST") {
    const body = ctx.json || await readJsonCtx(ctx);
    const adminId = session.user.admin.id;
    /* Смена пароля требует подтверждения текущего — кроме случая,
       когда учётка помечена как требующая смены. */
    if (!session.user.admin.mustChangePassword) {
      const a = auth.findAdmin(adminId);
      if (!a || !auth.verifyPassword(String(body.currentPassword || ""), a.passHash)) {
        audit.log("admin.password-change-denied", { adminId, ip: ctx.ip });
        return err(403, "current-password-invalid");
      }
    }
    const r = await auth.changePassword(adminId, body.newPassword);
    return wrap(r);
  }

  if (pathname === "/api/admin/recovery-token" && method === "POST") {
    /* Операционный путь восстановления: выпуск одноразового токена для
       конкретного админа. Доступен только уже авторизованному админу —
       если доступ утерян полностью, токен выпускается через CLI на сервере. */
    const body = ctx.json || await readJsonCtx(ctx);
    const target = body.adminId ? String(body.adminId).slice(0, 32) : session.user.admin.id;
    const r = await auth.createResetToken(target);
    if (!r.ok) return err(404, r.reason);
    audit.log("admin.recovery-token-issued", { by: session.user.admin.id, target, ip: ctx.ip });
    return json(200, { ok: true, token: r.token, expiresAt: r.expiresAt });
  }

  if (pathname === "/api/admin/audit" && method === "GET") {
    const fs = require("node:fs");
    let lines = [];
    try {
      lines = fs.readFileSync(config.logFile, "utf8").split("\n").filter(Boolean).slice(-300);
    } catch (e) {}
    return json(200, { ok: true, entries: lines.map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l.slice(0, 300) }; } }) });
  }

  return err(404, "not-found");
}

/* ---------- обёртки ---------- */
function wrap(res, okStatus = 200) {
  if (!res) return err(500, "internal");
  if (res.ok === false) return err(res.status || 400, res.reason || "error", res.details);
  return json(okStatus, Object.assign({}, res, { ok: true }));
}

async function readJsonCtx(ctx) {
  if (ctx.json) return ctx.json;
  try {
    ctx.json = http.stripDangerousKeys(JSON.parse(ctx.body && ctx.body.length ? ctx.body.toString("utf8") : "{}"));
  } catch (e) {
    throw Object.assign(new Error("invalid-json"), { status: 400 });
  }
  if (!ctx.json || typeof ctx.json !== "object" || Array.isArray(ctx.json)) {
    throw Object.assign(new Error("invalid-json-shape"), { status: 400 });
  }
  return ctx.json;
}

/* ---------- вход ---------- */
async function loginRoute(ctx) {
  let body;
  try { body = await readJsonCtx(ctx); } catch (e) { return err(e.status || 400, "invalid-json"); }

  const login = sanitize.str(body.login, config.login.max + 8);
  const password = String(body.password == null ? "" : body.password).slice(0, config.password.max + 8);

  const r = await auth.login({ login, password, ip: ctx.ip, ua: ctx.headers["user-agent"] });
  if (!r.ok) {
    const status = r.reason === "rate" ? 429 : r.reason === "locked" ? 423 : 401;
    /* Если учётных записей ещё нет вообще, вход невозможен в принципе —
       это не «перебор», а ошибка развёртывания (не заданы DF_BOOTSTRAP_*).
       Подсказка экономит часы отладки и не помогает перебору: rate-limit
       и блокировка применяются как обычно. */
    let hint;
    try {
      if (r.reason === "bad" && store.read((db) => db.admins.length) === 0) hint = "no-admins";
    } catch (e) { /* store недоступен — подсказку не даём */ }
    return json(status, {
      ok: false,
      /* Намеренно не различаем «нет такой учётки» и «неверный пароль» */
      error: r.reason === "bad" ? "invalid-credentials" : r.reason,
      ...(hint ? { hint } : {}),
      retryAfter: r.retryAfter || undefined,
      attemptsLeft: r.attemptsLeft,
    });
  }

  audit.log("api.login-ok", { ip: ctx.ip, adminId: r.admin.id });
  return {
    status: 200,
    json: {
      ok: true,
      admin: r.admin,
      token: r.token,                       // для Authorization: Bearer (хранится только в памяти вкладки)
      csrf: http.csrfTokenFor(r.sessionId),
      expiresAt: r.expiresAt,
      sessionTtlMs: config.sessionTtlMs,
    },
    setSession: { token: r.token, expiresAt: r.expiresAt, sessionId: r.sessionId },
  };
}

/* ---------- восстановление по одноразовому токену ---------- */
async function resetRoute(ctx) {
  let body;
  try { body = await readJsonCtx(ctx); } catch (e) { return err(e.status || 400, "invalid-json"); }
  const r = await auth.resetPasswordWithToken({
    token: sanitize.str(body.token, 200),
    newPassword: String(body.newPassword == null ? "" : body.newPassword).slice(0, config.password.max + 8),
  });
  if (!r.ok) {
    audit.log("api.reset-failed", { ip: ctx.ip, reason: r.reason });
    return err(400, r.reason === "bad-token" ? "invalid-token" : r.reason);
  }
  audit.log("api.reset-ok", { ip: ctx.ip, adminId: r.admin.id });
  return json(200, { ok: true, admin: r.admin });
}

module.exports = { handle, getSession, wrap, err, json, SAFE_METHODS };
