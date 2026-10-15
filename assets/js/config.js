"use strict";
if(window.ScrollTrigger){gsap.registerPlugin(ScrollTrigger);}
var VK_MSG = "https://vk.me/dubravin.flowers";
var VK_URL = "https://vk.ru/dubravin.flowers";
var IG_URL = "https://www.instagram.com/dubravin.flowers?igsh=YjFhaWdyNWRmMmlr";

/* CDN-fallback: если библиотеки анимаций не загрузились (блокировщик,
   офлайн), подставляем no-op реализацию — витрина остаётся полностью
   работоспособной, просто без анимаций. */
if(typeof window.gsap==="undefined"||!window.gsap||typeof window.gsap.to!=="function"){
  (function(){
    var chain={
      to:function(){return chain;},from:function(){return chain;},fromTo:function(){return chain;},
      set:function(){return chain;},call:function(){return chain;},add:function(){return chain;},
      eventCallback:function(){return chain;},progress:function(){return chain;},kill:function(){return chain;},
      then:function(r){if(typeof r==="function")r();return Promise.resolve();}
    };
    function fire(args){
      var t=args[0],v=args[args.length-1],i;
      /* мгновенно «докручиваем» tween-ы простых объектов (счётчики) */
      if(t&&typeof t==="object"&&t.nodeType===undefined&&t.window===undefined&&v&&typeof v==="object"){
        for(var k in v){
          if(typeof v[k]==="number"&&typeof t[k]==="number")t[k]=v[k];
        }
      }
      for(i=0;i<args.length;i++){
        var cb=args[i];
        if(cb&&typeof cb==="object"){
          if(typeof cb.onStart==="function"){try{cb.onStart();}catch(e){}}
          if(typeof cb.onUpdate==="function"){try{cb.onUpdate();}catch(e){}}
          if(typeof cb.onComplete==="function"){try{cb.onComplete();}catch(e){}}
        }
      }
    }
    window.gsap={
      registerPlugin:function(){},
      to:function(){fire(arguments);return chain;},
      from:function(){fire(arguments);return chain;},
      fromTo:function(){fire(arguments);return chain;},
      set:function(){},
      timeline:function(){return chain;},
      delayedCall:function(fn){if(typeof fn==="function"){try{fn();}catch(e){}}return chain;},
      getProperty:function(){return 0;},
      ticker:{add:function(){},remove:function(){},lagSmoothing:function(){}},
      config:function(){},defaults:function(){},
      utils:{toArray:function(x){return Array.prototype.slice.call(x||[]);}}
    };
  })();
}
