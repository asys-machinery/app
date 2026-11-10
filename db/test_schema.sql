-- Şema fonksiyon testleri (yerel PostgreSQL). psql -d mach -f db/test_schema.sql
\set ON_ERROR_STOP 1
\set QUIET 1
create or replace function t_expect_err(p_sql text, p_err text) returns text language plpgsql as $$
begin
  execute p_sql; return 'FAIL ' || p_sql || ' — hata bekleniyordu: ' || p_err;
exception when others then
  if sqlerrm = p_err then return 'PASS ' || p_err; else return 'FAIL ' || p_sql || ' — beklenen ' || p_err || ', gelen ' || sqlerrm; end if;
end $$;
create temp table tk(k text, v text);

-- 1. giriş
insert into tk select 'admin', (mach_login('huseyin.ozkan@asys-machinery.com','__GECICI_SIFRE__'))->>'token';
select case when (select v from tk where k='admin') is not null then 'PASS admin login' else 'FAIL admin login' end;
select case when (mach_login('HUSEYIN.OZKAN@asys-machinery.com','__GECICI_SIFRE__'))->>'mustChange' = 'true' then 'PASS mustChange ilk girişte true (büyük/küçük harf duyarsız e-posta)' else 'FAIL mustChange' end;
select t_expect_err($$select mach_login('huseyin.ozkan@asys-machinery.com','yanlis')$$, 'bad_login');
select t_expect_err($$select mach_fetch('yok-token')$$, 'not_logged_in');

select case when (select last_login from people where id='p-huseyin') is not null then 'PASS last_login girişte güncellendi' else 'FAIL last_login' end;
select case when (mach_fetch((select v from tk where k='admin')))->'people'->0->>'lastLogin' is not null then 'PASS lastLogin admin fetch' else 'FAIL lastLogin fetch' end;

-- 2. şifre değiştir
select t_expect_err(format($$select mach_change_password(%L,'yanlis','Yeni123456')$$,(select v from tk where k='admin')), 'bad_old');
select t_expect_err(format($$select mach_change_password(%L,'__GECICI_SIFRE__','123')$$,(select v from tk where k='admin')), 'too_short');
select mach_change_password((select v from tk where k='admin'),'__GECICI_SIFRE__','Yeni123456');
select case when (mach_fetch((select v from tk where k='admin')))->'me'->>'mustChange' = 'false' then 'PASS şifre değişti, mustChange false' else 'FAIL mustChange after change' end;

-- 3. kişiler: kullanıcı + viewer ekle
select mach_upsert_person((select v from tk where k='admin'),'', 'Бауыржан Беркынбай','bauyrzhan@test.kz','user',true,'Gecici123','["wb-astana"]');
select mach_upsert_person((select v from tk where k='admin'),'p-view', 'Gözlemci','viewer@test.kz','viewer',true,'Gecici123','["wb-astana","yok-site"]');
select case when (select sites from people where id='p-view') = '["wb-astana"]'::jsonb then 'PASS sites: var olmayan şantiye süzüldü' else 'FAIL sites filter' end;
select t_expect_err(format($$select mach_upsert_person(%L,'','X','yok','user',true,'Gecici123')$$,(select v from tk where k='admin')), 'bad_email');
select t_expect_err(format($$select mach_upsert_person(%L,'','X','x@x.kz','boss',true,'Gecici123')$$,(select v from tk where k='admin')), 'bad_role');
select t_expect_err(format($$select mach_upsert_person(%L,'p-huseyin','Hüseyin Özkan','huseyin.ozkan@asys-machinery.com','user',true,null)$$,(select v from tk where k='admin')), 'last_admin');
insert into tk select 'user', (mach_login('bauyrzhan@test.kz','Gecici123'))->>'token';
insert into tk select 'view', (mach_login('viewer@test.kz','Gecici123'))->>'token';
select case when (select count(*) from tk where v is not null) = 3 then 'PASS 3 oturum' else 'FAIL oturumlar' end;
-- kullanıcı e-postaları görmez, admin görür
select case when (mach_fetch((select v from tk where k='user')))->'people'->0->>'email' is null and (mach_fetch((select v from tk where k='admin')))->'people'->0->>'email' is not null then 'PASS e-posta yalnız admin görür' else 'FAIL email visibility' end;
-- kullanıcı admin işi yapamaz
select t_expect_err(format($$select mach_upsert_person(%L,'','X','x@x.kz','user',true,'Gecici123')$$,(select v from tk where k='user')), 'admin_required');
select t_expect_err(format($$select mach_ref_upsert(%L,'machines','m1','{"code":"X"}')$$,(select v from tk where k='user')), 'admin_required');
select t_expect_err(format($$select mach_set_setting(%L,'site','{}')$$,(select v from tk where k='user')), 'admin_required');

-- 4. tanımlar
select mach_ref_upsert((select v from tk where k='admin'),'machines','dmp-01','{"id":"dmp-01","code":"Д-01","type":"Ножничный подъёмник","active":true,"site":"wb-astana"}');
select mach_ref_upsert((select v from tk where k='admin'),'machines','dmp-02','{"id":"dmp-02","code":"Д-02","type":"Ножничный подъёмник","active":true,"site":"wb-astana"}');
select mach_ref_upsert((select v from tk where k='admin'),'teams','t1','{"id":"t1","name":"Бригада Муратов","active":true}');
select mach_ref_upsert((select v from tk where k='admin'),'operators','o1','{"id":"o1","name":"Ерик","teamId":"t1","active":true}');
select t_expect_err(format($$select mach_ref_upsert(%L,'users','x','{}')$$,(select v from tk where k='admin')), 'bad_col');
select case when ((mach_fetch((select v from tk where k='user')))->'machines') ? 'dmp-01' then 'PASS kullanıcı makineleri okur' else 'FAIL' end;

-- 5. gün kaydı: ilk kayıt, birleştirme, geçmiş
select case when (mach_save_day((select v from tk where k='user'), to_char(current_date,'YYYY-MM-DD'), '{"dmp-01":{"teamId":"t1","opId":"o1","status":"work","hrs":8},"dmp-02":{"teamId":"t1","opId":null,"status":"idle"}}'))->>'changed' = '2' then 'PASS ilk kayıt 2 satır' else 'FAIL first save' end;
-- başka kullanıcı (admin) sadece dmp-02 değiştirir; dmp-01 korunmalı
select case when (mach_save_day((select v from tk where k='admin'), to_char(current_date,'YYYY-MM-DD'), '{"dmp-02":{"teamId":"t1","opId":null,"status":"broken","note":"течь"}}'))->>'changed' = '1' then 'PASS ikinci kayıt 1 satır' else 'FAIL merge' end;
select case when rec->'dmp-01'->>'status'='work' and rec->'dmp-02'->>'status'='broken' and saved_by='p-huseyin' then 'PASS birleştirme: dmp-01 korundu, dmp-02 güncellendi' else 'FAIL merge content '||rec::text end from days where date = to_char(current_date,'YYYY-MM-DD');
select case when jsonb_array_length(history)=2 and history->0->>'first'='true' and (history->0->>'n')='2' and (history->1->>'n')='1' and history->1->'ch'->0->>'f' in ('status','note') and (history->1->'ch'->0->>'m')='dmp-02' then 'PASS geçmiş: ilk kayıt + alan bazlı fark' else 'FAIL history '||history::text end from days where date = to_char(current_date,'YYYY-MM-DD');
-- değişiklik yoksa kayıt yok
select case when (mach_save_day((select v from tk where k='user'), to_char(current_date,'YYYY-MM-DD'), '{"dmp-01":{"teamId":"t1","opId":"o1","status":"work","hrs":8}}'))->>'changed' = '0' then 'PASS aynı veri → changed 0' else 'FAIL no-change' end;
select case when jsonb_array_length(history)=2 then 'PASS geçmişe boş kayıt eklenmedi' else 'FAIL empty history entry' end from days where date = to_char(current_date,'YYYY-MM-DD');
-- viewer yazamaz
select t_expect_err(format($$select mach_save_day(%L,%L,'{}')$$,(select v from tk where k='view'),to_char(current_date,'YYYY-MM-DD')), 'read_only');
select t_expect_err(format($$select mach_incident_set(%L,'i1','{}')$$,(select v from tk where k='view')), 'read_only');
-- kilitli gün: kullanıcı yazamaz, admin yazar
select t_expect_err(format($$select mach_save_day(%L,%L,'{"dmp-01":{"status":"idle"}}')$$,(select v from tk where k='user'),to_char(current_date-10,'YYYY-MM-DD')), 'locked');
select case when (mach_save_day((select v from tk where k='admin'), to_char(current_date-10,'YYYY-MM-DD'), '{"dmp-01":{"status":"idle"}}'))->>'changed'='1' then 'PASS admin kilitli güne yazar' else 'FAIL' end;
select t_expect_err(format($$select mach_save_day(%L,'27.10.2026','{}')$$,(select v from tk where k='admin')), 'bad_date');

-- 6. arıza
select mach_incident_set((select v from tk where k='user'),'inc1', '{"id":"inc1","date":"2026-11-09","machineId":"dmp-02","type":"breakdown","opId":"o1","teamId":"t1","open":true,"by":"x"}');
select case when (mach_fetch((select v from tk where k='view')))->'incidents'->'inc1'->>'machineId'='dmp-02' then 'PASS arıza kaydı okunuyor (viewer dahil)' else 'FAIL incident' end;
select t_expect_err(format($$select mach_incident_delete(%L,'inc1')$$,(select v from tk where k='user')), 'admin_required');
select mach_incident_delete((select v from tk where k='admin'),'inc1');
select case when (mach_fetch((select v from tk where k='admin')))->'incidents' = '{}'::jsonb then 'PASS arıza silindi' else 'FAIL' end;

-- 7. talepler: kullanıcı açar → admin onaylar/reddeder; sunucu uygular
select mach_request_create((select v from tk where k='user'),'r1','machine_add','{"machine":{"id":"dmp-21","code":"Д-21","type":"Тест","year":2024}}','Д-21');
select mach_request_create((select v from tk where k='user'),'r2','toggle','{"col":"machines","id":"dmp-02","active":false}','Д-02 скрыть');
select mach_request_create((select v from tk where k='user'),'r3','team_add','{"team":{"id":"t2","name":"Бригада X"}}','Бригада X');
select mach_request_create((select v from tk where k='user'),'r4','operator_add','{"operator":{"id":"o2","name":"Тестов","teamId":"t1"}}','Тестов');
select mach_request_create((select v from tk where k='user'),'r5','day_edit',format('{"date":"%s","rows":{"dmp-01":{"status":"absent"}}}',to_char(current_date-10,'YYYY-MM-DD'))::jsonb,'kilitli gün');
select t_expect_err(format($$select mach_request_create(%L,'rx','delete_all','{}','x')$$,(select v from tk where k='user')), 'bad_type');
select t_expect_err(format($$select mach_decide(%L,'r1',true)$$,(select v from tk where k='user')), 'admin_required');
select case when (mach_fetch((select v from tk where k='user')))->'requests'->'r1'->>'status'='pending' and (mach_fetch((select v from tk where k='user')))->'requests'->'r1'->>'by' is not null then 'PASS talep pending, by dolu' else 'FAIL request fetch' end;
select mach_decide((select v from tk where k='admin'),'r1',true);
select mach_decide((select v from tk where k='admin'),'r2',true);
select mach_decide((select v from tk where k='admin'),'r3',false);
select mach_decide((select v from tk where k='admin'),'r4',true);
select mach_decide((select v from tk where k='admin'),'r5',true);
select t_expect_err(format($$select mach_decide(%L,'r1',true)$$,(select v from tk where k='admin')), 'already_decided');
select t_expect_err(format($$select mach_decide(%L,'yok',true)$$,(select v from tk where k='admin')), 'no_request');
select case when data->>'code'='Д-21' and (data->>'active')='true' and (data->>'year')='2024' then 'PASS machine_add onayı → makine eklendi' else 'FAIL '||data::text end from machines where id='dmp-21';
select case when (data->>'active')='false' and data->>'code'='Д-02' then 'PASS toggle onayı → Д-02 pasif, diğer alanlar korundu' else 'FAIL toggle' end from machines where id='dmp-02';
select case when not exists (select 1 from teams where id='t2') then 'PASS red → ekip eklenmedi' else 'FAIL reject applied' end;
select case when data->>'name'='Тестов' and data->>'teamId'='t1' then 'PASS operator_add onayı' else 'FAIL op' end from operators where id='o2';
select case when rec->'dmp-01'->>'status'='absent' and history->-1->>'requestedBy' is not null and history->-1->>'by'='p-huseyin' then 'PASS day_edit onayı → uygulandı, requestedBy kayıtlı' else 'FAIL day_edit '||history::text end from days where site='wb-astana' and date=to_char(current_date-10,'YYYY-MM-DD');
select case when status='rejected' and data->>'decidedBy'='p-huseyin' and data->>'decidedAt' is not null then 'PASS red kaydı decidedBy/At' else 'FAIL' end from requests where id='r3';

-- 8. ayarlar + kilit süresi
select mach_set_setting((select v from tk where k='admin'),'site','{"project":"Wildberries Astana","lockDays":30,"zones":["Склад 1"]}');
select case when (mach_fetch((select v from tk where k='user')))->'settings'->>'lockDays'='30' then 'PASS ayar okunuyor' else 'FAIL settings' end;
select t_expect_err(format($$select mach_save_day(%L,%L,'{"dmp-01":{"status":"idle"}}')$$,(select v from tk where k='user'),to_char(current_date-40,'YYYY-MM-DD')), 'locked');
select case when (mach_save_day((select v from tk where k='user'), to_char(current_date-2,'YYYY-MM-DD'), '{"dmp-01":{"status":"idle"}}'))->>'changed'='1' then 'PASS 2 gün önce kilitli değil' else 'FAIL' end;

-- 8b. kullanıcı silme
select mach_upsert_person((select v from tk where k='admin'),'p-tmp','Geçici Kişi','tmp@test.kz','user',true,'Gecici123');
select t_expect_err(format($$select mach_delete_person(%L,'p-huseyin')$$,(select v from tk where k='admin')), 'self');
select t_expect_err(format($$select mach_delete_person(%L,(select id from people where email='bauyrzhan@test.kz'))$$,(select v from tk where k='admin')), 'has_records');
select t_expect_err(format($$select mach_delete_person(%L,'p-tmp')$$,(select v from tk where k='user')), 'admin_required');
select mach_delete_person((select v from tk where k='admin'),'p-tmp');
select case when not exists (select 1 from people where id='p-tmp') and not exists (select 1 from pins where person_id='p-tmp') then 'PASS kayıtsız kullanıcı silindi (pins dahil)' else 'FAIL delete' end;

-- 8c. ÇOKLU ŞANTİYE
select t_expect_err(format($$select mach_site_upsert(%L,'','Yeni','true','{}')$$,(select v from tk where k='user')), 'admin_required');
select t_expect_err(format($$select mach_site_upsert(%L,'','  ',true,'{}')$$,(select v from tk where k='admin')), 'name_required');
select mach_site_upsert((select v from tk where k='admin'),'s-alm','Wildberries Almaty',true,'{"lockDays":5,"zones":["Блок A"]}');
select case when (mach_fetch((select v from tk where k='admin')))->'sites'->'s-alm'->>'name'='Wildberries Almaty' then 'PASS şantiye eklendi, fetch' else 'FAIL site fetch' end;
-- kullanıcı yalnızca kendi şantiyesinin verisini görür; parktaki makineleri görür
select mach_ref_upsert((select v from tk where k='admin'),'machines','alm-01','{"id":"alm-01","code":"A-01","type":"Телескоп","active":true,"site":"s-alm"}');
select mach_ref_upsert((select v from tk where k='admin'),'machines','park-01','{"id":"park-01","code":"P-01","type":"Кран","active":true}');
select mach_ref_upsert((select v from tk where k='admin'),'teams','t-alm','{"id":"t-alm","name":"Бригада Алматы","active":true,"site":"s-alm"}');
select case when (select site from machines where id='alm-01')='s-alm' and (select site from machines where id='park-01')='' and (select data ? 'site' from machines where id='alm-01')=false then 'PASS site sütuna yazıldı, veride tutulmadı' else 'FAIL site column' end;
select case when ((mach_fetch((select v from tk where k='user')))->'machines' ? 'alm-01')=false and ((mach_fetch((select v from tk where k='user')))->'machines' ? 'park-01')=true and ((mach_fetch((select v from tk where k='user')))->'machines' ? 'dmp-01')=true then 'PASS kullanıcı: kendi şantiyesi + park makineleri' else 'FAIL user machines' end;
select case when ((mach_fetch((select v from tk where k='user')))->'teams' ? 't-alm')=false and ((mach_fetch((select v from tk where k='admin')))->'teams' ? 't-alm')=true then 'PASS kullanıcı başka şantiyenin ekibini görmez' else 'FAIL teams filter' end;
select case when (mach_fetch((select v from tk where k='admin')))->'machines'->'alm-01'->>'site'='s-alm' then 'PASS fetch makineye site ekler' else 'FAIL' end;
-- gün kaydı: şantiye zorunlu / erişim / kilit şantiyeye göre
select t_expect_err(format($$select mach_save_day(%L,%L,'{"alm-01":{"status":"idle"}}','s-alm')$$,(select v from tk where k='user'),to_char(current_date,'YYYY-MM-DD')), 'no_site_access');
select t_expect_err(format($$select mach_save_day(%L,%L,'{}','yok')$$,(select v from tk where k='admin'),to_char(current_date,'YYYY-MM-DD')), 'bad_site');
select t_expect_err(format($$select mach_save_day(%L,%L,'{}')$$,(select v from tk where k='admin'),to_char(current_date,'YYYY-MM-DD')), 'site_required');
select case when (mach_save_day((select v from tk where k='admin'), to_char(current_date,'YYYY-MM-DD'), '{"alm-01":{"status":"work","hrs":8}}','s-alm'))->>'changed'='1' then 'PASS admin Almaty gününü yazdı' else 'FAIL' end;
select case when (select count(*) from days where date=to_char(current_date,'YYYY-MM-DD'))=2 then 'PASS aynı tarih iki şantiyede ayrı kayıt' else 'FAIL days pk' end;
select case when ((mach_fetch((select v from tk where k='admin')))->'days' ? ('s-alm|'||to_char(current_date,'YYYY-MM-DD')))=true and ((mach_fetch((select v from tk where k='user')))->'days' ? ('s-alm|'||to_char(current_date,'YYYY-MM-DD')))=false then 'PASS gün anahtarı site|date; kullanıcı süzülür' else 'FAIL days key' end;
select mach_upsert_person((select v from tk where k='admin'),(select id from people where email='bauyrzhan@test.kz'),'Бауыржан Беркынбай','bauyrzhan@test.kz','user',true,null,'["wb-astana","s-alm"]');
select t_expect_err(format($$select mach_save_day(%L,%L,'{"alm-01":{"status":"idle"}}','s-alm')$$,(select v from tk where k='user'),to_char(current_date-6,'YYYY-MM-DD')), 'locked');
select case when (mach_save_day((select v from tk where k='user'), to_char(current_date-4,'YYYY-MM-DD'), '{"alm-01":{"status":"idle"}}','s-alm'))->>'changed'='1' then 'PASS Almaty kilidi 5 gün (şantiyeye özel)' else 'FAIL per-site lock' end;
select t_expect_err(format($$select mach_save_day(%L,%L,'{"dmp-01":{"status":"idle"}}')$$,(select v from tk where k='user'),to_char(current_date,'YYYY-MM-DD')), 'site_required');
-- taşıma: admin doğrudan, kullanıcı taleple
select t_expect_err(format($$select mach_move_machine(%L,'park-01','s-alm','2026-11-10','')$$,(select v from tk where k='user')), 'admin_required');
select t_expect_err(format($$select mach_move_machine(%L,'park-01','yok','2026-11-10','')$$,(select v from tk where k='admin')), 'bad_site');
select t_expect_err(format($$select mach_move_machine(%L,'park-01','','2026-11-10','')$$,(select v from tk where k='admin')), 'same_site');
select mach_move_machine((select v from tk where k='admin'),'park-01','s-alm','2026-11-10','ilk sevk');
select case when (select site from machines where id='park-01')='s-alm' and (select count(*) from machine_moves where machine_id='park-01' and from_site='' and to_site='s-alm' and by_person='p-huseyin')=1 then 'PASS taşıma uygulandı + günlük' else 'FAIL move' end;
select mach_request_create((select v from tk where k='user'),'r6','machine_move','{"machineId":"park-01","toSite":"wb-astana","date":"2026-11-11","note":"lazım","site":"wb-astana"}','P-01 → Astana');
select t_expect_err(format($$select mach_request_create(%L,'r7','machine_move','{"machineId":"park-01","toSite":"gizli","site":"wb-astana"}','x')$$,(select v from tk where k='user')), 'no_site_access');
select mach_site_upsert((select v from tk where k='admin'),'s-gizli','Gizli',true,'{}');
select t_expect_err(format($$select mach_request_create(%L,'r8','day_edit','{"date":"2026-11-01","rows":{},"site":"s-gizli"}','x')$$,(select v from tk where k='user')), 'no_site_access');
select case when (select site from requests where id='r6')='wb-astana' and (select (data->'payload') ? 'site' from requests where id='r6')=false then 'PASS talep şantiyesi sütunda' else 'FAIL request site' end;
select mach_decide((select v from tk where k='admin'),'r6',true);
select case when (select site from machines where id='park-01')='wb-astana' and (select count(*) from machine_moves where machine_id='park-01')=2 then 'PASS taşıma talebi onayı → makine taşındı, günlük' else 'FAIL move request' end;
select case when jsonb_array_length((mach_fetch((select v from tk where k='admin')))->'moves')=2 and jsonb_array_length((mach_fetch((select v from tk where k='user')))->'moves')=0 then 'PASS taşıma günlüğü yalnız admin' else 'FAIL moves' end;
-- arıza: şantiye makineden türetilir, erişim denetimi
select mach_incident_set((select v from tk where k='user'),'inc-alm','{"id":"inc-alm","date":"2026-11-10","machineId":"alm-01","type":"breakdown","open":true,"by":"x"}');
select case when (select site from incidents where id='inc-alm')='s-alm' then 'PASS arıza şantiyesi makineden' else 'FAIL inc site' end;
select mach_upsert_person((select v from tk where k='admin'),(select id from people where email='bauyrzhan@test.kz'),'Бауыржан Беркынбай','bauyrzhan@test.kz','user',true,null,'["wb-astana"]');
select t_expect_err(format($$select mach_incident_set(%L,'inc-alm2','{"id":"inc-alm2","date":"2026-11-10","machineId":"alm-01","type":"breakdown","by":"x"}')$$,(select v from tk where k='user')), 'no_site_access');
select case when ((mach_fetch((select v from tk where k='user')))->'incidents' ? 'inc-alm')=false then 'PASS kullanıcı başka şantiyenin arızasını görmez' else 'FAIL inc filter' end;
-- şantiye pasifleştirme: makinesi varsa olmaz
select t_expect_err(format($$select mach_site_upsert(%L,'s-alm','Wildberries Almaty',false,'{}')$$,(select v from tk where k='admin')), 'site_has_machines');
select mach_site_upsert((select v from tk where k='admin'),'s-gizli','Gizli',false,'{}');
select case when (select active from sites where id='s-gizli')=false then 'PASS boş şantiye pasif yapıldı' else 'FAIL' end;
select t_expect_err(format($$select mach_move_machine(%L,'alm-01','s-gizli','2026-11-10','')$$,(select v from tk where k='admin')), 'bad_site');
-- talep: ekip ekleme şantiyeye bağlanır
select mach_request_create((select v from tk where k='user'),'r9','team_add','{"team":{"id":"t9","name":"Бригада 9"},"site":"wb-astana"}','Бригада 9');
select mach_decide((select v from tk where k='admin'),'r9',true);
select case when (select site from teams where id='t9')='wb-astana' and (select data ? 'site' from teams where id='t9')=false then 'PASS team_add onayı → şantiye sütunda' else 'FAIL team site' end;

-- 9. oturumlar
select case when jsonb_array_length(mach_sessions((select v from tk where k='admin'))) >= 3 then 'PASS oturum listesi' else 'FAIL sessions' end;
select t_expect_err(format($$select mach_sessions(%L)$$,(select v from tk where k='user')), 'admin_required');
select mach_revoke_person((select v from tk where k='admin'), (select id from people where email='bauyrzhan@test.kz'));
select t_expect_err(format($$select mach_fetch(%L)$$,(select v from tk where k='user')), 'not_logged_in');
-- şifre sıfırlama oturumları düşürür + mustChange
insert into tk select 'view2', (mach_login('viewer@test.kz','Gecici123'))->>'token';
select mach_upsert_person((select v from tk where k='admin'),'p-view','Gözlemci','viewer@test.kz','viewer',true,'Yenisifre1');
select t_expect_err(format($$select mach_fetch(%L)$$,(select v from tk where k='view2')), 'not_logged_in');
select case when (mach_login('viewer@test.kz','Yenisifre1'))->>'mustChange'='true' then 'PASS sıfırlanan şifre: eski oturum düştü, yeni girişte mustChange' else 'FAIL reset' end;
-- pasif kullanıcı giremez
select mach_upsert_person((select v from tk where k='admin'),'p-view','Gözlemci','viewer@test.kz','viewer',false,null);
select t_expect_err($$select mach_login('viewer@test.kz','Yenisifre1')$$, 'bad_login');
-- çıkış
select mach_logout((select v from tk where k='admin'));
select t_expect_err(format($$select mach_fetch(%L)$$,(select v from tk where k='admin')), 'not_logged_in');

-- 10. anon tablo erişimi yok
set role anon;
select t_expect_err($$select * from machines$$, 'permission denied for table machines');
select t_expect_err($$select * from pins$$, 'permission denied for table pins');
select t_expect_err($$select mach_apply_day('wb-astana','2026-01-01','{}','x')$$, 'permission denied for function mach_apply_day');
select t_expect_err($$select mach_do_move('x','','2026-01-01','x','')$$, 'permission denied for function mach_do_move');
select t_expect_err($$select * from sites$$, 'permission denied for table sites');
reset role;
