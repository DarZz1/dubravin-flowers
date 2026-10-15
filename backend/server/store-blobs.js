"use strict";
/* =========================================================
   BACKEND · ХРАНИЛИЩЕ НА NETLIFY BLOBS
   Постоянное хранилище для serverless: в отличие от /tmp оно
   переживает выгрузку инстанса и деплои, доступно из Functions
   без внешних аккаунтов и ключей (siteID и token подставляет
   сама платформа).

   Как устроено согласование с синхронным API store.js:
     • hydrate() — один раз в начале вызова функции читает БД из
       блоба в память. Дальше все чтения синхронны и работают с
       этой копией, поэтому остальной код бэкенда не меняется;
     • каждая мутация пишется и в память, и в очередь отложенных
       записей в блоб;
     • flush() — адаптер дожидается её ПЕРЕД возвратом ответа.
       Это обязательно: serverless-инстанс может быть заморожен
       сразу после ответа, и «фоновая» запись просто не успеет.

   Ограничение платформы: при нескольких одновременных записях
   побеждает последняя (last write wins). Для магазина с одним-двумя
   админами это приемлемо, а конфликт правок контента всё равно
   ловится на уровне ревизий (If-Match → 409).

   Ключи:
     db            — вся БД (админы, сессии, контент, счётчики)
     img/<ID>/<n>.<ext> — медиафайлы
   ========================================================= */
const { config } = require("./config.js");

const DB_KEY = "db";
const STORE_NAME = process.env.DF_BLOBS_STORE || "dubravin";
const fs = require("node:fs");
const path = require("node:path");

let blobs = null;         // объект-стор Netlify Blobs
let blobsAvailable = false;

/* ---------- локальный mock хранилища ----------
   Netlify Blobs доступен только внутри Functions/Edge/Build, поэтому
   проверить адаптер на реальной платформе из песочницы нельзя. Mock
   повторяет контракт стора (get/set/setJSON/delete/list с prefix и
   cursor) поверх обычной папки, что даёт:
     • возможность прогнать серверный код Netlify локально;
     • автоматические тесты адаптера (tests/backend/netlify-adapter.test.js);
     • отладку через `netlify dev` без деплоя.
   Включается переменной DF_BLOBS_MOCK=/путь/к/папке. */
function mockStore(dir) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const file = (key) => {
    const safe = String(key).replace(/[^A-Za-z0-9._/-]/g, "_");
    const full = path.resolve(root, safe);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error("bad key");
    return full;
  };
  return {
    name: "mock",
    async get(key, opts) {
      try {
        const buf = fs.readFileSync(file(key));
        const type = (opts && opts.type) || "text";
        if (type === "arrayBuffer") return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        if (type === "json") return JSON.parse(buf.toString("utf8"));
        return buf.toString("utf8");
      } catch (e) { return null; }
    },
    async set(key, data) {
      const f = file(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      return { modified: true };
    },
    async setJSON(key, value) { return this.set(key, JSON.stringify(value)); },
    async delete(key) {
      try {
        const f = file(key);
        fs.unlinkSync(f);
        /* В настоящих Blobs каталогов нет — только ключи. Mock убирает
           освободившиеся «папки», чтобы поведение совпадало. */
        let dir = path.dirname(f);
        while (dir.startsWith(root) && dir !== root) {
          try { if (fs.readdirSync(dir).length) break; fs.rmdirSync(dir); } catch (e) { break; }
          dir = path.dirname(dir);
        }
        return true;
      } catch (e) { return false; }
    },
    async list(opts) {
      const prefix = (opts && opts.prefix) || "";
      const all = [];
      (function walk(d) {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else all.push(path.relative(root, full).split(path.sep).join("/"));
        }
      })(root);
      const blobsList = all.filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return { blobs: blobsList, cursor: undefined };
    },
  };
}

function getStore() {
  if (blobs) return blobs;
  if (process.env.DF_BLOBS_MOCK) {
    blobs = mockStore(process.env.DF_BLOBS_MOCK);
    return blobs;
  }
  /* require выполняется лениво: вне Netlify пакета может не быть,
     и локальный сервер на файлах не должен из-за этого падать. */
  const mod = require("@netlify/blobs");
  blobs = mod.getStore(STORE_NAME);
  return blobs;
}

/* Доступно ли хранилище (есть пакет и контекст сайта Netlify) */
function isAvailable() {
  if (blobsAvailable) return true;
  try {
    getStore();
    blobsAvailable = !!(process.env.DF_BLOBS_MOCK || process.env.NETLIFY ||
      process.env.NETLIFY_SITE_ID || config.forceBlobs);
    return blobsAvailable;
  } catch (e) {
    return false;
  }
}

/* ---------- БД ---------- */
async function readDB() {
  const store = getStore();
  const raw = await store.get(DB_KEY, { consistency: "strong", type: "text" });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;                     // повреждённый блоб — стартуем чистыми
  }
}

async function writeDB(db) {
  const store = getStore();
  await store.set(DB_KEY, JSON.stringify(db), {
    metadata: { rev: String((db.meta && db.meta.rev) || 0), writtenAt: new Date().toISOString() },
  });
}

/* ---------- медиа ---------- */
function mediaKey(rel) {
  /* "img/12/3.jpg" → "img/12/3.jpg"; заодно отсекаем выход за префикс */
  const clean = String(rel || "").split("?")[0].replace(/^\/+/, "");
  if (!/^img\/[A-Za-z0-9_-]{1,64}\/[0-9]{1,3}\.(jpg|jpeg|png|webp)$/.test(clean)) return null;
  return clean;
}

async function putMedia(rel, buffer) {
  const key = mediaKey(rel);
  if (!key) throw Object.assign(new Error("bad-media-key"), { status: 400 });
  await getStore().set(key, buffer);
  return key;
}

async function getMedia(rel) {
  const key = mediaKey(rel);
  if (!key) return null;
  const buf = await getStore().get(key, { consistency: "strong", type: "arrayBuffer" });
  return buf ? Buffer.from(buf) : null;
}

async function deleteMedia(rel) {
  const key = mediaKey(rel);
  if (!key) return false;
  try { await getStore().delete(key); return true; } catch (e) { return false; }
}

async function listMedia(prefix) {
  const store = getStore();
  const out = [];
  let cursor;
  do {
    const page = await store.list({ prefix: prefix || "img/", cursor });
    for (const e of page.blobs || []) out.push(e.key);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/* ---------- драйвер медиа для media.js ---------- */
/* Реализует тот же интерфейс, что fsDriver: put / removeUrl / removeProduct / list */
const blobsDriver = {
  name: "netlify-blobs",

  async put(productId, index, buffer, ext) {
    const rel = "img/" + String(productId) + "/" + index + ext;
    await putMedia(rel, buffer);
    return rel;
  },

  async removeUrl(url) {
    return deleteMedia(String(url || ""));
  },

  async removeProduct(productId) {
    const prefix = "img/" + String(productId) + "/";
    const keys = await listMedia(prefix);
    let n = 0;
    for (const k of keys) { try { await getStore().delete(k); n++; } catch (e) {} }
    return n;
  },

  async list() {
    return listMedia("img/");
  },

  async get(rel) {
    return getMedia(rel);
  },
};

/* Сброс (нужен тестам: стор кэшируется в модуле) */
function reset() { blobs = null; blobsAvailable = false; }

module.exports = {
  STORE_NAME, DB_KEY, reset, mockStore,
  isAvailable, getStore,
  readDB, writeDB,
  mediaKey, putMedia, getMedia, deleteMedia, listMedia,
  blobsDriver,
};
