import { useEffect, useState } from 'react';
import type { FC, InputHTMLAttributes } from 'react';

interface INumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max'> {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}

/**
 * Числовое поле со свободным вводом: пользователь набирает любое число,
 * clamp к [min, max] и чтение значения происходят на blur/Enter, а не на
 * каждом keystroke. Промежуточный ввод (пусто, «2» при min 1) не сбрасывается.
 */
export const NumberInput: FC<INumberInputProps> = ({ value, min, max, onCommit, ...props }) => {
  const [draft, setDraft] = useState<string>(String(value));

  // Синхронизируем draft при внешних изменениях value (пресеты N/M,
  // переключение режима цикла). Во время набора value не меняется
  // (commit только на blur), поэтому draft не затирается.
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = parseInt(draft, 10);
    const clamped = Number.isNaN(parsed) ? value : Math.max(min, Math.min(max, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      {...props}
    />
  );
};
