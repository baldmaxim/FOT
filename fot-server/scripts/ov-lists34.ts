/**
 * Одноразово: по Лист2 из C:\tmp\ov-new.xls (1С) собрать Лист3 (данные ФОТ в виде
 * единого файла 1С: Отдел + Адрес объекта, при СКУД — несколько строк) и Лист4
 * (расхождения). Итог: C:\tmp\ov-new.xlsx + копия в ../../temp/.
 *
 * Отдел на период резолвится ЛОКАЛЬНО и детерминированно (последнее назначение,
 * действующее в периоде). Прод-сервис resolveDepartmentIdsForEmployeesInPeriod при
 * нескольких назначениях внутри периода выбирает произвольное — для отчёта это давало
 * бригаду, действовавшую 1–2 дня, вместо основного отдела.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const XLS = 'C:\\tmp\\ov-new.xls';
const OUT_TEMP = path.join(REPO, 'temp', 'ov-new.xlsx');
const OUT_TMP = 'C:\\tmp\\ov-new.xlsx';
const MONTH = '2026-08';
const START_DATE = '2026-08-01';
const END_DATE = '2026-08-31';

const parseEnvLastWins = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const envFile = parseEnvLastWins(fs.readFileSync(path.join(REPO, 'fot-server', '.env'), 'utf8'));
const rawUrl = envFile.DATABASE_URL;
if (!rawUrl) {
  console.error('DATABASE_URL не найден');
  process.exit(1);
}
try {
  const u = new URL(rawUrl);
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
  process.env.DATABASE_URL = u.toString();
} catch {
  process.env.DATABASE_URL = rawUrl;
}
process.env.DATABASE_SSL = 'true';
process.env.DATABASE_SSL_CA_PATH = path.join(REPO, '.migration', 'yandex-ca.pem');
process.env.NODE_ENV = 'test';

interface IRawSheet {
  name: string;
  rows: string[][];
}

interface IEmpRow {
  id: number;
  full_name: string | null;
  tab_number: string | null;
  employment_status: string | null;
  is_archived: boolean;
  dept_now: string | null;
}

const normalizeName = (value: unknown): string =>
  String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');

/** Сравнение значений: дополнительно кавычки и тире к единому виду. */
const normalizeValue = (value: unknown): string =>
  normalizeName(value)
    .replace(/[«»„“”"']/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, '-');

const normalizeTab = (value: unknown): string =>
  String(value ?? '')
    .replace(/\D/g, '')
    .replace(/^0+/, '') || '';

const readXls = (): IRawSheet[] => {
  const jsonPath = path.join(REPO, 'temp', 'ov-new-sheets.json');
  const py = `
import xlrd, json
b = xlrd.open_workbook(r"${XLS.replace(/\\/g, '\\\\')}")
out = []
for s in b.sheets():
    rows = []
    for r in range(s.nrows):
        rows.append([str(s.cell_value(r, c)).strip() for c in range(s.ncols)])
    out.append({"name": s.name, "rows": rows})
with open(r"${jsonPath.replace(/\\/g, '\\\\')}", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
`;
  const res = spawnSync('python', ['-c', py], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(res.stderr);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as IRawSheet[];
};

/** Заголовок Лист2: имена колонок 1–10 в строке 2, 11–15 — в строке 1. */
const buildHeader = (rows: string[][]): string[] => {
  const top = rows[0] ?? [];
  const main = rows[1] ?? [];
  const width = Math.max(top.length, main.length);
  return Array.from({ length: width }, (_, i) => (main[i] || top[i] || '').trim());
};

const STATUS_NOT_IN_FOT = 'нет в ФОТ';
const STATUS_NOT_IN_ROSTER = 'не в ростере периода';
const STATUS_NO_ACTIVITY = 'нет активности за период';

interface ISheet3Row {
  source: string[];
  deptFot: string;
  addressFot: string;
  status: string;
  deptNow: string;
  deptsInPeriod: string;
}

const main = async (): Promise<void> => {
  const [{ query, getPool }, exportSvc, unifiedSvc, assignedCtl] = await Promise.all([
    import('../src/config/postgres.js'),
    import('../src/services/timesheet-export.service.js'),
    import('../src/services/timesheet-1c-unified.service.js'),
    import('../src/controllers/timesheet-assigned-export.controller.js'),
  ]);

  const sheets = readXls();
  const sheet2 = sheets.find(s => s.name === 'Лист2');
  if (!sheet2) throw new Error('Лист2 не найден в ' + XLS);

  const header = buildHeader(sheet2.rows);
  const dataRows = sheet2.rows.slice(3).filter(r => (r[0] || '').trim() || (r[1] || '').trim());
  console.log(`Лист2: ${dataRows.length} сотрудников, колонок ${header.length}`);

  // Выборка БЕЗ фильтра «работает сейчас»: уволенный в сентябре законно есть в табеле августа.
  const employees = await query<IEmpRow>(`
    SELECT e.id, e.full_name, e.tab_number, e.employment_status, e.is_archived,
           d.name AS dept_now
      FROM employees e
      LEFT JOIN org_departments d ON d.id = e.org_department_id
  `);

  const byTab = new Map<string, IEmpRow[]>();
  const byName = new Map<string, IEmpRow[]>();
  for (const e of employees) {
    const tab = normalizeTab(e.tab_number);
    if (tab) byTab.set(tab, [...(byTab.get(tab) ?? []), e]);
    const key = normalizeName(e.full_name);
    if (key) byName.set(key, [...(byName.get(key) ?? []), e]);
  }

  const preferActive = (list: IEmpRow[]): IEmpRow => {
    const active = list.filter(e => !e.is_archived && (e.employment_status ?? 'active') === 'active');
    if (active.length > 0) return active[0];
    const alive = list.filter(e => !e.is_archived);
    return alive[0] ?? list[0];
  };

  let ambiguous = 0;
  // ФИО — единственный надёжный ключ: нумерация табельных в 1С и ФОТ разная, и совпадение
  // номера ничего не значит (1С 004034 = Рахматуллаев, ФОТ 04034 = Саидов). Табельный
  // используем только как тай-брейк среди однофамильцев.
  const pick = (name: string, tab: string, dept1c: string): IEmpRow | null => {
    const hit = byName.get(normalizeName(name)) ?? [];
    if (hit.length === 0) return null;
    if (hit.length === 1) return hit[0];
    ambiguous += 1;
    const byTabHit = hit.filter(e => normalizeTab(e.tab_number) === normalizeTab(tab) && normalizeTab(tab));
    if (byTabHit.length === 1) return byTabHit[0];
    const byDept = hit.filter(e => normalizeValue(e.dept_now) === normalizeValue(dept1c));
    if (byDept.length === 1) return byDept[0];
    return preferActive(hit);
  };

  const matchByRow = new Map<number, IEmpRow>();
  for (const [idx, row] of dataRows.entries()) {
    const emp = pick(row[0] ?? '', row[1] ?? '', row[2] ?? '');
    if (emp) matchByRow.set(idx, emp);
  }
  const empIds = [...new Set([...matchByRow.values()].map(e => e.id))];
  console.log(`сопоставлено ${matchByRow.size}, уникальных id ${empIds.length}, не найдено ${dataRows.length - matchByRow.size}, неоднозначных ${ambiguous}`);

  // ── Отдел на период: детерминированно, последнее назначение внутри периода ──
  // Состав ростера — те же фильтры, что в resolveDepartmentIdsForEmployeesInPeriod.
  const rosterRows = await query<{ employee_id: number; dept_id: string | null; dept_name: string | null }>(
    `WITH candidates AS (
       SELECT e.id AS employee_id,
              (SELECT a.org_department_id
                 FROM employee_assignments a
                WHERE a.employee_id = e.id
                  AND a.effective_from <= $3::date
                  AND (a.effective_to IS NULL OR a.effective_to >= $2::date)
                ORDER BY a.effective_from DESC, a.is_primary DESC, a.id DESC
                LIMIT 1) AS assigned_dept,
              e.org_department_id AS current_dept,
              (SELECT de.from_department_id
                 FROM employee_dismissal_events de
                WHERE de.employee_id = e.id
                  AND de.dismissal_date IS NOT NULL
                  AND de.dismissal_date >= $2::date
                  AND de.cancelled = false
                ORDER BY de.dismissal_date DESC
                LIMIT 1) AS dismissal_dept
         FROM employees e
        WHERE e.id = ANY($1::int[])
          AND e.is_archived = false
          AND (e.employment_status = 'active'
               OR (e.employment_status = 'fired'
                   AND e.dismissal_date IS NOT NULL
                   AND e.dismissal_date >= $2::date))
          AND NOT (e.excluded_from_timesheet = true
                   AND (e.excluded_from_timesheet_date IS NULL
                        OR e.excluded_from_timesheet_date <= $2::date))
     )
     SELECT c.employee_id,
            COALESCE(c.assigned_dept, c.current_dept, c.dismissal_dept)::text AS dept_id,
            d.name AS dept_name
       FROM candidates c
       LEFT JOIN org_departments d ON d.id = COALESCE(c.assigned_dept, c.current_dept, c.dismissal_dept)`,
    [empIds, START_DATE, END_DATE],
  );
  const memberByEmp = new Map<number, string | null>(rosterRows.map(r => [Number(r.employee_id), r.dept_id]));
  console.log(`в ростере периода ${memberByEmp.size}, вне ростера ${empIds.length - memberByEmp.size}`);

  // Все отделы сотрудника за период — справочная колонка, чтобы переводы были видны.
  const periodDeptRows = await query<{ employee_id: number; names: string }>(
    `SELECT a.employee_id, string_agg(DISTINCT d.name, '; ' ORDER BY d.name) AS names
       FROM employee_assignments a
       JOIN org_departments d ON d.id = a.org_department_id
      WHERE a.employee_id = ANY($1::int[])
        AND a.effective_from <= $3::date
        AND (a.effective_to IS NULL OR a.effective_to >= $2::date)
      GROUP BY a.employee_id`,
    [empIds, START_DATE, END_DATE],
  );
  const deptsInPeriodByEmp = new Map(periodDeptRows.map(r => [Number(r.employee_id), r.names]));

  // ── Строки единого файла 1С ────────────────────────────────────────────────
  const rosterIds = [...memberByEmp.keys()];
  const empIdsByDept = new Map<string | null, number[]>();
  for (const [empId, deptId] of memberByEmp) {
    const list = empIdsByDept.get(deptId);
    if (list) list.push(empId);
    else empIdsByDept.set(deptId, [empId]);
  }
  const deptIds = [...empIdsByDept.keys()].filter((id): id is string => Boolean(id));
  const deptNameRows = deptIds.length > 0
    ? await query<{ id: string; name: string }>(
      'SELECT id::text, name FROM org_departments WHERE id = ANY($1::uuid[])',
      [deptIds],
    )
    : [];
  const deptNameById = new Map(deptNameRows.map(r => [r.id, r.name]));

  const exemptEmployeeIds = await assignedCtl.listBrigadeSupervisorEmployeeIdsForDepartments(deptIds);
  const exemptOverlap = rosterIds.filter(id => exemptEmployeeIds.has(id)).length;
  console.log(`exempt (начальники участков) ${exemptEmployeeIds.size}, пересечение с выборкой ${exemptOverlap}`);

  const bulk = await exportSvc.fetchTimesheetDataForEmployees(
    MONTH, rosterIds, 'Сводный 1С', { startDate: START_DATE, endDate: END_DATE }, 'actual', true,
    { excludeZeroActivity: true, exemptEmployeeIds },
  );
  const inBulk = new Set(bulk.employees.map(e => e.id));
  console.log(`в bulk после excludeZeroActivity ${inBulk.size}, выпало ${rosterIds.length - inBulk.size}`);

  const collected = [...empIdsByDept].map(([deptId, ids]) => exportSvc.sliceTimesheetDataByEmployees(
    bulk,
    ids,
    (deptId && deptNameById.get(deptId)) || 'Без названия',
    deptId,
  ));

  const unifiedRows = await unifiedSvc.buildUnified1CRows(collected);
  // Связываем строго по employeeId — в самом листе id не остаётся, ФИО не уникально.
  const rowsByEmp = new Map<number, Array<{ dept: string; address: string }>>();
  for (const r of unifiedRows) {
    const empId = r.oneCRow.employeeId;
    rowsByEmp.set(empId, [
      ...(rowsByEmp.get(empId) ?? []),
      { dept: r.departmentName, address: r.objectAddress },
    ]);
  }
  console.log(`строк единого файла ${unifiedRows.length} на ${rowsByEmp.size} сотрудников`);

  const sheet3: ISheet3Row[] = [];
  const sheet4: string[][] = [];

  for (const [idx, source] of dataRows.entries()) {
    const emp = matchByRow.get(idx);
    const dept1c = source[2] ?? '';
    const obj1c = source[4] ?? '';
    const fio = source[0] ?? '';
    const deptNow = emp?.dept_now ?? '';
    const deptsInPeriod = emp ? (deptsInPeriodByEmp.get(emp.id) ?? '') : '';

    const pushBoth = (deptFot: string, addressFot: string, status: string): void => {
      sheet3.push({ source, deptFot, addressFot, status, deptNow, deptsInPeriod });
      sheet4.push([fio, deptNow, addressFot || status, dept1c, obj1c, deptFot, deptsInPeriod]);
    };

    if (!emp) {
      pushBoth('', '', STATUS_NOT_IN_FOT);
      continue;
    }
    if (!memberByEmp.has(emp.id)) {
      pushBoth('', '', STATUS_NOT_IN_ROSTER);
      continue;
    }
    const fotRows = rowsByEmp.get(emp.id) ?? [];
    if (fotRows.length === 0) {
      pushBoth(deptNameById.get(memberByEmp.get(emp.id) ?? '') ?? '', '', STATUS_NO_ACTIVITY);
      continue;
    }

    for (const fr of fotRows) {
      sheet3.push({ source, deptFot: fr.dept, addressFot: fr.address, status: '', deptNow, deptsInPeriod });
    }
    // Отдел сверяем с текущим (карточка): выгрузка 1С тоже актуальная, а отдел периода
    // у переведённых людей законно другой — он остаётся справочной колонкой.
    const deptDiffers = normalizeValue(deptNow) !== normalizeValue(dept1c);
    const objDiffers = fotRows.every(fr => normalizeValue(fr.address) !== normalizeValue(obj1c));
    if (deptDiffers || objDiffers) {
      sheet4.push([
        fio,
        deptNow,
        [...new Set(fotRows.map(fr => fr.address))].join('\n'),
        dept1c,
        obj1c,
        [...new Set(fotRows.map(fr => fr.dept))].join('\n'),
        deptsInPeriod,
      ]);
    }
  }

  console.log(`Лист3 строк ${sheet3.length}, Лист4 строк ${sheet4.length}`);

  const wb = new ExcelJS.Workbook();
  const boldHeader = (ws: ExcelJS.Worksheet, cols: number): void => {
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    ws.autoFilter = { from: 'A1', to: `${ws.getColumn(cols).letter}1` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const r of s.rows) ws.addRow(r);
  }

  const ws3 = wb.addWorksheet('Лист3');
  ws3.addRow([...header, 'Отдел (ФОТ)', 'Адрес объекта (ФОТ)', 'Статус (ФОТ)', 'Отдел сейчас (ФОТ)', 'Отделы за период (ФОТ)']);
  for (const r of sheet3) ws3.addRow([...r.source, r.deptFot, r.addressFot, r.status, r.deptNow, r.deptsInPeriod]);
  ws3.getColumn(1).width = 42;
  ws3.getColumn(3).width = 32;
  ws3.getColumn(5).width = 70;
  ws3.getColumn(header.length + 1).width = 32;
  ws3.getColumn(header.length + 2).width = 70;
  ws3.getColumn(header.length + 3).width = 24;
  ws3.getColumn(header.length + 4).width = 32;
  ws3.getColumn(header.length + 5).width = 40;
  boldHeader(ws3, header.length + 5);

  const ws4 = wb.addWorksheet('Лист4');
  ws4.addRow(['ФИО', 'Отдел сейчас (ФОТ)', 'Адрес объекта (ФОТ)', 'Подразделение', 'Объект выполнения', 'Отдел в августе (ФОТ)', 'Отделы за период (ФОТ)']);
  for (const r of sheet4) {
    const added = ws4.addRow(r);
    added.alignment = { vertical: 'top', wrapText: true };
  }
  for (const [i, w] of [42, 32, 70, 32, 70, 32, 40].entries()) ws4.getColumn(i + 1).width = w;
  boldHeader(ws4, 7);

  await wb.xlsx.writeFile(OUT_TEMP);
  await wb.xlsx.writeFile(OUT_TMP);
  console.log(OUT_TEMP);
  console.log(OUT_TMP);

  await getPool().end();
};

void main();
