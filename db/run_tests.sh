#!/bin/bash
# Yerel PostgreSQL'de şemayı sıfırdan kurar ve fonksiyon testlerini çalıştırır.
P="psql -h /tmp -p 5444 -U postgres -q -v ON_ERROR_STOP=1"
$P -c "drop database if exists mach_t" && $P -c "create database mach_t" && \
$P -d mach_t -c "do \$\$ begin create role anon nologin; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin; exception when duplicate_object then null; end \$\$;" && \
$P -d mach_t -f "$(dirname "$0")/schema.sql" && \
psql -h /tmp -p 5444 -U postgres -d mach_t -At -v ON_ERROR_STOP=1 -f "$(dirname "$0")/test_schema.sql" 2>&1 | grep -E "^(PASS|FAIL)|ERROR"
