"use strict";
/* =========================================================
   МОДУЛЬ N. АДМИН-ПАНЕЛЬ (CMS) — #/admin
   Все правки уходят на сервер хостинга (см. store.js → dfServerSave)
   и сразу публикуются для всех посетителей сайта.
   ========================================================= */
var admTab="hero", admEdit=null, admDraft=null;
/* Очередь фото, выбранных в форме товара: оригиналы файлов уйдут
   на сервер при сохранении (multipart), превью показываем сразу. */
var admPending=[], admPendingPrev=[];
var admRemovedUploaded=false;  /* удаляли загруженное фото → после сохранения чистим осиротевшие файлы */
var admSaving=false;

/* Относительные пути БД (img/…) хранятся от корня сайта, а панель
   живёт в /admin/ — для превью добавляем "../". */
function admSrc(u){
  u=String(u==null?"":u);
  if(!u)return u;
  if(/^https?:\/\//i.test(u)||u.indexOf("data:")===0||u.indexOf("blob:")===0||u.charAt(0)==="/")return u;
  return "../"+u;
}
function admThumb(src){return '<img class="adm-thumb" src="'+esc(safeUrl(admSrc(src||PH)))+'" alt="" data-imgfallback="ph">';}

function tplAdmin(){
  return '<div class="page-head"><div class="wrap">'+
    '<div class="crumbs"><a href="../">Главная</a> / <span>Управление сайтом</span></div>'+
    '<h1>Панель управления</h1>'+
    '<div class="adm-tabs" id="admTabs">'+
      '<button data-tab="hero" class="'+(admTab==="hero"?"on":"")+'">Hero</button>'+
      '<button data-tab="cols" class="'+(admTab==="cols"?"on":"")+'">Подборки</button>'+
      '<button data-tab="prod" class="'+(admTab==="prod"?"on":"")+'">Товары</button>'+
      '<button data-tab="data" class="'+(admTab==="data"?"on":"")+'">Данные</button>'+
    '</div>'+
  '</div></div>'+
  '<section style="padding-top:4px"><div class="wrap"><div id="admBody"></div></div></section>';
}
function bindAdmin(){
  document.querySelectorAll("#admTabs button").forEach(function(b){
    b.addEventListener("click",function(){
      admTab=b.dataset.tab;admEdit=null;admDraft=null;admClearPending();
      document.querySelectorAll("#admTabs button").forEach(function(x){x.classList.toggle("on",x===b);});
      renderAdmTab();
    });
  });
  renderAdmTab();
}
function renderAdmTab(){
  var body=document.getElementById("admBody");
  if(!body)return;
  if(admTab==="hero"){body.innerHTML=admHero();bindAdmHero();}
  else if(admTab==="cols"){body.innerHTML=admCols();bindAdmCols();}
  else if(admTab==="prod"){body.innerHTML=admEdit?admProdForm():admProdList();admEdit?bindAdmProdForm():bindAdmProdList();}
  else{body.innerHTML=admData();bindAdmData();}
}

/* Сохранение с немедленной публикацией на сервере (для крупных операций:
   импорт, сброс, сохранение товара). В локальном режиме — обычный dbSave. */
function admPersist(msgServer,msgLocal){
  if(dfServerMode()){
    return dfServerFlush().then(function(r){
      if(r){showToast(msgServer);}
      else{showToast("Не удалось опубликовать изменения на сервере — попробуйте ещё раз");}
      return !!r;
    });
  }
  dbSave();
  showToast(msgLocal||msgServer);
  return Promise.resolve(true);
}

/* --- Hero --- */
function admHero(){
  var img=(DB.hero&&DB.hero.img)||"";
  return '<div class="adm-card"><h3>Изображение Hero (главный экран)</h3>'+
    '<div class="adm-row" style="margin-bottom:14px">'+admThumb(img)+'</div>'+
    '<div class="adm-field"><label>Ссылка на изображение (необязательно — можно просто загрузить файл)</label>'+
    '<input class="adm-input" id="heroPath" value="'+esc(img)+'"></div>'+
    '<div class="adm-btns">'+
      '<label class="btn ghost" style="padding:10px 18px;font-size:13px">Загрузить с устройства<input type="file" id="heroFile" accept="image/*" hidden></label>'+
      '<button class="btn" id="heroSave" style="padding:10px 18px;font-size:13px">Сохранить</button>'+
    '</div></div>';
}
function bindAdmHero(){
  var pending=null;
  document.getElementById("heroFile").addEventListener("change",function(){
    var f=this.files&&this.files[0];if(!f)return;
    readImgFile(f,function(url){
      if(!url){showToast("Не удалось прочитать файл");return;}
      pending=url;
      document.querySelector("#admBody .adm-thumb").src=url;
    });
  });
  document.getElementById("heroSave").addEventListener("click",function(){
    var hv=pending||sanitizeString(document.getElementById("heroPath").value.trim(),2000000);
    if(hv&&safeUrl(hv)==="#"){showToast("Недопустимый адрес изображения");return;}
    DB.hero=DB.hero||{};
    DB.hero.img=hv;
    admPersist("Hero-изображение сохранено и опубликовано","Hero-изображение сохранено");
  });
}

/* --- Подборки --- */
function admCols(){
  var mainUsed=(DB.collections||[]).filter(function(c){return c.main;}).length;
  var rows=(DB.collections||[]).map(function(c){
    return '<div class="adm-list-row" data-cid="'+c.id+'">'+
      admThumb(colCover(c))+
      '<input class="adm-input" style="max-width:260px" data-act="cname" value="'+esc(c.name)+'">'+
      '<label class="adm-check" title="Показывать подборку на главной странице"><input type="checkbox" data-act="cmain" '+(c.main?"checked":"")+'> 🏠 На главной</label>'+
      '<label class="btn-mini" style="width:auto">Обложка<input type="file" data-act="cfile" accept="image/*" hidden></label>'+
      '<button class="btn-mini" style="width:auto" data-act="cdel">Удалить</button>'+
    '</div>';
  }).join("");
  return '<div class="adm-card"><h3>Подборки (категории каталога)</h3>'+
    (rows||'<p class="adm-note">Подборок пока нет — добавьте первую.</p>')+
    '<div class="adm-row" style="margin-top:16px">'+
    '<input class="adm-input" id="newColName" placeholder="Название новой подборки" style="max-width:260px">'+
    '<button class="btn" id="newColAdd" style="padding:10px 18px;font-size:13px">Добавить</button></div>'+
    '<p class="adm-note" style="margin-top:10px">На главной странице показываются только подборки с отметкой «🏠 На главной» — не более '+MAIN_LIMIT+'. Сейчас отмечено: '+mainUsed+' из '+MAIN_LIMIT+'. Обложка подборки — изображение плитки на главной и превью в каталоге; пока её нет, подставляется обложка первого товара. Удаление подборки не удаляет товары.</p></div>';
}
function bindAdmCols(){
  var body=document.getElementById("admBody");
  body.querySelectorAll(".adm-list-row").forEach(function(row){
    var cid=row.dataset.cid;
    var col=(DB.collections||[]).filter(function(c){return c.id===cid;})[0];
    if(!col)return;
    row.querySelector('[data-act="cname"]').addEventListener("change",function(){
      col.name=this.value.trim()||col.name;dbSave();showToast("Название сохранено");
    });
    row.querySelector('[data-act="cmain"]').addEventListener("change",function(){
      var cb=this;
      if(cb.checked&&mainCollectionsCount(cid)>=MAIN_LIMIT){
        cb.checked=false;
        showToast("На главной может быть не больше "+MAIN_LIMIT+" подборок — сначала снимите отметку с другой");
        return;
      }
      col.main=cb.checked;
      dbSave();
      renderAdmTab();
      showToast(col.main?"Подборка показывается на главной":"Подборка убрана с главной");
    });
    row.querySelector('[data-act="cfile"]').addEventListener("change",function(){
      var f=this.files&&this.files[0];if(!f)return;
      readImgFile(f,function(url){if(url){col.cover=url;dbSave();renderAdmTab();showToast("Обложка обновлена");}});
    });
    row.querySelector('[data-act="cdel"]').addEventListener("click",function(){
      if(!confirm("Удалить подборку «"+col.name+"»?"))return;
      DB.collections=DB.collections.filter(function(c){return c.id!==cid;});
      dbSave();renderAdmTab();showToast("Подборка удалена");
    });
  });
  document.getElementById("newColAdd").addEventListener("click",function(){
    var name=document.getElementById("newColName").value.trim();
    if(!name){showToast("Введите название");return;}
    DB.collections.push({id:"c"+Date.now(),name:name,cover:"",main:false});
    dbSave();renderAdmTab();showToast("Подборка добавлена");
  });
}

/* --- Товары: список --- */
function admProdList(){
  var rows=(DB.products||[]).map(function(p){
    return '<div class="adm-list-row" data-pid="'+esc(p.id)+'">'+
      admThumb(prodCover(p))+
      '<div style="flex:1;min-width:160px"><b style="font-size:13px">'+esc(p.name)+'</b>'+
      '<div class="adm-note">'+fmt(p.price)+(p.old?' <s>'+fmt(p.old)+'</s>':'')+' · '+esc((p.cols||[]).map(colName).join(", "))+'</div></div>'+
      '<div class="adm-note">'+(p.sale?"🏷 Акция ":"")+(p.hit?"🔥 Хит ":"")+(p.main?"🏠 Главная":"")+'</div>'+
      '<button class="btn-mini" style="width:auto" data-act="pedit">Изменить</button>'+
      '<button class="btn-mini" style="width:auto" data-act="pdel">Удалить</button>'+
    '</div>';
  }).join("");
  return '<div class="adm-card">'+
    '<div class="adm-list-head">'+
      '<h3>Товары ('+(DB.products||[]).length+')</h3>'+
      '<button class="btn pink" id="prodAdd" style="padding:10px 22px;font-size:13.5px">+ Добавить товар</button>'+
    '</div>'+
    (rows||'<p class="adm-note">Товаров пока нет — нажмите «+ Добавить товар».</p>')+
  '</div>';
}
function bindAdmProdList(){
  var body=document.getElementById("admBody");
  body.querySelectorAll(".adm-list-row").forEach(function(row){
    var pid=row.dataset.pid;
    row.querySelector('[data-act="pedit"]').addEventListener("click",function(){
      var p=prodById(pid);
      admDraft=JSON.parse(JSON.stringify(p));
      admEdit=pid;admClearPending();renderAdmTab();
    });
    row.querySelector('[data-act="pdel"]').addEventListener("click",function(){
      var p=prodById(pid);
      if(!confirm("Удалить товар «"+p.name+"»?"))return;
      DB.products=DB.products.filter(function(x){return x.id!==pid;});
      dbSave();
      /* фото удалённого товара уберёт серверная чистка осиротевших файлов */
      if(dfServerMode()){dfServerFlush().then(function(r){if(r)dfApiRequest("POST","/admin/media/orphans");});}
      renderAdmTab();showToast("Товар удалён");
    });
  });
  document.getElementById("prodAdd").addEventListener("click",function(){
    /* ID назначается автоматически (следующий свободный номер) — поле скрыто */
    admDraft={id:nextProductId(),name:"",desc:"",price:0,old:null,imgs:[],cols:[],hit:false,main:false,comp:[]};
    admEdit="new";admClearPending();renderAdmTab();
  });
}

/* --- Товары: форма --- */
/* «Акция» отдельно не включается: заполнена «Старая цена» → плашка и
   попадание в подборку «Акции» проставляются автоматически.            */
function admSaleState(d){
  var old=(d.old===null||d.old===undefined||d.old==="")?null:parseFloat(d.old);
  var price=parseFloat(d.price)||0;
  return !!(old!==null&&isFinite(old)&&old>0&&old>price);
}
function admProdForm(){
  var d=admDraft;
  var isNew=(admEdit==="new");
  var colsChecks=(DB.collections||[]).map(function(c){
    var isSale=(c.id===SALE_COL_ID);
    var checked=isSale?admSaleState(d):((d.cols||[]).indexOf(c.id)>-1);
    return '<label class="adm-check"'+(isSale?' title="Управляется автоматически: отметьте «Старую цену»"':'')+'>'+
      '<input type="checkbox" data-f="cols" value="'+c.id+'" '+(checked?"checked":"")+(isSale?" disabled":"")+'> '+esc(c.name)+(isSale?' <span class="adm-note">(авто)</span>':'')+'</label>';
  }).join("");
  return '<div class="adm-card"><h3>'+(isNew?"Новый товар":"Товар #"+esc(d.id))+'</h3>'+(isNew?'<p class="adm-note" style="margin:-6px 0 12px">Номер (ID) товара будет присвоен автоматически при сохранении.</p>':'')+
    '<div class="adm-grid">'+
      '<div class="adm-field"><label>Название</label><input class="adm-input" data-f="name" placeholder="Например: Букет из 25 роз 🤍" value="'+esc(d.name)+'"></div>'+
      '<div class="adm-field"><label>Цена, ₽</label><input class="adm-input" data-f="price" type="number" min="0" value="'+d.price+'"></div>'+
      '<div class="adm-field"><label>Старая цена, ₽ (если заполнена — автоматически появится плашка «Акция», а товар попадёт в подборку «Акции»)</label><input class="adm-input" data-f="old" type="number" min="0" value="'+(d.old||"")+'"></div>'+
    '</div>'+
    '<div class="adm-field"><label>Описание</label><textarea class="adm-textarea" data-f="desc">'+esc(d.desc)+'</textarea></div>'+
    '<div class="adm-field"><label>Подборки</label><div class="adm-checks">'+colsChecks+'</div></div>'+
    '<div class="adm-checks">'+
      '<label class="adm-check"><input type="checkbox" data-f="hit" '+(d.hit?"checked":"")+'> 🔥 Хит</label>'+
      '<label class="adm-check" title="На главной показываются только '+MAIN_LIMIT+' отмеченные карточки"><input type="checkbox" data-f="main" '+(d.main?"checked":"")+'> 🏠 Показывать на главной</label>'+
    '</div>'+
    '<div class="adm-field"><label>Фото товара (до '+MAX_IMGS+' штук, первое — обложка)</label>'+
      '<div class="adm-imgs" id="admImgs"></div>'+
      '<div class="adm-btns">'+
        '<label class="btn-mini" id="admImgsBtn" style="width:auto">+ Загрузить с устройства<input type="file" id="admImgsFile" accept="image/jpeg,image/png,image/webp" multiple hidden></label>'+
        '<span class="adm-note" id="admImgsHint"></span>'+
      '</div>'+
    '</div>'+
    '<div class="adm-field"><label>Состав (теги-характеристики, до '+MAX_COMP+' позиций)</label><div id="admComp"></div>'+
      '<div class="adm-btns"><button class="btn-mini" style="width:auto" id="admCompAdd">+ Позиция состава</button></div>'+
    '</div>'+
    '<div class="adm-btns" style="margin-top:16px">'+
      '<button class="btn pink" id="admSave" style="padding:12px 24px;font-size:14px">Сохранить товар</button>'+
      '<button class="btn ghost" id="admCancel" style="padding:12px 24px;font-size:14px">Отмена</button>'+
    '</div></div>';
}
function admClearPending(){
  admPendingPrev.forEach(function(u){try{URL.revokeObjectURL(u);}catch(e){}});
  admPending=[];admPendingPrev=[];admRemovedUploaded=false;
}
function bindAdmProdForm(){
  var d=admDraft;
  var body=document.getElementById("admBody");

  /* ---- поля ---- */
  body.querySelectorAll("[data-f]").forEach(function(el){
    var f=el.dataset.f;
    if(f==="cols"){
      if(el.disabled)return;   /* чекбокс «Акции» управляется автоматически */
      el.addEventListener("change",function(){
        var vals=[];
        body.querySelectorAll('[data-f="cols"]:checked').forEach(function(c){vals.push(c.value);});
        d.cols=vals;
      });
    }else if(el.type==="checkbox"){
      el.addEventListener("change",function(){
        if(f==="main"&&el.checked&&mainProductsCount(d.id)>=MAIN_LIMIT){
          el.checked=false;
          showToast("На главной может быть не больше "+MAIN_LIMIT+" товаров — сначала снимите отметку с другого");
          return;
        }
        d[f]=el.checked;
      });
    }else{
      el.addEventListener("input",function(){
        if(f==="price"||f==="old"){
          var n=parseFloat(el.value);
          d[f]=isNaN(n)?null:n;
          if(f==="old"&&!d.old)d.old=null;
          admUpdateSaleUI();
        }
        else d[f]=el.value;
      });
    }
  });
  /* живой индикатор акции: чекбокс подборки «Акции» (disabled) следует за старой ценой */
  function admUpdateSaleUI(){
    var cb=body.querySelector('[data-f="cols"][value="'+SALE_COL_ID+'"]');
    if(cb)cb.checked=admSaleState(d);
  }
  admUpdateSaleUI();

  /* ---- изображения ---- */
  function refreshImgs(){
    var box=document.getElementById("admImgs");
    if(!box)return;
    var html=(d.imgs||[]).map(function(u,i){
      return '<span class="im"><img src="'+esc(safeUrl(admSrc(u)))+'" alt="" data-imgfallback="ph"><button data-delimg="'+i+'" title="Удалить">×</button></span>';
    }).join("");
    html+=admPendingPrev.map(function(u,i){
      return '<span class="im pending" title="Загрузится на сервер при сохранении"><img src="'+esc(u)+'" alt=""><button data-delpend="'+i+'" title="Убрать">×</button></span>';
    }).join("");
    box.innerHTML=html||'<span class="adm-note">Фото нет — на сайте карточка покажет заглушку. Загрузите первое фото, и заглушка пропадёт.</span>';
    box.querySelectorAll("[data-delimg]").forEach(function(b){
      b.addEventListener("click",function(){
        var i=+b.dataset.delimg;
        var u=(d.imgs||[])[i];
        if(u&&/^img\//.test(u))admRemovedUploaded=true;
        d.imgs.splice(i,1);refreshImgs();
      });
    });
    box.querySelectorAll("[data-delpend]").forEach(function(b){
      b.addEventListener("click",function(){
        var i=+b.dataset.delpend;
        try{URL.revokeObjectURL(admPendingPrev[i]);}catch(e){}
        admPending.splice(i,1);admPendingPrev.splice(i,1);refreshImgs();
      });
    });
    var total=(d.imgs||[]).length+admPending.length;
    var fileInput=document.getElementById("admImgsFile");
    var btn=document.getElementById("admImgsBtn");
    var hint=document.getElementById("admImgsHint");
    var full=total>=MAX_IMGS;
    if(fileInput)fileInput.disabled=full;
    if(btn)btn.classList.toggle("disabled",full);
    if(hint)hint.textContent=full
      ? "Достигнут лимит: "+MAX_IMGS+" фото. Удалите одно, чтобы добавить новое."
      : "Загружено "+total+" из "+MAX_IMGS+(dfIsServerMode()?" · фото сохранятся на сервер при нажатии «Сохранить товар»":"");
  }
  refreshImgs();
  document.getElementById("admImgsFile").addEventListener("change",function(){
    var files=Array.prototype.slice.call(this.files||[]);
    this.value="";
    if(!files.length)return;
    var room=MAX_IMGS-((d.imgs||[]).length+admPending.length);
    if(room<=0){showToast("Максимум "+MAX_IMGS+" фото — удалите лишнее");return;}
    if(files.length>room){
      showToast("Можно добавить ещё "+room+" — лишние файлы пропущены");
      files=files.slice(0,room);
    }
    files.forEach(function(f){
      if(!/^image\/(jpeg|png|webp)$/i.test(f.type||"")){showToast("Неподдерживаемый формат: "+(f.name||"файл")+" (только JPEG, PNG, WebP)");return;}
      if(f.size>8*1024*1024){showToast("Файл больше 8 МБ: "+(f.name||""));return;}
      if(dfIsServerMode()){
        /* Серверный режим: оригинал файла уйдёт на сервер (multipart),
           превью показываем сразу через objectURL. */
        admPending.push(f);
        var url=null;
        try{url=URL.createObjectURL(f);}catch(e){}
        admPendingPrev.push(url||PH);
        refreshImgs();
      }else{
        /* Без сервера (локальный просмотр): сжимаем и храним в браузере */
        readImgFile(f,function(url2){
          if(url2){d.imgs=d.imgs||[];d.imgs.push(url2);refreshImgs();dbSave();}
          else showToast("Не удалось прочитать файл "+(f.name||""));
        });
      }
    });
  });

  /* ---- состав (максимум MAX_COMP позиций) ---- */
  function refreshComp(){
    var box=document.getElementById("admComp");
    box.innerHTML=(d.comp||[]).map(function(c,i){
      return '<div class="adm-comp-row"><input class="adm-input" data-comp="'+i+'" value="'+esc(c)+'">'+
        '<button class="btn-mini" style="width:auto" data-delcomp="'+i+'">×</button></div>';
    }).join("");
    box.querySelectorAll("[data-comp]").forEach(function(inp){
      inp.addEventListener("input",function(){d.comp[+inp.dataset.comp]=inp.value;});
    });
    box.querySelectorAll("[data-delcomp]").forEach(function(b){
      b.addEventListener("click",function(){d.comp.splice(+b.dataset.delcomp,1);refreshComp();});
    });
    var addBtn=document.getElementById("admCompAdd");
    var n=(d.comp||[]).length;
    if(addBtn){
      addBtn.disabled=n>=MAX_COMP;
      addBtn.textContent=n>=MAX_COMP?"Лимит: "+MAX_COMP+" позиций (удалите одну, чтобы добавить)":"+ Позиция состава";
    }
  }
  refreshComp();
  document.getElementById("admCompAdd").addEventListener("click",function(){
    d.comp=d.comp||[];
    if(d.comp.length>=MAX_COMP){showToast("Максимум "+MAX_COMP+" позиций состава");return;}
    d.comp.push("");refreshComp();
  });

  /* ---- сохранить / отмена ---- */
  function setSavingUI(on){
    admSaving=on;
    var s=document.getElementById("admSave"),c=document.getElementById("admCancel");
    if(s){s.disabled=on;s.textContent=on?"Сохраняем и публикуем…":"Сохранить товар";}
    if(c)c.disabled=on;
  }
  function buildRecord(){
    var rec={
      id:(admEdit==="new")?nextProductId():String(admEdit),
      name:sanitizeString(d.name,160),
      desc:sanitizeString(d.desc,2000),
      price:parseFloat(d.price)||0,
      old:(d.old!==null&&d.old!==undefined&&d.old!==""&&isFinite(parseFloat(d.old))&&parseFloat(d.old)>0)?parseFloat(d.old):null,
      imgs:(d.imgs||[]).map(function(u){return safeUrl(sanitizeString(u,2000000));}).filter(function(u){return u&&u!=="#";}).slice(0,MAX_IMGS),
      cols:(d.cols||[]).slice(),
      hit:!!d.hit,
      main:!!d.main,
      comp:(d.comp||[]).filter(function(c){return c&&String(c).trim();}).map(function(c){return sanitizeString(c,80);}).slice(0,MAX_COMP)
    };
    /* Акция — автоматически по старой цене: плашка + подборка «Акции» */
    rec.sale=!!(rec.old!==null&&rec.old>rec.price);
    if(rec.sale){
      ensureSaleCollection();
      if(rec.cols.indexOf(SALE_COL_ID)<0)rec.cols.push(SALE_COL_ID);
    }else{
      rec.cols=rec.cols.filter(function(c){return c!==SALE_COL_ID;});
    }
    /* Страховка лимита главной страницы */
    if(rec.main&&mainProductsCount(rec.id)>=MAIN_LIMIT)rec.main=false;
    return rec;
  }
  function putProduct(rec){
    var i=DB.products.findIndex(function(x){return x.id===rec.id;});
    if(i>-1)DB.products[i]=rec;else DB.products.push(rec);
  }
  function finishSaved(){
    admClearPending();
    admEdit=null;admDraft=null;
    renderAdmTab();
  }
  document.getElementById("admSave").addEventListener("click",function(){
    if(admSaving)return;
    if(!String(d.name||"").trim()){showToast("Укажите название товара");return;}
    var rec=buildRecord();
    var files=admPending.slice();

    /* --- режим сервера: публикуем контент, затем загружаем фото --- */
    if(dfServerMode()){
      setSavingUI(true);
      putProduct(rec);
      var photoWarn=null;
      dfServerFlush().then(function(r){
        if(!r)throw new Error("content-failed");
        if(!files.length)return null;
        return dfUploadPhotos(rec.id,files,false);
      }).then(function(up){
        if(up===null||up===undefined)return;   /* фото не загружали */
        if(!up.ok){
          if(up.status===401)photoWarn="Серверная сессия истекла — войдите заново и повторите сохранение";
          else if(up.body&&up.body.error==="photo-limit")photoWarn="Превышен лимит фото ("+MAX_IMGS+") — товар сохранён без новых фото";
          else photoWarn="Товар сохранён, но фото не загрузились на сервер — повторите загрузку";
          return;
        }
        var rej=(up.body&&up.body.rejected)||[];
        if(rej.length)photoWarn="Товар сохранён; сервер отклонил файлы: "+rej.map(function(x){return x.name||"файл";}).join(", ");
      }).then(function(){
        /* уборка файлов, удалённых из карточки, и перечитывание серверной версии */
        var prune=admRemovedUploaded?dfApiRequest("POST","/admin/media/orphans"):Promise.resolve(null);
        return prune.then(function(){return dfReloadContent();});
      }).then(function(){
        setSavingUI(false);
        finishSaved();
        showToast(photoWarn||"Товар сохранён и опубликован для всех посетителей");
      }).catch(function(){
        /* Контент НЕ опубликован: остаёмся в форме, чтобы не потерять введённое;
           локальную копию БД возвращаем к серверному состоянию. */
        setSavingUI(false);
        dfReloadContent().then(function(){if(admEdit)renderAdmTab();});
      });
      return;
    }

    /* --- локальный режим (сервера нет): всё в этом браузере --- */
    putProduct(rec);
    dbSave();
    finishSaved();
    showToast("Товар сохранён (локальный режим — сервер CMS не обнаружен)");
  });
  document.getElementById("admCancel").addEventListener("click",function(){
    if(admSaving)return;
    admEdit=null;admDraft=null;admClearPending();renderAdmTab();
  });
}

/* --- Данные --- */
function admData(){
  var server=dfServerMode();
  var storeNote=server
    ? '<p class="adm-note" style="margin-bottom:16px">Изменения сохраняются на сервере хостинга и сразу публикуются для всех посетителей сайта — скачивать и загружать файлы не нужно. Кнопки ниже — резервная копия и перенос данных: «Скачать data.json» сохранит текущий каталог файлом, «Импортировать» загрузит копию обратно на сервер, «Сбросить» вернёт исходную витрину.</p>'
    : '<p class="adm-note" style="margin-bottom:16px">⚠️ Сервер CMS не обнаружен — изменения сохраняются только в этом браузере и не видны посетителям сайта. Проверьте развёртывание бэкенда (DEPLOYMENT.md): на Netlify это Functions + переменные окружения, на Beget — backend/server/server.js.</p>';
  var secNote=server
    ? '<p class="adm-note" style="margin-bottom:14px">Вход проверяется на сервере: пароль хранится там в виде хэша scrypt и никогда не попадает в браузер. Смена пароля действует для всех устройств. После 5 неверных попыток вход временно блокируется, сессия завершается через 30 минут бездействия.</p>'
    : '<p class="adm-note" style="margin-bottom:14px">Пароль панели хранится только в этом браузере в виде хэша (PBKDF2-SHA256, 260 000 итераций). После 5 неверных попыток вход временно блокируется, сессия завершается через 30 минут бездействия. Забыли пароль — очистите данные сайта (localStorage) в настройках браузера: панель вернётся к паролю по умолчанию.</p>';
  return '<div class="adm-card"><h3>Данные сайта</h3>'+storeNote+
   '<div class="adm-btns">'+
     '<button class="btn" id="dbExport" style="padding:10px 18px;font-size:13px">Скачать data.json</button>'+
     '<label class="btn ghost" style="padding:10px 18px;font-size:13px">Импортировать data.json<input type="file" id="dbImport" accept="application/json,.json" hidden></label>'+
     '<button class="btn ghost" id="dbReset" style="padding:10px 18px;font-size:13px">Сбросить к исходным</button>'+
   '</div></div>'+
   '<div class="adm-card"><h3>Безопасность</h3>'+secNote+
     '<div class="adm-grid">'+
       '<div class="adm-field"><label>Текущий пароль</label><input class="adm-input" type="password" id="secOld" autocomplete="current-password"></div>'+
       '<div class="adm-field"><label>Новый пароль (мин. 8 символов)</label><input class="adm-input" type="password" id="secNew" autocomplete="new-password"></div>'+
     '</div>'+
     '<div class="adm-field"><label>Повторите новый пароль</label><input class="adm-input" type="password" id="secNew2" autocomplete="new-password"></div>'+
     '<div class="adm-btns"><button class="btn" id="secChange" style="padding:10px 18px;font-size:13px">Сменить пароль</button></div>'+
   '</div>';
}
function bindAdmData(){
  document.getElementById("dbExport").addEventListener("click",function(){
    exportDB();
    showToast(dfServerMode()?"Резервная копия data.json скачана":"data.json скачан");
  });
  document.getElementById("dbImport").addEventListener("change",function(){
    var f=this.files&&this.files[0];if(!f)return;
    var fr=new FileReader();
    fr.onload=function(){
      try{
        var j=JSON.parse(fr.result);
        if(!j.products||!j.collections)throw 0;
        DB=sanitizeDB(j);
        admPersist("Данные импортированы и опубликованы для всех посетителей","Данные импортированы");
        renderAdmTab();
      }catch(e){showToast("Файл повреждён или не подходит");}
    };
    fr.readAsText(f);
  });
  document.getElementById("dbReset").addEventListener("click",function(){
    if(!confirm("Сбросить все изменения к исходному набору?"))return;
    DB=seedDB();
    admPersist("Витрина сброшена к исходному каталогу и опубликована","Данные сброшены");
    if(dfServerMode())dfApiRequest("POST","/admin/media/orphans");
    renderAdmTab();
  });
  var secBtn=document.getElementById("secChange");
  if(!secBtn)return;
  secBtn.addEventListener("click",function(){
    var o=document.getElementById("secOld").value;
    var n=document.getElementById("secNew").value;
    var n2=document.getElementById("secNew2").value;
    if(n.length<8){showToast("Новый пароль слишком короткий (минимум 8 символов)");return;}
    if(n!==n2){showToast("Новые пароли не совпадают");return;}
    secBtn.disabled=true;
    function clearFields(){
      document.getElementById("secOld").value="";
      document.getElementById("secNew").value="";
      document.getElementById("secNew2").value="";
    }
    /* Серверный режим: пароль меняется НА СЕРВЕРЕ (действует для всех устройств) */
    if(dfIsServerMode()){
      dfApiRequest("POST","/admin/password",{currentPassword:o,newPassword:n}).then(function(r){
        secBtn.disabled=false;
        if(r&&r.ok&&r.body&&r.body.ok){clearFields();showToast("Пароль изменён на сервере");}
        else if(r&&r.status===403){showToast("Текущий пароль неверен");}
        else if(r&&r.status===400){showToast("Новый пароль не принят сервером (минимум 8 символов)");}
        else if(r&&r.status===401){showToast("Серверная сессия истекла — войдите заново");}
        else showToast("Не удалось сменить пароль");
      });
      return;
    }
    if(window.DFAuth){
      DFAuth.changePassword(o,n).then(function(r){
        secBtn.disabled=false;
        if(r.ok){clearFields();showToast("Пароль изменён");}
        else if(r.reason==="short"){showToast("Новый пароль слишком короткий (минимум 8 символов)");}
        else{showToast("Текущий пароль неверен");}
      });
    }else{secBtn.disabled=false;}
  });
}
