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
