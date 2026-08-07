/**
 * Инвентаризация карт подрядных сотрудников Sigur (READ-ONLY).
 *
 * Ничего не пишет — ни в Sigur, ни в БД. Собирает полный срез «сотрудник → карта» по
 * всему дереву Sigur, классифицирует поколение каждой карты и выгружает xlsx + JSON.
 * JSON затем скармливается scripts/block-contractor-old-cards.ts.
 *
 * Сбор и классификация живут в src/services/old-card-block.collect.ts — общем модуле
 * с боевым скриптом, чтобы denylist при apply не разошёлся с тем, что видно в Excel.
 *
 * Запуск (локально, БД и Sigur — прод):
 *   cd fot-server && npx tsx scripts/inventory-contractor-cards.ts
 *
 * Подключение к прод-БД — по приёму из [[reference_prod_db_local_diagnostics]].
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
// Только типы — при выполнении такой импорт стирается, порядок настройки env не нарушается.
import type { ICardRow } from '../src/services/old-card-block.collect.js';
import type { CardGeneration, ScopeBucket } from '../src/services/old-card-block.util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Готовим env ДО импорта app-модулей (они тянут env.ts с dotenv).
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

const LOCAL_CA = path.resolve(__dirname, '../../.migration/yandex-ca.pem');
if (fs.existsSync(LOCAL_CA)) {
  process.env.NODE_ENV = 'test';
  const envFile = parseEnvLastWins(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
  const rawUrl = envFile.DATABASE_URL;
  if (!rawUrl) {
    console.error('DATABASE_URL не найден в fot-server/.env');
    process.exit(1);
  }
  try {
    const url = new URL(rawUrl);
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) url.searchParams.delete(key);
    process.env.DATABASE_URL = url.toString();
  } catch {
    process.env.DATABASE_URL = rawUrl;
  }
  process.env.DATABASE_SSL = 'true';
  process.env.DATABASE_SSL_CA_PATH = LOCAL_CA;
  const debugUrl = new URL(process.env.DATABASE_URL);
  console.error('[debug] db host:', debugUrl.hostname, 'db:', debugUrl.pathname);
}

const OUT_DIR = path.resolve(__dirname, '../temp');

async function main(): Promise<void> {
  console.log('=== Инвентаризация карт подрядных сотрудников Sigur (READ-ONLY) ===\n');

  const collect = await import('../src/services/old-card-block.collect.js');
  const util = await import('../src/services/old-card-block.util.js');

  // requireRootless=false: инвентаризация должна отработать даже при недоступной полной
  // выгрузке — просто пометит rootlessComplete=false, и apply запретит --scope=rootless.
  const state = await collect.collectLiveState({ requireRootless: false });
  const rows = state.rows;

  const countBy = <T>(items: readonly ICardRow[], pick: (row: ICardRow) => T, value: T): number =>
    items.filter(row => pick(row) === value).length;

  const bucket = (value: ScopeBucket): number => countBy(rows, row => row.scopeBucket, value);
  const generation = (value: CardGeneration): number => countBy(rows, row => row.generation, value);

  console.log('');
  console.log(`[итог] карт: подрядчики ${bucket('contractors')}, корень ${bucket('rootless')}, `
    + `исключено ${bucket('excluded')}, аномалии ${bucket('anomaly')}`);
  console.log(`[итог] поколения: confirmed_white ${generation('confirmed_white')}, `
    + `module_linked ${generation('module_linked')}, not_proven_new ${generation('not_proven_new')}, `
    + `unknown ${generation('unknown')}`);
  if (!state.rootlessComplete) {
    console.warn('[внимание] полная выгрузка сотрудников не удалась — корневые люди неполны, '
      + 'боевой прогон с --scope=rootless будет запрещён');
  }
  console.log('');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `inventory-${stamp}.json`);
  const xlsxPath = path.join(OUT_DIR, `inventory-${stamp}.xlsx`);

  const payload = {
    kind: 'contractor-card-inventory',
    createdAt: new Date().toISOString(),
    connection: state.connection,
    inventoryComplete: true,
    rootlessComplete: state.rootlessComplete,
    failedDepartmentIds: state.failedDepartmentIds,
    contractorSigurId: state.contractorSigurId,
    controlNodes: state.controlNodes,
    employeesWithNewCard: [...state.employeesWithNewCard].sort((left, right) => left - right),
    duplicateCardIds: [...state.duplicateCardIds].sort((left, right) => left - right),
    cards: rows.map(row => ({
      cardId: row.cardId,
      sigurEmployeeId: row.sigurEmployeeId,
      employeeName: row.employeeName,
      orgName: row.orgName,
      departmentId: row.departmentId,
      scopeBucket: row.scopeBucket,
      generation: row.generation,
      value: row.value,
      w26: row.w26,
      facility: row.facility,
      format: row.format,
      startDate: row.startDate,
      expirationDate: row.expirationDate,
    })),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  await writeWorkbook(xlsxPath, rows, state.employeesWithNewCard, util.hasFotPoolNote);

  console.log(`JSON:  ${jsonPath}`);
  console.log(`Excel: ${xlsxPath}\n`);
  console.log('Дальше:');
  console.log('  1) npx tsx scripts/build-white-confirmation.ts   — файл подтверждений');
  console.log('  2) npx tsx scripts/block-contractor-old-cards.ts \\');
  console.log(`       --input=${jsonPath} --confirmations=<white-confirmation-*.tsv>`);
  console.log('Без --confirmations к гашению будет 0 карт: право гасить даёт только подтверждение.');
}

async function writeWorkbook(
  filePath: string,
  rows: readonly ICardRow[],
  newCardEmployees: ReadonlySet<number>,
  hasFotPoolNote: (note: string | null | undefined) => boolean,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();

  const columns: Partial<ExcelJS.Column>[] = [
    { header: 'Ветка', key: 'topLevel', width: 26 },
    { header: 'Скоуп', key: 'scopeBucket', width: 13 },
    { header: 'Организация/отдел', key: 'orgName', width: 30 },
    { header: 'sigurEmployeeId', key: 'sigurEmployeeId', width: 16 },
    { header: 'ФИО', key: 'employeeName', width: 34 },
    { header: 'Примечание профиля', key: 'note', width: 20 },
    { header: 'cardId', key: 'cardId', width: 10 },
    { header: 'value', key: 'value', width: 12 },
    { header: 'W26', key: 'w26', width: 12 },
    { header: 'facility', key: 'facility', width: 9 },
    { header: 'format', key: 'format', width: 9 },
    { header: 'Начало', key: 'startDate', width: 22 },
    { header: 'Окончание', key: 'expirationDate', width: 22 },
    { header: 'Пропуск', key: 'passNumber', width: 12 },
    { header: 'Статус пропуска', key: 'passStatus', width: 14 },
    { header: 'card_hex_uid', key: 'passHexUid', width: 20 },
    { header: 'Карт у человека', key: 'cardsPerEmployee', width: 15 },
    { header: 'Поколение', key: 'generation', width: 16 },
    { header: 'Почему', key: 'reason', width: 60 },
  ];

  const addSheet = (title: string, data: readonly ICardRow[]): void => {
    const sheet = workbook.addWorksheet(title);
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    for (const row of data) sheet.addRow(row);
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } };
  };

  addSheet('Карты', rows);

  const branchSheet = workbook.addWorksheet('По веткам');
  branchSheet.columns = [
    { header: 'Ветка', key: 'branch', width: 30 },
    { header: 'Карт', key: 'cards', width: 10 },
    { header: 'Сотрудников', key: 'employees', width: 13 },
    { header: 'module_linked', key: 'moduleLinked', width: 15 },
    { header: 'not_proven_new', key: 'notProven', width: 16 },
    { header: 'confirmed_white', key: 'confirmed', width: 16 },
    { header: 'unknown', key: 'unknown', width: 10 },
  ];
  branchSheet.getRow(1).font = { bold: true };
  const branches = new Map<string, ICardRow[]>();
  for (const row of rows) {
    const list = branches.get(row.topLevel) ?? [];
    list.push(row);
    branches.set(row.topLevel, list);
  }
  for (const [branch, list] of [...branches.entries()].sort((left, right) => right[1].length - left[1].length)) {
    branchSheet.addRow({
      branch,
      cards: list.length,
      employees: new Set(list.map(row => row.sigurEmployeeId)).size,
      moduleLinked: list.filter(row => row.generation === 'module_linked').length,
      notProven: list.filter(row => row.generation === 'not_proven_new').length,
      confirmed: list.filter(row => row.generation === 'confirmed_white').length,
      unknown: list.filter(row => row.generation === 'unknown').length,
    });
  }

  const facilitySheet = workbook.addWorksheet('По facility');
  facilitySheet.columns = [
    { header: 'facility', key: 'facility', width: 10 },
    { header: 'Карт', key: 'cards', width: 10 },
    { header: 'В скоупе', key: 'inScope', width: 12 },
    { header: 'С FOT-POOL', key: 'fotPool', width: 12 },
    { header: 'С card_hex_uid', key: 'hexUid', width: 15 },
    { header: 'Поколения', key: 'generation', width: 30 },
    { header: 'Организаций', key: 'orgs', width: 13 },
  ];
  facilitySheet.getRow(1).font = { bold: true };
  const facilities = new Map<string, ICardRow[]>();
  for (const row of rows) {
    const key = row.facility === null ? '(нет)' : String(row.facility);
    const list = facilities.get(key) ?? [];
    list.push(row);
    facilities.set(key, list);
  }
  for (const [facility, list] of [...facilities.entries()].sort((left, right) => right[1].length - left[1].length)) {
    facilitySheet.addRow({
      facility,
      cards: list.length,
      inScope: list.filter(row => row.scopeBucket === 'contractors' || row.scopeBucket === 'rootless').length,
      fotPool: list.filter(row => hasFotPoolNote(row.note)).length,
      hexUid: list.filter(row => !!row.passHexUid).length,
      generation: [...new Set(list.map(row => row.generation))].join(', '),
      orgs: new Set(list.map(row => row.orgName ?? '—')).size,
    });
  }

  const inScope = (row: ICardRow): boolean => row.scopeBucket === 'contractors' || row.scopeBucket === 'rootless';
  addSheet('Корень', rows.filter(row => row.scopeBucket === 'rootless'));
  addSheet('Две карты', rows.filter(row => row.cardsPerEmployee > 1 && inScope(row)));
  addSheet('Нераспознанные', rows.filter(row => row.generation === 'unknown'));
  addSheet('Аномалии', rows.filter(row => row.scopeBucket === 'anomaly'));
  addSheet('Есть новый пропуск', rows.filter(row => newCardEmployees.has(row.sigurEmployeeId) && inScope(row)));

  await workbook.xlsx.writeFile(filePath);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const err = error as Error;
    console.error('\nОшибка:', err?.stack ?? err?.message ?? error);
    process.exit(1);
  });
