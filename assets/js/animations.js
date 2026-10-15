"use strict";
/* =========================================================
   МОДУЛЬ I. АНИМАЦИИ
   ========================================================= */
function splitWords(el){
  if(el.dataset.splitDone) return;
  var blurMode = el.dataset.split==="blur";
  var words=el.textContent.trim().split(/\s+/);
  if(blurMode){el.innerHTML=words.map(function(w){return '<span class="w2"><span class="wi2">'+w+'</span></span>';}).join(" ");}
  else{el.innerHTML=words.map(function(w){return '<span class="w"><span class="wi">'+w+'</span></span>';}).join(" ");}
  el.dataset.splitDone="1";
}
function runProductIntro(scope){
  var media=scope.querySelector("#prodMedia");
  var info=scope.querySelectorAll(".prod-info > *, .prod > .crumbs-mobile");
  if(!media||!info.length)return;
  gsap.set(media,{opacity:0,scale:.94,clipPath:"inset(10% 10% 10% 10% round 30px)"});
  gsap.set(info,{opacity:0,y:22});
  gsap.timeline({defaults:{ease:"power3.out"}})
    .to(media,{opacity:1,scale:1,clipPath:"inset(0% 0% 0% 0% round 30px)",duration:.6},.15)
    .to(info,{opacity:1,y:0,duration:.45,stagger:.08},.27);
}
function runSimReveal(scope){
  var sim=scope.querySelector("#simGrid");
  if(!sim||!window.ScrollTrigger)return;
  gsap.from(sim.children,{y:34,opacity:0,scale:.97,duration:.5,stagger:.09,ease:"power3.out",scrollTrigger:{trigger:sim,start:"top 90%",once:true}});
}
function animatePage(){
  var scope=app;
  scope.querySelectorAll("[data-split]").forEach(splitWords);
  var fades=scope.querySelectorAll("[data-anim='fade']");
  var drops=scope.querySelectorAll("[data-anim='drop']");
  var medias=scope.querySelectorAll("[data-anim='media']");
  var heroWords=scope.querySelectorAll(".hero h1 .wi2");
  var immWords=scope.querySelectorAll(".page-head [data-split] .wi,.del-sticky [data-split] .wi");
  gsap.set(fades,{opacity:0,y:26});
  gsap.set(drops,{opacity:0,y:-10});
  gsap.set(medias,{opacity:0,scale:.94});
  gsap.set(immWords,{yPercent:130});
  gsap.set(heroWords,{opacity:0,y:14,filter:"blur(10px)"});
  gsap.timeline({defaults:{ease:"power3.out"},delay:0.1})
    .to(heroWords,{opacity:1,y:0,filter:"blur(0px)",duration:.55,stagger:.035,ease:"power3.out"},0)
    .to(immWords,{yPercent:0,duration:1.2,stagger:.05,ease:"power4.out"},0)
    .to(drops,{opacity:1,y:0,duration:.35,stagger:.1,ease:"power2.out"},0)
    .to(fades,{opacity:1,y:0,duration:.6,stagger:.12,ease:"power2.out"},.25)
    .to(medias,{opacity:1,scale:1,duration:1.3,ease:"power3.out"},.25);
  if(scope.querySelector(".prod"))runProductIntro(scope);
  runSimReveal(scope);
  prepReveals(scope);
}
