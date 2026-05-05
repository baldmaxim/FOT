import { useState, useRef, useLayoutEffect, type FC } from 'react';

interface IDateInputProps {
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  className?: string;
}

type Field = 'day' | 'month' | 'year';
const MAX: Record<Field, number> = { day: 2, month: 2, year: 4 };

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
  const pendingCaretRef = useRef<{ field: Field; pos: number } | null>(null);

  const displayD = isFocused ? d : day;
  const displayM = isFocused ? m : month;
  const displayY = isFocused ? y : year;

  const refOf = (field: Field) =>
    field === 'day' ? dayRef : field === 'month' ? monthRef : yearRef;

  const setterOf = (field: Field) =>
    field === 'day' ? setD : field === 'month' ? setM : setY;

  const tryEmit = (nd: string, nm: string, ny: string) => {
    if (nd.length === 2 && nm.length === 2 && ny.length === 4) {
      const numD = Number(nd), numM = Number(nm), numY = Number(ny);
      if (numD >= 1 && numD <= 31 && numM >= 1 && numM <= 12 && numY >= 1900) {
        onChange(`${ny}-${nm}-${nd}`);
      }
    }
  };

  useLayoutEffect(() => {
    const p = pendingCaretRef.current;
    if (!p) return;
    const node = refOf(p.field).current;
    if (node && document.activeElement === node) {
      node.setSelectionRange(p.pos, p.pos);
    }
    pendingCaretRef.current = null;
  }, [d, m, y]);

  const handleDigitKey = (
    e: React.KeyboardEvent<HTMLInputElement>,
    field: Field,
  ) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!/^[0-9]$/.test(e.key)) return;
    e.preventDefault();

    const max = MAX[field];
    const input = e.currentTarget;
    const cur = input.value;
    const start = input.selectionStart ?? cur.length;
    const end = input.selectionEnd ?? start;

    let next: string;
    let caret: number;

    if (start !== end) {
      next = cur.slice(0, start) + e.key + cur.slice(end);
      caret = start + 1;
    } else if (cur.length < max) {
      next = cur.slice(0, start) + e.key + cur.slice(start);
      caret = start + 1;
    } else {
      const pos = start === max ? start - 1 : start;
      next = cur.slice(0, pos) + e.key + cur.slice(pos + 1);
      caret = pos + 1;
    }

    next = next.replace(/\D/g, '').slice(0, max);
    pendingCaretRef.current = { field, pos: Math.min(caret, max) };
    setterOf(field)(next);

    const nd = field === 'day' ? next : d;
    const nm = field === 'month' ? next : m;
    const ny = field === 'year' ? next : y;
    tryEmit(nd, nm, ny);

    if (next.length === max && field !== 'year') {
      const nextField: Field = field === 'day' ? 'month' : 'year';
      const nextRef = refOf(nextField).current;
      if (nextRef) {
        nextRef.focus();
        nextRef.select();
      }
    }
  };

  const handleChange = (
    val: string,
    field: Field,
  ) => {
    const clean = val.replace(/\D/g, '').slice(0, MAX[field]);
    setterOf(field)(clean);
    const nd = field === 'day' ? clean : d;
    const nm = field === 'month' ? clean : m;
    const ny = field === 'year' ? clean : y;
    tryEmit(nd, nm, ny);
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    e.target.select();
  };

  const handleBlur = () => {
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
    field: Field,
  ) => {
    if (e.key === 'Backspace' && e.currentTarget.value.length === 0) {
      e.preventDefault();
      if (field === 'year') monthRef.current?.focus();
      else if (field === 'month') dayRef.current?.focus();
      return;
    }
    handleDigitKey(e, field);
  };

  return (
    <div className={`date-input-group ${className || ''}`}>
      <input
        ref={dayRef}
        type="text"
        inputMode="numeric"
        className="date-input-segment date-input-dd"
        value={displayD}
        onChange={e => handleChange(e.target.value, 'day')}
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
        onChange={e => handleChange(e.target.value, 'month')}
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
        onChange={e => handleChange(e.target.value, 'year')}
        onKeyDown={e => handleKeyDown(e, 'year')}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="ГГГГ"
        maxLength={4}
      />
    </div>
  );
};
