"use strict";
/* =========================================================
   BACKEND · МЕДИАФАЙЛЫ
   Приём multipart-загрузок, проверка содержимого по сигнатуре,
   публикация в /img/<ID>/<номер>.<ext> и обязательная уборка
   старых файлов при замене или удалении товара.

   Хранилище вынесено за интерфейс driver: по умолчанию —
   файловая система (локально и на VPS). Для Netlify free, где
   постоянной ФС нет, подключается внешний драйвер (Supabase
   Storage / Cloudflare R2 / S3) — см. DEPLOYMENT.md.

   Безопасность путей: ID товара приводится к [A-Za-z0-9_-],
   итоговый путь проверяется на нахождение внутри корня,
   имена файлов генерируются сервером (имя из формы игнорируется).
   ========================================================= */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const Busboy = require("busboy");
const { config } = require("./config.js");
const audit = require("./audit.js");
const { id: toId, safeUrl } = require("./sanitize.js");

/* ---------- сигнатуры форматов (проверяем байты, а не заголовок браузера) ---------- */
function sniffType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: ".jpg" };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: ".png" };
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: ".webp" };
  return null;
}

/* ---------- структурная валидация изображения ----------
   Сигнатуры мало: файл может быть обрезан. Проверяем минимальную
   структуру формата — это заодно отсекает «polyglot»-заготовки. */
function validateImageStructure(buf, mime) {
  if (!buf || buf.length < 16) return "too-small";
  if (mime === "image/jpeg") {
    /* должен заканчиваться маркером EOI FFD9 */
    if (buf.length < 4) return "too-small";
    const tail = buf.slice(-2);
    if (tail[0] !== 0xff || tail[1] !== 0xd9) return "truncated";
    return null;
  }
  if (mime === "image/png") {
    /* 8 байт сигнатуры + IHDR(25) + минимальный IDAT(20) + IEND(12) */
    if (buf.length < 67) return "too-small";
    const iend = buf.slice(-8, -4).toString("latin1");
    if (iend !== "IEND") return "truncated";
    return null;
  }
  if (mime === "image/webp") {
    if (buf.length < 20) return "too-small";
    /* RIFF-размер должен соответствовать фактическому (допуск на паддинг) */
    const declared = buf.readUInt32LE(4);
    if (declared + 8 < buf.length - 1 || declared + 8 > buf.length + 1) return "truncated";
    return null;
  }
  return "unsupported-type";
}

/* ---------- следующий свободный номер фото ---------- */
function nextIndexSync(productId) {
  const dir = safeSubdir(config.publicImgDir, productId);
  if (!dir) return 1;
  let max = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)\.[A-Za-z0-9]+$/.exec(f);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (e) { /* папки ещё нет */ }
  return max + 1;
}

/* ---------- защита путей ---------- */
function safeSubdir(root, sub) {
  const clean = toId(sub);
  if (!clean) return null;
  const full = path.resolve(root, clean);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;  // traversal
  return full;
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

/* ---------- приём multipart-запроса ---------- */
/* Возвращает { fields, files: [{ field, buffer, detectedMime, ext, originalName }] } */
function parseMultipart(req, { maxFiles = 8, maxBytes = config.maxUploadBytes, maxTotal = config.maxUploadTotal } = {}) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const fields = Object.create(null);
    const files = [];
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: maxFiles, fields: 40, fieldSize: 64 * 1024 } });
    } catch (e) {
      return reject(Object.assign(new Error("multipart-invalid"), { status: 400 }));
    }

    bb.on("field", (name, value) => {
      if (Object.prototype.hasOwnProperty.call(fields, name)) return;   // защита от prototype-загрязнения
      if (/^(__proto__|constructor|prototype)$/.test(name)) return;
      fields[name] = String(value).slice(0, 200_000);
    });

    bb.on("file", (name, stream, info) => {
      if (files.length >= maxFiles) { stream.resume(); return; }
      const chunks = [];
      let size = 0;
      let truncated = false;
      stream.on("data", (c) => {
        size += c.length; total += c.length;
        if (total > maxTotal) { truncated = true; stream.resume(); return; }
        if (size > maxBytes) { truncated = true; stream.resume(); return; }
        chunks.push(c);
      });
      stream.on("limit", () => { truncated = true; });
      stream.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const detected = sniffType(buffer);
        files.push({
          field: String(name).slice(0, 64),
          originalName: String(info.filename || "").slice(0, 200),
          declaredMime: String(info.mimeType || "").slice(0, 100),
          buffer,
          size: buffer.length,
          truncated,
          detectedMime: detected ? detected.mime : null,
          ext: detected ? detected.ext : null,
        });
      });
      stream.on("error", () => { /* файл просто не попадёт в список */ });
    });

    bb.on("error", (err) => reject(Object.assign(new Error("multipart-error"), { status: 400, cause: err })));
    bb.on("finish", () => {
      if (total > maxTotal) return reject(Object.assign(new Error("upload-too-large"), { status: 413 }));
      resolve({ fields, files });
    });
    req.pipe(bb);
  });
}

/* То же самое, но из уже прочитанного буфера — для serverless-окружений
   (Netlify Functions), где поток недоступен, а тело приходит целиком. */
function parseMultipartBuffer(buffer, headers, opts = {}) {
  const { maxFiles = 8, maxBytes = config.maxUploadBytes, maxTotal = config.maxUploadTotal } = opts;
  return new Promise((resolve, reject) => {
    if (!buffer || !buffer.length) return reject(Object.assign(new Error("empty-body"), { status: 400 }));
    if (buffer.length > maxTotal) return reject(Object.assign(new Error("upload-too-large"), { status: 413 }));
    const fields = Object.create(null);
    const files = [];
    let bb;
    try {
      bb = Busboy({ headers, limits: { fileSize: maxBytes, files: maxFiles, fields: 40, fieldSize: 64 * 1024 } });
    } catch (e) {
      return reject(Object.assign(new Error("multipart-invalid"), { status: 400 }));
    }
    bb.on("field", (name, value) => {
      if (Object.prototype.hasOwnProperty.call(fields, name)) return;
      if (/^(__proto__|constructor|prototype)$/.test(name)) return;
      fields[name] = String(value).slice(0, 200_000);
    });
    bb.on("file", (name, stream, info) => {
      const chunks = [];
      let truncated = false;
      stream.on("data", (c) => chunks.push(c));
      stream.on("limit", () => { truncated = true; });
      stream.on("end", () => {
        const buf = Buffer.concat(chunks);
        const detected = sniffType(buf);
        files.push({
          field: String(name).slice(0, 64),
          originalName: String(info.filename || "").slice(0, 200),
          declaredMime: String(info.mimeType || "").slice(0, 100),
          buffer: buf, size: buf.length, truncated,
          detectedMime: detected ? detected.mime : null,
          ext: detected ? detected.ext : null,
        });
      });
      stream.on("error", () => {});
    });
    bb.on("error", (err) => reject(Object.assign(new Error("multipart-error"), { status: 400, cause: err })));
    bb.on("finish", () => resolve({ fields, files }));
    bb.write(buffer);
    bb.end();
  });
}

/* ---------- драйвер: файловая система ---------- */
const fsDriver = {
  name: "fs",

  /* Сохранить буфер и вернуть публичный относительный URL */
  async put(productId, index, buffer, ext) {
    const dir = safeSubdir(config.publicImgDir, productId);
    if (!dir) throw Object.assign(new Error("bad-product-id"), { status: 400 });
    ensureDir(dir);
    const fileName = String(index) + ext;                       // имя задаёт сервер
    const full = path.resolve(dir, fileName);
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw Object.assign(new Error("bad-path"), { status: 400 });
    const tmp = full + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    fs.writeFileSync(tmp, buffer, { mode: 0o644 });
    fs.renameSync(tmp, full);                                    // атомарно
    return "img/" + toId(productId) + "/" + fileName;
  },

  /* Удалить конкретный файл по его публичному URL */
  async removeUrl(url) {
    const rel = String(url || "");
    if (!/^img\//.test(rel)) return false;
    const full = path.resolve(config.publicRoot, rel.split("?")[0]);
    if (!full.startsWith(path.resolve(config.publicImgDir) + path.sep)) return false;   // traversal
    try { fs.unlinkSync(full); return true; } catch (e) { return false; }
  },

  /* Удалить ВСЕ файлы товара (при замене или удалении карточки) */
  async removeProduct(productId) {
    const dir = safeSubdir(config.publicImgDir, productId);
    if (!dir) return 0;
    try {
      const list = fs.readdirSync(dir);
      for (const f of list) {
        const full = path.resolve(dir, f);
        if (full.startsWith(path.resolve(dir) + path.sep)) { try { fs.unlinkSync(full); } catch (e) {} }
      }
      try { fs.rmdirSync(dir); } catch (e) {}
      return list.length;
    } catch (e) { return 0; }
  },

  /* Список фактически опубликованных файлов (для сверки с БД) */
  async list() {
    const out = [];
    try {
      for (const d of fs.readdirSync(config.publicImgDir, { withFileTypes: true })) {
        if (!d.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(d.name)) continue;
        for (const f of fs.readdirSync(path.join(config.publicImgDir, d.name))) {
          out.push("img/" + d.name + "/" + f);
        }
      }
    } catch (e) {}
    return out;
  },
};

let driver = fsDriver;
function setDriver(d) { driver = d; }
function getDriver() { return driver; }

/* ---------- операции верхнего уровня ---------- */

/* Принять загрузки и опубликовать их как фото товара.
   replace=true → старые файлы товара удаляются (именно то, что требуется
   при замене изображений: на диске не остаётся «хвостов»). */
async function saveUploads({ productId, files, replace = true, startIndex = null }) {
  const pid = toId(productId);
  if (!pid) throw Object.assign(new Error("bad-product-id"), { status: 400 });
  /* replace → нумерация с 1 (старые файлы удалены);
     иначе продолжаем существующую нумерацию, чтобы не перезаписать фото. */
  const first = startIndex === null ? (replace ? 1 : nextIndexSync(pid)) : startIndex;

  const accepted = [];
  const rejected = [];
  for (const f of files) {
    /* Принимаем только если сигнатура совпала и формат в белом списке.
       Расширение и MIME из формы не используются — только содержимое. */
    if (!f.detectedMime || !config.allowedImageTypes[f.detectedMime]) {
      rejected.push({ name: f.originalName, reason: "unsupported-type", declared: f.declaredMime });
      continue;
    }
    if (f.truncated || f.size > config.maxUploadBytes) {
      rejected.push({ name: f.originalName, reason: "too-large", size: f.size });
      continue;
    }
    const broken = validateImageStructure(f.buffer, f.detectedMime);
    if (broken) {
      rejected.push({ name: f.originalName, reason: broken, size: f.size });
      continue;
    }
    accepted.push(f);
  }
  if (!accepted.length) {
    return { urls: [], rejected, removed: 0 };
  }
  if (accepted.length > config.maxPhotosPerProduct) {
    throw Object.assign(new Error("too-many-photos"), { status: 400 });
  }

  let removed = 0;
  if (replace) removed = await driver.removeProduct(pid);

  const urls = [];
  for (let i = 0; i < accepted.length; i++) {
    const f = accepted[i];
    const ext = config.allowedImageTypes[f.detectedMime];
    const url = await driver.put(pid, first + i, f.buffer, ext);
    urls.push(safeUrl(url) || url);
  }

  audit.log("media.saved", { productId: pid, count: urls.length, removedOld: removed, rejected: rejected.length });
  return { urls, rejected, removed };
}

/* Синхронизация диска с БД: удалить файлы, которых больше нет в контенте */
async function pruneOrphans(content) {
  const referenced = new Set();
  for (const p of (content && content.products) || []) {
    for (const u of p.imgs || []) if (typeof u === "string" && u.startsWith("img/")) referenced.add(u.split("?")[0]);
  }
  const hero = content && content.hero && content.hero.img;
  if (typeof hero === "string" && hero.startsWith("img/")) referenced.add(hero.split("?")[0]);
  for (const c of (content && content.collections) || []) {
    if (typeof c.cover === "string" && c.cover.startsWith("img/")) referenced.add(c.cover.split("?")[0]);
  }

  const onDisk = await driver.list();
  const orphans = onDisk.filter((u) => !referenced.has(u));
  let removed = 0;
  for (const u of orphans) { if (await driver.removeUrl(u)) removed++; }
  if (removed) audit.log("media.pruned", { removed, orphans: orphans.slice(0, 20) });
  return { removed, orphans };
}

module.exports = {
  sniffType, validateImageStructure, nextIndexSync, safeSubdir, parseMultipart, parseMultipartBuffer,
  saveUploads, pruneOrphans,
  setDriver, getDriver, fsDriver,
};
