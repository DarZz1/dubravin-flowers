#!/usr/bin/env node
"use strict";
/* =========================================================
   BACKEND · CLI ГЕНЕРАЦИИ SEED
   Пересобирает backend/seed.json из клиентских модулей витрины
   (assets/js/photo-factory.js + assets/js/store.js → seedDB()).
   Сервер использует seed.json для первичного наполнения каталога
   и для «Сбросить к исходным» — без jsdom, чтобы работать в serverless.

   Запуск:  node backend/cli/seed.js   (или npm run backend:seed)
   ========================================================= */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const outFile = path.join(root, "backend", "seed.json");

/* Минимальные заглушки браузера: модули витрины на верхнем уровне
   обращаются только к document.addEventListener (photo-factory) и
   объявляют функции/переменные. */
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener() {}, createElement() { return { style: {}, getContext: () => null }; } },
  location: { hash: "" },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  Image: function () {},
  URL: { createObjectURL() { return ""; }, revokeObjectURL() {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
for (const f of ["assets/js/photo-factory.js", "assets/js/store.js"]) {
  const code = fs.readFileSync(path.join(root, f), "utf8");
  vm.runInContext(code, sandbox, { filename: f });
}

const db = sandbox.seedDB();
if (!db || !Array.isArray(db.products) || !Array.isArray(db.collections)) {
  console.error("seedDB() не вернул ожидаемую структуру — seed.json не записан.");
  process.exit(1);
}

fs.writeFileSync(outFile, JSON.stringify(db, null, 2) + "\n");
console.log("backend/seed.json обновлён:");
console.log("  товаров   : " + db.products.length);
console.log("  подборок  : " + db.collections.length + " (" + db.collections.map((c) => c.name + (c.main ? " · на главной" : "")).join(", ") + ")");
console.log("  на главной: " + db.products.filter((p) => p.main).length + " карточки");
