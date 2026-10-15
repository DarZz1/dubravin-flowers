"use strict";
/* =========================================================
   BACKEND · ЖУРНАЛ БЕЗОПАСНОСТИ
   Append-only NDJSON-файл в backend/data/audit.log.
   Пароли, токены и хэши в журнал НЕ пишутся — только факты.
   ========================================================= */
const fs = require("node:fs");
const { config, ensureDirs } = require("./config.js");

const SENSITIVE = /pass|token|secret|hash|cookie|authorization/i;

function scrub(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) { out[k] = "[redacted]"; continue; }
    if (v && typeof v === "object") { out[k] = Array.isArray(v) ? "[array:" + v.length + "]" : scrub(v); }
    else out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}

function log(event, data) {
  try {
    ensureDirs();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...(data ? { data: scrub(data) } : {}),
    }) + "\n";
    fs.appendFileSync(config.logFile, line);
  } catch (e) {
    /* Журнал не должен ронять запрос */
  }
}

/* Простая ротация: при превышении 5 МБ — один архивный файл */
function rotate(maxBytes = 5 * 1024 * 1024) {
  try {
    const st = fs.statSync(config.logFile);
    if (st.size < maxBytes) return false;
    fs.renameSync(config.logFile, config.logFile + ".1");
    return true;
  } catch (e) { return false; }
}

module.exports = { log, rotate, scrub };
