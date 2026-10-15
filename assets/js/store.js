"use strict";
/* =========================================================
   МОДУЛЬ B. CMS: ХРАНИЛИЩЕ ДАННЫХ
   Основной режим — серверный (backend CMS): правки уходят на
   хостинг и сразу видны всем посетителям. localStorage —
   только резервный режим, когда сервера CMS рядом нет.
   Структура DB:
   { hero:{img}, collections:[{id,name,cover,main}],
     products:[{id,name,desc,price,old,imgs[],cols[],sale,hit,main,comp[]}] }
   sale — производный флаг (old > price); main — «На главной»
   (не более MAIN_LIMIT товаров и подборок).
   ========================================================= */
var DB=null;
var CMS_KEY="df-cms-v1";

/* =========================================================
   ЛИМИТЫ БИЗНЕС-ПРАВИЛ (единый источник для панели и витрины;
   на сервере продублированы в backend/server/config.js)
   ========================================================= */
var MAIN_LIMIT=4;         /* максимум карточек/подборок «На главной» */
var MAX_IMGS=5;           /* максимум фото у товара */
var MAX_COMP=10;          /* максимум позиций в «Составе» */
var SALE_COL_ID="sale";   /* авто-подборка товаров со скидкой */

/* =========================================================
   СЕРВЕРНЫЙ СЛОЙ CMS
   Если вместе с сайтом запущен backend (backend/server/server.js
   или Netlify Functions), правки уходят на сервер: там они пишутся
   в БД и сразу публикуют data.json — изменения видны всем
   посетителям, а не только этому браузеру.

   Без сервера (статический хостинг) всё работает по-прежнему
   через localStorage — обратная совместимость сохранена.

   Токен сессии держим ТОЛЬКО в памяти вкладки: в хранилище его нет,
   поэтому украсть его через XSS-чтение localStorage нельзя.
   ========================================================= */
var DF_API=null;                 /* база API, null — пока не проверили */
var DF_TOKEN=null;               /* Bearer-токен (только в памяти) */
var DF_SERVER_OK=false;
var DF_REV=null;                 /* последняя известная ревизия контента */
var DF_SAVE_TIMER=null;

function dfApiBase(){
  /* В админке DF_DATA_URL="../data.json" → API в корне сайта.
     На витрине data.json лежит рядом → база "/api". */
  var u=window.DF_DATA_URL||"data.json";
  if(u.indexOf("../")===0)return "../api";
  if(u.charAt(0)==="/")return "/api";
  return "api";
}

/* Есть ли рядом сервер CMS? Один HEAD-запрос при старте страницы. */
function dfProbeServer(cb){
  var done=false;
  function finish(ok){ if(done)return; done=true; DF_SERVER_OK=!!ok; if(cb)cb(!!ok); }
  try{
    fetch(dfApiBase()+"/health",{cache:"no-store",credentials:"same-origin"})
      .then(function(r){
        if(!r.ok){finish(false);return null;}
        return r.json();
      })
      .then(function(j){ DF_API=j&&j.ok?dfApiBase():null; finish(!!DF_API); })
      .catch(function(){finish(false);});
  }catch(e){finish(false);}
  setTimeout(function(){finish(false);},1500);
}

/* Запрос к API. При 401 токеном больше не пользуемся — панель
   вернётся к локальному режиму и попросит войти заново.
   extraHeaders — дополнительные заголовки (например If-Match). */
function dfApiRequest(method,path,body,extraHeaders){
  if(!DF_SERVER_OK||!DF_API)return Promise.resolve(null);
  var opt={method:method,cache:"no-store",credentials:"same-origin",headers:{}};
  if(DF_TOKEN)opt.headers["Authorization"]="Bearer "+DF_TOKEN;
  if(body!==undefined&&!(body instanceof FormData)){
    opt.headers["Content-Type"]="application/json";
    opt.body=JSON.stringify(body);
  }else if(body!==undefined){
    opt.body=body;   /* для FormData заголовок выставит браузер (с boundary) */
  }
  if(extraHeaders){
    for(var hk in extraHeaders){
      if(Object.prototype.hasOwnProperty.call(extraHeaders,hk))opt.headers[hk]=extraHeaders[hk];
    }
  }
  return fetch(DF_API+path,opt).then(function(r){
    if(r.status===401){DF_TOKEN=null;}
    return r.json().catch(function(){return {ok:false,error:"bad-response"};})
      .then(function(j){return {status:r.status,ok:r.ok,body:j};});
  }).catch(function(e){return null;});
}

function dfSetToken(t){DF_TOKEN=(typeof t==="string"&&t)?t:null;}
function dfIsServerMode(){return !!(DF_SERVER_OK&&DF_API&&DF_TOKEN);}
/* Вход и выход с проверкой учётных данных на сервере реализованы в
   assets/js/admin/admin-main.js: store.js загружается и витриной, а в коде
   витрины не должно быть ни аутентификации, ни связанных с ней терминов
   (это проверяет статический аудит безопасности). */
function dfServerMode(){return !!(DF_SERVER_OK&&DF_API);}

/* Немедленная отправка контента на сервер (без дебаунса).
   Возвращает промис: тело ответа при успехе, null при ошибке.
   Используется панелью, когда после сохранения нужны ещё действия
   (например загрузка фото сохранённого товара). */
var DF_WARN_TS=0;
function dfServerFlush(){
  if(DF_SAVE_TIMER){clearTimeout(DF_SAVE_TIMER);DF_SAVE_TIMER=null;}
  if(!DB)return Promise.resolve(null);
  if(!dfIsServerMode()){
    var now=Date.now();
    if(DF_SERVER_OK&&DF_API&&!DF_TOKEN&&now-DF_WARN_TS>4000){
      DF_WARN_TS=now;
      showToast("Серверная сессия не активна — войдите в панель, чтобы изменения публиковались для всех");
    }
    return Promise.resolve(null);
  }
  var headers={};
  if(DF_REV!==null)headers["If-Match"]=String(DF_REV);
  return dfApiRequest("PUT","/admin/content",{hero:DB.hero,collections:DB.collections,products:DB.products},headers)
    .then(function(r){
      if(!r)return null;
      if(r.ok&&r.body&&r.body.ok){
        if(typeof r.body.rev==="number")DF_REV=r.body.rev;
        return r.body;
      }
      if(r.status===409){
        showToast("Контент изменился в другой сессии — это сохранение выполнено поверх, проверьте результат");
        DF_REV=null;   /* следующий PUT пройдёт без If-Match */
      }else if(r.status===401){
        showToast("Серверная сессия истекла — войдите заново, чтобы опубликовать правки");
      }else{
        showToast("Не удалось сохранить изменения на сервере ("+((r.body&&r.body.error)||r.status)+")");
      }
      return null;
    });
}

/* Отправка контента на сервер. Дебаунс 250 мс: панель вызывает dbSave()
   на каждое поле, а нам достаточно одного запроса на серию правок. */
function dfServerSave(){
  if(!DB)return;
  if(DF_SAVE_TIMER)clearTimeout(DF_SAVE_TIMER);
  DF_SAVE_TIMER=setTimeout(function(){
    DF_SAVE_TIMER=null;
    dfServerFlush();
  },250);
}

/* Перечитать контент с сервера (после загрузки фото и т.п.),
   чтобы панель и витрина показывали актуальную серверную версию. */
function dfReloadContent(){
  if(!dfServerMode())return Promise.resolve(false);
  return dfApiRequest("GET","/content").then(function(r){
    if(r&&r.ok&&r.body&&r.body.products){
      if(typeof r.body.rev==="number")DF_REV=r.body.rev;
      var fresh=sanitizeDB(r.body);
      if(fresh)DB=fresh;
      return true;
    }
    return false;
  });
}

/* Загрузка фото на сервер как файлов (multipart).
   Возвращает промис с { ok, urls, rejected } или null, если сервера нет. */
function dfUploadPhotos(productId,files,replace){
  if(!dfIsServerMode())return Promise.resolve(null);
  var fd=new FormData();
  fd.append("replace",replace?"true":"false");
  for(var i=0;i<files.length;i++){fd.append("photo"+i,files[i],files[i].name||("photo"+i));}
  return dfApiRequest("POST","/admin/products/"+encodeURIComponent(productId)+"/photos",fd);
}

function dbSave(){
  /* Обнаружен сервер CMS — источник истины ОН: правка сразу уходит
     на сервер и публикуется для всех посетителей. Браузерное хранилище
     в этом режиме не используется. */
  if(DF_SERVER_OK&&DF_API){dfServerSave();return;}
  /* Резервный режим (сервера нет, например локальный просмотр файлов):
     данные живут в этом браузере. */
  try{localStorage.setItem(CMS_KEY,JSON.stringify(DB));}
  catch(e){showToast("Не хватило памяти браузера — экспортируйте data.json и очистите лишние фото");}
}
function dbInit(cb){
  var done=false;
  function finish(j){
    if(done)return; done=true;
    DB=(j&&j.products&&j.collections)?sanitizeDB(j):seedDB();
    cb();
  }
  /* Локальный черновик админки — только когда сервера нет. При живом
     бэкенде источник истины один: серверная БД (иначе правки с другого
     устройства никогда не доехали бы до этого браузера). */
  function fromLocalDraft(){
    var raw=null;
    try{raw=localStorage.getItem(CMS_KEY);}catch(e){}
    if(raw){
      /* Внешние данные всегда проходят sanitizeDB — в том числе черновик
         из localStorage: его мог записать другой скрипт или старая версия. */
      var draft=null;
      try{draft=sanitizeDB(JSON.parse(raw));}catch(e){draft=null;}
      if(draft&&draft.products){finish(draft);return;}
    }
    fromDataJson();
  }
  function fromDataJson(){
    try{
      fetch(window.DF_DATA_URL||"data.json",{cache:"no-store"})
        .then(function(r){return r.ok?r.json():null;})
        .then(function(j){finish(j);})
        .catch(function(){finish(null);});
    }catch(e){finish(null);}
    setTimeout(function(){finish(null);},2500);
  }
  /* 1) серверный каталог → 2) data.json → 3) localStorage → 4) seed */
  dfProbeServer(function(ok){
    if(!ok){fromLocalDraft();return;}
    dfApiRequest("GET","/content").then(function(r){
      if(r&&r.ok&&r.body&&r.body.products){
        if(typeof r.body.rev==="number")DF_REV=r.body.rev;
        finish(r.body);
      }else{
        fromDataJson();
      }
    });
  });
}
function colName(id){
  var c=(DB.collections||[]).filter(function(x){return x.id===id;})[0];
  return c?c.name:"Каталог";
}
function prodById(id){
  return (DB.products||[]).filter(function(x){return String(x.id)===String(id);})[0];
}
/* Автогенерация ID нового товара: следующий свободный числовой.
   Поле ID в панели не показывается — номер назначается сам. */
function nextProductId(){
  var maxId=0;
  (DB.products||[]).forEach(function(p){var n=parseInt(p.id,10);if(!isNaN(n)&&n>maxId)maxId=n;});
  var id=String(maxId+1);
  while(prodById(id)){maxId++;id=String(maxId+1);}
  return id;
}
/* Подборка «Акции» существует, пока есть товары со старой ценой:
   создаётся автоматически при первом же акционном товаре. */
function ensureSaleCollection(){
  DB.collections=DB.collections||[];
  var exists=DB.collections.some(function(c){return c.id===SALE_COL_ID;});
  if(!exists)DB.collections.push({id:SALE_COL_ID,name:"Акции",cover:"",main:false});
}
/* Сколько товаров/подборок уже отмечены «На главной» (кроме исключённого id) */
function mainProductsCount(excludeId){
  return (DB.products||[]).filter(function(p){return p.main&&String(p.id)!==String(excludeId);}).length;
}
function mainCollectionsCount(excludeId){
  return (DB.collections||[]).filter(function(c){return c.main&&String(c.id)!==String(excludeId);}).length;
}
function catalogList(cat){
  var list=DB.products||[];
  if(cat!=="all")list=list.filter(function(p){return (p.cols||[]).indexOf(cat)>-1;});
  return list;
}
function colCover(c){
  if(c.cover)return c.cover;
  var p=catalogList(c.id)[0];
  if(p&&p.imgs&&p.imgs.length)return p.imgs[0];
  return "";
}
function prodCover(p){
  if(p.imgs&&p.imgs.length)return p.imgs[0];
  /* Нет фото: в режиме серверной CMS сразу заглушка (папки img/ не существует),
     на статическом хостинге — шанс, что фото положили в папку вручную. */
  if(typeof dfServerMode==="function"&&dfServerMode())return PH;
  return firstSrc(p.id,1);
}
/* загрузка файла изображения → сжатие до max px → Blob (JPEG).
   Используется для отправки фото НА СЕРВЕР: оригиналы с телефона (5–10 МБ)
   упираются в лимит размера запроса serverless-функций, а после сжатия
   фото весит сотни КБ. Если canvas недоступен/файл не читается — cb(null),
   вызывающий код отправит оригинал как есть. */
function resizeImgFile(file,max,quality,cb){
  var c=null;
  try{c=document.createElement("canvas");}catch(e){cb(null);return;}
  if(!c||typeof c.getContext!=="function"){cb(null);return;}
  var probe=null;
  try{probe=c.getContext("2d");}catch(e){probe=null;}
  if(!probe){cb(null);return;}
  try{
    var fr=new FileReader();
    fr.onload=function(){
      var im=new Image();
      im.onload=function(){
        try{
          var w=im.width||max,h=im.height||max;
          if(w>max){h=Math.round(h*max/w);w=max;}
          if(h>max){w=Math.round(w*max/h);h=max;}
          c.width=w;c.height=h;
          c.getContext("2d").drawImage(im,0,0,w,h);
          if(typeof c.toBlob==="function"){
            c.toBlob(function(b){cb(b||null);},"image/jpeg",quality);
          }else{cb(null);}
        }catch(e){cb(null);}
      };
      im.onerror=function(){cb(null);};
      im.src=fr.result;
    };
    fr.onerror=function(){cb(null);};
    fr.readAsDataURL(file);
  }catch(e){cb(null);}
}
/* загрузка файла изображения → сжатие до 1200px → dataURL */
function readImgFile(file,cb){
  var fr=new FileReader();
  fr.onload=function(){
    var im=new Image();
    im.onload=function(){
      var max=1200,w=im.width,h=im.height;
      if(w>max){h=Math.round(h*max/w);w=max;}
      var c=document.createElement("canvas");c.width=w;c.height=h;
      c.getContext("2d").drawImage(im,0,0,w,h);
      cb(c.toDataURL("image/jpeg",0.82));
    };
    im.onerror=function(){cb(null);};
    im.src=fr.result;
  };
  fr.readAsDataURL(file);
}
function exportDB(){
  var blob=new Blob([JSON.stringify(DB,null,2)],{type:"application/json"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="data.json";
  document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},400);
}

/* =========================================================
   МОДУЛЬ B2. ИСХОДНЫЙ НАБОР ТОВАРОВ (для seed и сброса)
   ========================================================= */
function P(id,cat,name,price,old,desc,comp){
  return {id:String(id),cat:cat,name:name,price:price,old:old||null,desc:desc,comp:comp.split("|")};
}
var BASE_PRODUCTS = [
  P(1,"bouquets","Букет из эквадорских роз🤍",3990,6990,"Роскошный микс белых и красных эквадорских роз в бордовом авторском оформлении. Крупная роза 60 см, букет выглядит дорого и стоит 10+ дней.","Роза эквадорская 60 см|Бордовая упаковка|Атласная лента"),
  P(2,"comp","Цветочная композиция в корзинке🌿",3490,null,"Композиция в плетёной корзинке: белые хризантемы, розовые розы и альстромерия с зеленью. Не нужна ваза — вода уже внутри.","Хризантема|Роза|Альстромерия|Плетёная корзинка"),
  P(3,"comp","Цветочная композиция в сумочке🌿",2490,null,"Компактная композиция в сумочке-ручке: свежие цветы во флористической губке. Идеальный комплимент коллеге или учителю.","Сезонные цветы|Сумочка|Флористическая губка"),
  P(4,"bouquets","Медовая маттиола в авторском оформлении🌿",5990,null,"Ароматная медовая маттиола в авторском оформлении — нежное облачко цветов с медовым ароматом.","Маттиола|Авторское оформление|Лента"),
  P(5,"comp","Цветочная корзина🌿",3490,null,"Полноценная цветочная корзина в бело-розовой гамме с зеленью. Самодостаточный подарок к любому поводу.","Хризантемы|Розы|Зелень|Корзина"),
  P(6,"comp","Цветочная композиция🕊️",2890,null,"Воздушная композиция в бело-розовой гамме с эустомой и розами — лёгкость и нежность в каждой линии.","Эустома|Роза|Зелень"),
  P(7,"comp","Ромашковая сумочка - мини🌿",1490,null,"Мини-версия любимой ромашковой сумочки: кустовые хризантемы-ромашки в кремовой сумочке-ручке.","Хризантема ромашковая|Сумочка-мини"),
  P(8,"comp","Ромашковая сумочка🤍",1990,null,"Ромашковые хризантемы в стильной сумочке с ручками. Ярко, легко и очень фотогенично.","Хризантема ромашковая|Сумочка|Зелень"),
  P(9,"mono","Монобукет из хризантем 🤍",2990,null,"Монобукет из белых хризантем в матовой упаковке. Строго, стильно и очень стойко.","Хризантема белая|Упаковка|Лента"),
  P(10,"bouquets","Бордовая классика💔",3990,6990,"Бордовая классика: глубокие красные розы в бордовой упаковке. Вечный жанр для главных слов.","Роза красная|Бордовая упаковка|Лента"),
  P(11,"mono","Монобукет из хризантем🤍",2990,null,"Монобукет из белых хризантем с зеленью — свежесть и лёгкость на долгие дни.","Хризантема|Зелень|Упаковка"),
  P(12,"mono","Монобукет из хризантем🤍",2990,null,"Плотный монобукет из хризантем в белой упаковке — классика, которая всегда уместна.","Хризантема|Упаковка|Лента"),
  P(13,"comp","Цветочная композиция в корзине 🤍",4090,null,"Композиция в плетёной корзине в белой гамме: хризантемы, розы и эустома.","Хризантема|Роза|Эустома|Корзина"),
  P(14,"mono","Букет из хризантем🦋",1990,null,"Лёгкий букет из хризантем в пастельной гамме — настроение порхающих бабочек.","Хризантема|Пастельная упаковка"),
  P(15,"comp","Цветочная композиция в корзине 🌿",3890,null,"Композиция в корзине с зеленью и сезонными цветами — уютный подарок для дома.","Сезонные цветы|Зелень|Корзина"),
  P(16,"bouquets","Авторский букет🕊️",4990,null,"Авторский букет наших флористов: уникальное сочетание цветов и фактур в единственном экземпляре.","Сезонные цветы|Авторское оформление"),
  P(17,"bouquets","Авторский букет🌿",4790,null,"Авторский букет с акцентной зеленью — стильно, современно, характерно.","Сезонные цветы|Зелень|Оформление"),
  P(18,"bouquets","Авторский букет 🤍️",4390,null,"Авторский букет в белой палитре — нежность, воплощённая во цветах.","Белые цветы|Авторское оформление"),
  P(19,"mono","Ромашковый🤍",1090,null,"Компактный ромашковый монобукет — просто, тепло и по-домашнему.","Хризантема ромашковая"),
  P(20,"mono","Одноголовые хризантемы в букете💔",3190,null,"Букет из одноголовых хризантем в глубокой бордовой гамме — драматично и выразительно.","Хризантема одноголовая|Упаковка"),
  P(21,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(22,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(23,"bouquets","Хризантемы+ромашки🌼",2990,null,"Дуэт хризантем и ромашек с зеленью — солнечное сочетание в одном букете.","Хризантема|Ромашка|Зелень"),
  P(24,"mono","Ромашковое моно🌼",3790,null,"Ромашковое моно: плотный охапочный букет из кустовых ромашек с зеленью.","Хризантема ромашковая|Зелень|Упаковка"),
  P(25,"bouquets","Осенний букет с подсолнухами🌼",4690,null,"Осенний букет с подсолнухами — тепло сентябрьского солнца в каждом лепестке.","Подсолнух|Сезонные цветы|Оформление"),
  P(26,"comp","Цветочная композиция🌿",1890,null,"Компактная цветочная композиция с зеленью — приятный знак внимания без повода.","Сезонные цветы|Зелень"),
  P(27,"comp","Цветочная композиция🌿",1890,null,"Компактная цветочная композиция с зеленью — приятный знак внимания без повода.","Сезонные цветы|Зелень"),
  P(28,"comp","Цветочная композиция💛",1890,null,"Композиция в жёлтой гамме — маленький кусочек солнца на вашем столе.","Сезонные цветы|Жёлтая гамма"),
  P(29,"comp","Цветочная композиция🌿",2090,null,"Композиция с зеленью в нейтральной палитре — стильный акцент для интерьера.","Сезонные цветы|Зелень"),
  P(30,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(31,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(32,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(33,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(34,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(35,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(36,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(37,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(38,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(39,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(40,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(41,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(42,"bouquets","25 эквадорских роз🤍",3990,6990,"25 крупных эквадорских роз в праздничном оформлении. Акционная цена вместо обычной.","Роза эквадорская 60 см|Оформление|Лента"),
  P(43,"bouquets","11 пионов в авторском оформлении 🌸️",8990,null,"11 отборных пионов в авторском оформлении — сезон пушистых пионов в самом разгаре.","Пион|Авторское оформление|Лента"),
  P(44,"bouquets","15 пионов в авторском оформлении 🌸️",11690,null,"15 пионов в авторском оформлении — роскошный объём и фирменный аромат.","Пион|Авторское оформление|Лента"),
  P(45,"bouquets","25 пионов в авторском оформлении🌸️",19490,null,"25 пионов — букет, который говорит о любви громче слов.","Пион|Авторское оформление|Лента"),
  P(46,"bouquets","51 пион в авторском оформлении🌸️",38790,null,"51 пион — грандиозный жест для самого важного повода.","Пион|Авторское оформление|Лента"),
  P(47,"bouquets","Дофаминовый букет🫧",4090,null,"Дофаминовый букет: яркий микс, который поднимает настроение с одного взгляда.","Розы|Гвоздики|Альстромерия|Оформление"),
  P(48,"bouquets","Нежность 🤍️",3590,null,"Нежность: бело-розовый букет с розами и эустомой в воздушной упаковке.","Роза|Эустома|Упаковка"),
  P(49,"bouquets","Лиловый микс🎀",3190,null,"Лиловый микс с лентой — романтичное настроение в каждом цветке.","Сезонные цветы|Лиловая гамма|Лента"),
  P(50,"bouquets","Весенний🕊️",4190,null,"Весенний букет с тюльпанами и зеленью — как первые тёплые дни.","Тюльпаны|Зелень|Оформление"),
  P(51,"bouquets","Солнечный микс цветов🌿",3790,null,"Солнечный микс цветов с жёлтыми акцентами — тепло в каждом лепестке.","Сезонные цветы|Жёлтые акценты|Зелень"),
  P(52,"bouquets","Авторский🫧",4590,null,"Авторский букет в розово-белой гамме с игривыми акцентами.","Сезонные цветы|Авторское оформление"),
  P(53,"mono","Моно букет из гортензий🌿",4290,null,"Монобукет из гортензий — пышное облако крупных соцветий.","Гортензия|Упаковка|Лента"),
  P(54,"mono","Пушистое облако из хризантем🤍",6090,null,"Пушистое облако из белых хризантем — объёмный и воздушный монобукет.","Хризантема белая|Упаковка"),
  P(55,"bouquets","Пломбирный букет🤍",5390,null,"Пломбирный букет: сливочно-белые цветы, похожие на шарик мороженого.","Белые цветы|Зелень|Оформление"),
  P(56,"bouquets","101 тюльпан в оформлении 🤍",5990,8990,"101 тюльпан в праздничном оформлении. Акция: большой жест по приятной цене.","Тюльпан 101 шт|Оформление"),
  P(57,"balls","Шар-сфера с шариками и надписью🎈",1549,null,"Шар-сфера с маленькими шариками внутри и индивидуальной надписью.","Шар-сфера|Шарики внутри|Надпись"),
  P(58,"balls","Шар-сфера с надписью🎈",1249,null,"Шар-сфера с индивидуальной надписью — лёгкий и приятный комплимент.","Шар-сфера|Надпись"),
  P(59,"balls","Шар в шаре с конфетти и надписью🎈",3267,null,"Шар в шаре с конфетти и надписью — двойной wow-эффект при вручении.","Внешняя сфера|Внутренний шар|Конфетти|Надпись"),
  P(60,"balls","Шар-сфера с конфетти и надписью🎈",1249,null,"Шар-сфера с конфетти и надписью — праздничное настроение в каждом движении.","Шар-сфера|Конфетти|Надпись"),
  P(61,"balls","Шар с диодом - белый🎈",159,null,"Белый шар с диодной гирляндой — светится в темноте и создаёт праздник.","Шар|Диодная гирлянда")
];
var SEED_MAIN = ["1","2","4","56"];
var SEED_HIT = ["47","54"];
/* В seed-данных НЕТ заглушек-обложек: imgs и cover пусты, а плэйсхолдер
   подставляется только при отрисовке (prodCover/colCover) и пропадёт сам,
   как только загрузят настоящее фото. */
function seedDB(){
  return {
    hero:{img:""},
    collections:[
      {id:"bouquets", name:"Букеты", cover:"", main:true},
      {id:"mono", name:"Монобукеты", cover:"", main:true},
      {id:"comp", name:"Композиции и корзины", cover:"", main:true},
      {id:"balls", name:"Гелиевые шары", cover:"", main:true},
      {id:SALE_COL_ID, name:"Акции", cover:"", main:false}
    ],
    products: BASE_PRODUCTS.map(function(p){
      var sale=!!p.old;
      return {
        id:p.id, name:p.name, desc:p.desc, price:p.price, old:p.old,
        imgs:[],
        cols: sale?[p.cat,SALE_COL_ID]:[p.cat],
        sale:sale,
        hit:SEED_HIT.indexOf(p.id)>-1,
        main:SEED_MAIN.indexOf(p.id)>-1,
        comp:p.comp.slice()
      };
    })
  };
}
function fmt(n){ return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g," ")+" ₽"; }

/* =========================================================
   МОДУЛЬ B3. БЕЗОПАСНОСТЬ ДАННЫХ: ЭКРАНИРОВАНИЕ, SAFE-URL,
   САНИТАЦИЯ БД (защита от XSS и «грязных» data.json)
   ========================================================= */
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
/* Пропускает только безопасные адреса изображений: относительные пути,
   http(s), data:image/*. Всё прочее (javascript:, vbscript:, data:text/html,
   protocol-relative //) заменяется заглушкой "#". */
function safeUrl(u){
  u=String(u==null?"":u).trim();
  if(!u)return "";
  if(/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(u))return u;
  if(/^https?:\/\//i.test(u))return u;
  if(/^[?#]/.test(u))return u;
  if(/^(?!\/\/)[^:]*$/.test(u))return u;
  return "#";
}
function sanitizeString(v,maxlen){
  if(typeof v==="number"&&isFinite(v))v=String(v);
  if(typeof v!=="string")return "";
  v=v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,"");
  if(v.length>maxlen)v=v.slice(0,maxlen);
  return v;
}
function sanitizeId(v){return sanitizeString(v,64).replace(/[^A-Za-z0-9_-]/g,"");}
function sanitizePrice(v){
  var n=parseFloat(v);
  if(!isFinite(n)||n<0)return 0;
  return Math.round(n*100)/100;
}
function sanitizeBool(v){return v===true||v==="true"||v===1||v==="1";}
/* Приводит произвольный JSON к безопасной структуре БД витрины. */
function sanitizeDB(j){
  if(!j||typeof j!=="object"||Array.isArray(j))return null;
  var heroImg=safeUrl(sanitizeString(j.hero&&j.hero.img,2000000));
  if(heroImg==="#")heroImg="";   /* опасный адрес → пусто (витрина подставит заглушку сама) */
  var out={hero:{img:heroImg}};
  var colMainUsed=0;
  out.collections=(Array.isArray(j.collections)?j.collections:[])
    .filter(function(c){return c&&typeof c==="object"&&!Array.isArray(c);})
    .slice(0,50).map(function(c,i){
    var cover=safeUrl(sanitizeString(c.cover,2000000));
    if(cover==="#")cover="";   /* опасный адрес → пустая обложка (сработает colCover) */
    var m=sanitizeBool(c.main);
    if(m){colMainUsed++;if(colMainUsed>MAIN_LIMIT)m=false;}   /* на главной — не больше MAIN_LIMIT подборок */
    return {
      id:sanitizeId(c.id)||("c"+i),
      name:sanitizeString(c.name,80)||"Подборка",
      cover:cover,
      main:m
    };
  });
  var prodMainUsed=0;
  out.products=(Array.isArray(j.products)?j.products:[])
    .filter(function(p){return p&&typeof p==="object"&&!Array.isArray(p);})
    .slice(0,2000).map(function(p,i){
    var old=(p.old===null||p.old===undefined||p.old==="")?null:sanitizePrice(p.old);
    var price=sanitizePrice(p.price);
    var m=sanitizeBool(p.main);
    if(m){prodMainUsed++;if(prodMainUsed>MAIN_LIMIT)m=false;}   /* на главной — не больше MAIN_LIMIT карточек */
    return {
      id:sanitizeId(p.id)||("p"+Date.now()+"_"+i),
      name:sanitizeString(p.name,160),
      desc:sanitizeString(p.desc,2000),
      price:price,
      old:(old||null),
      imgs:(Array.isArray(p.imgs)?p.imgs:[]).slice(0,MAX_IMGS)
        .map(function(u){return safeUrl(sanitizeString(u,2000000));})
        .filter(function(u){return u&&u!=="#";}),
      cols:(Array.isArray(p.cols)?p.cols:[]).slice(0,50)
        .map(function(c){return sanitizeId(c);}).filter(Boolean),
      /* «Акция» — производный флаг: заполнена старая цена → товар акционный */
      sale:sanitizeBool(p.sale)||(old!==null&&old>price),
      hit:sanitizeBool(p.hit),
      main:m,
      comp:(Array.isArray(p.comp)?p.comp:[]).slice(0,MAX_COMP)
        .map(function(c){return sanitizeString(c,80);})
        .filter(function(c){return String(c).trim()!=="";})
    };
  });
  return out;
}