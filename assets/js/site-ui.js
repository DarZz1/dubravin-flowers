"use strict";
/* =========================================================
   МОДУЛЬ K2. СЕРВИС: ЗАКАЗ В VK, МЕНЮ, ХЕДЕР, ТЕМА, COOKIE,
   КУРСОР, ПЛАВНЫЙ СКРОЛЛ
   ========================================================= */
function orderVK(name){
  if(name){copyText(name);showToast("Название «"+name+"» скопировано — вставьте его в сообщение сообществу VK");}
  else{showToast("Открываем сообщения сообщества VK…");}
  window.open(VK_MSG,"_blank","noopener");
}
document.addEventListener("click",function(e){
  var ord=e.target.closest("[data-order]");
  if(ord){e.preventDefault();e.stopPropagation();orderVK(ord.dataset.order);return;}
  var sc=e.target.closest("[data-scroll]");
  if(sc){
    var el=document.getElementById(sc.dataset.scroll);
    if(el){
      if(!lenis){el.scrollIntoView({behavior:"smooth",block:"start"});}
      else{lenis.scrollTo(el,{offset:-100});}
    }
    return;
  }
  if(e.target.closest("a[href^='http']"))return;
  /* Внутренние ссылки витрины: чистые пути (/catalog) и старый формат (#/catalog) */
  var a=e.target.closest("a[href^='#/'],a[href^='/']");
  if(a){
    if(e.metaKey||e.ctrlKey||e.shiftKey||e.button!==0)return;
    var href=a.getAttribute("href")||"";
    if(href.indexOf("//")===0)return;   /* protocol-relative — не трогаем */
    e.preventDefault();navigateTo(href);return;
  }
  var card=e.target.closest(".pcard");
  if(card){navigateTo("/product/"+card.dataset.id);}
});
var burger=document.getElementById("burger");
var menuEl=document.getElementById("menu");
function closeMenu(){
  document.body.classList.remove("menu-open");
  document.body.classList.remove("locked");
  burger.setAttribute("aria-expanded","false");
  menuEl.setAttribute("aria-hidden","true");
}
burger.addEventListener("click",function(){
  var open=!document.body.classList.contains("menu-open");
  document.body.classList.toggle("menu-open",open);
  document.body.classList.toggle("locked",open);
  burger.setAttribute("aria-expanded",open?"true":"false");
  menuEl.setAttribute("aria-hidden",open?"false":"true");
  if(open){
    gsap.fromTo("#menu .m-link",{opacity:0,y:34},{opacity:1,y:0,duration:.8,stagger:.09,ease:"power3.out",delay:.18});
    gsap.fromTo("#menu .m-theme-toggle",{opacity:0,y:20},{opacity:1,y:0,duration:.8,delay:.5});
    gsap.fromTo("#menu .m-foot",{opacity:0,y:20},{opacity:1,y:0,duration:.8,delay:.6});
  }
});
document.addEventListener("keydown",function(e){if(e.key==="Escape")closeMenu();});
window.addEventListener("resize",function(){if(innerWidth>992)closeMenu();});
var header=document.getElementById("header");
function headScroll(){header.classList.toggle("scrolled",(window.scrollY||0)>30);}
window.addEventListener("scroll",headScroll,{passive:true});
var metaTheme=document.getElementById("metaTheme");
function syncThemeUI(){
  var t=document.documentElement.dataset.theme;
  var lbl=document.getElementById("menuThemeLabel");
  if(lbl)lbl.textContent=(t==="dark"?"Тёмная тема":"Светлая тема");
}
function applyTheme(t){
  document.documentElement.dataset.theme=t;
  try{localStorage.setItem("df-theme",t);}catch(e){}
  metaTheme.setAttribute("content",t==="dark"?"#0A1710":"#F6F1E8");
  syncThemeUI();
}
function toggleTheme(btn){
  var next=document.documentElement.dataset.theme==="dark"?"light":"dark";
  applyTheme(next);
  if(btn)gsap.fromTo(btn,{rotate:-90,scale:.7},{rotate:0,scale:1,duration:.7,ease:"elastic.out(1,.5)"});
  showToast(next==="dark"?"Включена тёмная тема 🌙":"Включена светлая тема ☀️");
}
document.getElementById("themeToggle").addEventListener("click",function(){toggleTheme(this);});
document.getElementById("menuTheme").addEventListener("click",function(){toggleTheme(null);});
applyTheme(document.documentElement.dataset.theme==="dark"?"dark":"light");
var cookieEl=document.getElementById("cookie");
var cookieScheduled=false;
function scheduleCookie(){
  if(cookieScheduled)return;
  cookieScheduled=true;
  var consent=null;try{consent=localStorage.getItem("df-cookie");}catch(e){}
  if(consent)return;
  setTimeout(function(){cookieEl.classList.add("show");document.body.classList.add("ck-on");},1400);
}
function hideCookie(){cookieEl.classList.remove("show");document.body.classList.remove("ck-on");}
document.getElementById("cookieOk").addEventListener("click",function(){try{localStorage.setItem("df-cookie","all");}catch(e){}hideCookie();});
document.getElementById("cookieOff").addEventListener("click",function(){try{localStorage.setItem("df-cookie","needed");}catch(e){}hideCookie();});
if(matchMedia("(pointer:fine)").matches){
  var cur=document.getElementById("cur"),ring=document.getElementById("curRing");
  var mx=innerWidth/2,my=innerHeight/2,rx=mx,ry=my;
  var curOn=false;
  window.addEventListener("mousemove",function(e){
    mx=e.clientX;my=e.clientY;
    /* Кастомный курсор включается только после первого движения мыши:
       до этого (и на прелоадере) пользователю виден системный курсор. */
    if(!curOn){curOn=true;document.body.classList.add("cur-on");}
  });
  (function loop(){
    rx+=(mx-rx)*.16;ry+=(my-ry)*.16;
    cur.style.transform="translate("+mx+"px,"+my+"px) translate(-50%,-50%)";
    ring.style.transform="translate("+rx+"px,"+ry+"px) translate(-50%,-50%)";
    requestAnimationFrame(loop);
  })();
  document.addEventListener("mouseover",function(e){
    document.body.classList.toggle("cur-hover",!!e.target.closest("a,button,.pcard,.cat-tile,.chip"));
  });
}
var lenis=null;
try{
  lenis=new Lenis({duration:1.4,easing:function(t){return Math.min(1,1.001-Math.pow(2,-10*t));}});
  gsap.ticker.add(function(t){lenis.raf(t*1000);});
  gsap.ticker.lagSmoothing(0);
}catch(e){}
