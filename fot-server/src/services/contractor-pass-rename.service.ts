/**
 * Исправление ФИО держателя пропуска со вкладки «Мониторинг» (админ раздела подрядчиков).
 *
 * Это опечатка, а не смена владельца: открытую строку contractor_pass_holders правим
 * на месте, новую не создаём. У одобренного пропуска то же имя уходит в карточку
 * «Управления кадрами» и в профиль Sigur — чтобы все три места совпадали. У
 * неодобренного профиль Sigur называется «Пропуск N»: правим только пропуск, имя
 * уйдёт в Sigur при одобрении (оно читает contractor_passes.holder_name).
 *
 * Sigur не участвует в транзакции БД. Поэтому запись в него — последний внешний шаг
 * перед COMMIT, а при любой ошибке после начатого PUT (сам PUT мог примениться по
 * таймауту, мог упасть аудит или COMMIT) возвращаем в Sigur прежнее имя.
 */
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import { withTransaction } from '../config/postgres.js';
import { isContractorSigurDryRun } from '../config/contractor.js';
import { parseFIO } from '../utils/fio.utils.js';
import { auditService, AUDIT_ACTIONS } from './audit.service.js';
import { findActive, findActiveBySigurEmployeeId, blockMessage } from './blacklist.service.js';
import { employeeCache } from './employee-cache.service.js';
import { sigurService } from './sigur.service.js';
import { invalidateSigurDirectoryCaches } from './sigur-live-admin.service.js';
import { normalizeEmployee } from './sigur-sync-shared.js';
import { syncProfileNameFromEmployee } from './user-profile-name.service.js';
import type { ConnectionType } from './sigur-base.service.js';

export const renameHolderBodySchema = z.object({
  full_name: z
    .string({ required_error: 'Укажите ФИО', invalid_type_error: 'Укажите ФИО' })
    .transform(value => value.replace(/\s+/g, ' ').trim())
    .pipe(
      z.string()
        .min(2, 'ФИО слишком короткое')
        .max(200, 'ФИО длиннее 200 символов')
        .refine(value => value.split(' ').length >= 2, 'Укажите как минимум фамилию и имя'),
    ),
  // Обязательна и обязана быть датой: иначе проверка ревизии молча отключается.
  expected_updated_at: z
    .string({ required_error: 'Не передана ревизия записи', invalid_type_error: 'Не передана ревизия записи' })
    .datetime({ offset: true, message: 'Некорректная ревизия записи' }),
});

export class RenameHolderError extends Error {
  readonly http: number;

  constructor(http: number, message: string) {
    super(message);
    this.name = 'RenameHolderError';
    this.http = http;
  }
}

export interface IRenameHolderInput {
  passId: string;
  newName: string;
  expectedUpdatedAt: string;
  userId: string;
  canSeeBlacklistReason: boolean;
  ipAddress?: string;
  userAgent?: string;
}

export interface IRenameHolderResult {
  changed: boolean;
  holder_name: string;
  employee_updated: boolean;
  sigur_updated: boolean;
}

interface ILockedPass {
  id: string;
  pass_number: string;
  status: string;
  approval_status: string;
  org_department_id: string;
  sigur_employee_id: string | number | null;
  holder_name: string | null;
  birth_date: string | null;
  passport_series_number: string | null;
  updated_at: Date | string;
}

interface ILinkedEmployee {
  id: number;
  full_name: string | null;
  name_locked: boolean;
}

interface ISigurWrite {
  sigurEmployeeId: number;
  previousName: string;
  connection: ConnectionType;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Возврат прежнего имени в Sigur. PUT идемпотентен: если новое не записалось, ничего не меняет. */
const compensateSigurName = async (write: ISigurWrite): Promise<boolean> => {
  try {
    await sigurService.updateEmployee(write.sigurEmployeeId, { name: write.previousName }, write.connection);
    return true;
  } catch (compensationError) {
    console.error('Contractor renamePassHolder: компенсация Sigur не удалась', compensationError);
    return false;
  }
};

export const renamePassHolder = async (input: IRenameHolderInput): Promise<IRenameHolderResult> => {
  const { passId, newName, userId } = input;
  const dryRun = isContractorSigurDryRun();
  // Объект, а не let: присваивание внутри колбэка транзакции TS в catch не видит.
  const sigurState: { write: ISigurWrite | null } = { write: null };

  let result: IRenameHolderResult & { employee_id: number | null };
  try {
    result = await withTransaction(async client => {
      const passRes = await client.query<ILockedPass>(
        `SELECT p.id, p.pass_number, p.status, p.approval_status, p.org_department_id,
                p.sigur_employee_id, p.holder_name, p.passport_series_number, p.updated_at,
                to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date
           FROM contractor_passes p
          WHERE p.id = $1::uuid
          FOR UPDATE`,
        [passId],
      );
      const pass = passRes.rows[0];
      if (!pass) throw new RenameHolderError(404, 'Пропуск не найден');
      if (pass.status === 'revoked' || pass.status === 'in_pool') {
        throw new RenameHolderError(409, 'Пропуск свободен или отозван — ФИО не редактируется');
      }
      const expectedMs = new Date(input.expectedUpdatedAt).getTime();
      if (!Number.isFinite(expectedMs)) throw new RenameHolderError(400, 'Некорректная ревизия записи');
      if (new Date(pass.updated_at).getTime() !== expectedMs) {
        throw new RenameHolderError(409, 'Пропуск изменён другим пользователем — обновите страницу и повторите');
      }

      const holderRes = await client.query<{ id: string; holder_name: string }>(
        `SELECT id, holder_name FROM contractor_pass_holders
          WHERE pass_id = $1::uuid AND valid_until IS NULL
          FOR UPDATE`,
        [passId],
      );
      const openHolder = holderRes.rows[0] ?? null;
      const oldName = openHolder?.holder_name ?? pass.holder_name;
      // Вписать держателя в пустой слот — не исправление опечатки: это делает подрядчик.
      if (!oldName) {
        throw new RenameHolderError(409, 'У пропуска нет держателя — ФИО вписывает подрядчик');
      }

      // Одобренный пропуск: имя живёт ещё в кадрах и Sigur. Связь обязана быть однозначной —
      // иначе «одинаково в трёх местах» не гарантировать, отказываем до любых изменений.
      const approved = pass.approval_status === 'approved';
      let sigurEmployeeId: number | null = null;
      let employee: ILinkedEmployee | null = null;
      if (approved) {
        if (pass.sigur_employee_id == null) {
          throw new RenameHolderError(409, 'У одобренного пропуска нет профиля Sigur — исправить ФИО здесь нельзя, нужна ручная проверка');
        }
        sigurEmployeeId = Number(pass.sigur_employee_id);
        const employeeRes = await client.query<ILinkedEmployee>(
          `SELECT id, full_name, name_locked
             FROM employees
            WHERE sigur_employee_id = $1 AND is_archived IS NOT TRUE
            FOR UPDATE`,
          [sigurEmployeeId],
        );
        if (employeeRes.rows.length !== 1) {
          throw new RenameHolderError(
            409,
            employeeRes.rows.length === 0
              ? 'Сотрудник этого пропуска не найден в «Управлении кадрами» — повторите после синхронизации с Sigur'
              : 'Профиль Sigur связан с несколькими карточками в «Управлении кадрами» — нужна ручная проверка',
          );
        }
        employee = employeeRes.rows[0];
      }

      const passUnchanged = oldName === newName && pass.holder_name === newName;
      const employeeUnchanged = !employee || employee.full_name === newName;
      if (passUnchanged && employeeUnchanged) {
        return {
          changed: false,
          holder_name: newName,
          employee_updated: false,
          sigur_updated: false,
          employee_id: null,
        };
      }

      if (employee && !employeeUnchanged && employee.name_locked) {
        throw new RenameHolderError(
          409,
          'ФИО в «Управлении кадрами» закреплено от синхронизации (name_locked) — здесь его не исправить, иначе имена разойдутся',
        );
      }

      // Чёрный список — под теми же локами, по документам из заблокированной строки.
      if (sigurEmployeeId != null) {
        // Тот же лок, что у withSigurProfileGuard: внесение в ЧС и правка профиля не идут параллельно.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`blacklist:sigur:${sigurEmployeeId}`]);
        const target = await findActiveBySigurEmployeeId(sigurEmployeeId, client);
        if (target) throw new RenameHolderError(409, blockMessage([target], input.canSeeBlacklistReason));
      }
      const matches = await findActive({
        fullName: newName,
        birthDate: pass.birth_date,
        passport: pass.passport_series_number,
        employeeId: employee?.id ?? null,
      }, client);
      if (matches.strong.length > 0) {
        throw new RenameHolderError(409, blockMessage(matches.strong, input.canSeeBlacklistReason));
      }

      await client.query(
        `UPDATE contractor_passes SET holder_name = $1, updated_at = now() WHERE id = $2::uuid`,
        [newName, passId],
      );
      // changed_by не трогаем: в нём тот, кто вписал держателя; правку фиксирует аудит.
      if (openHolder && openHolder.holder_name !== newName) {
        await client.query(
          `UPDATE contractor_pass_holders SET holder_name = $1 WHERE id = $2::uuid`,
          [newName, openHolder.id],
        );
      }

      let employeeUpdated = false;
      if (employee && !employeeUnchanged) {
        const fio = parseFIO(newName);
        await client.query(
          `UPDATE employees
              SET full_name = $1, last_name = $2, first_name = $3, middle_name = $4, updated_at = now()
            WHERE id = $5`,
          [newName, fio.lastName, fio.firstName, fio.middleName, employee.id],
        );
        await syncProfileNameFromEmployee(client, employee.id);
        employeeUpdated = true;
      }
      if (sigurEmployeeId != null) {
        // Как синк ростера: только активные строки, staged/removed-намерения подрядчика не трогаем.
        await client.query(
          `UPDATE contractor_roster
              SET full_name = $1, updated_at = now()
            WHERE org_department_id = $2::uuid AND sigur_employee_id = $3
              AND state = 'active' AND full_name IS DISTINCT FROM $1`,
          [newName, pass.org_department_id, sigurEmployeeId],
        );
      }

      // Sigur — последним внешним шагом; всё, что может упасть в БД, уже выполнено.
      let sigurPreviousName: string | null = null;
      let sigurUpdated = false;
      if (sigurEmployeeId != null && !dryRun) {
        const connection = await sigurService.getBackgroundConnectionType();
        try {
          sigurPreviousName = normalizeEmployee(await sigurService.getEmployeeById(sigurEmployeeId, connection)).name;
        } catch (readError) {
          throw new RenameHolderError(502, `Не удалось прочитать профиль в Sigur — ФИО не изменено: ${errorText(readError)}`);
        }
        // Без прежнего имени нечем компенсировать сбой — не рискуем.
        if (!sigurPreviousName) {
          throw new RenameHolderError(502, 'Профиль в Sigur пришёл без ФИО — ФИО не изменено, нужна ручная проверка');
        }
        if (sigurPreviousName !== newName) {
          sigurState.write = { sigurEmployeeId, previousName: sigurPreviousName, connection };
          await sigurService.updateEmployee(sigurEmployeeId, { name: newName }, connection);
          sigurUpdated = true;
        }
      }

      // Аудит тем же клиентом и без глушения ошибки: нет следа — нет и правки.
      await auditService.logWithClient(client, {
        user_id: userId,
        action: AUDIT_ACTIONS.CONTRACTOR_PASS_HOLDER_RENAMED,
        entity_type: 'contractor_pass',
        entity_id: passId,
        details: {
          pass_number: pass.pass_number,
          old_name: oldName,
          new_name: newName,
          approval_status: pass.approval_status,
          employee_id: employee?.id ?? null,
          employee_old_name: employee?.full_name ?? null,
          sigur_employee_id: sigurEmployeeId,
          sigur_previous_name: sigurPreviousName,
          sigur_updated: sigurUpdated,
        },
        ip_address: input.ipAddress,
        user_agent: input.userAgent,
      });

      return {
        changed: true,
        holder_name: newName,
        employee_updated: employeeUpdated,
        sigur_updated: sigurUpdated,
        employee_id: employee?.id ?? null,
      };
    });
  } catch (error) {
    const write = sigurState.write;
    if (!write) throw error;
    // PUT в Sigur был начат, а транзакция БД откатилась — возвращаем прежнее имя.
    const compensated = await compensateSigurName(write);
    if (!compensated) {
      Sentry.captureException(error, {
        tags: { route: 'contractor.renamePassHolder', stage: 'sigur-compensation-failed' },
        extra: { passId, sigurEmployeeId: write.sigurEmployeeId, previousName: write.previousName, newName },
      });
      throw new RenameHolderError(
        502,
        `ФИО в FOT не сохранено, а в Sigur могло записаться «${newName}». Проверьте профиль Sigur №${write.sigurEmployeeId} вручную и верните «${write.previousName}».`,
      );
    }
    if (error instanceof RenameHolderError) throw error;
    throw new RenameHolderError(502, `Не удалось сохранить ФИО — ничего не изменено: ${errorText(error)}`);
  }

  if (result.employee_id != null) employeeCache.invalidate(result.employee_id);
  if (result.sigur_updated) {
    sigurService.invalidateEmployeeCache();
    invalidateSigurDirectoryCaches();
  }

  return {
    changed: result.changed,
    holder_name: result.holder_name,
    employee_updated: result.employee_updated,
    sigur_updated: result.sigur_updated,
  };
};
