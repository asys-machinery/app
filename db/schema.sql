-- ASYS Machinery — Supabase şeması (v1, 09.11.2026)
-- Tarayıcı publishable (anon) anahtarla hiçbir tabloyu doğrudan OKUYAMAZ ve YAZAMAZ.
-- Tüm erişim aşağıdaki mach_* fonksiyonları üzerinden, e-posta+şifre ile alınan oturum token'ı ile yapılır.
-- Roller: admin (yönetici) · user (kullanıcı: günlük kayıt, arıza, talep) · viewer (sadece görüntüler)

create extension if not exists pgcrypto;

-- ---------- tablolar ----------
create table if not exists people (
  id          text primary key,
  name        text not null,
  email       text,
  role        text not null default 'user' check (role in ('admin','user','viewer')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  last_login  timestamptz
);
create unique index if not exists people_email_idx on people (lower(email));

create table if not exists pins (                 -- şifre hash'leri (bcrypt)
  person_id    text primary key references people(id) on delete cascade,
  pin_hash     text not null,
  must_change  boolean not null default true
);

create table if not exists sessions (
  token       text primary key,
  person_id   text not null references people(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '180 days'
);

create table if not exists machines  (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists teams     (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists operators (id text primary key, data jsonb not null, updated_at timestamptz not null default now());

create table if not exists days (
  date        text primary key,                   -- YYYY-MM-DD
  rec         jsonb not null default '{}'::jsonb, -- {machineId: {teamId,opId,loc,status,hrs,hStart,hEnd,fuel,note}}
  saved_by    text not null default '',
  saved_at    timestamptz not null default now(),
  history     jsonb not null default '[]'::jsonb  -- [{at,by,n,first,ch:[{m,f,a,b}],requestedBy}]
);

create table if not exists incidents (
  id          text primary key,
  date        text not null default '',
  machine_id  text not null default '',
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists requests (
  id          text primary key,
  type        text not null,                      -- machine_add | toggle | team_add | operator_add | day_edit
  status      text not null default 'pending',    -- pending | approved | rejected
  data        jsonb not null,                     -- {payload, summary, by, at, decidedBy, decidedAt}
  created_at  timestamptz not null default now()
);

create table if not exists settings (key text primary key, value jsonb not null default '{}'::jsonb);

-- ---------- RLS: hiçbir tabloda anon/authenticated politikası yok → yalnızca security definer fonksiyonlar ----------
alter table people    enable row level security;
alter table pins      enable row level security;
alter table sessions  enable row level security;
alter table machines  enable row level security;
alter table teams     enable row level security;
alter table operators enable row level security;
alter table days      enable row level security;
alter table incidents enable row level security;
alter table requests  enable row level security;
alter table settings  enable row level security;
grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;

-- ---------- yardımcılar ----------
create or replace function mach_require(p_token text, p_admin boolean default false, p_write boolean default false)
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

create or replace function mach_lock_days() returns int language sql security definer stable as $$
  select coalesce((select (value->>'lockDays')::int from settings where key = 'site'), 3);
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
  p := mach_require(p_token);
  if length(p_new) < 6 then raise exception 'too_short'; end if;
  select pin_hash into h from pins where person_id = p.id;
  if h is null or h <> crypt(p_old, h) then raise exception 'bad_old'; end if;
  update pins set pin_hash = crypt(p_new, gen_salt('bf')), must_change = false where person_id = p.id;
end $$;

-- ---------- veri okuma (tek çağrı) ----------
create or replace function mach_fetch(p_token text, p_since text default null)
returns jsonb language plpgsql security definer stable as $$
declare p people; since text; mc boolean;
begin
  p := mach_require(p_token);
  since := coalesce(p_since, to_char(now() - interval '400 days', 'YYYY-MM-DD'));
  select must_change into mc from pins where person_id = p.id;
  return jsonb_build_object(
    'me', jsonb_build_object('person', p.id, 'name', p.name, 'role', p.role, 'mustChange', coalesce(mc,false)),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'role',role,'active',active,
                 'email', case when p.role='admin' then email else null end,
                 'lastLogin', case when p.role='admin' then last_login else null end) order by name) from people), '[]'::jsonb),
    'machines',  coalesce((select jsonb_object_agg(id, data) from machines),  '{}'::jsonb),
    'teams',     coalesce((select jsonb_object_agg(id, data) from teams),     '{}'::jsonb),
    'operators', coalesce((select jsonb_object_agg(id, data) from operators), '{}'::jsonb),
    'days',      coalesce((select jsonb_object_agg(date, jsonb_build_object('date',date,'rec',rec,'savedBy',saved_by,'savedAt',saved_at,'history',history)) from days where date >= since), '{}'::jsonb),
    'incidents', coalesce((select jsonb_object_agg(id, data) from incidents), '{}'::jsonb),
    'requests',  coalesce((select jsonb_object_agg(id, data || jsonb_build_object('id',id,'type',type,'status',status)) from requests), '{}'::jsonb),
    'settings',  coalesce((select value from settings where key = 'site'), '{}'::jsonb)
  );
end $$;

-- ---------- günlük kayıt: sunucu tarafında birleştirme + değişiklik geçmişi ----------
-- p_rows: {machineId: row} — yalnızca değişen satırlar. Mevcut kayıt üzerine satır satır yazılır,
-- alan alan fark çıkarılıp geçmişe eklenir. Kilitli günlerde (today - lockDays) yalnızca admin yazar.
create or replace function mach_apply_day(p_date text, p_rows jsonb, p_by text, p_requested_by text default null)
returns jsonb language plpgsql security definer as $$
declare cur days; rec jsonb; hist jsonb; ch jsonb := '[]'::jsonb; m text; newrow jsonb; oldrow jsonb; f text; first boolean; n int := 0;
begin
  select * into cur from days where date = p_date;
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
  insert into days(date, rec, saved_by, saved_at, history) values (p_date, rec, p_by, now(), hist)
    on conflict (date) do update set rec = excluded.rec, saved_by = excluded.saved_by, saved_at = excluded.saved_at, history = excluded.history;
  return jsonb_build_object('changed', n);
end $$;
revoke execute on function mach_apply_day(text,jsonb,text,text) from anon, authenticated, public;

create or replace function mach_save_day(p_token text, p_date text, p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare p people;
begin
  p := mach_require(p_token, false, true);
  if p_date !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad_date'; end if;
  if p.role <> 'admin' and p_date::date < (current_date - mach_lock_days()) then raise exception 'locked'; end if;
  return mach_apply_day(p_date, p_rows, p.id, null);
end $$;

-- ---------- tanımlar (admin) ----------
create or replace function mach_ref_upsert(p_token text, p_col text, p_id text, p_data jsonb)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := mach_require(p_token, true);
  if p_col = 'machines' then insert into machines(id,data) values (p_id,p_data) on conflict (id) do update set data = excluded.data, updated_at = now();
  elsif p_col = 'teams' then insert into teams(id,data) values (p_id,p_data) on conflict (id) do update set data = excluded.data, updated_at = now();
  elsif p_col = 'operators' then insert into operators(id,data) values (p_id,p_data) on conflict (id) do update set data = excluded.data, updated_at = now();
  else raise exception 'bad_col'; end if;
end $$;

create or replace function mach_set_setting(p_token text, p_key text, p_value jsonb)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := mach_require(p_token, true);
  insert into settings(key, value) values (p_key, p_value) on conflict (key) do update set value = excluded.value;
end $$;

-- ---------- arızalar (kullanıcı+) ----------
create or replace function mach_incident_set(p_token text, p_id text, p_data jsonb)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := mach_require(p_token, false, true);
  insert into incidents(id, date, machine_id, data) values (p_id, coalesce(p_data->>'date',''), coalesce(p_data->>'machineId',''), p_data)
    on conflict (id) do update set date = excluded.date, machine_id = excluded.machine_id, data = excluded.data, updated_at = now();
end $$;

create or replace function mach_incident_delete(p_token text, p_id text)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := mach_require(p_token, true);
  delete from incidents where id = p_id;
end $$;

-- ---------- talepler: kullanıcı açar, admin karar verir (uygulama sunucuda) ----------
create or replace function mach_request_create(p_token text, p_id text, p_type text, p_payload jsonb, p_summary text)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := mach_require(p_token, false, true);
  if p_type not in ('machine_add','toggle','team_add','operator_add','day_edit') then raise exception 'bad_type'; end if;
  insert into requests(id, type, status, data) values (p_id, p_type, 'pending',
    jsonb_build_object('payload', p_payload, 'summary', coalesce(p_summary,''), 'by', p.id, 'at', now()));
end $$;

create or replace function mach_decide(p_token text, p_id text, p_approve boolean)
returns void language plpgsql security definer as $$
declare p people; r requests; pl jsonb; ex jsonb; col text;
begin
  p := mach_require(p_token, true);
  select * into r from requests where id = p_id;
  if r.id is null then raise exception 'no_request'; end if;
  if r.status <> 'pending' then raise exception 'already_decided'; end if;
  pl := r.data->'payload';
  if p_approve then
    if r.type = 'machine_add' then
      select data into ex from machines where id = pl->'machine'->>'id';
      insert into machines(id, data) values (pl->'machine'->>'id', coalesce(ex,'{}'::jsonb) || jsonb_strip_nulls(pl->'machine') || '{"active":true}'::jsonb)
        on conflict (id) do update set data = excluded.data, updated_at = now();
    elsif r.type = 'team_add' then
      select data into ex from teams where id = pl->'team'->>'id';
      insert into teams(id, data) values (pl->'team'->>'id', coalesce(ex,'{}'::jsonb) || (pl->'team') || '{"active":true}'::jsonb)
        on conflict (id) do update set data = excluded.data, updated_at = now();
    elsif r.type = 'operator_add' then
      select data into ex from operators where id = pl->'operator'->>'id';
      insert into operators(id, data) values (pl->'operator'->>'id', coalesce(ex,'{}'::jsonb) || (pl->'operator') || '{"active":true}'::jsonb)
        on conflict (id) do update set data = excluded.data, updated_at = now();
    elsif r.type = 'toggle' then
      col := pl->>'col';
      if col = 'machines' then update machines set data = data || jsonb_build_object('active', (pl->>'active')::boolean), updated_at = now() where id = pl->>'id';
      elsif col = 'teams' then update teams set data = data || jsonb_build_object('active', (pl->>'active')::boolean), updated_at = now() where id = pl->>'id';
      elsif col = 'operators' then update operators set data = data || jsonb_build_object('active', (pl->>'active')::boolean), updated_at = now() where id = pl->>'id';
      end if;
    elsif r.type = 'day_edit' then
      perform mach_apply_day(pl->>'date', pl->'rows', p.id, r.data->>'by');
    end if;
  end if;
  update requests set status = case when p_approve then 'approved' else 'rejected' end,
    data = data || jsonb_build_object('decidedBy', p.id, 'decidedAt', now()) where id = p_id;
end $$;

-- ---------- kişiler (admin) ----------
create or replace function mach_upsert_person(p_token text, p_id text, p_name text, p_email text, p_role text, p_active boolean, p_password text)
returns jsonb language plpgsql security definer as $$
declare p people; pid text; r people; admins int;
begin
  p := mach_require(p_token, true);
  if p_role not in ('admin','user','viewer') then raise exception 'bad_role'; end if;
  if p_email is null or position('@' in p_email) = 0 then raise exception 'bad_email'; end if;
  if length(trim(coalesce(p_name,''))) = 0 then raise exception 'name_required'; end if;
  pid := coalesce(nullif(p_id,''), 'p' || encode(gen_random_bytes(5),'hex'));
  -- son aktif yönetici kendini düşüremez / pasif yapamaz
  if pid = p.id and (p_role <> 'admin' or not coalesce(p_active,true)) then
    select count(*) into admins from people where role = 'admin' and active and id <> p.id;
    if admins = 0 then raise exception 'last_admin'; end if;
  end if;
  insert into people(id, name, email, role, active) values (pid, trim(p_name), lower(trim(p_email)), p_role, coalesce(p_active,true))
    on conflict (id) do update set name = excluded.name, email = excluded.email, role = excluded.role, active = excluded.active
    returning * into r;
  if p_password is not null and length(p_password) >= 6 then
    insert into pins(person_id, pin_hash, must_change) values (pid, crypt(p_password, gen_salt('bf')), true)
      on conflict (person_id) do update set pin_hash = excluded.pin_hash, must_change = true;
    if pid <> p.id then delete from sessions where person_id = pid; end if;
  end if;
  return jsonb_build_object('id', r.id, 'name', r.name, 'email', r.email, 'role', r.role, 'active', r.active);
end $$;

create or replace function mach_sessions(p_token text)
returns jsonb language plpgsql security definer stable as $$
declare p people;
begin
  p := mach_require(p_token, true);
  return coalesce((select jsonb_agg(jsonb_build_object('person', person_id, 'at', created_at, 'exp', expires_at) order by created_at desc) from sessions where expires_at > now()), '[]'::jsonb);
end $$;

create or replace function mach_revoke_person(p_token text, p_person text)
returns void language plpgsql security definer as $$
declare p people;
begin
  p := mach_require(p_token, true);
  delete from sessions where person_id = p_person and token <> p_token;
end $$;

create or replace function mach_delete_person(p_token text, p_person text)
returns void language plpgsql security definer as $$
declare p people; n int;
begin
  p := mach_require(p_token, true);
  if p_person = p.id then raise exception 'self'; end if;
  select count(*) into n from days where saved_by = p_person
    or exists (select 1 from jsonb_array_elements(history) h where h->>'by' = p_person or h->>'requestedBy' = p_person);
  if n > 0 then raise exception 'has_records'; end if;
  select count(*) into n from incidents where data->>'by' = p_person;
  if n > 0 then raise exception 'has_records'; end if;
  select count(*) into n from requests where data->>'by' = p_person or data->>'decidedBy' = p_person;
  if n > 0 then raise exception 'has_records'; end if;
  delete from people where id = p_person;   -- pins ve sessions cascade ile silinir
end $$;
-- ---------- yetkiler ----------
grant execute on function
  mach_login(text,text), mach_logout(text), mach_change_password(text,text,text), mach_fetch(text,text),
  mach_save_day(text,text,jsonb), mach_ref_upsert(text,text,text,jsonb), mach_set_setting(text,text,jsonb),
  mach_incident_set(text,text,jsonb), mach_incident_delete(text,text),
  mach_request_create(text,text,text,jsonb,text), mach_decide(text,text,boolean),
  mach_upsert_person(text,text,text,text,text,boolean,text), mach_sessions(text), mach_revoke_person(text,text), mach_delete_person(text,text)
  to anon, authenticated;
revoke execute on function mach_require(text,boolean,boolean), mach_lock_days() from anon, authenticated, public;

-- ---------- başlangıç ----------
insert into settings(key, value) values ('site', '{"project":"Wildberries Astana","lockDays":3,"zones":[]}'::jsonb) on conflict (key) do nothing;
-- İlk yönetici: ÇALIŞTIRMADAN ÖNCE aşağıdaki __GECICI_SIFRE__ yerine kendi geçici şifrenizi yazın (bu depo herkese açıktır; gerçek şifre buraya yazılmaz).
-- İlk girişte şifre değiştirmesi zorunludur.
insert into people(id, name, email, role) values ('p-huseyin', 'Hüseyin Özkan', 'huseyin.ozkan@asys-machinery.com', 'admin') on conflict (id) do nothing;
insert into pins(person_id, pin_hash, must_change) values ('p-huseyin', crypt('__GECICI_SIFRE__', gen_salt('bf')), true) on conflict (person_id) do nothing;
