/**
 * Номера МТС, привязанные к сотрудникам ФОТ, без использования SIM
 * (нет звонков/СМС/интернета). Группировка по отделам.
 *
 * Деньги:
 *  - «Начислено факт» — сумма расходов из выписки за текущий месяц МСК
 *    (mts_business_statement_rows / charges, без пополнений);
 *  - «Услуги по тарифу» — номинал подключённых услуг (product_services),
 *    уже включает абонплату; отдельно tariff_fee НЕ прибавляем.
 *
 * Запуск:
 *   npx tsx scripts/export-mts-unused-fot-by-dept.ts --out /tmp/mts-unused-fot-by-dept.xlsx
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
  : path.resolve(process.cwd(), `mts-unused-fot-by-dept-${new Date().toISOString().slice(0, 10)}.xlsx`);

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
const deptFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
const subtotalFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
const zeroFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2F0E4' } };
const moneyFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

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
  charges_mtd: string | null;
  stmt_mtd: string | null;
  calls_count: string;
  internet_events: string;
  internet_mb: string;
  sms_count: string;
}

interface IPreparedRow {
  department: string;
  employeeName: string;
  tabNumber: string;
  mtsFio: string;
  msisdn: string;
  calls: number;
  internetEvents: number;
  internetMb: number;
  sms: number;
  tariff: string;
  feeSnap: number;
  services: number;
  factMtd: number;
  mtsComment: string;
  account: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const styleRow = (row: ExcelJS.Row, fill?: ExcelJS.Fill, bold = false): void => {
  row.eachCell(cell => {
    cell.border = thinBorder;
    if (fill) cell.fill = fill;
    if (bold) cell.font = { bold: true };
  });
};

const UNUSED_SQL = `
WITH fee_snap AS (
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
         COALESCE(SUM(amount) FILTER (
           WHERE category NOT IN ('topups')
             AND usage_date >= date_trunc('month', (NOW() AT TIME ZONE 'Europe/Moscow'))::date
         ), 0) AS stmt_mtd
    FROM mts_business_statement_rows
   GROUP BY msisdn_hash
),
cdr AS (
  SELECT msisdn_hash, calls
    FROM mts_business_cdr_rollup
),
charges AS (
  SELECT msisdn_hash, SUM(amount) AS charges_mtd
    FROM mts_business_metric_daily
   WHERE scope = 'msisdn'
     AND metric = 'charges_amount'
     AND msisdn_hash IS NOT NULL
     AND captured_date >= date_trunc('month', (NOW() AT TIME ZONE 'Europe/Moscow'))::date
   GROUP BY msisdn_hash
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
  COALESCE(ch.charges_mtd, 0)::text AS charges_mtd,
  COALESCE(u.stmt_mtd, 0)::text AS stmt_mtd,
  GREATEST(COALESCE(c.calls, 0), COALESCE(u.calls_events, 0))::text AS calls_count,
  COALESCE(u.internet_events, 0)::text AS internet_events,
  ROUND(COALESCE(u.internet_bytes, 0) / 1000000.0, 2)::text AS internet_mb,
  COALESCE(u.sms_events, 0)::text AS sms_count
FROM mts_business_number_map nm
INNER JOIN employees e ON e.id = nm.employee_id
LEFT JOIN fee_snap f ON f.msisdn_hash = nm.msisdn_hash
LEFT JOIN plan_snap p ON p.msisdn_hash = nm.msisdn_hash
LEFT JOIN services_sum ss ON ss.msisdn_hash = nm.msisdn_hash
LEFT JOIN usage u ON u.msisdn_hash = nm.msisdn_hash
LEFT JOIN cdr c ON c.msisdn_hash = nm.msisdn_hash
LEFT JOIN charges ch ON ch.msisdn_hash = nm.msisdn_hash
LEFT JOIN org_departments od ON od.id = e.org_department_id
LEFT JOIN mts_business_accounts a ON a.id = nm.account_id
WHERE COALESCE(ss.services_monthly, 0) > 0
  AND COALESCE(c.calls, 0) = 0
  AND COALESCE(u.calls_events, 0) = 0
  AND COALESCE(u.sms_events, 0) = 0
  AND COALESCE(u.internet_events, 0) = 0
ORDER BY COALESCE(od.name, 'ЯЯЯ'), e.full_name, nm.mts_fio`;

const main = async (): Promise<void> => {
  const { query } = await import('../src/config/postgres.js');
  const { encryptionService } = await import('../src/services/encryption.service.js');

  const rows = await query<IRow>(UNUSED_SQL);

  const prepared: IPreparedRow[] = rows.map(r => {
    const feeSnap = r.fee_amount != null ? Number(r.fee_amount) : 0;
    const services = r.services_monthly != null ? Number(r.services_monthly) : 0;
    // Факт = выписка; если charges_amount больше (бывает расхождение окон) — берём максимум.
    const stmt = r.stmt_mtd != null ? Number(r.stmt_mtd) : 0;
    const charges = r.charges_mtd != null ? Number(r.charges_mtd) : 0;
    return {
      department: r.department_name?.trim() || 'Без отдела',
      employeeName: r.employee_full_name ?? '',
      tabNumber: r.tab_number ?? '',
      mtsFio: r.mts_fio ?? '',
      msisdn: encryptionService.decryptField(r.msisdn_enc) ?? '',
      calls: Number(r.calls_count),
      internetEvents: Number(r.internet_events),
      internetMb: Number(r.internet_mb),
      sms: Number(r.sms_count),
      tariff: r.tariff_name ?? '',
      feeSnap,
      services,
      factMtd: Math.max(stmt, charges),
      mtsComment: r.mts_comment ?? '',
      account: r.account_label ?? '',
    };
  });

  const byDept = new Map<string, IPreparedRow[]>();
  for (const r of prepared) {
    const list = byDept.get(r.department) ?? [];
    list.push(r);
    byDept.set(r.department, list);
  }

  const deptStats = [...byDept.entries()]
    .map(([department, list]) => ({
      department,
      numbers: list.length,
      factMtd: round2(list.reduce((a, x) => a + x.factMtd, 0)),
      services: round2(list.reduce((a, x) => a + x.services, 0)),
      feeSnap: round2(list.reduce((a, x) => a + x.feeSnap, 0)),
    }))
    .sort((a, b) => b.factMtd - a.factMtd || b.services - a.services || a.department.localeCompare(b.department, 'ru'));

  const grand = {
    numbers: prepared.length,
    factMtd: round2(prepared.reduce((a, x) => a + x.factMtd, 0)),
    services: round2(prepared.reduce((a, x) => a + x.services, 0)),
    feeSnap: round2(prepared.reduce((a, x) => a + x.feeSnap, 0)),
  };

  console.log(`Сотрудников ФОТ с неиспользуемыми SIM: ${grand.numbers}`);
  console.log(`Факт начислено (текущий месяц): ${grand.factMtd} руб`);
  console.log(`Номинал услуг (без дубля абонплаты): ${grand.services} руб/мес`);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'FOT';
  wb.created = new Date();

  const wsSummary = wb.addWorksheet('По отделам');
  wsSummary.columns = [
    { header: 'Отдел', key: 'department', width: 40 },
    { header: 'Номеров', key: 'numbers', width: 12 },
    { header: 'Начислено факт, руб (тек. мес.)', key: 'factMtd', width: 28 },
    { header: 'Услуги по тарифу, руб/мес', key: 'services', width: 26 },
    { header: 'Справка: абонплата в снимке', key: 'feeSnap', width: 26 },
  ];
  styleRow(wsSummary.getRow(1), headerFill, true);
  for (const d of deptStats) {
    const row = wsSummary.addRow(d);
    styleRow(row);
    row.getCell(3).fill = moneyFill;
    row.getCell(3).font = { bold: true };
  }
  const totalRow = wsSummary.addRow({
    department: 'ИТОГО',
    numbers: grand.numbers,
    factMtd: grand.factMtd,
    services: grand.services,
    feeSnap: grand.feeSnap,
  });
  styleRow(totalRow, subtotalFill, true);

  const wsDetail = wb.addWorksheet('Детально по отделам');
  wsDetail.columns = [
    { header: 'Отдел / сотрудник', key: 'label', width: 40 },
    { header: 'Таб. №', key: 'tabNumber', width: 12 },
    { header: 'ФИО МТС', key: 'mtsFio', width: 32 },
    { header: 'Номер', key: 'msisdn', width: 18 },
    { header: 'Звонки', key: 'calls', width: 10 },
    { header: 'Интернет', key: 'internetEvents', width: 12 },
    { header: 'Интернет, МБ', key: 'internetMb', width: 14 },
    { header: 'СМС', key: 'sms', width: 10 },
    { header: 'Тариф', key: 'tariff', width: 28 },
    { header: 'Начислено факт (тек. мес.)', key: 'factMtd', width: 24 },
    { header: 'Услуги по тарифу', key: 'services', width: 16 },
    { header: 'Справка: абонплата', key: 'feeSnap', width: 16 },
    { header: 'Комментарий МТС', key: 'mtsComment', width: 24 },
  ];
  styleRow(wsDetail.getRow(1), headerFill, true);

  for (const d of deptStats) {
    const list = byDept.get(d.department) ?? [];
    const deptHeader = wsDetail.addRow({
      label: d.department,
      tabNumber: '',
      mtsFio: '',
      msisdn: '',
      calls: '',
      internetEvents: '',
      internetMb: '',
      sms: '',
      tariff: '',
      factMtd: d.factMtd,
      services: d.services,
      feeSnap: d.feeSnap,
      mtsComment: `${d.numbers} ном.`,
    });
    styleRow(deptHeader, deptFill, true);
    deptHeader.getCell(1).font = { bold: true, size: 12 };
    deptHeader.getCell(10).fill = moneyFill;

    for (const r of list) {
      const row = wsDetail.addRow({
        label: r.employeeName,
        tabNumber: r.tabNumber,
        mtsFio: r.mtsFio,
        msisdn: r.msisdn,
        calls: r.calls,
        internetEvents: r.internetEvents,
        internetMb: r.internetMb,
        sms: r.sms,
        tariff: r.tariff,
        factMtd: r.factMtd,
        services: r.services,
        feeSnap: r.feeSnap,
        mtsComment: r.mtsComment,
      });
      styleRow(row);
      for (const col of [5, 6, 7, 8]) {
        const cell = row.getCell(col);
        cell.fill = zeroFill;
        cell.alignment = { horizontal: 'center' };
        cell.font = { bold: true };
      }
      row.getCell(10).fill = moneyFill;
      row.getCell(10).font = { bold: true };
    }
  }

  const grandRow = wsDetail.addRow({
    label: 'ИТОГО ПО КОМПАНИИ',
    tabNumber: '',
    mtsFio: '',
    msisdn: '',
    calls: '',
    internetEvents: '',
    internetMb: '',
    sms: '',
    tariff: '',
    factMtd: grand.factMtd,
    services: grand.services,
    feeSnap: grand.feeSnap,
    mtsComment: `${grand.numbers} ном.`,
  });
  styleRow(grandRow, subtotalFill, true);
  grandRow.getCell(1).font = { bold: true, size: 12 };

  const wsInfo = wb.addWorksheet('Сводка');
  wsInfo.columns = [
    { header: 'Показатель', key: 'k', width: 52 },
    { header: 'Значение', key: 'v', width: 28 },
  ];
  styleRow(wsInfo.getRow(1), headerFill, true);
  const info: Array<[string, string | number]> = [
    ['Номеров (сотрудники ФОТ, SIM не используется)', grand.numbers],
    ['Отделов', deptStats.length],
    ['Начислено факт за текущий месяц, руб', grand.factMtd],
    ['Услуги по тарифу (номинал), руб/мес', grand.services],
    ['Справка: абонплата из снимка (не суммировать с услугами)', grand.feeSnap],
    ['Критерий отбора', 'Привязка к ФОТ; услуги > 0; звонки/СМС/интернет = 0'],
    ['Что такое «факт»', 'Сумма строк выписки МТС за текущий месяц (без пополнений)'],
    ['Что такое «услуги по тарифу»', 'product_services.monthlyAmount (абонплата уже внутри, без +fee)'],
    ['Дата выгрузки', new Date().toISOString()],
  ];
  for (const [k, v] of info) {
    const row = wsInfo.addRow({ k, v });
    styleRow(row);
  }

  await wb.xlsx.writeFile(outPath);
  console.log(`Файл: ${outPath}`);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
