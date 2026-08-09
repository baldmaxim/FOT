/**
 * READ-ONLY проба живой сверки карты перед гашением.
 *
 * Повторяет ровно тот участок боевого скрипта, на котором 09.08.2026 встали все 1620
 * операций: поиск карты в каталоге Sigur → вывод идентичности → verifyConfirmedIdentity.
 * Пишущих режимов здесь нет в принципе, только GET-запросы.
 *
 * Запуск:
 *   cd fot-server && npx tsx scripts/probe-card-identity.ts \
 *     --confirmations=temp/white-confirmation-<ts>.tsv --limit=5
 *   ... --card-ids=15318,38046   — проверить конкретные карты вместо первых N
 *
 * Exit code 1 при любом вердикте, отличном от ok: проба должна ломаться заметно.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
  if (rawUrl) {
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
}

/** Вердикты пробы поверх verifyConfirmedIdentity — состояния, до которых сверка не доходит. */
type ProbeVerdict =
  | 'ok'
  | 'card_lookup_failed'
  | 'card_not_found'
  | 'identity_underivable'
  | 'binding_gone'
  | 'binding_ambiguous'
  | string;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found = argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };

  const confirmationsPath = getArg('confirmations');
  if (!confirmationsPath) throw new Error('нужен --confirmations=<файл подтверждений>');
  const limit = Number(getArg('limit') ?? '5');
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit должен быть целым > 0');
  const cardIdsRaw = getArg('card-ids');
  const cardIdFilter = cardIdsRaw
    ? new Set(cardIdsRaw.split(',').map(part => Number(part.trim())).filter(Number.isFinite))
    : null;

  const util = await import('../src/services/old-card-block.util.js');
  const { sigurService } = await import('../src/services/sigur.service.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');
  const { normalizeInt } = await import('../src/services/sigur-live-admin.service.js');

  const describeError = (error: unknown): string => {
    if (!(error instanceof Error)) return String(error);
    const frame = (error.stack ?? '').split('\n').map(line => line.trim()).find(line => line.startsWith('at '));
    return `${error.name}: ${error.message}${frame ? ` (${frame})` : ''}`;
  };

  console.log('=== Проба идентичности карт (READ-ONLY) ===\n');

  const parsed = util.parseConfirmationFile(fs.readFileSync(confirmationsPath, 'utf8'));
  if (parsed.errors.length > 0) {
    console.error('confirmation-файл не прошёл валидацию:');
    for (const error of parsed.errors.slice(0, 10)) console.error(`  ${error}`);
    process.exit(1);
  }
  const selected = cardIdFilter
    ? parsed.entries.filter(entry => cardIdFilter.has(entry.cardId))
    : parsed.entries.slice(0, limit);
  console.log(`подтверждений в файле: ${parsed.entries.length}, проверяем: ${selected.length}\n`);

  const verdicts: Record<string, number> = {};
  const bump = (key: string): void => { verdicts[key] = (verdicts[key] ?? 0) + 1; };

  for (const entry of selected) {
    const label = `card=${entry.cardId} emp=${entry.employeeId}`;
    console.log(`── ${label} — подтверждено как value=${entry.value} w26=${entry.w26} format=${entry.format}`);

    let found: Awaited<ReturnType<typeof sigurService.findCardByCandidates>>;
    try {
      found = await sigurService.findCardByCandidates([entry.value, entry.w26]);
    } catch (error) {
      console.log(`   вердикт: card_lookup_failed — ${describeError(error)}\n`);
      bump('card_lookup_failed');
      continue;
    }
    console.log(`   поиск: tried=${JSON.stringify(found.tried)}, матчей=${found.matches.length}`);

    const exact = found.matches.find(
      raw => normalizeInt(resolveField(raw, 'id', 'ID', 'cardId', 'card_id')) === entry.cardId,
    );
    if (!exact) {
      console.log(`   вердикт: card_not_found — среди матчей нет карты с cardId=${entry.cardId}\n`);
      bump('card_not_found');
      continue;
    }
    const catalogValue = resolveField(exact, 'value', 'cardValue', 'card_value') ?? null;
    const catalogFormatted = resolveField(exact, 'formattedValue', 'formatted_value') ?? null;
    const catalogFormat = resolveField(exact, 'format', 'Format', 'cardFormat') ?? null;
    console.log(
      `   каталог: value=${JSON.stringify(catalogValue)},`
      + ` formattedValue=${JSON.stringify(catalogFormatted)},`
      + ` format(catalog)=${JSON.stringify(catalogFormat)}`,
    );

    // Владельца берём по cardId БЕЗ фильтра по employeeId: фильтр по старому владельцу
    // при перепривязке вернёт пусто и замаскирует смену держателя.
    let bindings: Record<string, unknown>[];
    try {
      bindings = await sigurService.getCardBindings({ cardId: entry.cardId }) as Record<string, unknown>[];
    } catch (error) {
      console.log(`   вердикт: card_lookup_failed — привязки: ${describeError(error)}\n`);
      bump('card_lookup_failed');
      continue;
    }
    const owners = new Set<number>();
    const bindingFormats = new Set<string>();
    for (const raw of bindings) {
      const holder = raw.holder && typeof raw.holder === 'object' ? raw.holder as Record<string, unknown> : null;
      const owner = normalizeInt(
        resolveField(raw, 'employeeId', 'employee_id')
        ?? (holder ? resolveField(holder, 'holderId', 'holder_id', 'id') : null),
      );
      if (owner) owners.add(owner);
      const format = String(resolveField<string>(raw, 'format', 'Format', 'cardFormat') ?? '').trim();
      if (format) bindingFormats.add(format);
    }
    console.log(
      `   привязки: ${bindings.length}, владельцы=${JSON.stringify([...owners])},`
      + ` format(binding)=${JSON.stringify([...bindingFormats])}`,
    );
    if (bindings.length === 0 || owners.size === 0) {
      console.log('   вердикт: binding_gone — привязки карты нет\n');
      bump('binding_gone');
      continue;
    }
    if (owners.size > 1 || bindingFormats.size > 1) {
      console.log('   вердикт: binding_ambiguous — несколько владельцев/форматов, первую запись не берём\n');
      bump('binding_ambiguous');
      continue;
    }

    const [owner] = [...owners];
    const [bindingFormat] = bindingFormats.size === 1 ? [...bindingFormats] : [null];
    // Та же функция, что и в боевом скрипте: format каталога с фолбэком на format привязки.
    const liveIdentity = util.buildLiveCardIdentity(exact, entry.cardId, owner, bindingFormat);
    if (!liveIdentity) {
      console.log('   вердикт: identity_underivable — W26 не выводится ни из value, ни из formattedValue\n');
      bump('identity_underivable');
      continue;
    }
    console.log(
      `   live: value=${JSON.stringify(liveIdentity.value)}, w26=${JSON.stringify(liveIdentity.w26)},`
      + ` format(effective)=${JSON.stringify(liveIdentity.format)}, employeeId=${liveIdentity.employeeId}`,
    );

    const verdict: ProbeVerdict = util.verifyConfirmedIdentity(entry, liveIdentity);
    console.log(`   вердикт: ${verdict}\n`);
    bump(verdict);
  }

  console.log('── Сводка ──');
  for (const [key, count] of Object.entries(verdicts).sort((left, right) => right[1] - left[1])) {
    console.log(`  ${key}: ${count}`);
  }
  const failed = Object.entries(verdicts)
    .filter(([key]) => key !== 'ok')
    .reduce((sum, [, count]) => sum + count, 0);
  if (failed > 0) {
    console.error(`\nне-ok вердиктов: ${failed} — до боевого прогона разбираться с ними`);
    process.exit(1);
  }
  console.log('\nвсе проверенные карты сверяются как ok');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Ошибка пробы:', error);
    process.exit(1);
  });
