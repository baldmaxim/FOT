/**
 * Номера МТС Бизнес с абонентской платой (> 0), но без использования связи
 * (нет звонков в CDR и нет событий calls/sms/internet в выписке).
 *
 * Запуск на проде:
 *   cd /opt/fot-build/fot-server && npx tsx scripts/export-mts-unused-with-fee.ts
 *   cd /opt/fot-build/fot-server && npx tsx scripts/export-mts-unused-with-fee.ts --out /tmp/mts-unused-with-fee.xlsx
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
  : path.resolve(process.cwd(), `mts-unused-with-fee-${new Date().toISOString().slice(0, 10)}.xlsx`);

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

interface IRow {
  msisdn_enc: string | null;
  mts_fio: string | null;
  mts_comment: string | null;
  employee_full_name: string | null;
  tab_number: string | null;
  department_name: string | null;
  account_label: string | null;
  tariff_name: string | null;
  fee_amount: string | null;
  services_monthly: string | null;
  calls_count: string;
  internet_events: string;
  internet_mb: string;
  sms_count: string;
  stmt_periodic_amount: string | null;
  last_usage_at: string | null;
}

const main = async (): Promise<void> => {
  const { query } = await import('../src/config/postgres.js');
  const { encryptionService } = await import('../src/services/encryption.service.js');

  const rows = await query<IRow>(
    `WITH fee_snap AS (
       SELECT DISTINCT ON (msisdn_hash)
              msisdn_hash,
              (payload->>'amount')::numeric AS fee_amount
         FROM mts_business_metric_snapshot
        WHERE scope = 'msisdn'
          AND metric = 'tariff_fee'
          AND msisdn_hash IS NOT NULL
        ORDER BY msisdn_hash, captured_at DESC
     ),
     plan_snap AS (
       SELECT DISTINCT ON (msisdn_hash)
              msisdn_hash,
              payload->>'tariffName' AS tariff_name
         FROM mts_business_metric_snapshot
        WHERE scope = 'msisdn'
          AND metric = 'bill_plan'
          AND msisdn_hash IS NOT NULL
        ORDER BY msisdn_hash, captured_at DESC
     ),
     services_snap AS (
       SELECT DISTINCT ON (msisdn_hash)
              msisdn_hash,
              payload AS product_services
         FROM mts_business_metric_snapshot
        WHERE scope = 'msisdn'
          AND metric = 'product_services'
          AND msisdn_hash IS NOT NULL
        ORDER BY msisdn_hash, captured_at DESC
     ),
     services_sum AS (
       SELECT s.msisdn_hash,
              COALESCE((
                SELECT SUM(COALESCE((x->>'monthlyAmount')::numeric, 0))
                  FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(s.product_services) = 'array'
                         THEN s.product_services ELSE '[]'::jsonb END
                  ) AS x
              ), 0) AS services_monthly
         FROM services_snap s
     ),
     usage AS (
       SELECT msisdn_hash,
              COUNT(*) FILTER (WHERE category = 'calls') AS calls_events,
              COUNT(*) FILTER (WHERE category = 'sms') AS sms_events,
              COUNT(*) FILTER (WHERE category = 'internet') AS internet_events,
              COALESCE(
                SUM(units) FILTER (WHERE category = 'internet' AND unit_code = 'BYTE'),
                0
              ) AS internet_bytes,
              COALESCE(SUM(amount) FILTER (WHERE category = 'periodic'), 0) AS periodic_amount
         FROM mts_business_statement_rows
        GROUP BY msisdn_hash
     ),
     cdr AS (
       SELECT msisdn_hash, calls
         FROM mts_business_cdr_rollup
     )
     SELECT
       nm.msisdn_enc,
       nm.mts_fio,
       nm.mts_comment,
       e.full_name AS employee_full_name,
       e.tab_number,
       od.name AS department_name,
       a.label AS account_label,
       p.tariff_name,
       f.fee_amount::text,
       COALESCE(ss.services_monthly, 0)::text AS services_monthly,
       GREATEST(COALESCE(c.calls, 0), COALESCE(u.calls_events, 0))::text AS calls_count,
       COALESCE(u.internet_events, 0)::text AS internet_events,
       ROUND(COALESCE(u.internet_bytes, 0) / 1000000.0, 2)::text AS internet_mb,
       COALESCE(u.sms_events, 0)::text AS sms_count,
       COALESCE(u.periodic_amount, 0)::text AS stmt_periodic_amount,
       nm.last_usage_at::text
     FROM mts_business_number_map nm
     LEFT JOIN fee_snap f ON f.msisdn_hash = nm.msisdn_hash
     LEFT JOIN plan_snap p ON p.msisdn_hash = nm.msisdn_hash
     LEFT JOIN services_sum ss ON ss.msisdn_hash = nm.msisdn_hash
     LEFT JOIN usage u ON u.msisdn_hash = nm.msisdn_hash
     LEFT JOIN cdr c ON c.msisdn_hash = nm.msisdn_hash
     LEFT JOIN employees e ON e.id = nm.employee_id
     LEFT JOIN org_departments od ON od.id = e.org_department_id
     LEFT JOIN mts_business_accounts a ON a.id = nm.account_id
     WHERE COALESCE(f.fee_amount, 0) > 0
       AND COALESCE(c.calls, 0) = 0
       AND COALESCE(u.calls_events, 0) = 0
       AND COALESCE(u.sms_events, 0) = 0
       AND COALESCE(u.internet_events, 0) = 0
     ORDER BY COALESCE(f.fee_amount, 0) DESC,
              e.full_name NULLS LAST,
              nm.mts_fio NULLS LAST`,
  );

  console.log(`Найдено номеров без связи с абонплатой: ${rows.length}`);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'FOT';
  wb.created = new Date();

  const ws = wb.addWorksheet('Без связи, с абонплатой');
  ws.columns = [
    { header: 'ФИО МТС', key: 'mtsFio', width: 36 },
    { header: 'Сотрудник ФОТ', key: 'employeeName', width: 36 },
    { header: 'Таб. №', key: 'tabNumber', width: 12 },
    { header: 'Подразделение', key: 'department', width: 28 },
    { header: 'Номер телефона', key: 'msisdn', width: 18 },
    { header: 'Звонки, шт', key: 'calls', width: 12 },
    { header: 'Интернет, событий', key: 'internetEvents', width: 16 },
    { header: 'Интернет, МБ', key: 'internetMb', width: 14 },
    { header: 'СМС, шт', key: 'sms', width: 10 },
    { header: 'Тариф', key: 'tariff', width: 28 },
    { header: 'Абонплата, руб/мес', key: 'fee', width: 18 },
    { header: 'Услуги, руб/мес', key: 'services', width: 16 },
    { header: 'Абонплата в выписке, руб', key: 'periodic', width: 22 },
    { header: 'Комментарий МТС', key: 'mtsComment', width: 28 },
    { header: 'Аккаунт', key: 'account', width: 24 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell(cell => {
    cell.border = thinBorder;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
  });

  const zeroFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2F0E4' } };

  let feeTotal = 0;
  for (const r of rows) {
    const msisdn = encryptionService.decryptField(r.msisdn_enc);
    const fee = r.fee_amount != null ? Number(r.fee_amount) : 0;
    feeTotal += fee;
    const row = ws.addRow({
      mtsFio: r.mts_fio ?? '',
      employeeName: r.employee_full_name ?? '',
      tabNumber: r.tab_number ?? '',
      department: r.department_name ?? '',
      msisdn: msisdn ?? '',
      calls: Number(r.calls_count),
      internetEvents: Number(r.internet_events),
      internetMb: Number(r.internet_mb),
      sms: Number(r.sms_count),
      tariff: r.tariff_name ?? '',
      fee,
      services: r.services_monthly != null ? Number(r.services_monthly) : 0,
      periodic: r.stmt_periodic_amount != null ? Number(r.stmt_periodic_amount) : 0,
      mtsComment: r.mts_comment ?? '',
      account: r.account_label ?? '',
    });
    for (const col of [6, 7, 8, 9]) {
      const cell = row.getCell(col);
      cell.fill = zeroFill;
      cell.alignment = { horizontal: 'center' };
      cell.font = { bold: true };
    }
  }

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell(cell => {
      cell.border = thinBorder;
    });
  });

  const summary = wb.addWorksheet('Сводка');
  summary.columns = [
    { header: 'Показатель', key: 'k', width: 40 },
    { header: 'Значение', key: 'v', width: 20 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.addRow({ k: 'Номеров без использования связи', v: rows.length });
  summary.addRow({ k: 'Сумма абонплаты, руб/мес', v: Math.round(feeTotal * 100) / 100 });
  summary.addRow({ k: 'Критерий', v: 'Абонплата > 0; нет CDR; нет calls/sms/internet в выписке' });
  summary.addRow({ k: 'Дата выгрузки', v: new Date().toISOString() });

  await wb.xlsx.writeFile(outPath);
  console.log(`Сумма абонплаты: ${Math.round(feeTotal * 100) / 100} руб/мес`);
  console.log(`Файл: ${outPath}`);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
