/**
 * Замер: что изменила в табеле смена типа зоны точки доступа (READ-ONLY).
 *
 * Инцидент 12.10.2026: «кпп ASTERUS» переключили с «Внутренней» на «Внешнюю», и проходы через
 * неё стали учитываться за все прошлые месяцы. Скрипт считает табель затронутых сотрудников
 * штатной функцией дважды над одним снимком БД — «как было» (точка внутренняя) и «как сейчас
 * на экране» (внешняя) — и показывает разницу по дням. БД не меняется (см. lib/zone-scenario.ts).
 *
 * Запуск (локально, БД — прод):
 *   cd fot-server && npx tsx scripts/report-access-point-zone-impact.ts \
 *     [--point "кпп ASTERUS"] [--from 2026-05-20] [--to 2026-09-30] \
 *     [--switch-at 2026-10-12T10:56:50Z] [--out ../temp/asterus-impact.xlsx] \
 *     [--save-before ../temp/asterus-before.json] [--skip-versions] [--accept-replica-drift]
 *
 * Проверка против снимка «как было»:
 *   • до выката, новым кодом (на проде ещё нет таблицы истории — она подставляется):
 *       npx tsx scripts/report-access-point-zone-impact.ts --verify ../temp/asterus-before.json --simulate planned
 *   • после выката и восстановления (живая история типа зоны):
 *       npx tsx scripts/report-access-point-zone-impact.ts --verify ../temp/asterus-before.json
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { bootstrapLocalEnv, openScenarioSnapshot, type ISummaryPatch, type ZoneOverride } from './lib/zone-scenario.js';
import { findLostTravelDecisions } from './lib/zone-travel-losses.js';
import {
  writeImpactWorkbook, type IDayRecord, type IDayDiffRow, type IVersionDiffRow, type IReplicaRow,
} from './lib/zone-impact-workbook.js';

const db = bootstrapLocalEnv();

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const POINT = arg('point', 'кпп ASTERUS');
const FROM = arg('from', '2026-05-20');
const TO = arg('to', '2026-09-30');
const SWITCH_AT = arg('switch-at', '2026-10-12T10:56:50Z');
const OUT = path.resolve(arg('out', '../temp/asterus-impact.xlsx'));
const SAVE_BEFORE = arg('save-before', '');
const VERIFY = arg('verify', '');
// С какого рабочего дня точка внешняя в сценарии «как будет после миграции».
const EXTERNAL_FROM = arg('external-from', '2026-10-01');
// --verify до миграции: 'planned' подставляет будущую историю; без флага читается живая таблица.
const SIMULATE = arg('simulate', 'as-is') as ZoneOverride;

const addDays = (date: string, days: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

const monthsBetween = (from: string, to: string): string[] => {
  const months: string[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const stop = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  while (cursor <= stop) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
};

const sameRecord = (a: IDayRecord | undefined, b: IDayRecord | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const hashRecords = (records: Map<string, IDayRecord>): string => {
  const sorted = [...records.entries()].sort(([a], [b]) => a.localeCompare(b));
  return crypto.createHash('md5').update(JSON.stringify(sorted)).digest('hex');
};

async function main(): Promise<void> {
  const { getPool } = await import('../src/config/postgres.js');
  const { fetchTimesheetDataForEmployees } = await import('../src/services/timesheet-export.service.js');
  const { buildObjectAttendanceData } = await import('../src/services/timesheet-object.service.js');
  const { invalidateInternalPointsCache } = await import('../src/services/skud-shared.service.js');
  const { buildTimesheetPayload, computeContentHash } = await import('../src/services/timesheet-version.service.js');
  type IVersionPayload = Awaited<ReturnType<typeof buildTimesheetPayload>>['payload'];

  console.log(`БД: ${db.host.replace(/^([^.]{6})[^.]*/, '$1***')}/${db.database} · точка «${POINT}» · ${FROM}…${TO}`);
  const snapshot = await openScenarioSnapshot(getPool(), POINT, EXTERNAL_FROM);
  const months = monthsBetween(FROM, TO);

  try {
    // ── Кандидаты: проход через точку мог закрыть смену последнего дня периода → +2 суток.
    const candidateRows = await snapshot.raw<{ employee_id: number }>(
      `SELECT DISTINCT employee_id FROM skud_events
        WHERE access_point = $1 AND event_date BETWEEN $2 AND $3 AND employee_id IS NOT NULL`,
      [POINT, FROM, addDays(TO, 2)],
    );
    const candidateIds = candidateRows.map(row => Number(row.employee_id)).sort((a, b) => a - b);
    const candidates = new Set(candidateIds);
    // Ветка — подразделение первого уровня под корнем: отличает свои отделы от подрядчиков.
    const info = new Map((await snapshot.raw<{
      id: number; full_name: string | null; tab_number: string | null; employment_status: string | null;
      department: string | null; branch: string | null;
    }>(
      `WITH RECURSIVE up AS (
         SELECT d.id AS dept_id, d.id AS cur, d.parent_id, d.name, 0 AS lvl FROM org_departments d
          WHERE d.id IN (SELECT org_department_id FROM employees WHERE id = ANY($1::int[]))
         UNION ALL
         SELECT u.dept_id, p.id, p.parent_id, p.name, u.lvl + 1 FROM up u JOIN org_departments p ON p.id = u.parent_id
       ), branch AS (
         SELECT DISTINCT ON (u.dept_id) u.dept_id, u.name
           FROM up u JOIN org_departments parent ON parent.id = u.parent_id AND parent.parent_id IS NULL
          ORDER BY u.dept_id
       )
       SELECT e.id, e.full_name, e.tab_number, e.employment_status, d.name AS department, b.name AS branch
         FROM employees e
         LEFT JOIN org_departments d ON d.id = e.org_department_id
         LEFT JOIN branch b ON b.dept_id = e.org_department_id
        WHERE e.id = ANY($1::int[])`,
      [candidateIds],
    )).map(row => [Number(row.id), row]));
    const inRoster = new Set((await snapshot.raw<{ employee_id: number }>(
      'SELECT DISTINCT employee_id FROM timesheet_approval_employees WHERE employee_id = ANY($1::bigint[])',
      [candidateIds],
    )).map(row => Number(row.employee_id)));
    console.log(`Кандидатов: ${candidateIds.length}, из них в подачах табеля: ${inRoster.size}`);

    // ── Штатный расчёт месяца → итоговые строки дней.
    const collect = async (label: string): Promise<Map<string, IDayRecord>> => {
      const records = new Map<string, IDayRecord>();
      for (const month of months) {
        const data = await fetchTimesheetDataForEmployees(
          month, candidateIds, 'Замер зоны', 'FULL', 'actual', true,
          // snapshot отключает фильтр по статусу занятости: уволенные и архивные тоже считаются.
          { rosterMode: 'snapshot', exec: snapshot.exec },
        );
        if (data.employees.length !== candidateIds.length) {
          throw new Error(`${label} ${month}: расчёт вернул ${data.employees.length} сотрудников из ${candidateIds.length}`);
        }
        const travel = new Map(data.entries.map(entry => [`${entry.employee_id}_${entry.work_date}`, entry.travel_minutes_credited || 0]));
        const objects = new Map<string, string[]>();
        for (const item of data.objectEntries) {
          const key = `${item.employee_id}_${item.work_date}`;
          const list = objects.get(key) ?? [];
          list.push(`${item.object_name}=${item.hours_worked}${item.is_correction ? '*' : ''}`);
          objects.set(key, list);
        }
        for (const [employeeId, days] of data.dataMap) {
          for (const [date, value] of days) {
            if (date < FROM || date > TO) continue;
            const key = `${employeeId}_${date}`;
            records.set(key, {
              status: value.status,
              hours: typeof value.hours === 'number' ? value.hours : 0,
              corrected: Boolean(value.corrected),
              overridden: Boolean(value.hoursOverridden),
              travelMin: travel.get(key) ?? 0,
              objects: (objects.get(key) ?? []).sort().join('; '),
            });
          }
        }
        console.log(`  ${label} ${month}: дней ${records.size}`);
      }
      return records;
    };

    // ── Утверждённые подачи с затронутыми сотрудниками и их последние редакции.
    interface IApprovalRow {
      id: number; department_id: string | null; manager_employee_id: number | null; start_date: string; end_date: string;
      status: string; closed: boolean; department: string | null;
      revision: number; content_hash: string; payload: IVersionPayload; version_created_at: Date;
    }
    const approvals = flag('skip-versions') ? [] : await snapshot.raw<IApprovalRow>(
      `SELECT a.id, a.department_id, a.manager_employee_id, a.start_date::text AS start_date,
              a.end_date::text AS end_date, a.status, (a.unlocked_at IS NULL) AS closed, d.name AS department,
              v.revision, v.content_hash, v.payload, v.created_at AS version_created_at
         FROM timesheet_approvals a
         JOIN LATERAL (SELECT * FROM timesheet_versions tv WHERE tv.approval_id = a.id
                        ORDER BY tv.revision DESC LIMIT 1) v ON true
         LEFT JOIN org_departments d ON d.id = a.department_id
        WHERE a.end_date >= $1 AND a.start_date <= $2 AND a.status = 'approved'
          AND EXISTS (SELECT 1 FROM timesheet_approval_employees ae
                       WHERE ae.approval_id = a.id AND ae.employee_id = ANY($3::bigint[]))
        ORDER BY a.start_date, a.id`,
      [FROM, TO, candidateIds],
    );
    // Часы дня в официальной версии — по затронутым сотрудникам.
    const versionDay = new Map<string, { hours: number; approvalId: number }>();
    for (const approval of approvals) {
      for (const employee of approval.payload.employees) {
        if (!candidates.has(employee.identity.employee_id)) continue;
        for (const [date, day] of Object.entries(employee.days)) {
          versionDay.set(`${employee.identity.employee_id}_${date}`, { hours: day.hours, approvalId: Number(approval.id) });
        }
      }
    }

    // ── Сверка с официальными версиями (тот же сборщик, что у материализации).
    const versionDiffs = async (label: string): Promise<IVersionDiffRow[]> => {
      const rows: IVersionDiffRow[] = [];
      let same = 0;
      for (const approval of approvals) {
        const base = {
          approvalId: Number(approval.id), department: approval.department ?? 'личная подача',
          period: `${approval.start_date}…${approval.end_date}`, closed: approval.closed,
          versionCreatedAt: approval.version_created_at.toISOString(),
        };
        let payload: IVersionPayload;
        try {
          payload = (await buildTimesheetPayload(snapshot.exec, {
            id: Number(approval.id), department_id: approval.department_id,
            manager_employee_id: approval.manager_employee_id == null ? null : Number(approval.manager_employee_id),
            start_date: approval.start_date, end_date: approval.end_date, status: approval.status,
          })).payload;
        } catch (error) {
          rows.push({ ...base, employeeId: 0, fullName: '', date: '', stored: '', calculated: `ошибка сборки: ${(error as Error).message}`, candidate: false, category: 'ошибка' });
          continue;
        }
        if (computeContentHash(payload) === approval.content_hash) { same += 1; continue; }
        const stored = new Map(approval.payload.employees.map(e => [e.identity.employee_id, e]));
        const built = new Map(payload.employees.map(e => [e.identity.employee_id, e]));
        // jsonb не хранит порядок ключей, а в старых редакциях нет hours_overridden — сравниваем по полям.
        type Day = { status: string; hours: number; corrected?: boolean; hours_overridden?: boolean } | undefined;
        const show = (day: Day): string => (day
          ? `${day.status} ${day.hours}${day.corrected ? ' корр.' : ''}${day.hours_overridden ? ' явные часы' : ''}`
          : '—');
        let dayDiffs = 0;
        for (const employeeId of new Set([...stored.keys(), ...built.keys()])) {
          const a: Record<string, Day> = stored.get(employeeId)?.days ?? {};
          const b: Record<string, Day> = built.get(employeeId)?.days ?? {};
          for (const date of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (show(a[date]) === show(b[date])) continue;
            dayDiffs += 1;
            rows.push({
              ...base, employeeId, date,
              fullName: stored.get(employeeId)?.identity.full_name ?? built.get(employeeId)?.identity.full_name ?? '',
              stored: show(a[date]), calculated: show(b[date]),
              candidate: candidates.has(employeeId),
              category: '',
            });
          }
        }
        if (dayDiffs === 0) {
          rows.push({ ...base, employeeId: 0, fullName: '', date: '', stored: '', calculated: 'отличия вне дней (должность, ФИО, признак активности)', candidate: false, category: 'вне дней' });
        }
      }
      // Категория: поздняя корректировка, не связано с точкой, либо требует разбора.
      const pairs = rows.filter(row => row.date);
      const late = new Set<string>();
      if (pairs.length > 0) {
        const adjustments = await snapshot.raw<{ employee_id: number; work_date: string; changed_at: Date }>(
          `SELECT employee_id, work_date::text AS work_date, GREATEST(created_at, updated_at) AS changed_at
             FROM attendance_adjustments
            WHERE employee_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3`,
          [[...new Set(pairs.map(row => row.employeeId))], FROM, TO],
        );
        const lastChange = new Map<string, number>();
        for (const item of adjustments) {
          const key = `${Number(item.employee_id)}_${item.work_date}`;
          lastChange.set(key, Math.max(lastChange.get(key) ?? 0, item.changed_at.getTime()));
        }
        for (const row of pairs) {
          const key = `${row.employeeId}_${row.date}`;
          if ((lastChange.get(key) ?? 0) > new Date(row.versionCreatedAt).getTime()) late.add(`${row.approvalId}_${key}`);
        }
      }
      for (const row of pairs) {
        row.category = late.has(`${row.approvalId}_${row.employeeId}_${row.date}`)
          ? 'поздняя корректировка'
          : (row.candidate ? 'требует разбора' : 'не связано с точкой');
      }
      console.log(`  ${label}: подач ${approvals.length}, совпали по хешу ${same}, строк отличий ${rows.length}`);
      return rows;
    };

    // ── Режим проверки: расчёт против снимка «как было» (до выката — с подставленной историей).
    if (VERIFY) {
      const saved = JSON.parse(fs.readFileSync(path.resolve(VERIFY), 'utf8')) as {
        hash: string; days: Record<string, IDayRecord>; versionDiffKeys: string[];
        travelRestore: Array<{ employeeId: number; date: string }>;
      };
      snapshot.setScenario({ zone: SIMULATE, summaryPatch: null });
      invalidateInternalPointsCache();
      const live = await collect(SIMULATE === 'as-is' ? 'живой расчёт' : `расчёт «${SIMULATE}»`);
      if (SIMULATE !== 'as-is' && snapshot.hits().internalPoints === 0) {
        throw new Error('Подмена истории типа зоны не сработала — изменился запрос в skud-shared.service.ts');
      }
      // Дни с одобрением «Дороги», стёртым в инцидент: совпадут со снимком только после
      // восстановления (reconcile-access-point-zone.ts --restore-travel).
      const awaitingTravel = new Set(saved.travelRestore.map(item => `${item.employeeId}_${item.date}`));
      const diffKeys = [...new Set([...Object.keys(saved.days), ...live.keys()])]
        .filter(key => !sameRecord(saved.days[key], live.get(key)));
      const travelOnly = diffKeys.filter(key => awaitingTravel.has(key));
      const unexplained = diffKeys.filter(key => !awaitingTravel.has(key));
      const liveVersionKeys = (await versionDiffs('сверка с версиями'))
        .filter(row => row.candidate).map(row => `${row.approvalId}_${row.employeeId}_${row.date}`);
      const newVersionKeys = liveVersionKeys.filter(key => !saved.versionDiffKeys.includes(key));
      console.log(`Хеш итогов: ${hashRecords(live)} (снимок «как было»: ${saved.hash})`);
      console.log(`Дней в снимке: ${Object.keys(saved.days).length}; совпало: ${Object.keys(saved.days).length - diffKeys.length}`);
      console.log(`Отличий от «как было»: ${unexplained.length}; ждут восстановления «Дороги»: ${travelOnly.length} из ${awaitingTravel.size}`);
      console.log(`Новых расхождений с версиями (сверх известных до фикса): ${newVersionKeys.length}`);
      for (const key of unexplained.slice(0, 30)) {
        console.log(`  ${key}: было ${JSON.stringify(saved.days[key] ?? null)} → сейчас ${JSON.stringify(live.get(key) ?? null)}`);
      }
      process.exitCode = unexplained.length === 0 ? 0 : 2;
      return;
    }

    // ── Строки сводки, пересчитанные после переключения: «как было» из них уже не взять.
    const summaryRows = await snapshot.raw<{
      employee_id: number; date: string; first_entry: string | null; last_exit: string | null;
      total_minutes: number | null; break_minutes: number | null; touched: boolean; changed_at: Date;
    }>(
      `SELECT employee_id, date::text AS date, first_entry::text AS first_entry, last_exit::text AS last_exit,
              total_minutes, break_minutes,
              (GREATEST(created_at, updated_at) >= $4::timestamptz) AS touched,
              GREATEST(created_at, updated_at) AS changed_at
         FROM skud_daily_summary
        WHERE employee_id = ANY($1::int[]) AND date BETWEEN $2 AND $3`,
      [candidateIds, FROM, TO, SWITCH_AT],
    );

    // ── TS-калька SQL-пересчёта сводки при «точка внутренняя» — за весь период, по месяцам.
    snapshot.setScenario({ zone: 'internal', summaryPatch: null });
    invalidateInternalPointsCache();
    const replica = new Map<string, ISummaryPatch>();
    for (const month of months) {
      const start = `${month}-01` < FROM ? FROM : `${month}-01`;
      const monthEnd = addDays(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10), -1);
      const built = await buildObjectAttendanceData({
        employeeIds: candidateIds, startDate: start, endDate: monthEnd < TO ? monthEnd : TO,
        adjustments: [], includeObjectDetails: false, exec: snapshot.exec,
      });
      for (const [employeeId, days] of built.rawFallbackSummaries) {
        for (const [date, value] of days) {
          replica.set(`${employeeId}_${date}`, {
            first_entry: value.first_entry, last_exit: value.last_exit,
            total_minutes: value.total_minutes ?? null, break_minutes: value.break_minutes ?? null,
          });
        }
      }
    }
    if (snapshot.hits().internalPoints === 0) throw new Error('Подмена истории типа зоны не сработала — изменился запрос в skud-shared.service.ts');

    // Сверка кальки с нетронутыми строками: расхождение по часам/входу значит, что калька не
    // воспроизводит прод-расчёт и подставлять её в тронутые строки нельзя (fail-closed).
    const time = (value: string | null): string => (value ? value.slice(0, 8) : '');
    const replicaRows: IReplicaRow[] = [];
    const summaryPatch = new Map<string, ISummaryPatch | null>();
    let untouched = 0;
    for (const row of summaryRows) {
      const key = `${Number(row.employee_id)}_${row.date}`;
      const calc = replica.get(key) ?? null;
      const calcMinutes = calc && (calc.total_minutes ?? 0) > 0 ? calc.total_minutes ?? 0 : 0;
      const storedMinutes = row.total_minutes ?? 0;
      const fields: string[] = [];
      if (time(row.first_entry) !== time(calc?.first_entry ?? null)) fields.push('первый вход');
      if (storedMinutes !== calcMinutes) fields.push('минуты');
      if ((storedMinutes > 0 ? row.break_minutes ?? 0 : 0) !== (calcMinutes > 0 ? calc?.break_minutes ?? 0 : 0)) fields.push('перерыв');
      if (row.touched) {
        summaryPatch.set(key, calc);
      } else {
        untouched += 1;
      }
      if (fields.length > 0 || row.touched) {
        const person = info.get(Number(row.employee_id));
        replicaRows.push({
          employeeId: Number(row.employee_id), fullName: person?.full_name ?? '', department: person?.department ?? '',
          date: row.date, touched: row.touched, changedAt: row.changed_at.toISOString(), fields: fields.join(', '),
          stored: `${time(row.first_entry) || '—'} · ${storedMinutes} мин`, calculated: `${time(calc?.first_entry ?? null) || '—'} · ${calcMinutes} мин`,
        });
      }
    }
    const drift = replicaRows.filter(row => !row.touched && row.fields).length;
    // Кальке верим там, где ею подменяем: расхождения на нетронутых строках ТЕХ ЖЕ месяцев.
    const touchedMonths = new Set([...summaryPatch.keys()].map(key => key.split('_')[1].slice(0, 7)));
    const driftInTouchedMonths = replicaRows.filter(row => !row.touched && row.fields && touchedMonths.has(row.date.slice(0, 7))).length;
    const substituted = replicaRows.filter(row => row.touched && row.fields).length;
    console.log(`Сводка: строк ${summaryRows.length}, тронуто после переключения ${summaryPatch.size} (из них калька отличается у ${substituted}), ` +
      `нетронутых ${untouched}, расхождений кальки ${drift} (в месяцах тронутых строк — ${driftInTouchedMonths})`);

    // ── Сценарии.
    snapshot.setScenario({ zone: 'internal', summaryPatch });
    invalidateInternalPointsCache();
    const before = await collect('как было');
    const hitsBefore = snapshot.hits();
    if (hitsBefore.internalPoints === 0) throw new Error('«как было»: подмена истории типа зоны не сработала');
    if (summaryPatch.size > 0 && hitsBefore.summaryRows === 0) throw new Error('«как было»: подмена строк сводки не сработала — изменился запрос loadDailySummaries');
    const versionRows = await versionDiffs('сверка «как было» с версиями');

    // ── «Дорога»: решения, стёртые пересборкой после переключения (сценарий всё ещё «внутренняя»).
    const losses = await findLostTravelDecisions({
      snapshot, employeeIds: candidateIds, months, from: FROM, to: TO, versionDay,
      beforeHours: key => before.get(key)?.hours ?? 0,
    });
    // Подтверждённое версией одобрение — часть «как было»: сегмент засчитывался по факту.
    const restoredDays = new Set<string>();
    for (const loss of losses.filter(item => item.verdict === 'одобрение потеряно')) {
      const key = `${loss.employeeId}_${loss.date}`;
      const record = before.get(key);
      if (!record) continue;
      record.travelMin += loss.delayMinutes;
      if (!restoredDays.has(key) && loss.versionHours != null) record.hours = loss.versionHours;
      restoredDays.add(key);
    }
    const verdicts = new Map<string, number>();
    for (const loss of losses) verdicts.set(loss.verdict, (verdicts.get(loss.verdict) ?? 0) + 1);
    console.log(`  «Дорога», сегменты «как было» без записи в хранилище: ${[...verdicts].map(([name, count]) => `${name} — ${count}`).join('; ') || 'нет'}`);

    snapshot.setScenario({ zone: 'external', summaryPatch: null });
    invalidateInternalPointsCache();
    const now = await collect('как сейчас');

    // ── Разница по дням + контекст (корректировки, подачи).
    const adjustments = await snapshot.raw<{ employee_id: number; work_date: string; kinds: string }>(
      `SELECT employee_id, work_date::text AS work_date, string_agg(DISTINCT source_type, ', ') AS kinds
         FROM attendance_adjustments
        WHERE employee_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3
        GROUP BY 1, 2`,
      [candidateIds, FROM, TO],
    );
    const adjustmentKinds = new Map(adjustments.map(row => [`${Number(row.employee_id)}_${row.work_date}`, row.kinds]));
    const submissions = await snapshot.raw<{ employee_id: number; start_date: string; end_date: string; status: string; closed: boolean }>(
      `SELECT ae.employee_id, a.start_date::text AS start_date, a.end_date::text AS end_date, a.status,
              (a.unlocked_at IS NULL) AS closed
         FROM timesheet_approval_employees ae JOIN timesheet_approvals a ON a.id = ae.approval_id
        WHERE ae.employee_id = ANY($1::bigint[]) AND a.end_date >= $2 AND a.start_date <= $3`,
      [candidateIds, FROM, TO],
    );
    const submissionOf = (employeeId: number, date: string): string => {
      const hit = submissions.filter(s => Number(s.employee_id) === employeeId && s.start_date <= date && s.end_date >= date);
      if (hit.length === 0) return 'нет подачи';
      return hit.map(s => (s.status === 'approved' ? (s.closed ? 'утверждён, закрыт' : 'утверждён, открыт') : s.status)).join(' / ');
    };

    const dayRows: IDayDiffRow[] = [];
    for (const key of new Set([...before.keys(), ...now.keys()])) {
      const a = before.get(key);
      const b = now.get(key);
      if (sameRecord(a, b)) continue;
      const [id, date] = key.split('_');
      const employeeId = Number(id);
      const person = info.get(employeeId);
      dayRows.push({
        branch: person?.branch ?? '—', department: person?.department ?? '— без отдела —', fullName: person?.full_name ?? '', tabNumber: person?.tab_number ?? '',
        employeeId, employmentStatus: person?.employment_status ?? '', inRoster: inRoster.has(employeeId), date,
        before: a ?? null, now: b ?? null,
        adjustment: adjustmentKinds.get(key) ?? '', submission: submissionOf(employeeId, date),
      });
    }
    dayRows.sort((x, y) => x.branch.localeCompare(y.branch) || x.department.localeCompare(y.department) || x.fullName.localeCompare(y.fullName) || x.date.localeCompare(y.date));

    // ── Следы в хранимых данных.
    const traces = {
      corrections: await snapshot.raw<Record<string, unknown>>(
        `SELECT a.id, a.employee_id, e.full_name, d.name AS department, a.work_date::text AS work_date, a.source_type,
                a.status, a.hours_override, a.reason, a.created_at
           FROM attendance_adjustments a JOIN employees e ON e.id = a.employee_id
           LEFT JOIN org_departments d ON d.id = e.org_department_id
          WHERE a.work_date <= $1 AND a.created_at >= $2::timestamptz ORDER BY a.created_at`,
        [TO, SWITCH_AT],
      ),
      travel: await snapshot.raw<Record<string, unknown>>(
        `SELECT t.employee_id, e.full_name, t.work_date::text AS work_date, t.from_access_point_name,
                t.to_access_point_name, t.status, t.credited_minutes, t.created_at
           FROM skud_travel_segments t JOIN employees e ON e.id = t.employee_id
          WHERE t.work_date <= $1 AND ($2 IN (t.from_access_point_name, t.to_access_point_name)) ORDER BY t.work_date`,
        [TO, POINT],
      ),
    };

    const meta = {
      point: POINT, from: FROM, to: TO, switchAt: SWITCH_AT, generatedAt: new Date().toISOString(),
      candidates: candidateIds.length, inRoster: inRoster.size,
      summaryRows: summaryRows.length, summaryTouched: summaryPatch.size, summarySubstituted: substituted,
      replicaChecked: untouched, replicaDrift: drift, replicaDriftInTouchedMonths: driftInTouchedMonths,
      hashBefore: hashRecords(before), hashNow: hashRecords(now),
    };
    const travelRows = losses.map(loss => {
      const person = info.get(loss.employeeId);
      return { ...loss, branch: person?.branch ?? '—', department: person?.department ?? '', fullName: person?.full_name ?? '' };
    });
    await writeImpactWorkbook(OUT, { meta, dayRows, versionRows, replicaRows, travelRows, traces });
    const round = (value: number): number => Math.round(value * 100) / 100;
    for (const branch of [...new Set(dayRows.map(row => row.branch))].sort()) {
      const rows = dayRows.filter(row => row.branch === branch);
      console.log(`Отличия «было → сейчас», ${branch}: сотрудников ${new Set(rows.map(row => row.employeeId)).size}, дней ${rows.length}, ` +
        `часов ${round(rows.reduce((total, row) => total + (row.before?.hours ?? 0), 0))} → ${round(rows.reduce((total, row) => total + (row.now?.hours ?? 0), 0))}`);
    }
    console.log(`Отчёт: ${OUT}`);

    if (SAVE_BEFORE) {
      // Тронутые строки подставлены калькой: если она расходится с прод-расчётом, снимку верить нельзя.
      if (driftInTouchedMonths > 0 && !flag('accept-replica-drift')) {
        console.error(`Снимок НЕ записан: калька сводки расходится с прод-расчётом в ${driftInTouchedMonths} строках тех же месяцев (лист «Калька сводки»).`);
        process.exitCode = 3;
        return;
      }
      const versionDiffKeys = versionRows.filter(row => row.candidate).map(row => `${row.approvalId}_${row.employeeId}_${row.date}`);
      // travelRestore — одобрения «Дороги», которые восстановит reconcile-access-point-zone.ts.
      const travelRestore = losses.filter(item => item.verdict === 'одобрение потеряно');
      fs.writeFileSync(path.resolve(SAVE_BEFORE), JSON.stringify({ meta, hash: meta.hashBefore, days: Object.fromEntries(before), versionDiffKeys, travelRestore }));
      console.log(`Снимок «как было»: ${path.resolve(SAVE_BEFORE)} (хеш ${meta.hashBefore})`);
    }
  } finally {
    await snapshot.close();
    await getPool().end();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
