import { useRef } from 'react';
import type { FC, InputHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import styles from './ClearableInput.module.css';

interface IClearableInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Подпись крестика: «Очистить название». */
  clearLabel: string;
  /** Класс обёртки: ширина и место поля в раскладке. */
  className?: string;
}

/**
 * Текстовое поле с крестиком «Очистить». Крестик виден у непустого поля (не у disabled / readOnly),
 * стоит справа внутри поля — текст под него не заходит; после очистки фокус остаётся в поле.
 */
export const ClearableInput: FC<IClearableInputProps> = ({
  value,
  onValueChange,
  clearLabel,
  className,
  disabled,
  readOnly,
  ...props
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const showClear = value !== '' && !disabled && !readOnly;

  const handleClear = () => {
    onValueChange('');
    inputRef.current?.focus();
  };

  return (
    <div className={className ? `${styles.wrapper} ${className}` : styles.wrapper}>
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        onChange={event => onValueChange(event.target.value)}
        {...props}
      />
      {showClear && (
        <button
          type="button"
          className={styles.clear}
          // Клик не уводит фокус из поля.
          onMouseDown={event => event.preventDefault()}
          onClick={handleClear}
          aria-label={clearLabel}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
