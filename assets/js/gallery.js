"use strict";
/* =========================================================
   МОДУЛЬ F. ГАЛЕРЕЯ + РАСПОЛОЖЕНИЕ МИНИАТЮР
   ========================================================= */
function placeThumbs(){
  var th=document.getElementById("galThumbs");
  var info=document.querySelector(".prod-info");
  var left=document.querySelector(".prod-left");
  if(!th||!info||!left)return;
  if(matchMedia("(max-width:991.98px)").matches){
    if(th.parentElement!==left){left.appendChild(th);}
  }else{
    if(th.parentElement!==info){info.appendChild(th);}
  }
}
var mqThumbs=matchMedia("(max-width:991.98px)");
if(mqThumbs.addEventListener){mqThumbs.addEventListener("change",placeThumbs);}
else if(mqThumbs.addListener){mqThumbs.addListener(placeThumbs);}
function initGallery(id){
  var p=prodById(id);
  var main=document.getElementById("galMain");
  var thumbs=document.getElementById("galThumbs");
  var count=document.getElementById("galCount");
  var media=document.getElementById("prodMedia");
  var prev=document.getElementById("galPrev");
  var next=document.getElementById("galNext");
  if(!main||!p)return;
  placeThumbs();
  var urls=null,idx=0;
  function show(i){
    if(!urls||!urls.length)return;
    idx=(i+urls.length)%urls.length;
    main.onerror=null;
    gsap.fromTo(main,{opacity:.35,scale:1.03},{opacity:1,scale:1,duration:.55,ease:"power2.out"});
    main.src=urls[idx];
    count.textContent=(idx+1)+" / "+urls.length;
    thumbs.querySelectorAll("button").forEach(function(b,bi){b.classList.toggle("on",bi===idx);});
  }
  function build(found){
    urls=found;
    if(!urls.length){main.src=PH;media.classList.add("solo");return;}
    if(urls.length<2){media.classList.add("solo");thumbs.style.display="none";show(0);return;}
    media.classList.remove("solo");
    thumbs.innerHTML=urls.map(function(u,i){
      return '<button data-i="'+i+'" aria-label="Фото '+(i+1)+'"><img src="'+esc(safeUrl(u))+'" alt="" loading="lazy" data-imgfallback="ph"></button>';
    }).join("");
    thumbs.querySelectorAll("button").forEach(function(b){
      b.addEventListener("click",function(){show(+b.dataset.i);});
    });
    show(0);
  }
  if(p.imgs&&p.imgs.length){build(p.imgs.slice().map(imgUrl));}
  else{loadPhotos(id,build);}
  prev.addEventListener("click",function(){show(idx-1);});
  next.addEventListener("click",function(){show(idx+1);});
  var sx=null;
  media.addEventListener("touchstart",function(e){sx=e.touches[0].clientX;},{passive:true});
  media.addEventListener("touchend",function(e){
    if(sx===null)return;
    var dx=e.changedTouches[0].clientX-sx;
    if(Math.abs(dx)>40)show(idx+(dx<0?1:-1));
    sx=null;
  },{passive:true});
  document.addEventListener("keydown",function galKey(e){
    if(!document.body.contains(media)){document.removeEventListener("keydown",galKey);return;}
    if(e.key==="ArrowLeft")show(idx-1);
    if(e.key==="ArrowRight")show(idx+1);
  });
}
