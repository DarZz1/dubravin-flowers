#!/usr/bin/env node
"use strict";
/* =========================================================
   BACKEND · CLI УПРАВЛЕНИЯ УЧЁТКАМИ
   Нужен для первого входа в панель /admin на любом хостинге.

   Команды:
     bootstrap --login <логин> [--random [длина] | --password <пароль>]
       Печатает переменные окружения для Netlify/Beget:
       DF_BOOTSTRAP_LOGIN, DF_BOOTSTRAP_HASH, DF_SECRET, NODE_ENV,
       DF_TRUST_PROXY. В переменные попадает ХЭШ scrypt, а не пароль.
       Пароль показывается один раз. Скопируйте вывод в
       Site configuration → Environment variables и перезапустите деплой.

     create --login <логин> [--password <пароль> | --random [длина]]
       Создаёт учётку прямо в локальной БД (backend/data/db.json) —
       для запуска backend/server/server.js на VPS/локально.

     hash --password <пароль>
       Печатает только scrypt-хэш (для DF_BOOTSTRAP_HASH вручную).

   Без --password/--random пароль запрашивается скрытым вводом.
   ========================================================= */
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

const auth = require(path.join(__dirname, "..", "server", "auth.js"));
const store = require(path.join(__dirname, "..", "server", "store.js"));

/* ---------- аргументы ---------- */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

/* ---------- скрытый ввод пароля ---------- */
function askPassword(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      /* не интерактивный режим (пайп) — читаем строку как есть */
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question(question, (v) => { rl.close(); resolve(String(v).replace(/\r?\n$/, "")); });
      return;
    }
    const rl = readline.createInterface({ input: stdin, output: process.stdout, terminal: true });
    let value = "";
    process.stdout.write(question);
    const onData = (ch) => {
      ch = String(ch);
      for (const c of ch) {
        if (c === "\n" || c === "\r" || c === "\u0004") {
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolve(value);
          return;
        } else if (c === "\u0003") {           // Ctrl+C
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          process.exit(130);
        } else if (c === "\u007F" || c === "\b") { // Backspace
          value = value.slice(0, -1);
        } else if (c >= " ") {
          value += c;
        }
      }
    };
    rl._writeToOutput = function () {};        // глушим эхо
    stdin.on("data", onData);
    stdin.resume();
  });
}

/* ---------- генерация пароля ---------- */
function randomPassword(len) {
  len = Math.max(12, Math.min(64, parseInt(len, 10) || 16));
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%-_";
  const bytes = crypto.randomBytes(len * 2);
  let out = "";
  for (let i = 0; out.length < len; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

async function resolvePassword(args) {
  if (typeof args.password === "string" && args.password) return { password: args.password, generated: false };
  if (args.random) return { password: randomPassword(args.random === true ? 16 : args.random), generated: true };
  const p1 = await askPassword("Пароль (ввод не отображается): ");
  const p2 = await askPassword("Повторите пароль: ");
  if (p1 !== p2) { console.error("Пароли не совпадают."); process.exit(1); }
  return { password: p1, generated: false };
}

function resolveLogin(args) {
  const login = String(args.login || "").trim();
  if (!login) { console.error("Укажите --login <логин> (3–64 символа, латиница, цифры, . _ @ -)."); process.exit(1); }
  const err = auth.validateLogin(login);
  if (err) { console.error("Недопустимый логин: " + err); process.exit(1); }
  return login;
}

/* ---------- команды ---------- */
async function cmdBootstrap(args) {
  const login = resolveLogin(args);
  const { password, generated } = await resolvePassword(args);
  const passErr = auth.validatePassword(password);
  if (passErr) { console.error("Недопустимый пароль: " + passErr + " (минимум 8 символов, максимум 128)."); process.exit(1); }
  const hash = auth.hashPassword(password);
  const secret = crypto.randomBytes(48).toString("base64url");

  console.log("");
  console.log("# Скопируйте эти переменные в настройки хостинга");
  console.log("# (Netlify: Site configuration → Environment variables, затем Trigger deploy):");
  console.log("");
  console.log("DF_BOOTSTRAP_LOGIN=" + login);
  console.log("DF_BOOTSTRAP_HASH=" + hash);
  console.log("DF_SECRET=" + secret);
  console.log("NODE_ENV=production");
  console.log("DF_TRUST_PROXY=1");
  console.log("");
  console.log("── Данные для входа (показаны один раз) ──");
  console.log("логин : " + login);
  console.log("пароль: " + password + (generated ? "   (сгенерирован)" : ""));
  console.log("");
  console.log("После первого входа переменные DF_BOOTSTRAP_* лучше удалить из настроек.");
}

async function cmdCreate(args) {
  const login = resolveLogin(args);
  const { password, generated } = await resolvePassword(args);
  const passErr = auth.validatePassword(password);
  if (passErr) { console.error("Недопустимый пароль: " + passErr); process.exit(1); }
  const r = await auth.createAdmin({ login, password, mustChangePassword: false });
  if (!r || !r.ok) { console.error("Не создано: " + ((r && r.reason) || "ошибка")); process.exit(1); }
  const { config } = require(path.join(__dirname, "..", "server", "config.js"));
  console.log("Учётка создана в " + path.join(config.dataDir, "db.json"));
  console.log("логин : " + login);
  console.log("пароль: " + password + (generated ? "   (сгенерирован)" : ""));
}

function cmdHash(args) {
  const password = typeof args.password === "string" ? args.password : null;
  if (!password) { console.error("Укажите --password <пароль>"); process.exit(1); }
  const passErr = auth.validatePassword(password);
  if (passErr) { console.error("Недопустимый пароль: " + passErr); process.exit(1); }
  console.log(auth.hashPassword(password));
}

function usage() {
  console.log("Использование:");
  console.log("  node backend/cli/admin.js bootstrap --login <логин> [--random [длина] | --password <пароль>]");
  console.log("      → переменные окружения для Netlify/Beget (хэш пароля, секрет)");
  console.log("  node backend/cli/admin.js create --login <логин> [--password <пароль> | --random]");
  console.log("      → создать учётку в локальной БД (для backend/server/server.js)");
  console.log("  node backend/cli/admin.js hash --password <пароль>");
  console.log("      → напечатать scrypt-хэш пароля");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "bootstrap") return cmdBootstrap(args);
  if (cmd === "create") return cmdCreate(args);
  if (cmd === "hash") return cmdHash(args);
  usage();
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => { console.error(e && e.message || e); process.exit(1); });
