"use strict";
/* =========================================================
   BACKEND · КОНТЕНТ (CMS)
   Все операции изменения витрины проходят через сервер и сразу
   публикуют data.json в корне сайта — посетители видят правки
   без перезагрузки кэша и без ручного скачивания файла.

   Оптимистичная блокировка: у контента есть rev (ревизия). Клиент
   может прислать If-Match: <rev>; при несовпадении — 409, чтобы
   два админа не перезаписали правки друг друга.
   ========================================================= */
const crypto = require("node:crypto");
const store = require("./store.js");
const sanitize = require("./sanitize.js");
const media = require("./media.js");
const audit = require("./audit.js");
const { config } = require("./config.js");

/* ---------- базовое состояние ---------- */
function rev() {
  return store.contentRev();
}

async function ensureSeed() {
  const existing = store.getContent();
  if (existing && Array.isArray(existing.products)) return existing;

  /* Первичное наполнение: берём встроенный каталог витрины (seed из
     assets/js/store.js), чтобы админка стартовала не пустой. */
  const seed = readSeedFromClient();
  const content = sanitize.sanitizeContent(seed);
  await store.setContent(content);
  store.publishDataJson(content);
  audit.log("content.seeded", { products: content.products.length, collections: content.collections.length });
  return content;
}

/* Seed-каталог: сначала готовый backend/seed.json (генерируется командой
   npm run backend:seed и не требует jsdom в рантайме — важно для serverless),
   затем fallback на разбор клиентского store.js через jsdom. */
function readSeedFromClient() {
  const fs = require("fs");
  const path = require("path");
  const seedFile = path.join(config.serverDir, "..", "seed.json");
  try {
    if (fs.existsSync(seedFile)) {
      const parsed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
      if (parsed && Array.isArray(parsed.products)) return parsed;
    }
  } catch (e) { /* падаем в jsdom-вариант */ }

  try {
    const { JSDOM } = require("jsdom");
    const vm = require("vm");
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", runScripts: "outside-only" });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    for (const f of ["assets/js/photo-factory.js", "assets/js/store.js"]) {
      vm.runInContext(fs.readFileSync(path.join(config.root, f), "utf8"), dom.getInternalVMContext(), { filename: f });
    }
    const db = w.seedDB();
    dom.window.close();
    return db;
  } catch (e) {
    return { hero: { img: "", title: "", subtitle: "", badge: "" }, collections: [], products: [] };
  }
}

/* Записать backend/seed.json — вызывается из npm run backend:seed */
function writeSeedFile() {
  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", runScripts: "outside-only" });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const f of ["assets/js/photo-factory.js", "assets/js/store.js"]) {
    vm.runInContext(fs.readFileSync(path.join(config.root, f), "utf8"), dom.getInternalVMContext(), { filename: f });
  }
  const db = w.seedDB();
  dom.window.close();
  const file = path.resolve(config.serverDir, "..", "seed.json");
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
  return { file, products: db.products.length, collections: db.collections.length };
}

async function getAll() {
  const content = await ensureSeed();
  return { content, rev: rev() };
}

/* ---------- hero ---------- */
async function setHero(patch) {
  const { content } = await getAll();
  const next = sanitize.sanitizeContent({
    ...content,
    hero: { ...content.hero, ...(patch && typeof patch === "object" ? patch : {}) },
  });
  return commit(next, "hero.update");
}

/* ---------- hero-фото как файл хостинга ----------
   Псевдо-каталог "hero" в медиа-хранилище: img/hero/1.<ext>.
   replace=true — прежний файл удаляется, в контент пишется готовый URL. */
async function setHeroPhoto({ file }) {
  const { content } = await getAll();
  if (!file) return { ok: false, reason: "no-file", status: 400 };
  const saved = await media.saveUploads({ productId: "hero", files: [file], replace: true });
  if (!saved.urls.length) return { ok: false, reason: "no-valid-files", status: 400, rejected: saved.rejected };
  const next = sanitize.sanitizeContent({ ...content, hero: { ...content.hero, img: saved.urls[0] } });
  const res = await commit(next, "hero.photo", { url: saved.urls[0] });
  return { ...res, url: saved.urls[0], rejected: saved.rejected };
}

/* ---------- обложка подборки как файл хостинга ----------
   Псевдо-каталог "col-<ID подборки>": img/col-bouquets/1.<ext>. */
async function setCollectionPhoto({ cid, file }) {
  const { content } = await getAll();
  const idc = sanitize.id(cid);
  const list = (content.collections || []).slice();
  const i = list.findIndex((x) => x.id === idc);
  if (i < 0) return { ok: false, reason: "not-found", status: 404 };
  if (!file) return { ok: false, reason: "no-file", status: 400 };
  const folder = "col-" + idc;
  const saved = await media.saveUploads({ productId: folder, files: [file], replace: true });
  if (!saved.urls.length) return { ok: false, reason: "no-valid-files", status: 400, rejected: saved.rejected };
  list[i] = { ...list[i], cover: saved.urls[0] };
  const next = sanitize.sanitizeContent({ ...content, collections: list });
  const res = await commit(next, "collection.photo", { id: idc, url: saved.urls[0] });
  return { ...res, url: saved.urls[0], rejected: saved.rejected };
}

/* ---------- подборки ---------- */
async function setCollections(list) {
  const { content } = await getAll();
  const next = sanitize.sanitizeContent({ ...content, collections: Array.isArray(list) ? list : [] });
  return commit(next, "collections.update");
}

async function upsertCollection(c) {
  const { content } = await getAll();
  const clean = sanitize.sanitizeCollection(c);
  if (!clean) return { ok: false, reason: "invalid", status: 400 };
  const list = (content.collections || []).slice();
  const i = list.findIndex((x) => x.id === clean.id);
  if (i >= 0) list[i] = { ...list[i], ...clean }; else list.push(clean);
  const next = sanitize.sanitizeContent({ ...content, collections: list });
  return commit(next, i >= 0 ? "collection.update" : "collection.create", { id: clean.id });
}

async function deleteCollection(cid) {
  const { content } = await getAll();
  const idc = sanitize.id(cid);
  const list = (content.collections || []).filter((x) => x.id !== idc);
  /* У товаров убираем ссылку на удалённую подборку */
  const products = (content.products || []).map((p) => ({ ...p, cols: (p.cols || []).filter((c) => c !== idc) }));
  const next = sanitize.sanitizeContent({ ...content, collections: list, products });
  return commit(next, "collection.delete", { id: idc });
}

/* ---------- товары ---------- */
function newProductId(taken) {
  for (let i = 0; i < 40; i++) {
    const cand = crypto.randomBytes(4).toString("hex");
    if (!taken.has(cand)) return cand;
  }
  return crypto.randomBytes(8).toString("hex");
}

async function listProducts() {
  const { content } = await getAll();
  return { products: content.products || [], rev: rev() };
}

async function getProduct(pid) {
  const { content } = await getAll();
  const idp = sanitize.id(pid);
  const p = (content.products || []).find((x) => x.id === idp);
  return p ? { product: p, rev: rev() } : { ok: false, reason: "not-found", status: 404 };
}

async function createProduct(input) {
  const { content } = await getAll();
  const products = (content.products || []).slice();
  const taken = new Set(products.map((p) => p.id));

  const suggested = sanitize.id(input && input.id);
  const pid = suggested && !taken.has(suggested) ? suggested : newProductId(taken);
  if (products.length >= config.maxProducts) return { ok: false, reason: "limit", status: 409 };

  const clean = sanitize.sanitizeProduct({ ...(input || {}), id: pid }, (content.collections || []).map((c) => c.id));
  if (!clean) return { ok: false, reason: "invalid", status: 400 };
  products.push(clean);

  const next = sanitize.sanitizeContent({ ...content, products });
  const res = await commit(next, "product.create", { id: pid });
  return { ...res, id: pid };
}

async function updateProduct(pid, patch) {
  const { content } = await getAll();
  const idp = sanitize.id(pid);
  const products = (content.products || []).slice();
  const i = products.findIndex((x) => x.id === idp);
  if (i < 0) return { ok: false, reason: "not-found", status: 404 };

  const merged = { ...products[i], ...(patch && typeof patch === "object" ? patch : {}), id: idp };
  const clean = sanitize.sanitizeProduct(merged, (content.collections || []).map((c) => c.id));
  if (!clean) return { ok: false, reason: "invalid", status: 400 };
  products[i] = clean;

  const next = sanitize.sanitizeContent({ ...content, products });
  return commit(next, "product.update", { id: idp });
}

/* Удаление карточки: вместе с записью убираем и её медиафайлы с диска */
async function deleteProduct(pid) {
  const { content } = await getAll();
  const idp = sanitize.id(pid);
  const before = (content.products || []);
  const victim = before.find((x) => x.id === idp);
  if (!victim) return { ok: false, reason: "not-found", status: 404 };

  const products = before.filter((x) => x.id !== idp);
  const next = sanitize.sanitizeContent({ ...content, products });
  const res = await commit(next, "product.delete", { id: idp, imgs: (victim.imgs || []).length });

  const removed = await media.getDriver().removeProduct(idp);
  audit.log("media.removed-with-product", { productId: idp, files: removed });

  /* На всякий случай убираем осиротевшие файлы (например, обложки подборок) */
  await media.pruneOrphans(next);
  return { ...res, removedFiles: removed };
}

/* Замена/добавление фото товара: multipart → публикация → запись в контент.
   При replace старые файлы товара удаляются с диска до записи новых. */
async function attachPhotos({ productId, files, replace = true }) {
  const { content } = await getAll();
  const idp = sanitize.id(productId);
  const products = (content.products || []).slice();
  const i = products.findIndex((x) => x.id === idp);
  if (i < 0) return { ok: false, reason: "not-found", status: 404 };

  /* Дозагрузка (replace=false): нумерацию продолжаем от существующих фото
     ТОВАРА (а не от списка файлов в каталоге публикации — на Netlify он
     доступен только для чтения и не отражает содержимое Blobs). */
  const existingImgs = (products[i].imgs || []).filter((u) => typeof u === "string" && u.indexOf("img/" + idp + "/") === 0);
  if (!replace && existingImgs.length + files.length > config.maxPhotosPerProduct) {
    return { ok: false, reason: "photo-limit", status: 409, details: { max: config.maxPhotosPerProduct, existing: existingImgs.length } };
  }
  let maxIdx = 0;
  for (const u of existingImgs) {
    const m = /^img\/[^/]+\/(\d+)\./.exec(u);
    if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
  }
  const saved = await media.saveUploads({ productId: idp, files, replace, startIndex: replace ? null : maxIdx + 1 });
  if (!saved.urls.length) {
    return { ok: false, reason: "no-valid-files", status: 400, rejected: saved.rejected };
  }

  const merged = { ...products[i], imgs: replace ? saved.urls : [...(products[i].imgs || []), ...saved.urls] };
  const clean = sanitize.sanitizeProduct(merged, (content.collections || []).map((c) => c.id));
  products[i] = clean;

  const next = sanitize.sanitizeContent({ ...content, products });
  const res = await commit(next, "product.photos", { id: idp, added: saved.urls.length, removedOld: saved.removed, rejected: saved.rejected.length });
  return { ...res, urls: saved.urls, rejected: saved.rejected, removedOldFiles: saved.removed };
}

/* Удалить одно фото из набора товара (по индексу или точному URL) */
async function removePhoto({ productId, url, index }) {
  const { content } = await getAll();
  const idp = sanitize.id(productId);
  const products = (content.products || []).slice();
  const i = products.findIndex((x) => x.id === idp);
  if (i < 0) return { ok: false, reason: "not-found", status: 404 };

  const imgs = (products[i].imgs || []).slice();
  let target = null;
  if (typeof url === "string" && url) target = imgs.find((u) => u === url || u.split("?")[0] === url.split("?")[0]);
  else if (Number.isInteger(index) && index >= 0 && index < imgs.length) target = imgs[index];
  if (!target) return { ok: false, reason: "not-found", status: 404 };

  const removed = await media.getDriver().removeUrl(target);
  const nextImgs = imgs.filter((u) => u !== target);
  const merged = { ...products[i], imgs: nextImgs };
  products[i] = sanitize.sanitizeProduct(merged, (content.collections || []).map((c) => c.id));

  const next = sanitize.sanitizeContent({ ...content, products });
  const res = await commit(next, "product.photo-removed", { id: idp, url: target, removedFromDisk: removed });
  return { ...res, removedFromDisk: removed };
}

/* ---------- импорт / экспорт / сброс ---------- */
async function replaceAll(input, expectedRev) {
  if (expectedRev !== undefined && expectedRev !== null && Number(expectedRev) !== rev()) {
    return { ok: false, reason: "rev-conflict", status: 409, rev: rev() };
  }
  const next = sanitize.sanitizeContent(input);
  if (!next) return { ok: false, reason: "invalid", status: 400 };
  return commit(next, "content.replace", { products: next.products.length });
}

async function resetToSeed() {
  const seed = readSeedFromClient();
  const next = sanitize.sanitizeContent(seed);
  const res = await commit(next, "content.reset", { products: next.products.length });
  const { removed } = await media.pruneOrphans(next);
  return { ...res, removedFiles: removed };
}

/* ---------- публикация ---------- */
async function commit(nextContent, event, data) {
  await store.setContent(nextContent);
  try {
    store.publishDataJson(nextContent);
  } catch (e) {
    audit.log("content.publish-failed", { error: e.message });
    return { ok: false, reason: "publish-failed", status: 500 };
  }
  audit.log(event, Object.assign({ rev: rev() }, data || {}));
  return {
    ok: true,
    rev: rev(),
    content: nextContent,
    counts: { products: nextContent.products.length, collections: nextContent.collections.length },
  };
}

module.exports = {
  rev, ensureSeed, getAll,
  setHero, setHeroPhoto, setCollections, upsertCollection, deleteCollection, setCollectionPhoto,
  listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  attachPhotos, removePhoto,
  replaceAll, resetToSeed, commit,
  readSeedFromClient, writeSeedFile,
};
