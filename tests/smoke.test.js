// "Her düğmeye bas" duman testi: her sekmede görünür tüm düğmeler/alanlar tıklanır; sayfa hatası, ham çeviri anahtarı,
// "undefined/NaN/[object" metni ve boş toast aranır. Admin, kullanıcı ve viewer rolleriyle, RU ve TR dilinde.
const {chromium}=require('playwright');const fs=require('fs');const path=require('path');
const {makeServer,TODAY}=require('./mock_server');
const ROOT=path.resolve(__dirname,'..');
let pass=0,fail=0;const ok=(n,c,d="")=>{c?pass++:fail++;console.log((c?"PASS ":"FAIL ")+n+(c?"":" — "+d));};
(async()=>{
  const server=makeServer();
  // ek kullanıcılar
  server.call('mach_upsert_person',{p_token:Object.keys(server.S.sessions)[0]||(server.call('mach_login',{p_email:'huseyin.ozkan@asys-machinery.com',p_password:'Gecici123'}).token),p_id:'',p_name:'Бауыржан',p_email:'b@test.kz',p_role:'user',p_active:true,p_password:'Gecici123'});
  const tok=Object.keys(server.S.sessions)[0];
  server.call('mach_upsert_person',{p_token:tok,p_id:'p-view',p_name:'Гость',p_email:'v@test.kz',p_role:'viewer',p_active:true,p_password:'Gecici123'});
  server.S.pins['p-huseyin'].must=false;
  // açık arıza + talep örnekleri
  server.call('mach_incident_set',{p_token:tok,p_id:'inc1',p_data:{id:'inc1',date:'2026-11-09',machineId:'dmp-03',type:'breakdown',opId:'',teamId:'',down:4,cost:0,desc:'тест',open:true,by:'p-huseyin'}});
  server.call('mach_request_create',{p_token:tok,p_id:'r1',p_type:'team_add',p_payload:{team:{id:'t_x',name:'Бригада X'}},p_summary:'Бригада X'});
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'});
  const site=fs.mkdtempSync('/tmp/asyssmoke-');for(const f of fs.readdirSync(ROOT)){if(f===".git"||f==="tests"||f==="db")continue;const s=path.join(ROOT,f);fs.statSync(s).isDirectory()?fs.cpSync(s,path.join(site,f),{recursive:true}):fs.copyFileSync(s,path.join(site,f));}
  fs.writeFileSync(path.join(site,'config.js'),'window.MACH_CONFIG={url:"https://test.supabase.co",key:"test-key"};');
  fs.writeFileSync(path.join(site,'index.html'),fs.readFileSync(path.join(site,'index.html'),'utf8').replace(/function isoToday\(\)\{[^}]*\}/,`function isoToday(){return "${TODAY}"}`));
  const SKIP=new Set(['accOut','accOut2','lBtn','pwSave','inpOk','modalYes','modalNo','inpCancel','pwCancel','accClose']); // çıkış/onay düğmeleri ayrı
  for(const [email,pw,role] of [['huseyin.ozkan@asys-machinery.com','Gecici123','admin'],['b@test.kz','Gecici123','user'],['v@test.kz','Gecici123','viewer']]){
    for(const lang of ['ru','tr']){
      const ctx=await b.newContext({viewport:{width:1300,height:900},acceptDownloads:true});const pg=await ctx.newPage();const errs=[];
      pg.on('pageerror',e=>errs.push('pageerror: '+e.message));pg.on('console',m=>{if(m.type()==='error'&&!/net::|TUNNEL|Failed to load resource|ServiceWorker|bad_login|duplicate key|last_admin|locked|read_only|admin_required|bad_old|no_request|already_decided/.test(m.text()))errs.push('console: '+m.text());});
      pg.on('dialog',d=>d.accept());
      await pg.route(/cdn\.jsdelivr\.net|fonts\.g/,r=>r.abort());
      await pg.exposeFunction('__rpc',(name,args)=>{try{return {data:server.call(name,args)};}catch(e){return {error:{message:e.message}};}});
      await pg.addInitScript(l=>{localStorage.setItem("asys_lang",l);window.supabase={createClient:()=>({rpc:async(n,a)=>{const r=await window.__rpc(n,a);return r.error?{data:null,error:r.error}:{data:r.data,error:null};}})};},lang);
      await pg.goto('file://'+site+'/index.html',{waitUntil:'load'});await pg.waitForTimeout(500);
      await pg.fill('#lEmail',email);await pg.fill('#lPass',pw);await pg.click('#lBtn');await pg.waitForTimeout(600);
      if(await pg.locator('#mPw').isVisible()){await pg.fill('#pwOld',pw);await pg.fill('#pwNew','Yeni12345');await pg.fill('#pwNew2','Yeni12345');await pg.click('#pwSave');await pg.waitForTimeout(300);server.S.pins[Object.values(server.S.people).find(x=>x.email===email).id]={pw,must:false};}
      const toasts=new Set();const badText=[];let clicks=0;
      for(const tab of ['today','entry','puan','inc','an','req','ref','set']){
        await pg.evaluate(t=>showTab(t),tab);await pg.waitForTimeout(250);
        // metin kontrolü
        const txt=await pg.evaluate(()=>document.querySelector('main section.on').innerText);
        for(const m of (txt.match(/\b(undefined|NaN|\[object Object\]|null)\b/g)||[]))badText.push(tab+': '+m);
        const rawKeys=txt.match(/(^|\s)(tab_|s_|w_|rq_|ppl_|acc_|pw_|login_|dl_|site_|lock_|rep_|puan_|kpi_|col_)[a-z_]+(\s|$)/g)||[];for(const k of rawKeys)badText.push(tab+': ham anahtar '+k.trim());
        // görünür düğmeler
        const btns=await pg.locator('main section.on button:visible, main section.on summary:visible, main section.on a[href="#"]:visible').all();
        for(let i=0;i<btns.length;i++){
          const el=(await pg.locator('main section.on button:visible, main section.on summary:visible, main section.on a[href="#"]:visible').all())[i];if(!el)continue;
          const id=await el.getAttribute('id');if(id&&SKIP.has(id))continue;const label=(await el.innerText()).trim().slice(0,30);
          try{await el.click({timeout:2000});clicks++;}catch(e){continue;}
          await pg.waitForTimeout(120);
          // modal açıldıysa kapat (varsayılan: iptal); girdi modalı → iptal
          for(const [m,btn] of [['#modal','#modalNo'],['#mInput','#inpCancel'],['#mForm','#frmCancel'],['#mPw','#pwCancel'],['#mAcc','#accClose']]){if(await pg.locator(m).isVisible()){await pg.click(btn).catch(()=>{});await pg.waitForTimeout(80);}}
          const tt=(await pg.textContent('#toast')||'').trim();if(tt)toasts.add(tt);
          if(/undefined|NaN|\[object/.test(tt))badText.push(tab+' toast('+label+'): '+tt);
          if(/^[a-z_]+$/.test(tt))badText.push(tab+' toast ham anahtar('+label+'): '+tt);
          if(await pg.locator('#mLogin').isVisible()){badText.push(tab+' '+label+' → oturum düştü');await pg.fill('#lEmail',email);await pg.fill('#lPass',pw);await pg.click('#lBtn');await pg.waitForTimeout(400);}
          await pg.evaluate(t=>showTab(t),tab);await pg.waitForTimeout(60);
        }
        // seçimler/alanlar: entry'de ilk satırın tüm alanlarını değiştir
        if(tab==='entry'&&role!=='viewer'){const row=pg.locator('#entryTbl tr[data-id]').first();for(const f of ['status','teamId','opId','loc']){const el=row.locator(`[data-f=${f}]`);if(await el.count()){const tag=await el.evaluate(e=>e.tagName);if(tag==='SELECT'){const opts=await el.locator('option').count();if(opts>1)await el.selectOption({index:1});}}}
          await pg.evaluate(()=>{entryDirty.clear();});}
      }
      ok(`${role}/${lang}: ${clicks} tıklama, sayfa hatası yok`,errs.length===0,errs.slice(0,3).join(' | '));
      ok(`${role}/${lang}: ham anahtar / undefined / NaN yok`,badText.length===0,badText.slice(0,6).join(' | '));
      await ctx.close();
    }
  }
  await b.close();fs.rmSync(site,{recursive:true,force:true});
  console.log(`\n${pass} PASS / ${fail} FAIL`);process.exit(fail?1:0);
})().catch(e=>{console.error("HARNESS",e);process.exit(1)});
