# DEPLOYMENT.md — развёртывание: Netlify (демо) и полноценный переезд

Два сценария, оба используют один и тот же код:

- **A. Netlify free** — показать сайт и панель управления. Работает из коробки,
  но с оговоркой про хранение данных (раздел A.4 — прочитайте обязательно).
- **B. Свой сервер (VPS / Railway / Render / Fly.io)** — боевой режим:
  постоянная БД, медиа на диске, серверная авторизация без оговорок.

Сборка архива для обоих сценариев:

```bash
node tools/pack.js netlify     # → dist-archive/dubravin-flowers-netlify.zip
node tools/pack.js server      # → dist-archive/dubravin-flowers-server.zip
```

Скрипт сам проверяет, что в поставку не попали `.env`, `db.json`, `audit.log`,
`node_modules/`, `tests/`, `data.json`, и прерывает сборку при утечке.

---

## A. Netlify (бесплатный тариф) — работает полностью

### A.1. Что публикуется

```
index.html  admin/  assets/  img/  robots.txt
_headers  _redirects  netlify.toml  vercel.json
README.md  SECURITY.md  ARCHITECTURE.md  SECURITY-AUDIT.md  QA-PLAN.md  DEPLOYMENT.md
package.json  package-lock.json   ← по ним Netlify ставит зависимости функций
backend/netlify/api.mjs           ← функция API (/api/*)
backend/netlify/img.mjs           ← функция раздачи фото (/img/*) из Blobs
backend/server/*.js               ← их общий код (11 модулей)
backend/seed.json                 ← стартовый каталог (61 товар, 4 подборки)
```

Не публикуется: `tests/`, `tools/`, `deploy/`, `node_modules/`, `backend/data/`,
`backend/.env`, `data.json`, журналы, учётные данные. `tools/pack.js` проверяет
это перед упаковкой и **прерывает сборку при утечке**.

`package-lock.json` в поставке перегенерируется: в нём 52 пакета и нет `jsdom`
(dev-зависимость для тестов, ~20 МБ) — только `busboy` и `@netlify/blobs`.

### A.2. Деплой перетаскиванием (без git)

1. `node tools/pack.js netlify`
2. Netlify → **Sites** → **Add new site** → **Deploy manually**
3. Перетащите **каталог** `dist-archive/dubravin-flowers-netlify` (или `.zip`)
4. Дождитесь сборки функций (в логе деплоя будет `1 function` / `api`)
5. **Site configuration → Environment variables** → добавьте `DF_SECRET`
   (значение — см. A.3) и `DF_TRUST_PROXY=1`, затем **Trigger deploy → Deploy site**
6. Проверьте: `https://ваш-сайт.netlify.app/api/health` → `{"ok":true,…,"cms":"server"}`

### A.2 bis. Деплой через git (рекомендуется)

```bash
git init && git add -A && git commit -m "dubravin-flowers"
git remote add origin <ваш репозиторий>
git push -u origin main
```

В Netlify: **Add new site → Import an existing project**. Настройки сборки:

| Поле | Значение |
|---|---|
| Base directory | *(пусто)* |
| Build command | `npm install --omit=dev --no-audit --no-fund` |
| Publish directory | `.` |
| Functions directory | `backend/netlify` |
| Node version | 20 (Environment variable `NODE_VERSION = 20`) |

**Build command обязателен.** Без установки зависимостей функция не найдёт
`busboy` и `@netlify/blobs` и упадёт с `Cannot find module`. Если оставляете
поле пустым в UI, убедитесь, что Netlify подхватил `command` из `netlify.toml`
(в логе деплоя должна быть строка `npm install`).

`netlify.toml` в корне подхватывается автоматически: в нём прописаны `publish`,
`command`, `functions`, `node_bundler = "esbuild"`, `included_files`
(`backend/server/**` и `backend/seed.json` попадают в бандл функции), а также
редиректы `/api/*` и `/img/*` на функции, `/admin` → `/admin/` и блокировка
служебных каталогов.

### A.3. Переменные окружения

| Переменная | Значение | Зачем |
|---|---|---|
| `DF_SECRET` | 64+ случайных символа | HMAC токенов сессий. Без неё в `NODE_ENV=production` сервер не стартует |
| `DF_BOOTSTRAP_LOGIN` | логин админа | Первая учётка (CLI на функции недоступен) |
| `DF_BOOTSTRAP_HASH` | `scrypt$…$…` | **Хэш** пароля, а не пароль |
| `NODE_ENV` | `production` | Режим продакшена |
| `DF_TRUST_PROXY` | `1` | Доверять `X-Forwarded-Proto`/`-For` от Netlify (HTTPS и реальный IP) |
| `DF_BLOBS_STORE` | `dubravin` *(по умолчанию)* | Имя пространства имён Netlify Blobs |
| `DF_SCRYPT_N` | `131072` *(по умолчанию)* | Стоимость хэширования |
| `DF_SESSION_TTL_MS` | `1800000` *(по умолчанию)* | 30 минут сессии |

Все пять обязательных значений выдаёт одна команда (см. A.5). Отдельно
сгенерировать секрет:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### A.4. Где живут данные на Netlify (и что реально работает)

Файловая система функции эфемерна: `/tmp` очищается между вызовами, инстансы
не разделяют диск. Поэтому данные хранятся **не в файлах, а в Netlify Blobs** —
штатном постоянном хранилище Netlify, которое доступно из Functions без внешних
аккаунтов и ключей (платформа сама подставляет `siteID` и `token`).

| Что | Где хранится | Переживает перезапуск/деплой |
|---|---|---|
| Товары, подборки, hero | Blobs, ключ `db` | **да** |
| Админы, хэши паролей, сессии | Blobs, ключ `db` | **да** |
| Загруженные фото | Blobs, ключи `img/<ID>/<n>.<ext>` | **да** |
| Журнал безопасности | `/tmp` (эфемерно) | нет — на Netlify смотрите Logs → Functions |
| `data.json` | не нужен | витрина читает каталог из `GET /api/content` |

Blobs: до 5 ГБ на объект, хранение и трафик в пределах бесплатных лимитов сайта,
модель «последняя запись побеждает». Для магазина с одним-двумя админами этого
достаточно, а конфликт одновременных правок контента всё равно ловится на
уровне ревизий (`If-Match` → `409`).

Фото отдаёт отдельная функция `img.mjs` (редирект `/img/* → /.netlify/functions/img/:splat`
с `force = true`): каталог публикации доступен только для чтения, поэтому
загруженные через CMS изображения физически не могут лежать в `img/` деплоя.

Проверить, что хранилище подключилось:

```bash
curl -s https://ваш-сайт.netlify.app/api/health
# {"ok":true,…,"storage":"netlify-blobs","cms":"server"}
```

Если вместо `netlify-blobs` вы видите `fs` — функция не получила контекст сайта
(например, запускается вне Netlify) и работает в эфемерном режиме: правки
сохранятся только до выгрузки инстанса. Причина и предупреждение пишутся в
Logs → Functions.

**Что на Netlify free работает полностью:** витрина, вход в `/admin` с проверкой
пароля на сервере, добавление/редактирование/удаление товаров и подборок,
смена hero, загрузка и замена фото с удалением старых файлов, мгновенная
видимость правок для всех посетителей, блокировка перебора, журнал попыток.

**Чего на Netlify нет по сравнению с VPS:** постоянного журнала безопасности на
диске, CLI-команд (их заменяют переменные bootstrap и API), HTTP Basic Auth
поверх `/admin` (включается в Netlify Password Protection на платных тарифах),
резервных копий файловой системы (вместо них — экспорт `data.json` из панели
и Blobs UI в Netlify).

### A.5. Создание админа для Netlify

CLI на функции недоступен, поэтому учётку заготавливают локально — команда
печатает **переменные окружения**, а не секрет в открытом виде:

```bash
node backend/cli/admin.js bootstrap --login <ваш-логин>
# пароль вводится скрыто; либо --random [длина] — сгенерировать и показать один раз
```

Вывод:

```
DF_BOOTSTRAP_LOGIN=dubravin
DF_BOOTSTRAP_HASH=scrypt$131072$8$1$<соль>$<хэш>
DF_SECRET=<64+ случайных символа>
NODE_ENV=production
DF_TRUST_PROXY=1

── Данные для входа (показаны один раз) ──
логин : dubravin
пароль: <пароль>
```

Скопируйте все пять переменных в **Site configuration → Environment variables**,
затем **Trigger deploy → Deploy site**. При первом запросе функция увидит, что
админов в хранилище нет, и создаст учётку из этих переменных с флагом
«требуется смена пароля».

Безопасность схемы:

- в переменные попадает **хэш scrypt**, а не пароль: даже человек с доступом к
  списку переменных Netlify не сможет войти;
- пароль показывается один раз и нигде не сохраняется;
- bootstrap срабатывает **только пока админов нет** — повторно учётку из
  переменных создать нельзя, поэтому после первого входа переменные
  `DF_BOOTSTRAP_*` лучше удалить;
- мусорный хэш и логин короче 3 символов отклоняются, отказ пишется в журнал
  (проверено тестом `bootstrap не срабатывает дважды и не принимает мусорный хэш`).

Дальнейшая смена пароля — в панели (`Данные` → `Безопасность`) или через
`POST /api/admin/recovery-token` + `POST /api/auth/reset`.

### A.6. Проверка после деплоя

```bash
BASE=https://ваш-сайт.netlify.app

# 1. API жив и хранит данные в Blobs (не в эфемерном /tmp)
curl -s $BASE/api/health
#    ожидаем: {"ok":true,…,"storage":"netlify-blobs","cms":"server"}

# 2. Каталог отдаётся (61 товар из seed при первом запуске)
curl -s $BASE/api/content | head -c 160

# 3. Заголовки безопасности и noindex для админки
curl -sI $BASE/       | grep -iE "content-security|x-frame|strict-transport|x-content-type"
curl -sI $BASE/admin  | grep -iE "^location|x-robots"      # 301 → /admin/ + noindex
curl -sI $BASE/admin/ | grep -i "x-robots"

# 4. Служебное не отдаётся
for u in /tests/harness.js /package.json /backend/server/auth.js /backend/.env /tools/pack.js; do
  printf "%-28s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' $BASE$u)"
done                                                        # ожидаем 404 везде

# 5. Аноним не может писать
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/admin/products \
  -H 'Content-Type: application/json' -d '{"name":"x","price":1}'   # 401

# 6. CORS не разрешён
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS $BASE/api/admin/products \
  -H 'Origin: https://evil.example'                                  # 405

curl -s $BASE/robots.txt                                              # Disallow: /admin/
```

Затем в браузере: войдите в `/admin` (появятся поля «Логин» и «Пароль»),
создайте товар, загрузите фото, откройте витрину в другой вкладке или
в режиме инкогнито — правка должна быть видна сразу. Перезагрузите сайт
через 10–15 минут: данные обязаны остаться (это и есть проверка, что
работает Blobs, а не `/tmp`).

---

## B. Переезд на свой сервер (боевой режим)

Здесь работает всё без оговорок: постоянная БД, медиа на диске, журнал
безопасности, CLI-восстановление доступа.

### B.1. Требования

- Node.js **20+** (проверить: `node -v`)
- 512 МБ RAM достаточно; диск — по объёму фото (сайт ~0,4 МБ + медиа)
- Открытые порты 80/443, домен, сертификат (Let's Encrypt)

### B.2. Установка

```bash
sudo mkdir -p /var/www && cd /var/www
sudo unzip dubravin-flowers-server.zip          # или tar -xzf
sudo mv dubravin-flowers-server dubravin-flowers
cd dubravin-flowers

npm install --omit=dev                          # единственная зависимость — busboy
cp backend/.env.example backend/.env
nano backend/.env                               # DF_SECRET, NODE_ENV=production, PORT
chmod 600 backend/.env

# данные сервера — ВНЕ веб-корня
sudo mkdir -p /var/lib/dubravin-flowers
sudo chown www-data:www-data /var/lib/dubravin-flowers
echo 'DF_DATA_DIR=/var/lib/dubravin-flowers' >> backend/.env

node backend/cli/seed.js                        # стартовый каталог → backend/seed.json
node backend/cli/admin.js create --random       # логин + пароль (печатается один раз)
node backend/cli/admin.js doctor                # диагностика
```

### B.3. systemd-сервис

`/etc/systemd/system/dubravin-flowers.service`:

```ini
[Unit]
Description=DUBRAVIN&FLOWERS — витрина и серверная CMS
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/dubravin-flowers
EnvironmentFile=/var/www/dubravin-flowers/backend/.env
ExecStart=/usr/bin/node backend/server/server.js 8090
Restart=on-failure
RestartSec=3
# --- усиление ---
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/www/dubravin-flowers/img /var/www/dubravin-flowers/data.json /var/lib/dubravin-flowers
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
MemoryMax=512M
TasksMax=64

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dubravin-flowers
sudo systemctl status dubravin-flowers
journalctl -u dubravin-flowers -f          # живой лог
```

`ProtectSystem=strict` + явный `ReadWritePaths` означают, что даже при
компрометации процесса злоумышленник не запишет ничего вне каталога медиа,
`data.json` и `backend/data`.

### B.4. nginx (reverse-proxy + HTTPS)

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/dubravin-flowers
sudo nano /etc/nginx/sites-available/dubravin-flowers    # домен и пути
sudo ln -s /etc/nginx/sites-available/dubravin-flowers /etc/nginx/sites-enabled/
sudo certbot --nginx -d ваш-домен.ru                      # сертификат + автопродление
sudo nginx -t && sudo systemctl reload nginx
```

В конфиге уже есть: редирект 80 → 443, все заголовки безопасности, две CSP
(витрина и админка), блокировка `tests/`, `deploy/`, `backend/`,
`node_modules/`, `package*.json`, dot-файлов, `location = /admin` → `301`,
кэширование статики, `no-store` для `data.json`, и **закомментированный блок
`auth_basic`** — включите его, чтобы закрыть `/admin` ещё и серверным паролем
(второй рубеж поверх scrypt).

Проверка заголовков:

```bash
curl -sI https://ваш-домен.ru/ | grep -iE "strict-transport|content-security|x-frame|x-content"
curl -sI https://ваш-домен.ru/admin/ | grep -i "x-robots"
```

### B.5. Резервное копирование

Восстановить можно всё, кроме двух вещей: **`backend/data/`** (БД, журнал)
и **`img/`** (фото). Их и копируем.

```bash
# /etc/cron.daily/dubravin-backup
#!/bin/sh
tar -czf /var/backups/dubravin-$(date +\%F).tar.gz \
  -C /var/lib dubravin-flowers \
  -C /var/www/dubravin-flowers img data.json
find /var/backups -name 'dubravin-*.tar.gz' -mtime +14 -delete
```

```bash
chmod +x /etc/cron.daily/dubravin-backup
```

Восстановление: распаковать, положить `backend/data/` на место,
`systemctl restart dubravin-flowers`. Сервер подхватит файл автоматически —
внешняя подмена детектируется по отпечатку содержимого.

### B.6. Обновление версии сайта

```bash
cd /var/www/dubravin-flowers
node ../tools/pack.js server && unzip -o ../dist-archive/dubravin-flowers-server.zip
npm install --omit=dev
npm test                       # 307 тестов должны быть зелёными
sudo systemctl restart dubravin-flowers
node backend/cli/admin.js doctor
```

`backend/data/` и `img/` при этом не затрагиваются: их нет в архиве поставки.

---

## C. Другие площадки (коротко)

| Площадка | Как |
|---|---|
| **Vercel** | `vercel.json` уже в корне: заголовки, CSP, `/admin` → rewrite. Функции — перенести `backend/netlify/api.mjs` в `api/index.ts` (формат ответа тот же, меняется обёртка) |
| **Cloudflare Pages** | Статика публикуется как есть (`_headers`, `_redirects` сработают). API — в Pages Functions (`functions/api/[[route]].js`), логика `api.handle(ctx)` переносится без изменений |
| **Railway / Render / Fly.io** | Полноценный режим B: `start: node backend/server/server.js`, постоянный том для `DF_DATA_DIR` и `img/` |
| **GitHub Pages** | Только витрина (functions нет). `deploy/_redirects.github-pages` — для связки с Netlify/Cloudflare поверх. CMS работает в клиентском режиме (`localStorage` + ручная публикация `data.json`) |
| **Обычный Apache** | `.htaccess` в корне (копия — `deploy/apache.htaccess`): редирект `/admin`, блокировка служебных каталогов, ЧПУ, заголовки. Node-процесс — рядом, Apache проксирует `/api` через `mod_proxy` |

---

## D. Чек-лист перед публикацией

- [ ] `npm test` — 307/307 зелёные
- [ ] `node tools/pack.js <netlify|server>` — сборка прошла, утечек нет
- [ ] `DF_SECRET` задан в окружении площадки (не в репозитории)
- [ ] `NODE_ENV=production`
- [ ] Админ создан: на VPS — `node backend/cli/admin.js create --random`;
      на Netlify — `node backend/cli/admin.js bootstrap` + пять переменных окружения
- [ ] На Netlify: `/api/health` возвращает `"storage":"netlify-blobs"` (не `fs`)
- [ ] На Netlify: правка, сделанная 15 минут назад, видна после перезагрузки
- [ ] `node backend/cli/admin.js doctor` — время scrypt 50–1000 мс, «ссылки без файлов» = 0
- [ ] Сайт работает по HTTPS, HSTS включился в заголовках
- [ ] `/admin` → 301 на `/admin/`, есть `X-Robots-Tag: noindex`, в `robots.txt` есть `Disallow: /admin/`
- [ ] `curl -I /backend/data/db.json`, `/tests/harness.js`, `/package.json`, `/.env` → 404
- [ ] `curl -X OPTIONS /api/admin/products -H "Origin: https://evil.example"` → 405
- [ ] Настроены бэкапы `backend/data/` и `img/`
- [ ] Включён `auth_basic` на `/admin` (nginx) или Password Protection (Netlify) — второй рубеж
- [ ] Проверен сценарий «правка в CMS → витрина у другого посетителя обновилась»
- [ ] Проверен сценарий «замена фото → старый файл удалён с диска» (`ls img/<ID>/`)
- [ ] Записан порядок восстановления доступа: `admin.js recovery` → `POST /api/auth/reset`
