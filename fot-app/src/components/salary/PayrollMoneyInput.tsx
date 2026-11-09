import { useLayoutEffect, useRef } from 'react';
import type { FC, InputHTMLAttributes } from 'react';

import { groupMoneyInput } from '../../utils/payrollFormat';

interface IPayrollMoneyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  /** Значение формы — без пробелов между разрядами. */
  value: string;
  onChange: (next: string) => void;
}

const SPACE = /\s/g;

/**
 * Поле суммы с разрядами: показывает «130 000», в форму отдаёт «130000». Курсор после правки ставится за тем же
 * по счёту непробельным символом, иначе при вставке пробелов он уезжал бы в конец поля.
 */
export const PayrollMoneyInput: FC<IPayrollMoneyInputProps> = ({ value, onChange, ...props }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  // Сколько непробельных символов стоит до курсора после последнего ввода; null — курсор не трогаем.
  const caretRef = useRef<number | null>(null);
  const display = groupMoneyInput(value);

  // Без зависимостей: значение могло не измениться (Backspace по пробелу), а React всё равно перезаписал поле.
  useLayoutEffect(() => {
    const input = inputRef.current;
    const count = caretRef.current;
    caretRef.current = null;
    if (!input || count === null || document.activeElement !== input) return;
    let position = 0;
    let seen = 0;
    while (position < display.length && seen < count) {
      if (!/\s/.test(display[position])) seen += 1;
      position += 1;
    }
    input.setSelectionRange(position, position);
  });

  return (
    <input
      {...props}
      ref={inputRef}
      value={display}
      onChange={event => {
        const { value: next, selectionStart } = event.target;
        caretRef.current = selectionStart === null ? null : next.slice(0, selectionStart).replace(SPACE, '').length;
        onChange(next.replace(SPACE, ''));
      }}
    />
  );
};
