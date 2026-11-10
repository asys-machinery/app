-- Migration 002 (10.11.2026): kişiler tablosuna son giriş zamanı. schema.sql kuruluysa bunu çalıştırın.
alter table people add column if not exists last_login timestamptz;

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
