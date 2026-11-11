// ASYS Machinery — uçtan uca tarayıcı testi (Playwright + bellek içi Supabase RPC taklidi)
// Çalıştırma: NODE_PATH=<playwright modülleri> node tests/app.test.js
// Taklit, db/schema.sql'deki mach_* fonksiyonlarının davranışını JS'te birebir uygular (roller, kilit, merge, geçmiş, talepler).
const {chromium}=require('playwright');const fs=require('fs');const path=require('path');const crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..');const DATA='/home/claude/pub';
const L=(dir)=>Object.fromEntries(fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!f.startsWith('.')).map(f=>[f.slice(0,-5),JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))]));
const TODAY="2026-11-10";
let pass=0,fail=0;const ok=(n,c,d="")=>{c?pass++:fail++;console.log((c?"PASS ":"FAIL ")+n+(c?"":" — "+d));};

const {makeServer}=require('./mock_server');
/* ---------- tarayıcı yardımcıları ---------- */
(async()=>{
  const server=makeServer();
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'});
  const site=fs.mkdtempSync('/tmp/asysapp-');for(const f of fs.readdirSync(ROOT)){if(f===".git"||f==="tests"||f==="db")continue;const s=path.join(ROOT,f);if(fs.statSync(s).isDirectory())fs.cpSync(s,path.join(site,f),{recursive:true});else fs.copyFileSync(s,path.join(site,f));}
  fs.writeFileSync(path.join(site,'config.js'),'window.MACH_CONFIG={url:"https://test.supabase.co",key:"test-key"};');
  let html=fs.readFileSync(path.join(site,'index.html'),'utf8').replace(/function isoToday\(\)\{[^}]*\}/,`function isoToday(){return "${TODAY}"}`);fs.writeFileSync(path.join(site,'index.html'),html);
  async function open(opts={}){
    const ctx=await b.newContext({viewport:opts.mobile?{width:390,height:844}:{width:1300,height:900},acceptDownloads:true});const pg=await ctx.newPage();const errs=[];
    pg.on('pageerror',e=>errs.push(e.message));pg.on('console',m=>{if(m.type()==='error'&&!/net::|TUNNEL|Failed to load resource|ServiceWorker|bad_login|duplicate key|last_admin|locked|read_only|admin_required|bad_old|site_has_machines|same_site|no_site_access|site_required/.test(m.text()))errs.push('console: '+m.text());});
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
  ok("B0 Tanımlar'da artık kullanıcı/ayar kartı yok",!(await vis(A.pg,'#pplForm'))&&!(await vis(A.pg,'#zonesTxt'))&&(await A.pg.locator('#ref .card').count())===5);
  await A.pg.click('text=Настройки');await A.pg.waitForTimeout(300);
  ok("B1 Ayarlar: kişiler formu admin'e görünür, e-posta + son giriş sütunu var",await vis(A.pg,'#pplForm')&&/huseyin.ozkan@/.test(await A.pg.textContent('#pplList'))&&/Последний вход/.test(await A.pg.textContent('#pplList')));
  await A.pg.locator('#sitesList tr').filter({hasText:'Wildberries Astana'}).locator('button').click();await A.pg.waitForTimeout(200);
  await A.pg.fill('#frmFields [data-k=name]','Wildberries Astana · Склад 2');await A.pg.click('#frmOk');await A.pg.waitForTimeout(300);
  ok("B1b Şantiye adı ayardan değişti → üst bar seçicide ve puantaj başlığında",server.S.sites['wb-astana'].name==='Wildberries Astana · Склад 2'&&/Склад 2/.test(await A.pg.textContent('#siteSel'))&&/Склад 2/.test(await A.pg.evaluate(()=>projectName())));
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
  // ad düzenleme, silme (kayıtsız kişi silinir, kayıtlı kişi silinmez)
  await A.pg.locator('#pplList a').filter({hasText:'Гость'}).click();await A.pg.waitForTimeout(200);await A.pg.fill('#inpVal','Гость Тест');await A.pg.click('#inpOk');await A.pg.waitForTimeout(400);
  ok("B7 Ad düzenlendi",Object.values(server.S.people).some(x=>x.name==='Гость Тест'));
  await A.pg.fill('#pName','Silinecek');await A.pg.fill('#pEmail','sil@test.kz');await A.pg.fill('#pPass','Gecici123');await A.pg.click('#addPerson');await A.pg.waitForTimeout(400);
  const delRow=A.pg.locator('#pplList tr').filter({hasText:'Silinecek'});await delRow.locator('button[title]').last().click();await A.pg.waitForTimeout(200);
  ok("B8 Silme onayı soruluyor",await vis(A.pg,'#modal'));await A.pg.click('#modalYes');await A.pg.waitForTimeout(400);
  ok("B9 Kayıtsız kullanıcı silindi",!Object.values(server.S.people).some(x=>x.email==='sil@test.kz')&&!/Silinecek/.test(await A.pg.textContent('#pplList')));
  ok("B10 Kendi satırında sil düğmesi yok",(await A.pg.locator('#pplList tr').filter({hasText:'Hüseyin'}).locator('button[title]').count())===0);
  // tanımlar: makine düzenle
  await A.pg.click('text=Справочники');await A.pg.waitForTimeout(300);
  await A.pg.locator('#refMach tr').filter({hasText:'Д-01'}).locator('button').filter({hasText:/Изменить/}).click();await A.pg.waitForTimeout(200);
  ok("B11 Makine düzenleme formu açıldı, kod dolu",await vis(A.pg,'#mForm')&&(await A.pg.inputValue('#frmFields [data-k=code]'))==='Д-01');
  await A.pg.fill('#frmFields [data-k=year]','2021');await A.pg.fill('#frmFields [data-k=plate]','777AAA01');await A.pg.click('#frmOk');await A.pg.waitForTimeout(400);
  ok("B12 Makine güncellendi (yıl, plaka), diğer alanlar korundu",server.S.machines['dmp-01'].year===2021&&server.S.machines['dmp-01'].plate==='777AAA01'&&server.S.machines['dmp-01'].brand==='HAULOTTE');
  await A.pg.locator('#refTeam tr').nth(1).locator('button').filter({hasText:/Изменить/}).click();await A.pg.waitForTimeout(200);await A.pg.fill('#frmFields [data-k=name]','Бригада Тест');await A.pg.click('#frmOk');await A.pg.waitForTimeout(400);
  ok("B13 Ekip adı değişti",Object.values(server.S.teams).some(x=>x.name==='Бригада Тест'));
  await A.pg.locator('#refOp tr').nth(1).locator('button').filter({hasText:/Изменить/}).click();await A.pg.waitForTimeout(200);const opName=await A.pg.inputValue('#frmFields [data-k=name]');await A.pg.fill('#frmFields [data-k=name]',opName+' X');await A.pg.click('#frmOk');await A.pg.waitForTimeout(400);
  ok("B14 Operatör adı değişti",Object.values(server.S.operators).some(x=>x.name===opName+' X'));
  ok("B6 Admin oturumu hatasız",A.errs.length===0,A.errs.join("|"));

  /* C. kullanıcı: günlük kayıt → sunucu merge + geçmiş */
  const U=await open();await login(U.pg,'bauyrzhan@test.kz','Gecici123');await U.pg.waitForTimeout(300);
  ok("C1 Kullanıcı girişi → zorunlu şifre penceresi",await vis(U.pg,'#mPw'));
  await U.pg.fill('#pwOld','Gecici123');await U.pg.fill('#pwNew','User12345');await U.pg.fill('#pwNew2','User12345');await U.pg.click('#pwSave');await U.pg.waitForTimeout(300);
  await U.pg.click('text=Настройки');await U.pg.waitForTimeout(300);
  ok("C2 Kullanıcı: rozet Пользователь; Ayarlar'da yalnız Hesabım (kişiler/proje/bölge gizli)",/Пользователь/.test(await U.pg.textContent('#whoami'))&&await vis(U.pg,'#accCard')&&!(await vis(U.pg,'#pplForm'))&&!(await vis(U.pg,'#sitesList'))&&/Бауыржан/.test(await U.pg.textContent('#accInfo')));
  await U.pg.click('text=Журнал дня');await U.pg.waitForTimeout(300);
  const row=U.pg.locator('#entryTbl tr[data-id="dmp-03"]');await row.locator('[data-f=status]').selectOption('broken');await row.locator('[data-f=note]').fill('гидравлика');
  const locSel=row.locator('[data-f=loc]');ok("C2b Bölge yalnızca listeden seçilir (select), seçenekler = ayar listesi",(await locSel.evaluate(e=>e.tagName))==='SELECT'&&(await locSel.locator('option').count())>=5);
  await locSel.selectOption({index:1});
  await U.pg.click('#saveDay');await U.pg.waitForTimeout(300);if(await vis(U.pg,'#modal'))await U.pg.click('#modalYes');await U.pg.waitForTimeout(600);
  const d10=server.S.days["wb-astana|"+TODAY];
  ok("C3 10.11 kaydı oluştu (ilk kayıt, 48 satır, saved_by kullanıcı)",!!d10&&Object.keys(d10.rec).length===48&&d10.history.length===1&&d10.history[0].first===true&&d10.saved_by!=="p-huseyin");
  ok("C4 Д-03 broken + not + serbest bölge",d10.rec["dmp-03"].status==="broken"&&d10.rec["dmp-03"].note==="гидравлика"&&d10.rec["dmp-03"].loc==="Склад N1");
  ok("C5 Toast: Сохранено · N работает",/Сохранено · \d+/.test(await U.pg.textContent('#toast')),await U.pg.textContent('#toast'));
  // admin aynı anda Д-01'i değiştiriyor (ayrı istemci) — kullanıcının eski kopyası ezmesin
  await A.pg.evaluate(()=>loadAll());await A.pg.waitForTimeout(300);await A.pg.click('text=Журнал дня');await A.pg.waitForTimeout(300);
  await A.pg.locator('#entryTbl tr[data-id="dmp-01"] [data-f=status]').selectOption('maint');await A.pg.click('#saveDay');await A.pg.waitForTimeout(300);if(await vis(A.pg,'#modal'))await A.pg.click('#modalYes');await A.pg.waitForTimeout(500);
  await row.locator('[data-f=note]').fill('гидравлика течёт');await U.pg.click('#saveDay');await U.pg.waitForTimeout(300);if(await vis(U.pg,'#modal'))await U.pg.click('#modalYes');await U.pg.waitForTimeout(600);
  const d10b=server.S.days["wb-astana|"+TODAY];
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
  ok("D2 Kilitli gün → day_edit talebi, gün değişmedi",rq.length===1&&rq[0].type==="day_edit"&&server.S.days["wb-astana|2026-11-01"].rec["dmp-05"].status!=="absent");
  await A.pg.evaluate(()=>loadAll());await A.pg.waitForTimeout(300);await A.pg.click('text=Запросы');await A.pg.waitForTimeout(300);
  ok("D3 Admin talebi görüyor (rozet 1)",(await A.pg.textContent('#reqBadge')).trim()==="1"&&/Д-05/.test(await A.pg.textContent('#reqBody')));
  await A.pg.locator('#reqBody button').filter({hasText:/Подтвердить/}).first().click();await A.pg.waitForTimeout(600);
  const d01=server.S.days["wb-astana|2026-11-01"];
  ok("D4 Onay → sunucuda uygulandı, geçmişte requestedBy",d01.rec["dmp-05"].status==="absent"&&d01.history[d01.history.length-1].requestedBy!=="p-huseyin"&&d01.history[d01.history.length-1].by==="p-huseyin"&&rq[0].status==="approved");

  /* D2. arıza düzenleme (admin) */
  server.call('mach_incident_set',{p_token:Object.keys(server.S.sessions).find(t=>server.S.sessions[t]==='p-huseyin'),p_id:'incX',p_data:{id:'incX',date:'2026-11-09',machineId:'dmp-04',type:'breakdown',opId:'',teamId:'',down:2,cost:0,desc:'старое',open:true,by:'p-huseyin'}});
  await A.pg.evaluate(()=>loadAll());await A.pg.waitForTimeout(300);await A.pg.click('text=Поломки');await A.pg.waitForTimeout(300);
  await A.pg.locator('#incTbl tr').filter({hasText:'Д-04'}).locator('button').filter({hasText:/Изменить/}).click();await A.pg.waitForTimeout(200);
  await A.pg.fill('#frmFields [data-k=desc]','новое описание');await A.pg.fill('#frmFields [data-k=down]','6');await A.pg.click('#frmOk');await A.pg.waitForTimeout(400);
  ok("D5 Arıza kaydı düzenlendi (açıklama, duruş)",server.S.incidents.incX.desc==='новое описание'&&server.S.incidents.incX.down===6&&server.S.incidents.incX.open===true);

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

  /* S. ÇOKLU ŞANTİYE */
  await login(A.pg,'huseyin.ozkan@asys-machinery.com','Admin12345');await A.pg.waitForTimeout(400);
  await A.pg.click('text=Настройки');await A.pg.waitForTimeout(300);
  ok("S0 Tek şantiye: seçici tek seçenekli, Makine Parkı 0",(await A.pg.locator('#siteSel option').count())===1&&/0 в парке/.test(await A.pg.textContent('#parkNote')));
  await A.pg.fill('#siteNewName','Wildberries Almaty');await A.pg.click('#addSite');await A.pg.waitForTimeout(400);
  const almId=Object.keys(server.S.sites).find(k=>k!=='wb-astana');
  ok("S1 Şantiye eklendi; seçicide 2 şantiye + «Все объекты»",!!almId&&(await A.pg.locator('#siteSel option').count())===3&&/Все объекты/.test(await A.pg.textContent('#siteSel')));
  ok("S1b Kullanıcı satırında şantiye özeti düğmesi (Бауыржан: Astana)",/Wildberries Astana/.test(await A.pg.locator('#pplList tr').filter({hasText:'Бауыржан'}).locator('button').filter({hasText:'✎'}).textContent()));
  // Almaty'ye geç: boş şantiye
  await A.pg.selectOption('#siteSel',almId);await A.pg.waitForTimeout(400);
  ok("S2 Almaty seçildi: makine yok, bölge/kilit kartı Almaty'yi gösteriyor",Object.keys(await A.pg.evaluate(()=>machines)).length===0&&/Wildberries Almaty/.test(await A.pg.textContent('#set .siteName'))&&(await A.pg.evaluate(()=>projectName()))==='Wildberries Almaty');
  await A.pg.fill('#zonesTxt','Блок A\nБлок B');await A.pg.click('#saveZones');await A.pg.waitForTimeout(300);
  ok("S3 Bölgeler şantiyeye kaydedildi (Astana etkilenmedi)",JSON.stringify(server.S.sites[almId].data.zones)==='["Блок A","Блок B"]'&&!(server.S.sites['wb-astana'].data.zones||[]).length);
  // makine taşı: Astana → Almaty (admin doğrudan)
  await A.pg.click('text=Справочники');await A.pg.waitForTimeout(300);
  ok("S4 Tanımlar: admin tüm parkı görür (48), Konum sütunu var",(await A.pg.locator('#refMach tr').count())===49&&/Объект/.test(await A.pg.textContent('#refMach')));
  await A.pg.locator('#refMach tr').filter({hasText:'Д-01'}).locator('button').filter({hasText:'Переместить'}).click();await A.pg.waitForTimeout(200);
  ok("S5 Taşıma formu açıldı",await vis(A.pg,'#mForm')&&/Д-01/.test(await A.pg.textContent('#frmTitle')));
  await A.pg.selectOption('#frmFields [data-k=toSite]',almId);await A.pg.fill('#frmFields [data-k=note]','кран нужен');await A.pg.click('#frmOk');await A.pg.waitForTimeout(400);
  ok("S6 Д-01 Almaty'ye taşındı, günlükte kayıt",server.S.machines['dmp-01'].site===almId&&server.S.moves.length===1&&server.S.moves[0].note==='кран нужен'&&/Переместить/.test(await A.pg.textContent('#movesBox'))===false&&/Д-01/.test(await A.pg.textContent('#movesList')));
  ok("S7 Almaty görünümünde 1 makine",Object.keys(await A.pg.evaluate(()=>machines)).length===1);
  // Almaty'de gün kaydı
  await A.pg.click('text=Журнал дня');await A.pg.waitForTimeout(400);
  ok("S8 Almaty günlük kayıt: 1 satır, bölge listesi Almaty'nin",(await A.pg.locator('#entryTbl tr[data-id]').count())===1&&/Блок A/.test(await A.pg.textContent('#entryTbl')));
  const astanaBefore=JSON.stringify(server.S.days['wb-astana|'+TODAY]);
  await A.pg.locator('#entryTbl tr[data-id="dmp-01"] [data-f=status]').selectOption('idle');await A.pg.click('#saveDay');await A.pg.waitForTimeout(300);if(await vis(A.pg,'#modal'))await A.pg.click('#modalYes');await A.pg.waitForTimeout(600);
  ok("S9 Kayıt Almaty anahtarına yazıldı; Astana'nın bugünü etkilenmedi",!!server.S.days[almId+'|'+TODAY]&&server.S.days[almId+'|'+TODAY].rec['dmp-01'].status==='idle'&&Object.keys(server.S.days[almId+'|'+TODAY].rec).length===1&&JSON.stringify(server.S.days['wb-astana|'+TODAY])===astanaBefore);
  // Tüm şantiyeler görünümü
  await A.pg.selectOption('#siteSel','*');await A.pg.waitForTimeout(400);
  ok("S10 «Все объекты»: 48 makine, günlük kayıt kapalı, bugün birleşik",Object.keys(await A.pg.evaluate(()=>machines)).length===48&&(await A.pg.locator('#entryTbl tr[data-id]').count())===0&&(await A.pg.isDisabled('#saveDay'))&&/Все объекты/.test(await A.pg.textContent('#roNote')));
  await A.pg.click('text=Сегодня');await A.pg.waitForTimeout(200);
  ok("S10b Bugün (tüm park): Almaty'deki Д-01 dahil 48 kayıt",(await A.pg.evaluate(()=>Object.keys(days[isoToday()]?.rec||{}).length))===48);
  // kullanıcı: yalnız Astana'yı görür; Almaty'deki makineyi görmez; park makinesini görür ve talep eder
  server.S.machines['dmp-02'].site='';
  const U2=await open();await login(U2.pg,'bauyrzhan@test.kz','User12345');await U2.pg.waitForTimeout(500);
  ok("S11 Kullanıcı: seçici yalnız Astana (1 seçenek, «Все объекты» yok), 46 makine",(await U2.pg.locator('#siteSel option').count())===1&&!/Все объекты/.test(await U2.pg.textContent('#siteSel'))&&Object.keys(await U2.pg.evaluate(()=>machines)).length===46);
  await U2.pg.click('text=Справочники');await U2.pg.waitForTimeout(300);
  const refTxt=await U2.pg.textContent('#refMach');
  ok("S12 Tanımlar (kullanıcı): Astana makineleri + parktaki Д-02 görünür, Almaty'deki Д-01 görünmez",/Д-02/.test(refTxt)&&!/Д-01/.test(refTxt)&&/Парк техники/.test(refTxt));
  await U2.pg.locator('#refMach tr').filter({hasText:'Д-02'}).locator('button').filter({hasText:'Переместить'}).click();await U2.pg.waitForTimeout(200);
  ok("S13 Kullanıcı taşıma formu: hedef yalnız kendi şantiyesi",(await U2.pg.locator('#frmFields [data-k=toSite] option').count())===1);
  await U2.pg.click('#frmOk');await U2.pg.waitForTimeout(400);
  const mvReq=Object.values(server.S.requests).find(r=>r.type==='machine_move');
  ok("S14 Taşıma talebi oluştu (pending, site=Astana), makine henüz parkta",!!mvReq&&mvReq.status==='pending'&&mvReq.site==='wb-astana'&&server.S.machines['dmp-02'].site==='');
  // admin onaylar
  await A.pg.evaluate(()=>loadAll());await A.pg.waitForTimeout(400);await A.pg.click('text=Запросы');await A.pg.waitForTimeout(500);
  ok("S15 Talep kartında makine, nereden → nereye",/Д-02/.test(await A.pg.textContent('#reqBody'))&&/Парк техники/.test(await A.pg.textContent('#reqBody'))&&/Wildberries Astana/.test(await A.pg.textContent('#reqBody')));
  await A.pg.locator('#reqBody .card.pending').filter({hasText:'Д-02'}).locator('button').filter({hasText:'Подтвердить'}).click();await A.pg.waitForTimeout(500);
  ok("S16 Onay → Д-02 Astana'ya taşındı, günlük 2 kayıt",server.S.machines['dmp-02'].site==='wb-astana'&&server.S.moves.length===2);
  // kullanıcıya Almaty yetkisi ver → seçici 2 seçenek
  await A.pg.click('text=Настройки');await A.pg.waitForTimeout(300);
  await A.pg.locator('#pplList tr').filter({hasText:'Бауыржан'}).locator('button').filter({hasText:'✎'}).click();await A.pg.waitForTimeout(200);
  ok("S16b Şantiye seçim penceresi: liste + Tümü/Hiçbiri",await vis(A.pg,'#mForm')&&(await A.pg.locator('#pkList input').count())===2&&(await A.pg.locator('#pkList input:checked').count())===1);
  await A.pg.locator('#pkList label').filter({hasText:'Almaty'}).locator('input').check();await A.pg.click('#frmOk');await A.pg.waitForTimeout(400);
  ok("S17 Kullanıcıya Almaty yetkisi verildi",JSON.stringify(Object.values(server.S.people).find(p=>p.email==='bauyrzhan@test.kz').sites.sort())==='["'+[almId,'wb-astana'].sort().join('","')+'"]');
  await U2.pg.waitForTimeout(100);await U2.pg.evaluate(()=>loadAll());await U2.pg.waitForTimeout(400);
  ok("S18 Kullanıcı seçicisinde artık 2 şantiye («Все объекты» yok)",(await U2.pg.locator('#siteSel option').count())===2&&!/Все объекты/.test(await U2.pg.textContent('#siteSel')));
  // makinesi olan şantiye pasif yapılamaz
  await A.pg.locator('#sitesList tr').filter({hasText:'Almaty'}).locator('button').click();await A.pg.waitForTimeout(200);await A.pg.selectOption('#frmFields [data-k=active]','0');await A.pg.click('#frmOk');await A.pg.waitForTimeout(300);
  ok("S19 Makinesi olan şantiye pasif yapılamaz → uyarı",/переместите/.test(await A.pg.textContent('#toast'))&&server.S.sites[almId].active===true);
  // şantiye silme: verisi olanda düğme yok; boş şantiye onayla silinir
  await A.pg.fill('#siteNewName','Geçici Şantiye');await A.pg.click('#addSite');await A.pg.waitForTimeout(400);
  const tmpId=Object.keys(server.S.sites).find(k=>server.S.sites[k].name==='Geçici Şantiye');
  ok("S19b Verisi olan şantiyede Sil düğmesi yok, boş şantiyede var",(await A.pg.locator('#sitesList tr').filter({hasText:'Wildberries Almaty'}).locator('button').filter({hasText:'Удалить'}).count())===0&&(await A.pg.locator('#sitesList tr').filter({hasText:'Geçici Şantiye'}).locator('button').filter({hasText:'Удалить'}).count())===1);
  await A.pg.locator('#sitesList tr').filter({hasText:'Geçici Şantiye'}).locator('button').filter({hasText:'Удалить'}).click();await A.pg.waitForTimeout(200);
  ok("S19c Silme onayı soruldu",await vis(A.pg,'#modal')&&/Geçici Şantiye/.test(await A.pg.textContent('#modalMsg')));
  await A.pg.click('#modalYes');await A.pg.waitForTimeout(400);
  ok("S19d Boş şantiye silindi, listeden ve seçiciden düştü",!server.S.sites[tmpId]&&!/Geçici Şantiye/.test(await A.pg.textContent('#sitesList'))&&!/Geçici Şantiye/.test(await A.pg.textContent('#siteSel')));
  ok("S20 Çoklu şantiye akışında sayfa hatası yok",A.errs.length===0&&U2.errs.length===0,(A.errs.concat(U2.errs)).slice(0,3).join("|"));
  await A.pg.selectOption('#siteSel','*');await A.pg.waitForTimeout(300);await A.pg.click('text=Справочники');await A.pg.waitForTimeout(300);await A.pg.screenshot({path:path.join(ROOT,'tests','shot-sites-ref.png'),fullPage:false});
  await A.pg.click('text=Настройки');await A.pg.waitForTimeout(300);await A.pg.screenshot({path:path.join(ROOT,'tests','shot-sites-set.png')});
  await U2.ctx.close();
  await b.close();fs.rmSync(site,{recursive:true,force:true});
  console.log(`\n${pass} PASS / ${fail} FAIL`);process.exit(fail?1:0);
})().catch(e=>{console.error("HARNESS",e);process.exit(1)});
