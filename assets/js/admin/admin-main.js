"use strict";
/* =========================================================
   МОДУЛЬ ADMIN-MAIN. ЛОГИКА СТРАНИЦЫ /admin:
   экран авторизации → панель CMS, авто-выход по таймауту,
   смена пароля, тема оформления.
   Данные (DB) и панель (tplAdmin/bindAdmin) — из общих модулей.
   ========================================================= */
/* data.json ищем в корне сайта (страница лежит в /admin/) */
window.DF_DATA_URL="../data.json";

/* Пароль по умолчанию для статического режима (без бэкенда).
   Создаётся автоматически при первом открытии /admin, чтобы посетитель
   сразу видел форму входа, а не экран «придумайте пароль». Хранится в виде
   хэша PBKDF2; сменить можно в панели: «Данные» → «Безопасность».
   Очистка localStorage возвращает этот пароль. */
var DF_DEFAULT_PASSWORD="dubravin";

(function(){
  var IDLE_CHECK_MS=30000;   /* как часто проверять живость сессии */
  var TOUCH_THROTTLE_MS=5000;/* как часто продлевать сессию при активности */
  var SERVER_PING_MS=5*60*1000;  /* как часто поддерживать серверную сессию живой */
  var IDLE_SERVER_CHECK_MS=10*60*1000; /* бездействие дольше — проверяем сессию на сервере */
  var idleTimer=null,lockTimer=null,lastTouch=0,lastServerPing=0;

  function dfServer(){return (typeof dfServerMode==="function")&&dfServerMode();}
  function dfLoggedIn(){return (typeof dfIsServerMode==="function")&&dfIsServerMode();}
  function sessionAlive(){return DFAuth.checkSession()||dfLoggedIn();}
  /* Продлить/проверить серверную сессию: GET /auth/me обновляет скользящий
     таймаут на сервере; при 401 токен гасится и панель возвращает ко входу. */
  function pingServerSession(){
    if(!dfLoggedIn())return Promise.resolve(false);
    lastServerPing=Date.now();
    return dfApiRequest("GET","/auth/me").then(function(r){
      var ok=!!(r&&r.ok&&r.body&&r.body.ok);
      if(!ok)dfSetToken(null);
      return ok;
    });
  }

  function $(id){return document.getElementById(id);}
  function show(el,on){if(el)el.hidden=!on;}

  /* ---------- серверная аутентификация ----------
     Учётные данные проверяются на бэкенде (backend/server/auth.js): там
     пароль сравнивается с хэшем scrypt, а клиент получает только токен
     сессии. Токен живёт в памяти вкладки (dfSetToken из store.js) и в
     httpOnly-куке — в localStorage его нет.                            */
  function dfServerLogin(login,password){
    if(typeof dfServerMode!=="function"||!dfServerMode())return Promise.resolve(null);
    var base=dfApiBase();
    return fetch(base+"/auth/login",{
      method:"POST",credentials:"same-origin",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({login:login,password:password})
    }).then(function(r){
      return r.json().catch(function(){return {};}).then(function(j){return {status:r.status,body:j};});
    }).catch(function(){return null;});
  }

  function dfServerLogout(){
    if(typeof dfApiRequest!=="function")return Promise.resolve(null);
    var p=dfApiRequest("POST","/auth/logout");
    dfSetToken(null);
    return p;
  }

  /* ---------- экран входа ---------- */
  function showLogin(){
    stopIdleWatch();
    show($("appScreen"),false);
    show($("loginScreen"),true);
    /* Серверный режим: учётки создаёт оператор на сервере (CLI), поэтому
       экран «первого запуска» не показываем и просим логин. */
    var serverMode=(typeof dfServerMode==="function")&&dfServerMode();
    show($("loginField"),serverMode);
    var li=$("loginInput");
    if(li&&!serverMode)li.value="";
    show($("loginForm"),true);
    hideError("loginError");hideError("setupError");
    var btnL=$("loginBtn");
    if(btnL){btnL.disabled=false;btnL.textContent="Войти";}
    updateLockUI();
    var inp=$("pwInput");
    if(inp){inp.value="";try{inp.focus();}catch(e){}}
  }
  function showError(id,msg){
    var e=$(id);
    if(!e)return;
    e.textContent=msg;   /* textContent — без HTML-инъекций */
    e.hidden=false;
  }
  function hideError(id){
    var e=$(id);
    if(!e)return;
    e.textContent="";e.hidden=true;
  }
  function updateLockUI(){
    var st=DFAuth.lockoutState();
    var hint=$("lockHint"),btnL=$("loginBtn");
    if(st.locked){
      var sec=Math.ceil(st.retryAfter/1000);
      if(hint){
        hint.hidden=false;
        hint.textContent="Слишком много неудачных попыток. Повторите через "+sec+" с.";
      }
      if(btnL)btnL.disabled=true;
      if(!lockTimer)lockTimer=setInterval(updateLockUI,250);
    }else{
      if(hint){hint.hidden=true;hint.textContent="";}
      if(btnL&&$("loginScreen")&&!$("loginScreen").hidden)btnL.disabled=false;
      if(lockTimer){clearInterval(lockTimer);lockTimer=null;}
    }
  }

  /* ---------- панель ---------- */
  function showApp(){
    show($("loginScreen"),false);
    show($("appScreen"),true);
    var app=$("admApp");
    app.innerHTML=tplAdmin();
    bindAdmin();
    startIdleWatch();
  }
  function startIdleWatch(){
    stopIdleWatch();
    idleTimer=setInterval(function(){
      if(dfLoggedIn()){
        /* Серверная сессия живёт 30 минут бездействия (скользящий таймаут).
           При долгом простое спрашиваем сервер напрямую; если сессия
           истекла — токен гасится и следующий тик вернёт форму входа. */
        if(Date.now()-Math.max(lastTouch,lastServerPing)>IDLE_SERVER_CHECK_MS)pingServerSession();
      }
      if(!sessionAlive()){
        showLogin();
        showToast("Сессия завершена — войдите снова");
      }
    },IDLE_CHECK_MS);
  }
  function stopIdleWatch(){
    if(idleTimer){clearInterval(idleTimer);idleTimer=null;}
  }
  function onActivity(){
    var now=Date.now();
    if(now-lastTouch<TOUCH_THROTTLE_MS)return;
    lastTouch=now;
    if(!$("appScreen")||$("appScreen").hidden)return;
    if(dfLoggedIn()){
      /* Работа в панели продлевает серверную сессию (не чаще раза в 5 минут) */
      if(now-lastServerPing>SERVER_PING_MS)pingServerSession();
      return;
    }
    DFAuth.touch();
  }

  /* ---------- привязка формы входа ---------- */
  function bindGate(){
    var lf=$("loginForm");
    lf.addEventListener("submit",function(e){
      e.preventDefault();
      hideError("loginError");
      var btn=$("loginBtn");
      if(btn.disabled)return;
      var pw=$("pwInput").value;
      btn.disabled=true;btn.textContent="Проверяем…";
      /* Если рядом работает сервер CMS — пароль проверяет ОН: сравнение с
         хэшем scrypt происходит на бэкенде, клиент получает только токен
         сессии (в памяти вкладки) и httpOnly-куку. Локальный DFAuth в этом
         случае служит лишь запасным путём для статического хостинга. */
      if(typeof dfServerLogin==="function"&&dfServerMode()){
        var lg=($("loginInput")?$("loginInput").value:"").trim();
        if(!lg){
          btn.disabled=false;btn.textContent="Войти";
          showError("loginError","Укажите логин: вход проверяется на сервере.");
          return;
        }
        dfServerLogin(lg,pw).then(function(sr){
          $("pwInput").value="";
          if(sr&&sr.body&&sr.body.ok){
            dfSetToken(sr.body.token);
            lastServerPing=Date.now();
            btn.textContent="Войти";
            showApp();
            showToast("Вход подтверждён сервером · правки публикуются для всех посетителей");
            return;
          }
          btn.disabled=false;
          var b=(sr&&sr.body)||{};
          if(sr&&sr.status===423){
            showError("loginError","Вход временно заблокирован после серии неудачных попыток. Повторите позже.");
          }else if(sr&&sr.status===429){
            showError("loginError","Слишком много попыток с вашего адреса. Подождите и повторите.");
          }else if(!sr){
            showError("loginError","Сервер авторизации недоступен. Проверьте, что backend запущен.");
          }else if(b.hint==="no-admins"){
            showError("loginError","На сервере ещё нет учётной записи: задайте переменные DF_BOOTSTRAP_LOGIN и DF_BOOTSTRAP_HASH (их печатает команда node backend/cli/admin.js bootstrap --login <логин> --random) и перезапустите деплой. Подробности — в CHANGES.md.");
          }else{
            var leftS=(typeof b.attemptsLeft==="number")?b.attemptsLeft:null;
            var msgS="Неверный логин или пароль.";
            if(leftS===1)msgS+=" Это была последняя попытка до блокировки.";
            else if(leftS!==null&&leftS>1)msgS+=" Осталось попыток: "+leftS+".";
            showError("loginError",msgS);
          }
        });
        return;
      }
      DFAuth.login(pw).then(function(r){
        btn.textContent="Войти";
        if(r.ok){
          $("pwInput").value="";
          showApp();
          showToast("Добро пожаловать в панель управления");
          return;
        }
        btn.disabled=false;
        if(r.reason==="locked"){
          showError("loginError","Вход временно заблокирован.");
          updateLockUI();
        }else if(r.reason==="nosetup"){
          /* Учётные данные пропали (например, очищено хранилище прямо во
             время работы) — молча пересоздаём дефолтные и показываем вход. */
          ensureProvisioned().then(showLogin);
        }else if(r.reason==="error"){
          showError("loginError","Ошибка проверки пароля. Обновите страницу.");
        }else{
          var left=(typeof r.attemptsLeft==="number")?r.attemptsLeft:null;
          var msg="Неверный пароль.";
          if(left===1)msg+=" Это была последняя попытка до блокировки.";
          else if(left!==null&&left>1)msg+=" Осталось попыток: "+left+".";
          showError("loginError",msg);
          $("pwInput").value="";
          if(r.retryAfter)updateLockUI();
        }
      });
    });

    $("logoutBtn").addEventListener("click",function(){
      /* Сначала гасим серверную сессию (токен отзывается в БД сервера),
         затем локальную — чтобы выход был полным в обоих режимах. */
      var done=function(){
        DFAuth.logout();
        showLogin();
        showToast("Вы вышли из панели управления");
      };
      if(typeof dfServerLogout==="function"&&dfIsServerMode()){
        dfServerLogout().then(done,done);
      }else{
        done();
      }
    });

    var tb=$("admTheme");
    if(tb){
      tb.addEventListener("click",function(){
        var next=document.documentElement.dataset.theme==="dark"?"light":"dark";
        document.documentElement.dataset.theme=next;
        try{localStorage.setItem("df-theme",next);}catch(e){}
        var mt=$("metaTheme");
        if(mt)mt.setAttribute("content",next==="dark"?"#0A1710":"#F6F1E8");
      });
    }

    ["click","keydown","mousemove","touchstart","scroll"].forEach(function(ev){
      document.addEventListener(ev,onActivity,{passive:true});
    });
    window.addEventListener("beforeunload",function(){stopIdleWatch();});
  }

  /* ---------- старт ---------- */
  /* В статическом режиме (сервер CMS не обнаружен) при первом заходе
     молча создаём учётные данные с паролем по умолчанию — без сессии.
     Благодаря этому посетитель сразу видит форму авторизации. */
  function ensureProvisioned(){
    var serverMode=(typeof dfServerMode==="function")&&dfServerMode();
    if(serverMode||DFAuth.isSetup())return Promise.resolve();
    try{
      return DFAuth.provision(DF_DEFAULT_PASSWORD).then(function(){});
    }catch(e){return Promise.resolve();}
  }
  function boot(){
    document.title="Управление сайтом — DUBRAVIN&FLOWERS";
    var y=$("admYear");
    if(y)y.textContent=new Date().getFullYear();
    bindGate();
    /* Мгновенно показываем форму входа, не дожидаясь загрузки данных —
       иначе страница была бы белой, пока dbInit опрашивает сервер/data.json.
       Если сессия жива, после загрузки данных форму заменит панель. */
    if(!DFAuth.checkSession())showLogin();
    dbInit(function(){
      ensureProvisioned().then(function(){
        if(DFAuth.checkSession()){showApp();return;}
        /* Перезагрузили вкладку: токен жил только в памяти, но httpOnly-кука
           сессии осталась — спрашиваем сервер и восстанавливаем вход. */
        if(dfServer()){
          dfApiRequest("GET","/auth/me").then(function(r){
            if(r&&r.ok&&r.body&&r.body.ok&&r.body.token){
              dfSetToken(r.body.token);
              lastServerPing=Date.now();
              showApp();
            }else{showLogin();}
          });
          return;
        }
        showLogin();
      });
    });
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
