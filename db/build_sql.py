# db/parts/*.sql → db/schema.sql (sıfırdan kurulum) ve db/migrate_004_sites.sql (canlı veritabanı geçişi)
import os
D=os.path.dirname(os.path.abspath(__file__)); P=os.path.join(D,'parts')
r=lambda n:open(os.path.join(P,n),encoding='utf-8').read()
open(os.path.join(D,'schema.sql'),'w',encoding='utf-8').write(r('tables.sql')+'\n'+r('functions.sql')+r('seed.sql'))
open(os.path.join(D,'migrate_004_sites.sql'),'w',encoding='utf-8').write(r('migrate_004_ddl.sql')+r('functions.sql'))
print('ok')
