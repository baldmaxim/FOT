import { useMemo, useRef, useState, type ComponentProps, type FC, type FocusEvent } from 'react';

import { filterDormitoryAddresses } from '../../../utils/dormitoryStayForm';
import { ClearableInput } from '../../ui/ClearableInput';
import styles from './DormitoryAddressField.module.css';

interface IDormitoryAddressFieldProps extends Omit<ComponentProps<typeof ClearableInput>, 'className' | 'onFocus' | 'onBlur'> {
  /** Общежития компании и адреса сохранённых проживаний (dormitoryAddressOptions). */
  options: readonly string[];
}

/**
 * «Адрес / номер» в окне «Общежития»: пока поле в фокусе — список сохранённых адресов под ним, тап выбирает.
 * Новый адрес вписывается как обычно; совпадений нет — списка нет.
 */
export const DormitoryAddressField: FC<IDormitoryAddressFieldProps> = ({
  options,
  value,
  onValueChange,
  disabled,
  ...props
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const suggestions = useMemo(() => filterDormitoryAddresses(options, value), [options, value]);
  const open = focused && !disabled && suggestions.length > 0;

  // Фокус внутри обёртки (поле, крестик, адрес списка по Tab) — список открыт.
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  const pick = (address: string) => {
    onValueChange(address);
    // Выбор с клавиатуры: кнопка исчезнет вместе со списком — фокус обратно в поле.
    wrapperRef.current?.querySelector('input')?.focus();
  };

  return (
    <div ref={wrapperRef} className={styles.wrapper} onFocus={() => setFocused(true)} onBlur={handleBlur}>
      <ClearableInput {...props} value={value} onValueChange={onValueChange} disabled={disabled} autoComplete="off" />
      {open && (
        <ul className={styles.results} aria-label="Сохранённые адреса">
          {suggestions.map(address => (
            <li key={address}>
              <button
                type="button"
                className={styles.option}
                // Тап не уводит фокус из поля: иначе список исчез бы до клика (Safari не фокусирует кнопки).
                onMouseDown={event => event.preventDefault()}
                onClick={() => pick(address)}
              >
                {address}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
