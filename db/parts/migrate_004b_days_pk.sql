-- Geçiş 004b: gün tablosu anahtarı (date) → (site, date). Tek "drop" içeren adım; ayrı çalıştırılır.
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'days'::regclass and contype = 'p' and array_length(conkey,1) = 1) then
    alter table days drop constraint days_pkey;
    alter table days add primary key (site, date);
  end if;
end $$;
