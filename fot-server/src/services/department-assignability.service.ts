/**
 * Единая проверка «в этот отдел можно назначать сотрудников».
 *
 * Отдел, выпавший из фильтра синхронизации или удалённый в Sigur, не гасится,
 * если в нём числятся люди (иначе из дерева уходит всё поддерево, а люди — из
 * сводки подачи табеля). Такой отдел остаётся видимым и доступным для просмотра,
 * но назначать, переводить и восстанавливать в него нельзя — иначе ФОТ копил бы
 * сотрудников в отделе, который Sigur не обслуживает.
 *
 * Одна функция на все пути (создание, перевод, восстановление, добавление в
 * бригаду, батч-операции и раздел /sigur/admin/*), чтобы UI и API не расходились.
 */
import { queryOne } from '../config/postgres.js';

export interface IAssignableDepartmentRow {
  id: string;
  sigur_department_id: number | null;
  name: string;
  is_active: boolean;
  is_assignable: boolean;
}

export interface IDepartmentAssignabilityError extends Error {
  status: number;
  code: string;
}

function assignabilityError(status: number, code: string, message: string): IDepartmentAssignabilityError {
  const error = new Error(message) as IDepartmentAssignabilityError;
  error.status = status;
  error.code = code;
  return error;
}

/** Загружает отдел без фильтра по активности — для аудита и отображения истории. */
export async function loadDepartmentRow(id: string): Promise<IAssignableDepartmentRow | null> {
  return queryOne<IAssignableDepartmentRow>(
    `SELECT id, sigur_department_id, name, is_active, is_assignable
       FROM org_departments
      WHERE id = $1`,
    [id],
  );
}

/**
 * Целевой отдел операции назначения. Бросает ошибку со status/code, если отдел
 * не найден, неактивен, неназначаем или (для операций Sigur) не привязан к Sigur.
 *
 * requireSigur=false оставляет portal-only сотрудников в ручных отделах
 * (sigur_department_id IS NULL) рабочими.
 */
export async function loadAssignableTargetDepartment(
  id: string,
  options: { requireSigur?: boolean } = {},
): Promise<IAssignableDepartmentRow> {
  const row = await loadDepartmentRow(id);

  if (!row || !row.is_active) {
    throw assignabilityError(400, 'DEPARTMENT_NOT_FOUND', 'Отдел не найден или неактивен');
  }

  if (!row.is_assignable) {
    throw assignabilityError(
      409,
      'DEPARTMENT_NOT_ASSIGNABLE',
      `Отдел «${row.name}» вне синхронизации с Sigur — назначение в него невозможно.`
      + ' Добавьте его в фильтр синхронизации (Настройки СКУД → Фильтр синхронизации).',
    );
  }

  if (options.requireSigur !== false && !row.sigur_department_id) {
    throw assignabilityError(409, 'DEPARTMENT_WITHOUT_SIGUR', `У отдела «${row.name}» нет привязки к Sigur`);
  }

  return row;
}

/**
 * Проверка по sigur-id — для операций раздела Sigur (/sigur/admin/*), где отдел
 * адресуется идентификатором Sigur, а не локальным uuid.
 *
 * Раздел Sigur подчиняется тем же правилам целостности, что и остальные разделы:
 * просматривать полное дерево Sigur можно, а заводить и переводить людей — только
 * в отдел, который ФОТ синхронизирует. Исключение — архивная папка «Уволенные»:
 * через неё идёт сценарий увольнения, и она намеренно может быть вне фильтра.
 */
export async function assertSigurDepartmentAssignable(
  sigurDepartmentId: number,
  options: { archiveDepartmentId?: number | null } = {},
): Promise<void> {
  if (options.archiveDepartmentId && options.archiveDepartmentId === sigurDepartmentId) return;

  const row = await queryOne<IAssignableDepartmentRow>(
    `SELECT id, sigur_department_id, name, is_active, is_assignable
       FROM org_departments
      WHERE sigur_department_id = $1
      ORDER BY is_active DESC
      LIMIT 1`,
    [sigurDepartmentId],
  );

  if (!row || !row.is_active) {
    throw assignabilityError(
      409,
      'DEPARTMENT_NOT_MIRRORED',
      `Отдел Sigur ${sigurDepartmentId} не синхронизирован с ФОТ — назначение в него невозможно.`
      + ' Добавьте отдел в фильтр синхронизации (Настройки СКУД → Фильтр синхронизации).',
    );
  }

  if (!row.is_assignable) {
    throw assignabilityError(
      409,
      'DEPARTMENT_NOT_ASSIGNABLE',
      `Отдел «${row.name}» вне синхронизации с Sigur — назначение в него невозможно.`,
    );
  }
}

/** Тот же контракт, но без загрузки строки вызывающим. */
export async function assertDepartmentAssignable(
  id: string,
  options: { requireSigur?: boolean } = {},
): Promise<IAssignableDepartmentRow> {
  return loadAssignableTargetDepartment(id, options);
}
