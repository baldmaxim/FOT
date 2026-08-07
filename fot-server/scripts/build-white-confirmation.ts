/**
 * Генератор confirmation-файла: список карт, подтверждённых как белые старого образца.
 *
 * READ-ONLY: ничего не пишет в Sigur и БД, только формирует файл на диске.
 *
 * ОСНОВАНИЕ (подтверждено владельцем процесса 07.08.2026):
 *   «Красные пропуска с индивидуальным номером выдаются ТОЛЬКО через модуль
 *    "Пропуска подрядчиков" (пул ФОТ, профили "Пропуск N")».
 *
 * Отсюда строгий логический вывод: карта, не связанная с модулем НИКАК, красной быть
 * не может. Обратное неверно — в модуль вносили и белые карты при миграции, поэтому
 * любая связь с модулем (профиль FOT-POOL, запись в contractor_passes, оформление через
 * ридер) исключает карту из подтверждения. Это консервативно: часть белых останется
 * непогашенной, но ни одна красная не попадёт под гашение.
 *
 * Запуск:
 *   cd fot-server && npx tsx scripts/build-white-confirmation.ts
 *   ... --scope=contractors        — только подрядчики, без корневых
 *   ... --out=temp/white.tsv       — путь файла
 *
 * Результат нужно просмотреть глазами, прежде чем скармливать block-скрипту.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ICardRow } from '../src/services/old-card-block.collect.js';
import type { IConfirmationEntry } from '../src/services/old-card-block.util.js';

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

/** Формулировка правила попадает в каждую строку файла — чтобы источник не потерялся. */
const OWNER_RULE_SOURCE = 'Владелец процесса: красные выдаются только через модуль «Пропуска подрядчиков» (подтверждено 2026-08-07)';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found = argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };
  const scopeRaw = getArg('scope') ?? 'contractors,rootless';
  const scope = new Set(scopeRaw.split(',').map(part => part.trim()).filter(Boolean));
  const acceptUnresolvedRaw = getArg('accept-unresolved');

  console.log('=== Сборка confirmation-файла (READ-ONLY) ===');
  console.log(`Основание: ${OWNER_RULE_SOURCE}`);
  console.log(`Скоуп: ${[...scope].join(',')}\n`);

  // ── Fail-closed по неразрешённым удалениям ───────────────────────────────────────
  // Часть удалённых пропусков не имеет связи «номер → профиль» в аудите. Отсутствие
  // следа НЕ доказывает, что профиль удалён: переименованный в ФИО профиль с красной
  // картой так не находится. Принять этот остаток может только человек — явным числом.
  const blacklistPath = path.resolve(OUT_DIR, 'deleted-passes-blacklist.json');
  if (!fs.existsSync(blacklistPath)) {
    throw new Error('Сначала выполните: npx tsx scripts/diagnose-deleted-passes.ts');
  }
  const blacklist = JSON.parse(fs.readFileSync(blacklistPath, 'utf8')) as {
    entries: Array<{ passNumber: string; verdict: string; note: string }>;
  };
  const unresolvedNoLink = blacklist.entries.filter(
    entry => entry.verdict === 'unresolved_no_trace' && !entry.note.includes('из аудита'),
  );
  if (unresolvedNoLink.length > 0) {
    console.log(`── Неразрешённые удаления: ${unresolvedNoLink.length} ──`);
    console.log(`  номера: ${unresolvedNoLink.map(entry => entry.passNumber).join(', ')}`);
    console.log('  У этих пропусков нет связи «номер → профиль» в аудите. Следов в Sigur не найдено,');
    console.log('  но это НЕ доказывает удаление профиля: переименованный в ФИО профиль не ищется.');
    if (acceptUnresolvedRaw === null) {
      throw new Error(
        `Стоп. Чтобы принять этот остаток осознанно, запустите с флагом `
        + `'--accept-unresolved=${unresolvedNoLink.length}'`,
      );
    }
    if (Number(acceptUnresolvedRaw) !== unresolvedNoLink.length) {
      throw new Error(
        `--accept-unresolved=${acceptUnresolvedRaw} не совпадает с фактическим числом `
        + `${unresolvedNoLink.length} — проверьте разбор удалений заново`,
      );
    }
    console.log(`  Принято флагом --accept-unresolved=${unresolvedNoLink.length}.\n`);
  }

  const collect = await import('../src/services/old-card-block.collect.js');
  const util = await import('../src/services/old-card-block.util.js');

  const state = await collect.collectLiveState({ requireRootless: scope.has('rootless') });

  const stats = {
    total: state.rows.length,
    outOfScope: 0,
    excludedBranch: 0,
    moduleLinked: 0,
    unknownCard: 0,
    moduleFacilityBatch: 0,
    duplicateCard: 0,
    confirmed: 0,
  };

  const confirmedAt = new Date().toISOString();
  const entries: IConfirmationEntry[] = [];
  const included: ICardRow[] = [];

  for (const row of state.rows) {
    if (!scope.has(row.scopeBucket)) { stats.outOfScope += 1; continue; }
    // Карты исключённых веток не подтверждаем никогда — даже если они вне модуля.
    if (state.excludedBranchCardIds.has(row.cardId)) { stats.excludedBranch += 1; continue; }
    // Любая связь с модулем — карта может быть красной, подтверждать нельзя.
    if (state.denylist.has(row.cardId)) { stats.moduleLinked += 1; continue; }
    const facts = state.cardFactsById.get(row.cardId);
    if (!facts || !facts.value || !facts.w26) { stats.unknownCard += 1; continue; }
    const link = facts.moduleLink;
    if (link.poolProfile || link.poolPlaceholderName || link.inPassModule
      || link.employeeHasPassRow || link.readerIssued || link.deletedPassTrace) {
      stats.moduleLinked += 1;
      continue;
    }
    // Партия однородна: если facility засветился в модуле, вся партия потенциально красная.
    if (link.moduleFacilityBatch) { stats.moduleFacilityBatch += 1; continue; }
    // Карта, встреченная в нескольких привязках, — неоднозначность, подтверждать нельзя.
    if (state.duplicateCardIds.has(row.cardId)) { stats.duplicateCard += 1; continue; }

    entries.push({
      cardId: row.cardId,
      value: facts.value,
      w26: facts.w26,
      format: row.format ?? 'W26',
      employeeId: row.sigurEmployeeId,
      confirmationType: 'owner_rule',
      source: OWNER_RULE_SOURCE,
      confirmedAt,
    });
    included.push(row);
    stats.confirmed += 1;
  }

  console.log('── Отбор ──');
  console.log(`  всего привязок: ${stats.total}`);
  console.log(`  вне выбранного скоупа: ${stats.outOfScope}`);
  console.log(`  карты СУ-10 / СМ / аномалий: ${stats.excludedBranch}`);
  console.log(`  связаны с модулем (могут быть красными): ${stats.moduleLinked}`);
  console.log(`  карта не в каталоге / битый W26: ${stats.unknownCard}`);
  console.log(`  партия facility засвечена в модуле: ${stats.moduleFacilityBatch}`);
  console.log(`  неоднозначные (карта в нескольких привязках): ${stats.duplicateCard}`);
  console.log(`\n  ПОДТВЕРЖДЕНО КАК БЕЛЫЕ: ${stats.confirmed}`);

  const byBucket = new Map<string, number>();
  const byOrg = new Map<string, number>();
  for (const row of included) {
    byBucket.set(row.scopeBucket, (byBucket.get(row.scopeBucket) ?? 0) + 1);
    const org = row.scopeBucket === 'rootless' ? '(корень, вне папок)' : row.orgName ?? '—';
    byOrg.set(org, (byOrg.get(org) ?? 0) + 1);
  }
  console.log('\n── По скоупу ──');
  for (const [bucket, count] of byBucket) console.log(`  ${bucket}: ${count}`);
  console.log('\n── По организациям (топ-15) ──');
  for (const [org, count] of [...byOrg.entries()].sort((l, r) => r[1] - l[1]).slice(0, 15)) {
    console.log(`  ${org}: ${count}`);
  }

  if (entries.length === 0) {
    console.log('\nПодтверждать нечего — файл не создан.');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = getArg('out')
    ?? path.join(OUT_DIR, `white-confirmation-${new Date().toISOString().replace(/[:.]/g, '-')}.tsv`);

  const lines = [
    util.CONFIRMATION_HEADER.join('\t'),
    ...entries.map(entry => [
      entry.cardId,
      entry.value,
      entry.w26,
      entry.format,
      entry.employeeId,
      entry.confirmationType,
      entry.source,
      entry.confirmedAt,
    ].join('\t')),
  ];
  const content = `${lines.join('\n')}\n`;
  fs.writeFileSync(outPath, content, 'utf8');

  // Самопроверка: файл обязан пройти ту же валидацию, что и при боевом прогоне.
  const validation = util.parseConfirmationFile(content);
  if (validation.errors.length > 0) {
    console.error('\nСгенерированный файл не прошёл собственную валидацию:');
    for (const error of validation.errors.slice(0, 10)) console.error(`  • ${error}`);
    throw new Error('генератор произвёл некорректный файл');
  }

  console.log(`\nФайл: ${outPath}`);
  console.log(`SHA-256: ${util.sha256(content)}`);
  console.log(`Записей: ${validation.entries.length} (валидация пройдена)`);
  console.log('\nДальше — dry-run гашения:');
  console.log(`  npx tsx scripts/block-contractor-old-cards.ts --input=<inventory.json> --confirmations=${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const err = error as Error;
    console.error('\nОшибка:', err?.stack ?? err?.message ?? error);
    process.exit(1);
  });
