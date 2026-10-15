"use strict";
/* =========================================================
   МОДУЛЬ A. ФОТО-ФАБРИКА (заглушки, локальные папки)
   ========================================================= */
var IMG_DIR = "img/";
var IMG_EXTS = [".jpg",".jpeg",".png",".webp"];
var MAX_PHOTOS = 8;
var PH = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='%236E6D55'/><path d='M32 15C29 21 22 21 20 16C18 25 24 33 32 33C40 33 46 25 44 16C42 21 35 21 32 15Z' fill='%23F4F2EA'/><path d='M31 33h2v13h-2z' fill='%237C8F6F'/><path d='M31 45C24 43 20 38 20 33C26 35 30 39 31 43Z' fill='%238A9B7C'/><path d='M33 43C34 39 38 35 44 33C44 38 40 43 33 45Z' fill='%238A9B7C'/></svg>";
var PHOTOS = {};
function ph(el){el.onerror=null;el.src=PH;}
function nex(el,id,n){
  var i=(+el.dataset.e||0)+1;
  if(i<IMG_EXTS.length){el.dataset.e=i;el.src=IMG_DIR+id+"/"+n+IMG_EXTS[i];}
  else{ph(el);}
}
function firstSrc(id,n){return IMG_DIR+id+"/"+n+IMG_EXTS[0];}
/* Режим серверной CMS: все фото приходят из БД (загружены через панель),
   папки img/ на сервере нет — probing только жёг бы лимиты функций
   (на Netlify free каждый запрос /img/* — вызов функции). */
function dfPhotosFromServer(){
  return typeof dfServerMode==="function"&&dfServerMode();
}
function loadPhotos(id,cb){
  if(dfPhotosFromServer()){cb([]);return;}
  if(PHOTOS[id]){cb(PHOTOS[id]);return;}
  var found=[];
  function tryNum(num){
    if(num>MAX_PHOTOS){finish();return;}
    var exts=IMG_EXTS.slice();
    (function tryExt(){
      if(!exts.length){finish();return;}
      var ext=exts.shift();
      var url=IMG_DIR+id+"/"+num+ext;
      var im=new Image();
      im.onload=function(){found.push(url);tryNum(num+1);};
      im.onerror=function(){tryExt();};
      im.src=url;
    })();
  }
  function finish(){PHOTOS[id]=found;cb(found);}
  tryNum(1);
}

/* Глобальный обработчик ошибок загрузки изображений.
   Заменяет inline-атрибуты onerror= (они запрещены строгой CSP).
   Событие error на <img> не всплывает, но ловится в capture-фазе. */
document.addEventListener("error",function(e){
  var el=e.target;
  if(!el||el.tagName!=="IMG")return;
  var fb=el.getAttribute?el.getAttribute("data-imgfallback"):null;
  if(!fb||el.dataset.fbdone)return;
  if(fb.indexOf("nex:")===0){
    var parts=fb.split(":");
    nex(el,parts[1],parseInt(parts[2],10)||1);
  }else{
    el.dataset.fbdone="1";
    ph(el);
  }
},true);