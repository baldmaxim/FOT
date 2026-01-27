# AI Context для TenderHUB

Этот каталог содержит компактные выжимки из схемы базы данных, оптимизированные для работы с AI-ассистентами (Claude Code, GitHub Copilot и др.).

## 📁 Структура файлов

### Манифест
- **ai_manifest.json** (0.6 KB) - Метаданные генерации с SHA256-хэшами исходных файлов

### Минимальные схемы (для быстрого контекста)
- **ai_tables_min.json** (37 KB) - Компактная схема таблиц: колонки, типы, FK
- **ai_relations.json** (7 KB) - Граф связей между таблицами через Foreign Keys
- **ai_functions_min.json** (3.6 KB) - Сигнатуры функций с кратким описанием
- **ai_triggers_min.json** (3.6 KB) - Таблицы → Триггеры → Функции
- **ai_enums_min.json** (1 KB) - Перечисления и их значения

### Полные схемы (для детального анализа)
- **ai_tables_full.json** (62 KB) - Полная схема с индексами, CHECK, UNIQUE
- **ai_functions_full.json** (5.3 KB) - Функции с побочными эффектами и затрагиваемыми таблицами

### Примеры
- **ai_examples.sql** (8.8 KB) - 12 эталонных SQL-запросов с комментариями

## 🎯 Назначение файлов

| Файл | Для чего использовать |
|------|----------------------|
| ai_tables_min.json | Быстрая справка по структуре таблиц |
| ai_relations.json | Понимание связей между сущностями |
| ai_enums_min.json | Валидация значений ENUM-полей |
| ai_triggers_min.json | Понимание автоматических действий БД |
| ai_functions_min.json | Доступные функции и их назначение |
| ai_tables_full.json | Детальный анализ индексов и ограничений |
| ai_functions_full.json | Побочные эффекты функций |
| ai_examples.sql | Шаблоны корректных запросов |

## 🔄 Регенерация

```bash
node scripts/generate-ai-context.cjs
```

Скрипт автоматически:
1. Читает файлы из `supabase/exports/` и `supabase/schemas/prod.sql`
2. Генерирует компактные выжимки
3. Вычисляет SHA256-хэши для отслеживания изменений
4. Сохраняет результаты в `supabase/ai_context/`

## 📊 Ключевые таблицы

**Основные сущности:**
- `tenders` - Тендеры (проекты)
- `client_positions` - Иерархические позиции заказчика
- `boq_items` - Элементы BOQ (работы/материалы)
- `markup_tactics` + `markup_parameters` - Схемы наценок
- `materials_library` + `works_library` - Библиотеки цен

**Вспомогательные:**
- `material_names`, `work_names` - Справочники наименований
- `cost_categories`, `detail_cost_categories` - Структура затрат
- `templates`, `template_items` - Шаблоны работ/материалов
- `units` - Единицы измерения

## 🔗 Ключевые связи

```
tenders
  └─ client_positions (иерархия с parent_id)
      └─ boq_items
          ├─ works_library / materials_library
          ├─ parent_work_item_id (материалы → работы)
          └─ detail_cost_categories
```

## ⚡ Автоматизация через триггеры

**BEFORE UPDATE триггеры:**
- Обновление `updated_at` на всех основных таблицах

**Пример:** При UPDATE на `client_positions` триггер `trigger_update_client_positions_updated_at` вызывает `update_client_positions_updated_at()`, которая устанавливает `updated_at = NOW()`.

## 🎨 Бизнес-логика

1. **Наценки (Markup):**
   - Тактика (`markup_tactics`) содержит упорядоченные параметры (`markup_parameters`)
   - Параметры применяются последовательно по `order_number`
   - Результат: `boq_items.calculated_price`

2. **Иерархия позиций:**
   - `client_positions.parent_id` → самоссылка для древовидной структуры
   - Листовые узлы содержат `boq_items`

3. **Связь материалов с работами:**
   - `boq_items.parent_work_item_id` → мягкая связь (ON DELETE SET NULL)
   - `conversion_coefficient` - расход материала на единицу работы

## 📝 Типовые сценарии

См. **ai_examples.sql** для примеров:
- Создание тендера с позициями
- Добавление работ/материалов в BOQ
- Применение наценок
- Работа с шаблонами
- Расчёт финансовых показателей

## 🚀 Использование с Claude Code

Эти файлы можно подключить к контексту Claude Code для:
- Автодополнения SQL-запросов
- Валидации структуры данных
- Генерации миграций
- Понимания бизнес-логики

**Пример промпта:**
```
Используя ai_tables_min.json и ai_relations.json, создай запрос для получения
всех BOQ items с коммерческими ценами для тендера X
```

## 🔐 SHA256 Verification

Файл `ai_manifest.json` содержит хэши исходных файлов. Если хэш изменился:
1. Запустите `node scripts/generate-ai-context.cjs`
2. Проверьте изменения в git diff
3. Закоммитьте обновлённые AI-контексты

## 📦 Размеры и оптимизация

**Текущий размер:** ~130 KB (все файлы)

**Оптимизация:**
- Исключены системные схемы (auth, storage, realtime)
- Только публичные таблицы и функции
- Минимальные версии без избыточных данных
- ai_tables_min.json остается < 100 KB

---

**Автоматически сгенерировано:** `scripts/generate-ai-context.cjs`
**Версия:** 1.0.0
**Последнее обновление:** Проверьте `ai_manifest.json`
