/**
 * Разовый генератор целевого списка для set-timesheet-modes-l4.ts.
 * Читает Лист4 (расхождения) и Лист2 (там табельные номера) из C:\tmp\ov-new.xlsx,
 * строго сопоставляет сотрудников с ФОТ и резолвит объект по «Объект выполнения» (1С).
 * Пишет temp/l4-targets.json + готовый TS-литерал temp/l4-targets.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const XLSX = 'C:\\tmp\\ov-new.xlsx';

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
try {
  const u = new URL(envFile.DATABASE_URL!);
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
  process.env.DATABASE_URL = u.toString();
} catch {
  process.env.DATABASE_URL = envFile.DATABASE_URL;
}
process.env.DATABASE_SSL = 'true';
process.env.DATABASE_SSL_CA_PATH = path.join(REPO, '.migration', 'yandex-ca.pem');
process.env.NODE_ENV = 'test';

const normalizeName = (value: unknown): string =>
  String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');

const normalizeValue = (value: unknown): string =>
  normalizeName(value)
    .replace(/[«»„“”"']/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, '-');

const normalizeTab = (value: unknown): string =>
  String(value ?? '')
    .replace(/\D/g, '')
    .replace(/^0+/, '') || '';

/** Утверждённый вручную маппинг: объект 1С → name объекта ФОТ (или current_activity). */
const MANUAL_MAP: Array<{ obj1c: string; objectName: string | null }> = [
  { obj1c: 'Волоколамское ш., вл. 97, ЖК CITY BAY, к. 1 - 8, н/ч, к. 9, п/ч в осях 1-16 / А-Н (Подэтап 1, 2), разработка РД, Благоустройство', objectName: 'ЖК Ситибэй' },
  { obj1c: 'Волгоградский пр-т, вл. 32/5, оч. 2, этап 2, секции 1 - 7 н/ч, п/ч отм. -3.000; -5.550; -8.850, благоустройство, разработка РД', objectName: 'ЖК Метрополия' },
  { obj1c: 'Волгоградский пр-т, вл. 32/5, оч. 2, этап 1.2, секции 1 - 4 н/ч, п/ч, ДОО 1, 2 этаж, благоустройство, разработка РД', objectName: 'ЖК Метрополия' },
  { obj1c: 'Волгоградский пр-т, вл. 32/5, оч. 2, этап 1.1, к. А, н/ч; п/ч (автостоянка) (- 1 и - 2 уровни)', objectName: 'ЖК Метрополия' },
  { obj1c: 'Волгоградский пр-т, вл. 32/3, к. 1 - 7, стилобат, подземная часть (автостоянка) (- 1 и - 2 уровни)', objectName: 'ЖК Метрополия' },
  { obj1c: 'Раменки р-н, ЖК СОБЫТИЕ-2 (ГЕНПОДРЯД), м/у ул. Лобачевского и платформой "Матвеевское", п/ч, с. 1 - 5, ДОО, н/ч, благ-во, подг. период, разр. пр. док.', objectName: 'ЖК События 6.2' },
  { obj1c: 'Раменки р-н, ЖК "Событие 6.1", м/у ул. Лобачевского и платформой "Матвеевское", п/ч, н/ч, организация стройпл.', objectName: 'ЖК События 6.2' },
  { obj1c: 'Фридриха Энгельса ул., з. у. 56/1, КОРПУС РЕНОВАЦИИ н/ч (9 эт.), п/ч (-1 эт), организация стр. площадки в соотв-и с ПОС', objectName: 'ЖК Дом 56' },
  { obj1c: 'Котляковский 2-й пер., вл. 1, Варшавская LIFE, д/с 11, кв. 1, 2, 3, н/ч, благоустройство (Дворы, бульвар, бульвар-восстановление)', objectName: 'Варшавская (ГО)' },
  { obj1c: 'Ильменский пр-д, вл. 14, оч. 2-я, к. Д. (с ДОУ), К, С, п/ч (автостоянка) (-1 и -2 уровни)', objectName: 'Селигер Сити' },
  // Объект «Офис Полковая 3» печатается как «Текущая деятельность» — ставим режим напрямую.
  { obj1c: 'Полковая ул, д. 3 (офис)', objectName: null },
];

interface ITarget {
  employeeId: number;
  name: string;
  tab: string;
  mode: 'object' | 'current_activity';
  objectId: string | null;
  objectName: string | null;
  objectAddress: string | null;
  obj1c: string;
  source: 'exact' | 'manual';
}

const main = async (): Promise<void> => {
  const { query, getPool } = await import('../src/config/postgres.js');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws2 = wb.getWorksheet('Лист2');
  const ws4 = wb.getWorksheet('Лист4');
  if (!ws2 || !ws4) throw new Error('Лист2/Лист4 не найдены');

  // Табельные номера — только из Лист2, там колонка «Код (Таб. №)».
  const tabByName = new Map<string, string[]>();
  ws2.eachRow((row, idx) => {
    if (idx === 1) return;
    const name = normalizeName(row.getCell(1).text);
    const tab = String(row.getCell(2).text ?? '').trim();
    if (!name) return;
    tabByName.set(name, [...(tabByName.get(name) ?? []), tab]);
  });

  interface IL4 { fio: string; addressFot: string; dept1c: string; obj1c: string }
  const l4: IL4[] = [];
  ws4.eachRow((row, idx) => {
    if (idx === 1) return;
    l4.push({
      fio: String(row.getCell(1).text ?? '').trim(),
      addressFot: String(row.getCell(3).text ?? '').trim(),
      dept1c: String(row.getCell(4).text ?? '').trim(),
      obj1c: String(row.getCell(5).text ?? '').trim(),
    });
  });
  console.log(`Лист4 строк ${l4.length}`);

  const objects = await query<{ id: string; name: string; alt_name: string | null; is_active: boolean }>(
    'SELECT id::text, name, alt_name, is_active FROM skud_objects',
  );
  const activeObjects = objects.filter(o => o.is_active);
  const printed = (o: { name: string; alt_name: string | null }): string =>
    (o.alt_name?.trim() ? o.alt_name.trim() : o.name);

  const byAlt = new Map<string, typeof activeObjects>();
  for (const o of activeObjects) {
    const k = normalizeValue(o.alt_name ?? '');
    if (!k) continue;
    byAlt.set(k, [...(byAlt.get(k) ?? []), o]);
  }
  const byName = new Map<string, typeof activeObjects>();
  for (const o of activeObjects) {
    byName.set(normalizeValue(o.name), [...(byName.get(normalizeValue(o.name)) ?? []), o]);
  }
  const manualByObj1c = new Map(MANUAL_MAP.map(m => [normalizeValue(m.obj1c), m]));

  const employees = await query<{
    id: number; full_name: string | null; tab_number: string | null;
    employment_status: string | null; is_archived: boolean; dept_name: string | null;
  }>(`
    SELECT e.id, e.full_name, e.tab_number, e.employment_status, e.is_archived, d.name AS dept_name
      FROM employees e LEFT JOIN org_departments d ON d.id = e.org_department_id
  `);
  const empByTab = new Map<string, typeof employees>();
  const empByName = new Map<string, typeof employees>();
  for (const e of employees) {
    const t = normalizeTab(e.tab_number);
    if (t) empByTab.set(t, [...(empByTab.get(t) ?? []), e]);
    const n = normalizeName(e.full_name);
    if (n) empByName.set(n, [...(empByName.get(n) ?? []), e]);
  }

  const targets: ITarget[] = [];
  const skipped: Array<{ fio: string; reason: string; obj1c: string }> = [];

  for (const row of l4) {
    const nName = normalizeName(row.fio);
    const tabs = [...new Set((tabByName.get(nName) ?? []).map(normalizeTab).filter(Boolean))];

    // Матчим ТОЛЬКО по ФИО: нумерация табельных в 1С и ФОТ разная, совпадение номера
    // случайно и даёт чужого человека (1С 004034 = Рахматуллаев, ФОТ 04034 = Саидов).
    // Табельный — лишь тай-брейк среди однофамильцев.
    let emp: (typeof employees)[number] | null = null;
    const hit = empByName.get(nName) ?? [];
    if (hit.length === 1) {
      emp = hit[0];
    } else if (hit.length > 1) {
      const byTabHit = tabs.length === 1
        ? hit.filter(e => normalizeTab(e.tab_number) === tabs[0])
        : [];
      const byDept = hit.filter(e => normalizeValue(e.dept_name) === normalizeValue(row.dept1c));
      const alive = hit.filter(e => !e.is_archived && (e.employment_status ?? 'active') === 'active');
      if (byTabHit.length === 1) emp = byTabHit[0];
      else if (byDept.length === 1) emp = byDept[0];
      else if (alive.length === 1) emp = alive[0];
      else {
        skipped.push({ fio: row.fio, reason: `неоднозначное ФИО (${hit.length} кандидатов, таб ${byTabHit.length}, отдел ${byDept.length}, активных ${alive.length})`, obj1c: row.obj1c });
        continue;
      }
      console.log(`  ↪ тай-брейк «${row.fio}» → id ${emp.id} (${emp.dept_name ?? '—'})`);
    }
    if (!emp) {
      skipped.push({ fio: row.fio, reason: 'не найден в ФОТ', obj1c: row.obj1c });
      continue;
    }

    // Объект уже совпадает — расходится только отдел; персональный режим не нужен.
    if (row.addressFot && normalizeValue(row.addressFot) === normalizeValue(row.obj1c)) {
      skipped.push({ fio: row.fio, reason: 'объект уже совпадает (расходится только отдел)', obj1c: row.obj1c });
      continue;
    }

    const key = normalizeValue(row.obj1c);
    const exact = byAlt.get(key) ?? [];
    if (exact.length === 1) {
      targets.push({
        employeeId: emp.id, name: emp.full_name ?? row.fio, tab: emp.tab_number ?? '',
        mode: 'object', objectId: exact[0].id, objectName: exact[0].name,
        objectAddress: printed(exact[0]), obj1c: row.obj1c, source: 'exact',
      });
      continue;
    }
    if (exact.length > 1) {
      skipped.push({ fio: row.fio, reason: `адрес разрешился в ${exact.length} объектов`, obj1c: row.obj1c });
      continue;
    }

    const manual = manualByObj1c.get(key);
    if (!manual) {
      skipped.push({ fio: row.fio, reason: 'объект не найден и нет ручного маппинга', obj1c: row.obj1c });
      continue;
    }
    if (manual.objectName === null) {
      targets.push({
        employeeId: emp.id, name: emp.full_name ?? row.fio, tab: emp.tab_number ?? '',
        mode: 'current_activity', objectId: null, objectName: null, objectAddress: 'Текущая деятельность',
        obj1c: row.obj1c, source: 'manual',
      });
      continue;
    }
    const mapped = byName.get(normalizeValue(manual.objectName)) ?? [];
    if (mapped.length !== 1) {
      skipped.push({ fio: row.fio, reason: `ручной объект «${manual.objectName}» найден ${mapped.length} раз`, obj1c: row.obj1c });
      continue;
    }
    targets.push({
      employeeId: emp.id, name: emp.full_name ?? row.fio, tab: emp.tab_number ?? '',
      mode: 'object', objectId: mapped[0].id, objectName: mapped[0].name,
      objectAddress: printed(mapped[0]), obj1c: row.obj1c, source: 'manual',
    });
  }

  // Один employee_id — ровно один раз, без конфликтующих объектов.
  const byEmp = new Map<number, ITarget[]>();
  for (const t of targets) byEmp.set(t.employeeId, [...(byEmp.get(t.employeeId) ?? []), t]);
  const conflicts = [...byEmp].filter(([, list]) => list.length > 1);
  for (const [empId, list] of conflicts) {
    const distinct = new Set(list.map(t => `${t.mode}:${t.objectId ?? ''}`));
    console.error(`⚠ employee ${empId} (${list[0].name}) встречается ${list.length} раз, вариантов ${distinct.size}`);
  }
  if (conflicts.length > 0) throw new Error('Дубли employee_id в целевом списке — исправьте вручную');

  const modes = await query<{ id: number; timesheet_export_mode: string | null }>(
    'SELECT id, timesheet_export_mode FROM employees WHERE id = ANY($1::int[])',
    [targets.map(t => t.employeeId)],
  );
  const already = modes.filter(m => m.timesheet_export_mode !== null);

  console.log(`\nК записи ${targets.length} (exact ${targets.filter(t => t.source === 'exact').length}, manual ${targets.filter(t => t.source === 'manual').length})`);
  console.log(`Из них уже с ручным режимом (будут пропущены скриптом): ${already.length}`);
  console.log(`Пропущено при генерации: ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s.fio}: ${s.reason}`);

  const outJson = path.join(REPO, 'temp', 'l4-targets.json');
  fs.writeFileSync(outJson, JSON.stringify(targets, null, 2), 'utf8');

  const literal = targets
    .map(t => `  { employeeId: ${t.employeeId}, name: ${JSON.stringify(t.name)}, mode: '${t.mode}', objectId: ${t.objectId ? `'${t.objectId}'` : 'null'}, objectName: ${t.objectName ? JSON.stringify(t.objectName) : 'null'}, objectAddress: ${JSON.stringify(t.objectAddress)} },`)
    .join('\n');
  const outTs = path.join(REPO, 'temp', 'l4-targets.ts');
  fs.writeFileSync(outTs, `export const TARGETS: ITarget[] = [\n${literal}\n];\n`, 'utf8');
  console.log(`\n${outJson}\n${outTs}`);

  await getPool().end();
};

void main();
