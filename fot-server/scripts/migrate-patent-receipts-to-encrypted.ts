/**
 * Одноразовый скрипт: шифрует существующие plain-записи patent_payment_receipts.
 * Идемпотентен — encryptIfPlain в helper'е пропускает уже зашифрованные значения.
 *
 * Запуск: cd fot-server && npx tsx scripts/migrate-patent-receipts-to-encrypted.ts
 *
 * Перед запуском должна быть применена миграция 066 (raw_response JSONB → TEXT),
 * иначе INSERT шифр-текста в jsonb колонку упадёт.
 */
import { supabase } from '../src/config/database.js';
import {
  encryptReceiptFields,
  encryptRawResponse,
  ENCRYPTED_FIELDS,
} from '../src/services/patent-receipt-encryption.helper.js';

const SELECT_COLUMNS = ['id', 'raw_response', ...ENCRYPTED_FIELDS].join(', ');

const main = async (): Promise<void> => {
  const { data, error } = await supabase
    .from('patent_payment_receipts')
    .select(SELECT_COLUMNS);

  if (error) throw error;

  const rows = (data || []) as Array<Record<string, unknown> & { id: number; raw_response: unknown }>;
  console.log(`[migrate] всего записей: ${rows.length}`);

  let updated = 0;
  for (const row of rows) {
    const { id, raw_response, ...fields } = row;
    const encryptedFields = encryptReceiptFields(fields);
    const encryptedRaw = encryptRawResponse(raw_response);

    const update = { ...encryptedFields, raw_response: encryptedRaw };

    const { error: upErr } = await supabase
      .from('patent_payment_receipts')
      .update(update)
      .eq('id', id);

    if (upErr) {
      console.error(`[migrate] id=${id} ошибка:`, upErr);
      continue;
    }
    updated += 1;
    console.log(`[migrate] id=${id} OK`);
  }

  console.log(`[migrate] готово, обновлено ${updated}/${rows.length}`);
};

main().catch(err => {
  console.error('[migrate] упал:', err);
  process.exit(1);
});
