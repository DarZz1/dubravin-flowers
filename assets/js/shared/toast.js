"use strict";
/* =========================================================
   МОДУЛЬ K. СЕРВИС
   ========================================================= */
var toastTimer=null;
function showToast(msg){
  var t=document.getElementById("toast");
  t.innerHTML=IC.check+"<span>"+esc(msg)+"</span>";
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){t.classList.remove("show");},4200);
}
function copyText(txt){
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).catch(function(){fallbackCopy(txt);});}
  else fallbackCopy(txt);
}
function fallbackCopy(txt){
  var ta=document.createElement("textarea");ta.value=txt;ta.style.position="fixed";ta.style.opacity="0";
  document.body.appendChild(ta);ta.select();try{document.execCommand("copy");}catch(e){}document.body.removeChild(ta);
}
