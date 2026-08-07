/**
 * Разведка признаков поколения пропуска (READ-ONLY, статистический отчёт).
 *
 * Отвечает на один вопрос: есть ли в данных Sigur поле, которое реально различает
 * физический тип пластика (белый старого образца / красный нового), а не способ
 * оформления карты.
 *
 * ВАЖНО: ничего из того, что печатает этот скрипт, само по себе НЕ даёт права гасить
 * карту. Любое найденное разделение групп — корреляция. Право на блокировку даёт только
 * внешнее подтверждение идентичности конкретной карты (confirmation-файл).
 *
 * Запуск:
 *   cd fot-server && npx tsx scripts/diagnose-card-eras.ts
 *   ... --sample=40   — сколько профилей опросить поштучно для поиска полей
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import type { ICardRow } from '../src/services/old-card-block.collect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
}

const OUT_DIR = path.resolve(__dirname, '../temp');

/** Группа сравнения — НЕ утверждение о цвете, а способ оформления карты. */
type Group = 'pool' | 'reader' | 'module_only' | 'outside_module';

const GROUP_TITLE: Record<Group, string> = {
  pool: 'Пул ФОТ (профиль FOT-POOL) — оформлена новым порядком',
  reader: 'Считана ридером (card_hex_uid) — оформлена новым порядком',
  module_only: 'Есть в модуле пропусков, но без ридера',
  outside_module: 'Вне модуля пропусков — способ оформления неизвестен',
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sampleSize = Number((argv.find(a => a.startsWith('--sample=')) ?? '--sample=40').split('=')[1]);

  console.log('=== Разведка признаков поколения пропуска (READ-ONLY) ===');
  console.log('Ничто из напечатанного ниже не даёт права гасить карту.\n');

  const collect = await import('../src/services/old-card-block.collect.js');
  const util = await import('../src/services/old-card-block.util.js');
  const { sigurService } = await import('../src/services/sigur.service.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');
  const { normalizeInt } = await import('../src/services/sigur-live-admin.service.js');

  const state = await collect.collectLiveState({ requireRootless: false });

  // ── Группировка по способу оформления ────────────────────────────────────────────
  const groupOf = (row: ICardRow): Group => {
    const employee = state.employees.get(row.sigurEmployeeId);
    if (util.hasFotPoolNote(employee?.note)) return 'pool';
    if (row.passHexUid) return 'reader';
    if (row.passNumber) return 'module_only';
    return 'outside_module';
  };

  const byGroup = new Map<Group, ICardRow[]>();
  for (const row of state.rows) {
    const group = groupOf(row);
    const list = byGroup.get(group) ?? [];
    list.push(row);
    byGroup.set(group, list);
  }

  console.log('── Группы по способу оформления ──');
  for (const group of Object.keys(GROUP_TITLE) as Group[]) {
    console.log(`  ${GROUP_TITLE[group]}: ${(byGroup.get(group) ?? []).length}`);
  }

  // ── 1.1 Поиск дискриминатора: полные поля профиля и карты ────────────────────────
  console.log(`\n── Опрос полей: по ${sampleSize} профилей из каждой группы ──`);

  interface IFieldStat { field: string; byGroup: Map<Group, Map<string, number>> }
  const employeeFields = new Map<string, IFieldStat>();
  const cardFields = new Map<string, IFieldStat>();

  const record = (store: Map<string, IFieldStat>, field: string, group: Group, value: unknown): void => {
    const printable = value === null || value === undefined
      ? '(пусто)'
      : typeof value === 'object' ? JSON.stringify(value).slice(0, 60) : String(value);
    const stat = store.get(field) ?? { field, byGroup: new Map<Group, Map<string, number>>() };
    const groupStat = stat.byGroup.get(group) ?? new Map<string, number>();
    groupStat.set(printable, (groupStat.get(printable) ?? 0) + 1);
    stat.byGroup.set(group, groupStat);
    store.set(field, stat);
  };

  const rawCards = await sigurService.getCardsCached(state.connection);
  const rawCardById = new Map<number, Record<string, unknown>>();
  for (const raw of rawCards) {
    const cardId = normalizeInt(resolveField(raw, 'id', 'ID', 'cardId', 'card_id'));
    if (cardId) rawCardById.set(cardId, raw);
  }

  for (const group of Object.keys(GROUP_TITLE) as Group[]) {
    const rows = (byGroup.get(group) ?? []).slice(0, sampleSize);
    for (const row of rows) {
      // Поля карты — из каталога, без дополнительных запросов.
      const rawCard = rawCardById.get(row.cardId);
      if (rawCard) for (const [key, value] of Object.entries(rawCard)) record(cardFields, key, group, value);

      // Поля профиля — поштучный GET, здесь и может обнаружиться шаблон пропуска.
      try {
        const profile = await sigurService.getEmployeeById(row.sigurEmployeeId, state.connection) as Record<string, unknown>;
        for (const [key, value] of Object.entries(profile)) {
          if (key === 'photo' || key === 'image') continue;
          record(employeeFields, key, group, value);
        }
      } catch {
        record(employeeFields, '(ошибка запроса профиля)', group, true);
      }
    }
    console.log(`  ${group}: опрошено ${rows.length}`);
  }

  /** Поле-кандидат: значения в группе pool не пересекаются со значениями outside_module. */
  const findDiscriminators = (store: Map<string, IFieldStat>): string[] => {
    const result: string[] = [];
    for (const stat of store.values()) {
      const poolValues = new Set((stat.byGroup.get('pool') ?? new Map()).keys());
      const outsideValues = new Set((stat.byGroup.get('outside_module') ?? new Map()).keys());
      if (poolValues.size === 0 || outsideValues.size === 0) continue;
      // Игнорируем заведомо уникальные поля (id, номер, даты) — они различаются всегда.
      if (poolValues.size > 5 && outsideValues.size > 5) continue;
      const overlap = [...poolValues].filter(value => outsideValues.has(value));
      if (overlap.length === 0) result.push(stat.field);
    }
    return result;
  };

  const employeeCandidates = findDiscriminators(employeeFields);
  const cardCandidates = findDiscriminators(cardFields);

  console.log('\n── Поля-кандидаты (значения пула и «вне модуля» не пересекаются) ──');
  console.log(`  профиль: ${employeeCandidates.join(', ') || 'нет'}`);
  console.log(`  карта:   ${cardCandidates.join(', ') || 'нет'}`);
  if (employeeCandidates.length === 0 && cardCandidates.length === 0) {
    console.log('  → поля, различающего тип пластика, в данных Sigur не найдено');
  } else {
    console.log('  → кандидаты найдены, но это КОРРЕЛЯЦИЯ. Требуется документальное');
    console.log('    подтверждение или физическая сверка карт по каждому значению.');
  }

  console.log('\n── Все поля профиля Sigur ──');
  console.log(`  ${[...employeeFields.keys()].join(', ')}`);
  console.log('── Все поля карты Sigur ──');
  console.log(`  ${[...cardFields.keys()].join(', ')}`);

  // ── 1.2 Статистика эпох (справочно) ──────────────────────────────────────────────
  const firstObserved = new Map<Group, string | null>();
  for (const group of Object.keys(GROUP_TITLE) as Group[]) {
    const dates = (byGroup.get(group) ?? [])
      .map(row => row.startDate)
      .filter((value): value is string => !!value)
      .sort();
    firstObserved.set(group, dates[0] ?? null);
  }

  console.log('\n── FIRST_OBSERVED_NEW_PROCESS_BINDING (наблюдение, не начало эпохи) ──');
  for (const group of Object.keys(GROUP_TITLE) as Group[]) {
    console.log(`  ${group}: ${firstObserved.get(group) ?? '—'}`);
  }
  console.log('  ВНИМАНИЕ: самая ранняя запись нового порядка НЕ доказывает, что красных');
  console.log('  карт раньше не существовало. startDate к тому же изменяем (PATCH привязки).');

  const monthHist = new Map<string, Map<Group, number>>();
  for (const group of Object.keys(GROUP_TITLE) as Group[]) {
    for (const row of byGroup.get(group) ?? []) {
      const month = row.startDate ? row.startDate.slice(0, 7) : '(нет даты)';
      const cell = monthHist.get(month) ?? new Map<Group, number>();
      cell.set(group, (cell.get(group) ?? 0) + 1);
      monthHist.set(month, cell);
    }
  }
  console.log('\n── Привязки по месяцам (pool / reader / module_only / outside) ──');
  for (const month of [...monthHist.keys()].sort()) {
    const cell = monthHist.get(month)!;
    console.log(`  ${month}: ${cell.get('pool') ?? 0} / ${cell.get('reader') ?? 0} / `
      + `${cell.get('module_only') ?? 0} / ${cell.get('outside_module') ?? 0}`);
  }

  // ── Excel ────────────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const xlsxPath = path.join(OUT_DIR, `card-eras-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
  await writeWorkbook(xlsxPath, {
    state,
    byGroup,
    employeeFields,
    cardFields,
    employeeCandidates,
    cardCandidates,
    monthHist,
    firstObserved,
  });
  console.log(`\nExcel: ${xlsxPath}`);
  console.log('\nНапоминание: этот отчёт НЕ является confirmation-файлом и не даёт права гасить карты.');

  async function writeWorkbook(filePath: string, data: {
    state: typeof state;
    byGroup: Map<Group, ICardRow[]>;
    employeeFields: Map<string, IFieldStat>;
    cardFields: Map<string, IFieldStat>;
    employeeCandidates: string[];
    cardCandidates: string[];
    monthHist: Map<string, Map<Group, number>>;
    firstObserved: Map<Group, string | null>;
  }): Promise<void> {
    const workbook = new ExcelJS.Workbook();

    const warn = workbook.addWorksheet('ВНИМАНИЕ');
    warn.columns = [{ header: 'Предупреждение', key: 'text', width: 110 }];
    warn.getRow(1).font = { bold: true };
    for (const text of [
      'Это статистический отчёт разведки. Он НЕ доказывает цвет пластика.',
      'Любое разделение групп ниже — корреляция со способом оформления карты, а не с типом заготовки.',
      'Файл не является confirmation-файлом: в нём нет полей подтверждения, и валидацию он не пройдёт.',
      'Право гасить карту даёт только внешнее подтверждение идентичности конкретной карты.',
    ]) warn.addRow({ text });

    const fieldsSheet = workbook.addWorksheet('Поля и значения');
    fieldsSheet.columns = [
      { header: 'Источник', key: 'source', width: 12 },
      { header: 'Поле', key: 'field', width: 26 },
      { header: 'Кандидат', key: 'candidate', width: 11 },
      { header: 'Группа', key: 'group', width: 18 },
      { header: 'Значение', key: 'value', width: 44 },
      { header: 'Сколько', key: 'count', width: 10 },
    ];
    fieldsSheet.getRow(1).font = { bold: true };
    const dump = (source: string, store: Map<string, IFieldStat>, candidates: string[]): void => {
      for (const stat of store.values()) {
        for (const [group, values] of stat.byGroup) {
          for (const [value, count] of values) {
            fieldsSheet.addRow({
              source,
              field: stat.field,
              candidate: candidates.includes(stat.field) ? 'да' : '',
              group,
              value,
              count,
            });
          }
        }
      }
    };
    dump('профиль', data.employeeFields, data.employeeCandidates);
    dump('карта', data.cardFields, data.cardCandidates);

    const monthSheet = workbook.addWorksheet('Привязки по месяцам');
    monthSheet.columns = [
      { header: 'Месяц', key: 'month', width: 14 },
      { header: 'pool', key: 'pool', width: 10 },
      { header: 'reader', key: 'reader', width: 10 },
      { header: 'module_only', key: 'module', width: 13 },
      { header: 'outside_module', key: 'outside', width: 15 },
    ];
    monthSheet.getRow(1).font = { bold: true };
    for (const month of [...data.monthHist.keys()].sort()) {
      const cell = data.monthHist.get(month)!;
      monthSheet.addRow({
        month,
        pool: cell.get('pool') ?? 0,
        reader: cell.get('reader') ?? 0,
        module: cell.get('module_only') ?? 0,
        outside: cell.get('outside_module') ?? 0,
      });
    }

    const facilitySheet = workbook.addWorksheet('По facility');
    facilitySheet.columns = [
      { header: 'facility', key: 'facility', width: 10 },
      { header: 'Карт', key: 'cards', width: 9 },
      { header: 'Номера от', key: 'min', width: 12 },
      { header: 'Номера до', key: 'max', width: 12 },
      { header: 'Привязки с', key: 'from', width: 24 },
      { header: 'Привязки по', key: 'to', width: 24 },
      { header: 'pool', key: 'pool', width: 8 },
      { header: 'reader', key: 'reader', width: 9 },
      { header: 'в модуле', key: 'module', width: 11 },
      { header: 'вне модуля', key: 'outside', width: 12 },
    ];
    facilitySheet.getRow(1).font = { bold: true };
    const byFacility = new Map<string, ICardRow[]>();
    for (const row of data.state.rows) {
      const key = row.facility === null ? '(нет)' : String(row.facility);
      const list = byFacility.get(key) ?? [];
      list.push(row);
      byFacility.set(key, list);
    }
    for (const [facility, list] of [...byFacility.entries()].sort((l, r) => r[1].length - l[1].length)) {
      const numbers = list
        .map(row => Number((row.w26 ?? '').split(',')[1]))
        .filter(value => Number.isFinite(value))
        .sort((l, r) => l - r);
      const dates = list.map(row => row.startDate).filter((v): v is string => !!v).sort();
      facilitySheet.addRow({
        facility,
        cards: list.length,
        min: numbers[0] ?? '',
        max: numbers[numbers.length - 1] ?? '',
        from: dates[0] ?? '',
        to: dates[dates.length - 1] ?? '',
        pool: list.filter(row => groupOf(row) === 'pool').length,
        reader: list.filter(row => groupOf(row) === 'reader').length,
        module: list.filter(row => groupOf(row) === 'module_only').length,
        outside: list.filter(row => groupOf(row) === 'outside_module').length,
      });
    }

    await workbook.xlsx.writeFile(filePath);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const err = error as Error;
    console.error('\nОшибка:', err?.stack ?? err?.message ?? error);
    process.exit(1);
  });
