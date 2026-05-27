/**
 * Однократный backfill: переписать существующие day-level корректировки
 * (`attendance_adjustments.source_type='manual'`, status в ('work','manual')) в per-object
 * корректировки (`source_type='manual_object'`) по правилу «объект с наибольшим числом
 * СКУД-событий сотрудника в этот день».
 *
 * Семантика: после внедрения мутекса day-level и per-object на бэке (см. timesheet.controller.ts),
 * старые day-level записи без object_id сваливаются в синтетическую группу «Не определён» в
 * режиме «по объектам». Этот скрипт привязывает их к конкретным объектам.
 *
 * Запуск:
 *   cd fot-server && npx tsx scripts/migrate-day-level-to-object-corrections.ts [--dry-run]
 *
 * --dry-run    Только выборка кандидатов и расчёт целевых объектов; БД не меняется.
 *              Отчёт пишется всегда (см. путь в логах).
 *
 * Идемпотентен: после удачного прогона у мигрированных строк source_type='manual_object',
 * повторный запуск их уже не подберёт.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, withTransaction } from '../src/config/postgres.js';
import { OBJECT_ADJUSTMENT_SOURCE_TYPE } from '../src/services/timesheet-object.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DRY_RUN = process.argv.includes('--dry-run');

interface ICandidateRow {
  id: number;
  employee_id: number;
  work_date: string;
  status: string;
  hours_override: string | number;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

interface IObjectCandidate {
  object_id: string;
  object_name: string;
  event_count: number;
}

interface IReportItem {
  adjustment_id: number;
  employee_id: number;
  work_date: string;
  hours_override: number;
  action: 'migrated' | 'merged_into_existing' | 'skipped_no_skud' | 'error';
  picked_object_id?: string;
  picked_object_name?: string;
  picked_event_count?: number;
  error?: string;
}

const REPORT_PATH = path.resolve(__dirname, `migrate-day-level-to-object-corrections.report.${Date.now()}.json`);

const main = async (): Promise<void> => {
  console.log(`[migrate] dry-run = ${DRY_RUN}`);

  const candidates = await query<ICandidateRow>(
    `SELECT id, employee_id, work_date::text AS work_date, status, hours_override, reason, metadata
       FROM attendance_adjustments
      WHERE source_type = 'manual'
        AND status IN ('work', 'manual')
        AND hours_override IS NOT NULL
        AND hours_override > 0
      ORDER BY work_date DESC, employee_id ASC, id ASC`,
  );

  console.log(`[migrate] кандидатов: ${candidates.length}`);

  const report: IReportItem[] = [];
  let migrated = 0;
  let merged = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of candidates) {
    const adjustmentId = Number(row.id);
    const hoursOverride = Number(row.hours_override);
    const reportBase: IReportItem = {
      adjustment_id: adjustmentId,
      employee_id: row.employee_id,
      work_date: row.work_date,
      hours_override: hoursOverride,
      action: 'skipped_no_skud',
    };

    let picked: IObjectCandidate | null = null;
    try {
      const objectRows = await query<{ object_id: string; object_name: string; event_count: string | number }>(
        `SELECT sap.object_id::text AS object_id,
                so.name AS object_name,
                COUNT(*)::int AS event_count
           FROM skud_events se
           JOIN skud_object_access_points sap
                ON BTRIM(sap.access_point_name) = BTRIM(se.access_point)
           JOIN skud_objects so
                ON so.id = sap.object_id
               AND so.is_active = TRUE
          WHERE se.employee_id = $1
            AND se.event_date = $2::date
            AND se.access_point IS NOT NULL
          GROUP BY sap.object_id, so.name
          ORDER BY event_count DESC, so.name ASC
          LIMIT 1`,
        [row.employee_id, row.work_date],
      );
      if (objectRows.length > 0) {
        picked = {
          object_id: objectRows[0].object_id,
          object_name: objectRows[0].object_name,
          event_count: Number(objectRows[0].event_count),
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[migrate] adjustment_id=${adjustmentId} SKUD lookup error: ${msg}`);
      report.push({ ...reportBase, action: 'error', error: msg });
      errors += 1;
      continue;
    }

    if (!picked) {
      report.push(reportBase);
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      report.push({
        ...reportBase,
        action: 'migrated',
        picked_object_id: picked.object_id,
        picked_object_name: picked.object_name,
        picked_event_count: picked.event_count,
      });
      migrated += 1;
      continue;
    }

    try {
      const result = await withTransaction(async (client) => {
        // Если уже существует manual_object на тот же (emp, date, object_id) — просто удаляем
        // day-level (manual_object авторитетна).
        const existing = await client.query(
          `SELECT id FROM attendance_adjustments
             WHERE employee_id = $1
               AND work_date = $2
               AND source_type = $3
               AND source_id = $4
             LIMIT 1`,
          [row.employee_id, row.work_date, OBJECT_ADJUSTMENT_SOURCE_TYPE, picked!.object_id],
        );
        if (existing.rowCount && existing.rowCount > 0) {
          await client.query(`DELETE FROM attendance_adjustments WHERE id = $1`, [adjustmentId]);
          return 'merged' as const;
        }

        const nextMetadata = {
          ...(row.metadata ?? {}),
          object_id: picked!.object_id,
          object_name: picked!.object_name,
          migrated_from_day_level: true,
          migrated_at: new Date().toISOString(),
        };
        await client.query(
          `UPDATE attendance_adjustments
              SET source_type = $1,
                  source_id   = $2,
                  status      = 'manual',
                  metadata    = $3::jsonb,
                  updated_at  = now()
            WHERE id = $4`,
          [OBJECT_ADJUSTMENT_SOURCE_TYPE, picked!.object_id, JSON.stringify(nextMetadata), adjustmentId],
        );
        return 'migrated' as const;
      });

      report.push({
        ...reportBase,
        action: result === 'merged' ? 'merged_into_existing' : 'migrated',
        picked_object_id: picked.object_id,
        picked_object_name: picked.object_name,
        picked_event_count: picked.event_count,
      });
      if (result === 'merged') merged += 1; else migrated += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[migrate] adjustment_id=${adjustmentId} UPDATE error: ${msg}`);
      report.push({
        ...reportBase,
        action: 'error',
        picked_object_id: picked.object_id,
        picked_object_name: picked.object_name,
        error: msg,
      });
      errors += 1;
    }
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify({
    dry_run: DRY_RUN,
    total: candidates.length,
    migrated,
    merged_into_existing: merged,
    skipped_no_skud: skipped,
    errors,
    items: report,
  }, null, 2));

  console.log(`[migrate] migrated=${migrated} merged=${merged} skipped=${skipped} errors=${errors}`);
  console.log(`[migrate] отчёт: ${REPORT_PATH}`);

  if (DRY_RUN) {
    console.log('[migrate] DRY-RUN: БД не изменялась. Прогон без --dry-run для применения.');
  }

  process.exit(errors > 0 ? 1 : 0);
};

main().catch((err) => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});
