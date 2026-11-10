// Bellek içi Supabase RPC taklidi — db/schema.sql ile aynı kurallar (testler için ortak).
const fs=require('fs');const path=require('path');const crypto=require('crypto');
const DATA='/home/claude/pub';
const L=(dir)=>Object.fromEntries(fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!f.startsWith('.')).map(f=>[f.slice(0,-5),JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))]));
const TODAY="2026-11-10";
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
    mach_delete_person:({p_token,p_person})=>{const p=req(p_token,true);if(p_person===p.id)err("self");const has=Object.values(S.days).some(d=>d.saved_by===p_person||(d.history||[]).some(h=>h.by===p_person||h.requestedBy===p_person))||Object.values(S.incidents).some(i=>i.by===p_person)||Object.values(S.requests).some(r=>r.data.by===p_person||r.data.decidedBy===p_person);if(has)err("has_records");delete S.people[p_person];delete S.pins[p_person];for(const [t,pid] of Object.entries(S.sessions))if(pid===p_person)delete S.sessions[t];return null;},
    mach_sessions:({p_token})=>{req(p_token,true);return Object.entries(S.sessions).map(([t,pid])=>({person:pid,at:new Date().toISOString()}));},
    mach_revoke_person:({p_token,p_person})=>{req(p_token,true);for(const [t,pid] of Object.entries(S.sessions))if(pid===p_person&&t!==p_token)delete S.sessions[t];return null;},
  };
  return {S,call:(name,args)=>{if(!F[name])throw new Error("no such function "+name);return F[name](args||{});}};
}


module.exports={makeServer,TODAY,L,DATA};
