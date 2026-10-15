"use strict";
/* =========================================================
   МОДУЛЬ H. РОУТЕР (History API — чистые адреса без «#»)
   Маршруты: /, /catalog, /catalog/<подборка>, /product/<id>,
   /delivery, /contacts, /privacy, /terms.
   • Прямые заходы и перезагрузка работают: Netlify отдаёт
     index.html по правилу «/* /index.html 200» (_redirects),
     backend/server/server.js — своим SPA-фолбэком.
   • Старые ссылки вида /#/catalog автоматически и без
     перезагрузки превращаются в /catalog.
   • При открытии файлов с диска (file://) History API
     недоступен — роутер сам откатывается на хэш-режим.
   ========================================================= */
var app = document.getElementById("app");
var SPA_MODE=(location.protocol==="http:"||location.protocol==="https:");

/* Текущий маршрут: хэш имеет приоритет (старые ссылки), иначе pathname */
function currentPath(){
  var h=location.hash||"";
  if(h.indexOf("#/")===0)return "/"+h.slice(2);
  var p=location.pathname||"/";
  if(p.charAt(0)!=="/")p="/"+p;
  return p;
}
function parseRoute(){
  var path=currentPath().replace(/^\/+/,"").replace(/\/+$/,"");
  var parts=path.split("/").filter(Boolean);
  if(!parts.length) return {page:"home"};
  if(parts[0]==="catalog") return {page:"catalog",cat:parts[1]||"all"};
  if(parts[0]==="product") return {page:"product",id:parts[1]};
  if(parts[0]==="delivery") return {page:"delivery"};
  if(parts[0]==="contacts") return {page:"contacts"};
  if(parts[0]==="privacy") return {page:"privacy"};
  if(parts[0]==="terms") return {page:"terms"};
  return {page:"404"};
}
var TITLES={
  home:"DUBRAVIN&FLOWERS — цветочный магазин в Кирове | Доставка 24/7",
  catalog:"Каталог — DUBRAVIN&FLOWERS",
  delivery:"Доставка — DUBRAVIN&FLOWERS",
  contacts:"Контакты — DUBRAVIN&FLOWERS",
  privacy:"Политика конфиденциальности — DUBRAVIN&FLOWERS",
  terms:"Пользовательское соглашение — DUBRAVIN&FLOWERS",
  "404":"Страница не найдена — DUBRAVIN&FLOWERS"
};
function setTitle(r){
  if(r.page==="product"){
    var pr=prodById(r.id);
    document.title=pr?(pr.name+" — DUBRAVIN&FLOWERS"):TITLES["404"];
    return;
  }
  if(r.page==="catalog"&&r.cat&&r.cat!=="all"){
    var c=(DB.collections||[]).filter(function(x){return x.id===r.cat;})[0];
    if(c){document.title=c.name+" — Каталог — DUBRAVIN&FLOWERS";return;}
  }
  document.title=TITLES[r.page]||TITLES.home;
}
function renderRoute(){
  var r=parseRoute();
  if(window.ScrollTrigger){ScrollTrigger.getAll().forEach(function(t){t.kill();});}
  if(r.page==="home"){app.innerHTML=tplHome();}
  else if(r.page==="catalog"){app.innerHTML=tplCatalog(r.cat);}
  else if(r.page==="product"){
    app.innerHTML=tplProduct(r.id);
    var pr=prodById(r.id);
    setTitle(pr?r:{page:"404"});
    postRender(pr?r:{page:"404"});
    initGallery(r.id);
    enrichCards(app);
    return;
  }
  else if(r.page==="delivery"){app.innerHTML=tplDelivery();}
  else if(r.page==="contacts"){app.innerHTML=tplContacts();}
  else if(r.page==="privacy"){app.innerHTML=tplPrivacy();}
  else if(r.page==="terms"){app.innerHTML=tplTerms();}
  else {app.innerHTML=tpl404();}
  setTitle(r);
  postRender(r);
  enrichCards(app);
}
function postRender(r){
  document.querySelectorAll("#nav a").forEach(function(a){
    a.classList.toggle("active",a.dataset.route===r.page||(r.page==="product"&&a.dataset.route==="catalog")||(r.page==="catalog"&&a.dataset.route==="catalog"));
  });
  headScroll();
  if(lenis){lenis.scrollTo(0,{immediate:true});}else{window.scrollTo(0,0);}
  bindCatalogChips();
  bindMoreButton();
  initMarquees(app);
  bindHeroParallax();
  bindCtaParallax();
  animatePage();
  bindTilt();
  bindMagnetic();
  requestAnimationFrame(function(){moveChipMarker(true);});
  setTimeout(function(){moveChipMarker(true);},350);
}
/* Навигация без перезагрузки страницы.
   path — «/catalog/mono» (старый формат «#/…» тоже принимается).
   opts.replace — не создавать запись истории (для чипов каталога не нужно,
   они push-ат сами; replace используется служебно). */
function navigateTo(path,opts){
  path=String(path||"/");
  if(path.charAt(0)==="#")path="/"+path.replace(/^#\/?/,"");
  if(path.charAt(0)!=="/")path="/"+path;
  if(!SPA_MODE){
    try{location.hash="#"+path;}catch(e){}
    return;
  }
  var cur=currentPath();
  if(cur===path&&!(opts&&opts.force)){renderRoute();return;}
  try{
    if(opts&&opts.replace)history.replaceState({df:1},"",path);
    else history.pushState({df:1},"",path);
  }catch(e){
    try{location.hash="#"+path;}catch(e2){}
    return;
  }
  closeMenu();
  renderRoute();
}
/* Синхронизация адресной строки без перехода (чипсы каталога):
   новая запись истории, страница не перерисовывается — фильтр
   уже применён анимацией на месте. */
function syncUrl(path){
  if(!SPA_MODE)return;
  path=String(path||"/");
  if(currentPath()===path)return;
  try{history.pushState({df:1},"",path);}catch(e){}
}
function onPopState(){
  closeMenu();
  renderRoute();
}
window.addEventListener("popstate",onPopState);
/* Старые хэш-ссылки (/#/catalog): превращаем в чистый адрес и рендерим */
window.addEventListener("hashchange",function(){
  var h=location.hash||"";
  if(h && h.indexOf("#/")!==0)return;
  if(SPA_MODE){
    try{history.replaceState({df:1},"","/"+h.slice(2));}catch(e){}
  }
  closeMenu();
  renderRoute();
});
/* При первом открытии старой ссылки вида /#/… — сразу чистый адрес */
(function normalizeInitialHash(){
  if(!SPA_MODE)return;
  var h=location.hash||"";
  if(h.indexOf("#/")===0){
    var target=(h.length>2)?"/"+h.slice(2):(location.pathname||"/");
    try{history.replaceState({df:1},"",target);}catch(e){}
  }
})();
window.addEventListener("resize",function(){moveChipMarker(true);});
