# Phase 10C report — Timesheet + schedules + attendance + approvals

**Дата:** 2026-05-12
**Скоуп:** runtime-домен табелей, расписаний, явок, аппрувов и связанных корректировок.
**Файлов:** ~25 (контроллеры + сервисы).

## Что сделано

### Контроллеры
- `controllers/timesheet.controller.ts` (~2080 строк): динамический WHERE (`empWhere/empParams`), helper-функции (`findApprovalLockForDate`, `loadApprovalLockedDatesForDepartment`, `countAcceptedMandatorySaturdays`, `resolvePlannedHoursByItems`, `resolveShiftDurationByItems`, `resolveAdjustmentApprovalStatus`) полностью на `query/queryOne`.
- `controllers/timesheet-approval.controller.ts` (~1250 строк): динамический WHERE для статусов/scope; `count(*)::int` precheck; в `getReviewList` adjustments через `= ANY($1::int[])` для employees и `= ANY($2::date[])` для skud-дат. Сохранён 23P01 → HTTP 409.
- `controllers/timesheet-weekend-memo.controller.ts`: один UPDATE с RETURNING.
- `controllers/timesheet-team-management.controller.ts`: scope-resolution + ILIKE-search; bulk fetch через `= ANY($N::uuid[])`.
- `controllers/timesheet-assigned-export.controller.ts`: экспорт по scope, формат CSV сохранён.
- `controllers/schedule.controller.ts`: ~22 supabase calls → 0. Локальный `SCHEDULE_ASSIGNMENT_JOIN`, dynamic INSERT/UPDATE для `work_schedules` (`day_overrides`/`cycle_days` через `$N::jsonb`).
- `controllers/correction-approval.controller.ts`: approval workflow + state-machine; multi-step операции в `withTransaction`.

### Сервисы
- `services/timesheet-period.service.ts`, `timesheet-range.service.ts`: чистая date/period math и SQL-builder.
- `services/timesheet-responsibles.service.ts`: UPSERT через `INSERT ... ON CONFLICT (...) DO UPDATE` row-by-row.
- `services/timesheet-department-assignments.service.ts`, `timesheet-workflow-recipients.service.ts`: SELECT/UPDATE с allowlist.
- `services/timesheet-object.service.ts`: `fetchRawEvents`/`fetchObjectMappings` — missing-table guard через PG `'42P01'`.
- `services/timesheet-export.service.ts`: read-only, через `= ANY($1::uuid[])` / `::int[]`.
- `services/timesheet-transfers.service.ts`: `updateTransfer`, `tryDeleteTransfer` (4-step), `updateExclusionDate`, `deleteExclusion` — все в `withTransaction`. Manual rollback удалён (TX делает то же atomically).
- `services/timesheet-reminder.service.ts`: cron-логика без изменений; `INSERT ... ON CONFLICT DO UPDATE` row-by-row.
- `services/timesheet-weekend-memo.service.ts`: UPDATE+INSERT через `execute`.
- `services/timesheet-approval-attachments.service.ts`: `documents` + `document_links` INSERT в одной `withTransaction`; DELETE тоже атомарно. `r2Service` для blob-хранилища без изменений.
- `services/timesheet-approval-history.service.ts`: INSERT с `$N::jsonb` для events.
- `services/timesheet-approval-correction-validation.service.ts`, `timesheet-approval-weekend-check.service.ts`: pure validations.
- `services/attendance.service.ts`: `upsertAttendanceAdjustment` — `INSERT ... ON CONFLICT (employee_id, work_date, source_type, source_id) DO UPDATE SET ...` с dynamic SET. BATCH_SIZE chunks сохранены.
- `services/schedule.service.ts`: локальный `SCHEDULE_JOIN_SELECT` (`LEFT JOIN work_schedules` + `to_jsonb(ws.*)`). `assignEmployee/ObjectSchedule` разделено на `execute` + `queryOne` JOIN-fetch.

## Ключевые решения
- `count: 'exact'` → window-функция `count(*) OVER ()::int AS total_count` (один round-trip).
- `.upsert(rows, { onConflict })` → row-by-row `INSERT ... ON CONFLICT DO UPDATE` (для маленьких N проще, чем multi-row VALUES).
- `.not('col', 'is', null)` → `col IS NOT NULL`.
- `.or('a.is.null,a.gte.X')` → `(a IS NULL OR a >= $N)` с повторным `$N`.
- Array casts: `::int[]` для employee ids, `::uuid[]` для department/object, `::date[]` для дат, `::text[]` для строк.
- Multi-step операции, требующие атомарности — в `withTransaction` (transfers, exclusion, approval-attachments).

## Verification
- `Grep "await supabase|supabase\\."` в скоупе → 0 совпадений.
- `cd fot-server; npm run build` → exit 0.
- Response shapes и API-контракты не изменены.
