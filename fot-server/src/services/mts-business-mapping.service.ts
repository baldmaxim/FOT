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

/** Изменение ФИО из МТС (old≠new, первичное заполнение — не изменение). */
export interface IMtsFioChange {
  msisdn: string;
  oldFio: string;
  newFio: string;
  linkedEmployeeId: number | null;
}

/** Изменение комментария номера из ЛК МТС. */
export interface IMtsCommentChange {
  msisdn: string;
  oldComment: string;
  newComment: string;
}

/** Строка «Телефонной книги» в ЛК: только номер + ФИО/должность/отдел. */
export interface IPhonebookRow {
  msisdn: string | null;
  employeeId: number;
  fullName: string;
  positionName: string | null;
  departmentName: string | null;
}

export interface IAutoLinkConflict {
  msisdn: string; // расшифрованный номер — для показа и ручной привязки
  mtsFio: string;
  currentEmployeeId: number | null;
  currentEmployeeName: string | null;
  reason: 'ambiguous' | 'no_match';
  candidates: Array<{ id: number; fullName: string; tabNumber: string | null }>;
}

export interface IAutoLinkResult {
  checked: number; // просмотрено строк с mts_fio
  linked: number; // впервые привязано (было NULL)
  relinked: number; // исправлена несовпадающая привязка
  cleared: number; // снята заведомо чужая привязка (ушло в конфликты)
  conflicts: IAutoLinkConflict[];
}

/** Нормализация ФИО для сравнения: регистр, ё→е, схлопывание пробелов. */
const normFio = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

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
   * Однозначный сотрудник ФОТ по нормализованному ФИО (регистр/ё/пробелы).
   * Ровно одно совпадение → он. Несколько → предпочитаем единственного
   * активного (не уволен, не архив); если активных не ровно один — null
   * (неоднозначно, оставляем ручной привязке). Дубль-«уволенный» больше
   * не ломает автосвязь при живой активной записи.
   */
  private async resolveEmployeeIdByFio(fio: string): Promise<number | null> {
    const matches = await query<{ id: number; employment_status: string | null; is_archived: boolean }>(
      `SELECT id, employment_status, is_archived FROM employees
        WHERE LOWER(REPLACE(regexp_replace(full_name, '\\s+', ' ', 'g'), 'ё', 'е'))
            = LOWER(REPLACE($1, 'ё', 'е'))`,
      [fio],
    );
    if (matches.length === 1) return matches[0].id;
    if (matches.length === 0) return null;
    const active = matches.filter((m) => m.employment_status !== 'fired' && !m.is_archived);
    return active.length === 1 ? active[0].id : null;
  }

  /**
   * Пары «номер → ФИО» (из XML МТС или PersonalData/PersonalDataInfo): сохранить
   * ФИО в привязку и автопривязать к сотруднику при однозначном совпадении
   * нормализованного ФИО (см. resolveEmployeeIdByFio: единственное совпадение
   * либо единственный активный среди дублей с уволенными/архивными).
   * Ручные привязки не перетираются (employee_id IS NULL). userId=null —
   * источник не привязан к конкретному админу (фоновый планировщик).
   */
  async syncMtsNames(pairs: ISimName[], userId: string | null): Promise<{ saved: number; autoLinked: number; changes: IMtsFioChange[] }> {
    let saved = 0;
    let autoLinked = 0;
    const changes: IMtsFioChange[] = [];
    // Старые значения батчем — чтобы вернуть реальные изменения ФИО (старое→новое)
    // для «Лога синхронизации»; первичное заполнение (old=null) изменением не считаем.
    const hashes = pairs.map(p => msisdnHash(p.msisdn)).filter((h): h is string => !!h);
    const prev = new Map<string, { fio: string | null; employeeId: number | null }>();
    if (hashes.length > 0) {
      const rows = await query<{ msisdn_hash: string; mts_fio: string | null; employee_id: number | null }>(
        `SELECT msisdn_hash, mts_fio, employee_id FROM mts_business_number_map WHERE msisdn_hash = ANY($1)`,
        [hashes],
      );
      for (const r of rows) prev.set(r.msisdn_hash, { fio: r.mts_fio, employeeId: r.employee_id });
    }
    for (const { msisdn, fio } of pairs) {
      const hash = msisdnHash(msisdn);
      const norm = normalizeMsisdn(msisdn);
      if (!hash || !norm) continue;
      const fioClean = fio.replace(/\s+/g, ' ').trim();
      if (!fioClean) continue;

      const old = prev.get(hash);
      if (old != null && old.fio != null && old.fio !== fioClean) {
        changes.push({ msisdn: norm, oldFio: old.fio, newFio: fioClean, linkedEmployeeId: old.employeeId });
      }

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
      if (targetId == null) continue;

      const updated = await execute(
        `UPDATE mts_business_number_map
            SET employee_id = $2, linked_by = $3, linked_at = NOW()
          WHERE msisdn_hash = $1 AND employee_id IS NULL`,
        [hash, targetId, userId],
      );
      autoLinked += updated;
    }
    return { saved, autoLinked, changes };
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
  ): Promise<{ saved: number; changes: IMtsCommentChange[] }> {
    let saved = 0;
    const changes: IMtsCommentChange[] = [];
    const hashes = pairs.map(p => msisdnHash(p.msisdn)).filter((h): h is string => !!h);
    const prev = new Map<string, string | null>();
    if (hashes.length > 0) {
      const rows = await query<{ msisdn_hash: string; mts_comment: string | null }>(
        `SELECT msisdn_hash, mts_comment FROM mts_business_number_map WHERE msisdn_hash = ANY($1)`,
        [hashes],
      );
      for (const r of rows) prev.set(r.msisdn_hash, r.mts_comment);
    }
    for (const { msisdn, comment } of pairs) {
      const hash = msisdnHash(msisdn);
      const norm = normalizeMsisdn(msisdn);
      if (!hash || !norm) continue;
      const clean = comment.replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      const old = prev.get(hash);
      if (old != null && old !== clean) {
        changes.push({ msisdn: norm, oldComment: old, newComment: clean });
      }
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
    return { saved, changes };
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
  async setPersonalDataBlob(
    rawMsisdn: string,
    ciphertext: string | null,
    plainHash: string | null,
  ): Promise<{ changed: boolean }> {
    const hash = msisdnHash(rawMsisdn);
    if (!hash) return { changed: false };
    // pd_data_hash — SHA-256 канонизированного plaintext: детект «ПДн изменились»
    // без расшифровки старого блоба (AES-GCM ciphertext не сравним — случайный IV).
    // Первичное заполнение (old=null) изменением не считаем.
    const old = await queryOne<{ pd_data_hash: string | null }>(
      `SELECT pd_data_hash FROM mts_business_number_map WHERE msisdn_hash = $1`,
      [hash],
    );
    await execute(
      `UPDATE mts_business_number_map
          SET pd_data_enc = $2, pd_data_hash = $3, pd_synced_at = NOW()
        WHERE msisdn_hash = $1`,
      [hash, ciphertext, plainHash],
    );
    const changed = old?.pd_data_hash != null && plainHash != null && old.pd_data_hash !== plainHash;
    return { changed };
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
   * Пере-проверка автопривязки по ФИО для ВСЕХ номеров с mts_fio (не только
   * без сотрудника): чинит устаревшие/неверные привязки (напр. корпоративные
   * SIM, массово привязанные к держателю контракта, когда mts_fio позже
   * исправился по-номерно). Правило (см. решения в плане):
   *  - привязка совпадает с mts_fio → не трогаем (сюда попадают верные и ручные);
   *  - не совпадает / нет привязки, но ФИО даёт единственного активного → (пере)привязываем;
   *  - привязан явно чужой, а ФИО неоднозначно (0 / несколько активных) → снимаем и в конфликты;
   *  - не привязан и ФИО неоднозначно: конфликт только при однофамильцах (>1 активных), 0 совпадений — молча пропускаем.
   */
  async autoLinkByFio(userId: string): Promise<IAutoLinkResult> {
    const rows = await query<{
      msisdn_hash: string;
      msisdn_enc: string | null;
      mts_fio: string;
      employee_id: number | null;
      current_name: string | null;
    }>(
      `SELECT m.msisdn_hash, m.msisdn_enc, m.mts_fio, m.employee_id, e.full_name AS current_name
         FROM mts_business_number_map m
         LEFT JOIN employees e ON e.id = m.employee_id
        WHERE m.mts_fio IS NOT NULL AND m.mts_fio <> ''`,
    );

    let linked = 0;
    let relinked = 0;
    let cleared = 0;
    const conflicts: IAutoLinkConflict[] = [];

    for (const row of rows) {
      const consistent =
        row.employee_id != null &&
        row.current_name != null &&
        normFio(row.current_name) === normFio(row.mts_fio);
      if (consistent) continue;

      const matches = await query<{
        id: number;
        full_name: string;
        tab_number: string | null;
        employment_status: string | null;
        is_archived: boolean;
      }>(
        `SELECT id, full_name, tab_number, employment_status, is_archived FROM employees
          WHERE LOWER(REPLACE(regexp_replace(full_name, '\\s+', ' ', 'g'), 'ё', 'е'))
              = LOWER(REPLACE($1, 'ё', 'е'))`,
        [row.mts_fio],
      );
      const active = matches.filter((m) => m.employment_status !== 'fired' && !m.is_archived);
      const desiredId = active.length === 1 ? active[0].id : null;

      if (desiredId != null) {
        await execute(
          `UPDATE mts_business_number_map
              SET employee_id = $2, linked_by = $3, linked_at = NOW()
            WHERE msisdn_hash = $1`,
          [row.msisdn_hash, desiredId, userId],
        );
        if (row.employee_id == null) linked++;
        else relinked++;
        continue;
      }

      // ФИО неоднозначно (0 или несколько активных)
      const isConflict = row.employee_id != null || active.length > 1;
      if (!isConflict) continue; // не привязан и нет совпадений — не шумим

      if (row.employee_id != null) {
        await execute(
          `UPDATE mts_business_number_map
              SET employee_id = NULL, linked_by = $2, linked_at = NOW()
            WHERE msisdn_hash = $1`,
          [row.msisdn_hash, userId],
        );
        cleared++;
      }

      const msisdn = encryptionService.decryptField(row.msisdn_enc);
      if (!msisdn) continue;
      conflicts.push({
        msisdn,
        mtsFio: row.mts_fio,
        currentEmployeeId: row.employee_id,
        currentEmployeeName: row.current_name,
        reason: active.length > 1 ? 'ambiguous' : 'no_match',
        candidates: active.map((m) => ({ id: m.id, fullName: m.full_name, tabNumber: m.tab_number })),
      });
    }

    return { checked: rows.length, linked, relinked, cleared, conflicts };
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

  /** Номера, привязанные к сотруднику (ЛК «Моя SIM»). Обычно один, бывает несколько. */
  async getMsisdnsByEmployeeId(employeeId: number): Promise<string[]> {
    const rows = await query<{ msisdn_enc: string | null }>(
      `SELECT msisdn_enc FROM mts_business_number_map
        WHERE employee_id = $1 AND msisdn_enc IS NOT NULL
        ORDER BY linked_at NULLS LAST`,
      [employeeId],
    );
    const out: string[] = [];
    for (const r of rows) {
      const msisdn = encryptionService.decryptField(r.msisdn_enc);
      if (msisdn) out.push(msisdn);
    }
    return out;
  }

  /**
   * «Телефонная книга» ЛК: привязанные номера АКТИВНЫХ сотрудников (уволенные и
   * архивные исключены; их привязки в number_map остаются, но не отдаются).
   * Только номер/ФИО/должность/отдел — без mts_fio, ПДн и статистики.
   */
  async getPhonebook(): Promise<IPhonebookRow[]> {
    const rows = await query<{
      msisdn_enc: string | null;
      employee_id: number;
      full_name: string;
      position_name: string | null;
      department_name: string | null;
    }>(
      `SELECT nm.msisdn_enc,
              e.id AS employee_id,
              e.full_name,
              p.name AS position_name,
              od.name AS department_name
         FROM mts_business_number_map nm
         JOIN employees e ON e.id = nm.employee_id
         LEFT JOIN positions p ON p.id = e.position_id
         LEFT JOIN org_departments od ON od.id = e.org_department_id
        WHERE nm.msisdn_enc IS NOT NULL
          AND e.employment_status = 'active'
          AND NOT COALESCE(e.is_archived, false)
        ORDER BY e.full_name, nm.linked_at NULLS LAST`,
    );
    return rows.map(r => ({
      msisdn: encryptionService.decryptField(r.msisdn_enc),
      employeeId: r.employee_id,
      fullName: r.full_name,
      positionName: r.position_name,
      departmentName: r.department_name,
    }));
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
   * Очередь непрерывного конвейера свежести (миграция 220): номера аккаунта,
   * которым пора обновить выписку, «самый несвежий первым».
   *
   * Горячие (событие в выписке за последние activeDays) обновляются раз в
   * hotMinutes, остальные — раз в coldHours. Номера с 3+ подряд неудачами
   * (401/1014 «вне доступа», 403/1010 «не в тарифе») считаются холодными в любом
   * случае: повторы по ним бессмысленны и жгут лимит 60 запросов/мин.
   */
  async getStatementQueue(params: {
    accountId: string;
    hotMinutes: number;
    coldHours: number;
    activeDays: number;
    limit: number;
  }): Promise<Array<{ msisdn: string; msisdnHash: string }>> {
    const rows = await query<{ msisdn_hash: string; msisdn_enc: string | null }>(
      `SELECT msisdn_hash, msisdn_enc
         FROM mts_business_number_map
        WHERE account_id = $1
          AND msisdn_enc IS NOT NULL
          AND (
            (last_usage_at > NOW() - ($4 * INTERVAL '1 day')
             AND statement_fail_count < 3
             AND (statement_synced_at IS NULL OR statement_synced_at < NOW() - ($2 * INTERVAL '1 minute')))
            OR (statement_synced_at IS NULL OR statement_synced_at < NOW() - ($3 * INTERVAL '1 hour'))
          )
        ORDER BY statement_synced_at ASC NULLS FIRST
        LIMIT $5`,
      [params.accountId, params.hotMinutes, params.coldHours, params.activeDays, params.limit],
    );
    const out: Array<{ msisdn: string; msisdnHash: string }> = [];
    for (const r of rows) {
      const msisdn = encryptionService.decryptField(r.msisdn_enc);
      if (msisdn) out.push({ msisdn, msisdnHash: r.msisdn_hash });
    }
    return out;
  }

  /**
   * Отметка попытки синка выписки. Успех — сбрасывает счётчик неудач и двигает
   * last_usage_at (если в выписке было событие свежее сохранённого). Неудача,
   * которая не лечится повтором (свойство номера), тоже двигает
   * statement_synced_at — иначе номер вечно оставался бы первым в очереди.
   */
  async markStatementSynced(params: {
    msisdnHash: string;
    ok: boolean;
    lastUsageAt: Date | null;
  }): Promise<void> {
    await execute(
      `UPDATE mts_business_number_map
          SET statement_synced_at = NOW(),
              statement_fail_count = CASE WHEN $2 THEN 0 ELSE statement_fail_count + 1 END,
              last_usage_at = GREATEST(last_usage_at, $3::timestamptz)
        WHERE msisdn_hash = $1`,
      [params.msisdnHash, params.ok, params.lastUsageAt],
    );
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
