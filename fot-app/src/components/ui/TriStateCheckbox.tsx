import { type FC, useEffect, useRef } from 'react';

export type CheckboxSelectionState = 'none' | 'partial' | 'all';

interface ITriStateCheckboxProps {
  state: CheckboxSelectionState;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Класс на обёртку-тап-зону (44×44 на мобильных). */
  className?: string;
}

/**
 * Чекбокс с тремя состояниями: `partial` рисуется нативным `indeterminate`
 * (свойство DOM, из JSX его не выставить — только через ref).
 */
export const TriStateCheckbox: FC<ITriStateCheckboxProps> = ({
  state,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}) => {
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'partial';
  }, [state]);

  return (
    <span className={className ? `tri-check ${className}` : 'tri-check'}>
      <input
        ref={ref}
        type="checkbox"
        checked={state === 'all'}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
        disabled={disabled}
      />
    </span>
  );
};
