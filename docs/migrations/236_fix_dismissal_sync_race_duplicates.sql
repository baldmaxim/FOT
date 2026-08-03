-- ============================================================================
-- Миграция 236: устранение последствий гонки «увольнение ↔ Sigur-синк»
-- ============================================================================
--
-- Симптом (кейс Сафарова 1623 / бр.Вохидова Ш.А., 31.07.2026): увольнение,
-- применённое планировщиком в 23:00+, закрывает реальный отдел по D включительно
-- и создаёт «Уволенные [D+1..∞]». Sigur-синк, тикнувший следом, работал по
-- устаревшему in-memory снимку сотрудников, принимал перенос за неучтённый и
-- оформлял его «сегодняшним днём»: обрезал реальный отдел до D-1 и вставлял
-- дубль «Уволенные [D..D]». В табеле это даёт «Пер. D» вместо «Пер. D+1» —
-- последний рабочий день выпадает из членства и не корректируется.
--
-- Код-фикс гонки (decideDeptSyncAction + skipIfScheduledToTarget + claim) должен
-- быть ЗАДЕПЛОЕН ДО применения миграции — иначе ближайшая ночь с увольнениями
-- наплодит новые дубли.
--
-- Что делает миграция (одна транзакция):
--   1) pinned-набор из 54 троек (dup/prev/next), зафиксированных preflight'ом
--      03.08.2026 по окну 01.07–31.07 (августовских случаев на 03.08 нет);
--   2) каждая тройка повторно валидируется против живых данных; повторный
--      запуск даёт 0 кандидатов и завершается no-op;
--   3) блокировка затронутых строк FOR UPDATE в стабильном порядке;
--   4) backup полных строк в public.migration_236_backup (переживает COMMIT);
--   5) DELETE дублей [D..D];
--   6) UPDATE prev.effective_to: D-1 → D (возврат последнего рабочего дня);
--   7) постусловия по каждой тройке + отсутствие пересечений.
--
-- ROLLBACK (после COMMIT), если потребуется вернуть как было:
--   INSERT INTO employee_assignments
--   SELECT (jsonb_populate_record(NULL::employee_assignments, row_data)).*
--     FROM migration_236_backup
--    WHERE migration_name = '236' AND kind = 'dup_assignment';
--   UPDATE employee_assignments p
--      SET effective_to = (b.row_data->>'effective_to')::date, updated_at = now()
--     FROM migration_236_backup b
--    WHERE b.migration_name = '236' AND b.kind = 'prev_assignment'
--      AND p.id = (b.row_data->>'id')::uuid;
--
-- После применения: сбросить кэш ответов табеля (или подождать ≤5 минут TTL).
-- ============================================================================

BEGIN;

-- Backup-таблица (постоянная): точный снимок изменяемых строк до миграции.
CREATE TABLE IF NOT EXISTS public.migration_236_backup (
  row_id         bigserial PRIMARY KEY,
  migration_name text        NOT NULL,
  run_id         uuid        NOT NULL,
  migrated_at    timestamptz NOT NULL DEFAULT now(),
  kind           text        NOT NULL,
  source_id      text        NOT NULL, -- text: uuid назначений и числовые employees.id
  row_data       jsonb       NOT NULL,
  UNIQUE (migration_name, kind, source_id)
);

-- 1) Pinned-набор (preflight 03.08.2026, N = 54; Сафаров 1623 — последняя строка).
CREATE TEMP TABLE tmp_pinned (
  dup_id      uuid NOT NULL,
  prev_id     uuid NOT NULL,
  next_id     uuid NOT NULL,
  employee_id int  NOT NULL,
  d           date NOT NULL
) ON COMMIT DROP;

INSERT INTO tmp_pinned (dup_id, prev_id, next_id, employee_id, d) VALUES
  ('6d55de9f-bbe2-44a0-8cab-5e566fafcf8d'::uuid, 'ab9840a2-00c6-4af9-a6b6-472744d11384'::uuid, '2ca26dc1-e868-40df-aa78-0ef50efdbc7d'::uuid, 8908, '2026-07-01'::date),
  ('a30629a8-f53b-4003-a99a-71d88ecad125'::uuid, '2894d3a3-536b-4082-ae4d-acdfbe346409'::uuid, '4e014fb7-968b-427a-8208-c6c13b2590e4'::uuid, 1570, '2026-07-09'::date),
  ('80815146-30f8-40f4-aaa1-3d67d6c5f806'::uuid, 'af0f9495-7e34-4037-8008-11a700a54f53'::uuid, '1916dbab-bc2d-4303-aba4-86ece7d2cc4c'::uuid, 1277, '2026-07-13'::date),
  ('54894ec8-8c22-43c5-93c1-ad378d82b60a'::uuid, '851a1904-bdf2-4e2a-b800-5359453bd9c0'::uuid, 'cc8d88f1-e770-47ef-8853-6a2a5b6561d7'::uuid, 584, '2026-07-14'::date),
  ('13f67f16-e858-428a-a076-7d338ae6d86e'::uuid, '782c99df-637e-4bae-82a9-58f427f04f10'::uuid, '8a36a624-406c-4d85-825e-ea4108f62bfc'::uuid, 693, '2026-07-16'::date),
  ('8a3d29ea-dace-4989-96b0-538f067f6cc5'::uuid, 'e891e566-d740-4111-93eb-a9302e08e501'::uuid, 'e43fd14b-1cda-4770-a2a3-3ea1a0df043a'::uuid, 1060, '2026-07-16'::date),
  ('77aa91d3-041e-4c3e-83ae-4c7b339c4464'::uuid, 'c8f16169-cfd1-44ea-b634-c08dc59b680f'::uuid, '3420639c-bc19-487d-bf5e-6fb33a4913e0'::uuid, 1154, '2026-07-16'::date),
  ('67139dec-5355-44d8-8e49-f44666020a85'::uuid, '5375fee9-87e3-4019-8090-a0acbe87b306'::uuid, 'fab55abc-e6e0-4a06-b8ae-d4816e74fa8a'::uuid, 1242, '2026-07-16'::date),
  ('09301201-9252-4f72-baa6-a73c0abc5552'::uuid, '920840ac-5e18-4a26-a3ed-e78359b61c4a'::uuid, '1d9d836a-faa9-4b32-85c2-fa0e32a49b5b'::uuid, 2033, '2026-07-16'::date),
  ('375ac0e2-bef8-4125-b2be-034550aefb2f'::uuid, '70e1ef60-6f57-43e1-b9a0-94a242b19092'::uuid, '329ce72a-7029-4c78-968a-9cc39aadb824'::uuid, 2141, '2026-07-16'::date),
  ('433e5611-8b60-478f-8bbb-62eee1ab1c5e'::uuid, '5763c8c8-a932-40a7-99b6-01cfafaf4d57'::uuid, '9baded34-568a-4131-b14a-b6d6463ded35'::uuid, 660, '2026-07-17'::date),
  ('6fbb1445-4492-452e-98f8-c2c50acc4e01'::uuid, '7a9dff87-7218-4c84-aa45-a244f0961654'::uuid, '3f3df827-0da3-4fa0-b01f-79f25bfb7db3'::uuid, 596, '2026-07-21'::date),
  ('e04ba32a-a66f-4333-b2da-0fb4b6b38d2c'::uuid, '6ec93cc0-26ad-4411-938c-51adec045d41'::uuid, '5bb71325-ce75-401d-84c8-0eaea8238308'::uuid, 1249, '2026-07-21'::date),
  ('622991cd-1055-4829-a88a-a6095eec0077'::uuid, '8f3513b3-52cc-4dc7-afbf-24ebbca13c11'::uuid, '45cc638f-e228-47c7-931d-76477dd9f660'::uuid, 3627, '2026-07-21'::date),
  ('120692df-94c2-4218-b184-7282135f6cb2'::uuid, 'e5a507e5-90d8-4fc5-a023-2bf61e82bf24'::uuid, '7583481d-ba56-448d-ba7c-67bdbd508286'::uuid, 3839, '2026-07-21'::date),
  ('d8b9e592-a9c3-4b2f-9144-b185a6546912'::uuid, 'c4c378b5-93cf-4429-84f6-3d9e017158f3'::uuid, 'c8928624-5d3e-4822-bb5b-80dc75bfdab4'::uuid, 4376, '2026-07-21'::date),
  ('88760dcb-286f-4b4a-b417-6d6ab0def8b7'::uuid, '429096df-7d56-461a-8bb8-a665c03a0a07'::uuid, 'f18ffdcf-8dd4-4c83-9ff3-32b4d56d657e'::uuid, 5409, '2026-07-21'::date),
  ('1ed0fe63-924a-4ca4-9505-65d7064f7cf5'::uuid, '76aea58a-41dd-4a80-9636-028dcf587977'::uuid, '6d1060ca-0494-4fbc-8337-8912dbab1e39'::uuid, 5485, '2026-07-21'::date),
  ('ab07ddd8-01d3-4985-babb-5d98dde31141'::uuid, 'b6f312e8-6e19-44e0-a185-499703881eed'::uuid, 'dbfec7fa-1bd3-47c9-990a-3fa2ec4f65a0'::uuid, 5917, '2026-07-21'::date),
  ('bae21dc1-ec7b-45d2-9c2e-ae9561891811'::uuid, '0e8b11db-ef8d-4ae9-84a8-037bc303053e'::uuid, '231280f0-5d9e-4bcd-b98b-c0790c35dfa2'::uuid, 6030, '2026-07-21'::date),
  ('110c6611-4823-4e8f-b48d-5decccce2c87'::uuid, '01b120fd-65e2-40a0-8ca3-a55b7b29be4c'::uuid, '64d7954d-0369-43e0-b2f7-4b1b19682ce1'::uuid, 8703, '2026-07-21'::date),
  ('4ba497af-97a8-46ec-9798-45555b79c6ac'::uuid, '0a12dee9-2054-4a5e-b49f-b31ed7bb3a1f'::uuid, 'edf9ed62-f850-45b8-be9c-4205dd2e453a'::uuid, 259, '2026-07-22'::date),
  ('34f31cb8-622d-441c-b33c-f998389dc2d6'::uuid, '3dbaadc2-3454-4b43-a945-c153ddcc8fdb'::uuid, '34fda391-b948-446d-ab85-3e56366c7e11'::uuid, 1848, '2026-07-22'::date),
  ('c93062b0-99dc-4e22-9f52-aa2167b27f94'::uuid, '1b29ba9e-7dc1-461b-b679-92d2c90939bf'::uuid, '5e6a20f6-5da3-4c52-8819-decbe61553bd'::uuid, 2691, '2026-07-22'::date),
  ('f5c90365-6b9f-4e70-bd0d-cfb471bd9515'::uuid, '4e9fae75-e5ba-4963-84f2-3f896b084ab3'::uuid, 'fae9d129-2370-4a4f-985f-32e9f729574d'::uuid, 2695, '2026-07-22'::date),
  ('7680ffa0-803e-4645-908f-9c54dafcb5b5'::uuid, '0c20a9cd-57ea-4035-ae0e-38365757a438'::uuid, '94d40b33-b8cd-48a2-b238-005162ad23e1'::uuid, 2704, '2026-07-22'::date),
  ('060b4b27-29a0-45e2-81ce-1955a26c386a'::uuid, '126b3ae7-b658-4689-a6f6-9a786f780d9d'::uuid, '1be1d689-97fc-400f-8632-0aa139ffa1d5'::uuid, 2793, '2026-07-22'::date),
  ('9aee3412-6db7-4021-af1a-eb0015c89a8f'::uuid, 'e761e620-01b1-4ac5-91d7-46ad0d45baa4'::uuid, 'adf17168-acfa-4de9-bd2d-4dc8be628633'::uuid, 2794, '2026-07-22'::date),
  ('ce236963-ad69-41bc-8a52-0af0357ffe6a'::uuid, '0e91eee1-a140-4fc5-97b0-0ed8a1fa5395'::uuid, '69c7eb53-7485-400b-bd5b-41f17f80184c'::uuid, 2795, '2026-07-22'::date),
  ('e088f222-35b9-4cd3-960d-9ee79d97975c'::uuid, '4f5c4456-ae3c-4ca6-9f9d-7a009a335803'::uuid, '916b5f96-206c-4baf-9862-606a5006534f'::uuid, 2892, '2026-07-22'::date),
  ('15863ce2-d55e-4291-9f95-a4d2e1fda144'::uuid, 'fb1d4ab9-35a6-4d59-8e45-25bd7379204d'::uuid, '33e1590e-a3b8-4b9c-b6f0-c695a37f8073'::uuid, 2897, '2026-07-22'::date),
  ('009314fa-157d-4fa0-a357-9815755e3a05'::uuid, '26ffb13f-f21c-4105-b1a7-2d233e30e866'::uuid, 'da31df69-608b-42c9-adec-d36eb9667fbf'::uuid, 2910, '2026-07-22'::date),
  ('755ce4c4-52e0-4cbb-aa67-4e9115403061'::uuid, '6cb69037-adab-48c0-8530-1967f33eb4a7'::uuid, 'fc863bb9-939b-4013-898f-a0db3baf5527'::uuid, 3011, '2026-07-22'::date),
  ('5320381f-755c-403b-9c0e-f38a1863d13f'::uuid, 'fada9d36-2943-4b35-b128-ef18f26dadbc'::uuid, '3bbebf34-04ae-4af7-ab9f-0b1fc07ea2b6'::uuid, 3012, '2026-07-22'::date),
  ('7755fb89-b8f9-4f8c-b469-3c82ec98e49f'::uuid, 'a82262e8-7ee1-4d7e-93e0-2a98a6debdd2'::uuid, '0d7c10cc-e108-4911-a35e-2981db819780'::uuid, 4174, '2026-07-22'::date),
  ('2c026f80-babf-4c67-8c71-ab41eedbae3e'::uuid, 'ed60070c-90a9-4e52-b0b0-5587b11790ae'::uuid, '6543be66-9119-4f95-868e-593989b140d8'::uuid, 5155, '2026-07-22'::date),
  ('041984c9-7be7-40ce-bee1-7932496482e1'::uuid, 'b9eb02ab-efd0-4dbb-a766-a4da5817ba26'::uuid, 'c85fedb8-10ba-46c5-8a53-3938beac6c9e'::uuid, 5919, '2026-07-22'::date),
  ('ce16a0ad-4f34-4b1d-bddf-1fbb904bc47f'::uuid, '5f6b62fc-8dd4-4be5-a18a-d18c647bc33a'::uuid, 'f08e37fe-6cfc-48be-8cfe-8ec7614582f9'::uuid, 6430, '2026-07-22'::date),
  ('ae41527d-cb3a-4f58-8f1d-082689ef03d4'::uuid, '7df41f92-e3d2-4e6e-84a4-2f038904820f'::uuid, '56e07d26-e9c5-449c-aa28-60bbc9212b04'::uuid, 5, '2026-07-27'::date),
  ('a2da199e-f167-4b8c-b505-263d2d881054'::uuid, '8a375b4a-faa4-492a-8f91-dd45da823264'::uuid, '271185c9-685e-46da-94ba-ac7fe97cda63'::uuid, 186, '2026-07-27'::date),
  ('c00f9b15-732a-41a8-a37b-08777738bba5'::uuid, '3a648ae5-f032-4271-9d67-1c45946c9653'::uuid, '1b70461d-0b2d-439b-8abc-e29978d68a8f'::uuid, 190, '2026-07-27'::date),
  ('2b21a011-7602-43be-9a2f-af3e3cc43e1c'::uuid, 'd8497f7e-4314-479e-bca8-9fb4acb6a253'::uuid, '0890ec72-7f87-410f-856a-d2360af49ba5'::uuid, 930, '2026-07-27'::date),
  ('c3b3df86-abe3-4767-8fcf-d56d2bb312dd'::uuid, 'fb8b55d9-a9a5-4442-980d-bad302b467c1'::uuid, '639aaee2-8dec-4f05-97a7-1a44125b4670'::uuid, 1819, '2026-07-27'::date),
  ('bf4ed80b-92ae-4ef7-a76b-c6ee887004cd'::uuid, '79e0ffce-f9ac-41a1-adfb-c7fd3e0db47b'::uuid, '7be9dddc-0656-497f-8eb8-8ea84955e54d'::uuid, 1843, '2026-07-27'::date),
  ('5838767c-1c8f-4935-9788-81d24cfb7b87'::uuid, '5f0374a7-7ce2-4f99-9b25-1ec8ea21ebd9'::uuid, '83f60141-f82a-48a3-ac44-fb1ca8e88efc'::uuid, 2134, '2026-07-27'::date),
  ('6222d7cc-e885-46bf-926c-6f807ec1ee35'::uuid, 'ceedbfd0-36ca-4675-bfeb-2aac3752eaed'::uuid, 'e807a098-741e-4611-8579-45c6f588fdae'::uuid, 2446, '2026-07-27'::date),
  ('6c182db4-e277-406a-8586-c12462b2e655'::uuid, '8e3b4f2a-58d8-486b-914b-2e066914771c'::uuid, '73819f05-dd82-4f91-8806-2cb2b5de1f85'::uuid, 2557, '2026-07-27'::date),
  ('6df04008-d692-4a92-b7ef-a3d034e227a3'::uuid, 'cd791953-7e27-4f41-83e1-13e0fb586502'::uuid, '6c6eaef0-5a4c-45c2-ac16-003d58aa007e'::uuid, 11197, '2026-07-27'::date),
  ('023eace1-d4cb-4e05-9f55-e4051f6cc133'::uuid, '635e299b-9718-4741-b446-3fec3fa28c6b'::uuid, '794c9254-0c98-462a-847b-a3a57bb89858'::uuid, 12289, '2026-07-27'::date),
  ('924b02dd-133c-48c5-b496-0cf943f36755'::uuid, '7cf3372d-2462-48c4-b944-25c84c4311d4'::uuid, '2056d31b-dca7-4e86-b21e-fa26903b06af'::uuid, 647, '2026-07-30'::date),
  ('0d2ffdc8-08e3-48d0-ade5-650ed4ea97d0'::uuid, 'fce31fb3-0562-4659-a99f-80059c6b0455'::uuid, '3350f1c4-dc0d-41dd-9668-248a1e45648f'::uuid, 2351, '2026-07-30'::date),
  ('44de2328-2c7a-4376-acb5-fecd0dcb5bb8'::uuid, '59f3a048-bfae-47c9-8683-cbdb53055b21'::uuid, '93a1f41b-bcfe-490a-9dc4-d50e88579ca7'::uuid, 565, '2026-07-31'::date),
  ('78a7ffe8-8034-461e-9363-2178b2ef5a18'::uuid, '8e710aa6-6502-41a0-915e-34592724ed19'::uuid, '093b3270-c5bf-4f33-b090-3cc06deca307'::uuid, 1190, '2026-07-31'::date),
  ('7fe6609f-6f24-4c01-b6db-ce8ed1682e9f'::uuid, '15ef5968-c586-4778-b733-1baebccb555e'::uuid, 'f6a46dbb-f7d3-48fa-9c9f-47c28216910f'::uuid, 1623, '2026-07-31'::date);

-- 2) Действующие кандидаты: pinned ∩ живой паттерн гонки.
--    Повторный запуск: дубли уже удалены → JOIN на dup отваливается → 0 строк (no-op).
CREATE TEMP TABLE tmp_race_fix ON COMMIT DROP AS
SELECT p.dup_id, p.prev_id, p.next_id, p.employee_id, p.d,
       prevr.org_department_id AS prev_dept_id
FROM tmp_pinned p
JOIN employee_assignments dup ON dup.id = p.dup_id
  AND dup.employee_id = p.employee_id
  AND dup.effective_from = p.d
  AND dup.effective_to = p.d
  AND dup.org_department_id = 'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc'::uuid
  AND dup.change_reason IN ('Синхронизация Sigur', 'Увольнение — перевод в папку "Уволенные"')
JOIN employee_assignments prevr ON prevr.id = p.prev_id
  AND prevr.employee_id = p.employee_id
  AND prevr.effective_to = p.d - 1
  AND prevr.org_department_id <> dup.org_department_id
JOIN employee_assignments nextr ON nextr.id = p.next_id
  AND nextr.employee_id = p.employee_id
  AND nextr.org_department_id = dup.org_department_id
  AND nextr.effective_from = p.d + 1
  AND nextr.change_reason = 'Увольнение — перевод в папку "Уволенные"'
JOIN employees e ON e.id = p.employee_id
  AND e.employment_status = 'fired'
  AND e.dismissal_date = p.d
  AND e.org_department_id = dup.org_department_id
WHERE EXISTS (
  SELECT 1 FROM employee_dismissal_events ede
   WHERE ede.employee_id = p.employee_id
     AND ede.dismissal_date = p.d
     AND ede.from_department_id = prevr.org_department_id
);

-- 3) Предусловия: настройка архива, N или 0, частичное совпадение запрещено.
DO $$
DECLARE
  v_pinned int;
  v_expected int;
  v_archive text;
BEGIN
  SELECT count(*) INTO v_pinned FROM tmp_pinned;
  IF v_pinned <> 54 THEN
    RAISE EXCEPTION 'МИГРАЦИЯ 236: pinned-набор повреждён: % строк вместо 54', v_pinned;
  END IF;

  SELECT value INTO v_archive FROM system_settings WHERE key = 'employees_archive_department_id';
  IF v_archive IS DISTINCT FROM 'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc' THEN
    RAISE EXCEPTION 'МИГРАЦИЯ 236: employees_archive_department_id = % — не совпадает с зашитым архивом', v_archive;
  END IF;

  SELECT count(*) INTO v_expected FROM tmp_race_fix;
  IF v_expected NOT IN (54, 0) THEN
    RAISE EXCEPTION 'МИГРАЦИЯ 236: кандидатов % — ожидалось 54 (первый запуск) или 0 (повторный). Данные изменились, нужен новый preflight.', v_expected;
  END IF;

  RAISE NOTICE 'МИГРАЦИЯ 236: кандидатов к исправлению: %', v_expected;
END $$;

-- 4) Блокировка затронутых строк в стабильном порядке (исключает изменение
--    между preflight и DELETE/UPDATE).
DO $$
BEGIN
  PERFORM 1 FROM employees
    WHERE id IN (SELECT employee_id FROM tmp_race_fix)
    ORDER BY id
    FOR UPDATE;
  PERFORM 1 FROM employee_assignments
    WHERE id IN (
      SELECT dup_id FROM tmp_race_fix
      UNION ALL SELECT prev_id FROM tmp_race_fix
      UNION ALL SELECT next_id FROM tmp_race_fix
    )
    ORDER BY id
    FOR UPDATE;
END $$;

-- 5) Backup ДО изменений (переживает COMMIT; restore-SQL — в шапке файла).
CREATE TEMP TABLE tmp_run ON COMMIT DROP AS SELECT gen_random_uuid() AS run_id;

INSERT INTO public.migration_236_backup (migration_name, run_id, kind, source_id, row_data)
SELECT '236', r.run_id, k.kind, k.source_id, k.row_data
FROM tmp_run r
CROSS JOIN LATERAL (
  SELECT 'dup_assignment' AS kind, a.id::text AS source_id, to_jsonb(a) AS row_data
    FROM employee_assignments a WHERE a.id IN (SELECT dup_id FROM tmp_race_fix)
  UNION ALL
  SELECT 'prev_assignment', a.id::text, to_jsonb(a)
    FROM employee_assignments a WHERE a.id IN (SELECT prev_id FROM tmp_race_fix)
  UNION ALL
  SELECT 'next_assignment', a.id::text, to_jsonb(a)
    FROM employee_assignments a WHERE a.id IN (SELECT next_id FROM tmp_race_fix)
  UNION ALL
  SELECT 'employee', e.id::text, to_jsonb(e)
    FROM employees e WHERE e.id IN (SELECT employee_id FROM tmp_race_fix)
  UNION ALL
  SELECT 'dismissal_event', ede.id::text, to_jsonb(ede)
    FROM employee_dismissal_events ede
   WHERE (ede.employee_id, ede.dismissal_date) IN (SELECT employee_id, d FROM tmp_race_fix)
) k
ON CONFLICT (migration_name, kind, source_id) DO NOTHING;

-- 6) DELETE дублей [D..D] — строго ДО расширения prev (иначе BEFORE-триггер
--    ensure_no_overlapping_employee_assignments увидит пересечение).
DO $$
DECLARE
  v_expected int;
  v_deleted int;
BEGIN
  SELECT count(*) INTO v_expected FROM tmp_race_fix;

  DELETE FROM employee_assignments WHERE id IN (SELECT dup_id FROM tmp_race_fix);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_expected THEN
    RAISE EXCEPTION 'МИГРАЦИЯ 236: DELETE удалил % строк вместо %', v_deleted, v_expected;
  END IF;
END $$;

-- 7) Возврат последнего рабочего дня: prev.effective_to D-1 → D.
DO $$
DECLARE
  v_expected int;
  v_updated int;
BEGIN
  SELECT count(*) INTO v_expected FROM tmp_race_fix;

  UPDATE employee_assignments p
     SET effective_to = t.d, updated_at = now()
    FROM tmp_race_fix t
   WHERE p.id = t.prev_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'МИГРАЦИЯ 236: UPDATE изменил % строк вместо %', v_updated, v_expected;
  END IF;
END $$;

-- 8) Постусловия по строкам tmp_race_fix.
DO $$
DECLARE
  v_bad int;
BEGIN
  -- Каждый дубль удалён.
  SELECT count(*) INTO v_bad FROM employee_assignments WHERE id IN (SELECT dup_id FROM tmp_race_fix);
  IF v_bad > 0 THEN RAISE EXCEPTION 'МИГРАЦИЯ 236: % дублей не удалено', v_bad; END IF;

  -- Каждый prev заканчивается ровно D.
  SELECT count(*) INTO v_bad
    FROM tmp_race_fix t
    JOIN employee_assignments p ON p.id = t.prev_id
   WHERE p.effective_to IS DISTINCT FROM t.d;
  IF v_bad > 0 THEN RAISE EXCEPTION 'МИГРАЦИЯ 236: % prev-строк не заканчиваются на D', v_bad; END IF;

  -- Каждый next не изменился: начинается D+1 в архиве.
  SELECT count(*) INTO v_bad
    FROM tmp_race_fix t
    JOIN employee_assignments n ON n.id = t.next_id
   WHERE n.effective_from IS DISTINCT FROM t.d + 1
      OR n.org_department_id IS DISTINCT FROM 'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc'::uuid;
  IF v_bad > 0 THEN RAISE EXCEPTION 'МИГРАЦИЯ 236: % next-строк изменены', v_bad; END IF;

  -- Снапшот сотрудника и увольнение не изменились.
  SELECT count(*) INTO v_bad
    FROM tmp_race_fix t
    JOIN employees e ON e.id = t.employee_id
   WHERE e.employment_status <> 'fired'
      OR e.dismissal_date IS DISTINCT FROM t.d
      OR e.org_department_id IS DISTINCT FROM 'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc'::uuid;
  IF v_bad > 0 THEN RAISE EXCEPTION 'МИГРАЦИЯ 236: % сотрудников изменили статус/дату/отдел', v_bad; END IF;

  -- Событие увольнения на месте.
  SELECT count(*) INTO v_bad
    FROM tmp_race_fix t
   WHERE NOT EXISTS (
     SELECT 1 FROM employee_dismissal_events ede
      WHERE ede.employee_id = t.employee_id
        AND ede.dismissal_date = t.d
        AND ede.from_department_id = t.prev_dept_id
   );
  IF v_bad > 0 THEN RAISE EXCEPTION 'МИГРАЦИЯ 236: % dismissal-событий пропало', v_bad; END IF;

  -- Пересечений диапазонов у затронутых сотрудников нет.
  SELECT count(*) INTO v_bad
    FROM employee_assignments a
    JOIN employee_assignments b
      ON b.employee_id = a.employee_id
     AND b.id <> a.id
     AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
      && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]')
   WHERE a.employee_id IN (SELECT employee_id FROM tmp_race_fix);
  IF v_bad > 0 THEN RAISE EXCEPTION 'МИГРАЦИЯ 236: обнаружены пересечения диапазонов (% пар)', v_bad; END IF;

  RAISE NOTICE 'МИГРАЦИЯ 236: постусловия пройдены';
END $$;

COMMIT;

-- ============================================================================
-- Диагностический отчёт (вне транзакции, read-only): остались ли строки паттерна.
-- Это НЕ условие фиксации — сюда могут попасть намеренно исключённые случаи.
-- ============================================================================
SELECT e.id AS employee_id, e.full_name, dup.effective_from AS d,
       dup.id AS dup_id, dup.change_reason
FROM employee_assignments dup
JOIN employees e ON e.id = dup.employee_id
JOIN employee_assignments nextr ON nextr.employee_id = dup.employee_id
  AND nextr.org_department_id = dup.org_department_id
  AND nextr.effective_from = dup.effective_from + 1
JOIN employee_assignments prevr ON prevr.employee_id = dup.employee_id
  AND prevr.effective_to = dup.effective_from - 1
  AND prevr.org_department_id <> dup.org_department_id
WHERE dup.effective_from = dup.effective_to
ORDER BY dup.effective_from DESC, e.id;
