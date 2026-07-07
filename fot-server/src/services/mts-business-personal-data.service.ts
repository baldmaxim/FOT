import { randomUUID } from 'node:crypto';
import { execute, query } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { MtsBusinessServiceBase } from './mts-business-base.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { msisdnHash, normalizeMsisdn } from './mts-business-cdr.service.js';

// Персональные данные пользователя номера (PersonalData-домен МТС Business API):
//  - чтение ФИО + статуса подтверждения (PersonalDataInfo);
//  - внесение/изменение и удаление (ChangePersonalData, асинхронно: SMS → Госуслуги);
//  - статус заявки (Operations/GetOperationResult по MessageId).
//
// ГЛАВНОЕ ПРАВИЛО МОДУЛЯ: паспортные данные/адрес/дата рождения идут в МТС
// ТРАНЗИТОМ — не сохраняются в БД, не логируются (suppressErrorBodyLog на всех
// вызовах), не попадают в аудит и Sentry. В журнале заявок
// (mts_business_personal_data_requests, миграция 206) — только message_id,
// номер (шифрованный), тип операции и статус.
//
// Контракт ChangePersonalData НЕ проверен живым вызовом (см. §5.12
// MTS_BUSINESS_API_INTEGRATION.md): x-soap-action передаётся С КАВЫЧКАМИ в
// значении (как в документации МТС), Country адреса — строго «Россия»
// («РФ»/«Российская Федерация» отклоняются валидатором МТС).

const SOAP_ACTION_CHANGE = '"http://schemas.sitels.ru/FORIS/IL/JsonApi/IResourceOperations%ChangeUserPhysicalResourceBulk"';
const SOAP_ACTION_GET_RESULT = '"http://schemas.sitels.ru/FORIS/IL/JsonApi/IGetOperationsResultService%GetOperationResult"';

/** Статусы подтверждения персданных (characteristic PersonalDataConfirmation). */
export type MtsPersonalDataConfirmationStatus =
  | 'Depersonalized'
  | 'NotRequired'
  | 'Migration'
  | 'Anonymous'
  | 'WaitingForAcceptance'
  | 'WaitingForCheck'
  | 'Activated'
  | 'ActivatedPortIn'
  | 'MismatchOfData'
  | 'NotFoundInEsia'
  | 'Refusal'
  | 'RequestNotFoundInEsia'
  | string;

export interface IMtsPersonalDataInfo {
  fullName: string | null;
  confirmationStatus: MtsPersonalDataConfirmationStatus | null;
}

export interface IMtsPersonalDataDocument {
  series?: string;      // 4 цифры (паспорт РФ); у иностранного документа может отсутствовать
  number: string;
  dateIssued: string;   // YYYY-MM-DD
  issuer?: string;
  issuerCode?: string;  // ХХХ-ХХХ, только паспорт РФ
  countryCode?: string; // код страны для иностранного документа (DocumentType 10)
}

export interface IMtsPersonalDataAddress {
  region: string;
  city: string;
  street: string;
  home: string;
  apartment?: string;
  zip: string;
}

/** Данные формы — живут ТОЛЬКО в памяти запроса, никуда не персистятся. */
export interface IPersonalDataInput {
  surName: string;
  firstName: string;
  secondName?: string;
  gender: 'Male' | 'Female';
  birthday: string; // YYYY-MM-DD
  birthPlace?: string;
  citizenship: 'RU' | 'FOREIGN';
  document: IMtsPersonalDataDocument;
  address?: IMtsPersonalDataAddress; // обязателен для РФ (AddressTypes=RegAddress)
}

export type MtsPersonalDataRequestStatus = 'completed' | 'in_progress' | 'faulted' | 'unknown';

export interface IPersonalDataRequestRow {
  messageId: string;
  accountId: string | null;
  msisdn: string | null;
  operation: string; // 'change' | 'delete'
  status: string;
  statusDetail: string | null;
  requestedAt: string;
  checkedAt: string | null;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * МТС для корпоративных SIM без владельца возвращает в `name` литеральную строку
 * «null null» (склейка пустых firstName/lastName на своей стороне). Такое «имя»
 * НЕ должно попадать в mts_fio. Отсекаем пустое-после-trim и строки только из
 * токенов null/undefined (в любом регистре, любое количество через пробел).
 */
const isPlaceholderName = (s: string): boolean =>
  s.trim().length === 0 || /^(null|undefined)( +(null|undefined))*$/i.test(s.trim());

/** Значение имени с отсевом плейсхолдеров МТС; null — если имени по сути нет. */
const cleanName = (v: unknown): string | null => {
  const s = asString(v);
  if (!s) return null;
  const t = s.trim();
  return isPlaceholderName(t) ? null : t;
};

/**
 * Разбор ответа PersonalDataInfo: массив записей, ФИО одной строкой в `name`
 * (fallback SurName/FirstName/SecondName для иной схемы контура), статус — в
 * characteristic[name=PersonalDataConfirmation].value. Остальные поля ответа
 * (паспорт, адрес, дата рождения) СОЗНАТЕЛЬНО не парсим.
 */
export const parsePersonalDataInfo = (resp: unknown): IMtsPersonalDataInfo => {
  const records = (Array.isArray(resp) ? resp : [resp])
    .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object');
  let fullName: string | null = null;
  let confirmationStatus: string | null = null;
  for (const r of records) {
    if (!fullName) {
      const name = cleanName(r.name);
      if (name) {
        fullName = name;
      } else {
        const surName = asString(r.SurName) ?? asString(r.surName) ?? asString(r.LastName);
        const firstName = asString(r.FirstName) ?? asString(r.firstName);
        const secondName = asString(r.SecondName) ?? asString(r.secondName);
        const joined = [surName, firstName, secondName].filter((v): v is string => Boolean(v)).join(' ');
        const fio = joined && !isPlaceholderName(joined) ? joined : null;
        if (fio) fullName = fio;
      }
    }
    if (!confirmationStatus && Array.isArray(r.characteristic)) {
      for (const c of r.characteristic as Array<Record<string, unknown> | null>) {
        if (c && typeof c === 'object' && asString(c.name) === 'PersonalDataConfirmation') {
          confirmationStatus = asString(c.value);
          break;
        }
      }
    }
  }
  return { fullName, confirmationStatus };
};

/** Документ из ответа PersonalDataInfo (identifiedBy[]). */
export interface IMtsPdDocument {
  documentType: string | null;
  documentSeries: string | null;
  documentNo: string | null;
  issuedBy: string | null;
  issuedDate: string | null;
  issuingCountry: string | null;
}

/**
 * Полный профиль ПДн для отображения в карточке абонента: ФИО + дата рождения +
 * документы. Собирается из РАСШИФРОВАННОГО pd_data_enc (сырой ответ
 * PersonalDataInfo). Адреса в ответе МТС нет — не выводим.
 */
export interface IMtsPersonalDataFull {
  fullName: string | null;
  birthDate: string | null;
  confirmationStatus: MtsPersonalDataConfirmationStatus | null;
  documents: IMtsPdDocument[];
}

/**
 * Разбор полного ответа PersonalDataInfo: ФИО (с отсевом «null null»), дата
 * рождения, все документы из identifiedBy[], статус подтверждения. Толерантен к
 * форме — берёт первую запись массива с данными.
 */
export const parsePersonalDataFull = (resp: unknown): IMtsPersonalDataFull => {
  const records = (Array.isArray(resp) ? resp : [resp])
    .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object');
  const base = parsePersonalDataInfo(resp);
  let birthDate: string | null = null;
  const documents: IMtsPdDocument[] = [];
  for (const r of records) {
    if (!birthDate) birthDate = asString(r.birthDate) ?? asString(r.BirthDate) ?? asString(r.birthday);
    const ids = Array.isArray(r.identifiedBy) ? (r.identifiedBy as Array<Record<string, unknown> | null>) : [];
    for (const d of ids) {
      if (!d || typeof d !== 'object') continue;
      const doc: IMtsPdDocument = {
        documentType: asString(d.documentType) ?? asString(d.DocumentType),
        documentSeries: asString(d.documentSeries) ?? asString(d.DocumentSeries),
        documentNo: asString(d.documentNo) ?? asString(d.DocumentNumber) ?? asString(d.documentNumber),
        issuedBy: asString(d.issuedBy) ?? asString(d.IssuedBy) ?? asString(d.issuer),
        issuedDate: asString(d.issuedDate) ?? asString(d.IssuedDate),
        issuingCountry: asString(d.issuingCountry) ?? asString(d.IssuingCountry),
      };
      if (doc.documentNo || doc.documentSeries || doc.issuedBy) documents.push(doc);
    }
  }
  return { fullName: base.fullName, birthDate, confirmationStatus: base.confirmationStatus, documents };
};

/**
 * Тело ChangePersonalData (§5.12 документации): data=null — удаление персданных
 * (Items без UserData). Чистая функция — контракт покрывается vitest без сети.
 */
export const buildChangePersonalDataBody = (
  msisdn: string,
  data: IPersonalDataInput | null,
  messageId: string,
): Record<string, unknown> => {
  const item: Record<string, unknown> = { Msisdn: msisdn };
  if (data) {
    const isRu = data.citizenship === 'RU';
    const userData: Record<string, unknown> = {
      Action: 'Create',
      LegalCategory: { Code: '1' },
      Birthday: `${data.birthday}T00:00:00`,
      Gender: data.gender,
      IsEntrepreneur: false,
      Identifications: [{
        Action: 'Create',
        DocumentType: { Code: isRu ? '21' : '10' },
        Country: { Code: isRu ? 'RU' : (data.document.countryCode ?? '') },
        ...(data.document.series ? { DocumentSeries: data.document.series } : {}),
        DocumentNumber: data.document.number,
        DateIssued: `${data.document.dateIssued}T00:00:00`,
        ...(data.document.issuer ? { Issuer: data.document.issuer } : {}),
        ...(isRu && data.document.issuerCode ? { IssuerCode: data.document.issuerCode } : {}),
      }],
      Names: [{
        Action: 'Create',
        FirstName: data.firstName,
        SecondName: data.secondName ?? '',
        SurName: data.surName,
        Language: { Code: '1' },
      }],
    };
    if (data.birthPlace) userData.BirthPlace = data.birthPlace;
    if (isRu && data.address) {
      userData.Addresses = [{
        Country: 'Россия', // строго так — «РФ»/«Российская Федерация» МТС отклоняет
        Region: data.address.region,
        City: data.address.city,
        Street: data.address.street,
        Home: data.address.home,
        ...(data.address.apartment ? { Apartment: data.address.apartment } : {}),
        Zip: data.address.zip,
        AddressTypes: 'RegAddress',
      }];
    }
    item.UserData = userData;
  }
  return {
    request: { Items: [item] },
    SubscriberInformation: {
      MessageId: messageId,
      ReplyToURL: 'DB:',
      SubscriberName: 'MobileAPI',
      OperatorType: 'MTSBusinessAPI',
    },
  };
};

/** Глубокий поиск первой строки по ключам-кандидатам (статус в ответе GetOperationResult). */
const deepPickString = (body: unknown, keys: string[], depth = 0): string | null => {
  if (depth > 6 || body == null) return null;
  if (Array.isArray(body)) {
    for (const el of body) {
      const found = deepPickString(el, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  for (const k of keys) {
    const v = b[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  for (const v of Object.values(b)) {
    if (v && typeof v === 'object') {
      const found = deepPickString(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
};

export const normalizePersonalDataStatus = (raw: string | null): MtsPersonalDataRequestStatus => {
  const s = (raw || '').toLowerCase();
  if (s.includes('complet') || s.includes('success') || s.includes('done') || s.includes('готов') || s.includes('выполн')) return 'completed';
  if (s.includes('progress') || s.includes('process') || s.includes('wait') || s.includes('обраб') || s.includes('ожид')) return 'in_progress';
  if (s.includes('fault') || s.includes('error') || s.includes('fail') || s.includes('reject') || s.includes('ошиб') || s.includes('отказ')) return 'faulted';
  return 'unknown';
};

class MtsBusinessPersonalDataService extends MtsBusinessServiceBase {
  /** ФИО + статус подтверждения персданных (живой вызов PersonalDataInfo). */
  async getInfo(accountId: string, rawMsisdn: string): Promise<IMtsPersonalDataInfo> {
    const msisdn = normalizeMsisdn(rawMsisdn);
    if (!msisdn) throw new Error('МТС Бизнес: некорректный номер телефона');
    const resp = await this.request<unknown>('get', '/PersonalData/PersonalDataInfo', {
      accountId,
      params: { 'contactMedium.phoneNumber': msisdn },
      suppressErrorBodyLog: true,
    });
    return parsePersonalDataInfo(resp);
  }

  /** getInfo + кэш статуса в number_map.pd_status (бейдж «Персданные» без живых вызовов). */
  async fetchAndCacheInfo(accountId: string, rawMsisdn: string): Promise<IMtsPersonalDataInfo> {
    const info = await this.getInfo(accountId, rawMsisdn);
    await mtsBusinessMappingService.setPersonalDataStatus(rawMsisdn, info.confirmationStatus);
    return info;
  }

  /**
   * Полная выгрузка PersonalDataInfo: ФИО/статус — в открытые поля, сырой ответ
   * (паспорт/дата рождения и пр.) — ТОЛЬКО шифром в pd_data_enc (миграция 207).
   * Расшифровка отдаётся наружу единственным путём — getStoredFull → карточка
   * абонента под гардом страницы /mts-business; в логи/аудит по-прежнему не идёт.
   */
  async fetchAndStoreFull(accountId: string, rawMsisdn: string): Promise<IMtsPersonalDataInfo> {
    const msisdn = normalizeMsisdn(rawMsisdn);
    if (!msisdn) throw new Error('МТС Бизнес: некорректный номер телефона');
    const resp = await this.request<unknown>('get', '/PersonalData/PersonalDataInfo', {
      accountId,
      params: { 'contactMedium.phoneNumber': msisdn },
      suppressErrorBodyLog: true,
    });
    const info = parsePersonalDataInfo(resp);
    await mtsBusinessMappingService.setPersonalDataStatus(msisdn, info.confirmationStatus);
    const hasData = Array.isArray(resp)
      ? resp.length > 0
      : resp != null && typeof resp === 'object' && Object.keys(resp as Record<string, unknown>).length > 0;
    await mtsBusinessMappingService.setPersonalDataBlob(
      msisdn,
      hasData ? encryptionService.encrypt(JSON.stringify(resp)) : null,
    );
    return info;
  }

  /**
   * Полный профиль ПДн ИЗ КЭША (расшифровка pd_data_enc) для карточки абонента —
   * без живого вызова МТС. null, если blob пуст или не расшифровался.
   */
  async getStoredFull(rawMsisdn: string): Promise<IMtsPersonalDataFull | null> {
    const enc = await mtsBusinessMappingService.getPersonalDataBlob(rawMsisdn);
    if (!enc) return null;
    const raw = encryptionService.decryptField(enc);
    if (!raw) return null;
    try {
      return parsePersonalDataFull(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Внести/изменить персональные данные пользователя номера. Асинхронно:
   * после принятия заявки пользователю приходит SMS, подтверждение — через
   * Госуслуги. Возвращает наш MessageId (по нему опрашивается статус).
   */
  async change(accountId: string, rawMsisdn: string, data: IPersonalDataInput): Promise<{ messageId: string }> {
    const msisdn = normalizeMsisdn(rawMsisdn);
    if (!msisdn) throw new Error('МТС Бизнес: некорректный номер телефона');
    const messageId = randomUUID();
    await this.request<unknown>('post', '/PersonalData/ChangePersonalData', {
      accountId,
      data: buildChangePersonalDataBody(msisdn, data, messageId),
      headers: { 'x-soap-action': SOAP_ACTION_CHANGE, 'X-MTS-MSISDN': msisdn },
      suppressErrorBodyLog: true,
    });
    return { messageId };
  }

  /** Удалить персональные данные пользователя номера (Items без UserData). */
  async remove(accountId: string, rawMsisdn: string): Promise<{ messageId: string }> {
    const msisdn = normalizeMsisdn(rawMsisdn);
    if (!msisdn) throw new Error('МТС Бизнес: некорректный номер телефона');
    const messageId = randomUUID();
    await this.request<unknown>('post', '/PersonalData/ChangePersonalData', {
      accountId,
      data: buildChangePersonalDataBody(msisdn, null, messageId),
      headers: { 'x-soap-action': SOAP_ACTION_CHANGE, 'X-MTS-MSISDN': msisdn },
      suppressErrorBodyLog: true,
    });
    return { messageId };
  }

  /** Статус заявки внесения/удаления по MessageId (Operations/GetOperationResult). */
  async getOperationResult(
    accountId: string,
    rawMsisdn: string,
    messageId: string,
  ): Promise<{ status: MtsPersonalDataRequestStatus; raw: string | null }> {
    const msisdn = normalizeMsisdn(rawMsisdn);
    if (!msisdn) throw new Error('МТС Бизнес: некорректный номер телефона');
    const resp = await this.request<unknown>('post', '/Operations/GetOperationResult', {
      accountId,
      data: {
        request: { Body: { SourceTypeCode: 'MTSBusinessAPI', MessageId: messageId } },
        SubscriberInformation: { SubscriberName: 'MobileAPI', OperatorType: 'MTSBusinessAPI' },
      },
      headers: { 'x-soap-action': SOAP_ACTION_GET_RESULT, 'X-MTS-MSISDN': msisdn },
      suppressErrorBodyLog: true,
    });
    const raw = deepPickString(resp, ['status', 'Status', 'state', 'State', 'StatusCode', 'result', 'Result']);
    return { status: normalizePersonalDataStatus(raw), raw: raw ? raw.slice(0, 200) : null };
  }

  // === Журнал заявок (mts_business_personal_data_requests, миграция 206) ===

  async logRequest(input: {
    messageId: string;
    accountId: string;
    msisdn: string;
    operation: 'change' | 'delete';
    requestedBy: string;
  }): Promise<void> {
    const hash = msisdnHash(input.msisdn);
    const norm = normalizeMsisdn(input.msisdn);
    if (!hash || !norm) return;
    await execute(
      `INSERT INTO mts_business_personal_data_requests
         (message_id, account_id, msisdn_hash, msisdn_enc, operation, status, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, NOW())
       ON CONFLICT (message_id) DO NOTHING`,
      [input.messageId, input.accountId, hash, encryptionService.encrypt(norm), input.operation, input.requestedBy],
    );
  }

  async listRequests(limit = 100): Promise<IPersonalDataRequestRow[]> {
    const rows = await query<{
      message_id: string; account_id: string | null; msisdn_enc: string | null; operation: string;
      status: string; status_detail: string | null; requested_at: string; checked_at: string | null;
    }>(
      `SELECT message_id, account_id, msisdn_enc, operation, status, status_detail, requested_at, checked_at
         FROM mts_business_personal_data_requests
        ORDER BY requested_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(r => ({
      messageId: r.message_id,
      accountId: r.account_id,
      msisdn: encryptionService.decryptField(r.msisdn_enc),
      operation: r.operation,
      status: r.status,
      statusDetail: r.status_detail,
      requestedAt: r.requested_at,
      checkedAt: r.checked_at,
    }));
  }

  async listByMsisdn(rawMsisdn: string, limit = 20): Promise<IPersonalDataRequestRow[]> {
    const hash = msisdnHash(rawMsisdn);
    if (!hash) return [];
    const rows = await query<{
      message_id: string; account_id: string | null; msisdn_enc: string | null; operation: string;
      status: string; status_detail: string | null; requested_at: string; checked_at: string | null;
    }>(
      `SELECT message_id, account_id, msisdn_enc, operation, status, status_detail, requested_at, checked_at
         FROM mts_business_personal_data_requests
        WHERE msisdn_hash = $1
        ORDER BY requested_at DESC
        LIMIT $2`,
      [hash, limit],
    );
    return rows.map(r => ({
      messageId: r.message_id,
      accountId: r.account_id,
      msisdn: encryptionService.decryptField(r.msisdn_enc),
      operation: r.operation,
      status: r.status,
      statusDetail: r.status_detail,
      requestedAt: r.requested_at,
      checkedAt: r.checked_at,
    }));
  }

  /** Заявки «в обработке» для фонового статус-поллера. */
  async getPending(limit = 20): Promise<Array<{ messageId: string; accountId: string; msisdn: string | null; operation: string }>> {
    const rows = await query<{
      message_id: string; account_id: string | null; msisdn_enc: string | null; operation: string;
    }>(
      `SELECT message_id, account_id, msisdn_enc, operation
         FROM mts_business_personal_data_requests
        WHERE status IN ('in_progress', 'unknown')
          AND account_id IS NOT NULL
          AND requested_at > NOW() - INTERVAL '7 days'
        ORDER BY requested_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows
      .filter((r): r is typeof r & { account_id: string } => r.account_id !== null)
      .map(r => ({
        messageId: r.message_id,
        accountId: r.account_id,
        msisdn: encryptionService.decryptField(r.msisdn_enc),
        operation: r.operation,
      }));
  }

  async updateStatus(messageId: string, status: string, detail?: string | null): Promise<void> {
    await execute(
      `UPDATE mts_business_personal_data_requests
          SET status = $2, status_detail = COALESCE($3, status_detail), checked_at = NOW()
        WHERE message_id = $1`,
      [messageId, status, detail ?? null],
    );
  }
}

export const mtsBusinessPersonalDataService = new MtsBusinessPersonalDataService();
