"use strict";
/* =========================================================
   МОДУЛЬ FONTS. НЕБЛОКИРУЮЩАЯ ЗАГРУЗКА ВЕБ-ШРИФТОВ
   Подключается в <head> ДО таблиц стилей.

   Зачем: шесть <link rel="stylesheet"> на cdn.jsdelivr.net в <head>
   блокировали первую отрисовку — на медленной сети это напрямую
   ухудшало LCP (каждый такой CSS ждёт ответа CDN перед рендером).

   Как работает: ссылки создаются с media="print" (браузер загружает их
   асинхронно и не блокирует рендер), а после загрузки media меняется
   на "all". До подгрузки шрифта текст рисуется системным стеком из
   00-tokens.css — контент виден сразу, смена начертания разовая.

   Важно: обработчик навешивается через addEventListener, а не атрибутом
   onload= — иначе нарушилась бы строгая CSP сайта (script-src без
   'unsafe-inline').
   ========================================================= */
(function () {
  var FONTS = [
    /* Заголовочный шрифт: три начертания */
    "https://cdn.jsdelivr.net/fontsource/css/unbounded@latest/400.css",
    "https://cdn.jsdelivr.net/fontsource/css/unbounded@latest/600.css",
    "https://cdn.jsdelivr.net/fontsource/css/unbounded@latest/800.css",
    /* Текстовый шрифт: три начертания */
    "https://cdn.jsdelivr.net/fontsource/css/manrope@latest/400.css",
    "https://cdn.jsdelivr.net/fontsource/css/manrope@latest/500.css",
    "https://cdn.jsdelivr.net/fontsource/css/manrope@latest/700.css"
  ];

  function load() {
    var head = document.head || document.getElementsByTagName("head")[0];
    if (!head) return;
    for (var i = 0; i < FONTS.length; i++) {
      try {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = FONTS[i];
        link.media = "print";                 /* не блокирует рендер */
        link.setAttribute("data-font-async", "");
        /* onload через addEventListener: inline-обработчики запрещены CSP
           и отсеиваются статическим аудитом безопасности. */
        link.addEventListener("load", function () { this.media = "all"; });
        link.addEventListener("error", function () {
          /* CDN недоступен — остаёмся на системных шрифтах, сайт работает */
          if (this.parentNode) this.parentNode.removeChild(this);
        });
        head.appendChild(link);
      } catch (e) { /* окружение без DOM — молча пропускаем */ }
    }
  }

  /* Скрипт лежит в <head>, поэтому head уже существует */
  load();
})();
