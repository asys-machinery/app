-- ASYS Machinery — Supabase şeması (v2, 10.11.2026: çoklu şantiye)
-- Tarayıcı publishable (anon) anahtarla hiçbir tabloyu doğrudan OKUYAMAZ ve YAZAMAZ.
-- Tüm erişim mach_* fonksiyonları üzerinden, e-posta+şifre ile alınan oturum token'ı ile yapılır.
-- Roller: admin (yönetici) · user (kullanıcı: günlük kayıt, arıza, talep) · viewer (sadece görüntüler)
-- Şantiye modeli: makineler şirketin tek parkıdır; her makinenin "site" alanı bulunduğu şantiyeyi gösterir,
-- '' (boş) = Makine Parkı (hiçbir şantiyede değil). Ekip/operatör/günlük kayıt/arıza/talep şantiyeye bağlıdır.
-- Kullanıcıların people.sites listesi hangi şantiyeleri görebileceğini belirler; admin hepsini görür.

create extension if not exists pgcrypto;
create schema if not exists asys;   -- iç fonksiyonlar (API'ye kapalı)

-- ---------- tablolar ----------
create table if not exists sites (
  id          text primary key,
  name        text not null,
  active      boolean not null default true,
  data        jsonb not null default '{}'::jsonb,   -- {zones:[...], lockDays:n}
  created_at  timestamptz not null default now()
);

create table if not exists people (
  id          text primary key,
  name        text not null,
  email       text,
  role        text not null default 'user' check (role in ('admin','user','viewer')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  last_login  timestamptz,
  sites       jsonb not null default '[]'::jsonb    -- ["wb-astana", ...]; admin için anlamsız (hepsi)
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

create table if not exists machines  (id text primary key, data jsonb not null, site text not null default '', updated_at timestamptz not null default now());
create table if not exists teams     (id text primary key, data jsonb not null, site text not null default '', updated_at timestamptz not null default now());
create table if not exists operators (id text primary key, data jsonb not null, site text not null default '', updated_at timestamptz not null default now());

create table if not exists machine_moves (          -- makine taşıma günlüğü (denetim)
  id          bigserial primary key,
  machine_id  text not null,
  from_site   text not null default '',
  to_site     text not null default '',
  moved_on    text not null,                       -- YYYY-MM-DD
  by_person   text not null default '',
  note        text not null default '',
  at          timestamptz not null default now()
);

create table if not exists days (
  site        text not null default '',
  date        text not null,                      -- YYYY-MM-DD
  rec         jsonb not null default '{}'::jsonb, -- {machineId: {teamId,opId,loc,status,hrs,hStart,hEnd,fuel,note}}
  saved_by    text not null default '',
  saved_at    timestamptz not null default now(),
  history     jsonb not null default '[]'::jsonb, -- [{at,by,n,first,ch:[{m,f,a,b}],requestedBy}]
  primary key (site, date)
);

create table if not exists incidents (
  id          text primary key,
  date        text not null default '',
  machine_id  text not null default '',
  site        text not null default '',
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists requests (
  id          text primary key,
  type        text not null,                      -- machine_add | toggle | team_add | operator_add | day_edit | machine_move
  status      text not null default 'pending',    -- pending | approved | rejected
  site        text not null default '',
  data        jsonb not null,                     -- {payload, summary, by, at, decidedBy, decidedAt}
  created_at  timestamptz not null default now()
);

create table if not exists settings (key text primary key, value jsonb not null default '{}'::jsonb);

-- ---------- RLS: hiçbir tabloda anon/authenticated politikası yok → yalnızca security definer fonksiyonlar ----------
alter table sites         enable row level security;
alter table people        enable row level security;
alter table pins          enable row level security;
alter table sessions      enable row level security;
alter table machines      enable row level security;
alter table teams         enable row level security;
alter table operators     enable row level security;
alter table machine_moves enable row level security;
alter table days          enable row level security;
alter table incidents     enable row level security;
alter table requests      enable row level security;
alter table settings      enable row level security;
grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
