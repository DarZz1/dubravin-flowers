"use strict";
/* =========================================================
   BACKEND · ВАЛИДАЦИЯ И САНИТИЗАЦИЯ ДАННЫХ
   Серверный аналог sanitizeDB()/esc()/safeUrl() из
   assets/js/store.js. Правила намеренно совпадают с клиентскими
   (это проверяется тестом tests/backend-parity.test.js): контент,
   сохранённый через API, витрина примет без изменений.

   Принципиально: объект собирается заново из белого списка полей,
   поэтому загрязнение __proto__/constructor невозможно.
   ========================================================= */
const { config } = require("./config.js");
const L = config.limits;

function str(v, max, def = "") {
  if (v === null || v === undefined) return def;
  let s = String(v);
  /* Управляющие символы и BOM не нужны ни в одном поле */
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]/g, "");
  if (s.length > max) s = s.slice(0, max);
  return s.trim();
}

function id(v) {
  let s = str(v, L.id);
  s = s.replace(/[^A-Za-z0-9_-]/g, "");
  return s.slice(0, L.id);
}

function price(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(String(v).replace(/[^\d.,-]/g, "").replace(",", ".")));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 100000000);
}

function bool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function listOfStrings(arr, maxItems, maxLen) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const s = str(x, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/* --- URL изображения: белый список схем --- */
function safeUrl(u) {
  const s = str(u, 2000);
  if (!s) return "";
  /* Protocol-relative (//evil.com/x) и варианты с обратным слэшем (\\evil.com,
     /\\evil.com) — отклоняем ДО конструктора URL: new URL("//x", base)
     молча разворачивает их в http(s)://x, и фильтр был бы обойдён. */
  if (/^[\/][\/\\]/.test(s) || /^\\/.test(s)) return "";
  /* относительные пути сайта */
  if (/^(img|assets|data\.json)[\w./-]*$/i.test(s)) return s;
  if (/^\/[\w./-]+$/.test(s)) return s;
  /* data: только для изображений */
  if (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s.slice(0, 2_000_000);
  /* http(s) */
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) {
    try {
      const p = new URL(s);
      if (p.protocol === "http:" || p.protocol === "https:") return p.href.slice(0, 2000);
    } catch (e) { return ""; }
  }
  /* javascript:, vbscript:, data:text/html, //evil.com — отклоняются */
  return "";
}

function imgsList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const u = safeUrl(x);
    if (u) out.push(u);
    if (out.length >= L.imgs) break;
  }
  return out;
}

/* --- товар --- */
function sanitizeProduct(p, knownCollections) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const pid = id(p.id);
  if (!pid) return null;
  const name = str(p.name, L.name);
  if (!name) return null;
  const price = priceNum(p.price);
  if (price === null) return null;
  const old = priceNum(p.old);
  const cols = Array.isArray(p.cols)
    ? [...new Set(p.cols.map(id).filter(Boolean))].filter((c) => !knownCollections || knownCollections.includes(c)).slice(0, L.collections)
    : [];
  return {
    id: pid,
    name,
    desc: str(p.desc, L.desc),
    price,
    old: old !== null && old > price ? old : null,
    imgs: imgsList(p.imgs),
    cols,
    sale: bool(p.sale) || (old !== null && old > price),
    hit: bool(p.hit),
    main: bool(p.main),
    comp: listOfStrings(p.comp, L.comp, L.compItem),
  };
}
function priceNum(v) { return price(v); }

/* --- подборка --- */
function sanitizeCollection(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const cid = id(c.id);
  if (!cid) return null;
  const name = str(c.name, L.name);
  if (!name) return null;
  return {
    id: cid,
    name,
    cover: safeUrl(c.cover),
    note: str(c.note, 400),
    main: bool(c.main),     /* показывать подборку на главной */
  };
}

/* --- hero --- */
function sanitizeHero(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  return {
    img: safeUrl(h.img),
    title: str(h.title, 120),
    subtitle: str(h.subtitle, 240),
    badge: str(h.badge, 80),
  };
}

/* --- весь контент (аналог sanitizeDB) --- */
function sanitizeContent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const collections = Array.isArray(input.collections)
    ? input.collections.map(sanitizeCollection).filter(Boolean).slice(0, L.collections)
    : [];
  /* На главной — не больше mainOnHome подборок: лишние отметки гасим
     (правило продублировано в CMS, здесь — серверная страховка). */
  let colMain = 0;
  for (const c of collections) {
    if (c.main) { colMain++; if (colMain > L.mainOnHome) c.main = false; }
  }
  const knownCols = collections.map((c) => c.id);

  const seen = new Set();
  const products = [];
  let prodMain = 0;
  if (Array.isArray(input.products)) {
    for (const raw of input.products) {
      const p = sanitizeProduct(raw, knownCols.length ? knownCols : null);
      if (!p || seen.has(p.id)) continue;      // дубли id отбрасываем
      if (p.main) { prodMain++; if (prodMain > L.mainOnHome) p.main = false; }
      seen.add(p.id);
      products.push(p);
      if (products.length >= config.maxProducts) break;
    }
  }

  return {
    hero: sanitizeHero(input.hero) || { img: "", title: "", subtitle: "", badge: "" },
    collections,
    products,
  };
}

/* --- экранирование для ответа в HTML-контексте (используется редко:
       API отдаёт JSON, экранирует клиент; оставлено для совместимости) --- */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
}

module.exports = {
  str, id, price, bool, listOfStrings,
  safeUrl, imgsList,
  sanitizeProduct, sanitizeCollection, sanitizeHero, sanitizeContent,
  esc,
};
