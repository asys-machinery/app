// Bellek içi Supabase RPC taklidi — db/schema.sql (v2, çoklu şantiye) ile aynı kurallar (testler için ortak).
const fs=require('fs');const path=require('path');const crypto=require('crypto');
const DATA='/home/claude/pub';
const L=(dir)=>Object.fromEntries(fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!f.startsWith('.')).map(f=>[f.slice(0,-5),JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))]));
const TODAY="2026-11-10";
const SITE0="wb-astana";
/* ---------- sunucu taklidi (schema.sql ile aynı kurallar) ---------- */
function makeServer(){
  const withSite=(o,site)=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,{...v,site}]));
  const S={people:{},pins:{},sessions:{},sites:{[SITE0]:{id:SITE0,name:"Wildberries Astana",active:true,data:{lockDays:3,zones:[]}}},
    machines:withSite(L(DATA+'/dbcheck2/machines'),SITE0),teams:withSite(L(DATA+'/dbcheck2/teams'),SITE0),operators:withSite(L(DATA+'/dbcheck2/operators'),SITE0),
    days:{},incidents:{},requests:{},moves:[],settings:{site:{project:"Wildberries Astana",lockDays:3,zones:[]}}};
  for(const [k,v] of Object.entries(L(DATA+'/dbmig/days')))S.days[SITE0+"|"+k]={site:SITE0,date:k,rec:v.rec,saved_by:"p-bauyrzhan",saved_at:v.savedAt||k+"T08:30:00Z",history:v.history||[]};
  S.people["p-huseyin"]={id:"p-huseyin",name:"Hüseyin Özkan",email:"huseyin.ozkan@asys-machinery.com",role:"admin",active:true,sites:[]};S.pins["p-huseyin"]={pw:"Gecici123",must:true};
  const err=m=>{throw new Error(m)};
  const req=(tok,admin,write)=>{const s=S.sessions[tok];if(!s)err("not_logged_in");const p=S.people[s];if(!p||!p.active)err("not_logged_in");if(admin&&p.role!=="admin")err("admin_required");if(write&&p.role==="viewer")err("read_only");return p;};
  const sitesOf=p=>p.role==="admin"?Object.keys(S.sites):(p.sites||[]);
  const siteOk=(p,site)=>p.role==="admin"||sitesOf(p).includes(site);
  const defSite=p=>{const a=sitesOf(p);return a.length===1?a[0]:null;};
  const lock=site=>Number(S.sites[site]?.data?.lockDays??S.settings.site?.lockDays??3);
  const addDays=(iso,n)=>{const d=new Date(iso+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
  const strip=(o)=>{const {site,...rest}=o||{};return rest;};
  const applyDay=(site,date,rows,by,reqBy)=>{const key=site+"|"+date;const cur=S.days[key];const first=!cur;const rec={...(cur?.rec||{})};let hist=(cur?.history||[]).slice();const ch=[];let n=0;
    for(const [m,nr] of Object.entries(rows||{})){const o=rec[m];if(JSON.stringify(o)!==JSON.stringify(nr)){n++;if(!first)for(const f of ["teamId","opId","loc","status","hrs","hStart","hEnd","fuel","note"]){if(JSON.stringify(o?.[f]??null)!==JSON.stringify(nr?.[f]??null)&&ch.length<40)ch.push({m,f,a:o?.[f]??"",b:nr?.[f]??""});}rec[m]=nr;}}
    if(!n)return {changed:0};const h={at:new Date().toISOString(),by,n,ch};if(first)h.first=true;if(reqBy)h.requestedBy=reqBy;hist.push(h);hist=hist.slice(-20);
    S.days[key]={site,date,rec,saved_by:by,saved_at:new Date().toISOString(),history:hist};return {changed:n};};
  const doMove=(mid,to,date,by,note)=>{const m=S.machines[mid];if(!m)err("no_machine");if(to!==""&&!(S.sites[to]&&S.sites[to].active!==false))err("bad_site");if((m.site||"")===to)err("same_site");if(!/^\d{4}-\d\d-\d\d$/.test(date))err("bad_date");
    S.moves.unshift({id:S.moves.length+1,machineId:mid,from:m.site||"",to,date,by,note:note||"",at:new Date().toISOString()});m.site=to;};
  const F={
    mach_login:({p_email,p_password})=>{const p=Object.values(S.people).find(x=>x.email?.toLowerCase()===String(p_email).trim().toLowerCase()&&x.active);if(!p||S.pins[p.id]?.pw!==p_password)err("bad_login");const tok=crypto.randomBytes(12).toString("hex");S.sessions[tok]=p.id;p.lastLogin=new Date().toISOString();return {token:tok,person:p.id,name:p.name,role:p.role,mustChange:!!S.pins[p.id].must};},
    mach_logout:({p_token})=>{delete S.sessions[p_token];return null;},
    mach_change_password:({p_token,p_old,p_new})=>{const p=req(p_token);if(String(p_new).length<6)err("too_short");if(S.pins[p.id].pw!==p_old)err("bad_old");S.pins[p.id]={pw:p_new,must:false};return null;},
    mach_fetch:({p_token})=>{const p=req(p_token);const adm=p.role==="admin";const al=sitesOf(p);const vis=site=>adm||al.includes(site);
      const pick=(obj,f)=>Object.fromEntries(Object.entries(obj).filter(([k,v])=>f(v)));
      const days={};for(const [k,v] of Object.entries(S.days))if(vis(v.site))days[k]={site:v.site,date:v.date,rec:v.rec,savedBy:v.saved_by,savedAt:v.saved_at,history:v.history};
      const requests={};for(const [k,v] of Object.entries(S.requests))if(vis(v.site))requests[k]={...v.data,id:k,type:v.type,status:v.status,site:v.site};
      return {me:{person:p.id,name:p.name,role:p.role,mustChange:!!S.pins[p.id]?.must,sites:p.sites||[]},
        sites:JSON.parse(JSON.stringify(S.sites)),
        people:Object.values(S.people).map(x=>({id:x.id,name:x.name,role:x.role,active:x.active,email:adm?x.email:null,lastLogin:adm?(x.lastLogin||null):null,sites:adm?(x.sites||[]):null})),
        machines:pick(S.machines,m=>adm||!m.site||al.includes(m.site)),teams:pick(S.teams,x=>vis(x.site)),operators:pick(S.operators,x=>vis(x.site)),
        days,incidents:pick(S.incidents,i=>vis(i.site)),requests,moves:adm?S.moves.slice(0,300):[],settings:S.settings.site||{}};},
    mach_save_day:({p_token,p_date,p_rows,p_site})=>{const p=req(p_token,false,true);if(!/^\d{4}-\d\d-\d\d$/.test(p_date))err("bad_date");const st=p_site||defSite(p);if(!st)err("site_required");if(!S.sites[st])err("bad_site");if(!siteOk(p,st))err("no_site_access");if(p.role!=="admin"&&p_date<addDays(TODAY,-lock(st)))err("locked");return applyDay(st,p_date,p_rows,p.id,null);},
    mach_ref_upsert:({p_token,p_col,p_id,p_data})=>{req(p_token,true);if(!["machines","teams","operators"].includes(p_col))err("bad_col");const st=p_data.site||null;if(st&&!S.sites[st])err("bad_site");const cur=S[p_col][p_id];
      const site=p_col==="machines"?(cur?cur.site:(st||"")):(st||cur?.site||"");S[p_col][p_id]={...strip(p_data),site};return null;},
    mach_set_setting:({p_token,p_key,p_value})=>{req(p_token,true);S.settings[p_key]=p_value;return null;},
    mach_site_upsert:({p_token,p_id,p_name,p_active,p_data})=>{req(p_token,true);if(!String(p_name||"").trim())err("name_required");const id=p_id||("s"+crypto.randomBytes(4).toString("hex"));
      if(p_active===false&&Object.values(S.machines).some(m=>m.site===id&&m.active!==false))err("site_has_machines");
      S.sites[id]={id,name:p_name.trim(),active:p_active!==false,data:p_data||{}};return S.sites[id];},
    mach_move_machine:({p_token,p_machine,p_to_site,p_date,p_note})=>{const p=req(p_token,true);doMove(p_machine,p_to_site||"",p_date||TODAY,p.id,p_note);return null;},
    mach_incident_set:({p_token,p_id,p_data})=>{const p=req(p_token,false,true);const st=p_data.site||S.machines[p_data.machineId]?.site||S.incidents[p_id]?.site||defSite(p)||"";if(!siteOk(p,st))err("no_site_access");S.incidents[p_id]={...strip(p_data),site:st};return null;},
    mach_incident_delete:({p_token,p_id})=>{req(p_token,true);delete S.incidents[p_id];return null;},
    mach_request_create:({p_token,p_id,p_type,p_payload,p_summary})=>{const p=req(p_token,false,true);if(!["machine_add","toggle","team_add","operator_add","day_edit","machine_move"].includes(p_type))err("bad_type");
      const st=p_payload?.site||defSite(p)||"";if(st&&!siteOk(p,st))err("no_site_access");if(p_type==="machine_move"&&p_payload?.toSite&&!siteOk(p,p_payload.toSite))err("no_site_access");
      S.requests[p_id]={type:p_type,status:"pending",site:st,data:{payload:strip(p_payload),summary:p_summary||"",by:p.id,at:new Date().toISOString()}};return null;},
    mach_decide:({p_token,p_id,p_approve})=>{const p=req(p_token,true);const r=S.requests[p_id];if(!r)err("no_request");if(r.status!=="pending")err("already_decided");const pl=r.data.payload||{};
      if(p_approve){if(r.type==="machine_add"){const m=pl.machine;S.machines[m.id]={...(S.machines[m.id]||{}),...Object.fromEntries(Object.entries(strip(m)).filter(([k,v])=>v!=null)),active:true,site:m.site||r.site};}
        else if(r.type==="team_add"){S.teams[pl.team.id]={...(S.teams[pl.team.id]||{}),...strip(pl.team),active:true,site:pl.team.site||r.site};}
        else if(r.type==="operator_add"){S.operators[pl.operator.id]={...(S.operators[pl.operator.id]||{}),...strip(pl.operator),active:true,site:pl.operator.site||r.site};}
        else if(r.type==="toggle"){const o=S[pl.col]?.[pl.id];if(o)o.active=!!pl.active;}
        else if(r.type==="day_edit"){applyDay(pl.site||r.site,pl.date,pl.rows,p.id,r.data.by);}
        else if(r.type==="machine_move"){doMove(pl.machineId,pl.toSite||"",pl.date||TODAY,p.id,(pl.note||"")+" ("+r.data.by+")");}}
      r.status=p_approve?"approved":"rejected";r.data.decidedBy=p.id;r.data.decidedAt=new Date().toISOString();return null;},
    mach_upsert_person:({p_token,p_id,p_name,p_email,p_role,p_active,p_password,p_sites})=>{const p=req(p_token,true);if(!["admin","user","viewer"].includes(p_role))err("bad_role");if(!p_email||!p_email.includes("@"))err("bad_email");if(!String(p_name||"").trim())err("name_required");
      const id=p_id||("p"+crypto.randomBytes(5).toString("hex"));if(id===p.id&&(p_role!=="admin"||p_active===false)){if(!Object.values(S.people).some(x=>x.role==="admin"&&x.active&&x.id!==p.id))err("last_admin");}
      if(Object.values(S.people).some(x=>x.id!==id&&x.email?.toLowerCase()===p_email.toLowerCase()))err('duplicate key value violates unique constraint "people_email_idx"');
      const ss=Array.isArray(p_sites)?p_sites.filter(x=>S.sites[x]):null;
      S.people[id]={...(S.people[id]||{}),id,name:p_name.trim(),email:p_email.toLowerCase(),role:p_role,active:p_active!==false,sites:ss??(S.people[id]?.sites||[])};
      if(p_password&&p_password.length>=6){S.pins[id]={pw:p_password,must:true};if(id!==p.id)for(const [t,pid] of Object.entries(S.sessions))if(pid===id)delete S.sessions[t];}
      return {id,name:S.people[id].name,email:S.people[id].email,role:p_role,active:S.people[id].active,sites:S.people[id].sites,lastLogin:S.people[id].lastLogin||null};},
    mach_delete_person:({p_token,p_person})=>{const p=req(p_token,true);if(p_person===p.id)err("self");const has=Object.values(S.days).some(d=>d.saved_by===p_person||(d.history||[]).some(h=>h.by===p_person||h.requestedBy===p_person))||Object.values(S.incidents).some(i=>i.by===p_person)||Object.values(S.requests).some(r=>r.data.by===p_person||r.data.decidedBy===p_person)||S.moves.some(m=>m.by===p_person);if(has)err("has_records");delete S.people[p_person];delete S.pins[p_person];for(const [t,pid] of Object.entries(S.sessions))if(pid===p_person)delete S.sessions[t];return null;},
    mach_sessions:({p_token})=>{req(p_token,true);return Object.entries(S.sessions).map(([t,pid])=>({person:pid,at:new Date().toISOString()}));},
    mach_revoke_person:({p_token,p_person})=>{req(p_token,true);for(const [t,pid] of Object.entries(S.sessions))if(pid===p_person&&t!==p_token)delete S.sessions[t];return null;},
  };
  return {S,call:(name,args)=>{if(!F[name])throw new Error("no such function "+name);return F[name](args||{});}};
}

module.exports={makeServer,TODAY,L,DATA,SITE0};
