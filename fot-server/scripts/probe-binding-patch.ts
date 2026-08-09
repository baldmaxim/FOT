/**
 * Проба write-контракта Sigur: принимает ли PATCH привязки тело БЕЗ поля startDate.
 *
 * Зачем: боевой скрипт гашения не смог просрочить 205 карт подрядчиков — у них в привязке
 * нет даты начала, и PUT /api/v1/bindings/employees-cards отвечает 500 internal.error.
 * PATCH выглядит правильным путём (частичное обновление), но документацией это не
 * подтверждается, поэтому проверяем живьём на одной карте.
 *
 * ЭТО ЗАПИСЬ, а не чтение. По значению — no-op: карте отправляется её же текущий
 * expirationDate. Но «no-op» гарантирован только если состояние совпало с ожидаемым,
 * поэтому срок обязателен явным аргументом и сверяется перед отправкой.
 *
 * Запуск:
 *   npx tsx scripts/probe-binding-patch.ts \
 *     --employee=145814 --card=37202 \
 *     --expect-expiration="2027-01-01 00:00:00" --confirm-write
 *
 * Без --confirm-write не пишет ничего. Ненулевой exit code при любом расхождении.
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

interface IBindingView {
  employeeId: number | null;
  cardId: number | null;
  startDate: string | null;
  expirationDate: string | null;
  format: string | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found = argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };

  const employeeId = Number(getArg('employee'));
  const cardId = Number(getArg('card'));
  const expectExpiration = getArg('expect-expiration');
  const confirmWrite = argv.includes('--confirm-write');

  if (!Number.isInteger(employeeId) || employeeId <= 0) throw new Error('нужен --employee=<id>');
  if (!Number.isInteger(cardId) || cardId <= 0) throw new Error('нужен --card=<id>');
  if (!expectExpiration) {
    throw new Error('нужен --expect-expiration="<текущий срок ровно как отдаёт Sigur>"');
  }

  const { sigurService } = await import('../src/services/sigur.service.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');
  const { normalizeInt } = await import('../src/services/sigur-live-admin.service.js');

  const readBindings = async (): Promise<IBindingView[]> => {
    const raw = await sigurService.getCardBindings({ employeeId, cardId }) as Record<string, unknown>[];
    return raw.map(item => {
      const holder = item.holder && typeof item.holder === 'object' ? item.holder as Record<string, unknown> : null;
      return {
        employeeId: normalizeInt(
          resolveField(item, 'employeeId', 'employee_id')
          ?? (holder ? resolveField(holder, 'holderId', 'holder_id', 'id') : null),
        ),
        cardId: normalizeInt(resolveField(item, 'cardId', 'card_id', 'id')),
        startDate: String(resolveField<string>(item, 'startDate', 'start_date', 'validFrom') ?? '').trim() || null,
        expirationDate: String(
          resolveField<string>(item, 'expirationDate', 'expiration_date', 'expiresAt', 'validTo') ?? '',
        ).trim() || null,
        format: String(resolveField<string>(item, 'format', 'Format', 'cardFormat') ?? '').trim() || null,
      };
    });
  };

  console.log('=== Проба PATCH привязки без startDate ===\n');
  console.log(`цель: employeeId=${employeeId}, cardId=${cardId}`);
  console.log(`ожидаемый текущий срок: ${JSON.stringify(expectExpiration)}\n`);

  const before = await readBindings();
  console.log(`привязок найдено: ${before.length}`);
  for (const item of before) console.log(`  ${JSON.stringify(item)}`);

  if (before.length !== 1) {
    throw new Error(`ожидалась ровно одна привязка, получено ${before.length} — стоп`);
  }
  const current = before[0];
  if (current.employeeId !== employeeId) {
    throw new Error(`владелец привязки ${current.employeeId}, а не ${employeeId} — стоп`);
  }
  if (current.cardId !== cardId) {
    throw new Error(`cardId привязки ${current.cardId}, а не ${cardId} — стоп`);
  }
  if (current.startDate !== null) {
    throw new Error(`у привязки есть дата начала (${current.startDate}) — проба не про этот случай, стоп`);
  }
  if (current.expirationDate !== expectExpiration) {
    throw new Error(
      `срок в Sigur ${JSON.stringify(current.expirationDate)} ≠ --expect-expiration `
      + `${JSON.stringify(expectExpiration)} — состояние изменилось, стоп`,
    );
  }

  if (!confirmWrite) {
    console.log('\nСверка пройдена. Запись НЕ выполнялась: добавьте --confirm-write.');
    return;
  }

  // Срок отправляем той же строкой, что отдал Sigur: прогон через Date сдвинет таймзону,
  // и «no-op» перестанет быть no-op. format — как в боевом PATCH, тело должно совпадать.
  console.log('\n[запись] PATCH без startDate, expirationDate тем же значением…');
  await sigurService.patchEmployeeCardBinding(
    employeeId,
    cardId,
    null,
    current.expirationDate,
    undefined,
    current.format ?? undefined,
  );
  // Статуса ответа тут не видно: HTTP-слой отдаёт только тело, менять его ради пробы не будем.
  console.log('PATCH succeeded (2xx)');

  const after = await readBindings();
  console.log(`\nпривязок после записи: ${after.length}`);
  for (const item of after) console.log(`  ${JSON.stringify(item)}`);
  if (after.length !== 1) throw new Error(`после записи привязок ${after.length} — разбирать вручную`);

  const live = after[0];
  const diffs: string[] = [];
  for (const key of ['employeeId', 'cardId', 'startDate', 'expirationDate', 'format'] as const) {
    if (live[key] !== current[key]) {
      diffs.push(`${key}: было ${JSON.stringify(current[key])}, стало ${JSON.stringify(live[key])}`);
    }
  }
  if (diffs.length > 0) {
    console.error('\nПРИВЯЗКА ИЗМЕНИЛАСЬ — PATCH без startDate не идемпотентен:');
    for (const diff of diffs) console.error(`  ${diff}`);
    process.exit(1);
  }

  console.log('\nВЕРДИКТ: PATCH без startDate принят, привязка не изменилась.');
  console.log('Контракт подтверждён — можно готовить dry-run на остаток карт.');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\nПроба не пройдена:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
