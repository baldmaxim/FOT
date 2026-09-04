/**
 * Независимая проверка вшитого в set-timesheet-modes-l4.ts списка TARGETS.
 * Разбирает именно тот массив, который будет исполняться, и сверяет его
 * с Лист4 из C:\tmp\ov-new.xlsx и с прод-БД. Ничего не пишет.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const XLSX = 'C:\\tmp\\ov-new.xlsx';
const SCRIPT = path.join(REPO, 'fot-server', 'scripts', 'set-timesheet-modes-l4.ts');

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

/** Утверждённый пользователем ручной маппинг (объект 1С → объект ФОТ / режим ТД). */
const MANUAL_ALLOWED = new Map<string, string | null>([
  ['Волоколамское ш., вл. 97, ЖК CITY BAY, к. 1 - 8, н/ч, к. 9, п/ч в осях 1-16 / А-Н (Подэтап 1, 2), разработка РД, Благоустройство', 'ЖК Ситибэй'],
  ['Волгоградский пр-т, вл. 32/5, оч. 2, этап 2, секции 1 - 7 н/ч, п/ч отм. -3.000; -5.550; -8.850, благоустройство, разработка РД', 'ЖК Метрополия'],
  ['Волгоградский пр-т, вл. 32/5, оч. 2, этап 1.2, секции 1 - 4 н/ч, п/ч, ДОО 1, 2 этаж, благоустройство, разработка РД', 'ЖК Метрополия'],
  ['Волгоградский пр-т, вл. 32/5, оч. 2, этап 1.1, к. А, н/ч; п/ч (автостоянка) (- 1 и - 2 уровни)', 'ЖК Метрополия'],
  ['Волгоградский пр-т, вл. 32/3, к. 1 - 7, стилобат, подземная часть (автостоянка) (- 1 и - 2 уровни)', 'ЖК Метрополия'],
  ['Раменки р-н, ЖК СОБЫТИЕ-2 (ГЕНПОДРЯД), м/у ул. Лобачевского и платформой "Матвеевское", п/ч, с. 1 - 5, ДОО, н/ч, благ-во, подг. период, разр. пр. док.', 'ЖК События 6.2'],
  ['Раменки р-н, ЖК "Событие 6.1", м/у ул. Лобачевского и платформой "Матвеевское", п/ч, н/ч, организация стройпл.', 'ЖК События 6.2'],
  ['Фридриха Энгельса ул., з. у. 56/1, КОРПУС РЕНОВАЦИИ н/ч (9 эт.), п/ч (-1 эт), организация стр. площадки в соотв-и с ПОС', 'ЖК Дом 56'],
  ['Котляковский 2-й пер., вл. 1, Варшавская LIFE, д/с 11, кв. 1, 2, 3, н/ч, благоустройство (Дворы, бульвар, бульвар-восстановление)', 'Варшавская (ГО)'],
  ['Ильменский пр-д, вл. 14, оч. 2-я, к. Д. (с ДОУ), К, С, п/ч (автостоянка) (-1 и -2 уровни)', 'Селигер Сити'],
  ['Полковая ул, д. 3 (офис)', null],
].map(([k, v]) => [normalizeValue(k), v as string | null]));

interface IParsedTarget {
  employeeId: number;
  name: string;
  mode: string;
  objectId: string | null;
  objectName: string | null;
  objectAddress: string;
}

/** Разбор литерала TARGETS прямо из исходника скрипта — проверяем то, что исполнится. */
const parseTargets = (): IParsedTarget[] => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const block = src.match(/const TARGETS: ITarget\[\] = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error('Не найден литерал TARGETS');
  const out: IParsedTarget[] = [];
  const re = /\{ employeeId: (\d+), name: "((?:[^"\\]|\\.)*)", mode: '([a-z_]+)', objectId: (null|'[0-9a-f-]+'), objectName: (null|"(?:[^"\\]|\\.)*"), objectAddress: "((?:[^"\\]|\\.)*)" \}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) {
    out.push({
      employeeId: Number(m[1]),
      name: JSON.parse(`"${m[2]}"`),
      mode: m[3],
      objectId: m[4] === 'null' ? null : m[4].slice(1, -1),
      objectName: m[5] === 'null' ? null : JSON.parse(m[5]),
      objectAddress: JSON.parse(`"${m[6]}"`),
    });
  }
  return out;
};

const main = async (): Promise<void> => {
  const { query, getPool } = await import('../src/config/postgres.js');

  const targets = parseTargets();
  console.log(`Разобрано из скрипта: ${targets.length} целей`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws4 = wb.getWorksheet('Лист4');
  if (!ws4) throw new Error('Лист4 не найден');

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

  const l4ByName = new Map<string, IL4[]>();
  for (const r of l4) {
    const k = normalizeName(r.fio);
    l4ByName.set(k, [...(l4ByName.get(k) ?? []), r]);
  }

  const emps = await query<{ id: number; full_name: string | null; timesheet_export_mode: string | null }>(
    'SELECT id, full_name, timesheet_export_mode FROM employees WHERE id = ANY($1::int[])',
    [targets.map(t => t.employeeId)],
  );
  const empById = new Map(emps.map(e => [Number(e.id), e]));

  const objs = await query<{ id: string; name: string; alt_name: string | null; is_active: boolean }>(
    'SELECT id::text, name, alt_name, is_active FROM skud_objects',
  );
  const objById = new Map(objs.map(o => [o.id, o]));
  const activeByAlt = new Map<string, typeof objs>();
  for (const o of objs) {
    if (!o.is_active) continue;
    const k = normalizeValue(o.alt_name ?? '');
    if (k) activeByAlt.set(k, [...(activeByAlt.get(k) ?? []), o]);
  }

  const errors: string[] = [];
  const warns: string[] = [];
  const seen = new Set<number>();
  const coveredL4 = new Set<string>();

  for (const t of targets) {
    if (seen.has(t.employeeId)) errors.push(`дубль employeeId ${t.employeeId} (${t.name})`);
    seen.add(t.employeeId);

    // 1. Сотрудник существует и ФИО совпадает с БД.
    const emp = empById.get(t.employeeId);
    if (!emp) { errors.push(`${t.employeeId} ${t.name}: нет в БД`); continue; }
    if ((emp.full_name ?? '').trim() !== t.name.trim()) {
      errors.push(`${t.employeeId}: ФИО в БД «${emp.full_name}» ≠ «${t.name}»`);
    }

    // 2. Этот человек реально есть в Лист4 (ровно одной строкой), ФИО совпадает.
    const rows = l4ByName.get(normalizeName(t.name)) ?? [];
    if (rows.length === 0) { errors.push(`${t.employeeId} ${t.name}: нет строки в Лист4`); continue; }
    if (rows.length > 1) warns.push(`${t.name}: ${rows.length} строк в Лист4 (однофамильцы)`);
    coveredL4.add(normalizeName(t.name));
    const row = rows[0];

    // 3. Объект соответствует «Объект выполнения» 1С.
    const key = normalizeValue(row.obj1c);
    const exact = activeByAlt.get(key) ?? [];
    if (exact.length === 1) {
      if (t.mode !== 'object' || t.objectId !== exact[0].id) {
        errors.push(`${t.name}: объект 1С точно совпадает с «${exact[0].name}», а в списке ${t.mode} ${t.objectName ?? ''}`);
      }
    } else if (exact.length > 1) {
      errors.push(`${t.name}: адрес 1С разрешается в ${exact.length} объектов`);
    } else {
      const allowed = MANUAL_ALLOWED.get(key);
      if (allowed === undefined) {
        errors.push(`${t.name}: объект 1С не найден и не входит в утверждённый маппинг: ${row.obj1c.slice(0, 60)}`);
      } else if (allowed === null) {
        if (t.mode !== 'current_activity' || t.objectId !== null) {
          errors.push(`${t.name}: ожидался режим current_activity, получено ${t.mode} ${t.objectName ?? ''}`);
        }
      } else if (t.mode !== 'object' || t.objectName !== allowed) {
        errors.push(`${t.name}: по маппингу ожидался «${allowed}», получено ${t.mode} ${t.objectName ?? ''}`);
      }
    }

    // 4. Объект существует, активен, название и печатный адрес не разъехались.
    if (t.objectId) {
      const obj = objById.get(t.objectId);
      if (!obj) errors.push(`${t.name}: объект ${t.objectId} отсутствует`);
      else {
        if (!obj.is_active) errors.push(`${t.name}: объект «${obj.name}» неактивен`);
        if (obj.name !== t.objectName) errors.push(`${t.name}: название объекта «${obj.name}» ≠ «${t.objectName}»`);
        const printed = obj.alt_name?.trim() ? obj.alt_name.trim() : obj.name;
        if (printed !== t.objectAddress) errors.push(`${t.name}: печатный адрес объекта изменился`);
      }
    } else if (t.mode === 'object') {
      errors.push(`${t.name}: режим object без objectId`);
    }

    // 5. Ставим объект только тем, у кого он действительно расходится.
    if (row.addressFot && normalizeValue(row.addressFot) === normalizeValue(row.obj1c)) {
      errors.push(`${t.name}: объект в ФОТ уже совпадает с 1С — цель лишняя`);
    }
  }

  // 6. Строки Лист4, не покрытые списком: допустимы только «нет в ФОТ» и совпадающий объект.
  for (const r of l4) {
    if (coveredL4.has(normalizeName(r.fio))) continue;
    const sameObject = r.addressFot && normalizeValue(r.addressFot) === normalizeValue(r.obj1c);
    const notInFot = r.addressFot === 'нет в ФОТ';
    if (!sameObject && !notInFot) {
      warns.push(`строка Лист4 не покрыта: ${r.fio} — ${r.addressFot.slice(0, 40)}`);
    }
  }

  // 7. Кто уже имеет ручной режим — будет пропущен скриптом.
  const already = targets.filter(t => empById.get(t.employeeId)?.timesheet_export_mode != null);

  console.log(`\nПроверки: сотрудники ✓, объекты ✓, покрытие Лист4 ✓`);
  console.log(`Уже с ручным режимом (скрипт пропустит): ${already.length}`);
  for (const t of already) console.log(`  ⏭ ${t.employeeId} ${t.name} — ${empById.get(t.employeeId)?.timesheet_export_mode}`);
  if (warns.length > 0) {
    console.log(`\nПредупреждения (${warns.length}):`);
    for (const w of warns) console.log(`  ⚠ ${w}`);
  }
  if (errors.length > 0) {
    console.error(`\nОШИБКИ (${errors.length}):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    await getPool().end();
    process.exit(1);
  }
  console.log('\nСписок корректен.');
  await getPool().end();
};

void main();
