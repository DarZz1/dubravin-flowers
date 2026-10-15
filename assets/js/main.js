"use strict";
/* =========================================================
   МОДУЛЬ L. СТАРТ
   ========================================================= */
/* Прелоадер: гасим после первой отрисовки маршрута. Страховочный
   таймаут — чтобы оверлей не мог остаться на экране, если что-то
   пойдёт не так (дополнительно к CSS-страховке в 01-preloader.css). */
var DF_PRELOADER_MAX_MS=6000;
function hidePreloader(){
  var p=document.getElementById("preloader");
  if(!p||p.classList.contains("done"))return;
  p.classList.add("done");
  setTimeout(function(){if(p.parentNode)p.parentNode.removeChild(p);},700);
}
setTimeout(hidePreloader,DF_PRELOADER_MAX_MS);
function boot(){
  if(location.hash && location.hash.indexOf("#/")!==0){
    try{history.replaceState(null,"","#/");}catch(e){location.hash="#/";}
  }
  document.getElementById("year").textContent=new Date().getFullYear();
  dbInit(function(){
    renderRoute();
    headScroll();
    bindMagnetic();
    initMarquees(app);
    scheduleCookie();
    /* первый экран в DOM — убираем оверлей на следующем кадре,
       чтобы пользователь не увидел мигание пустой витрины */
    requestAnimationFrame(function(){requestAnimationFrame(hidePreloader);});
    if(document.fonts&&document.fonts.ready){
      document.fonts.ready.then(function(){moveChipMarker(true);});
    }
  });
}
/* Живое обновление витрины: когда в соседней вкладке (/admin) сохраняют
   изменения, событие storage приходит во все остальные вкладки сайта. */
window.addEventListener("storage",function(e){
  if(e.key!==CMS_KEY||!e.newValue)return;
  try{
    var parsed=JSON.parse(e.newValue);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return;
    if(!Array.isArray(parsed.products)||!Array.isArray(parsed.collections))return;
    var fresh=sanitizeDB(parsed);
    if(!fresh)return;
    DB=fresh;
    renderRoute();
    showToast("Контент обновлён из панели управления");
  }catch(err){}
});
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
