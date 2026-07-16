/**
 * Выгрузка в Excel номеров МТС Бизнес с одинаковым ФИО владельца (mts_fio).
 *
 * Группировка по нормализованному ФИО (trim, lower, схлопывание пробелов, ё→е).
 * В отчёт попадают только ФИО, встречающиеся у 2+ разных номеров.
 *
 * Запуск на проде:
 *   cd /opt/fot-build/fot-server && npx tsx scripts/export-mts-duplicate-fio.ts
 *   cd /opt/fot-build/fot-server && npx tsx scripts/export-mts-duplicate-fio.ts --out /tmp/mts-duplicate-fio.xlsx
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envCandidates = [
  process.env.MTS_ENV_FILE,
  path.resolve(process.cwd(), '.env'),
  '/srv/sites/fot.su10.ru/fot-server/.env',
  path.resolve(__dirname, '../.env'),
].filter((p): p is string => Boolean(p));
const envPath = envCandidates.find(p => fs.existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath });
  console.log(`[env] загружен ${envPath}`);
}

const outIdx = process.argv.indexOf('--out');
const outPath = outIdx >= 0
  ? process.argv[outIdx + 1]
  : path.resolve(process.cwd(), `mts-duplicate-fio-${new Date().toISOString().slice(0, 10)}.xlsx`);

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

interface IRow {
  fio_norm: string;
  mts_fio: string;
  msisdn_enc: string | null;
  employee_id: number | null;
  employee_full_name: string | null;
  tab_number: string | null;
  account_id: string | null;
  mts_comment: string | null;
  numbers_in_group: string;
}

const main = async (): Promise<void> => {
  const { query } = await import('../src/config/postgres.js');
  const { encryptionService } = await import('../src/services/encryption.service.js');

  const rows = await query<IRow>(
    `WITH base AS (
       SELECT
         lower(trim(regexp_replace(replace(nm.mts_fio, 'ё', 'е'), '\\s+', ' ', 'g'))) AS fio_norm,
         nm.mts_fio,
         nm.msisdn_enc,
         nm.employee_id,
         e.full_name AS employee_full_name,
         e.tab_number,
         nm.account_id::text AS account_id,
         nm.mts_comment
       FROM mts_business_number_map nm
       LEFT JOIN employees e ON e.id = nm.employee_id
       WHERE nm.mts_fio IS NOT NULL AND trim(nm.mts_fio) <> ''
     ),
     dupes AS (
       SELECT fio_norm
         FROM base
        GROUP BY fio_norm
       HAVING COUNT(*) > 1
     )
     SELECT
       b.fio_norm,
       b.mts_fio,
       b.msisdn_enc,
       b.employee_id,
       b.employee_full_name,
       b.tab_number,
       b.account_id,
       b.mts_comment,
       COUNT(*) OVER (PARTITION BY b.fio_norm)::text AS numbers_in_group
     FROM base b
     INNER JOIN dupes d ON d.fio_norm = b.fio_norm
     ORDER BY b.fio_norm, b.mts_fio, b.msisdn_enc`,
  );

  const groupCount = new Set(rows.map(r => r.fio_norm)).size;
  console.log(`Найдено ФИО с дублями: ${groupCount}, строк (номеров): ${rows.length}`);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'FOT';
  wb.created = new Date();

  const ws = wb.addWorksheet('Одинаковые ФИО МТС');
  ws.columns = [
    { header: 'ФИО МТС (как в данных)', key: 'mtsFio', width: 36 },
    { header: 'Номер телефона', key: 'msisdn', width: 18 },
    { header: 'Номеров с этим ФИО', key: 'groupSize', width: 18 },
    { header: 'Сотрудник ФОТ', key: 'employeeName', width: 36 },
    { header: 'Таб. №', key: 'tabNumber', width: 12 },
    { header: 'Комментарий МТС', key: 'mtsComment', width: 28 },
    { header: 'Account ID', key: 'accountId', width: 38 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell(cell => {
    cell.border = thinBorder;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
  });

  for (const r of rows) {
    const msisdn = encryptionService.decryptField(r.msisdn_enc);
    ws.addRow({
      mtsFio: r.mts_fio,
      msisdn: msisdn ?? '',
      groupSize: Number(r.numbers_in_group),
      employeeName: r.employee_full_name ?? '',
      tabNumber: r.tab_number ?? '',
      mtsComment: r.mts_comment ?? '',
      accountId: r.account_id ?? '',
    });
  }

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell(cell => {
      cell.border = thinBorder;
    });
  });

  await wb.xlsx.writeFile(outPath);
  console.log(`Файл: ${outPath}`);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
