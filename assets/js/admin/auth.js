"use strict";
/* =========================================================
   МОДУЛЬ AUTH. АВТОРИЗАЦИЯ ПАНЕЛИ УПРАВЛЕНИЯ (/admin)

   Модель (статический сайт, без бэкенда):
   • Пароль никогда не хранится в открытом виде — только хэш:
       - PBKDF2-HMAC-SHA256, 260 000 итераций, соль 16 байт (WebCrypto),
       - если WebCrypto недоступен (например, открытие по file://) —
         итеративный SHA-256 (100 000 раундов) на чистой JS-реализации.
   • Блокировка перебора: после 5 неудач — 30 с, далее вдвое дольше
     (потолок 15 минут). Счётчик живёт в localStorage (переживает F5).
   • Сессия: sessionStorage, токен 32 байта, таймаут бездействия 30 минут.
   • Все данные хранятся только в браузере владельца (localStorage).
   ========================================================= */
var DFAuth=(function(){

  var CRED_KEY="df-admin-cred";   // хэш пароля (localStorage)
  var FAIL_KEY="df-admin-fail";   // счётчик неудач (localStorage)
  var SESS_KEY="df-admin-sess";   // сессия (sessionStorage)

  var PBKDF2_ITER=260000;         // OWASP/рекомендации для PBKDF2-HMAC-SHA256
  var FALLBACK_ROUNDS=100000;     // для чистой JS-реализации SHA-256
  var MAX_FAILS=5;
  var BASE_LOCK_MS=30000;
  var MAX_LOCK_MS=15*60000;
  var SESSION_TTL_MS=30*60000;
  var MIN_LEN=8;
  var MAX_LEN=128;

  /* ---------- утилиты ---------- */
  function toHex(bytes){
    var s="",i;
    for(i=0;i<bytes.length;i++){s+=("0"+bytes[i].toString(16)).slice(-2);}
    return s;
  }
  function fromHex(hex){
    var h=String(hex||"").replace(/[^0-9a-fA-F]/g,"");
    if(h.length%2)h=h.slice(0,h.length-1);
    var out=new Uint8Array(h.length/2),i;
    for(i=0;i<out.length;i++){out[i]=parseInt(h.substr(i*2,2),16);}
    return out;
  }
  function randBytes(n){
    if(typeof crypto==="undefined"||!crypto.getRandomValues){
      throw new Error("crypto.getRandomValues недоступен");
    }
    var a=new Uint8Array(n);
    crypto.getRandomValues(a);
    return a;
  }
  function hasSubtle(){
    try{
      return !!(typeof crypto!=="undefined"&&crypto.subtle&&crypto.subtle.importKey&&crypto.subtle.deriveBits);
    }catch(e){return false;}
  }
  /* Сравнение строк постоянной длительности (защита от timing-атак) */
  function safeEqual(a,b){
    a=String(a);b=String(b);
    if(a.length!==b.length)return false;
    var diff=0,i;
    for(i=0;i<a.length;i++){diff|=a.charCodeAt(i)^b.charCodeAt(i);}
    return diff===0;
  }
  function readJSON(store,key){
    try{var r=store.getItem(key);return r?JSON.parse(r):null;}catch(e){return null;}
  }
  function writeJSON(store,key,val){
    try{store.setItem(key,JSON.stringify(val));return true;}catch(e){return false;}
  }
  function removeKey(store,key){try{store.removeItem(key);}catch(e){}}

  /* ---------- SHA-256 на чистом JS (FIPS 180-4) ---------- */
  var SHA256_K=[
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256Bytes(msg){
    var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var l=msg.length;
    var total=(Math.ceil((l+9)/64))*64;
    var buf=new Uint8Array(total);
    buf.set(msg);
    buf[l]=0x80;
    var dv=new DataView(buf.buffer);
    dv.setUint32(total-8,Math.floor(l/536870912)); /* старшие 32 бита длины в битах */
    dv.setUint32(total-4,(l<<3)>>>0);
    var w=new Uint32Array(64);
    function rotr(x,n){return (x>>>n)|(x<<(32-n));}
    var b,i,a,bb,c,d,e,f,g,h,S0,S1,ch,maj,t1,t2,s0,s1;
    for(b=0;b<total;b+=64){
      for(i=0;i<16;i++){w[i]=dv.getUint32(b+i*4);}
      for(i=16;i<64;i++){
        s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
        s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
        w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
      }
      a=H[0];bb=H[1];c=H[2];d=H[3];e=H[4];f=H[5];g=H[6];h=H[7];
      for(i=0;i<64;i++){
        S1=rotr(e,6)^rotr(e,11)^rotr(e,25);
        ch=(e&f)^(~e&g);
        t1=(h+S1+ch+SHA256_K[i]+w[i])>>>0;
        S0=rotr(a,2)^rotr(a,13)^rotr(a,22);
        maj=(a&bb)^(a&c)^(bb&c);
        t2=(S0+maj)>>>0;
        h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=bb;bb=a;a=(t1+t2)>>>0;
      }
      H[0]=(H[0]+a)>>>0;H[1]=(H[1]+bb)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
      H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
    }
    var out=new Uint8Array(32);
    var odv=new DataView(out.buffer);
    for(i=0;i<8;i++){odv.setUint32(i*4,H[i]);}
    return out;
  }
  function concatBytes(a,b){
    var out=new Uint8Array(a.length+b.length);
    out.set(a,0);out.set(b,a.length);
    return out;
  }
  /* Итеративный SHA-256: H0=sha256(salt||pw), Hi=sha256(H(i-1)||pw) */
  function deriveFallbackHex(password,saltHex,rounds){
    var enc=new TextEncoder();
    var pw=enc.encode(password);
    var h=sha256Bytes(concatBytes(fromHex(saltHex),pw));
    var i;
    for(i=1;i<rounds;i++){h=sha256Bytes(concatBytes(h,pw));}
    return toHex(h);
  }
  function pbkdf2Hex(password,saltHex,iter){
    var enc=new TextEncoder();
    return crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"])
      .then(function(key){
        return crypto.subtle.deriveBits(
          {name:"PBKDF2",salt:fromHex(saltHex),iterations:iter,hash:"SHA-256"},key,256);
      })
      .then(function(bits){return toHex(new Uint8Array(bits));});
  }
  function derive(pw,cred){
    if(!cred||!cred.salt||!cred.hash)return Promise.reject(new Error("bad-cred"));
    if(cred.kdf==="pbkdf2-sha256"){
      if(!hasSubtle())return Promise.reject(new Error("webcrypto-unavailable"));
      return pbkdf2Hex(pw,cred.salt,cred.iter||PBKDF2_ITER);
    }
    if(cred.kdf==="sha256-iter"){
      return Promise.resolve(deriveFallbackHex(pw,cred.salt,cred.rounds||FALLBACK_ROUNDS));
    }
    return Promise.reject(new Error("unknown-kdf"));
  }
  function makeCred(pw){
    var salt=toHex(randBytes(16));
    if(hasSubtle()){
      return pbkdf2Hex(pw,salt,PBKDF2_ITER)
        .then(function(h){return {v:1,kdf:"pbkdf2-sha256",iter:PBKDF2_ITER,salt:salt,hash:h,created:Date.now()};})
        .catch(function(){
          return {v:1,kdf:"sha256-iter",rounds:FALLBACK_ROUNDS,salt:salt,hash:deriveFallbackHex(pw,salt,FALLBACK_ROUNDS),created:Date.now()};
        });
    }
    return Promise.resolve({v:1,kdf:"sha256-iter",rounds:FALLBACK_ROUNDS,salt:salt,hash:deriveFallbackHex(pw,salt,FALLBACK_ROUNDS),created:Date.now()});
  }

  /* ---------- хранилища ---------- */
  function readCred(){
    var c=readJSON(localStorage,CRED_KEY);
    if(!c||typeof c!=="object")return null;
    if(typeof c.hash!=="string"||!/^[0-9a-f]{64}$/i.test(c.hash))return null;
    if(typeof c.salt!=="string"||!/^[0-9a-f]{16,64}$/i.test(c.salt))return null;
    return c;
  }
  function readFails(){
    var f=readJSON(localStorage,FAIL_KEY);
    if(!f||typeof f!=="object")return null;
    if(typeof f.n!=="number"||f.n<0)return null;
    return f;
  }
  function lockMsFor(n){
    var exp=n-MAX_FAILS;
    if(exp<0)exp=0;
    return Math.min(BASE_LOCK_MS*Math.pow(2,exp),MAX_LOCK_MS);
  }
  function recordFail(){
    var f=readFails()||{n:0,until:0};
    f.n+=1;
    if(f.n>=MAX_FAILS){f.until=Date.now()+lockMsFor(f.n);}
    writeJSON(localStorage,FAIL_KEY,f);
    return f;
  }
  function lockoutState(){
    var f=readFails();
    if(!f||!f.n)return {locked:false,retryAfter:0,fails:0,attemptsLeft:MAX_FAILS};
    var now=Date.now();
    if(f.until&&f.until>now&&f.n>=MAX_FAILS){
      return {locked:true,retryAfter:f.until-now,fails:f.n,attemptsLeft:0};
    }
    return {locked:false,retryAfter:0,fails:f.n,attemptsLeft:Math.max(0,MAX_FAILS-f.n)};
  }

  /* ---------- сессия ---------- */
  function createSession(){
    var tok;
    try{tok=toHex(randBytes(32));}catch(e){return false;}
    return writeJSON(sessionStorage,SESS_KEY,{tok:tok,exp:Date.now()+SESSION_TTL_MS});
  }
  function readSession(){
    var s=readJSON(sessionStorage,SESS_KEY);
    if(!s||typeof s!=="object")return null;
    if(typeof s.tok!=="string"||s.tok.length<32)return null;
    if(typeof s.exp!=="number")return null;
    return s;
  }
  function checkSession(){
    var s=readSession();
    if(!s)return false;
    if(Date.now()>s.exp){clearSession();return false;}
    return true;
  }
  function touch(){
    var s=readSession();
    if(!s)return false;
    if(Date.now()>s.exp){clearSession();return false;}
    s.exp=Date.now()+SESSION_TTL_MS;
    return writeJSON(sessionStorage,SESS_KEY,s);
  }
  function clearSession(){removeKey(sessionStorage,SESS_KEY);}

  /* ---------- проверка пароля по длине ---------- */
  function validateLen(pw){
    if(typeof pw!=="string"||pw.length<MIN_LEN)return "short";
    if(pw.length>MAX_LEN)return "long";
    return null;
  }

  /* ---------- публичный API ---------- */
  function isSetup(){return !!readCred();}

  /* Тихая подготовка учётных данных БЕЗ открытия сессии.
     Вызывается один раз при первом заходе в /admin (см. admin-main.js),
     чтобы посетитель сразу видел форму входа, а не экран «придумайте
     пароль». Сессию не создаёт: вход по-прежнему требует пароль. */
  function provision(pw){
    if(readCred())return Promise.resolve({ok:false,reason:"exists"});
    var bad=validateLen(pw);
    if(bad)return Promise.resolve({ok:false,reason:bad});
    return makeCred(pw).then(function(cred){
      if(!writeJSON(localStorage,CRED_KEY,cred))return {ok:false,reason:"storage"};
      removeKey(localStorage,FAIL_KEY);
      return {ok:true,kdf:cred.kdf};
    });
  }

  function login(pw){
    var st=lockoutState();
    if(st.locked)return Promise.resolve({ok:false,reason:"locked",retryAfter:st.retryAfter});
    var cred=readCred();
    if(!cred)return Promise.resolve({ok:false,reason:"nosetup"});
    if(typeof pw!=="string"||!pw){
      var f0=recordFail();
      return Promise.resolve({ok:false,reason:"bad",attemptsLeft:Math.max(0,MAX_FAILS-f0.n),retryAfter:0});
    }
    return derive(pw.length>MAX_LEN?pw.slice(0,MAX_LEN):pw,cred).then(function(hash){
      if(safeEqual(hash,cred.hash)){
        removeKey(localStorage,FAIL_KEY);
        createSession();
        return {ok:true};
      }
      var f=recordFail();
      var lockedNow=(f.n>=MAX_FAILS);
      return {
        ok:false,reason:"bad",
        attemptsLeft:Math.max(0,MAX_FAILS-f.n),
        retryAfter:lockedNow?lockMsFor(f.n):0
      };
    }).catch(function(err){
      return {ok:false,reason:"error",message:String(err&&err.message||err)};
    });
  }

  function changePassword(oldPw,newPw){
    var st=lockoutState();
    if(st.locked)return Promise.resolve({ok:false,reason:"locked",retryAfter:st.retryAfter});
    var cred=readCred();
    if(!cred)return Promise.resolve({ok:false,reason:"nosetup"});
    var bad=validateLen(newPw);
    if(bad)return Promise.resolve({ok:false,reason:bad});
    return derive(String(oldPw||""),cred).then(function(hash){
      if(!safeEqual(hash,cred.hash)){
        var f=recordFail();
        return {ok:false,reason:"badold",attemptsLeft:Math.max(0,MAX_FAILS-f.n)};
      }
      removeKey(localStorage,FAIL_KEY);
      return makeCred(newPw).then(function(nc){
        if(!writeJSON(localStorage,CRED_KEY,nc))return {ok:false,reason:"storage"};
        touch();
        return {ok:true,kdf:nc.kdf};
      });
    }).catch(function(err){
      return {ok:false,reason:"error",message:String(err&&err.message||err)};
    });
  }

  function logout(){clearSession();}

  return {
    isSetup:isSetup,
    provision:provision,
    login:login,
    logout:logout,
    checkSession:checkSession,
    touch:touch,
    changePassword:changePassword,
    lockoutState:lockoutState,
    CONFIG:{
      MIN_LEN:MIN_LEN,MAX_LEN:MAX_LEN,PBKDF2_ITER:PBKDF2_ITER,
      FALLBACK_ROUNDS:FALLBACK_ROUNDS,MAX_FAILS:MAX_FAILS,
      BASE_LOCK_MS:BASE_LOCK_MS,MAX_LOCK_MS:MAX_LOCK_MS,SESSION_TTL_MS:SESSION_TTL_MS
    },
    KEYS:{CRED:CRED_KEY,FAIL:FAIL_KEY,SESS:SESS_KEY},
    _int:{
      sha256Bytes:sha256Bytes,toHex:toHex,fromHex:fromHex,safeEqual:safeEqual,
      derive:derive,deriveFallbackHex:deriveFallbackHex,pbkdf2Hex:pbkdf2Hex,
      hasSubtle:hasSubtle,makeCred:makeCred,randBytes:randBytes,lockMsFor:lockMsFor
    }
  };
})();
