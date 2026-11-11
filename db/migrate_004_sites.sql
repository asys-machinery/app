-- ASYS Machinery — Geçiş 004 (10.11.2026): ÇOKLU ŞANTİYE
-- Supabase SQL Editor'da tek seferde çalıştırın. Mevcut tüm veri "Wildberries Astana" (wb-astana) şantiyesine bağlanır;
-- hiçbir kayıt silinmez veya değişmez. Fonksiyonların hepsi yeniden tanımlanır (aşağıda).

-- 1) yeni tablolar
create table if not exists sites (
  id          text primary key,
  name        text not null,
  active      boolean not null default true,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create table if not exists machine_moves (
  id          bigserial primary key,
  machine_id  text not null,
  from_site   text not null default '',
  to_site     text not null default '',
  moved_on    text not null,
  by_person   text not null default '',
  note        text not null default '',
  at          timestamptz not null default now()
);
alter table sites         enable row level security;
alter table machine_moves enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 2) yeni sütunlar
alter table people    add column if not exists sites jsonb not null default '[]'::jsonb;
alter table machines  add column if not exists site text not null default '';
alter table teams     add column if not exists site text not null default '';
alter table operators add column if not exists site text not null default '';
alter table days      add column if not exists site text not null default '';
alter table incidents add column if not exists site text not null default '';
alter table requests  add column if not exists site text not null default '';

-- 3) ilk şantiye: mevcut ayarlardaki bölgeler ve kilit süresi şantiyeye taşınır
insert into sites(id, name, active, data)
  select 'wb-astana', coalesce(value->>'project','Wildberries Astana'), true,
         jsonb_strip_nulls(jsonb_build_object('zones', value->'zones', 'lockDays', value->'lockDays'))
  from settings where key = 'site'
  on conflict (id) do nothing;
insert into sites(id, name) values ('wb-astana', 'Wildberries Astana') on conflict (id) do nothing;

-- 4) mevcut veriyi şantiyeye bağla
update machines  set site = 'wb-astana' where site = '';
update teams     set site = 'wb-astana' where site = '';
update operators set site = 'wb-astana' where site = '';
update days      set site = 'wb-astana' where site = '';
update incidents set site = 'wb-astana' where site = '';
update requests  set site = 'wb-astana' where site = '';
update people    set sites = '["wb-astana"]'::jsonb where role <> 'admin' and sites = '[]'::jsonb;


-- 005: şantiye silme (iz bırakarak)
alter table sites add column if not exists deleted_at timestamptz;
-- Geçiş 004b: gün tablosu anahtarı (date) → (site, date). Tek "drop" içeren adım; ayrı çalıştırılır.
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'days'::regclass and contype = 'p' and array_length(conkey,1) = 1) then
    alter table days drop constraint days_pkey;
    alter table days add primary key (site, date);
  end if;
end $$;

-- ======================= FONKSİYONLAR (v2 — çoklu şantiye) =======================
-- İç yardımcılar "asys" şemasındadır: PostgREST yalnızca public şemasını sunar, anon'un bu şemada USAGE yetkisi yoktur →
-- API'den çağrılamazlar (revoke gerekmez). Hiçbir şey silinmez; v1'den kalan eski imzalar zararsızdır (yetkileri zaten alınmıştı).
create schema if not exists asys;

-- ---------- yardımcılar ----------
create or replace function asys.require(p_token text, p_admin boolean default false, p_write boolean default false)
returns people language plpgsql security definer as $$
declare s sessions; p people;
begin
  select * into s from sessions where token = p_token and expires_at > now();
  if s.token is null then raise exception 'not_logged_in'; end if;
  select * into p from people where id = s.person_id and active;
  if p.id is null then raise exception 'not_logged_in'; end if;
  if p_admin and p.role <> 'admin' then raise exception 'admin_required'; end if;
  if p_write and p.role = 'viewer' then raise exception 'read_only'; end if;
  return p;
end $$;

-- kişinin görebildiği şantiyeler (admin: hepsi)
create or replace function asys.sites_of(p people) returns text[] language sql security definer stable as $$
  select case when p.role = 'admin' then coalesce((select array_agg(id) from sites where deleted_at is null), '{}'::text[])
              else coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p.sites,'[]'::jsonb)) x), '{}'::text[]) end;
$$;
create or replace function asys.site_ok(p people, p_site text) returns boolean language sql security definer stable as $$
  select p.role = 'admin' or p_site = any(asys.sites_of(p));
$$;
-- tek şantiyesi olan kişi için varsayılan şantiye (eski istemciler / tek şantiyeli kurulum)
create or replace function asys.default_site(p people) returns text language plpgsql security definer stable as $$
declare a text[];
begin
  a := asys.sites_of(p);
  if array_length(a,1) = 1 then return a[1]; end if;
  return null;
end $$;

create or replace function asys.lock_days(p_site text) returns int language sql security definer stable as $$
  select coalesce((select (data->>'lockDays')::int from sites where id = p_site),
                  (select (value->>'lockDays')::int from settings where key = 'site'), 3);
$$;

-- ---------- giriş / oturum ----------
create or replace function mach_login(p_email text, p_password text)
returns jsonb language plpgsql security definer as $$
declare h text; mc boolean; tok text; p people;
begin
  select * into p from people where lower(email) = lower(trim(p_email)) and active;
  if p.id is null then raise exception 'bad_login'; end if;
  select pin_hash, must_change into h, mc from pins where person_id = p.id;
  if h is null or h <> crypt(p_password, h) then raise exception 'bad_login'; end if;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into sessions(token, person_id) values (tok, p.id);
  update people set last_login = now() where id = p.id;
  return jsonb_build_object('token', tok, 'person', p.id, 'name', p.name, 'role', p.role, 'mustChange', coalesce(mc,false));
end $$;

create or replace function mach_logout(p_token text) returns void language sql security definer as $$
  delete from sessions where token = p_token;
$$;

create or replace function mach_change_password(p_token text, p_old text, p_new text)
returns void language plpgsql security definer as $$
declare p people; h text;
begin
  p := asys.require(p_token);
  if length(p_new) < 6 then raise exception 'too_short'; end if;
  select pin_hash into h from pins where person_id = p.id;
  if h is null or h <> crypt(p_old, h) then raise exception 'bad_old'; end if;
  update pins set pin_hash = crypt(p_new, gen_salt('bf')), must_change = false where person_id = p.id;
end $$;

-- ---------- veri okuma (tek çağrı) ----------
-- Admin her şeyi görür. Kullanıcı/izleyici: kendi şantiyelerinin ekip/operatör/gün/arıza/taleplerini,
-- makinelerden ise kendi şantiyelerindekileri + Makine Parkı'ndakileri ('' — talep edebilmek için) görür.
create or replace function mach_fetch(p_token text, p_since text default null)
returns jsonb language plpgsql security definer stable as $$
declare p people; since text; mc boolean; adm boolean; al text[];
begin
  p := asys.require(p_token);
  since := coalesce(p_since, to_char(now() - interval '400 days', 'YYYY-MM-DD'));
  select must_change into mc from pins where person_id = p.id;
  adm := p.role = 'admin'; al := asys.sites_of(p);
  return jsonb_build_object(
    'me', jsonb_build_object('person', p.id, 'name', p.name, 'role', p.role, 'mustChange', coalesce(mc,false), 'sites', coalesce(p.sites,'[]'::jsonb)),
    'sites', coalesce((select jsonb_object_agg(id, jsonb_build_object('id',id,'name',name,'active',active,'data',data)) from sites where deleted_at is null), '{}'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'role',role,'active',active,
                 'email', case when adm then email else null end,
                 'lastLogin', case when adm then last_login else null end,
                 'sites', case when adm then coalesce(sites,'[]'::jsonb) else null end) order by name) from people), '[]'::jsonb),
    'machines',  coalesce((select jsonb_object_agg(id, data || jsonb_build_object('site', site)) from machines where adm or site = '' or site = any(al)), '{}'::jsonb),
    'teams',     coalesce((select jsonb_object_agg(id, data || jsonb_build_object('site', site)) from teams where adm or site = any(al)), '{}'::jsonb),
    'operators', coalesce((select jsonb_object_agg(id, data || jsonb_build_object('site', site)) from operators where adm or site = any(al)), '{}'::jsonb),
    'days',      coalesce((select jsonb_object_agg(site || '|' || date, jsonb_build_object('site',site,'date',date,'rec',rec,'savedBy',saved_by,'savedAt',saved_at,'history',history)) from days where date >= since and (adm or site = any(al))), '{}'::jsonb),
    'incidents', coalesce((select jsonb_object_agg(id, data || jsonb_build_object('site', site)) from incidents where adm or site = any(al)), '{}'::jsonb),
    'requests',  coalesce((select jsonb_object_agg(id, data || jsonb_build_object('id',id,'type',type,'status',status,'site',site)) from requests where adm or site = any(al)), '{}'::jsonb),
    'moves',     case when adm then coalesce((select jsonb_agg(jsonb_build_object('id',id,'machineId',machine_id,'from',from_site,'to',to_site,'date',moved_on,'by',by_person,'note',note,'at',at) order by at desc)
                        from (select * from machine_moves order by at desc limit 300) q), '[]'::jsonb) else '[]'::jsonb end,
    'settings',  coalesce((select value from settings where key = 'site'), '{}'::jsonb)
  );
end $$;

-- ---------- günlük kayıt: sunucu tarafında birleştirme + değişiklik geçmişi ----------
-- p_rows: {machineId: row} — yalnızca değişen satırlar. Mevcut kayıt üzerine satır satır yazılır,
-- alan alan fark çıkarılıp geçmişe eklenir. Kilitli günlerde (today - lockDays) yalnızca admin yazar.
create or replace function asys.apply_day(p_site text, p_date text, p_rows jsonb, p_by text, p_requested_by text)
returns jsonb language plpgsql security definer as $$
declare cur days; rec jsonb; hist jsonb; ch jsonb := '[]'::jsonb; m text; newrow jsonb; oldrow jsonb; f text; first boolean; n int := 0;
begin
  select * into cur from days where site = p_site and date = p_date;
  first := cur.date is null;
  rec := coalesce(cur.rec, '{}'::jsonb);
  hist := coalesce(cur.history, '[]'::jsonb);
  for m, newrow in select * from jsonb_each(coalesce(p_rows,'{}'::jsonb)) loop
    oldrow := rec->m;
    if oldrow is distinct from newrow then
      n := n + 1;
      if not first then
        foreach f in array array['teamId','opId','loc','status','hrs','hStart','hEnd','fuel','note'] loop
          if (oldrow->f) is distinct from (newrow->f) and jsonb_array_length(ch) < 40 then
            ch := ch || jsonb_build_array(jsonb_build_object('m', m, 'f', f, 'a', coalesce(oldrow->f,'""'::jsonb), 'b', coalesce(newrow->f,'""'::jsonb)));
          end if;
        end loop;
      end if;
      rec := rec || jsonb_build_object(m, newrow);
    end if;
  end loop;
  if n = 0 then return jsonb_build_object('changed', 0); end if;
  hist := hist || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('at', now(), 'by', p_by, 'n', n, 'first', case when first then true else null end, 'ch', ch, 'requestedBy', p_requested_by)));
  if jsonb_array_length(hist) > 20 then hist := (select jsonb_agg(x) from (select x from jsonb_array_elements(hist) with ordinality as t(x, i) order by i offset jsonb_array_length(hist) - 20) q); end if;
  insert into days(site, date, rec, saved_by, saved_at, history) values (p_site, p_date, rec, p_by, now(), hist)
    on conflict (site, date) do update set rec = excluded.rec, saved_by = excluded.saved_by, saved_at = excluded.saved_at, history = excluded.history;
  return jsonb_build_object('changed', n);
end $$;

-- p_site boş bırakılırsa kişinin tek şantiyesi kullanılır (tek şantiyeli kurulum / eski istemci)
create or replace function mach_save_day(p_token text, p_date text, p_rows jsonb, p_site text)
returns jsonb language plpgsql security definer as $$
declare p people; st text;
begin
  p := asys.require(p_token, false, true);
  if p_date !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad_date'; end if;
  st := coalesce(nullif(p_site,''), asys.default_site(p));
  if st is null or st = '' then raise exception 'site_required'; end if;
  if not exists (select 1 from sites where id = st and deleted_at is null) then raise exception 'bad_site'; end if;
  if not asys.site_ok(p, st) then raise exception 'no_site_access'; end if;
  if p.role <> 'admin' and p_date::date < (current_date - asys.lock_days(st)) then raise exception 'locked'; end if;
  return asys.apply_day(st, p_date, p_rows, p.id, null);
end $$;
-- v1 imzası (3 parametre): tek şantiyeli kurulum / eski istemci → varsayılan şantiye
create or replace function mach_save_day(p_token text, p_date text, p_rows jsonb)
returns jsonb language sql security definer as $$ select mach_save_day(p_token, p_date, p_rows, null); $$;

-- ---------- tanımlar (admin) ----------
-- p_data içindeki "site" alanı sütuna yazılır (veri içinde tutulmaz). Makinenin şantiyesi yalnızca
-- ilk eklemede buradan belirlenir; sonrası mach_move_machine ile (taşıma günlüğü için).
create or replace function mach_ref_upsert(p_token text, p_col text, p_id text, p_data jsonb)
returns void language plpgsql security definer as $$
declare p people; st text; d jsonb;
begin
  p := asys.require(p_token, true);
  st := nullif(p_data->>'site',''); d := p_data - 'site';
  if st is not null and not exists (select 1 from sites where id = st) then raise exception 'bad_site'; end if;
  if p_col = 'machines' then
    insert into machines(id,data,site) values (p_id,d,coalesce(st,'')) on conflict (id) do update set data = excluded.data, updated_at = now();
  elsif p_col = 'teams' then
    insert into teams(id,data,site) values (p_id,d,coalesce(st,'')) on conflict (id) do update set data = excluded.data, site = coalesce(st, teams.site), updated_at = now();
  elsif p_col = 'operators' then
    insert into operators(id,data,site) values (p_id,d,coalesce(st,'')) on conflict (id) do update set data = excluded.data, site = coalesce(st, operators.site), updated_at = now();
  else raise exception 'bad_col'; end if;
end $$;

create or replace function mach_set_setting(p_token text, p_key text, p_value jsonb)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := asys.require(p_token, true);
  insert into settings(key, value) values (p_key, p_value) on conflict (key) do update set value = excluded.value;
end $$;

-- ---------- şantiyeler (admin) ----------
create or replace function mach_site_upsert(p_token text, p_id text, p_name text, p_active boolean, p_data jsonb)
returns jsonb language plpgsql security definer as $$
declare p people; sid text; r sites; n int;
begin
  p := asys.require(p_token, true);
  if length(trim(coalesce(p_name,''))) = 0 then raise exception 'name_required'; end if;
  sid := coalesce(nullif(p_id,''), 's' || encode(gen_random_bytes(4),'hex'));
  if not coalesce(p_active,true) then
    select count(*) into n from machines where site = sid and coalesce((data->>'active')::boolean, true);
    if n > 0 then raise exception 'site_has_machines'; end if;
  end if;
  insert into sites(id, name, active, data) values (sid, trim(p_name), coalesce(p_active,true), coalesce(p_data,'{}'::jsonb))
    on conflict (id) do update set name = excluded.name, active = excluded.active, data = excluded.data
    returning * into r;
  return jsonb_build_object('id', r.id, 'name', r.name, 'active', r.active, 'data', r.data);
end $$;

-- şantiye silme: yalnızca hiç verisi olmayan şantiye (makine/ekip/operatör/gün/arıza/talep/taşıma yok). Verisi olan pasif yapılır.
create or replace function mach_site_delete(p_token text, p_id text)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := asys.require(p_token, true);
  if not exists (select 1 from sites where id = p_id and deleted_at is null) then raise exception 'bad_site'; end if;
  if exists (select 1 from machines where site = p_id) then raise exception 'site_has_machines'; end if;
  if exists (select 1 from teams where site = p_id) or exists (select 1 from operators where site = p_id)
     or exists (select 1 from days where site = p_id) or exists (select 1 from incidents where site = p_id)
     or exists (select 1 from requests where site = p_id)
     or exists (select 1 from machine_moves where from_site = p_id or to_site = p_id) then raise exception 'site_has_records'; end if;
  update people set sites = coalesce((select jsonb_agg(x) from jsonb_array_elements_text(sites) x where x <> p_id), '[]'::jsonb) where sites ? p_id;
  update sites set active = false, deleted_at = now() where id = p_id;   -- kayıt tutulur (iz kalır), listelerde görünmez
end $$;

-- makine taşıma (iç): günlüğe yazar, makinenin şantiyesini değiştirir
create or replace function asys.do_move(p_machine text, p_to text, p_date text, p_by text, p_note text)
returns void language plpgsql security definer as $$
declare frm text;
begin
  select site into frm from machines where id = p_machine;
  if frm is null then raise exception 'no_machine'; end if;
  if p_to <> '' and not exists (select 1 from sites where id = p_to and active) then raise exception 'bad_site'; end if;
  if frm = p_to then raise exception 'same_site'; end if;
  if p_date !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad_date'; end if;
  insert into machine_moves(machine_id, from_site, to_site, moved_on, by_person, note) values (p_machine, frm, p_to, p_date, p_by, coalesce(p_note,''));
  update machines set site = p_to, updated_at = now() where id = p_machine;
end $$;

create or replace function mach_move_machine(p_token text, p_machine text, p_to_site text, p_date text, p_note text)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := asys.require(p_token, true);
  perform asys.do_move(p_machine, coalesce(p_to_site,''), coalesce(nullif(p_date,''), to_char(current_date,'YYYY-MM-DD')), p.id, p_note);
end $$;

-- ---------- arızalar (kullanıcı+) ----------
create or replace function mach_incident_set(p_token text, p_id text, p_data jsonb)
returns void language plpgsql security definer as $$
declare p people; st text;
begin
  p := asys.require(p_token, false, true);
  st := coalesce(nullif(p_data->>'site',''), (select nullif(site,'') from machines where id = p_data->>'machineId'), (select nullif(site,'') from incidents where id = p_id), asys.default_site(p), '');
  if not asys.site_ok(p, st) then raise exception 'no_site_access'; end if;
  insert into incidents(id, date, machine_id, site, data) values (p_id, coalesce(p_data->>'date',''), coalesce(p_data->>'machineId',''), st, p_data - 'site')
    on conflict (id) do update set date = excluded.date, machine_id = excluded.machine_id, site = excluded.site, data = excluded.data, updated_at = now();
end $$;

create or replace function mach_incident_delete(p_token text, p_id text)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := asys.require(p_token, true);
  delete from incidents where id = p_id;
end $$;

-- ---------- talepler: kullanıcı açar, admin karar verir (uygulama sunucuda) ----------
create or replace function mach_request_create(p_token text, p_id text, p_type text, p_payload jsonb, p_summary text)
returns void language plpgsql security definer as $$
declare p people; st text;
begin
  p := asys.require(p_token, false, true);
  if p_type not in ('machine_add','toggle','team_add','operator_add','day_edit','machine_move') then raise exception 'bad_type'; end if;
  st := coalesce(nullif(p_payload->>'site',''), asys.default_site(p), '');
  if st <> '' and not asys.site_ok(p, st) then raise exception 'no_site_access'; end if;
  if p_type = 'machine_move' and coalesce(p_payload->>'toSite','') <> '' and not asys.site_ok(p, p_payload->>'toSite') then raise exception 'no_site_access'; end if;
  insert into requests(id, type, status, site, data) values (p_id, p_type, 'pending', st,
    jsonb_build_object('payload', p_payload - 'site', 'summary', coalesce(p_summary,''), 'by', p.id, 'at', now()));
end $$;

create or replace function mach_decide(p_token text, p_id text, p_approve boolean)
returns void language plpgsql security definer as $$
declare p people; r requests; pl jsonb; ex jsonb; col text; st text;
begin
  p := asys.require(p_token, true);
  select * into r from requests where id = p_id;
  if r.id is null then raise exception 'no_request'; end if;
  if r.status <> 'pending' then raise exception 'already_decided'; end if;
  pl := r.data->'payload';
  if p_approve then
    if r.type = 'machine_add' then
      st := coalesce(nullif(pl->'machine'->>'site',''), r.site);
      select data into ex from machines where id = pl->'machine'->>'id';
      insert into machines(id, data, site) values (pl->'machine'->>'id', (coalesce(ex,'{}'::jsonb) || jsonb_strip_nulls(pl->'machine') || '{"active":true}'::jsonb) - 'site', st)
        on conflict (id) do update set data = excluded.data, updated_at = now();
    elsif r.type = 'team_add' then
      st := coalesce(nullif(pl->'team'->>'site',''), r.site);
      select data into ex from teams where id = pl->'team'->>'id';
      insert into teams(id, data, site) values (pl->'team'->>'id', (coalesce(ex,'{}'::jsonb) || (pl->'team') || '{"active":true}'::jsonb) - 'site', st)
        on conflict (id) do update set data = excluded.data, updated_at = now();
    elsif r.type = 'operator_add' then
      st := coalesce(nullif(pl->'operator'->>'site',''), r.site);
      select data into ex from operators where id = pl->'operator'->>'id';
      insert into operators(id, data, site) values (pl->'operator'->>'id', (coalesce(ex,'{}'::jsonb) || (pl->'operator') || '{"active":true}'::jsonb) - 'site', st)
        on conflict (id) do update set data = excluded.data, updated_at = now();
    elsif r.type = 'toggle' then
      col := pl->>'col';
      if col = 'machines' then update machines set data = data || jsonb_build_object('active', (pl->>'active')::boolean), updated_at = now() where id = pl->>'id';
      elsif col = 'teams' then update teams set data = data || jsonb_build_object('active', (pl->>'active')::boolean), updated_at = now() where id = pl->>'id';
      elsif col = 'operators' then update operators set data = data || jsonb_build_object('active', (pl->>'active')::boolean), updated_at = now() where id = pl->>'id';
      end if;
    elsif r.type = 'day_edit' then
      perform asys.apply_day(coalesce(nullif(pl->>'site',''), r.site), pl->>'date', pl->'rows', p.id, r.data->>'by');
    elsif r.type = 'machine_move' then
      perform asys.do_move(pl->>'machineId', coalesce(pl->>'toSite',''), coalesce(nullif(pl->>'date',''), to_char(current_date,'YYYY-MM-DD')), p.id, coalesce(pl->>'note','') || ' (' || coalesce(r.data->>'by','') || ')');
    end if;
  end if;
  update requests set status = case when p_approve then 'approved' else 'rejected' end,
    data = data || jsonb_build_object('decidedBy', p.id, 'decidedAt', now()) where id = p_id;
end $$;

-- ---------- kişiler (admin) ----------
-- p_sites: ["wb-astana",...] → kişinin görebildiği şantiyeler; null = değiştirme
create or replace function mach_upsert_person(p_token text, p_id text, p_name text, p_email text, p_role text, p_active boolean, p_password text, p_sites jsonb)
returns jsonb language plpgsql security definer as $$
declare p people; pid text; r people; admins int; ss jsonb;
begin
  p := asys.require(p_token, true);
  if p_role not in ('admin','user','viewer') then raise exception 'bad_role'; end if;
  if p_email is null or position('@' in p_email) = 0 then raise exception 'bad_email'; end if;
  if length(trim(coalesce(p_name,''))) = 0 then raise exception 'name_required'; end if;
  pid := coalesce(nullif(p_id,''), 'p' || encode(gen_random_bytes(5),'hex'));
  -- son aktif yönetici kendini düşüremez / pasif yapamaz
  if pid = p.id and (p_role <> 'admin' or not coalesce(p_active,true)) then
    select count(*) into admins from people where role = 'admin' and active and id <> p.id;
    if admins = 0 then raise exception 'last_admin'; end if;
  end if;
  if p_sites is not null then
    ss := coalesce((select jsonb_agg(x) from jsonb_array_elements_text(p_sites) x where exists (select 1 from sites where id = x)), '[]'::jsonb);
  end if;
  insert into people(id, name, email, role, active, sites) values (pid, trim(p_name), lower(trim(p_email)), p_role, coalesce(p_active,true), coalesce(ss,'[]'::jsonb))
    on conflict (id) do update set name = excluded.name, email = excluded.email, role = excluded.role, active = excluded.active, sites = coalesce(ss, people.sites)
    returning * into r;
  if p_password is not null and length(p_password) >= 6 then
    insert into pins(person_id, pin_hash, must_change) values (pid, crypt(p_password, gen_salt('bf')), true)
      on conflict (person_id) do update set pin_hash = excluded.pin_hash, must_change = true;
    if pid <> p.id then perform mach_revoke_person(p_token, pid); end if;   -- şifre sıfırlandı: kişinin açık oturumları kapanır
  end if;
  return jsonb_build_object('id', r.id, 'name', r.name, 'email', r.email, 'role', r.role, 'active', r.active, 'sites', r.sites, 'lastLogin', r.last_login);
end $$;
-- v1 imzası (7 parametre): şantiye listesi değişmez
create or replace function mach_upsert_person(p_token text, p_id text, p_name text, p_email text, p_role text, p_active boolean, p_password text)
returns jsonb language sql security definer as $$ select mach_upsert_person(p_token, p_id, p_name, p_email, p_role, p_active, p_password, null); $$;

create or replace function mach_sessions(p_token text)
returns jsonb language plpgsql security definer stable as $$
declare p people;
begin
  p := asys.require(p_token, true);
  return coalesce((select jsonb_agg(jsonb_build_object('person', person_id, 'at', created_at, 'exp', expires_at) order by created_at desc) from sessions where expires_at > now()), '[]'::jsonb);
end $$;

create or replace function mach_revoke_person(p_token text, p_person text)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := asys.require(p_token, true);
  delete from sessions where person_id = p_person and token <> p_token;
end $$;

create or replace function mach_delete_person(p_token text, p_person text)
returns void language plpgsql security definer as $$
declare p people; n int;
begin
  p := asys.require(p_token, true);
  if p_person = p.id then raise exception 'self'; end if;
  select count(*) into n from days where saved_by = p_person
    or exists (select 1 from jsonb_array_elements(history) h where h->>'by' = p_person or h->>'requestedBy' = p_person);
  if n > 0 then raise exception 'has_records'; end if;
  select count(*) into n from incidents where data->>'by' = p_person;
  if n > 0 then raise exception 'has_records'; end if;
  select count(*) into n from requests where data->>'by' = p_person or data->>'decidedBy' = p_person;
  if n > 0 then raise exception 'has_records'; end if;
  select count(*) into n from machine_moves where by_person = p_person;
  if n > 0 then raise exception 'has_records'; end if;
  delete from people where id = p_person;   -- pins ve sessions cascade ile silinir
end $$;

-- ---------- yetkiler ----------
grant execute on function
  mach_login(text,text), mach_logout(text), mach_change_password(text,text,text), mach_fetch(text,text),
  mach_save_day(text,text,jsonb,text), mach_save_day(text,text,jsonb), mach_ref_upsert(text,text,text,jsonb), mach_set_setting(text,text,jsonb),
  mach_site_upsert(text,text,text,boolean,jsonb), mach_site_delete(text,text), mach_move_machine(text,text,text,text,text),
  mach_incident_set(text,text,jsonb), mach_incident_delete(text,text),
  mach_request_create(text,text,text,jsonb,text), mach_decide(text,text,boolean),
  mach_upsert_person(text,text,text,text,text,boolean,text,jsonb), mach_upsert_person(text,text,text,text,text,boolean,text), mach_sessions(text), mach_revoke_person(text,text), mach_delete_person(text,text)
  to anon, authenticated;

-- ---------- sertleştirme ----------
-- SECURITY DEFINER fonksiyonlarda search_path sabitlenir (Supabase güvenlik danışmanı: function_search_path_mutable).
-- pgcrypto Supabase'de "extensions" şemasındadır; yerelde public'te → ikisi de listede.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname = 'public' and p.proname like 'mach\_%') or n.nspname = 'asys' loop
    execute format('alter function %s set search_path = public, extensions', f.sig);
  end loop;
end $$;
create index if not exists sessions_person_idx on sessions (person_id);

-- PostgREST API önbelleğini yenile (yeni/değişen fonksiyonlar hemen görünsün)
notify pgrst, 'reload schema';
