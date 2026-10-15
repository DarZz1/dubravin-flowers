"use strict";
/* =========================================================
   BACKEND · HTTP-СЕРВЕР (локальная разработка и VPS)
   Один процесс обслуживает и витрину, и API, и фото — значит
   всё на одном origin, CORS не нужен, CSRF закрыт SameSite.

     npm run server          → http://127.0.0.1:8090/
     npm run server -- 3000  → другой порт

   Статика раздаётся так же, как deploy/serve.js: служебные
   каталоги и конфиги не отдаются, path traversal закрыт.
   ========================================================= */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { config, assertProductionReady, ensureSecret, ensureDirs } = require("./config.js");
const api = require("./api.js");
const httpx = require("./http.js");
const audit = require("./audit.js");

ensureDirs();
ensureSecret();

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".webmanifest": "application/manifest+json",
};
const BANNED_DIRS = new Set(["tests", "deploy", "backend", "build_tools", "node_modules", ".git", "uploads", "tools", "dist-archive"]);
const BANNED_FILES = /^(package(-lock)?\.json|netlify\.toml|vercel\.json|_headers|_redirects|sitemap\.xml\.gz|.*\.bak)$/;
const COMPRESSIBLE = /\.(html|css|js|mjs|json|txt|md|svg)$/i;

function isBanned(rel) {
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((p) => p.startsWith(".") || BANNED_DIRS.has(p))) return true;
  return BANNED_FILES.test(parts[parts.length - 1]);
}

function resolveStatic(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return null; }
  rel = path.posix.normalize(rel).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  if (isBanned(rel)) return null;
  const abs = path.resolve(config.staticRoot, rel || "index.html");
  const root = path.resolve(config.staticRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;      // traversal
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      const idx = path.join(abs, "index.html");
      return fs.existsSync(idx) ? { file: idx, size: fs.statSync(idx).size } : null;
    }
    return { file: abs, size: st.size };
  } catch (e) {
    if (!path.extname(abs) && fs.existsSync(abs + ".html")) return { file: abs + ".html", size: fs.statSync(abs + ".html").size };
    return null;
  }
}

/* Разрешает путь внутри каталога медиа с защитой от выхода за его пределы */
function mediaResolve(rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch (e) { return null; }
  const norm = path.posix.normalize("/" + decoded).replace(/^[/\\]+/, "");
  if (!norm || norm.split("/").some((p) => p === ".." || p === "." || p.startsWith("."))) return null;
  const base = path.resolve(config.publicImgDir);
  const abs = path.resolve(base, norm);
  if (!abs.startsWith(base + path.sep)) return null;                  // traversal
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return { file: abs, size: st.size };
  } catch (e) { return null; }
}

function sendFile(req, res, file, size) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const headers = Object.assign({}, staticSecurityHeaders(req, file));
  const accept = String(req.headers["accept-encoding"] || "");
  const canGzip = COMPRESSIBLE.test(file) && /\bgzip\b/.test(accept) && size > 1024;

  headers["Content-Type"] = type;
  if (canGzip) headers["Content-Encoding"] = "gzip";
  headers["Accept-Ranges"] = "bytes";
  headers["Cache-Control"] = ext === ".html" || file.endsWith("data.json")
    ? "no-cache"
    : "public, max-age=" + (ext === ".css" || ext === ".js" ? 604800 : 2592000);

  if (req.method === "HEAD") { res.writeHead(200, headers); return res.end(); }

  const stream = fs.createReadStream(file);
  if (canGzip) {
    res.writeHead(200, Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "Content-Length")));
    stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
  } else {
    headers["Content-Length"] = size;
    res.writeHead(200, headers);
    stream.pipe(res);
  }
  stream.on("error", () => { try { res.destroy(); } catch (e) {} });
}

function staticSecurityHeaders(req, file) {
  const isAdmin = /(^|[\\/])admin([\\/]|$)/.test(file);
  const h = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
  };
  if (httpx.isHttps(req)) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  if (isAdmin) h["X-Robots-Tag"] = "noindex, nofollow, noarchive";
  return h;
}

async function readCtx(req, res) {
  const u = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  return {
    method: req.method.toUpperCase(),
    pathname: u.pathname,
    query: Object.fromEntries(u.searchParams),
    headers: req.headers,
    ip: httpx.clientIp(req),
    socket: req.socket,
    stream: req,
  };
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let ctx;
  try { ctx = await readCtx(req, res); } catch (e) { return httpx.sendText(res, 400, "Bad Request"); }

  try {
    /* ---------------- API ---------------- */
    if (ctx.pathname === "/api" || ctx.pathname.startsWith("/api/")) {
      const headers = httpx.securityHeaders(req);
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

      if (ctx.method === "OPTIONS") {
        /* 204 — только явно разрешённому origin. Иначе 405: иначе браузер
           сочтёт CORS-префлайт успешным. */
        const corsOrigin = process.env.DF_CORS_ORIGIN;
        if (corsOrigin && req.headers.origin === corsOrigin) {
          res.writeHead(204, { "Content-Length": "0" });
          return res.end();
        }
        return httpx.sendJson(res, 405, { ok: false, error: "method-not-allowed" });
      }

      /* Для multipart тело не читаем целиком — отдаём поток в busboy */
      const isMultipart = /^multipart\/form-data/i.test(String(req.headers["content-type"] || ""));
      if (!isMultipart) {
        if (["POST", "PUT", "PATCH", "DELETE"].includes(ctx.method)) {
          const raw = await httpx.readBody(req, config.maxBodyBytes);
          ctx.body = raw;
          if (raw.length) {
            try {
              const parsed = JSON.parse(raw.toString("utf8"));
              ctx.json = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                ? httpx.stripDangerousKeys(parsed) : null;
            } catch (e) { ctx.json = null; ctx.jsonError = true; }
          }
        } else {
          ctx.body = Buffer.alloc(0);
        }
      } else {
        ctx.body = null;
      }

      const out = await api.handle(ctx);

      if (out.setSession) httpx.sessionCookie(res, req, out.setSession.token, out.setSession.expiresAt);
      if (out.headers && out.headers["X-Clear-Session"]) httpx.clearSessionCookie(res, req);
      if (out.setSession && out.json && out.json.csrf) {
        const list = res.getHeader("Set-Cookie") || [];
        const arr = Array.isArray(list) ? list.slice() : [list];
        const secure = httpx.isHttps(req) ? "; Secure" : "";
        arr.push("df-csrf=" + out.json.csrf + "; Path=/; SameSite=" + config.sameSite + secure);
        res.setHeader("Set-Cookie", arr);
      }

      if (out.headers) {
        for (const [k, v] of Object.entries(out.headers)) {
          if (k === "X-Clear-Session") continue;      // служебный маркер, не заголовок
          if (v !== undefined && v !== null) res.setHeader(k, v);
        }
      }
      return httpx.sendJson(res, out.status, out.json === undefined ? null : out.json);
    }

    /* ---------------- статика ---------------- */
    if (!["GET", "HEAD"].includes(ctx.method)) return httpx.sendText(res, 405, "Method Not Allowed");

    if (ctx.pathname === "/admin") {
      res.writeHead(301, Object.assign({ Location: "/admin/" }, staticSecurityHeaders(req, "admin")));
      return res.end();
    }

    /* data.json публикуется сервером; при DF_DATA_JSON он может лежать вне
       веб-корня — отдаём именно настроенный файл. */
    if (ctx.pathname === "/data.json" && fs.existsSync(config.publicDataJson)) {
      const st = fs.statSync(config.publicDataJson);
      return sendFile(req, res, config.publicDataJson, st.size);
    }

    /* Медиа отдаются из каталога публикаций (publicImgDir), который может не
       совпадать с корнем статики — например, отдельный том на VPS или
       временный каталог в тестах. */
    if (ctx.pathname.startsWith("/img/")) {
      const rel = ctx.pathname.slice("/img/".length);
      const media_ = mediaResolve(rel);
      if (!media_) return httpx.sendText(res, 404, "404 — Not Found", staticSecurityHeaders(req, ctx.pathname));
      return sendFile(req, res, media_.file, media_.size);
    }

    const hit = resolveStatic(ctx.pathname);
    if (!hit) {
      audit.log("http.404", { path: ctx.pathname.slice(0, 200), ip: ctx.ip });
      return httpx.sendText(res, 404, "404 — Not Found", staticSecurityHeaders(req, ctx.pathname));
    }
    return sendFile(req, res, hit.file, hit.size);
  } catch (e) {
    const status = e && Number.isInteger(e.status) ? e.status : 500;
    audit.log("http.error", { path: ctx.pathname.slice(0, 200), status, message: String(e && e.message).slice(0, 200), ip: ctx.ip });
    if (!res.headersSent) {
      if (ctx.pathname.startsWith("/api/")) httpx.sendJson(res, status, { ok: false, error: status === 500 ? "internal" : e.message });
      else httpx.sendText(res, status, status === 500 ? "Internal Server Error" : "Error");
    } else { try { res.end(); } catch (e2) {} }
  } finally {
    if (config.isProd && process.env.DF_ACCESS_LOG !== "0") {
      audit.log("http.request", { method: ctx.method, path: ctx.pathname.slice(0, 200), status: res.statusCode, ms: Date.now() - started, ip: ctx.ip });
    }
  }
});

/* Плавное завершение: не рвём активные запросы */
function shutdown(signal) {
  audit.log("server.shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) => { audit.log("server.uncaught", { message: String(e && e.message).slice(0, 300) }); });
process.on("unhandledRejection", (e) => { audit.log("server.unhandled", { message: String(e && e.message).slice(0, 300) }); });

if (require.main === module) {
  const problems = assertProductionReady();
  if (problems.length) {
    console.error("Сервер не запущен — проблемы конфигурации:");
    problems.forEach((p) => console.error("  • " + p));
    process.exit(1);
  }
  const port = Number(process.argv[2] || config.port);
  server.listen(port, config.host, () => {
    audit.rotate();
    audit.log("server.start", { port, host: config.host, env: config.env });
    console.log("DUBRAVIN&FLOWERS · сервер с CMS");
    console.log("  витрина  → http://" + config.host + ":" + port + "/");
    console.log("  админка  → http://" + config.host + ":" + port + "/admin");
    console.log("  API      → http://" + config.host + ":" + port + "/api/health");
    console.log("  данные   → " + path.relative(config.root, config.dbFile));
    console.log("  фото     → img/  (хранилище: " + config.dataDir + ")");
    if (config.ephemeralSecret) console.log("  DF_SECRET не задан — сгенерирован одноразовый (сессии сбросятся при перезапуске)");
  });
}

module.exports = { server, resolveStatic, isBanned };
