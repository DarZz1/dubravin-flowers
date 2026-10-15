"use strict";
/* =========================================================
   МОДУЛЬ D. ШАБЛОНЫ САЙТА (читают DB)
   ========================================================= */
var PAGE_SIZE = 16;
function cardHTML(p){
  var cover=prodCover(p);
  var noImgs=!(p.imgs&&p.imgs.length);
  var badge=p.sale?'<span class="pcard-badge sale">Акция</span>':(p.hit?'<span class="pcard-badge">Хит</span>':'');
  return '<article class="pcard tilt" data-id="'+esc(p.id)+'">'+
    '<a class="pcard-media" href="#/product/'+esc(p.id)+'" aria-label="'+esc(p.name)+'">'+
      '<img loading="lazy" decoding="async" '+(noImgs?'data-photo="'+esc(p.id)+'" ':'')+'src="'+esc(safeUrl(cover))+'" alt="'+esc(p.name)+'" data-imgfallback="'+(noImgs?"nex:"+esc(p.id)+":1":"ph")+'">'+
      badge+
      ((p.imgs&&p.imgs.length>1)?'<span class="pcard-photos" style="display:block">📷 '+p.imgs.length+'</span>':'')+
    '</a>'+
    '<div class="pcard-body">'+
      '<a class="pcard-name" href="#/product/'+esc(p.id)+'">'+esc(p.name)+'</a>'+
      '<div class="pcard-price">'+(p.old?'<s>'+fmt(p.old)+'</s>':'')+fmt(p.price)+'</div>'+
      '<div class="pcard-cat">'+esc(colName((p.cols||[])[0]))+'</div>'+
      '<button class="btn-mini" data-magnetic data-order="'+esc(p.name)+'" aria-label="Заказать '+esc(p.name)+' в VK">'+IC.vk+'<span>Заказать</span></button>'+
    '</div></article>';
}
function enrichCards(scope){
  var ids={};
  scope.querySelectorAll("[data-photo]").forEach(function(im){ids[im.dataset.photo]=1;});
  Object.keys(ids).forEach(function(id){
    loadPhotos(id,function(urls){
      scope.querySelectorAll('[data-photo="'+id+'"]').forEach(function(im){
        if(urls.length){im.onerror=null;im.src=urls[0];}
      });
    });
  });
}
function popBadges(cards){
  Array.prototype.forEach.call(cards,function(c,i){
    if(!c.querySelector)return;
    if(c.querySelector(".pcard-badge")){
      setTimeout(function(){c.classList.add("badge-in");},140+i*70);
    }
  });
}
/* Подборки для главной: только отмеченные «На главной» (не больше MAIN_LIMIT).
   Если отметок нет вовсе (старые данные) — страховка: первые MAIN_LIMIT. */
function homeCollections(){
  var all=DB.collections||[];
  var marked=all.filter(function(c){return c.main;});
  return (marked.length?marked:all).slice(0,MAIN_LIMIT);
}
function tplHome(){
  var feat=(DB.products||[]).filter(function(p){return p.main;}).slice(0,MAIN_LIMIT);
  var heroImg=(DB.hero&&DB.hero.img)||((typeof dfServerMode==="function"&&dfServerMode())?PH:firstSrc("1",1));
  return ''+
  '<section class="hero"><div class="wrap"><div class="hero-card">'+
    '<div class="hero-in">'+
      '<div class="hero-left">'+
        '<span class="hero-eyebrow" data-anim="fade"><i class="dot"></i>Цветы · Шары · Киров · Доставка 24/7</span>'+
        '<h1 data-split="blur">Цветы, которые говорят вместо вас</h1>'+
        '<p class="hero-sub" data-anim="fade">Свежие букеты, гелиевые шары и композиции с доставкой по Кирову в любое время суток. Заказ — в один клик, прямо в сообщения нашего сообщества VK.</p>'+
        '<div class="hero-ctas" data-anim="fade">'+
          '<a class="btn pink" href="#/catalog" data-magnetic>Смотреть каталог '+arrowSpan()+'</a>'+
          '<button class="btn ghost" data-order="" data-magnetic>'+vkSpan()+'Написать в VK</button>'+
        '</div>'+
        '<div class="hero-stats" data-anim="fade">'+
          '<div class="hstat"><b><span data-count="'+(DB.products||[]).length+'">0</span></b><span>товаров в наличии на витрине</span></div>'+
          '<div class="hstat"><b><span data-count="24">0</span>/7</b><span>бесплатная доставка по Кирову</span></div>'+
          '<div class="hstat"><b><span data-count="5700">0</span>+</b><span>подписчиков в соцсетях магазина</span></div>'+
        '</div>'+
      '</div>'+
      '<div class="hero-media" data-anim="media" id="heroMedia">'+
        '<div class="hero-frame"><img id="heroImg" src="'+esc(safeUrl(heroImg))+'" alt="Dubravin&amp;Flowers" data-imgfallback="ph"></div>'+
        '<div class="hero-chip chip-1">'+IC.leaf+'Только свежие цветы</div>'+
        '<div class="hero-chip chip-2">'+IC.truck+'Доставим бесплатно за 1–2 часа</div>'+
      '</div>'+
    '</div>'+
  '</div></div></section>'+
  '<div class="marquee" aria-hidden="true"><div class="mq-track">'+
    '<span>Свежие цветы</span><span>Бесплатная доставка 24/7</span><span>Гелиевые шары от 69 ₽</span><span>Опт и розница</span><span>Соберём букет под ваш бюджет</span>'+
    '<span>Свежие цветы</span><span>Бесплатная доставка 24/7</span><span>Гелиевые шары от 69 ₽</span><span>Опт и розница</span><span>Соберём букет под ваш бюджет</span>'+
  '</div></div>'+
  '<section><div class="wrap">'+
    '<div class="sec-head"><h2 class="sec-title" data-split>Выберите настроение</h2>'+
    '<a class="sec-link" href="#/catalog">Весь каталог '+IC.arrowUp+'</a></div>'+
    '<div class="cats" data-stagger>'+homeCollections().map(function(c){var cv=colCover(c);return ''+
      '<a class="cat-tile" href="#/catalog/'+esc(c.id)+'"><img loading="lazy" decoding="async" src="'+esc(safeUrl(cv||PH))+'" alt="'+esc(c.name)+'" data-imgfallback="ph">'+
      '<span class="cat-label"><b>'+esc(c.name)+'</b><i>'+IC_DIAG+'</i></span></a>';}).join('')+'</div>'+
  '</div></section>'+
  (feat.length?
  '<section style="padding-top:8px"><div class="wrap">'+
    '<div class="sec-head"><h2 class="sec-title" data-split>Хиты этой недели</h2>'+
    '<a class="sec-link" href="#/catalog">Смотреть все '+IC.arrowUp+'</a></div>'+
    '<div class="pgrid" data-stagger>'+feat.map(cardHTML).join('')+'</div>'+
  '</div></section>':'')+
  '<div class="marquee pink" aria-hidden="true"><div class="mq-track">'+
    '<span>Про цветы с любовью</span><span>Dubravin&amp;Flowers</span><span>Киров</span><span>с 06:00 до 00:00</span>'+
    '<span>Про цветы с любовью</span><span>Dubravin&amp;Flowers</span><span>Киров</span><span>с 06:00 до 00:00</span>'+
  '</div></div>'+
  '<section><div class="wrap">'+
    '<div class="sec-head"><h2 class="sec-title" data-split>Почему нас любят</h2></div>'+
    '<div class="feats" data-stagger>'+
      '<div class="feat"><span class="f-num">01</span><span class="f-ic f-ic-1">'+IC.leaf+'</span><h3>Свежесть гарантируем</h3><p>Поставки 3 раза в неделю напрямую с баз. Цветы, которые стоят неделями, а не днями.</p></div>'+
      '<div class="feat"><span class="f-num">02</span><span class="f-ic f-ic-2">'+IC.truck+'</span><h3>Доставка 24/7 бесплатно</h3><p>Привезём даже одну пачку тюльпанов ночью — по Кирову доставка всегда за наш счёт.</p></div>'+
      '<div class="feat"><span class="f-num">03</span><span class="f-ic f-ic-3">'+IC.tag+'</span><h3>Честные цены</h3><p>Оптовые цены в розницу, акции каждую неделю и шары от 69 ₽. Без скрытых наценок.</p></div>'+
      '<div class="feat"><span class="f-num">04</span><span class="f-ic f-ic-4">'+IC.scissors+'</span><h3>Флористы-волшебники</h3><p>Соберём букет под любой повод и бюджет — от комплимента до свадебной классики.</p></div>'+
    '</div>'+
  '</div></section>'+
  '<section style="padding-top:16px"><div class="wrap">'+
    '<div class="sec-head"><h2 class="sec-title" data-split>Как заказать</h2></div>'+
    '<div class="steps" data-stagger>'+
      '<div class="step"><b class="st-n">01</b><h3>Выберите букет</h3><p>В каталоге — всё, что сейчас в наличии. Или пришлите референс: соберём похожий под ваш бюджет.</p></div>'+
      '<div class="step"><b class="st-n">02</b><h3>Нажмите «Заказать»</h3><p>Мы откроем сообщения сообщества VK и скопируем название товара — останется вставить его в диалог.</p></div>'+
      '<div class="step"><b class="st-n">03</b><h3>Получите цветы</h3><p>Подтвердим заказ в переписке и привезём бесплатно в удобное время. Хоть в 3 часа ночи.</p></div>'+
    '</div>'+
  '</div></section>'+
  '<section style="padding-top:8px"><div class="wrap">'+
    '<div class="cta-banner">'+
      '<h2 data-cta="1">Не можете выбрать?<br>Соберём букет под ваш бюджет</h2>'+
      '<p data-cta="0.6">Напишите нам в VK — флорист предложит 3 варианта на вашу сумму и пришлёт фото до отправки.</p>'+
      '<button class="btn pink" data-order="" data-cta="1.2">'+vkSpan()+'Обсудить букет в VK</button>'+
    '</div>'+
  '</div></section>';
}
function tplCatalog(cat){
  var list = catalogList(cat);
  var first = list.slice(0,PAGE_SIZE);
  var rest = list.length-first.length;
  return '<div class="page-head"><div class="wrap">'+
    '<div class="crumbs" data-anim="drop"><a href="#/">Главная</a> / <span>Каталог</span></div>'+
    '<h1 data-anim="drop">Каталог</h1>'+
    '<p class="lead" data-anim="fade">Онлайн-витрина наличия: '+list.length+' товаров. Заказ оформляется в сообщениях сообщества VK — без форм и оплат на сайте. Цены не являются публичной офертой и подтверждаются флористом в переписке.</p>'+
    '<div class="chips" data-anim="fade" id="chipsBox">'+
      '<span class="chip-marker" id="chipMarker" aria-hidden="true"></span>'+
      '<button class="chip'+(cat==="all"?" on":"")+'" data-cat="all">Все товары</button>'+
      (DB.collections||[]).map(function(c){return '<button class="chip'+(cat===c.id?" on":"")+'" data-cat="'+esc(c.id)+'">'+esc(c.name)+'</button>';}).join('')+
    '</div>'+
  '</div></div>'+
  '<section style="padding-top:4px"><div class="wrap">'+
    '<div class="pgrid" id="pgrid" data-cat="'+cat+'" data-stagger>'+first.map(cardHTML).join('')+'</div>'+
    '<div class="more-wrap" id="moreWrap"'+(rest>0?'':' hidden')+'>'+
      '<span class="more-info">Показано <span id="moreShown">'+first.length+'</span> из <span id="moreTotal">'+list.length+'</span></span>'+
      '<button class="btn ghost more-btn" id="moreBtn" data-magnetic>'+
        '<span class="mb-text">Показать ещё · <span id="moreRest">'+rest+'</span></span>'+
        '<span class="loader" aria-hidden="true"><i></i></span>'+
      '</button>'+
    '</div>'+
  '</div></section>';
}
function updateMoreUI(animate){
  var grid=document.getElementById("pgrid");
  var wrap=document.getElementById("moreWrap");
  var shownEl=document.getElementById("moreShown");
  var totalEl=document.getElementById("moreTotal");
  var restEl=document.getElementById("moreRest");
  if(!grid||!wrap)return;
  var total=catalogList(grid.dataset.cat||"all").length;
  var shown=grid.children.length;
  var rest=total-shown;
  if(totalEl)totalEl.textContent=total;
  if(shownEl){
    var from=parseInt(shownEl.textContent,10)||0;
    if(animate && from!==shown){
      var o={v:from};
      gsap.to(o,{v:shown,duration:.45,ease:"power2.out",onUpdate:function(){shownEl.textContent=Math.round(o.v);}});
      gsap.fromTo(shownEl,{y:10,opacity:0},{y:0,opacity:1,duration:.35,ease:"power2.out"});
    }else{shownEl.textContent=shown;}
  }
  if(restEl)restEl.textContent=rest;
  wrap.hidden = rest<=0;
}
function bindMoreButton(){
  var btn=document.getElementById("moreBtn");
  var grid=document.getElementById("pgrid");
  if(!btn||!grid)return;
  btn.onclick=function(){
    if(btn.classList.contains("loading"))return;
    btn.classList.add("loading");
    setTimeout(function(){
      var cat=grid.dataset.cat||"all";
      var list=catalogList(cat);
      var shown=grid.children.length;
      var next=list.slice(shown,shown+PAGE_SIZE);
      btn.classList.remove("loading");
      if(!next.length){updateMoreUI(true);return;}
      var tmp=document.createElement("div");
      tmp.innerHTML=next.map(cardHTML).join("");
      var added=Array.prototype.slice.call(tmp.children);
      added.forEach(function(el){grid.appendChild(el);});
      bindTilt();bindMagnetic();enrichCards(grid);popBadges(added);
      gsap.from(added,{y:40,opacity:0,scale:.97,duration:.32,stagger:.05,ease:"power3.out"});
      updateMoreUI(true);
    },450);
  };
}
function moveChipMarker(instant){
  var mk=document.getElementById("chipMarker");
  var on=document.querySelector(".chip.on");
  if(!mk||!on)return;
  if(instant){mk.style.transition="none";}
  mk.style.left=on.offsetLeft+"px";
  mk.style.top=on.offsetTop+"px";
  mk.style.width=on.offsetWidth+"px";
  mk.style.height=on.offsetHeight+"px";
  if(instant){void mk.offsetWidth;mk.style.transition="";}
}
function bindCatalogChips(){
  document.querySelectorAll(".chip[data-cat]").forEach(function(ch){
    ch.addEventListener("click",function(){
      if(ch.classList.contains("on"))return;
      document.querySelectorAll(".chip[data-cat]").forEach(function(c){c.classList.toggle("on",c===ch);});
      moveChipMarker(false);
      var cat=ch.dataset.cat;
      var list=catalogList(cat);
      var grid=document.getElementById("pgrid");
      if(!grid)return;
      var out=Array.prototype.slice.call(grid.children);
      gsap.to(out,{opacity:0,scale:.9,duration:.22,stagger:.015,ease:"power2.out",onComplete:function(){
        grid.dataset.cat=cat;
        grid.classList.remove("rv-stagger","rv-in");
        grid.innerHTML=list.slice(0,PAGE_SIZE).map(cardHTML).join("");
        updateMoreUI(true);
        bindTilt();bindMagnetic();enrichCards(grid);popBadges(grid.children);
        gsap.from(grid.children,{y:26,opacity:0,scale:.96,duration:.3,stagger:.05,ease:"power2.out"});
      }});
    });
  });
}
function tplProduct(id){
  var p = prodById(id);
  if(!p) return tpl404();
  var sim=(DB.products||[]).filter(function(x){return x.id!==p.id && (x.cols||[]).some(function(c){return (p.cols||[]).indexOf(c)>-1;});});
  if(sim.length<4){
    sim=sim.concat((DB.products||[]).filter(function(x){return x.id!==p.id && sim.indexOf(x)===-1;}));
  }
  sim=sim.slice(0,4);
  var crumbsInner='<a href="#/">Главная</a> / <a href="#/catalog">Каталог</a> / <a href="#/catalog/'+esc((p.cols||[])[0])+'">'+esc(colName((p.cols||[])[0]))+'</a>';
  return '<div class="wrap prod">'+
    '<div class="crumbs crumbs-mobile">'+crumbsInner+'</div>'+
    '<div class="prod-left">'+
      '<div class="prod-media solo" id="prodMedia">'+
        '<img id="galMain" src="'+esc(safeUrl(prodCover(p)))+'" alt="'+esc(p.name)+'" data-imgfallback="'+((p.imgs&&p.imgs.length)?"ph":"nex:"+esc(p.id)+":1")+'">'+
        '<button class="gal-nav prev" id="galPrev" aria-label="Предыдущее фото">'+IC.chevL+'</button>'+
        '<button class="gal-nav next" id="galNext" aria-label="Следующее фото">'+IC.chevR+'</button>'+
        '<span class="gal-count" id="galCount">1 / 1</span>'+
      '</div>'+
    '</div>'+
    '<div class="prod-info">'+
      '<div class="crumbs">'+crumbsInner+'</div>'+
      '<h1>'+esc(p.name)+'</h1>'+
      '<div class="prod-price">'+(p.old?'<s>'+fmt(p.old)+'</s>':'')+fmt(p.price)+'</div>'+
      '<p class="prod-desc">'+esc(p.desc)+'</p>'+
      '<div class="comp-chips">'+(p.comp||[]).map(function(c){return '<span>'+esc(c)+'</span>';}).join('')+'</div>'+
      '<div class="prod-ctas">'+
        '<button class="btn" data-order="'+esc(p.name)+'" data-magnetic>'+vkSpan()+'Заказать в VK</button>'+
        '<a class="btn ghost" href="#/catalog">В каталог '+IC.arrow+'</a>'+
      '</div>'+
      '<div class="prod-notes">'+
        '<div class="pnote">'+IC.truck+'<div><b>Бесплатная доставка 24/7</b><span>По Кирову — в любое время, среднее время 1–2 часа.</span></div></div>'+
        '<div class="pnote">'+IC.pin+'<div><b>Самовывоз</b><span>Ленина 102-А · Воровского 107/1 — ежедневно с 06:00 до 00:00.</span></div></div>'+
      '</div>'+
      '<div class="gal-thumbs" id="galThumbs"></div>'+
    '</div>'+
  '</div>'+
  '<section class="similar"><div class="wrap">'+
    '<div class="sec-head"><h2 class="sec-title" data-split>С этим также берут</h2></div>'+
    '<div class="pgrid" id="simGrid">'+sim.map(cardHTML).join('')+'</div>'+
  '</div></section>';
}
function tplDelivery(){
  return '<div class="page-head"><div class="wrap">'+
    '<div class="crumbs" data-anim="fade"><a href="#/">Главная</a> / <span>Доставка</span></div>'+
    '<h1 data-split>Доставка и заказ</h1>'+
    '<p class="lead" data-anim="fade">Мы доставляем цветы по Кирову круглосуточно и бесплатно. Даже если вы заказываете одну пачку тюльпанов в 4 утра.</p>'+
  '</div></div>'+
  '<section style="padding-top:8px"><div class="wrap del-grid">'+
    '<div class="del-sticky">'+
      '<h2 data-split>Три шага до букета</h2>'+
      '<p data-anim="fade">Никаких корзин, форм и оплат на сайте: весь заказ происходит в диалоге с флористом в VK — так быстрее и человечнее.</p>'+
      '<button class="btn" data-order="" data-magnetic>'+vkSpan()+'Написать сейчас</button>'+
    '</div>'+
    '<div class="del-steps" data-stagger>'+
      '<div class="dstep"><b>01</b><div><h3>Выбираете товар в каталоге</h3><p>Все позиции витрины — в наличии в магазинах на Ленина 102-А и Воровского 107/1. Нет готового варианта? Пришлите референс — соберём на ваш бюджет.</p></div></div>'+
      '<div class="dstep"><b>02</b><div><h3>Жмёте «Заказать в VK»</h3><p>Откроются сообщения сообщества, а название товара скопируется в буфер обмена — просто вставьте его в первое сообщение диалога.</p></div></div>'+
      '<div class="dstep"><b>03</b><div><h3>Подтверждаете и получаете</h3><p>Флорист пришлёт фото готового букета перед отправкой и согласует оплату. Курьер привезёт заказ бесплатно в удобное время, круглосуточно.</p></div></div>'+
    '</div>'+
  '</div>'+
  '<div class="wrap"><div class="del-cards" data-stagger>'+
    '<div class="del-card dark"><span class="ic-round ic-truck">'+IC.truck+'</span><h3>По Кирову — 0 ₽</h3><p>Бесплатная доставка в любое время суток, 7 дней в неделю, без минимальной суммы заказа.</p></div>'+
    '<div class="del-card"><span class="ic-round ic-clock">'+IC.clock+'</span><h3>1–2 часа</h3><p>Среднее время доставки готового букета. Нужно к точному времени? Привезём к нужному часу — укажите в переписке.</p></div>'+
    '<div class="del-card"><span class="ic-round ic-pin">'+IC.pin+'</span><h3>Самовывоз</h3><p>Ленина 102-А и Воровского 107/1 — ежедневно с 06:00 до 00:00. Отложим заказ к вашему приходу.</p></div>'+
  '</div></div></section>'+
  '<section style="padding-top:4px"><div class="wrap">'+
    '<div class="cta-banner">'+
      '<h2 data-cta="1">Нужен букет к точному времени?</h2>'+
      '<p data-cta="0.6">Напишите в VK дату и время — соберём и привезём минута в минуту, даже ночью.</p>'+
      '<button class="btn pink" data-order="" data-cta="1.2">'+vkSpan()+'Обсудить доставку</button>'+
    '</div>'+
  '</div></section>';
}
function tplContacts(){
  return '<div class="page-head"><div class="wrap">'+
    '<div class="crumbs" data-anim="fade"><a href="#/">Главная</a> / <span>Контакты</span></div>'+
    '<h1 data-split>Контакты и магазины</h1>'+
    '<p class="lead" data-anim="fade">Два магазина в Кирове, круглосуточная доставка и соцсети, где мы каждый день показываем новинки и акции.</p>'+
  '</div></div>'+
  '<section style="padding-top:8px"><div class="wrap">'+
    '<div class="contact-cards" data-stagger>'+
      '<div class="ccard"><span class="ic-round ic-pin">'+IC.pin+'</span><h3>Магазин на Ленина</h3><p>Киров, ул. Ленина, 102-А</p><p>Ежедневно с 06:00 до 00:00</p><p>Доставка 24/7</p></div>'+
      '<div class="ccard"><span class="ic-round ic-pin">'+IC.pin+'</span><h3>Магазин на Воровского</h3><p>Киров, ул. Воровского, 107/1</p><p>Ежедневно с 06:00 до 00:00</p><p>Доставка 24/7</p></div>'+
      '<div class="ccard"><span class="ic-round ic-phone">'+IC.phone+'</span><h3>Телефон</h3><p>Звоните с 06:00 до 00:00</p><a class="tel" href="tel:+79992255000">+7 (999) 225-50-00</a></div>'+
    '</div>'+
    '<div class="socials" data-stagger>'+
      '<a class="soc vk" href="'+VK_URL+'" target="_blank" rel="noopener">'+IC.vk+'<b>ВКонтакте</b><span>vk.ru/dubravin.flowers — витрина, акции и сообщения для заказа</span>'+socArrow()+'</a>'+
      '<a class="soc ig" href="'+IG_URL+'" target="_blank" rel="noopener">'+IC.ig+'<b>Instagram</b><span>@dubravin.flowers — онлайн-витрина в stories и новинки недели</span>'+socArrow()+'</a>'+
    '</div>'+
  '</div></section>'+
  '<section style="padding-top:4px"><div class="wrap">'+
    '<div class="cta-banner">'+
      '<h2 data-cta="1">Проще всего написать нам в VK</h2>'+
      '<p data-cta="0.6">Отвечаем на сообщения сообщества каждый день. Поможем выбрать, посчитаем под бюджет и пришлём фото готового букета.</p>'+
      '<button class="btn pink" data-order="" data-cta="1.2">'+vkSpan()+'Открыть сообщения VK</button>'+
    '</div>'+
  '</div></section>';
}
function tpl404(){
  return '<div class="page-head"><div class="wrap">'+
    '<div class="crumbs" data-anim="fade"><a href="#/">Главная</a> / <span>404</span></div>'+
    '<h1 data-split>Страница не найдена</h1>'+
    '<p class="lead" data-anim="fade">Возможно, она была удалена или указан неверный адрес. Загляните в каталог — там точно есть свежие букеты.</p>'+
    '<div style="margin-top:24px;display:flex;gap:12px;flex-wrap:wrap" data-anim="fade">'+
      '<a class="btn" href="#/catalog" data-magnetic>В каталог '+IC.arrow+'</a>'+
      '<a class="btn ghost" href="#/">На главную</a>'+
    '</div>'+
  '</div></div>';
}
