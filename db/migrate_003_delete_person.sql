-- Migration 003 (10.11.2026): kullanıcı silme — yalnızca hiç kaydı olmayan kişi silinebilir (geçmiş bütünlüğü için).
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
grant execute on function mach_delete_person(text,text) to anon, authenticated;
