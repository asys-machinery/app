# ASYS Machinery

Учёт строительной техники: ежедневный журнал (машина → бригада → оператор), табель, поломки, отчёты.
Веб-приложение (PWA) на GitHub Pages; данные — Supabase (PostgreSQL), доступ только по e-mail и паролю.

- Приложение: https://asys-machinery.github.io/app/
- База: `db/schema.sql` (таблицы, роли, функции `mach_*`), тесты `db/test_schema.sql`
- Настройка подключения: скопируйте `config.example.js` → `config.js` и впишите URL и anon-ключ проекта Supabase.
