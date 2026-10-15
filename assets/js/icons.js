"use strict";
/* =========================================================
   МОДУЛЬ C. ИКОНКИ
   ========================================================= */
var IC = {
  vk:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.785 16.222c-5.33 0-8.385-3.644-8.513-9.71h2.68c.086 4.452 2.05 6.342 3.606 6.73V6.51h2.52v3.857c1.537-.165 3.152-1.91 3.696-3.856h2.52c-.418 2.392-2.178 4.137-3.412 4.86 1.234.578 3.217 2.107 3.974 4.85h-2.78c-.59-1.843-2.06-3.27-3.997-3.463v3.463h-.294z"/></svg>',
  ig:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none"/></svg>',
  arrow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  arrowSm:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  arrowUp:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  chevL:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 5l-7 7 7 7"/></svg>',
  chevR:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 5l7 7-7 7"/></svg>',
  truck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 7h13v10H1zM14 10h5l4 4v3h-9z"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="18" cy="17.5" r="1.8"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  leaf:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21C7 16 4 12 4 8.5C4 5 7 3 12 3s8 2 8 5.5c0 3.5-3 7.5-8 12.5z"/><path d="M12 3v18"/></svg>',
  tag:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 12l-8.5 8.5a2 2 0 01-2.8 0L3 14.8V3h11.8L20 8.2a2.6 2.6 0 010 3.8z"/><circle cx="8" cy="8" r="1.6"/></svg>',
  pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-6.1 7-11a7 7 0 10-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 3h4l2 5-2.5 1.5a12 12 0 006 6L16 13l5 2v4a2 2 0 01-2 2A17 17 0 013 5a2 2 0 012-2z"/></svg>',
  scissors:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8.2 7.6L20 18M8.2 16.4L20 6"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12.5l5 5L20 6.5"/></svg>'
};
function arrowSpan(){return '<span class="btn-arrow" aria-hidden="true">'+IC.arrow+IC.arrow+'</span>';}
function vkSpan(){return '<span class="vk-ic">'+IC.vk+'</span>';}
function socArrow(){return '<span class="soc-arrow" aria-hidden="true">'+IC.arrowSm+IC.arrowSm+'</span>';}
var IC_DIAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
