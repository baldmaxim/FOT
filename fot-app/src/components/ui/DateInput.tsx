import { useRef, useState, useLayoutEffect, type FC } from 'react';
import { Calendar } from 'lucide-react';
import './DateInput.css';

interface IDateInputProps {
  value: string; // YYYY-MM-DD или ''
  onChange: (value: string) => void;
  className?: string;
  /** Блокирует ввод, календарь и скрытый date-input (например, на время сохранения). */
  disabled?: boolean;
  onBlur?: () => void;
}

const PLACEHOLDER = '_';
const DOT_POSITIONS = new Set([2, 5]);
const DIGIT_POSITIONS = [0, 1, 3, 4, 6, 7, 8, 9];

const parse = (iso: string): (string | null)[] => {
  const slots: (string | null)[] = [null, null, null, null, null, null, null, null];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return slots;
  const [, y, mo, d] = m;
  slots[0] = d[0]; slots[1] = d[1];
  slots[2] = mo[0]; slots[3] = mo[1];
  slots[4] = y[0]; slots[5] = y[1]; slots[6] = y[2]; slots[7] = y[3];
  return slots;
};

const render = (digits: (string | null)[]): string => {
  const ch = (i: number) => digits[i] ?? PLACEHOLDER;
  return `${ch(0)}${ch(1)}.${ch(2)}${ch(3)}.${ch(4)}${ch(5)}${ch(6)}${ch(7)}`;
};

const digitIdxToCaret = (idx: number): number => {
  // digit index 0..7 → позиция самой цифры в строке
  return DIGIT_POSITIONS[Math.max(0, Math.min(7, idx))];
};

const nextDigitCaret = (caret: number): number => {
  // следующая позиция-цифра справа от caret (для размещения каретки ПОСЛЕ ввода)
  for (const p of DIGIT_POSITIONS) {
    if (p >= caret) return p;
  }
  return 10;
};

const prevDigitCaret = (caret: number): number => {
  // ближайшая позиция-цифра слева
  for (let i = DIGIT_POSITIONS.length - 1; i >= 0; i--) {
    if (DIGIT_POSITIONS[i] <= caret) return DIGIT_POSITIONS[i];
  }
  return 0;
};

const computeIso = (digits: (string | null)[]): string | null => {
  if (digits.some(c => c == null)) return null;
  const dd = `${digits[0]}${digits[1]}`;
  const mm = `${digits[2]}${digits[3]}`;
  const yyyy = `${digits[4]}${digits[5]}${digits[6]}${digits[7]}`;
  const numD = Number(dd), numM = Number(mm), numY = Number(yyyy);
  if (numD < 1 || numD > 31) return null;
  if (numM < 1 || numM > 12) return null;
  if (numY < 1900 || numY > 9999) return null;
  return `${yyyy}-${mm}-${dd}`;
};

export const DateInput: FC<IDateInputProps> = ({ value, onChange, className, disabled = false, onBlur }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const [digits, setDigits] = useState<(string | null)[]>(() => parse(value));
  const [lastSyncedValue, setLastSyncedValue] = useState(value);
  const pendingCaretRef = useRef<number | null>(null);

  // синк с пропсом, если родитель сменил value (например, кнопка «месяц вперёд»)
  // render-phase setState — рекомендованный React-паттерн для синхронизации с пропом
  if (value !== lastSyncedValue) {
    setLastSyncedValue(value);
    const currentIso = computeIso(digits) ?? '';
    if (currentIso !== value) {
      setDigits(parse(value));
    }
  }

  useLayoutEffect(() => {
    const p = pendingCaretRef.current;
    if (p == null) return;
    pendingCaretRef.current = null;
    const node = inputRef.current;
    if (node && document.activeElement === node) {
      node.setSelectionRange(p, p);
    }
  }, [digits]);

  const updateDigits = (next: (string | null)[], caret: number) => {
    pendingCaretRef.current = caret;
    setDigits(next);
    const iso = computeIso(next);
    const prevIso = value;
    if (iso != null && iso !== prevIso) onChange(iso);
    else if (iso == null && prevIso !== '') onChange('');
  };

  const getCaret = (): number => {
    const node = inputRef.current;
    if (!node) return 0;
    return node.selectionStart ?? 0;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key;

    if (key === 'Tab') return; // нативный Tab

    if (/^[0-9]$/.test(key)) {
      e.preventDefault();
      const caret = getCaret();
      // если каретка на точке — двигаем на ближайшую цифру слева, и оттуда пишем (заменяем эту цифру)
      // но интуитивнее — писать в позицию справа: пользователь кликнул между, ожидает «следующую» цифру
      // используем правило: пишем в позицию ≥ caret, если на точке — справа
      let writePos: number;
      if (DOT_POSITIONS.has(caret)) writePos = caret + 1;
      else if (caret >= 10) writePos = 9;
      else writePos = caret;
      const idx = DIGIT_POSITIONS.indexOf(writePos);
      if (idx === -1) return;
      const next = digits.slice();
      next[idx] = key;
      const nextCaret = idx < 7 ? digitIdxToCaret(idx + 1) : 10;
      updateDigits(next, nextCaret);
      return;
    }

    if (key === 'Backspace') {
      e.preventDefault();
      const caret = getCaret();
      if (caret === 0) return;
      const targetCaret = prevDigitCaret(caret - 1);
      const idx = DIGIT_POSITIONS.indexOf(targetCaret);
      if (idx === -1) return;
      const next = digits.slice();
      next[idx] = null;
      updateDigits(next, targetCaret);
      return;
    }

    if (key === 'Delete') {
      e.preventDefault();
      const caret = getCaret();
      if (caret >= 10) return;
      const pos = DOT_POSITIONS.has(caret) ? caret + 1 : caret;
      const idx = DIGIT_POSITIONS.indexOf(pos);
      if (idx === -1) return;
      const next = digits.slice();
      next[idx] = null;
      updateDigits(next, pos);
      return;
    }

    if (key === 'ArrowLeft') {
      e.preventDefault();
      const caret = getCaret();
      if (caret <= 0) return;
      const target = prevDigitCaret(caret - 1);
      pendingCaretRef.current = target;
      // форсим повторный апдейт каретки (без изменения digits — useLayoutEffect не сработает)
      inputRef.current?.setSelectionRange(target, target);
      return;
    }

    if (key === 'ArrowRight') {
      e.preventDefault();
      const caret = getCaret();
      if (caret >= 10) return;
      const target = nextDigitCaret(caret + 1);
      inputRef.current?.setSelectionRange(target, target);
      return;
    }

    if (key === 'Home') {
      e.preventDefault();
      inputRef.current?.setSelectionRange(0, 0);
      return;
    }

    if (key === 'End') {
      e.preventDefault();
      inputRef.current?.setSelectionRange(10, 10);
      return;
    }

    // всё остальное — глушим
    if (key.length === 1) {
      e.preventDefault();
    }
  };

  const handleClick = () => {
    const node = inputRef.current;
    if (!node) return;
    const caret = node.selectionStart ?? 0;
    if (DOT_POSITIONS.has(caret)) {
      // на точке → к ближайшей цифре справа
      node.setSelectionRange(caret + 1, caret + 1);
    }
  };

  const handleSelect = () => {
    // сжимаем выделение в каретку (мы редактируем поразрядно, диапазон не нужен)
    const node = inputRef.current;
    if (!node) return;
    const s = node.selectionStart ?? 0;
    const eSel = node.selectionEnd ?? 0;
    if (s !== eSel) {
      node.setSelectionRange(eSel, eSel);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    const onlyDigits = text.replace(/\D/g, '');
    if (!onlyDigits) return;
    const caret = getCaret();
    const startIdx = DIGIT_POSITIONS.indexOf(
      DOT_POSITIONS.has(caret) ? caret + 1 : Math.min(caret, 9),
    );
    if (startIdx === -1) return;
    const next = digits.slice();
    let i = startIdx;
    for (const ch of onlyDigits) {
      if (i > 7) break;
      next[i] = ch;
      i++;
    }
    const nextCaret = i > 7 ? 10 : digitIdxToCaret(i);
    updateDigits(next, nextCaret);
  };

  const openPicker = () => {
    if (disabled) return;
    const node = hiddenRef.current;
    if (!node) return;
    type WithShowPicker = HTMLInputElement & { showPicker?: () => void };
    const withPicker = node as WithShowPicker;
    if (typeof withPicker.showPicker === 'function') {
      try { withPicker.showPicker(); return; } catch { /* fallback ниже */ }
    }
    node.focus();
    node.click();
  };

  const handleHiddenChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const iso = e.target.value;
    if (!iso) return;
    setDigits(parse(iso));
    if (iso !== value) onChange(iso);
  };

  return (
    <div className={`date-input-group ${className || ''}`}>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        className="date-input"
        value={render(digits)}
        onChange={() => { /* всё через keyDown/paste */ }}
        onKeyDown={handleKeyDown}
        onClick={handleClick}
        onSelect={handleSelect}
        onPaste={handlePaste}
        onBlur={onBlur}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-label="Дата"
      />
      <button
        type="button"
        className="date-input-calendar-btn"
        onClick={openPicker}
        disabled={disabled}
        aria-label="Открыть календарь"
        tabIndex={-1}
      >
        <Calendar size={14} />
      </button>
      <input
        ref={hiddenRef}
        type="date"
        className="date-input-calendar-hidden"
        value={value || ''}
        onChange={handleHiddenChange}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
};
