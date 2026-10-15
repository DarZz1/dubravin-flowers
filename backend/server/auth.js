"use strict";
/* =========================================================
   BACKEND · АУТЕНТИФИКАЦИЯ
   Пароль проверяется ТОЛЬКО здесь, на сервере. Клиент получает
   лишь httpOnly-cookie с токеном сессии — ни логина, ни хэша,
   ни факта существования учётки.

   • хэш: scrypt (N=2^17, r=8, p=1), соль 16 байт, ключ 64 байта
   • сравнение: crypto.timingSafeEqual — без timing-атак
   • сессия: 32 байта CSPRNG, в БД хранится HMAC-хэш токена
   • перебор: 5 неудач → блокировка 30 с с удвоением, потолок 15 мин
   • дополнительно: лимит попыток на IP за 10 минут
   ========================================================= */
const crypto = require("node:crypto");
const store = require("./store.js");
const { config } = require("./config.js");
const audit = require("./audit.js");

/* ---------- хэширование пароля ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = config.scrypt;
  const key = crypto.scryptSync(String(password), salt, keylen, { N, r, p, maxmem: 512 * 1024 * 1024 });
  return ["scrypt", N, r, p, salt.toString("hex"), key.toString("hex")].join("$");
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = parseInt(parts[1], 10), r = parseInt(parts[2], 10), p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    if (!salt.length || !expected.length) return false;
    const key = crypto.scryptSync(String(password), salt, expected.length, { N, r, p, maxmem: 512 * 1024 * 1024 });
    /* постоянная длительность сравнения */
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch (e) {
    return false;
  }
}

/* Формат хэша валиден и не является «предвычисленным бэкдором» */
function isHashFormatValid(stored) {
  return /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(String(stored || ""));
}

/* ---------- нормализация логина ---------- */
function normalizeLogin(login) {
  return String(login || "").trim().toLowerCase();
}

function validateLogin(login) {
  const s = String(login || "");
  if (s.length < config.login.min || s.length > config.login.max) return "login-length";
  if (!/^[A-Za-z0-9._@-]+$/.test(s)) return "login-charset";
  return null;
}

function validatePassword(password) {
  const s = String(password || "");
  if (s.length < config.password.min) return "password-short";
  if (s.length > config.password.max) return "password-long";
  return null;
}

/* ---------- блокировка перебора ---------- */
function lockMsFor(fails) {
  const over = Math.max(0, fails - config.maxFails);
  return Math.min(config.lockBaseMs * Math.pow(2, over), config.lockMaxMs);
}

function getAttemptState(loginNorm) {
  const db = store.load();
  return db.loginAttempts.find((a) => a.login === loginNorm) || null;
}

function lockoutState(loginNorm) {
  const a = getAttemptState(loginNorm);
  const now = Date.now();
  if (!a) return { locked: false, retryAfter: 0, fails: 0, attemptsLeft: config.maxFails };
  const locked = !!a.lockedUntil && a.lockedUntil > now;
  return {
    locked,
    retryAfter: locked ? Math.ceil((a.lockedUntil - now) / 1000) * 1000 : 0,
    fails: a.fails || 0,
    attemptsLeft: Math.max(0, config.maxFails - (a.fails || 0)),
  };
}

function registerFailure(loginNorm) {
  return store.update((db) => {
    let a = db.loginAttempts.find((x) => x.login === loginNorm);
    if (!a) { a = { login: loginNorm, fails: 0, lockedUntil: 0 }; db.loginAttempts.push(a); }
    a.fails += 1;
    if (a.fails >= config.maxFails) a.lockedUntil = Date.now() + lockMsFor(a.fails);
    return lockoutStateOf(a);
  });
}
function lockoutStateOf(a) {
  const now = Date.now();
  const locked = !!a.lockedUntil && a.lockedUntil > now;
  return { locked, retryAfter: locked ? a.lockedUntil - now : 0, fails: a.fails };
}

function clearFailures(loginNorm) {
  return store.update((db) => {
    db.loginAttempts = db.loginAttempts.filter((x) => x.login !== loginNorm);
  });
}

/* ---------- лимит по IP ---------- */
function rateLimited(ip) {
  const db = store.load();
  const now = Date.now();
  let rec = db.rate.find((r) => r.ip === ip);
  if (!rec) return false;
  rec.hits = (rec.hits || []).filter((t) => now - t < config.rateWindowMs);
  return rec.hits.length >= config.rateMax;
}

function rateHit(ip) {
  return store.update((db) => {
    const now = Date.now();
    let rec = db.rate.find((r) => r.ip === ip);
    if (!rec) { rec = { ip, hits: [] }; db.rate.push(rec); }
    rec.hits = rec.hits.filter((t) => now - t < config.rateWindowMs);
    rec.hits.push(now);
  });
}

/* ---------- учётные записи ---------- */
function createAdmin({ login, password, mustChangePassword = false }) {
  const loginErr = validateLogin(login);
  if (loginErr) return Promise.resolve({ ok: false, reason: loginErr });
  const passErr = validatePassword(password);
  if (passErr) return Promise.resolve({ ok: false, reason: passErr });

  return store.update((db) => {
    const loginNorm = normalizeLogin(login);
    if (db.admins.some((a) => a.loginNorm === loginNorm)) return { ok: false, reason: "exists" };
    const admin = {
      id: crypto.randomBytes(8).toString("hex"),
      login: String(login).trim(),
      loginNorm,
      passHash: hashPassword(password),
      createdAt: Date.now(),
      mustChangePassword: !!mustChangePassword,
    };
    db.admins.push(admin);
    audit.log("admin.create", { adminId: admin.id, login: admin.login });
    return { ok: true, admin: publicAdmin(admin) };
  });
}

function publicAdmin(a) {
  /* Наружу — только нечувствительные поля. passHash не покидает сервер. */
  return a ? { id: a.id, login: a.login, createdAt: a.createdAt, mustChangePassword: !!a.mustChangePassword } : null;
}

function listAdmins() {
  return store.read((db) => db.admins.map(publicAdmin));
}

function findAdmin(loginOrId) {
  const db = store.load();
  const norm = normalizeLogin(loginOrId);
  return db.admins.find((a) => a.loginNorm === norm || a.id === loginOrId) || null;
}

function changePassword(adminId, newPassword) {
  const passErr = validatePassword(newPassword);
  if (passErr) return Promise.resolve({ ok: false, reason: passErr });
  return store.update((db) => {
    const a = db.admins.find((x) => x.id === adminId);
    if (!a) return { ok: false, reason: "no-admin" };
    a.passHash = hashPassword(newPassword);
    a.mustChangePassword = false;
    a.passChangedAt = Date.now();
    /* Все сессии этого админа истекают — devices разлогиниваются. */
    db.sessions = db.sessions.filter((s) => s.adminId !== adminId);
    db.loginAttempts = db.loginAttempts.filter((x) => x.login !== a.loginNorm);
    audit.log("admin.password-changed", { adminId });
    return { ok: true };
  });
}

/* ---------- вход / сессии ---------- */
function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function login({ login, password, ip, ua }) {
  const loginNorm = normalizeLogin(login);
  const loginErr = validateLogin(login);
  const passErr = validatePassword(password);

  if (loginErr || passErr) {
    /* Формально неверные данные. Важно: это НЕ быстрый выход —
       иначе перебор заведомо короткими паролями никогда не упирался бы
       в блокировку. Считаем неудачу, а ответ делаем неотличимым от
       «неверный пароль», чтобы не раскрывать существование учётки. */
    const after = await registerFailure(loginNorm);
    audit.log("auth.invalid-input", { ip, reason: loginErr || passErr, fails: after.fails, locked: after.locked });
    return {
      ok: false,
      reason: after.locked ? "locked" : "bad",
      retryAfter: after.retryAfter || 0,
      attemptsLeft: Math.max(0, config.maxFails - after.fails),
    };
  }

  /* Лимит по IP проверяем перед дорогим scrypt — и учитываем только те
     запросы, которые дошли до проверки пароля. */
  await rateHit(ip);
  if (rateLimited(ip)) {
    audit.log("auth.rate-limited", { ip });
    return { ok: false, reason: "rate", retryAfter: config.rateWindowMs };
  }

  const st = lockoutState(loginNorm);
  if (st.locked) {
    audit.log("auth.locked", { ip, login: loginNorm, retryAfter: st.retryAfter });
    return { ok: false, reason: "locked", retryAfter: st.retryAfter };
  }

  const admin = findAdmin(loginNorm);
  /* Хэш всё равно считаем, чтобы время ответа не зависело от существования
     учётки (иначе — перечисление логинов по таймингу). */
  const ok = verifyPassword(password, admin ? admin.passHash : DUMMY_HASH);

  if (!admin || !ok) {
    const after = await registerFailure(loginNorm);
    audit.log("auth.fail", { ip, login: loginNorm, fails: after.fails, locked: after.locked });
    return {
      ok: false,
      reason: after.locked ? "locked" : "bad",
      retryAfter: after.retryAfter || 0,
      attemptsLeft: Math.max(0, config.maxFails - after.fails),
    };
  }

  await clearFailures(loginNorm);
  const token = newToken();
  const now = Date.now();
  const session = await store.update((db) => {
    store.pruneExpired(db);
    const s = {
      id: crypto.randomBytes(8).toString("hex"),
      tokenHash: store.hashToken(token),
      adminId: admin.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + config.sessionTtlMs,
      ip: String(ip || "").slice(0, 64),
      ua: String(ua || "").slice(0, 200),
    };
    db.sessions.push(s);
    return s;
  });

  audit.log("auth.ok", { ip, adminId: admin.id, login: admin.login });
  return {
    ok: true,
    token,
    sessionId: session.id,
    admin: publicAdmin(admin),
    expiresAt: session.expiresAt,
  };
}

/* Продление сессии по активности (скользящий таймаут).
   ВАЖНО: запись выполняется ДО ответа клиенту. Фоновая (fire-and-forget)
   запись создавала гонку: продление могло лечь на диск позже постороннего
   изменения файла и перезаписать его. */
async function touchSession(token) {
  const s = store.findSessionByToken(token);
  if (!s) return null;
  await store.update((db) => {
    const rec = db.sessions.find((x) => x.id === s.id);
    if (rec) {
      rec.lastSeenAt = Date.now();
      rec.expiresAt = Date.now() + config.sessionTtlMs;
    }
  }).catch(() => {});
  return s;
}

function logout(token) {
  if (!token) return Promise.resolve({ ok: true });
  const h = store.hashToken(token);
  return store.update((db) => {
    const before = db.sessions.length;
    db.sessions = db.sessions.filter((s) => s.tokenHash !== h);
    return { ok: true, removed: before - db.sessions.length };
  });
}

function sessionUser(token) {
  const s = store.findSessionByToken(token);
  if (!s) return null;
  const admin = store.read((db) => db.admins.find((a) => a.id === s.adminId));
  if (!admin) return null;
  return { admin: publicAdmin(admin), session: { id: s.id, expiresAt: s.expiresAt } };
}

/* ---------- восстановление доступа ---------- */
/* Токен сброса: одноразовый, 15 минут, в БД хранится только хэш.
   Выпускается оператором с сервера (CLI) — то есть восстановление возможно
   даже если пароль утерян полностью, но требует доступа к серверу. */
function createResetToken(adminId, ttlMs = 15 * 60 * 1000) {
  return store.update((db) => {
    const a = db.admins.find((x) => x.id === adminId);
    if (!a) return { ok: false, reason: "no-admin" };
    store.pruneExpired(db);
    const token = newToken();
    db.resetTokens.push({
      id: crypto.randomBytes(8).toString("hex"),
      tokenHash: store.hashToken(token),
      adminId,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      used: false,
    });
    audit.log("auth.reset-token-created", { adminId });
    return { ok: true, token, expiresAt: Date.now() + ttlMs };
  });
}

async function resetPasswordWithToken({ token, newPassword }) {
  const passErr = validatePassword(newPassword);
  if (passErr) return { ok: false, reason: passErr };
  const h = store.hashToken(String(token || ""));
  const rec = store.read((db) => db.resetTokens.find((t) => t.tokenHash === h));
  if (!rec || rec.used || rec.expiresAt < Date.now()) {
    audit.log("auth.reset-token-invalid", {});
    return { ok: false, reason: "bad-token" };
  }
  const res = await store.update((db) => {
    const t = db.resetTokens.find((x) => x.id === rec.id);
    if (!t || t.used) return { ok: false, reason: "bad-token" };
    t.used = true;
    const a = db.admins.find((x) => x.id === t.adminId);
    if (!a) return { ok: false, reason: "no-admin" };
    a.passHash = hashPassword(newPassword);
    a.mustChangePassword = false;
    a.passChangedAt = Date.now();
    db.sessions = db.sessions.filter((s) => s.adminId !== a.id);
    db.loginAttempts = db.loginAttempts.filter((x) => x.login !== a.loginNorm);
    audit.log("auth.password-reset", { adminId: a.id });
    return { ok: true, admin: publicAdmin(a) };
  });
  return res;
}

/* Константный «пустой» хэш для выравнивания времени ответа */
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString("hex"));

module.exports = {
  hashPassword, verifyPassword, isHashFormatValid,
  validateLogin, validatePassword, normalizeLogin,
  createAdmin, listAdmins, findAdmin, changePassword, publicAdmin,
  login, logout, touchSession, sessionUser, newToken,
  lockoutState, lockMsFor, clearFailures,
  createResetToken, resetPasswordWithToken,
};
