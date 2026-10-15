"use strict";
/* =========================================================
   BACKEND · ХРАНИЛИЩЕ
   JSON-файл с атомарной записью (tmp → fsync → rename) и
   последовательной очередью мутаций. Осознанно без внешних
   зависимостей: переносится на любой хостинг как есть, а при
   необходимости заменяется на SQLite/Postgres без смены API —
   все обращения идут через read()/update().
   ========================================================= */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { config, ensureDirs } = require("./config.js");

/* ---------- структура БД ---------- */
function emptyDB() {
  return {
    v: 1,
    admins: [],          // [{ id, login, loginNorm, passHash, createdAt, mustChangePassword }]
    sessions: [],        // [{ id, tokenHash, adminId, createdAt, lastSeenAt, expiresAt, ip, ua }]
    resetTokens: [],     // [{ id, tokenHash, adminId, createdAt, expiresAt, used }]
    loginAttempts: [],   // [{ login, fails, lockedUntil }]
    rate: [],            // [{ ip, hits: [ts…] }]
    content: null,       // { hero, collections, products } — как data.json витрины
    contentRev: 0,       // ревизия контента: растёт только при успешной публикации
    meta: { createdAt: Date.now(), updatedAt: Date.now(), rev: 0 },
  };
}

let cache = null;
let queue = Promise.resolve();

/* ---------- бэкенд хранилища ----------
   По умолчанию — файловая система (локально и на VPS): persist() пишет сразу,
   hydrate()/flush() ничего не делают. На Netlify подключается store-blobs.js:
   там чтение возможно только асинхронно, поэтому адаптер функции обязан
   вызвать hydrate() до обработки запроса и flush() до возврата ответа. */
let backend = null;
let writes = Promise.resolve();
let hydrated = false;

function setBackend(b) { backend = b; }
function getBackend() { return backend; }

/* Прочитать БД из внешнего хранилища в память (один раз на вызов функции) */
async function hydrate() {
  if (!backend) { hydrated = true; return; }
  const raw = await backend.readDB();
  cache = normalize(raw);
  hydrated = true;
}

/* Дождаться всех отложенных записей во внешнее хранилище */
function flush() {
  return writes.then(() => {}, () => {});
}

function scheduleWrite(db) {
  if (!backend) return;
  writes = writes.then(() => backend.writeDB(db)).catch((e) => {
    try { require("./audit.js").log("store.write-failed", { message: String(e && e.message).slice(0, 200) }); } catch (e2) {}
  });
}

/* ---------- детекция внешней подмены файла ----------
   Отпечаток = размер + mtime(ns) + inode + SHA-256 содержимого. Файл БД
   небольшой (десятки КБ), поэтому хэширование стоит доли миллисекунды,
   зато детекция абсолютно надёжна: любая внешняя правка (восстановление
   из бэкапа, ручное изменение, работа второго процесса) меняет отпечаток
   и кэш перечитывается.

   Почему не отдельный счётчик внутри файла и не один лишь mtime: счётчик
   подвержен гонке между кэшем и очередью записи, а mtime может не меняться
   при совпавшей длине и гранулярности ФС.                              */
let ownFingerprint = null;

function fileFingerprint() {
  try {
    const st = fs.statSync(config.dbFile);
    const buf = fs.readFileSync(config.dbFile);
    return st.size + ":" + st.mtimeMs + ":" + st.ino + ":" +
      crypto.createHash("sha256").update(buf).digest("base64url").slice(0, 22);
  } catch (e) {
    return null;                     // файла нет
  }
}

/* Принудительный сброс кэша (обслуживание, тесты) */
function invalidate() {
  cache = null;
  ownFingerprint = null;
}

/* ---------- атомарная запись ---------- */
function persist(db) {
  if (backend) { scheduleWrite(db); return; }     // файловая запись не нужна
  ensureDirs();
  const tmp = config.dbFile + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(db, null, 2));
    fs.fsyncSync(fd);                                // данные на диске до переименования
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, config.dbFile);                 // атомарно в пределах ФС
  try {
    const dir = fs.openSync(path.dirname(config.dbFile), "r");
    fs.fsyncSync(dir);                               // фиксируем и запись о файле
    fs.closeSync(dir);
  } catch (e) { /* не все ФС позволяют fsync каталога */ }
  try { fs.chmodSync(config.dbFile, 0o600); } catch (e) {}
  ownFingerprint = fileFingerprint();
}

/* Белая сборка объекта БД: посторонние поля (включая __proto__) не проникают.
   Используется и для файла, и для внешнего хранилища. */
function normalize(parsed) {
  const base = emptyDB();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return base;
  return {
    v: Number.isFinite(parsed.v) ? parsed.v : base.v,
    admins: Array.isArray(parsed.admins) ? parsed.admins : base.admins,
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : base.sessions,
    resetTokens: Array.isArray(parsed.resetTokens) ? parsed.resetTokens : base.resetTokens,
    loginAttempts: Array.isArray(parsed.loginAttempts) ? parsed.loginAttempts : base.loginAttempts,
    rate: Array.isArray(parsed.rate) ? parsed.rate : base.rate,
    content: parsed.content && typeof parsed.content === "object" ? parsed.content : null,
    contentRev: Number.isFinite(parsed.contentRev) ? parsed.contentRev : 0,
    meta: Object.assign(base.meta, parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {}),
  };
}

/* ---------- чтение ---------- */
function load() {
  if (backend) {
    /* Внешнее хранилище: чтение асинхронно, поэтому к этому моменту
       адаптер уже обязан был вызвать hydrate(). */
    if (!hydrated || !cache) {
      throw new Error("store не гидратирован: вызовите await store.hydrate() перед обработкой запроса");
    }
    return cache;
  }
  /* Предыдущее состояние запоминаем ДО сброса кэша: оно нужно ветке
     восстановления после повреждения файла, чтобы не потерять учётки. */
  const prev = cache;
  if (cache) {
    const fp = fileFingerprint();
    if (fp !== null && fp === ownFingerprint) return cache;   // на диске наша запись
    if (fp === null) return cache;                            // файла нет — работаем с кэшем
    cache = null;                                             // файл изменили извне
  }
  ensureDirs();

  if (!fs.existsSync(config.dbFile)) {
    cache = emptyDB();
    persist(cache);
    return cache;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(config.dbFile, "utf8"));
    cache = normalize(parsed);
    ownFingerprint = fileFingerprint();
  } catch (e) {
    /* Повреждённый файл не затираем молча — сохраняем копию для разбора.
       Учётки и сессии берём из последнего валидного кэша: иначе повреждение
       файла молча «разлогинивало» бы админов и требовало заново их создавать. */
    try {
      fs.copyFileSync(config.dbFile, config.dbFile + ".corrupt." + Date.now());
    } catch (e2) { /* копия не важна для работоспособности */ }
    cache = emptyDB();
    if (prev) {
      cache.admins = Array.isArray(prev.admins) ? prev.admins : [];
      cache.sessions = Array.isArray(prev.sessions) ? prev.sessions : [];
      cache.resetTokens = Array.isArray(prev.resetTokens) ? prev.resetTokens : [];
      cache.content = prev.content || null;
      cache.contentRev = prev.contentRev || 0;
      cache.meta = prev.meta || cache.meta;
    }
    persist(cache);
  }
  return cache;
}

/* ---------- мутации ----------
   Все записи идут строго последовательно: нет гонки «прочитал-изменил-записал». */
function update(fn) {
  const run = queue.then(async () => {
    const db = load();
    const result = await fn(db);
    db.meta.updatedAt = Date.now();
    db.meta.rev = (db.meta.rev || 0) + 1;
    persist(db);
    return result;
  });
  /* В общую очередь кладём вариант без исключения, чтобы одна ошибка
     не ломала все последующие операции. */
  queue = run.catch(() => {});
  return run;
}

function read(fn) {
  const db = load();
  return fn ? fn(db) : db;
}

/* ---------- контент витрины ---------- */
function getContent() {
  return read((db) => db.content);
}

function setContent(next) {
  /* Ревизия контента меняется только здесь: служебные записи (сессии,
     счётчики неудач) её не трогают, иначе If-Match конфликтовал бы сам с собой. */
  return update((db) => {
    db.content = next;
    db.contentRev = (db.contentRev || 0) + 1;
    return next;
  });
}

function contentRev() {
  return read((db) => db.contentRev || 0);
}

/* Публикуем каталог для витрины: data.json рядом с index.html. */
function publishDataJson(content) {
  /* В serverless корень публикации доступен только для чтения, а он и не
     нужен: витрина берёт каталог из GET /api/content. На VPS и локально
     файл публикуется как раньше — это позволяет раздавать каталог
     статикой и переживать временную недоступность API. */
  if (backend || config.isNetlify) return false;
  const tmp = config.publicDataJson + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(content, null, 2));
  fs.renameSync(tmp, config.publicDataJson);          // атомарно
  return true;
}

/* ---------- сессии ---------- */
function hashToken(token) {
  /* В БД хранится только HMAC-хэш токена: утечка файла не даёт доступа. */
  return crypto.createHmac("sha256", config.secret || "dev").update(String(token)).digest("hex");
}

function findSessionByToken(token) {
  if (!token) return null;
  const h = hashToken(token);
  const db = load();
  const now = Date.now();
  return db.sessions.find((s) => s.tokenHash === h && s.expiresAt > now) || null;
}

function pruneExpired(db) {
  const now = Date.now();
  db.sessions = db.sessions.filter((s) => s.expiresAt > now);
  db.resetTokens = db.resetTokens.filter((t) => !t.used && t.expiresAt > now);
  db.rate = db.rate.filter((r) => Array.isArray(r.hits) && r.hits.some((t) => now - t < config.rateWindowMs));
}

module.exports = {
  emptyDB, normalize, load, read, update, persist, invalidate,
  setBackend, getBackend, hydrate, flush,
  getContent, setContent, contentRev, publishDataJson,
  hashToken, findSessionByToken, pruneExpired,
};
