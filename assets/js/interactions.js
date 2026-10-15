"use strict";
/* =========================================================
   МОДУЛЬ J. МИКРО-ВЗАИМОДЕЙСТВИЯ
   ========================================================= */
function bindHeroParallax(){
  var media=document.getElementById("heroMedia");
  var img=document.getElementById("heroImg");
  if(!media||!img||!matchMedia("(pointer:fine)").matches)return;
  gsap.set(img,{scale:1.1});
  media.addEventListener("mousemove",function(e){
    var r=media.getBoundingClientRect();
    var px=(e.clientX-r.left)/r.width-.5, py=(e.clientY-r.top)/r.height-.5;
    gsap.to(img,{x:px*36,y:py*36,duration:.7,ease:"power2.out",overwrite:"auto"});
  });
  media.addEventListener("mouseleave",function(){
    gsap.to(img,{x:0,y:0,duration:1,ease:"elastic.out(1,.6)",overwrite:"auto"});
  });
}
function bindCtaParallax(){
  document.querySelectorAll(".cta-banner").forEach(function(bn){
    if(bn.dataset.ctaBound)return;
    bn.dataset.ctaBound="1";
    var els=bn.querySelectorAll("[data-cta]");
    if(!els.length||!matchMedia("(pointer:fine)").matches)return;
    bn.addEventListener("mousemove",function(e){
      var r=bn.getBoundingClientRect();
      var px=(e.clientX-r.left)/r.width-.5, py=(e.clientY-r.top)/r.height-.5;
      els.forEach(function(el){
        var d=parseFloat(el.dataset.cta)||1;
        gsap.to(el,{x:-px*12*d,y:-py*8*d,duration:.5,ease:"power2.out",overwrite:"auto"});
      });
    });
    bn.addEventListener("mouseleave",function(){
      els.forEach(function(el){gsap.to(el,{x:0,y:0,duration:.7,ease:"elastic.out(1,.6)",overwrite:"auto"});});
    });
  });
}
function initMarquees(scope){
  (scope||document).querySelectorAll(".mq-track").forEach(function(tr){
    if(tr.dataset.mqBound)return;
    if(!tr.getAnimations)return;
    tr.dataset.mqBound="1";
    var anims=tr.getAnimations();
    if(!anims.length)return;
    var target=1,cur=1;
    var box=tr.parentElement;
    box.addEventListener("mouseenter",function(){target=0.33;});
    box.addEventListener("mouseleave",function(){target=1;});
    (function tick(){
      if(!document.body.contains(tr))return;
      cur+=(target-cur)*0.055;
      anims.forEach(function(a){a.playbackRate=cur;});
      requestAnimationFrame(tick);
    })();
  });
}
function bindTilt(){
  if(!matchMedia("(pointer:fine)").matches)return;
  document.querySelectorAll(".tilt").forEach(function(card){
    if(card.dataset.tiltBound)return;card.dataset.tiltBound="1";
    var img=card.querySelector(".pcard-media img");
    card.addEventListener("mousemove",function(e){
      var r=card.getBoundingClientRect();
      var px=(e.clientX-r.left)/r.width-.5,py=(e.clientY-r.top)/r.height-.5;
      gsap.to(card,{y:-6,scale:1.02,rotateY:px*7,rotateX:-py*7,transformPerspective:800,duration:.45,ease:"power2.out",overwrite:"auto"});
      if(img)gsap.to(img,{x:px*10,y:py*10,scale:1.04,duration:.45,ease:"power2.out",overwrite:"auto"});
    });
    card.addEventListener("mouseleave",function(){
      gsap.to(card,{y:0,scale:1,rotateY:0,rotateX:0,duration:.6,ease:"elastic.out(1,.5)",overwrite:"auto"});
      if(img)gsap.to(img,{x:0,y:0,scale:1,duration:.6,ease:"power2.out",overwrite:"auto"});
    });
  });
}
function bindMagnetic(){
  if(!matchMedia("(pointer:fine)").matches)return;
  document.querySelectorAll("[data-magnetic]").forEach(function(el){
    if(el.dataset.magBound)return;el.dataset.magBound="1";
    el.addEventListener("mousemove",function(e){
      var r=el.getBoundingClientRect();
      gsap.to(el,{x:(e.clientX-r.left-r.width/2)*.22,y:(e.clientY-r.top-r.height/2)*.32,duration:.6,ease:"power2.out"});
    });
    el.addEventListener("mouseleave",function(){gsap.to(el,{x:0,y:0,duration:.9,ease:"elastic.out(1,.4)"});});
  });
}
