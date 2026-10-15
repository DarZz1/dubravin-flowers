"use strict";
/* =========================================================
   МОДУЛЬ G. SCROLL-REVEAL (IO)
   ========================================================= */
var stateIO=null;
function runCounter(el){
  if(el.dataset.counted)return;
  el.dataset.counted="1";
  var target=+el.dataset.count,obj={v:0};
  gsap.to(obj,{v:target,duration:2,ease:"power2.out",onUpdate:function(){el.textContent=Math.round(obj.v).toLocaleString("ru-RU");}});
}
function prepReveals(scope){
  if(stateIO){stateIO.disconnect();stateIO=null;}
  var rv=scope.querySelectorAll("[data-reveal]");
  var st=scope.querySelectorAll("[data-stagger]");
  var tt=scope.querySelectorAll(".sec-title[data-split]");
  var ct=scope.querySelectorAll("[data-count]");
  if(!("IntersectionObserver" in window)){
    rv.forEach(function(el){el.classList.add("rv-in");});
    st.forEach(function(g){g.classList.add("rv-in");popBadges(g.children);});
    tt.forEach(function(t){t.classList.add("rv-in");});
    ct.forEach(function(el){el.textContent=(+el.dataset.count).toLocaleString("ru-RU");});
    return;
  }
  stateIO=new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if(!en.isIntersecting)return;
      var el=en.target;
      el.classList.add("rv-in");
      if(el.hasAttribute("data-count"))runCounter(el);
      if(el.classList.contains("rv-stagger"))popBadges(el.children);
      stateIO.unobserve(el);
    });
  },{threshold:0.12,rootMargin:"0px 0px -6% 0px"});
  rv.forEach(function(el){
    var t=el.dataset.reveal;
    el.classList.add("rv");
    if(t==="left")el.classList.add("rv-left");
    if(t==="right")el.classList.add("rv-right");
    if(t==="scale")el.classList.add("rv-scale");
    stateIO.observe(el);
  });
  st.forEach(function(g){
    g.classList.add("rv-stagger");
    Array.prototype.forEach.call(g.children,function(c,i){c.style.transitionDelay=(i*0.1)+"s";});
    stateIO.observe(g);
  });
  tt.forEach(function(t){
    t.classList.add("rv-title");
    t.querySelectorAll(".wi").forEach(function(w,i){w.style.transitionDelay=(i*0.045)+"s";});
    stateIO.observe(t);
  });
  ct.forEach(function(el){stateIO.observe(el);});
}
