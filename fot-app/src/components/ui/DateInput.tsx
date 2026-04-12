import { useState, useRef, type FC } from 'react';

interface IDateInputProps {
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  className?: string;
}

/** Разбивает YYYY-MM-DD на [day, month, year] строки */
const parse = (iso: string): [string, string, string] => {
  const [y = '', m = '', d = ''] = iso.split('-');
  return [d, m, y];
};

export const DateInput: FC<IDateInputProps> = ({ value, onChange, className }) => {
  const [day, month, year] = parse(value);
  const [d, setD] = useState(day);
  const [m, setM] = useState(month);
  const [y, setY] = useState(year);
  const [isFocused, setIsFocused] = useState(false);

  const dayRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);
  const displayD = isFocused ? d : day;
  const displayM = isFocused ? m : month;
  const displayY = isFocused ? y : year;

  const tryEmit = (nd: string, nm: string, ny: string) => {
    // Эмитим только когда все поля полностью заполнены
    if (nd.length === 2 && nm.length === 2 && ny.length === 4) {
      const numD = Number(nd), numM = Number(nm), numY = Number(ny);
      if (numD >= 1 && numD <= 31 && numM >= 1 && numM <= 12 && numY >= 1900) {
        onChange(`${ny}-${nm}-${nd}`);
      }
    }
  };

  const handleDay = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 2);
    setD(clean);
    if (clean.length === 2) {
      monthRef.current?.focus();
      monthRef.current?.select();
    }
    tryEmit(clean, m, y);
  };

  const handleMonth = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 2);
    setM(clean);
    if (clean.length === 2) {
      yearRef.current?.focus();
      yearRef.current?.select();
    }
    tryEmit(d, clean, y);
  };

  const handleYear = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 4);
    setY(clean);
    tryEmit(d, m, clean);
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    e.target.select();
  };

  const handleBlur = () => {
    // Проверяем, не перешёл ли фокус на соседнее поле внутри группы
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        active !== dayRef.current &&
        active !== monthRef.current &&
        active !== yearRef.current
      ) {
        setIsFocused(false);
      }
    });
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    field: 'day' | 'month' | 'year',
  ) => {
    if (e.key === 'Backspace' && e.currentTarget.value.length === 0) {
      e.preventDefault();
      if (field === 'year') monthRef.current?.focus();
      else if (field === 'month') dayRef.current?.focus();
    }
  };

  return (
    <div className={`date-input-group ${className || ''}`}>
      <input
        ref={dayRef}
        type="text"
        inputMode="numeric"
        className="date-input-segment date-input-dd"
        value={displayD}
        onChange={e => handleDay(e.target.value)}
        onKeyDown={e => handleKeyDown(e, 'day')}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="ДД"
        maxLength={2}
      />
      <span className="date-input-dot">.</span>
      <input
        ref={monthRef}
        type="text"
        inputMode="numeric"
        className="date-input-segment date-input-mm"
        value={displayM}
        onChange={e => handleMonth(e.target.value)}
        onKeyDown={e => handleKeyDown(e, 'month')}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="ММ"
        maxLength={2}
      />
      <span className="date-input-dot">.</span>
      <input
        ref={yearRef}
        type="text"
        inputMode="numeric"
        className="date-input-segment date-input-yyyy"
        value={displayY}
        onChange={e => handleYear(e.target.value)}
        onKeyDown={e => handleKeyDown(e, 'year')}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="ГГГГ"
        maxLength={4}
      />
    </div>
  );
};
