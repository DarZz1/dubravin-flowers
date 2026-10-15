"use strict";
/* =========================================================
   BACKEND · КОНФИГУРАЦИЯ
   Все настройки — из переменных окружения, секретов в коде нет.
   Значения по умолчанию безопасны для локальной разработки;
   для продакшена обязательны SECRET и работа по HTTPS.
   ========================================================= */
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..", "..");          // корень сайта
const HERE = __dirname;                                    // backend/server
const BACKEND = path.resolve(HERE, "..");                   // backend/

function bool(v, def) {
  if (v === undefined || v === "" || v === null) return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/* --- backend/.env: простой парсер, без внешних зависимостей --- */
function loadDotEnv(file) {
  try {
    const txt = require("node:fs").readFileSync(file, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (!m) continue;
      if (line.trim().startsWith("#")) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (e) { /* файла нет — работаем от процесса */ }
}
loadDotEnv(path.join(BACKEND, ".env"));

/* Данные сервера (БД, медиа, сессии) живут ВНЕ публикуемой части сайта:
   backend/data/ закрыт от веба и исключён из git. */
const NODE_ENV = process.env.NODE_ENV || "development";
const isProd = NODE_ENV === "production";

/* Netlify: переменные NETLIFY и NETLIFY_SITE_ID платформа задаёт сама.
   Постоянной файловой системы там нет, поэтому данные уходят в Netlify
   Blobs (см. store-blobs.js), а рабочий каталог — в эфемерный /tmp. */
const isNetlify = !!(process.env.NETLIFY || process.env.NETLIFY_SITE_ID);

const DATA_DIR = path.resolve(
  process.env.DF_DATA_DIR || (isNetlify ? "/tmp/df-data" : path.join(BACKEND, "data"))
);


const config = {
  env: NODE_ENV,
  isProd,
  isNetlify,

  /* --- сеть --- */
  host: process.env.HOST || "127.0.0.1",
  port: int(process.env.PORT, 8090),
  /* За сайтом стоит reverse-proxy (nginx/Netlify) — доверяем X-Forwarded-Proto
     только когда это явно разрешено. */
  trustProxy: bool(process.env.DF_TRUST_PROXY, isProd),

  /* --- пути --- */
  root: ROOT,
  /* Корень, из которого раздаётся статика. Совпадает с root, но может быть
     переопределён (DF_STATIC_ROOT) — используется тестами, чтобы не писать
     в реальный каталог сайта. */
  staticRoot: path.resolve(process.env.DF_STATIC_ROOT || ROOT),
  serverDir: HERE,
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, "db.json"),
  mediaDir: path.join(DATA_DIR, "media"),     // сюда пишутся фото (отдаются как /img/<id>/<n>.<ext>)
  /* Публикуемые данные (img/ и data.json) можно вынести отдельно от корня
     статики — это нужно тестам, чтобы не писать в реальный каталог сайта,
     и полезно на VPS, если медиа смонтированы отдельным томом. */
  publicRoot: path.resolve(process.env.DF_PUBLIC_ROOT || ROOT),
  publicImgDir: path.resolve(process.env.DF_IMG_DIR || path.join(process.env.DF_PUBLIC_ROOT || ROOT, "img")),
  publicDataJson: path.resolve(process.env.DF_DATA_JSON || path.join(process.env.DF_PUBLIC_ROOT || ROOT, "data.json")),
  logFile: path.join(DATA_DIR, "audit.log"),

  /* --- криптография --- */
  secret: process.env.DF_SECRET || "",         // обязателен в продакшене
  scrypt: {
    N: int(process.env.DF_SCRYPT_N, 1 << 17),  // 131072 — ~100 мс на проверке
    r: int(process.env.DF_SCRYPT_R, 8),
    p: int(process.env.DF_SCRYPT_P, 1),
    keylen: 64,
  },

  /* --- сессии --- */
  sessionTtlMs: int(process.env.DF_SESSION_TTL_MS, 30 * 60 * 1000),  // 30 минут
  cookieName: "__Host-df-session",
  cookieNameDev: "df-session",
  /* SameSite=Strict + httpOnly + Secure: CSRF закрыт на уровне браузера. */
  sameSite: "Strict",

  /* --- защита от перебора --- */
  maxFails: int(process.env.DF_MAX_FAILS, 5),
  lockBaseMs: int(process.env.DF_LOCK_BASE_MS, 30 * 1000),
  lockMaxMs: int(process.env.DF_LOCK_MAX_MS, 15 * 60 * 1000),
  /* Лимит попыток на IP за окно (защита от распределённого перебора) */
  rateWindowMs: int(process.env.DF_RATE_WINDOW_MS, 10 * 60 * 1000),
  rateMax: int(process.env.DF_RATE_MAX, 30),

  /* --- входные данные --- */
  login: { min: 3, max: 64 },
  password: { min: 8, max: 128 },
  maxBodyBytes: int(process.env.DF_MAX_BODY, 1024 * 1024),           // 1 МБ JSON
  maxUploadBytes: int(process.env.DF_MAX_UPLOAD, 8 * 1024 * 1024),   // 8 МБ на файл
  maxUploadTotal: int(process.env.DF_MAX_UPLOAD_TOTAL, 24 * 1024 * 1024),
  maxPhotosPerProduct: 5,          /* лимит фото на товар (совпадает с CMS) */
  maxProducts: 2000,
  allowedImageTypes: {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  },
  /* Изображение ужимается до этой ширины (если sharp/резайз недоступен —
     файл сохраняется как есть, но в пределах maxUploadBytes). */
  resizeMaxWidth: int(process.env.DF_RESIZE_WIDTH, 1600),

  /* --- лимиты содержимого (совпадают с sanitizeDB в assets/js/store.js) --- */
  limits: {
    name: 160,
    desc: 2000,
    imgs: 5,             /* максимум фото у товара */
    comp: 10,            /* максимум позиций «Состава» */
    compItem: 120,
    collections: 40,
    mainOnHome: 4,       /* максимум карточек/подборок «На главной» */
    hero: 12,
    id: 64,
  },
};

/* Секрет требуется в продакшене: без него сессионный токен предсказуем. */
function assertProductionReady() {
  const problems = [];
  if (isProd && !config.secret) problems.push("DF_SECRET не задан");
  if (isProd && !config.isNetlify && config.host === "127.0.0.1" && !bool(process.env.DF_ALLOW_LOOPBACK_BIND, false)) {
    problems.push("в продакшене HOST=127.0.0.1 допустим только за reverse-proxy (DF_ALLOW_LOOPBACK_BIND=1)");
  }
  if (isProd && config.isNetlify && !bool(process.env.DF_BLOBS_OK, true)) {
    problems.push("на Netlify отключено хранилище Blobs (DF_BLOBS_OK=0) — данные не сохраняются");
  }
  return problems;
}

function ensureSecret() {
  if (config.secret) return config.secret;
  /* Локальная разработка: одноразовый секрет на процесс. Сессии не переживут
     перезапуск — это ожидаемо и безопасно. */
  config.secret = crypto.randomBytes(32).toString("hex");
  config.ephemeralSecret = true;
  return config.secret;
}

function ensureDirs() {
  for (const d of [config.dataDir, config.mediaDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

module.exports = { config, assertProductionReady, ensureSecret, ensureDirs, BACKEND, isNetlify };
