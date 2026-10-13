/**
 * Восстановление после инцидента 12.10.2026: «кпп ASTERUS» переключили с «Внутренней» на
 * «Внешнюю» без даты, и проходы через неё стали учитываться за все прошлые месяцы.
 *
 * Миграция 305 возвращает расчёту правило «точка внутренняя по 30.09.2026, внешняя с 01.10.2026».
 * Этот скрипт пересобирает то, что за время инцидента успело материализоваться с неверным типом,
 * и возвращает стёртые одобрения «Дороги». Часы и корректировки руками не правятся.
 *
 * План собирается в момент запуска:
 *   • сводка, рабочие дни до --external-from: строки затронутых сотрудников, созданные или
 *     пересчитанные после переключения (--switch-at), — ровно за свой день. Остальные строки
 *     закрытых месяцев — те же данные, по которым табель считался до инцидента, их не трогаем;
 *   • сводка с --external-from по сегодня: все дни с проходами через точку;
 *   • «Дорога»: все затронутые сотрудники, с --history-from по сегодня;
 *   • версии для 1С: закрытые утверждённые подачи с --external-from помечаются на пересборку
 *     (новая редакция появится только при изменившихся часах); подачи до этой даты не помечаются;
 *   • --restore-travel: одобрения «Дороги», подтверждённые официальными версиями
 *     (список travelRestore из снимка report-access-point-zone-impact.ts).
 *
 * Повторный запуск ничего не меняет: пересчёт даёт те же значения, восстановленные одобрения
 * уже стоят.
 *
 * Запуск на сервере ПОСЛЕ миграции 305 и деплоя бэкенда — рабочий каталог папка сайта:
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/reconcile-access-point-zone.ts \
 *     --restore-travel /opt/fot-build/temp/asterus-before.json            # только план
 *   … тот же вызов с --apply                                              # выполнить
 *
 * Флаги:
 *   --point NAME          точка доступа (по умолчанию «кпп ASTERUS»);
 *   --history-from DATE   первый день с проходами через точку (2026-05-20);
 *   --external-from DATE  с какого рабочего дня точка внешняя (2026-10-01);
 *   --switch-at ISO       момент переключения (2026-10-12T10:56:50Z);
 *   --restore-travel FILE снимок «как было» со списком одобрений «Дороги»;
 *   --apply               выполнить; без флага — только план, в БД ничего не пишется.
 */
import fs from 'fs';
import path from 'path';
import { closeDb, execute, query } from '../src/config/postgres.js';
import { moscowTodayIso } from '../src/utils/date.utils.js';
import { reconcileAccessPointZone, type IZoneReconcilePlan } from '../src/services/access-point-zone-reconcile.service.js';
import { invalidateTravelSegmentsCache } from '../src/services/skud-travel.service.js';

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const POINT = arg('point', 'кпп ASTERUS');
const HISTORY_FROM = arg('history-from', '2026-05-20');
const EXTERNAL_FROM = arg('external-from', '2026-10-01');
const SWITCH_AT = arg('switch-at', '2026-10-12T10:56:50Z');
const RESTORE_TRAVEL = arg('restore-travel', '');
const APPLY = process.argv.includes('--apply');

interface ITravelRestore {
  employeeId: number;
  date: string;
  from: string;
  to: string;
  exitTime: string;
  entryTime: string;
  actualMinutes: number;
  approvalId: number | null;
}

const shiftDay = (date: string, days: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

const main = async (): Promise<void> => {
  const today = moscowTodayIso();
  const prefix = APPLY ? '' : '[план] ';

  const history = await query<{ is_internal: boolean; effective_from: string }>(
    `SELECT is_internal, effective_from::text AS effective_from
       FROM skud_access_point_zone_periods WHERE access_point_name = $1 ORDER BY effective_from`,
    [POINT],
  );
  if (history.length === 0) throw new Error(`У точки «${POINT}» нет истории типа зоны — миграция 305 не применена?`);
  console.log(`Точка «${POINT}»: ${history.map(row => `${row.is_internal ? 'внутренняя' : 'внешняя'} с ${row.effective_from}`).join(', ')}`);

  // Проход 01–02 числа мог закрыть смену последнего дня до смены типа — они тоже затронуты.
  const candidates = (await query<{ employee_id: number }>(
    `SELECT DISTINCT employee_id FROM skud_events
      WHERE event_date BETWEEN $2 AND $3 AND employee_id IS NOT NULL AND btrim(access_point) = $1`,
    [POINT, HISTORY_FROM, today],
  )).map(row => Number(row.employee_id));

  const touched = await query<{ employee_id: number; date: string }>(
    `SELECT employee_id, date::text AS date FROM skud_daily_summary
      WHERE employee_id = ANY($1::bigint[]) AND date >= $2 AND date < $3
        AND GREATEST(created_at, updated_at) >= $4::timestamptz`,
    [candidates, HISTORY_FROM, EXTERNAL_FROM, SWITCH_AT],
  );
  const recent = await query<{ employee_id: number; event_date: string }>(
    `SELECT DISTINCT employee_id, event_date::text AS event_date FROM skud_events
      WHERE event_date BETWEEN $2 AND $3 AND employee_id IS NOT NULL AND btrim(access_point) = $1`,
    [POINT, EXTERNAL_FROM, today],
  );

  const plan: IZoneReconcilePlan = {
    accessPointName: POINT,
    summaryPairs: recent.map(row => ({ emp_id: Number(row.employee_id), date: row.event_date })),
    summaryExactPairs: touched.map(row => ({ emp_id: Number(row.employee_id), date: row.date })),
    travelEmployeeIds: candidates,
    travelFrom: HISTORY_FROM,
    travelTo: today,
    versionsFrom: EXTERNAL_FROM,
    versionsTo: today,
  };

  const toMark = await query<{ id: number }>(
    `SELECT DISTINCT a.id FROM timesheet_approvals a
       JOIN timesheet_approval_employees ae ON ae.approval_id = a.id
      WHERE a.status = 'approved' AND a.unlocked_at IS NULL
        AND a.end_date >= $1 AND a.start_date <= $2 AND ae.employee_id = ANY($3::bigint[])`,
    [EXTERNAL_FROM, today, candidates],
  );
  const staleTravel = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM skud_travel_segments
      WHERE work_date >= $2 AND work_date < $3 AND $1 IN (from_access_point_name, to_access_point_name)`,
    [POINT, HISTORY_FROM, EXTERNAL_FROM],
  );
  const restore: ITravelRestore[] = RESTORE_TRAVEL
    ? ((JSON.parse(fs.readFileSync(path.resolve(RESTORE_TRAVEL), 'utf8')) as { travelRestore?: ITravelRestore[] }).travelRestore ?? [])
    : [];

  console.log(`${prefix}затронутых сотрудников: ${candidates.length}`);
  console.log(`${prefix}сводка до ${EXTERNAL_FROM}: строк, пересчитанных после переключения, — ${plan.summaryExactPairs?.length ?? 0} (пересчёт ровно за свой день)`);
  console.log(`${prefix}сводка с ${EXTERNAL_FROM} по ${today}: пар сотрудник-день — ${plan.summaryPairs.length}`);
  console.log(`${prefix}«Дорога»: пересборка ${HISTORY_FROM}…${today}; сегментов с точкой до ${EXTERNAL_FROM} сейчас — ${Number(staleTravel[0]?.n ?? 0)}`);
  console.log(`${prefix}закрытых подач с ${EXTERNAL_FROM} к пометке для 1С: ${toMark.length}${toMark.length ? ` (№ ${toMark.map(row => row.id).join(', ')})` : ''}`);
  console.log(`${prefix}одобрений «Дороги» к восстановлению: ${restore.length}`);
  for (const item of restore) {
    console.log(`${prefix}  сотрудник ${item.employeeId}, ${item.date}, ${item.from} ${item.exitTime} → ${item.to} ${item.entryTime}, ${item.actualMinutes} мин (подача № ${item.approvalId ?? '—'})`);
  }

  if (!APPLY) {
    console.log('Ничего не записано. Для выполнения добавьте --apply.');
    return;
  }

  const result = await reconcileAccessPointZone(plan);
  console.log(`Сводка: изменилось строк ${result.summaryChanged} из ${result.summaryPairs} пересчитанных`);
  console.log(`«Дорога»: изменилось сегментов ${result.travelChanged}; решений, оставшихся без сегмента, — ${result.lostTravelDecisions.length}`);
  for (const lost of result.lostTravelDecisions) {
    console.log(`  ${lost.status}: сотрудник ${lost.employee_id}, ${lost.work_date}, ${lost.from_access_point_name} → ${lost.to_access_point_name} (сохранено в аудит)`);
  }
  console.log(`Подач помечено для 1С: ${result.markedApprovalIds.length}`);

  // Одобрение восстанавливается только у сегмента, который снова ждёт решения, — повторный
  // запуск и уже принятое позже решение не перезаписываются.
  let restored = 0;
  for (const item of restore) {
    restored += await execute(
      `UPDATE skud_travel_segments
          SET status = 'approved', credited_minutes = actual_minutes, approved_at = now(), updated_at = now(),
              approval_comment = $7
        WHERE employee_id = $1 AND work_date = $2::date AND exit_time = $3::time AND entry_time = $4::time
          AND from_access_point_name = $5 AND to_access_point_name = $6 AND status = 'pending'`,
      [
        item.employeeId, item.date, item.exitTime, item.entryTime, item.from, item.to,
        `Восстановлено после сбоя 12.10.2026 (смена типа зоны «${POINT}»): одобрение подтверждено официальной версией табеля${item.approvalId ? `, подача № ${item.approvalId}` : ''}`,
      ],
    );
  }
  if (restore.length > 0) {
    invalidateTravelSegmentsCache();
    console.log(`Одобрений «Дороги» восстановлено: ${restored} из ${restore.length}${restored < restore.length ? ' (остальные уже стоят либо сегмент решён иначе)' : ''}`);
  }

  const left = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM skud_travel_segments
      WHERE work_date >= $2 AND work_date < $3 AND $1 IN (from_access_point_name, to_access_point_name)`,
    [POINT, HISTORY_FROM, EXTERNAL_FROM],
  );
  console.log(`Сегментов «Дороги» с точкой до ${shiftDay(EXTERNAL_FROM, -1)} включительно осталось: ${Number(left[0]?.n ?? 0)}`);
};

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
