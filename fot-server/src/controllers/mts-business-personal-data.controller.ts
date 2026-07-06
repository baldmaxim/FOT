import { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { queryOne } from '../config/postgres.js';
import { encryptionService } from '../services/encryption.service.js';
import { mtsBusinessPersonalDataService, type IPersonalDataInput } from '../services/mts-business-personal-data.service.js';
import { mtsBusinessMappingService } from '../services/mts-business-mapping.service.js';
import { MtsBusinessApiError, isFeatureUnavailable } from '../services/mts-business-base.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';

// Персональные данные пользователя номера: чтение статуса/ФИО, внесение/
// изменение и удаление (транзитом в МТС), журнал заявок. ПДн-гигиена:
//  - тело формы НЕ сохраняется и НЕ логируется (ни в аудит, ни в Sentry);
//  - в ответах об ошибке — только статус/код МТС, без полей запроса.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const personSchema = z.object({
  surName: z.string().trim().min(1).max(100),
  firstName: z.string().trim().min(1).max(100),
  secondName: z.string().trim().max(100).optional(),
  gender: z.enum(['Male', 'Female']),
  birthday: z.string().regex(DATE_RE),
  birthPlace: z.string().trim().max(200).optional(),
  citizenship: z.enum(['RU', 'FOREIGN']),
  document: z.object({
    series: z.string().trim().max(20).optional(),
    number: z.string().trim().min(1).max(30),
    dateIssued: z.string().regex(DATE_RE),
    issuer: z.string().trim().max(300).optional(),
    issuerCode: z.string().trim().regex(/^\d{3}-\d{3}$/).optional(),
    countryCode: z.string().trim().min(2).max(3).optional(),
  }),
  address: z.object({
    region: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(200),
    street: z.string().trim().min(1).max(200),
    home: z.string().trim().min(1).max(50),
    apartment: z.string().trim().max(50).optional(),
    zip: z.string().trim().regex(/^\d{6}$/),
  }).optional(),
}).superRefine((val, ctx) => {
  if (val.citizenship === 'RU') {
    if (!val.address) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: 'Для гражданина РФ обязателен адрес регистрации' });
    }
    if (!val.document.series || !/^\d{4}$/.test(val.document.series)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document', 'series'], message: 'Серия паспорта РФ — 4 цифры' });
    }
    if (!/^\d{6}$/.test(val.document.number)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document', 'number'], message: 'Номер паспорта РФ — 6 цифр' });
    }
    if (!val.document.issuerCode) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document', 'issuerCode'], message: 'Укажите код подразделения (ХХХ-ХХХ)' });
    }
  } else if (!val.document.countryCode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document', 'countryCode'], message: 'Укажите страну документа' });
  }
});

const changeSchema = z.object({
  accountId: z.string().uuid().optional(),
  msisdn: z.string().min(10).max(20),
  confirmed: z.literal(true),
  person: personSchema,
});

const deleteSchema = z.object({
  accountId: z.string().uuid().optional(),
  msisdn: z.string().min(10).max(20),
  confirmed: z.literal(true),
});

/** Ошибки апстрима без тела запроса (в теле — ПДн). */
const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof MtsBusinessApiError) {
    console.error(`[mts-biz-pd] upstream error: http=${error.status} code=${error.code ?? '-'}`);
    res.status(502).json({ success: false, error: fallback, mtsHttp: error.status, mtsCode: error.code ?? null });
    return;
  }
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts-biz-pd] ${fallback}: ${msg}`);
  Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'personal-data' } });
  res.status(500).json({ success: false, error: fallback });
};

/** accountId из body/контекста номера (number_map → CDR → единственный активный аккаунт). */
const resolveAccountId = async (msisdn: string, explicit?: string): Promise<string | null> => {
  if (explicit) return explicit;
  const context = await mtsBusinessMappingService.getSubscriberContext(msisdn);
  return context?.accountId ?? null;
};

export const mtsBusinessPersonalDataController = {
  /** ФИО + статус подтверждения (живой вызов) + префилл из сотрудника + заявки номера. */
  async getInfo(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const msisdn = String(req.params.msisdn || '').trim();
      const context = await mtsBusinessMappingService.getSubscriberContext(msisdn);
      if (!context) {
        res.status(404).json({ success: false, error: 'Номер не найден или не определён лицевой счёт' });
        return;
      }

      let employee: Record<string, unknown> | null = null;
      if (context.employeeId != null) {
        const row = await queryOne<{
          id: number; last_name: string | null; first_name: string | null; middle_name: string | null;
          birth_date: string | null; country: string | null;
        }>(
          `SELECT id, last_name, first_name, middle_name, birth_date, country
             FROM employees WHERE id = $1`,
          [context.employeeId],
        );
        if (row) {
          employee = {
            id: row.id,
            lastName: row.last_name,
            firstName: row.first_name,
            middleName: row.middle_name,
            birthDate: row.birth_date,
            country: row.country,
          };
        }
      }
      const requests = await mtsBusinessPersonalDataService.listByMsisdn(msisdn);

      try {
        const info = await mtsBusinessPersonalDataService.fetchAndCacheInfo(context.accountId, msisdn);
        res.json({
          success: true,
          data: {
            msisdn,
            accountId: context.accountId,
            fullName: info.fullName,
            confirmationStatus: info.confirmationStatus,
            employee,
            requests,
          },
        });
      } catch (error) {
        if (isFeatureUnavailable(error)) {
          res.json({
            success: true,
            data: {
              msisdn,
              accountId: context.accountId,
              unavailable: true,
              reason: 'MTS_FEATURE_NOT_CONNECTED',
              employee,
              requests,
            },
          });
          return;
        }
        throw error;
      }
    } catch (error) {
      fail(res, error, 'Ошибка чтения персональных данных');
    }
  },

  /** Внести/изменить персональные данные (транзит в МТС, асинхронно: SMS → Госуслуги). */
  async change(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = changeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Проверьте поля формы', details: parsed.error.flatten() });
        return;
      }
      const { msisdn, person } = parsed.data;
      const accountId = await resolveAccountId(msisdn, parsed.data.accountId);
      if (!accountId) {
        res.status(400).json({ success: false, error: 'Не удалось определить лицевой счёт номера' });
        return;
      }

      const { messageId } = await mtsBusinessPersonalDataService.change(accountId, msisdn, person as IPersonalDataInput);
      await mtsBusinessPersonalDataService.logRequest({
        messageId, accountId, msisdn, operation: 'change', requestedBy: req.user.id,
      });
      // Аудит без ПДн: только аккаунт и тип операции (ни ФИО, ни номера).
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_PERSONAL_DATA_SUBMITTED, {
        details: { accountId, operation: 'change' },
      });
      res.json({ success: true, data: { messageId } });
    } catch (error) {
      fail(res, error, 'Ошибка отправки персональных данных в МТС');
    }
  },

  /** Удалить персональные данные пользователя номера. */
  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = deleteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const { msisdn } = parsed.data;
      const accountId = await resolveAccountId(msisdn, parsed.data.accountId);
      if (!accountId) {
        res.status(400).json({ success: false, error: 'Не удалось определить лицевой счёт номера' });
        return;
      }

      const { messageId } = await mtsBusinessPersonalDataService.remove(accountId, msisdn);
      await mtsBusinessPersonalDataService.logRequest({
        messageId, accountId, msisdn, operation: 'delete', requestedBy: req.user.id,
      });
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_PERSONAL_DATA_DELETE_REQUESTED, {
        details: { accountId, operation: 'delete' },
      });
      res.json({ success: true, data: { messageId } });
    } catch (error) {
      fail(res, error, 'Ошибка удаления персональных данных');
    }
  },

  /** Журнал заявок на внесение/удаление персданных. */
  async listRequests(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await mtsBusinessPersonalDataService.listRequests() });
    } catch (error) {
      fail(res, error, 'Ошибка получения журнала заявок');
    }
  },

  /** Ручная проверка статуса заявки по MessageId (плюс фоновый поллер). */
  async refreshRequestStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const messageId = String(req.params.messageId || '').trim();
      const row = await queryOne<{ account_id: string | null; msisdn_enc: string | null }>(
        `SELECT account_id, msisdn_enc FROM mts_business_personal_data_requests WHERE message_id = $1`,
        [messageId],
      );
      if (!row) {
        res.status(404).json({ success: false, error: 'Заявка не найдена' });
        return;
      }
      const msisdn = encryptionService.decryptField(row.msisdn_enc);
      if (!row.account_id || !msisdn) {
        res.status(400).json({ success: false, error: 'У заявки не определён аккаунт или номер' });
        return;
      }
      const { status, raw } = await mtsBusinessPersonalDataService.getOperationResult(row.account_id, msisdn, messageId);
      await mtsBusinessPersonalDataService.updateStatus(messageId, status, raw);
      // Заявка завершилась — статус подтверждения на номере мог измениться,
      // обновляем кэш ФИО/статуса (не критично при ошибке).
      if (status === 'completed') {
        try {
          const info = await mtsBusinessPersonalDataService.fetchAndCacheInfo(row.account_id, msisdn);
          if (info.fullName) await mtsBusinessMappingService.syncMtsNames([{ msisdn, fio: info.fullName }], null);
        } catch { /* кэш обновится следующим синком */ }
      }
      res.json({ success: true, data: { messageId, status, raw } });
    } catch (error) {
      fail(res, error, 'Ошибка проверки статуса заявки');
    }
  },
};
