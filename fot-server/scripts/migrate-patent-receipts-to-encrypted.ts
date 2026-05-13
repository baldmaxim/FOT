/**
 * Одноразовый скрипт: шифрует существующие plain-записи patent_payment_receipts.
 * Идемпотентен — encryptIfPlain в helper'е пропускает уже зашифрованные значения.
 *
 * Запуск: cd fot-server && npx tsx scripts/migrate-patent-receipts-to-encrypted.ts
 *
 * Перед запуском должна быть применена миграция 066 (raw_response JSONB → TEXT),
 * иначе INSERT шифр-текста в jsonb колонку упадёт.
 */
import { query, execute } from '../src/config/postgres.js';
import {
  encryptReceiptFields,
  encryptRawResponse,
  ENCRYPTED_FIELDS,
} from '../src/services/patent-receipt-encryption.helper.js';

const SELECT_COLUMNS = ['id', 'raw_response', ...ENCRYPTED_FIELDS].join(', ');

const main = async (): Promise<void> => {
  const rows = await query<Record<string, unknown> & { id: number; raw_response: unknown }>(
    `SELECT ${SELECT_COLUMNS} FROM patent_payment_receipts`,
  );

  console.log(`[migrate] всего записей: ${rows.length}`);

  let updated = 0;
  for (const row of rows) {
    const { id, raw_response, ...fields } = row;
    const encryptedFields = encryptReceiptFields(fields);
    const encryptedRaw = encryptRawResponse(raw_response);

    const setClauses: string[] = [];
    const params: unknown[] = [];
    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    for (const [key, value] of Object.entries(encryptedFields)) {
      // Allowlist: ключи получены из ENCRYPTED_FIELDS (статический список).
      if (!ENCRYPTED_FIELDS.includes(key as (typeof ENCRYPTED_FIELDS)[number])) continue;
      setClauses.push(`${key} = ${addParam(value)}`);
    }
    setClauses.push(`raw_response = ${addParam(encryptedRaw)}`);

    if (setClauses.length === 0) continue;
    const idPlaceholder = addParam(id);

    try {
      await execute(
        `UPDATE patent_payment_receipts SET ${setClauses.join(', ')} WHERE id = ${idPlaceholder}`,
        params,
      );
      updated += 1;
      console.log(`[migrate] id=${id} OK`);
    } catch (err) {
      console.error(`[migrate] id=${id} ошибка:`, (err as Error).message);
      continue;
    }
  }

  console.log(`[migrate] готово, обновлено ${updated}/${rows.length}`);
};

main().catch(err => {
  console.error('[migrate] упал:', err);
  process.exit(1);
});
