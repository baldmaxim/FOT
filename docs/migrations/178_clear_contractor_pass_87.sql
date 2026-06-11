-- 178: освободить «зависший» пропуск подрядчика №87 (АЛЬЯНС ООО), вернув его в
-- состояние «назначен подрядчику, ждёт ФИО» — чтобы в ЛК он отображался пустым
-- и подрядчик мог назначить его другому человеку.
--
-- Контекст: один и тот же card_uid 18229B4E00000000 по ошибке ввода присвоен
-- двум сотрудникам АЛЬЯНС ООО — Махмудову Д.Ш. (пропуск №85, sigur 143686,
-- уже applied, карта 229B4E заведена и привязана к нему) и Муллобоеву Э.Ш.
-- (пропуск №87 = id 3c6f8148-…, sigur 143688). При «Открыть пропуск» №87 Sigur
-- отвечает 422 (карта с таким value уже существует), заявка 646e4307 висит в
-- статусе partially_applied. Перепривязка недопустима — она сломала бы активного
-- Махмудова. Карта 229B4E к профилю 143688 НЕ привязана (создание упало 422),
-- поэтому в Sigur чистить нечего; карта остаётся у №85.
--
-- Сам Муллобоев Э.Ш. уже обеспечен ОТДЕЛЬНЫМ рабочим пропуском №107
-- (id 41fcacb2-…, sigur 143708, карта 1826EDA0…, applied/active) — поэтому №87
-- ему не нужен и освобождается как лишний пустой слот. №107 миграция не трогает.
--
-- Что делает миграция:
--  1) №87 → status='assigned', очищены holder_name/card_uid/submission_id и
--     признаки одобрения; org_department_id (АЛЬЯНС) и sigur_employee_id (143688)
--     сохранены — так выглядит штатный пустой assigned-пропуск (профиль 143688 —
--     переиспользуемый контейнер для следующего назначенного человека).
--  2) закрыта открытая строка держателя (valid_until=now()).
--  3) заявка 646e4307 (после ухода единственного pending-пропуска) → approved,
--     apply_error очищен.
--
-- Идемпотентно: WHERE-стражи делают повторный прогон no-op, а если подрядчик уже
-- заполнил №87 заново — миграция его НЕ затрёт (страж по status/card_uid).

-- 1) Сброс пропуска №87 в «свободный» слот того же подрядчика.
UPDATE public.contractor_passes
   SET status                = 'assigned',
       approval_status       = 'not_submitted',
       holder_name           = NULL,
       card_uid              = NULL,
       submission_id         = NULL,
       access_point_names    = NULL,
       expires_at            = NULL,
       is_active             = false,
       sigur_sync_state      = 'synced',
       sigur_sync_attempts   = 0,
       sigur_sync_error      = NULL,
       sigur_sync_updated_at = now(),
       updated_at            = now()
 WHERE id = '3c6f8148-c93e-4c94-82d9-8168fb333675'
   AND status = 'submitted'
   AND card_uid = '18229B4E00000000';

-- 2) Закрыть открытую строку держателя (Муллобоев) — освободить слот.
UPDATE public.contractor_pass_holders
   SET valid_until = now()
 WHERE pass_id = '3c6f8148-c93e-4c94-82d9-8168fb333675'
   AND valid_until IS NULL;

-- 3) Заявка больше не содержит pending → пометить разрешённой и убрать ошибку 422.
UPDATE public.contractor_submissions s
   SET status = 'approved',
       apply_error = NULL
 WHERE s.id = '646e4307-a430-460e-b8f2-5ce477afb2a6'
   AND s.status = 'partially_applied'
   AND NOT EXISTS (
     SELECT 1 FROM public.contractor_passes p
      WHERE p.submission_id = s.id
        AND p.approval_status = 'pending'
   );
