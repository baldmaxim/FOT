-- Диагностика нагрузки на БД. Запускать на МАСТЕРЕ (RW-endpoint), НЕ на реплике.
-- MCP-инструмент смотрит на реплику и сессий приложения не видит.
-- Подключение локально: psql к RW-host кластера Yandex MDB c CA-сертификатом.

-- ───────────────────────────────────────────────────────────────────────────
-- 1) Снимок коннектов: сколько активно / idle / idle-in-transaction, по юзерам.
--    Если active близко к DATABASE_POOL_MAX (сейчас 10) и есть waiting — пул мал.
SELECT
  usename,
  application_name,
  state,
  count(*)                                         AS conns,
  max(now() - query_start)  FILTER (WHERE state='active')             AS oldest_active,
  max(now() - state_change) FILTER (WHERE state='idle in transaction') AS oldest_idle_txn
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY usename, application_name, state
ORDER BY conns DESC;

-- ───────────────────────────────────────────────────────────────────────────
-- 2) Живые активные запросы прямо сейчас (что именно крутится), от старых к новым.
SELECT
  pid,
  usename,
  client_addr,
  now() - query_start AS age,
  wait_event_type, wait_event,
  left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND state = 'active'
ORDER BY query_start ASC NULLS LAST
LIMIT 40;

-- ───────────────────────────────────────────────────────────────────────────
-- 3) Ожидания блокировок: кто кого блокирует (если есть idle-in-transaction).
SELECT
  blocked.pid          AS blocked_pid,
  blocked.query        AS blocked_query,
  blocking.pid         AS blocking_pid,
  blocking.state       AS blocking_state,
  blocking.query       AS blocking_query
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking
  ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE blocked.wait_event_type = 'Lock';

-- ───────────────────────────────────────────────────────────────────────────
-- 4) ТОП запросов (нужен pg_stat_statements). Сейчас расширение ВЫКЛЮЧЕНО —
--    включить в настройках кластера Yandex MDB:
--      shared_preload_libraries += pg_stat_statements  (требует рестарт кластера)
--      затем в нужной БД:  CREATE EXTENSION pg_stat_statements;
--    После накопления статистики — топ по суммарному времени:
SELECT
  calls,
  round(total_exec_time)            AS total_ms,
  round(mean_exec_time, 1)          AS mean_ms,
  round(100 * total_exec_time / sum(total_exec_time) OVER (), 1) AS pct,
  left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 25;
-- Сбросить накопленное:  SELECT pg_stat_statements_reset();
