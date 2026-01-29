# AI Context для FOT

Компактные выжимки схемы БД для работы с AI-ассистентами.

## Файлы

| Файл | Назначение |
|------|-----------|
| ai_tables_min.json | Схема таблиц: колонки, типы, FK |
| ai_relations.json | Связи между таблицами |
| ai_enums_min.json | ENUM-значения |
| ai_triggers_min.json | Триггеры |
| ai_functions_min.json | Функции БД |
| ai_tables_full.json | Полная схема с индексами |
| ai_examples.sql | Примеры SQL-запросов |

## Основные таблицы

```
tenders                    # Тендеры (проекты)
  └─ client_positions      # Позиции заказчика (иерархия)
      └─ boq_items         # Элементы BOQ (работы/материалы)

materials_library          # Справочник материалов
works_library              # Справочник работ
material_names / work_names # Наименования

markup_tactics             # Тактики наценок
markup_parameters          # Параметры наценок
tender_markup_percentage   # Проценты наценок по тендеру

cost_categories            # Категории затрат
detail_cost_categories     # Детальные категории

templates / template_items # Шаблоны
units                      # Единицы измерения
```

## Связи

```
tenders
  └─ client_positions (parent_position_id → self)
      └─ boq_items
          ├─ material_names / work_names
          ├─ parent_work_item_id (материал → работа)
          └─ detail_cost_categories
```

## Использование

При работе с Supabase читай нужные файлы:
- Структура таблиц → ai_tables_min.json
- Связи → ai_relations.json
- Примеры запросов → ai_examples.sql

## Регенерация

```bash
node scripts/generate-ai-context.cjs
```
