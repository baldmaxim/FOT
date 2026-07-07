import { execute, query, queryOne } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { mtsBusinessCdrService, msisdnHash, normalizeMsisdn, type ISimName } from './mts-business-cdr.service.js';

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
  mtsComment: string | null;
  pdStatus: string | null;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  accountId: string | null;
}

export interface IMtsSubscriberContext {
  accountId: string;
  accountNo: string | null;
  fio: string | null;
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
   * Известные номера: объединение инвентаря number_map (HierarchyStructure,
   * XML-имена, ручные привязки) и агрегата CDR. Раньше источником были ТОЛЬКО
   * загруженные CDR — номера, найденные через структуру абонента, не попадали
   * ни в пикер детализации, ни в таблицу привязок (bootstrap-тупик: без
   * детализации нет номеров, без номеров не запросить детализацию). Номер без
   * звонков отдаётся с calls=0. Если account_id не определён, а активный
   * аккаунт один — подставляем его (та же эвристика, что getSubscriberContext).
   */
  async getImportedNumbers(): Promise<IMtsBusinessImportedNumberRow[]> {
    const rows = await query<{
      msisdn_enc: string | null;
      calls: string;
      total_sec: string;
      last_call_at: string | null;
      mts_fio: string | null;
      mts_comment: string | null;
      pd_status: string | null;
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
      account_id: string | null;
    }>(
      `WITH cdr AS (
         SELECT msisdn_hash,
                MIN(msisdn_enc) AS msisdn_enc,
                COUNT(*) AS calls,
                COALESCE(SUM(duration_sec), 0) AS total_sec,
                MAX(started_at) AS last_call_at,
                MAX(account_id::text) AS account_id
           FROM mts_business_cdr
          WHERE msisdn_hash IS NOT NULL
          GROUP BY msisdn_hash
       )
       SELECT COALESCE(m.msisdn_enc, c.msisdn_enc) AS msisdn_enc,
              COALESCE(c.calls, 0)::text AS calls,
              COALESCE(c.total_sec, 0)::text AS total_sec,
              c.last_call_at,
              COALESCE(m.account_id::text, c.account_id) AS account_id,
              m.mts_fio,
              m.mts_comment,
              m.pd_status,
              m.employee_id,
              e.full_name,
              e.tab_number
         FROM mts_business_number_map m
         FULL OUTER JOIN cdr c ON c.msisdn_hash = m.msisdn_hash
         LEFT JOIN employees e ON e.id = m.employee_id
        ORDER BY COALESCE(c.total_sec, 0) DESC, m.linked_at DESC NULLS LAST`,
    );

    let fallbackAccountId: string | null = null;
    if (rows.some(r => r.account_id == null)) {
      const active = await query<{ id: string }>(`SELECT id FROM mts_business_accounts WHERE is_active`);
      if (active.length === 1) fallbackAccountId = active[0].id;
    }

    return rows.map(r => ({
      msisdn: encryptionService.decryptField(r.msisdn_enc),
      calls: Number(r.calls),
      totalSeconds: Number(r.total_sec),
      lastCallAt: r.last_call_at,
      mtsFio: r.mts_fio,
      mtsComment: r.mts_comment,
      pdStatus: r.pd_status,
      employeeId: r.employee_id,
      employeeFullName: r.full_name,
      employeeTabNumber: r.tab_number,
      accountId: r.account_id ?? fallbackAccountId,
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

      const targetId = await this.resolveEmployeeIdByFio(fioClean);
      if (targetId === null) continue;

      const updated = await execute(
        `UPDATE mts_business_number_map
            SET employee_id = $2, linked_by = $3, linked_at = NOW()
          WHERE msisdn_hash = $1 AND employee_id IS NULL`,
        [hash, targetId, userId],
      );
      autoLinked += updated;
    }
    return { saved, autoLinked };
  }

  /**
   * Комментарии номеров из ЛК МТС (Service/GetCommentsByMSISDN) → mts_comment.
   * Fallback-заметка для идентификации номера, когда PersonalData пуст (админ в
   * ЛК часто подписывает номер «Иванов Иван / отдел»). employee_id/mts_fio не
   * трогаем — комментарий не юридическое ФИО, автопривязку по нему не делаем.
   */
  async syncMtsComments(
    pairs: Array<{ msisdn: string; comment: string }>,
    accountId: string | null,
  ): Promise<{ saved: number }> {
    let saved = 0;
    for (const { msisdn, comment } of pairs) {
      const hash = msisdnHash(msisdn);
      const norm = normalizeMsisdn(msisdn);
      if (!hash || !norm) continue;
      const clean = comment.replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      await execute(
        `INSERT INTO mts_business_number_map (msisdn_hash, msisdn_enc, account_id, mts_comment, linked_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (msisdn_hash) DO UPDATE
           SET mts_comment = EXCLUDED.mts_comment,
               msisdn_enc = COALESCE(mts_business_number_map.msisdn_enc, EXCLUDED.msisdn_enc),
               account_id = COALESCE(mts_business_number_map.account_id, EXCLUDED.account_id)`,
        [hash, encryptionService.encrypt(norm), accountId, clean],
      );
      saved++;
    }
    return { saved };
  }

  /**
   * Кэш статуса подтверждения персданных (PersonalDataConfirmation) — для
   * бейджа «Персданные» в таблице номеров. Обновляется при каждом живом чтении
   * PersonalData/PersonalDataInfo (карточка, синк ФИО, поллер заявок).
   */
  async setPersonalDataStatus(rawMsisdn: string, status: string | null): Promise<void> {
    const hash = msisdnHash(rawMsisdn);
    const norm = normalizeMsisdn(rawMsisdn);
    if (!hash || !norm) return;
    await execute(
      `INSERT INTO mts_business_number_map (msisdn_hash, msisdn_enc, pd_status, pd_checked_at, linked_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (msisdn_hash) DO UPDATE
         SET pd_status = EXCLUDED.pd_status,
             pd_checked_at = NOW(),
             msisdn_enc = COALESCE(mts_business_number_map.msisdn_enc, EXCLUDED.msisdn_enc)`,
      [hash, encryptionService.encrypt(norm), status],
    );
  }

  /**
   * Полный ответ PersonalDataInfo (паспорт/дата рождения и пр.) — ТОЛЬКО
   * шифром (AES-256-GCM). Отдаётся наружу единственным путём — getPersonalDataBlob
   * → расшифровка в карточке абонента под гардом страницы (миграция 207).
   */
  async setPersonalDataBlob(rawMsisdn: string, ciphertext: string | null): Promise<void> {
    const hash = msisdnHash(rawMsisdn);
    if (!hash) return;
    await execute(
      `UPDATE mts_business_number_map
          SET pd_data_enc = $2, pd_synced_at = NOW()
        WHERE msisdn_hash = $1`,
      [hash, ciphertext],
    );
  }

  /** Шифртекст полного профиля ПДн (pd_data_enc) по номеру; null — если нет. */
  async getPersonalDataBlob(rawMsisdn: string): Promise<string | null> {
    const hash = msisdnHash(rawMsisdn);
    if (!hash) return null;
    const row = await queryOne<{ pd_data_enc: string | null }>(
      `SELECT pd_data_enc FROM mts_business_number_map WHERE msisdn_hash = $1`,
      [hash],
    );
    return row?.pd_data_enc ?? null;
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
      const targetId = await this.resolveEmployeeIdByFio(row.mts_fio);
      if (targetId === null) continue;
      const updated = await execute(
        `UPDATE mts_business_number_map
            SET employee_id = $2, linked_by = $3, linked_at = NOW()
          WHERE msisdn_hash = $1 AND employee_id IS NULL`,
        [row.msisdn_hash, targetId, userId],
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
   * created=true — номер заведён впервые (xmax=0 у свежевставленной строки).
   * authoritative=true — источник знает НАСТОЯЩИЙ ЛС номера (accountNo из
   * customerAccount структуры абонента) → перетираем прежний account_id;
   * иначе только доливаем, если ещё не был известен.
   */
  async ensureNumberDiscovered(
    rawMsisdn: string,
    accountId: string,
    authoritative = false,
  ): Promise<{ needsFio: boolean; created: boolean }> {
    const norm = normalizeMsisdn(rawMsisdn);
    const hash = msisdnHash(rawMsisdn);
    if (!norm || !hash) return { needsFio: false, created: false };
    const inserted = await queryOne<{ created: boolean }>(
      `INSERT INTO mts_business_number_map (msisdn_hash, msisdn_enc, account_id, linked_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (msisdn_hash) DO UPDATE
         SET account_id = CASE
           WHEN $4 THEN EXCLUDED.account_id
           ELSE COALESCE(mts_business_number_map.account_id, EXCLUDED.account_id)
         END
       RETURNING (xmax = 0) AS created`,
      [hash, encryptionService.encrypt(norm), accountId, authoritative],
    );
    const row = await queryOne<{ employee_id: number | null; mts_fio: string | null }>(
      `SELECT employee_id, mts_fio FROM mts_business_number_map WHERE msisdn_hash = $1`,
      [hash],
    );
    return { needsFio: row != null && row.employee_id == null && !row.mts_fio, created: inserted?.created === true };
  }

  /**
   * Контекст номера для карточки: аккаунт (обязателен для живых вызовов), ЛС,
   * ФИО (сотрудник → иначе mts_fio), сотрудник. account_id ищем устойчиво:
   * number_map → иначе из CDR (номер мог прийти детализацией, без
   * HierarchyStructure, тогда в number_map account_id NULL) → иначе, если
   * активный аккаунт один, берём его. null только если аккаунт вообще не
   * определить (тогда контроллер вернёт 404).
   */
  async getSubscriberContext(rawMsisdn: string): Promise<IMtsSubscriberContext | null> {
    const hash = msisdnHash(rawMsisdn);
    if (!hash) return null;

    const nm = await queryOne<{
      account_id: string | null;
      mts_fio: string | null;
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
    }>(
      `SELECT nm.account_id, nm.mts_fio, nm.employee_id, e.full_name, e.tab_number
         FROM mts_business_number_map nm
         LEFT JOIN employees e ON e.id = nm.employee_id
        WHERE nm.msisdn_hash = $1`,
      [hash],
    );

    let accountId = nm?.account_id ?? null;
    if (!accountId) {
      const cdr = await queryOne<{ account_id: string | null }>(
        `SELECT account_id FROM mts_business_cdr
          WHERE msisdn_hash = $1 AND account_id IS NOT NULL
          ORDER BY started_at DESC LIMIT 1`,
        [hash],
      );
      accountId = cdr?.account_id ?? null;
    }
    if (!accountId) {
      const active = await query<{ id: string }>(`SELECT id FROM mts_business_accounts WHERE is_active`);
      if (active.length === 1) accountId = active[0].id;
    }
    if (!accountId) return null;

    const acc = await queryOne<{ account_number: string | null }>(
      `SELECT account_number FROM mts_business_accounts WHERE id = $1`,
      [accountId],
    );

    return {
      accountId,
      accountNo: acc?.account_number ?? null,
      fio: nm?.full_name ?? nm?.mts_fio ?? null,
      employeeId: nm?.employee_id ?? null,
      employeeFullName: nm?.full_name ?? null,
      employeeTabNumber: nm?.tab_number ?? null,
    };
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
   * ВСЕ известные номера аккаунта — объединение CDR-истории и инвентаря
   * number_map (HierarchyStructure). Единый источник для CDR-планировщика,
   * синка метрик/каталога и оркестратора «Обновить всё»: номер, найденный
   * любым путём, дальше обслуживается всеми синками одинаково.
   */
  async getAllKnownMsisdnsByAccount(accountId: string): Promise<string[]> {
    const [cdrNumbers, mappedNumbers] = await Promise.all([
      mtsBusinessCdrService.getKnownMsisdnsByAccount(accountId),
      this.getKnownMsisdnsByAccount(accountId),
    ]);
    return [...new Set([...cdrNumbers, ...mappedNumbers])];
  }

  /**
   * Карта «хэш номера → имя» по всем известным номерам (сотрудник ФОТ → иначе
   * ФИО из МТС → иначе комментарий из ЛК). Используется для подписи
   * собеседников в детальной выписке: звонок «на номер» превращается в звонок
   * «конкретному абоненту», если номер есть в нашей базе.
   */
  async getNamesByMsisdnHash(): Promise<Map<string, string>> {
    const rows = await query<{ msisdn_hash: string; mts_fio: string | null; mts_comment: string | null; full_name: string | null }>(
      `SELECT nm.msisdn_hash, nm.mts_fio, nm.mts_comment, e.full_name
         FROM mts_business_number_map nm
         LEFT JOIN employees e ON e.id = nm.employee_id`,
    );
    const map = new Map<string, string>();
    for (const r of rows) {
      const name = r.full_name ?? r.mts_fio ?? r.mts_comment;
      if (name) map.set(r.msisdn_hash, name);
    }
    return map;
  }

  /**
   * Хэши номеров со свежепроверенными персданными (pd_synced_at моложе
   * maxAgeHours) — bulk-синк профилей пропускает для них PersonalDataInfo,
   * экономя rate-limit (повторный прогон в тот же день дешевле на ~N вызовов).
   */
  async getFreshPdHashes(maxAgeHours: number): Promise<Set<string>> {
    const rows = await query<{ msisdn_hash: string }>(
      `SELECT msisdn_hash FROM mts_business_number_map
        WHERE pd_synced_at IS NOT NULL AND pd_synced_at > NOW() - ($1 * INTERVAL '1 hour')`,
      [maxAgeHours],
    );
    return new Set(rows.map(r => r.msisdn_hash));
  }

  /**
   * Номера аккаунта без идентификации (нет ни сотрудника, ни ФИО из МТС) —
   * кандидаты на добор ФИО через PersonalData/PersonalDataInfo.
   */
  async getNumbersNeedingFio(accountId: string): Promise<string[]> {
    const rows = await query<{ msisdn_enc: string | null }>(
      `SELECT msisdn_enc FROM mts_business_number_map
        WHERE account_id = $1 AND msisdn_enc IS NOT NULL
          AND employee_id IS NULL AND (mts_fio IS NULL OR mts_fio = '')`,
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
