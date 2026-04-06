import { useState, useEffect, useRef, memo, type FC } from 'react';
import { ChevronDown } from 'lucide-react';
import type { OrgDepartmentNode } from '../../types/organization';

interface IDeptSelectProps {
  departments: OrgDepartmentNode[];
  value: string;
  onChange: (id: string) => void;
}

export const DeptSelect: FC<IDeptSelectProps> = memo(({ departments, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selected = departments.find(d => d.id === value);
  const qLower = q.toLowerCase();
  const filtered = q ? departments.filter(d => d.name.toLowerCase().includes(qLower)) : departments;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="sc-dept-select" ref={ref}>
      <button className="sc-dept-trigger" onClick={() => { setOpen(!open); setQ(''); }}>
        <span className="sc-dept-trigger-text">{selected ? selected.name : 'Все отделы'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="sc-dept-dropdown">
          <input
            className="sc-dept-search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Поиск отдела..."
            autoFocus
          />
          <div className="sc-dept-list">
            <div className={`sc-dept-option ${!value ? 'active' : ''}`} onClick={() => pick('')}>
              Все отделы
            </div>
            {filtered.map(d => (
              <div
                key={d.id}
                className={`sc-dept-option ${d.id === value ? 'active' : ''}`}
                onClick={() => pick(d.id)}
              >
                {d.name}
              </div>
            ))}
            {filtered.length === 0 && <div className="sc-dept-empty">Не найдено</div>}
          </div>
        </div>
      )}
    </div>
  );
});
