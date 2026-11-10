
-- ---------- başlangıç ----------
insert into settings(key, value) values ('site', '{"project":"Wildberries Astana","lockDays":3,"zones":[]}'::jsonb) on conflict (key) do nothing;
insert into sites(id, name, active, data) values ('wb-astana', 'Wildberries Astana', true, '{"lockDays":3,"zones":[]}'::jsonb) on conflict (id) do nothing;
-- İlk yönetici: ÇALIŞTIRMADAN ÖNCE aşağıdaki __GECICI_SIFRE__ yerine kendi geçici şifrenizi yazın (bu depo herkese açıktır; gerçek şifre buraya yazılmaz).
-- İlk girişte şifre değiştirmesi zorunludur.
insert into people(id, name, email, role) values ('p-huseyin', 'Hüseyin Özkan', 'huseyin.ozkan@asys-machinery.com', 'admin') on conflict (id) do nothing;
insert into pins(person_id, pin_hash, must_change) values ('p-huseyin', crypt('__GECICI_SIFRE__', gen_salt('bf')), true) on conflict (person_id) do nothing;
