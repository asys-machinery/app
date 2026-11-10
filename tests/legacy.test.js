// Geçiş güvenliği: veritabanı henüz 004'e geçmemişken (v1 RPC'ler) yeni arayüz tek şantiye kipinde çalışmalı.
const {chromium}=require('playwright');const fs=require('fs');const path=require('path');
const {makeServer,TODAY}=require('./mock_server_v1');
const ROOT=path.resolve(__dirname,'..');
let pass=0,fail=0;const ok=(n,c,d="")=>{c?pass++:fail++;console.log((c?"PASS ":"FAIL ")+n+(c?"":" — "+d));};
(async()=>{
  const server=makeServer();server.S.pins['p-huseyin'].must=false;
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'});
  const site=fs.mkdtempSync('/tmp/asyslegacy-');for(const f of fs.readdirSync(ROOT)){if(f===".git"||f==="tests"||f==="db")continue;const s=path.join(ROOT,f);fs.statSync(s).isDirectory()?fs.cpSync(s,path.join(site,f),{recursive:true}):fs.copyFileSync(s,path.join(site,f));}
  fs.writeFileSync(path.join(site,'config.js'),'window.MACH_CONFIG={url:"https://test.supabase.co",key:"test-key"};');
  fs.writeFileSync(path.join(site,'index.html'),fs.readFileSync(path.join(site,'index.html'),'utf8').replace(/function isoToday\(\)\{[^}]*\}/,`function isoToday(){return "${TODAY}"}`));
  const ctx=await b.newContext({viewport:{width:1300,height:900}});const pg=await ctx.newPage();const errs=[];
  pg.on('pageerror',e=>errs.push('pageerror: '+e.message));
  await pg.route(/cdn\.jsdelivr\.net|fonts\.g/,r=>r.abort());
  await pg.exposeFunction('__rpc',(name,args)=>{try{return {data:server.call(name,args)};}catch(e){return {error:{message:e.message}};}});
  await pg.addInitScript(()=>{window.supabase={createClient:()=>({rpc:async(n,a)=>{const r=await window.__rpc(n,a);return r.error?{data:null,error:r.error}:{data:r.data,error:null};}})};});
  await pg.goto('file://'+site+'/index.html',{waitUntil:'load'});await pg.waitForTimeout(400);
  await pg.fill('#lEmail','huseyin.ozkan@asys-machinery.com');await pg.fill('#lPass','Gecici123');await pg.click('#lBtn');await pg.waitForTimeout(700);
  ok("L1 v1 sunucu: LEGACY kipi, 48 makine, 13 gün, seçicide tek şantiye",(await pg.evaluate(()=>LEGACY))===true&&Object.keys(await pg.evaluate(()=>machines)).length===48&&Object.keys(await pg.evaluate(()=>days)).length===13&&(await pg.locator('#siteSel option').count())===1);
  await pg.click('text=Журнал дня');await pg.waitForTimeout(400);
  await pg.locator('#entryTbl tr[data-id="dmp-03"] [data-f=status]').selectOption('idle');await pg.click('#saveDay');await pg.waitForTimeout(300);if(await pg.locator('#modal').isVisible())await pg.click('#modalYes');await pg.waitForTimeout(600);
  ok("L2 Gün kaydı v1 imzasıyla (p_site yok) kaydedildi",!!server.S.days[TODAY]&&server.S.days[TODAY].rec['dmp-03'].status==='idle');
  await pg.click('text=Настройки');await pg.waitForTimeout(300);
  await pg.fill('#zonesTxt','Склад 1\nСклад 2');await pg.click('#saveZones');await pg.waitForTimeout(400);
  ok("L3 Bölgeler v1 ayar tablosuna yazıldı",JSON.stringify(server.S.settings.site.zones)==='["Склад 1","Склад 2"]');
  await pg.fill('#pName','Test');await pg.fill('#pEmail','t@test.kz');await pg.fill('#pPass','Gecici123');await pg.click('#addPerson');await pg.waitForTimeout(400);
  ok("L4 Kullanıcı ekleme v1 imzasıyla çalışır",Object.values(server.S.people).some(p=>p.email==='t@test.kz'));
  ok("L5 Sayfa hatası yok",errs.length===0,errs.join('|'));
  await b.close();fs.rmSync(site,{recursive:true,force:true});
  console.log(`\n${pass} PASS / ${fail} FAIL`);process.exit(fail?1:0);
})().catch(e=>{console.error("HARNESS",e);process.exit(1)});
