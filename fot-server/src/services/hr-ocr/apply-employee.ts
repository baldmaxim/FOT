/**
 * Применение результата OCR к профилю существующего сотрудника: пустые поля
 * заполняются (источник 'ocr', событие ocr_apply), отличающиеся → конфликты
 * employee_hr_ocr_conflicts (значения зашифрованы) для ручного решения.
 *
 * ФИО сотрудника принадлежит employees/Sigur — из OCR не применяется и в
 * конфликты не попадает. Гражданство — только если найдено в справочнике.
 */
import type { HrOcrType } from '../../config/hr-documents.js';
import { withTransaction } from '../../config/postgres.js';
import { encryptField } from '../hr-crypto.service.js';
import { applyProfilePatch, listCitizenships, loadProfileRow, recordHistory, rowToPlainFields, type IHrProfileInput } from '../hr-profile.service.js';
import { buildOcrApplyPlan, buildProfilePatchFromOcr, FIO_FIELDS } from './apply.js';
import type { IOcrNormalized } from './normalize.js';

const EMPLOYEE_SKIP_FIELDS = [...FIO_FIELDS, 'citizenship_raw'];

export interface IApplyOutcome {
  autoFilled: string[];
  conflicts: string[];
}

export const applyOcrToEmployee = async (
  employeeId: number,
  documentId: number,
  type: HrOcrType,
  normalized: IOcrNormalized,
): Promise<IApplyOutcome> => {
  const citizenships = await listCitizenships();
  const patch = buildProfilePatchFromOcr(normalized, citizenships);
  const skip = [...EMPLOYEE_SKIP_FIELDS];
  // Иностранный паспорт/КИГ не несут русского ФИО; переводу доверяем, но ФИО всё равно владеет Sigur.
  if (type !== 'passport_rf' && type !== 'foreign_passport' && type !== 'passport_translation') skip.push('passport_type');

  return withTransaction(async client => {
    const row = await loadProfileRow(employeeId, client);
    if (!row) return { autoFilled: [], conflicts: [] };
    const current = rowToPlainFields(row);
    const plan = buildOcrApplyPlan(current as Record<string, unknown>, patch, { skipFields: skip });

    const autoFilled: string[] = [];
    if (Object.keys(plan.autoFill).length > 0) {
      const res = await applyProfilePatch(client, employeeId, plan.autoFill as IHrProfileInput, { userId: null, userName: 'Распознавание' }, 'ocr', {
        historyEvent: 'ocr_apply',
        documentId,
      });
      autoFilled.push(...res.changedFields);
    }

    const conflictFields: string[] = [];
    for (const c of plan.conflicts) {
      const cur = encryptField(c.currentValue);
      const ocr = encryptField(c.ocrValue);
      await client.query(
        `INSERT INTO employee_hr_ocr_conflicts (employee_id, document_id, field_name, current_value_enc, ocr_value_enc, key_version, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'open')
         ON CONFLICT (employee_id, document_id, field_name) DO UPDATE
           SET current_value_enc = EXCLUDED.current_value_enc, ocr_value_enc = EXCLUDED.ocr_value_enc,
               key_version = EXCLUDED.key_version, status = 'open', resolved_by = NULL, resolved_at = NULL`,
        [employeeId, documentId, c.fieldName, cur.enc, ocr.enc, cur.keyVersion],
      );
      conflictFields.push(c.fieldName);
    }
    await recordHistory(client, employeeId, 'ocr_run', {
      changedFields: [...autoFilled, ...conflictFields.map(f => `conflict:${f}`)],
      documentId,
      actor: { userId: null, userName: 'Распознавание' },
      source: 'ocr',
    });
    return { autoFilled, conflicts: conflictFields };
  });
};
