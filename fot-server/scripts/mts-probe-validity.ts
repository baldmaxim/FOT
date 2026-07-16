/**
 * Проба: сырой ответ Bills/ValidityInfo по номеру (READ-ONLY).
 *
 * Зачем: снимки validity_msisdn в БД содержат только unitOfMeasure, все
 * quota/remainder = null → блок «Остатки пакетов» в ЛК «Моя SIM» и карточке
 * абонента пуст. Гипотеза: значения лежат в fields=forisCounters (мы запрашиваем
 * только MOAF) либо под другими именами полей, чем ждёт parsePackages
 * (r.BQ / r.reminder / r.Consumption).
 *
 * Что делает: для номера (аргумент или автоподбор самого «свежего» по
 * last_usage_at) зовёт ValidityInfo дважды — с fields=MOAF (как сейчас) и с
 * полным набором fields из документации — и печатает сырые ответы (номер в
 * выводе маскируется; счётчики пакетов — не ПДн). Ничего не пишет в БД/МТС.
 *
 * Запуск (локально или на проде из /opt/fot-build):
 *   npx tsx fot-server/scripts/mts-probe-validity.ts [79XXXXXXXXX]
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

async function main(): Promise<void> {
  const { MtsBusinessServiceBase } = await import('../src/services/mts-business-base.service.js');
  const { encryptionService } = await import('../src/services/encryption.service.js');
  const { msisdnHash, normalizeMsisdn } = await import('../src/services/mts-business-cdr.service.js');
  const { queryOne, query } = await import('../src/config/postgres.js');

  const positional = process.argv.slice(2).find(a => !a.startsWith('--')) ?? null;
  let msisdn = normalizeMsisdn(positional);
  let accountId: string | null = null;

  if (msisdn) {
    const row = await queryOne<{ account_id: string | null }>(
      `SELECT account_id FROM mts_business_number_map WHERE msisdn_hash = $1`,
      [msisdnHash(msisdn)],
    );
    accountId = row?.account_id ?? null;
  } else {
    // Автоподбор: самый недавно активный номер с известным аккаунтом.
    const rows = await query<{ msisdn_enc: string | null; account_id: string }>(
      `SELECT msisdn_enc, account_id FROM mts_business_number_map
        WHERE account_id IS NOT NULL AND msisdn_enc IS NOT NULL AND last_usage_at IS NOT NULL
        ORDER BY last_usage_at DESC LIMIT 5`,
    );
    for (const r of rows) {
      const dec = encryptionService.decryptField(r.msisdn_enc);
      if (dec) {
        msisdn = normalizeMsisdn(dec);
        accountId = r.account_id;
        break;
      }
    }
  }
  if (!msisdn || !accountId) {
    console.error('Не удалось определить номер/аккаунт (передай msisdn аргументом)');
    process.exit(1);
  }
  const masked = `${msisdn.slice(0, 4)}***${msisdn.slice(-3)}`;
  console.log(`Номер: ${masked}, account=${accountId}`);

  class ProbeClient extends MtsBusinessServiceBase {
    raw(endpoint: string, params: Record<string, unknown>, accId: string): Promise<unknown> {
      return this.request<unknown>('get', endpoint, { accountId: accId, params, timeout: 30_000 });
    }
  }
  const client = new ProbeClient();

  // --live: прогнать боевой парсер (mtsBusinessBillingService.getValidityInfo)
  // по нескольким активным номерам и напечатать результат как он ляжет в снимок.
  if (process.argv.includes('--live')) {
    const { mtsBusinessBillingService } = await import('../src/services/mts-business-billing.service.js');
    const rows = await query<{ msisdn_enc: string | null; account_id: string }>(
      `SELECT msisdn_enc, account_id FROM mts_business_number_map
        WHERE account_id IS NOT NULL AND msisdn_enc IS NOT NULL AND last_usage_at IS NOT NULL
        ORDER BY last_usage_at DESC LIMIT 3`,
    );
    for (const r of rows) {
      const m = normalizeMsisdn(encryptionService.decryptField(r.msisdn_enc));
      if (!m) continue;
      const parsed = await mtsBusinessBillingService.getValidityInfo(r.account_id, m);
      console.log(`\n${m.slice(0, 4)}***${m.slice(-3)}:`, JSON.stringify(parsed, null, 2));
    }
    process.exit(0);
  }

  // --scan=N: компактная сводка счётчиков по N самым активным номерам —
  // ищем, у кого CurrentValue > 0 и какие вообще valueType встречаются.
  const scanFlag = process.argv.find(a => a.startsWith('--scan='));
  if (scanFlag) {
    const n = Math.min(30, Number(scanFlag.slice(7)) || 10);
    const rows = await query<{ msisdn_enc: string | null; account_id: string }>(
      `SELECT msisdn_enc, account_id FROM mts_business_number_map
        WHERE account_id IS NOT NULL AND msisdn_enc IS NOT NULL AND last_usage_at IS NOT NULL
        ORDER BY last_usage_at DESC LIMIT $1`,
      [n],
    );
    const valueTypes = new Map<string, Set<string>>();
    for (const r of rows) {
      const m = normalizeMsisdn(encryptionService.decryptField(r.msisdn_enc));
      if (!m) continue;
      const mm = `${m.slice(0, 4)}***${m.slice(-3)}`;
      try {
        const resp = await client.raw('/Bills/ValidityInfo', {
          'customerAccount.accountNo': m,
          'customerAccount.productRelationship.product.productLine.name': 'Counters',
          fields: 'MOAF,forisCounters,h2oProfile,ReturnServices,ReturnAutoExtention',
        }, r.account_id);
        // Обход: каждый узел с productSpecification — счётчик.
        const stack: unknown[] = [resp];
        const lines: string[] = [];
        while (stack.length) {
          const node = stack.pop();
          if (Array.isArray(node)) { stack.push(...node); continue; }
          if (!node || typeof node !== 'object') continue;
          const o = node as Record<string, unknown>;
          const spec = o.productSpecification as Record<string, unknown> | undefined;
          if (spec?.name) {
            const unit = ((o.productPrice as Array<Record<string, unknown>> | undefined)?.[0]?.unitOfMeasure as string) ?? '?';
            const pairs: string[] = [];
            const chars = (spec.productSpecCharacteristic as unknown[]) ?? [];
            for (const c of chars) {
              const vals = ((c as Record<string, unknown>).prodSpecCharacteristicValue as Array<Record<string, unknown>>) ?? [];
              for (const v of vals) {
                if (v.valueType != null) {
                  pairs.push(`${v.valueType}=${v.value ?? '-'}`);
                  const set = valueTypes.get(String(v.valueType)) ?? new Set<string>();
                  set.add(String(v.value ?? '-'));
                  valueTypes.set(String(v.valueType), set);
                }
              }
            }
            lines.push(`  [${unit}] ${spec.id ?? '?'} «${spec.name}» :: ${pairs.join(', ')}`);
          }
          for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
        }
        const nonZero = lines.filter(l => /=(?!0(?:,|$))\d/.test(l));
        console.log(`\n--- ${mm} (счётчиков: ${lines.length}, ненулевых: ${nonZero.length}) ---`);
        for (const l of (nonZero.length ? nonZero : lines.slice(0, 4))) console.log(l);
      } catch (e) {
        console.log(`\n--- ${mm} — ошибка: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log('\n===== Все встреченные valueType (до 8 примеров значений) =====');
    for (const [vt, vals] of valueTypes) console.log(`  ${vt}: ${[...vals].slice(0, 8).join(' | ')}`);
    process.exit(0);
  }

  const variants: Array<[string, string]> = [
    ['как сейчас (MOAF)', 'MOAF'],
    ['полный набор из доки', 'MOAF,forisCounters,h2oProfile,ReturnServices,ReturnAutoExtention'],
    ['только forisCounters', 'forisCounters'],
  ];
  for (const [label, fields] of variants) {
    console.log(`\n===== ValidityInfo fields=${fields} (${label}) =====`);
    try {
      const resp = await client.raw('/Bills/ValidityInfo', {
        'customerAccount.accountNo': msisdn,
        'customerAccount.productRelationship.product.productLine.name': 'Counters',
        fields,
      }, accountId);
      console.log(JSON.stringify(resp, null, 2).replaceAll(msisdn, masked).slice(0, 12_000));
    } catch (e) {
      console.error('Ошибка:', e instanceof Error ? e.message : e);
    }
  }
  process.exit(0);
}

void main().catch(e => {
  console.error(e);
  process.exit(1);
});
