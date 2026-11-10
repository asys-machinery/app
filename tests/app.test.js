// ASYS Machinery — uçtan uca tarayıcı testi (Playwright + bellek içi Supabase RPC taklidi)
// Çalıştırma: NODE_PATH=<playwright modülleri> node tests/app.test.js
// Taklit, db/schema.sql'deki mach_* fonksiyonlarının davranışını JS'te birebir uygular (roller, kilit, merge, geçmiş, talepler).
const {chromium}=require('playwright');const fs=require('fs');const path=require('path');const crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..');const DATA='/home/claude/pub';
const L=(dir)=>Object.fromEntries(fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!f.startsWith('.')).map(f=>[f.slice(0,-5),JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))]));
const TODAY="2026-11-10";
let pass=0,fail=0;const ok=(n,c,d="")=>{c?pass++:fail++;console.log((c?"PASS ":"FAIL ")+n+(c?"":" — "+d));};

/* ---------- sunucu taklidi (schema.sql ile aynı kurallar) ---------- */
function makeServer(){
  const S={people:{},pins:{},sessions:{},machines:L(DATA+'/dbcheck2/machines'),teams:L(DATA+'/dbcheck2/teams'),operators:L(DATA+'/dbcheck2/operators'),days:{},incidents:{},requests:{},settings:{site:{project:"Wildberries Astana",lockDays:3,zones:[]}}};
  for(const [k,v] of Object.entries(L(DATA+'/dbmig/days')))S.days[k]={date:k,rec:v.rec,saved_by:"p-bauyrzhan",saved_at:v.savedAt||k+"T08:30:00Z",history:v.history||[]};
  S.people["p-huseyin"]={id:"p-huseyin",name:"Hüseyin Özkan",email:"huseyin.ozkan@asys-machinery.com",role:"admin",active:true};S.pins["p-huseyin"]={pw:"Gecici123",must:true};
  const err=m=>{throw new Error(m)};
  const req=(tok,admin,write)=>{const s=S.sessions[tok];if(!s)err("not_logged_in");const p=S.people[s];if(!p||!p.active)err("not_logged_in");if(admin&&p.role!=="admin")err("admin_required");if(write&&p.role==="viewer")err("read_only");return p;};
  const lock=()=>Number(S.settings.site?.lockDays??3);
  const addDays=(iso,n)=>{const d=new Date(iso+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
  const applyDay=(date,rows,by,reqBy)=>{const cur=S.days[date];const first=!cur;const rec={...(cur?.rec||{})};let hist=(cur?.history||[]).slice();const ch=[];let n=0;
    for(const [m,nr] of Object.entries(rows||{})){const o=rec[m];if(JSON.stringify(o)!==JSON.stringify(nr)){n++;if(!first)for(const f of ["teamId","opId","loc","status","hrs","hStart","hEnd","fuel","note"]){if(JSON.stringify(o?.[f]??null)!==JSON.stringify(nr?.[f]??null)&&ch.length<40)ch.push({m,f,a:o?.[f]??"",b:nr?.[f]??""});}rec[m]=nr;}}
    if(!n)return {changed:0};const h={at:new Date().toISOString(),by,n,ch};if(first)h.first=true;if(reqBy)h.requestedBy=reqBy;hist.push(h);hist=hist.slice(-20);
    S.days[date]={date,rec,saved_by:by,saved_at:new Date().toISOString(),history:hist};return {changed:n};};
  const F={
    mach_login:({p_email,p_password})=>{const p=Object.values(S.people).find(x=>x.email?.toLowerCase()===String(p_email).trim().toLowerCase()&&x.active);if(!p||S.pins[p.id]?.pw!==p_password)err("bad_login");const tok=crypto.randomBytes(12).toString("hex");S.sessions[tok]=p.id;p.lastLogin=new Date().toISOString();return {token:tok,person:p.id,name:p.name,role:p.role,mustChange:!!S.pins[p.id].must};},
    mach_logout:({p_token})=>{delete S.sessions[p_token];return null;},
    mach_change_password:({p_token,p_old,p_new})=>{const p=req(p_token);if(String(p_new).length<6)err("too_short");if(S.pins[p.id].pw!==p_old)err("bad_old");S.pins[p.id]={pw:p_new,must:false};return null;},
    mach_fetch:({p_token})=>{const p=req(p_token);const days={};for(const [k,v] of Object.entries(S.days))days[k]={date:k,rec:v.rec,savedBy:v.saved_by,savedAt:v.saved_at,history:v.history};
      const requests={};for(const [k,v] of Object.entries(S.requests))requests[k]={...v.data,id:k,type:v.type,status:v.status};
      return {me:{person:p.id,name:p.name,role:p.role,mustChange:!!S.pins[p.id]?.must},people:Object.values(S.people).map(x=>({id:x.id,name:x.name,role:x.role,active:x.active,email:p.role==="admin"?x.email:null,lastLogin:p.role==="admin"?(x.lastLogin||null):null})),machines:S.machines,teams:S.teams,operators:S.operators,days,incidents:S.incidents,requests,settings:S.settings.site||{}};},
    mach_save_day:({p_token,p_date,p_rows})=>{const p=req(p_token,false,true);if(!/^\d{4}-\d\d-\d\d$/.test(p_date))err("bad_date");if(p.role!=="admin"&&p_date<addDays(TODAY,-lock()))err("locked");return applyDay(p_date,p_rows,p.id,null);},
    mach_ref_upsert:({p_token,p_col,p_id,p_data})=>{req(p_token,true);if(!S[p_col]||!["machines","teams","operators"].includes(p_col))err("bad_col");S[p_col][p_id]=p_data;return null;},
    mach_set_setting:({p_token,p_key,p_value})=>{req(p_token,true);S.settings[p_key]=p_value;return null;},
    mach_incident_set:({p_token,p_id,p_data})=>{req(p_token,false,true);S.incidents[p_id]=p_data;return null;},
    mach_incident_delete:({p_token,p_id})=>{req(p_token,true);delete S.incidents[p_id];return null;},
    mach_request_create:({p_token,p_id,p_type,p_payload,p_summary})=>{const p=req(p_token,false,true);if(!["machine_add","toggle","team_add","operator_add","day_edit"].includes(p_type))err("bad_type");S.requests[p_id]={type:p_type,status:"pending",data:{payload:p_payload,summary:p_summary||"",by:p.id,at:new Date().toISOString()}};return null;},
    mach_decide:({p_token,p_id,p_approve})=>{const p=req(p_token,true);const r=S.requests[p_id];if(!r)err("no_request");if(r.status!=="pending")err("already_decided");const pl=r.data.payload||{};
      if(p_approve){if(r.type==="machine_add"){const m=pl.machine;S.machines[m.id]={...(S.machines[m.id]||{}),...Object.fromEntries(Object.entries(m).filter(([k,v])=>v!=null)),active:true};}
        else if(r.type==="team_add"){S.teams[pl.team.id]={...(S.teams[pl.team.id]||{}),...pl.team,active:true};}
        else if(r.type==="operator_add"){S.operators[pl.operator.id]={...(S.operators[pl.operator.id]||{}),...pl.operator,active:true};}
        else if(r.type==="toggle"){const o=S[pl.col]?.[pl.id];if(o)o.active=!!pl.active;}
        else if(r.type==="day_edit"){applyDay(pl.date,pl.rows,p.id,r.data.by);}}
      r.status=p_approve?"approved":"rejected";r.data.decidedBy=p.id;r.data.decidedAt=new Date().toISOString();return null;},
    mach_upsert_person:({p_token,p_id,p_name,p_email,p_role,p_active,p_password})=>{const p=req(p_token,true);if(!["admin","user","viewer"].includes(p_role))err("bad_role");if(!p_email||!p_email.includes("@"))err("bad_email");if(!String(p_name||"").trim())err("name_required");
      const id=p_id||("p"+crypto.randomBytes(5).toString("hex"));if(id===p.id&&(p_role!=="admin"||p_active===false)){if(!Object.values(S.people).some(x=>x.role==="admin"&&x.active&&x.id!==p.id))err("last_admin");}
      if(Object.values(S.people).some(x=>x.id!==id&&x.email?.toLowerCase()===p_email.toLowerCase()))err('duplicate key value violates unique constraint "people_email_idx"');
      S.people[id]={id,name:p_name.trim(),email:p_email.toLowerCase(),role:p_role,active:p_active!==false};
      if(p_password&&p_password.length>=6){S.pins[id]={pw:p_password,must:true};if(id!==p.id)for(const [t,pid] of Object.entries(S.sessions))if(pid===id)delete S.sessions[t];}
      return S.people[id];},
    mach_sessions:({p_token})=>{req(p_token,true);return Object.entries(S.sessions).map(([t,pid])=>({person:pid,at:new Date().toISOString()}));},
    mach_revoke_person:({p_token,p_person})=>{req(p_token,true);for(const [t,pid] of Object.entries(S.sessions))if(pid===p_person&&t!==p_token)delete S.sessions[t];return null;},
  };
  return {S,call:(name,args)=>{if(!F[name])throw new Error("no such function "+name);return F[name](args||{});}};
}

/* ---------- tarayıcı yardımcıları ---------- */
(async()=>{
  const server=makeServer();
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'});
  const site=fs.mkdtempSync('/tmp/asysapp-');for(const f of fs.readdirSync(ROOT)){if(f===".git"||f==="tests"||f==="db")continue;const s=path.join(ROOT,f);if(fs.statSync(s).isDirectory())fs.cpSync(s,path.join(site,f),{recursive:true});else fs.copyFileSync(s,path.join(site,f));}
  fs.writeFileSync(path.join(site,'config.js'),'window.MACH_CONFIG={url:"https://test.supabase.co",key:"test-key"};');
  let html=fs.readFileSync(path.join(site,'index.html'),'utf8').replace(/function isoToday\(\)\{[^}]*\}/,`function isoToday(){return "${TODAY}"}`);fs.writeFileSync(path.join(site,'index.html'),html);
  async function open(opts={}){
    const ctx=await b.newContext({viewport:opts.mobile?{width:390,height:844}:{width:1300,height:900},acceptDownloads:true});const pg=await ctx.newPage();const errs=[];
    pg.on('pageerror',e=>errs.push(e.message));pg.on('console',m=>{if(m.type()==='error'&&!/net::|TUNNEL|Failed to load resource|ServiceWorker|bad_login|duplicate key|last_admin|locked|read_only|admin_required|bad_old/.test(m.text()))errs.push('console: '+m.text());});
    await pg.route(/cdn\.jsdelivr\.net|fonts\.g/,r=>r.abort());
    await pg.exposeFunction('__rpc',(name,args)=>{try{return {data:server.call(name,args)};}catch(e){return {error:{message:e.message}};}});
    await pg.addInitScript(()=>{window.supabase={createClient:()=>({rpc:async(n,a)=>{const r=await window.__rpc(n,a);return r.error?{data:null,error:r.error}:{data:r.data,error:null};}})};});
    if(opts.token)await pg.addInitScript(t=>{localStorage.setItem("asys-mach:token",t);},opts.token);
    await pg.goto('file://'+site+'/index.html',{waitUntil:'load'});await pg.waitForTimeout(600);
    return {pg,ctx,errs};
  }
  const login=async(pg,email,pw)=>{await pg.fill('#lEmail',email);await pg.fill('#lPass',pw);await pg.click('#lBtn');await pg.waitForTimeout(500);};
  const vis=async(pg,sel)=>pg.locator(sel).isVisible();

  /* A. giriş + zorunlu şifre değişimi (admin) */
  let A=await open();
  ok("A1 Oturum yok → giriş penceresi, veri yok",await vis(A.pg,'#mLogin')&&(await A.pg.locator('#entryTbl tr[data-id]').count())===0);
  await login(A.pg,'huseyin.ozkan@asys-machinery.com','yanlis');
  ok("A2 Yanlış şifre → hata metni, pencere açık",/Неверный/.test(await A.pg.textContent('#lErr'))&&await vis(A.pg,'#mLogin'));
  await login(A.pg,'huseyin.ozkan@asys-machinery.com','Gecici123');
  ok("A3 Doğru giriş → pencere kapandı, zorunlu şifre penceresi açıldı",!(await vis(A.pg,'#mLogin'))&&await vis(A.pg,'#mPw')&&(await A.pg.locator('#pwCancel').evaluate(e=>getComputedStyle(e).display))==="none");
  await A.pg.fill('#pwOld','Gecici123');await A.pg.fill('#pwNew','Admin12345');await A.pg.fill('#pwNew2','Admin12346');await A.pg.click('#pwSave');await A.pg.waitForTimeout(200);
  ok("A4 Şifreler eşleşmiyor uyarısı",/не совпадают/.test(await A.pg.textContent('#pwErr')));
  await A.pg.fill('#pwNew2','Admin12345');await A.pg.click('#pwSave');await A.pg.waitForTimeout(400);
  ok("A5 Şifre değişti, pencere kapandı",!(await vis(A.pg,'#mPw'))&&server.S.pins["p-huseyin"].pw==="Admin12345"&&server.S.pins["p-huseyin"].must===false);
  ok("A6 Rozet: Hüseyin Özkan · Администратор",/Hüseyin Özkan/.test(await A.pg.textContent('#whoami'))&&/Администратор/.test(await A.pg.textContent('#whoami')));
  await A.pg.waitForTimeout(300);
  ok("A7 Veri yüklendi: 48 makine, 13 gün",Object.keys(await A.pg.evaluate(()=>machines)).length===48&&Object.keys(await A.pg.evaluate(()=>days)).length===13);
  await A.pg.click('text=Журнал дня');await A.pg.waitForTimeout(400);
  ok("A8 10.11 günü dünden (09.11) ön-doldu: 48 satır",(await A.pg.locator('#entryTbl tr[data-id]').count())===48);
  ok("A9 Puantaj son kayıtlı güne (09.11) atladı",(await A.pg.evaluate(()=>puanDate))==="2026-11-09");

  /* B. kişiler yönetimi (Ayarlar sekmesi) */
  await A.pg.click('text=Справочники');await A.pg.waitForTimeout(300);
  ok("B0 Tanımlar'da artık kullanıcı/ayar kartı yok",!(await vis(A.pg,'#pplForm'))&&!(await vis(A.pg,'#zonesTxt'))&&(await A.pg.locator('#ref .card').count())===4);
  await A.pg.click('text=Настройки');await A.pg.waitForTimeout(300);
  ok("B1 Ayarlar: kişiler formu admin'e görünür, e-posta + son giriş sütunu var",await vis(A.pg,'#pplForm')&&/huseyin.ozkan@/.test(await A.pg.textContent('#pplList'))&&/Последний вход/.test(await A.pg.textContent('#pplList')));
  await A.pg.fill('#projInp','Wildberries Astana · Склад 2');await A.pg.click('#saveProj');await A.pg.waitForTimeout(300);
  ok("B1b Proje adı ayardan değişti → başlıkta",server.S.settings.site.project==='Wildberries Astana · Склад 2'&&/Склад 2/.test(await A.pg.textContent('#hdrProj')));
  await A.pg.click('#addPerson');await A.pg.waitForTimeout(200);
  ok("B2 Boş form → uyarı",/Заполните/.test(await A.pg.textContent('#toast')));
  await A.pg.fill('#pName','Бауыржан Беркынбай');await A.pg.fill('#pEmail','bauyrzhan@test.kz');await A.pg.selectOption('#pRole','user');await A.pg.fill('#pPass','Gecici123');await A.pg.click('#addPerson');await A.pg.waitForTimeout(400);
  await A.pg.fill('#pName','Гость');await A.pg.fill('#pEmail','viewer@test.kz');await A.pg.selectOption('#pRole','viewer');await A.pg.fill('#pPass','Gecici123');await A.pg.click('#addPerson');await A.pg.waitForTimeout(400);
  ok("B3 İki kişi eklendi, tabloda görünüyor",Object.keys(server.S.people).length===3&&/Бауыржан/.test(await A.pg.textContent('#pplList'))&&/Гость/.test(await A.pg.textContent('#pplList')));
  await A.pg.fill('#pName','Tekrar');await A.pg.fill('#pEmail','bauyrzhan@test.kz');await A.pg.fill('#pPass','Gecici123');await A.pg.click('#addPerson');await A.pg.waitForTimeout(300);
  ok("B4 Aynı e-posta → uyarı, eklenmedi",/уже есть/.test(await A.pg.textContent('#toast'))&&Object.keys(server.S.people).length===3);
  const selfRole=A.pg.locator('#pplList tr').filter({hasText:'Hüseyin'}).locator('select');await selfRole.selectOption('user');await A.pg.waitForTimeout(300);
  ok("B5 Son yönetici kendini düşüremez",/последний администратор/.test(await A.pg.textContent('#toast'))&&server.S.people["p-huseyin"].role==="admin");
  await A.pg.locator('#pplList a').filter({hasText:'bauyrzhan@test.kz'}).click();await A.pg.waitForTimeout(200);ok("B5a E-posta düzenleme penceresi açıldı",await vis(A.pg,'#mInput'));await A.pg.fill('#inpVal','bauyrzhan@asys-machinery.com');await A.pg.click('#inpOk');await A.pg.waitForTimeout(400);
  ok("B5b E-posta tablodan düzenlendi",Object.values(server.S.people).some(x=>x.email==='bauyrzhan@asys-machinery.com')&&!Object.values(server.S.people).some(x=>x.email==='bauyrzhan@test.kz'));
  await A.pg.locator('#pplList a').filter({hasText:'bauyrzhan@asys-machinery.com'}).click();await A.pg.waitForTimeout(200);await A.pg.fill('#inpVal','bauyrzhan@test.kz');await A.pg.click('#inpOk');await A.pg.waitForTimeout(400);
  await A.pg.locator('#pplList button').filter({hasText:/Сбросить/}).last().click();await A.pg.waitForTimeout(200);await A.pg.fill('#inpVal','Yeni12345');await A.pg.click('#inpOk');await A.pg.waitForTimeout(400);
  ok("B5c Şifre sıfırlama modal ile çalıştı",Object.values(server.S.pins).some(x=>x.pw==='Yeni12345'&&x.must===true));
  await A.pg.locator('#pplList button').filter({hasText:/Сбросить/}).last().click();await A.pg.waitForTimeout(200);await A.pg.fill('#inpVal','Gecici123');await A.pg.click('#inpOk');await A.pg.waitForTimeout(400);
  ok("B6 Admin oturumu hatasız",A.errs.length===0,A.errs.join("|"));

  /* C. kullanıcı: günlük kayıt → sunucu merge + geçmiş */
  const U=await open();await login(U.pg,'bauyrzhan@test.kz','Gecici123');await U.pg.waitForTimeout(300);
  ok("C1 Kullanıcı girişi → zorunlu şifre penceresi",await vis(U.pg,'#mPw'));
  await U.pg.fill('#pwOld','Gecici123');await U.pg.fill('#pwNew','User12345');await U.pg.fill('#pwNew2','User12345');await U.pg.click('#pwSave');await U.pg.waitForTimeout(300);
  await U.pg.click('text=Настройки');await U.pg.waitForTimeout(300);
  ok("C2 Kullanıcı: rozet Пользователь; Ayarlar'da yalnız Hesabım (kişiler/proje/bölge gizli)",/Пользователь/.test(await U.pg.textContent('#whoami'))&&await vis(U.pg,'#accCard')&&!(await vis(U.pg,'#pplForm'))&&!(await vis(U.pg,'#projInp'))&&/Бауыржан/.test(await U.pg.textContent('#accInfo')));
  await U.pg.click('text=Журнал дня');await U.pg.waitForTimeout(300);
  const row=U.pg.locator('#entryTbl tr[data-id="dmp-03"]');await row.locator('[data-f=status]').selectOption('broken');await row.locator('[data-f=note]').fill('гидравлика');
  await U.pg.click('#saveDay');await U.pg.waitForTimeout(300);if(await vis(U.pg,'#modal'))await U.pg.click('#modalYes');await U.pg.waitForTimeout(600);
  const d10=server.S.days[TODAY];
  ok("C3 10.11 kaydı oluştu (ilk kayıt, 48 satır, saved_by kullanıcı)",!!d10&&Object.keys(d10.rec).length===48&&d10.history.length===1&&d10.history[0].first===true&&d10.saved_by!=="p-huseyin");
  ok("C4 Д-03 broken + not",d10.rec["dmp-03"].status==="broken"&&d10.rec["dmp-03"].note==="гидравлика");
  ok("C5 Toast: Сохранено · N работает",/Сохранено · \d+/.test(await U.pg.textContent('#toast')),await U.pg.textContent('#toast'));
  // admin aynı anda Д-01'i değiştiriyor (ayrı istemci) — kullanıcının eski kopyası ezmesin
  await A.pg.evaluate(()=>loadAll());await A.pg.waitForTimeout(300);await A.pg.click('text=Журнал дня');await A.pg.waitForTimeout(300);
  await A.pg.locator('#entryTbl tr[data-id="dmp-01"] [data-f=status]').selectOption('maint');await A.pg.click('#saveDay');await A.pg.waitForTimeout(300);if(await vis(A.pg,'#modal'))await A.pg.click('#modalYes');await A.pg.waitForTimeout(500);
  await row.locator('[data-f=note]').fill('гидравлика течёт');await U.pg.click('#saveDay');await U.pg.waitForTimeout(300);if(await vis(U.pg,'#modal'))await U.pg.click('#modalYes');await U.pg.waitForTimeout(600);
  const d10b=server.S.days[TODAY];
  ok("C6 Eşzamanlı: admin'in Д-01 ТО kaydı korundu, kullanıcının Д-03 notu güncellendi",d10b.rec["dmp-01"].status==="maint"&&d10b.rec["dmp-03"].note==="гидравлика течёт");
  ok("C7 Geçmiş: 3 kayıt, sonuncusu 1 satır / alan 'note' a→b",d10b.history.length===3&&d10b.history[2].n===1&&d10b.history[2].ch[0].f==="note"&&d10b.history[2].ch[0].a==="гидравлика"&&d10b.history[2].ch[0].b==="гидравлика течёт",JSON.stringify(d10b.history[2]));
  await U.pg.click('text=Пуантаж');await U.pg.waitForTimeout(300);await U.pg.evaluate(()=>{puanDate=isoToday();document.getElementById("puanDate").value=puanDate;renderPuan();});await U.pg.waitForTimeout(300);
  const hist=await U.pg.textContent('#puanHistBody').catch(()=>"");
  ok("C8 Geçmiş ekranında isimler (Hüseyin Özkan / Бауыржан) ve Д-03",/Hüseyin Özkan/.test(hist)&&/Бауыржан/.test(hist)&&/Д-03/.test(hist),hist.slice(0,160));

  /* D. kilitli gün → talep → onay */
  await U.pg.click('text=Журнал дня');await U.pg.waitForTimeout(200);
  await U.pg.evaluate(()=>{entryDate="2026-11-01";entryDirty.clear();document.getElementById("entryDate").value=entryDate;loadEntryDay();});await U.pg.waitForTimeout(300);
  ok("D1 Kilitli gün uyarısı görünür",await vis(U.pg,'#lockNote'));
  await U.pg.locator('#entryTbl tr[data-id="dmp-05"] [data-f=status]').selectOption('absent');await U.pg.click('#saveDay');await U.pg.waitForTimeout(300);if(await vis(U.pg,'#modal'))await U.pg.click('#modalYes');await U.pg.waitForTimeout(500);
  const rq=Object.values(server.S.requests);
  ok("D2 Kilitli gün → day_edit talebi, gün değişmedi",rq.length===1&&rq[0].type==="day_edit"&&server.S.days["2026-11-01"].rec["dmp-05"].status!=="absent");
  await A.pg.evaluate(()=>loadAll());await A.pg.waitForTimeout(300);await A.pg.click('text=Запросы');await A.pg.waitForTimeout(300);
  ok("D3 Admin talebi görüyor (rozet 1)",(await A.pg.textContent('#reqBadge')).trim()==="1"&&/Д-05/.test(await A.pg.textContent('#reqBody')));
  await A.pg.locator('#reqBody button').filter({hasText:/Подтвердить/}).first().click();await A.pg.waitForTimeout(600);
  const d01=server.S.days["2026-11-01"];
  ok("D4 Onay → sunucuda uygulandı, geçmişte requestedBy",d01.rec["dmp-05"].status==="absent"&&d01.history[d01.history.length-1].requestedBy!=="p-huseyin"&&d01.history[d01.history.length-1].by==="p-huseyin"&&rq[0].status==="approved");

  /* E. makine ekleme talebi + red */
  await U.pg.click('text=Справочники');await U.pg.waitForTimeout(200);await U.pg.fill('#mCode','Д-21');await U.pg.fill('#mBrand','Тест 1');await U.pg.click('#addMachine');await U.pg.waitForTimeout(400);
  ok("E1 Kullanıcı makine ekleme → talep (makine yok)",Object.values(server.S.requests).some(r=>r.type==="machine_add")&&!Object.values(server.S.machines).some(m=>m.code==="Д-21"));
  await A.pg.evaluate(()=>loadAll());await A.pg.waitForTimeout(300);await A.pg.click('text=Запросы');await A.pg.waitForTimeout(200);
  await A.pg.locator('#reqBody button').filter({hasText:/Отклонить/}).first().click();await A.pg.waitForTimeout(500);
  ok("E2 Red → makine eklenmedi, talep rejected",!Object.values(server.S.machines).some(m=>m.code==="Д-21")&&Object.values(server.S.requests).find(r=>r.type==="machine_add").status==="rejected");
  ok("E3 Kullanıcı oturumu hatasız",U.errs.length===0,U.errs.join("|"));

  /* F. viewer */
  const V=await open();await login(V.pg,'viewer@test.kz','Gecici123');await V.pg.waitForTimeout(300);
  await V.pg.fill('#pwOld','Gecici123');await V.pg.fill('#pwNew','View12345');await V.pg.fill('#pwNew2','View12345');await V.pg.click('#pwSave');await V.pg.waitForTimeout(300);
  ok("F1 Viewer: rozet Просмотр, salt-okunur notu",/Просмотр/.test(await V.pg.textContent('#whoami'))&&/Только просмотр/.test(await V.pg.textContent('#roNote')));
  await V.pg.click('text=Журнал дня');await V.pg.waitForTimeout(300);
  ok("F2 Viewer: Kaydet pasif, veri görünüyor",await V.pg.locator('#saveDay').isDisabled()&&(await V.pg.locator('#entryTbl tr[data-id]').count())===48);
  await V.pg.click('text=Пуантаж');await V.pg.waitForTimeout(300);
  const [dl]=await Promise.all([V.pg.waitForEvent('download',{timeout:15000}),V.pg.click('#puanPrint')]);
  ok("F3 Viewer PDF'i doğrudan indirdi (onay penceresi yok)",/^asys-machinery-puantaj-\d{4}-\d\d-\d\d\.pdf$/.test(dl.suggestedFilename()),dl.suggestedFilename());
  const pdfPath=await dl.path();ok("F4 PDF dosyası > 20 KB",fs.statSync(pdfPath).size>20000);
  ok("F5 Viewer oturumu hatasız",V.errs.length===0,V.errs.join("|"));

  /* G. oturum iptali + çıkış */
  const uTok=Object.entries(server.S.sessions).find(([t,p])=>p===Object.values(server.S.people).find(x=>x.email==='bauyrzhan@test.kz').id);
  await A.pg.evaluate(id=>revokePerson(id),uTok[1]);await A.pg.waitForTimeout(300);
  await U.pg.evaluate(()=>loadAll());await U.pg.waitForTimeout(400);
  ok("G1 Admin oturumu iptal etti → kullanıcıda giriş penceresi 'Сеанс завершён'",await vis(U.pg,'#mLogin')&&/Сеанс завершён/.test(await U.pg.textContent('#lErr')));
  await A.pg.click('#whoami');await A.pg.waitForTimeout(200);ok("G2 Hesap penceresi: ad + rol + e-posta",await vis(A.pg,'#mAcc')&&/Hüseyin/.test(await A.pg.textContent('#accName'))&&/huseyin.ozkan@/.test(await A.pg.textContent('#accRole')));
  await A.pg.click('#accOut');await A.pg.waitForTimeout(300);
  ok("G3 Çıkış → giriş penceresi, token silindi, veri temizlendi",await vis(A.pg,'#mLogin')&&(await A.pg.evaluate(()=>localStorage.getItem("asys-mach:token")))===null&&Object.keys(await A.pg.evaluate(()=>machines)).length===0);

  /* H. kalıcı oturum: token ile yeniden açılış + telefon ekranı */
  const tok=Object.keys(server.S.sessions).find(t=>server.S.sessions[t]==="p-view")||Object.keys(server.S.sessions)[0];
  const M=await open({token:tok,mobile:true});
  ok("H1 Kayıtlı token ile açılış: giriş penceresi yok, veri yüklü",!(await vis(M.pg,'#mLogin'))&&Object.keys(await M.pg.evaluate(()=>machines)).length===48);
  await M.pg.screenshot({path:path.join(ROOT,'tests','shot-mobile.png')});await M.pg.click('text=Журнал дня');await M.pg.waitForTimeout(300);await M.pg.screenshot({path:path.join(ROOT,'tests','shot-mobile-entry.png')});
  const hb=await M.pg.evaluate(()=>{const r=document.querySelector('.hbar').getBoundingClientRect();const tr=[...document.querySelectorAll('.hbar .lang')].pop().getBoundingClientRect();return [Math.round(r.width),Math.round(tr.right)]});
  ok("H2 Telefonda üst bar taşmıyor",hb[1]<=390,JSON.stringify(hb));
  ok("H3 Mobil oturum hatasız",M.errs.length===0,M.errs.join("|"));
  await A.pg.screenshot({path:path.join(ROOT,'tests','shot-login.png')});
  await b.close();fs.rmSync(site,{recursive:true,force:true});
  console.log(`\n${pass} PASS / ${fail} FAIL`);process.exit(fail?1:0);
})().catch(e=>{console.error("HARNESS",e);process.exit(1)});
