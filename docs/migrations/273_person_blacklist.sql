-- 273: чёрный список физлиц.
--
-- Зачем: отклонение заявки на регистрацию физически удаляет учётку и не сохраняет
-- email даже в аудите — человек регистрируется заново без следа. На стороне СКУД
-- так же: заблокированный пропуск не мешает выписать новый на то же ФИО под другой
-- подрядной организацией. Нужен обратимый реестр, который запрещает выдачу пропуска,
-- приём на работу, запись ПДн, регистрацию и вход.
--
-- Модель:
--   * person_blacklist — сама запись. Активна, пока removed_at IS NULL. Повторное
--     внесение после снятия = НОВАЯ строка (таблица append-only), поэтому отдельная
--     таблица истории не нужна: снятые записи и есть история.
--   * person_blacklist_targets — цели исполнения: какие профили Sigur заблокировать.
--     Отдельная таблица нужна из-за durable-исполнения (Sigur может быть недоступен)
--     и потому что у одного человека бывает несколько профилей.
--   * СНИЛС хранится plain: его нужно ВИДЕТЬ в таблице, а hash необратим. Это не
--     выход за модель — employees.pension_number тоже plain (см. 259, стр. 10), и
--     сопоставление в проекте уже делается plain-сравнением (hr-profile.service.ts).
--   * employee_id — БЕЗ FK. Запись обязана переживать удаление карточки, а
--     ON DELETE SET NULL обнулил бы единственный идентификатор и сорвал
--     person_blacklist_identifier_ck. Для 97% активных сотрудников (10189 из 10526)
--     это вообще единственный доступный ключ: ни СНИЛС, ни email, ни даты рождения.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.
-- Контроль перед применением: SELECT count(*) FROM app_auth.users WHERE is_disabled;
-- (ожидаем 0 — иначе эти люди потеряют доступ, так как флагом начинает владеть ЧС).

BEGIN;

-- Канон нормализации ФИО для сопоставления.
-- ТОЧНАЯ семантика normalizeNameForHash (fot-server/src/services/hr-crypto.service.ts):
-- NFKC -> trim -> сжатие пробелов -> ё/Ё -> е -> lower. Пунктуация СОХРАНЯЕТСЯ:
-- расхождение с TS означало бы, что гейт не находит человека.
-- ВНИМАНИЕ: правка тела функции требует бэкфилла person_blacklist.full_name_norm
-- (колонка GENERATED STORED — существующие значения сами не пересчитаются).
CREATE OR REPLACE FUNCTION public.norm_person_name(txt text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(lower(regexp_replace(
           translate(btrim(normalize(coalesce(txt, ''), NFKC)), 'ёЁ', 'ее'),
           '\s+', ' ', 'g')), '')
$$;

COMMENT ON FUNCTION public.norm_person_name(text) IS
  'Нормализация ФИО для сопоставления с чёрным списком. Копия normalizeNameForHash (hr-crypto.service.ts): NFKC, trim, сжатие пробелов, ё→е, lower. Пунктуацию НЕ удаляет.';

CREATE TABLE IF NOT EXISTS public.person_blacklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Идентификация ──
  full_name text NOT NULL,
  -- GENERATED, а не запись из приложения: канон один и его нельзя нарушить ошибкой
  -- будущего writer-а. TS-нормализация используется только для входа поиска.
  full_name_norm text GENERATED ALWAYS AS (public.norm_person_name(full_name)) STORED,
  birth_date date,
  snils text,
  snils_digits text GENERATED ALWAYS AS (
    nullif(regexp_replace(coalesce(snils, ''), '\D', '', 'g'), '')) STORED,
  email text,
  email_lower text GENERATED ALWAYS AS (
    nullif(lower(btrim(coalesce(email, ''))), '')) STORED,
  passport_series_number text,
  passport_norm text GENERATED ALWAYS AS (
    nullif(lower(regexp_replace(coalesce(passport_series_number, ''), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g')), '')) STORED,
  employee_id bigint,
  user_profile_id uuid,

  -- ── Кто внёс и почему ──
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'person_pick', 'user_reject')),

  -- ── Снятие со следом ──
  removed_at timestamptz,
  removed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  removed_by_name text,
  removal_reason text,

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT person_blacklist_identifier_ck CHECK (
    employee_id IS NOT NULL OR snils_digits IS NOT NULL OR email_lower IS NOT NULL
    OR passport_norm IS NOT NULL OR birth_date IS NOT NULL),
  CONSTRAINT person_blacklist_removal_ck CHECK (
    (removed_at IS NULL AND removed_by_name IS NULL AND removal_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_by_name IS NOT NULL
        AND btrim(coalesce(removal_reason, '')) <> ''))
);

COMMENT ON TABLE public.person_blacklist IS
  'Чёрный список физлиц. Активна запись с removed_at IS NULL. Повторное внесение после снятия = НОВАЯ строка (append-only, снятые записи — история).';
COMMENT ON COLUMN public.person_blacklist.employee_id IS
  'Карточка сотрудника на момент внесения. Без FK намеренно: запись переживает удаление карточки, иначе обнуление сорвало бы identifier_ck.';
COMMENT ON COLUMN public.person_blacklist.snils IS
  'СНИЛС plain: значение должно отображаться в таблице ЧС. Источник истины employees.pension_number также plain.';

-- Уникальность только среди активных записей: снятые не мешают внести заново.
CREATE UNIQUE INDEX IF NOT EXISTS person_blacklist_active_employee_uq
  ON public.person_blacklist(employee_id) WHERE removed_at IS NULL AND employee_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS person_blacklist_active_email_uq
  ON public.person_blacklist(email_lower) WHERE removed_at IS NULL AND email_lower IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS person_blacklist_active_snils_uq
  ON public.person_blacklist(snils_digits) WHERE removed_at IS NULL AND snils_digits IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS person_blacklist_active_passport_uq
  ON public.person_blacklist(passport_norm) WHERE removed_at IS NULL AND passport_norm IS NOT NULL;

-- ФИО НЕ уникально: однофамильцы — легальная ситуация.
CREATE INDEX IF NOT EXISTS person_blacklist_active_name_idx
  ON public.person_blacklist(full_name_norm, birth_date) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS person_blacklist_active_user_idx
  ON public.person_blacklist(user_profile_id) WHERE removed_at IS NULL AND user_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_blacklist_active_created_idx
  ON public.person_blacklist(created_at DESC) WHERE removed_at IS NULL;

-- Цели исполнения: какие профили Sigur заблокировать по этой записи.
CREATE TABLE IF NOT EXISTS public.person_blacklist_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blacklist_id uuid NOT NULL REFERENCES public.person_blacklist(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('employee', 'contractor_pass')),
  -- Только блокировка профиля: пропуск и карта остаются за подрядчиком
  -- (решение заказчика — обратимость важнее). Отзыва в пул нет.
  action text NOT NULL DEFAULT 'sigur_block' CHECK (action = 'sigur_block'),
  employee_id bigint,
  pass_id uuid,
  -- bigint как в employees/contractor_passes; NOT NULL — цель без профиля неисполнима.
  sigur_employee_id bigint NOT NULL,
  match_reason text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  lease_owner text,
  lease_expires_at timestamptz,
  done_at timestamptz,
  -- Последняя успешная сверка реконсилером: профиль всё ещё заблокирован.
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_blacklist_targets_kind_ck CHECK (
    (kind = 'employee' AND employee_id IS NOT NULL AND pass_id IS NULL)
    OR (kind = 'contractor_pass' AND pass_id IS NOT NULL AND employee_id IS NULL))
);

COMMENT ON TABLE public.person_blacklist_targets IS
  'Цели блокировки в Sigur по записи ЧС. Durable: Sigur может быть недоступен, воркер добивает по lease с ретраями.';

-- БЕЗ kind в ключе: 6515 профилей Sigur встречаются и в employees, и в
-- contractor_passes (держатели пропусков продублированы как сотрудники) — иначе
-- один и тот же профиль попал бы в очередь дважды.
CREATE UNIQUE INDEX IF NOT EXISTS person_blacklist_targets_uq
  ON public.person_blacklist_targets(blacklist_id, sigur_employee_id);
CREATE INDEX IF NOT EXISTS person_blacklist_targets_queue_idx
  ON public.person_blacklist_targets(state, lease_expires_at, updated_at)
  WHERE state IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS person_blacklist_targets_verify_idx
  ON public.person_blacklist_targets(verified_at) WHERE state = 'done';

-- Флагом is_disabled с этой миграции владеет чёрный список: значение вычисляется
-- как «существует активная запись на этого пользователя» (см. applyAccountLock).
COMMENT ON COLUMN app_auth.users.is_disabled IS
  'Владелец флага — чёрный список (миграция 273): значение = существует ли активная запись person_blacklist на этого пользователя. Вручную не выставлять.';

COMMIT;
