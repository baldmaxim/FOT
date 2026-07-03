import { execute, query, queryOne } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { msisdnHash, normalizeMsisdn, type ISimName } from './mts-business-cdr.service.js';

// Привязка номера телефона (MSISDN) → сотрудник FOT. Ключ — детерминированный
// хэш номера (msisdn_hash), по нему же джойнится агрегация CDR. Сам номер
// хранится зашифрованным (msisdn_enc). ПДн в открытом виде в БД не лежат.

export interface IMtsBusinessNumberMapRow {
  msisdn: string | null;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  linkedAt: string | null;
}

export interface IMtsBusinessImportedNumberRow {
  msisdn: string | null;
  calls: number;
  totalSeconds: number;
  lastCallAt: string | null;
  mtsFio: string | null;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
}

class MtsBusinessMappingService {
  async getNumberMap(): Promise<IMtsBusinessNumberMapRow[]> {
    const rows = await query<{
      msisdn_enc: string | null;
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
      linked_at: string | null;
    }>(
      `SELECT m.msisdn_enc, m.employee_id, e.full_name, e.tab_number, m.linked_at
         FROM mts_business_number_map m
         LEFT JOIN employees e ON e.id = m.employee_id
        ORDER BY m.linked_at DESC NULLS LAST`,
    );
    return rows.map(r => ({
      msisdn: encryptionService.decryptField(r.msisdn_enc),
      employeeId: r.employee_id,
      employeeFullName: r.full_name,
      employeeTabNumber: r.tab_number,
      linkedAt: r.linked_at,
    }));
  }

  /**
   * Импортированные номера: все уникальные свои номера из загруженных CDR со
   * статистикой и текущей привязкой — источник для ручной связи с сотрудником.
   */
  async getImportedNumbers(): Promise<IMtsBusinessImportedNumberRow[]> {
    const rows = await query<{
      msisdn_enc: string | null;
      calls: string;
      total_sec: string;
      last_call_at: string | null;
      mts_fio: string | null;
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
    }>(
      `SELECT MIN(c.msisdn_enc) AS msisdn_enc,
              COUNT(*)::text AS calls,
              COALESCE(SUM(c.duration_sec), 0)::text AS total_sec,
              MAX(c.started_at) AS last_call_at,
              m.mts_fio,
              m.employee_id,
              e.full_name,
              e.tab_number
         FROM mts_business_cdr c
         LEFT JOIN mts_business_number_map m ON m.msisdn_hash = c.msisdn_hash
         LEFT JOIN employees e ON e.id = m.employee_id
        WHERE c.msisdn_hash IS NOT NULL
        GROUP BY c.msisdn_hash, m.mts_fio, m.employee_id, e.full_name, e.tab_number
        ORDER BY COALESCE(SUM(c.duration_sec), 0) DESC`,
    );
    return rows.map(r => ({
      msisdn: encryptionService.decryptField(r.msisdn_enc),
      calls: Number(r.calls),
      totalSeconds: Number(r.total_sec),
      lastCallAt: r.last_call_at,
      mtsFio: r.mts_fio,
      employeeId: r.employee_id,
      employeeFullName: r.full_name,
      employeeTabNumber: r.tab_number,
    }));
  }

  /**
   * Пары «номер → ФИО» (из XML МТС или PersonalData/PersonalDataInfo): сохранить
   * ФИО в привязку и автопривязать к сотруднику при ТОЧНОМ однозначном совпадении
   * нормализованного ФИО (регистр/ё/пробелы). Ручные привязки не перетираются
   * (employee_id IS NULL). userId=null — источник не привязан к конкретному
   * админу (фоновый планировщик, а не ручное действие в UI).
   */
  async syncMtsNames(pairs: ISimName[], userId: string | null): Promise<{ saved: number; autoLinked: number }> {
    let saved = 0;
    let autoLinked = 0;
    for (const { msisdn, fio } of pairs) {
      const hash = msisdnHash(msisdn);
      const norm = normalizeMsisdn(msisdn);
      if (!hash || !norm) continue;
      const fioClean = fio.replace(/\s+/g, ' ').trim();
      if (!fioClean) continue;

      await execute(
        `INSERT INTO mts_business_number_map (msisdn_hash, msisdn_enc, mts_fio, linked_by, linked_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (msisdn_hash) DO UPDATE
           SET mts_fio = EXCLUDED.mts_fio,
               msisdn_enc = COALESCE(mts_business_number_map.msisdn_enc, EXCLUDED.msisdn_enc)`,
        [hash, encryptionService.encrypt(norm), fioClean, userId],
      );
      saved++;

      const matches = await query<{ id: number }>(
        `SELECT id FROM employees
          WHERE LOWER(REPLACE(regexp_replace(full_name, '\\s+', ' ', 'g'), 'ё', 'е'))
              = LOWER(REPLACE($1, 'ё', 'е'))
          LIMIT 2`,
        [fioClean],
      );
      if (matches.length !== 1) continue;

      const updated = await execute(
        `UPDATE mts_business_number_map
            SET employee_id = $2, linked_by = $3, linked_at = NOW()
          WHERE msisdn_hash = $1 AND employee_id IS NULL`,
        [hash, matches[0].id, userId],
      );
      autoLinked += updated;
    }
    return { saved, autoLinked };
  }

  /**
   * Пере-проверка автопривязки для уже сохранённых номеров: те, что ещё без
   * сотрудника, но уже имеют mts_fio (из прошлых XML-загрузок) — например,
   * ФИО пришло раньше, чем сотрудник появился в ФОТ, или коллизия ФИО с тех
   * пор разрешилась. Та же логика точного совпадения, что в syncMtsNames.
   */
  async autoLinkByFio(userId: string): Promise<{ checked: number; linked: number }> {
    const unlinked = await query<{ msisdn_hash: string; mts_fio: string }>(
      `SELECT msisdn_hash, mts_fio FROM mts_business_number_map
        WHERE employee_id IS NULL AND mts_fio IS NOT NULL AND mts_fio <> ''`,
    );
    let linked = 0;
    for (const row of unlinked) {
      const matches = await query<{ id: number }>(
        `SELECT id FROM employees
          WHERE LOWER(REPLACE(regexp_replace(full_name, '\\s+', ' ', 'g'), 'ё', 'е'))
              = LOWER(REPLACE($1, 'ё', 'е'))
          LIMIT 2`,
        [row.mts_fio],
      );
      if (matches.length !== 1) continue;
      const updated = await execute(
        `UPDATE mts_business_number_map
            SET employee_id = $2, linked_by = $3, linked_at = NOW()
          WHERE msisdn_hash = $1 AND employee_id IS NULL`,
        [row.msisdn_hash, matches[0].id, userId],
      );
      linked += updated;
    }
    return { checked: unlinked.length, linked };
  }

  /**
   * Завести номер в number_map без привязки к сотруднику (employee_id=NULL),
   * если его там ещё нет — источник: структура абонента (HierarchyStructure),
   * а не CDR. account_id проставляется (или доливается, если ещё не был
   * известен) — без него синк баланса/тарифа по номерам его не найдёт (см.
   * getKnownMsisdnsByAccount). ON CONFLICT не трогает employee_id/mts_fio.
   */
  async ensureNumberDiscovered(rawMsisdn: string, accountId: string): Promise<{ needsFio: boolean }> {
    const norm = normalizeMsisdn(rawMsisdn);
    const hash = msisdnHash(rawMsisdn);
    if (!norm || !hash) return { needsFio: false };
    await execute(
      `INSERT INTO mts_business_number_map (msisdn_hash, msisdn_enc, account_id, linked_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (msisdn_hash) DO UPDATE
         SET account_id = COALESCE(mts_business_number_map.account_id, EXCLUDED.account_id)`,
      [hash, encryptionService.encrypt(norm), accountId],
    );
    const row = await queryOne<{ employee_id: number | null; mts_fio: string | null }>(
      `SELECT employee_id, mts_fio FROM mts_business_number_map WHERE msisdn_hash = $1`,
      [hash],
    );
    return { needsFio: row != null && row.employee_id == null && !row.mts_fio };
  }

  /** Номера аккаунта, известные ТОЛЬКО через number_map (напр. из HierarchyStructure, без CDR-истории). */
  async getKnownMsisdnsByAccount(accountId: string): Promise<string[]> {
    const rows = await query<{ msisdn_enc: string | null }>(
      `SELECT msisdn_enc FROM mts_business_number_map WHERE account_id = $1 AND msisdn_enc IS NOT NULL`,
      [accountId],
    );
    const out: string[] = [];
    for (const r of rows) {
      const msisdn = encryptionService.decryptField(r.msisdn_enc);
      if (msisdn) out.push(msisdn);
    }
    return out;
  }

  /**
   * Привязать/переназначить номер к сотруднику. employeeId=null снимает привязку
   * (строка остаётся, но без сотрудника). Возвращает обновлённый список.
   */
  async setNumberMap(
    rawMsisdn: string,
    employeeId: number | null,
    userId: string,
  ): Promise<IMtsBusinessNumberMapRow[]> {
    const norm = normalizeMsisdn(rawMsisdn);
    const hash = msisdnHash(rawMsisdn);
    if (!norm || !hash) {
      throw new Error('МТС Бизнес: некорректный номер телефона');
    }
    if (employeeId != null) {
      const emp = await queryOne<{ id: number }>('SELECT id FROM employees WHERE id = $1', [employeeId]);
      if (!emp) throw new Error('Сотрудник не найден');
    }
    await execute(
      `INSERT INTO mts_business_number_map (msisdn_hash, msisdn_enc, employee_id, linked_by, linked_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (msisdn_hash) DO UPDATE
         SET msisdn_enc = EXCLUDED.msisdn_enc,
             employee_id = EXCLUDED.employee_id,
             linked_by = EXCLUDED.linked_by,
             linked_at = NOW()`,
      [hash, encryptionService.encrypt(norm), employeeId, userId],
    );
    return this.getNumberMap();
  }
}

export const mtsBusinessMappingService = new MtsBusinessMappingService();
