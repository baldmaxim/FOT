-- AI Context Examples для TenderHUB
-- Примеры корректных SQL-запросов с учётом триггеров и бизнес-логики

-- ========================================
-- 1. СОЗДАНИЕ ТЕНДЕРА
-- ========================================
-- Тендер - основная сущность, содержит информацию о проекте
INSERT INTO public.tenders (
  title,
  client_name,
  version,
  usd_rate,
  eur_rate,
  cny_rate
) VALUES (
  'Реконструкция офисного здания',
  'ООО "СтройИнвест"',
  1,
  95.50,
  105.20,
  13.10
)
RETURNING id;

-- ========================================
-- 2. СОЗДАНИЕ БИБЛИОТЕК МАТЕРИАЛОВ И РАБОТ
-- ========================================
-- Сначала создаём наименование материала
INSERT INTO public.material_names (name, unit_code)
VALUES ('Цемент М500', 'кг')
RETURNING id;

-- Затем создаём запись в библиотеке материалов с ценами
INSERT INTO public.materials_library (
  material_name_id,
  material_price,
  material_type,
  location_id
) VALUES (
  '...', -- id из material_names
  850.00,
  'основн.',
  '...'  -- id локации
);

-- Аналогично для работ
INSERT INTO public.work_names (name, unit_code)
VALUES ('Кладка кирпича', 'м3')
RETURNING id;

INSERT INTO public.works_library (
  work_name_id,
  work_price,
  location_id
) VALUES (
  '...', -- id из work_names
  4500.00,
  '...'
);

-- ========================================
-- 3. СОЗДАНИЕ ПОЗИЦИЙ ЗАКАЗЧИКА (CLIENT POSITIONS)
-- ========================================
-- Иерархическая структура с parent_id
-- Родительская позиция (раздел)
INSERT INTO public.client_positions (
  tender_id,
  position_number,
  work_name,
  item_no,
  hierarchy_level,
  parent_id
) VALUES (
  '...', -- tender_id
  1,
  'Общестроительные работы',
  '1',
  0,
  NULL
)
RETURNING id;

-- Дочерняя позиция
INSERT INTO public.client_positions (
  tender_id,
  position_number,
  work_name,
  item_no,
  hierarchy_level,
  parent_id,
  manual_volume,
  unit_code
) VALUES (
  '...', -- tender_id
  2,
  'Кладка наружных стен',
  '1.1',
  1,
  '...', -- id родительской позиции
  450.5,
  'м3'
);

-- ========================================
-- 4. СОЗДАНИЕ BOQ ITEMS (WORKS/MATERIALS)
-- ========================================
-- BOQ item с автоматическим расчётом цен через триггеры
INSERT INTO public.boq_items (
  tender_id,
  client_position_id,
  boq_item_type,  -- 'раб', 'мат', 'суб-раб', 'суб-мат', 'раб-комп.', 'мат-комп.'
  work_library_id,
  quantity,
  sort_number
) VALUES (
  '...',  -- tender_id
  '...',  -- client_position_id
  'раб',
  '...',  -- work_library_id
  450.5,
  0
);
-- Триггер автоматически рассчитает:
-- - initial_price (из библиотеки)
-- - calculated_price (с наценками)
-- - total_price (calculated_price * quantity)

-- ========================================
-- 5. СОЗДАНИЕ СХЕМЫ НАЦЕНОК
-- ========================================
-- Тактика наценок
INSERT INTO public.markup_tactics (name, is_global)
VALUES ('Базовая схема наценок', true)
RETURNING id;

-- Параметры наценок (выполняются в порядке order_number)
INSERT INTO public.markup_parameters (
  markup_tactic_id,
  order_number,
  parameter_name,
  base_value,
  coefficient,
  is_percentage
) VALUES
  ('...', 1, 'Материалы базовые', 'Материалы', 1.15, false),
  ('...', 2, 'Работы базовые', 'Работы', 1.25, false),
  ('...', 3, 'НДС 20%', 'Итого материалов + работ', 0.20, true);

-- Привязка тактики к тендеру
UPDATE public.tenders
SET markup_tactic_id = '...'
WHERE id = '...';

-- ========================================
-- 6. ЗАПРОСЫ С УЧЁТОМ ТРИГГЕРОВ
-- ========================================
-- Получение коммерческих стоимостей позиций
SELECT
  cp.id,
  cp.work_name,
  cp.item_no,
  cp.manual_volume,
  SUM(bi.total_price) FILTER (WHERE bi.boq_item_type IN ('мат', 'суб-мат', 'мат-комп.')) AS material_cost_total,
  SUM(bi.total_price) FILTER (WHERE bi.boq_item_type IN ('раб', 'суб-раб', 'раб-комп.')) AS work_cost_total,
  SUM(bi.total_price) AS commercial_total
FROM public.client_positions cp
LEFT JOIN public.boq_items bi ON cp.id = bi.client_position_id
WHERE cp.tender_id = '...'
GROUP BY cp.id, cp.work_name, cp.item_no, cp.manual_volume
ORDER BY cp.position_number;

-- ========================================
-- 7. РАБОТА С ШАБЛОНАМИ
-- ========================================
-- Создание шаблона
INSERT INTO public.templates (name, cost_category_id)
VALUES ('Стандартная кладка стен', '...')
RETURNING id;

-- Добавление работ и материалов в шаблон
INSERT INTO public.template_items (
  template_id,
  kind,  -- 'work' или 'material'
  work_library_id,
  quantity,
  position,
  parent_id
) VALUES (
  '...',
  'work',
  '...',  -- work_library_id
  1.0,
  0,
  NULL
);

INSERT INTO public.template_items (
  template_id,
  kind,
  material_library_id,
  quantity,
  position,
  parent_work_item_id,  -- привязка материала к работе
  conversion_coefficient
) VALUES (
  '...',
  'material',
  '...',
  350.0,
  1,
  '...',  -- parent work item
  350.0   -- расход материала на единицу работы
);

-- ========================================
-- 8. ЗАТРАТЫ НА СТРОИТЕЛЬСТВО
-- ========================================
-- Создание категории затрат
INSERT INTO public.cost_categories (name, sort_number)
VALUES ('Общестроительные работы', 1)
RETURNING id;

-- Детализированная категория с локацией
INSERT INTO public.detail_cost_categories (
  category_id,
  detail_name,
  unit_code,
  location_id
) VALUES (
  '...',
  'Кладка кирпича',
  'м3',
  '...'
);

-- Объёмы работ по тендеру
INSERT INTO public.construction_cost_volumes (
  tender_id,
  detail_cost_category_id,
  work_volume
) VALUES (
  '...',
  '...',
  450.5
);

-- ========================================
-- 9. ОБНОВЛЕНИЕ С ТРИГГЕРАМИ updated_at
-- ========================================
-- При UPDATE автоматически обновляется updated_at
UPDATE public.client_positions
SET manual_volume = 500.0,
    manual_note = 'Корректировка объёма'
WHERE id = '...';
-- Триггер update_client_positions_updated_at автоматически установит updated_at = NOW()

-- ========================================
-- 10. ПЕРЕСЧЁТ КОММЕРЧЕСКИХ СТОИМОСТЕЙ
-- ========================================
-- После изменения тактики наценок пересчитать все BOQ items
UPDATE public.boq_items
SET calculated_price = initial_price -- Триггер пересчитает с новыми наценками
WHERE tender_id = '...';

-- ========================================
-- 11. ИСКЛЮЧЕНИЯ ДЛЯ РОСТА МАТЕРИАЛОВ СУБПОДРЯДА
-- ========================================
-- Создание исключения для конкретной детальной категории
INSERT INTO public.subcontract_growth_exclusions (
  markup_tactic_id,
  detail_cost_category_id,
  excluded
) VALUES (
  '...',  -- markup_tactic_id
  '...',  -- detail_cost_category_id
  true
);

-- ========================================
-- 12. КОМПЛЕКСНЫЙ ЗАПРОС: ФИНАНСОВЫЕ ПОКАЗАТЕЛИ
-- ========================================
SELECT
  t.id AS tender_id,
  t.title,
  t.client_name,
  COUNT(DISTINCT cp.id) AS positions_count,
  COUNT(bi.id) AS items_count,
  COALESCE(SUM(bi.total_amount), 0) AS base_cost,
  COALESCE(SUM(bi.total_price), 0) AS commercial_cost,
  COALESCE(SUM(bi.total_price) - SUM(bi.total_amount), 0) AS profit,
  CASE
    WHEN SUM(bi.total_amount) > 0
    THEN ((SUM(bi.total_price) - SUM(bi.total_amount)) / SUM(bi.total_amount) * 100)
    ELSE 0
  END AS profit_percentage
FROM public.tenders t
LEFT JOIN public.client_positions cp ON t.id = cp.tender_id
LEFT JOIN public.boq_items bi ON cp.id = bi.client_position_id
WHERE t.id = '...'
GROUP BY t.id, t.title, t.client_name;
