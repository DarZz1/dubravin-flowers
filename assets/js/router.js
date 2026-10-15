"use strict";
/* =========================================================
   МОДУЛЬ H. РОУТЕР (без прелоадеров и шторок)
   ========================================================= */
var app = document.getElementById("app");
function parseRoute(){
  var h=(location.hash||"#/").replace(/^#\//,"");
  var parts=h.split("/").filter(Boolean);
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
function renderRoute(){
  var r=parseRoute();
  if(window.ScrollTrigger){ScrollTrigger.getAll().forEach(function(t){t.kill();});}
  if(r.page==="home"){app.innerHTML=tplHome();}
  else if(r.page==="catalog"){app.innerHTML=tplCatalog(r.cat);}
  else if(r.page==="product"){
    app.innerHTML=tplProduct(r.id);
    var pr=prodById(r.id);
    document.title=pr?(pr.name+" — DUBRAVIN&FLOWERS"):TITLES["404"];
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
  document.title=TITLES[r.page]||TITLES.home;
  postRender(r);
  enrichCards(app);
}
function postRender(r){
  document.querySelectorAll("#nav a").forEach(function(a){
    a.classList.toggle("active",a.dataset.route===r.page||(r.page==="product"&&a.dataset.route==="catalog"));
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
function navigateTo(h){
  var cur=location.hash||"";
  if(cur===h||(cur===""&&h==="#/")){onHashChange();}
  else{location.hash=h;}
}
function onHashChange(){
  var h=location.hash||"";
  if(h && h.indexOf("#/")!==0) return;
  closeMenu();
  renderRoute();
}
window.addEventListener("hashchange",onHashChange);
window.addEventListener("resize",function(){moveChipMarker(true);});
