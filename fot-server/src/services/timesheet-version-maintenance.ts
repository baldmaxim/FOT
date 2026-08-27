// Операторское восстановление версий закрытых табелей.
//
// ЭТО НЕ ЧАСТЬ ПРИКЛАДНОГО ПРОЦЕССА. В штатной работе новая официальная редакция для 1С
// создаётся только при согласовании и при закрытии табеля, а закрытый табель правится
// исключительно через «Открыть → правки → Закрыть». Ни один контроллер отсюда ничего
// вызывать не должен.
//
// Модуль существует для единственного случая: содержимое закрытого табеля изменили в
// обход приложения — ручным SQL на проде или миграционным скриптом. Тогда оператор
// помечает подачу, и фоновый воркер (timesheet-version-rebuild.service.ts) пересобирает
// снимок, создавая редакцию с source='rebuild'.
//
// Функция вынесена из timesheet-version.service.ts намеренно: пока она лежала рядом с
// гардом закрытого периода, её было слишком легко снова подключить к пути записи и тем
// самым вернуть обход замка для админа.

import type { DbExecutor } from '../config/postgres.js';

/**
 * Помечает версии подач на аварийную пересборку.
 *
 * seq инкрементится, а не просто обновляется время: два изменения могут получить
 * одинаковый timestamp, и правка, пришедшая во время сборки, потерялась бы. Воркер
 * снимает метку только при совпадении seq.
 *
 * Счётчик неудач сбрасывается: новое вмешательство могло устранить причину прошлой
 * ошибки, и держать подачу под backoff'ом больше незачем.
 *
 * Помечаются только закрытые утверждённые подачи: открытую пересобирать нечего —
 * её редакция появится штатно при закрытии.
 */
export async function markVersionDirtyForOperatorRebuild(
  exec: DbExecutor,
  approvalIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(approvalIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return;

  await exec.query(
    `UPDATE timesheet_approvals
        SET version_dirty_seq          = version_dirty_seq + 1,
            version_dirty_at           = clock_timestamp(),
            version_rebuild_attempts   = 0,
            version_rebuild_after      = NULL,
            version_rebuild_last_error = NULL
      WHERE id = ANY($1::bigint[])
        AND status = 'approved'
        AND unlocked_at IS NULL`,
    [ids],
  );
}
