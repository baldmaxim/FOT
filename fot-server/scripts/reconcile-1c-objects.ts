/**
 * Сверка объектов из выгрузки 1С с фактическими данными ФОТ (READ-ONLY).
 *
 * Отвечает на вопрос «совпадут ли объекты, если включить сотрудникам режим skud».
 * Ничего не пишет в БД; списки расхождений выгружает в temp/.
 *
 * Стороны сравнения:
 *   1С  — xlsx-выгрузка, лист «в1», колонки: Сотрудник | ОбъектВыполнения | Подразделение | Часов.
 *         Строки с объектом «Текущая деятельность» исключаются — они не про разбивку.
 *   ФОТ — фактические объекты периода: пары skud_events × skud_object_access_points плюс
 *         объектные корректировки attendance_adjustments (source_type='manual_object',
 *         hours_override > 0).
 *
 * Нормализация названия объекта — ключевая деталь:
 *   NBSP (U+00A0) → пробел, схлопывание пробелов, lower, сравнение с ПОЛНЫМ
 *   COALESCE(NULLIF(btrim(alt_name),''), name). Обрезка ключа не делается: на 28 символах
 *   коллизия реальна (ЗИЛАРТ «Лот 33» vs «Лоты 18, 19, 27»). Без NBSP-шага 125 строк по
 *   Примавере К14 ложно попадают в «нет в справочнике».
 *
 * Матч ФИО: lower(btrim(full_name)), is_archived = false. ФИО с несколькими кандидатами
 * из подсчёта исключаются (однофамильцы), они попадают в отчёт отдельным списком.
 *
 * Запуск:
 *   npx tsx scripts/reconcile-1c-objects.ts temp/tabel_july26.xlsx 2026-07-01 2026-07-31
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV = 'test';

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

const envFile = parseEnvLastWins(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
const rawUrl = envFile.DATABASE_URL;
if (!rawUrl) {
  console.error('DATABASE_URL не найден в fot-server/.env');
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
process.env.DATABASE_SSL_CA_PATH = path.resolve(__dirname, '../../.migration/yandex-ca.pem');

const CURRENT_ACTIVITY = 'текущая деятельность';

/** Единая нормализация для обеих сторон сравнения. */
const normalize = (value: string): string =>
  value.replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

interface IOneCRow {
  fio: string;
  objectKey: string;
  objectRaw: string;
  hours: number;
}

const readOneCSheet = async (file: string): Promise<IOneCRow[]> => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('В файле нет листов');

  const rows: IOneCRow[] = [];
  ws.eachRow((row, index) => {
    if (index === 1) return; // шапка
    const fio = String(row.getCell(1).value ?? '').trim();
    const objectRaw = String(row.getCell(2).value ?? '').trim();
    const hours = Number(row.getCell(4).value ?? 0);
    if (!fio || !objectRaw) return;
    const objectKey = normalize(objectRaw);
    if (objectKey === CURRENT_ACTIVITY) return;
    rows.push({ fio, objectKey, objectRaw, hours: Number.isFinite(hours) ? hours : 0 });
  });
  return rows;
};

async function main(): Promise<void> {
  const { query } = await import('../src/config/postgres.js');

  const file = process.argv[2] ?? path.resolve(__dirname, '../../temp/tabel_july26.xlsx');
  const from = process.argv[3] ?? '2026-07-01';
  const to = process.argv[4] ?? '2026-07-31';
  console.log(`Файл 1С: ${file}\nПериод: ${from} .. ${to}\n`);

  const oneC = await readOneCSheet(file);
  console.log(`Строк 1С (без «Текущей деятельности»): ${oneC.length}`);

  // Справочник объектов ФОТ по нормализованному полному названию.
  const objects = await query<{ id: string; name: string; alt_name: string | null }>(
    'SELECT id::text, name, alt_name FROM skud_objects',
  );
  const objectIdByKey = new Map<string, string>();
  const objectNameById = new Map<string, string>();
  for (const o of objects) {
    const address = (o.alt_name ?? '').trim() || o.name;
    objectIdByKey.set(normalize(address), o.id);
    objectNameById.set(o.id, o.name);
  }

  // Матч ФИО. Дубли исключаются из подсчёта, но попадают в отчёт.
  const fioList = [...new Set(oneC.map(r => r.fio))];
  const empRows = await query<{ fio_key: string; ids: string }>(
    `SELECT lower(btrim(full_name)) AS fio_key, string_agg(id::text, ',') AS ids
       FROM employees
      WHERE is_archived = false AND lower(btrim(full_name)) = ANY($1::text[])
      GROUP BY 1`,
    [fioList.map(f => f.toLowerCase().trim())],
  );
  const idsByFio = new Map(empRows.map(r => [r.fio_key, r.ids.split(',').map(Number)]));

  const notFound: string[] = [];
  const ambiguous: string[] = [];
  const empIdByFio = new Map<string, number>();
  for (const fio of fioList) {
    const ids = idsByFio.get(fio.toLowerCase().trim());
    if (!ids || ids.length === 0) { notFound.push(fio); continue; }
    if (ids.length > 1) { ambiguous.push(`${fio} → ${ids.join(', ')}`); continue; }
    empIdByFio.set(fio, ids[0]);
  }
  console.log(`Уникальных ФИО: ${fioList.length}; не найдено: ${notFound.length}; с дублями: ${ambiguous.length}`);

  // Фактические объекты ФОТ за период.
  const empIds = [...empIdByFio.values()];
  const fotRows = await query<{ employee_id: number; object_id: string; days: string }>(
    `SELECT employee_id, object_id::text, sum(days)::text AS days FROM (
       SELECT se.employee_id, sap.object_id, count(DISTINCT se.event_date) AS days
         FROM skud_events se
         JOIN skud_object_access_points sap
           ON btrim(lower(sap.access_point_name)) = btrim(lower(se.access_point))
        WHERE se.event_date BETWEEN $2::date AND $3::date
          AND se.employee_id = ANY($1::int[])
        GROUP BY 1, 2
       UNION ALL
       SELECT aa.employee_id, (aa.metadata->>'object_id')::uuid, count(DISTINCT aa.work_date)
         FROM attendance_adjustments aa
        WHERE aa.source_type = 'manual_object'
          AND aa.work_date BETWEEN $2::date AND $3::date
          AND aa.metadata ? 'object_id'
          AND COALESCE(aa.hours_override, 0) > 0
          AND aa.employee_id = ANY($1::int[])
        GROUP BY 1, 2
     ) t GROUP BY 1, 2`,
    [empIds, from, to],
  );

  const fotPairs = new Set<string>();
  const fotDays = new Map<string, number>();
  for (const r of fotRows) {
    const key = `${r.employee_id}|${r.object_id}`;
    fotPairs.add(key);
    fotDays.set(key, Number(r.days));
  }

  // Сравнение пар (сотрудник × объект).
  const unknownObjects = new Map<string, number>();
  const oneCPairs = new Set<string>();
  const onlyIn1C: Array<{ fio: string; object: string }> = [];

  for (const row of oneC) {
    const empId = empIdByFio.get(row.fio);
    if (!empId) continue;
    const objectId = objectIdByKey.get(row.objectKey);
    if (!objectId) {
      unknownObjects.set(row.objectRaw, (unknownObjects.get(row.objectRaw) ?? 0) + 1);
      continue;
    }
    const key = `${empId}|${objectId}`;
    if (oneCPairs.has(key)) continue;
    oneCPairs.add(key);
    if (!fotPairs.has(key)) onlyIn1C.push({ fio: row.fio, object: objectNameById.get(objectId) ?? objectId });
  }

  const fioByEmpId = new Map([...empIdByFio].map(([fio, id]) => [id, fio]));
  const onlyInFot: Array<{ fio: string; object: string; days: number }> = [];
  for (const key of fotPairs) {
    if (oneCPairs.has(key)) continue;
    const [empIdStr, objectId] = key.split('|');
    onlyInFot.push({
      fio: fioByEmpId.get(Number(empIdStr)) ?? empIdStr,
      object: objectNameById.get(objectId) ?? objectId,
      days: fotDays.get(key) ?? 0,
    });
  }

  const matched = [...oneCPairs].filter(k => fotPairs.has(k)).length;
  const total = oneCPairs.size;
  const percent = total > 0 ? ((matched / total) * 100).toFixed(1) : '—';

  console.log('\n=== Итог ===');
  console.log(`Пар «сотрудник × объект» из 1С: ${total}`);
  console.log(`  совпало с ФОТ: ${matched} (${percent}%)`);
  console.log(`  в 1С есть, в ФОТ нет: ${onlyIn1C.length}`);
  console.log(`в ФОТ есть, в 1С нет: ${onlyInFot.length} (из них >= 3 дней: ${onlyInFot.filter(r => r.days >= 3).length})`);
  console.log(`Названий объектов вне справочника ФОТ: ${unknownObjects.size}`);

  const outDir = path.resolve(__dirname, '../../temp');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'reconcile_1c_objects.json');
  fs.writeFileSync(outFile, JSON.stringify({
    period: { from, to },
    summary: { total, matched, percent, only_in_1c: onlyIn1C.length, only_in_fot: onlyInFot.length },
    only_in_1c: onlyIn1C,
    only_in_fot: onlyInFot.sort((a, b) => b.days - a.days),
    unknown_objects: [...unknownObjects].map(([name, count]) => ({ name, count })),
    fio_not_found: notFound,
    fio_ambiguous: ambiguous,
  }, null, 2), 'utf8');
  console.log(`\nПолные списки расхождений: ${outFile}`);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
