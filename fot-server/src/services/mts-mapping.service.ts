import { query, queryOne, execute } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import type { IMtsSubscriber } from './mts-data.service.js';

// Привязка абонента МТС -> сотрудник FOT. ПДн (phone, display_name) хранятся
// зашифрованными. Авто-подсказка — по нормализованному ФИО (employees.full_name
// plain-text; phone-колонки в employees нет).

export interface IMtsMappingRow {
  subscriberId: number;
  employeeId: number | null;
  phone: string | null;
  displayName: string | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  linkedAt: string | null;
}

export interface IMtsMappingSuggestion {
  subscriberId: number;
  subscriberName: string | null;
  employeeId: number;
  employeeFullName: string;
}

const normalizeName = (s: string | null | undefined): string =>
  (s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/ё/g, 'е');

export const mtsMappingService = {
  async listMappings(): Promise<IMtsMappingRow[]> {
    const rows = await query<{
      subscriber_id: number;
      employee_id: number | null;
      phone_enc: string | null;
      display_name_enc: string | null;
      employee_full_name: string | null;
      employee_tab_number: string | null;
      linked_at: string | null;
    }>(
      `SELECT m.subscriber_id, m.employee_id, m.phone_enc, m.display_name_enc,
              e.full_name AS employee_full_name, e.tab_number AS employee_tab_number,
              m.linked_at
         FROM mts_subscriber_map m
         LEFT JOIN employees e ON e.id = m.employee_id
        ORDER BY m.subscriber_id`,
    );

    return rows.map(r => ({
      subscriberId: r.subscriber_id,
      employeeId: r.employee_id,
      phone: encryptionService.decryptField(r.phone_enc),
      displayName: encryptionService.decryptField(r.display_name_enc),
      employeeFullName: r.employee_full_name,
      employeeTabNumber: r.employee_tab_number,
      linkedAt: r.linked_at,
    }));
  },

  /** Создать/обновить привязку. phone/displayName шифруются перед записью. */
  async setMapping(
    subscriberId: number,
    employeeId: number | null,
    meta: { phone?: string | null; displayName?: string | null },
    userId: string,
  ): Promise<void> {
    await execute(
      `INSERT INTO mts_subscriber_map
         (subscriber_id, employee_id, phone_enc, display_name_enc, linked_by, linked_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (subscriber_id) DO UPDATE SET
         employee_id = EXCLUDED.employee_id,
         phone_enc = COALESCE(EXCLUDED.phone_enc, mts_subscriber_map.phone_enc),
         display_name_enc = COALESCE(EXCLUDED.display_name_enc, mts_subscriber_map.display_name_enc),
         linked_by = EXCLUDED.linked_by,
         linked_at = NOW(),
         updated_at = NOW()`,
      [
        subscriberId,
        employeeId,
        encryptionService.encryptField(meta.phone ?? null),
        encryptionService.encryptField(meta.displayName ?? null),
        userId,
      ],
    );
  },

  /** Подсказки привязки по уникальному совпадению ФИО абонента и сотрудника. */
  async suggest(subscribers: IMtsSubscriber[]): Promise<IMtsMappingSuggestion[]> {
    const employees = await query<{ id: number; full_name: string }>(
      `SELECT id, full_name FROM employees
        WHERE is_archived = false AND full_name IS NOT NULL AND full_name <> ''`,
    );

    const byName = new Map<string, { id: number; full_name: string } | null>();
    for (const e of employees) {
      const key = normalizeName(e.full_name);
      if (!key) continue;
      byName.set(key, byName.has(key) ? null : { id: e.id, full_name: e.full_name });
    }

    const mapped = await query<{ subscriber_id: number }>(
      'SELECT subscriber_id FROM mts_subscriber_map WHERE employee_id IS NOT NULL',
    );
    const alreadyMapped = new Set(mapped.map(m => m.subscriber_id));

    const suggestions: IMtsMappingSuggestion[] = [];
    for (const s of subscribers) {
      if (alreadyMapped.has(s.subscriberID)) continue;
      const match = byName.get(normalizeName(s.name));
      if (match) {
        suggestions.push({
          subscriberId: s.subscriberID,
          subscriberName: s.name,
          employeeId: match.id,
          employeeFullName: match.full_name,
        });
      }
    }
    return suggestions;
  },

  async employeeExists(employeeId: number): Promise<boolean> {
    const row = await queryOne<{ id: number }>('SELECT id FROM employees WHERE id = $1', [employeeId]);
    return row !== null;
  },

  /** Внутренний employee_id для абонента (для IDOR-проверки). */
  async getEmployeeIdBySubscriber(subscriberId: number): Promise<number | null> {
    const row = await queryOne<{ employee_id: number | null }>(
      'SELECT employee_id FROM mts_subscriber_map WHERE subscriber_id = $1',
      [subscriberId],
    );
    return row?.employee_id ?? null;
  },
};
