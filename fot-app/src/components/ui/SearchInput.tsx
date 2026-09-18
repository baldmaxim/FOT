import { useRef } from 'react';
import type { FC, InputHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import styles from './SearchInput.module.css';
import { SearchIcon } from './Icons';

interface ISearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  value: string;
  onValueChange: (value: string) => void;
  /** Крестик очистки справа, пока поле непустое. */
  clearable?: boolean;
}

export const SearchInput: FC<ISearchInputProps> = ({
  value,
  onValueChange,
  placeholder = 'Поиск...',
  clearable = false,
  ...props
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const showClear = clearable && value !== '';

  const handleClear = () => {
    onValueChange('');
    inputRef.current?.focus();
  };

  return (
    <div className={`${styles.wrapper}${clearable ? ` ${styles.withClear}` : ''}`}>
      <SearchIcon className={styles.icon} />
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        value={value}
        onChange={e => onValueChange(e.target.value)}
        placeholder={placeholder}
        {...props}
      />
      {showClear && (
        <button
          type="button"
          className={styles.clear}
          // Клик не уводит фокус из поля.
          onMouseDown={e => e.preventDefault()}
          onClick={handleClear}
          aria-label="Очистить поиск"
          title="Очистить"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
