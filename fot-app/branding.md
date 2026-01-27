# Branding Guidelines — ФОТ

## Цветовая палитра

### Тёмная тема (по умолчанию)

| Название | HEX | Использование |
|----------|-----|---------------|
| bg-primary | `#0a0a0b` | Основной фон |
| bg-secondary | `#111113` | Фон sidebar, header, карточек |
| bg-tertiary | `#18181b` | Фон элементов, hover |
| bg-elevated | `#1f1f23` | Приподнятые элементы |
| border | `#27272a` | Границы |
| border-subtle | `#1e1e21` | Тонкие разделители |
| text-primary | `#fafafa` | Основной текст |
| text-secondary | `#a1a1aa` | Вторичный текст |
| text-tertiary | `#71717a` | Третичный текст, плейсхолдеры |

### Светлая тема

| Название | HEX | Использование |
|----------|-----|---------------|
| bg-primary | `#ffffff` | Основной фон |
| bg-secondary | `#fafafa` | Фон sidebar, header, карточек |
| bg-tertiary | `#f4f4f5` | Фон элементов, hover |
| bg-elevated | `#e4e4e7` | Приподнятые элементы |
| border | `#e4e4e7` | Границы |
| border-subtle | `#f4f4f5` | Тонкие разделители |
| text-primary | `#09090b` | Основной текст |
| text-secondary | `#52525b` | Вторичный текст |
| text-tertiary | `#a1a1aa` | Третичный текст, плейсхолдеры |

### Акцентные цвета

| Название | Dark | Light | Использование |
|----------|------|-------|---------------|
| accent | `#3b82f6` | `#2563eb` | Основной акцент, кнопки, ссылки |
| accent-muted | `rgba(59, 130, 246, 0.1)` | `rgba(37, 99, 235, 0.08)` | Фон акцентных элементов |

### Семантические цвета

| Название | Dark | Light | Использование |
|----------|------|-------|---------------|
| success | `#22c55e` | `#16a34a` | Успешные действия |
| success-muted | `rgba(34, 197, 94, 0.1)` | `rgba(22, 163, 74, 0.08)` | Фон успешных элементов |
| warning | `#f59e0b` | `#d97706` | Предупреждения |
| warning-muted | `rgba(245, 158, 11, 0.1)` | `rgba(217, 119, 6, 0.08)` | Фон предупреждений |
| error | `#ef4444` | `#dc2626` | Ошибки |
| error-muted | `rgba(239, 68, 68, 0.1)` | `rgba(220, 38, 38, 0.08)` | Фон ошибок |

## Типографика

### Шрифты

```css
--font-primary: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;
```

### Размеры шрифтов

| Название | Размер | Line Height | Использование |
|----------|--------|-------------|---------------|
| xs | 11px | 16px | Badges, метки |
| sm | 12px | 16px | Мелкий текст, подписи |
| base | 13px | 20px | Навигация, карточки |
| md | 14px | 20px | Основной текст |
| lg | 15px | 24px | Заголовки секций |
| xl | 28px | 36px | Большие числа (статистика) |

### Насыщенность

- `400` - Regular (основной текст)
- `500` - Medium (навигация, акценты)
- `600` - Semi Bold (заголовки карточек)
- `700` - Bold (большие числа, заголовки)

## Отступы и скругления

### Spacing

```css
--spacing-1: 4px;
--spacing-2: 8px;
--spacing-3: 12px;
--spacing-4: 16px;
--spacing-5: 20px;
--spacing-6: 24px;
--spacing-8: 32px;
```

### Border Radius

```css
--radius-sm: 4px;
--radius-md: 6px;
--radius-lg: 8px;
--radius-xl: 12px;
```

## Компоненты

### Sidebar
- Ширина: `240px`
- Фон: `bg-secondary`
- Высота: `100vh`, фиксированная позиция

### Header
- Высота: `60px`
- Фон: `bg-secondary`
- sticky позиция

### Карточки
- Фон: `bg-secondary`
- Граница: `1px solid border`
- Скругление: `12px`
- Padding header: `16px 20px`

### Кнопки
- Высота: `36px`
- Скругление: `8px`
- Primary: фон `accent`, текст белый

### Статистика
- Размер числа: `28px`
- Насыщенность: `700`
- Letter-spacing: `-1px`

## CSS Variables

```css
:root {
  /* Dark Theme (default) */
  --bg-primary: #0a0a0b;
  --bg-secondary: #111113;
  --bg-tertiary: #18181b;
  --bg-elevated: #1f1f23;
  --border: #27272a;
  --border-subtle: #1e1e21;
  --text-primary: #fafafa;
  --text-secondary: #a1a1aa;
  --text-tertiary: #71717a;
  --accent: #3b82f6;
  --accent-muted: rgba(59, 130, 246, 0.1);
  --success: #22c55e;
  --success-muted: rgba(34, 197, 94, 0.1);
  --warning: #f59e0b;
  --warning-muted: rgba(245, 158, 11, 0.1);
  --error: #ef4444;
  --error-muted: rgba(239, 68, 68, 0.1);

  /* Typography */
  --font-primary: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
}

[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #fafafa;
  --bg-tertiary: #f4f4f5;
  --bg-elevated: #e4e4e7;
  --border: #e4e4e7;
  --border-subtle: #f4f4f5;
  --text-primary: #09090b;
  --text-secondary: #52525b;
  --text-tertiary: #a1a1aa;
  --accent: #2563eb;
  --accent-muted: rgba(37, 99, 235, 0.08);
  --success: #16a34a;
  --success-muted: rgba(22, 163, 74, 0.08);
  --warning: #d97706;
  --warning-muted: rgba(217, 119, 6, 0.08);
  --error: #dc2626;
  --error-muted: rgba(220, 38, 38, 0.08);
}
```
