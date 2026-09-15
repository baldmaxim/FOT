import { useMemo, useState, type FC } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { FUNNEL_KEYS, stageMeta, type IHiringRequest } from '../../../services/hiringRequestService';
import { Avatar, pluralDays, fmtDate } from './hiringUi';
import styles from './hiring.module.css';

const NO_DEPT_KEY = '__no_department__';
const collator = new Intl.Collator('ru');

interface IDeptGroup {
  key: string;
  name: string;
  items: IHiringRequest[];
  headcount: number;
  urgent: number;
}

const pluralRequests = (n: number): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'заявка';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'заявки';
  return 'заявок';
};

const groupByDepartment = (requests: IHiringRequest[]): IDeptGroup[] => {
  const map = new Map<string, IDeptGroup>();
  for (const r of requests) {
    const key = r.department_id ?? NO_DEPT_KEY;
    let g = map.get(key);
    if (!g) {
      const name = r.department_id == null ? 'Без отдела' : (r.department_name || 'Неизвестный отдел');
      g = { key, name, items: [], headcount: 0, urgent: 0 };
      map.set(key, g);
    }
    g.items.push(r);
    g.headcount += r.headcount;
    if (r.is_urgent) g.urgent += 1;
  }
  return [...map.values()].sort((a, b) => {
    if (a.key === NO_DEPT_KEY) return 1;
    if (b.key === NO_DEPT_KEY) return -1;
    return collator.compare(a.name, b.name);
  });
};

interface IHiringDepartmentGroupsProps {
  requests: IHiringRequest[];
  onOpen: (id: number) => void;
}

/** Заявки на поиск, сгруппированные по отделам (вид как в «Согласованиях»). */
export const HiringDepartmentGroups: FC<IHiringDepartmentGroupsProps> = ({ requests, onOpen }) => {
  // По умолчанию все отделы свёрнуты — храним раскрытые.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => groupByDepartment(requests), [requests]);

  const toggle = (key: string): void => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className={styles.depts}>
      {groups.map(g => {
        const isOpen = expanded.has(g.key);
        return (
          <section key={g.key} className={styles.dept}>
            <button type="button" className={styles.deptHead} onClick={() => toggle(g.key)} aria-expanded={isOpen}>
              <span className={styles.deptChevron} aria-hidden="true">
                {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </span>
              <span className={styles.deptName} title={g.name}>{g.name}</span>
              {g.urgent > 0 && <span className={styles.urgentTag}>● {g.urgent} срочн.</span>}
              <span className={styles.deptStats}>
                {g.items.length} {pluralRequests(g.items.length)} · {g.headcount}&thinsp;чел
              </span>
            </button>
            {isOpen && (
              <div className={styles.rows}>
                {g.items.map(r => <HiringRequestRow key={r.id} r={r} onOpen={onOpen} />)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
};

const HiringRequestRow: FC<{ r: IHiringRequest; onOpen: (id: number) => void }> = ({ r, onOpen }) => {
  const m = stageMeta(r.stage);
  const isFunnel = FUNNEL_KEYS.includes(r.stage);
  const hcDone = r.headcount > 0 && r.approved_count >= r.headcount;
  const primary = r.assignees.find(a => a.is_primary) ?? r.assignees[0] ?? null;
  const primaryName = primary ? (primary.full_name || `Сотрудник #${primary.employee_id}`) : null;

  const term = r.stage === 'closed'
    ? { text: `закрыта за ${r.days_in_work} дн`, warn: false }
    : r.stage === 'rework'
      ? { text: 'ждёт заявителя', warn: true }
      : r.stage === 'cancelled'
        ? { text: 'отменена', warn: false }
        : { text: `${r.days_in_work} ${pluralDays(r.days_in_work)} в работе`, warn: r.days_in_work > 14 };

  return (
    <button
      type="button"
      className={`${styles.row} ${r.is_urgent ? styles.rowUrgent : ''}`}
      onClick={() => onOpen(r.id)}
    >
      <span className={styles.rowBar} style={r.is_urgent ? undefined : { background: m.color }} aria-hidden="true" />

      <span className={styles.cellPos}>
        <span className={styles.posTitle}>{r.position_title}</span>
        <span className={styles.posCust}>Заказчик: {r.customer_name || '—'}</span>
        {r.is_urgent && <span className={styles.urgentTag}>● Срочная</span>}
      </span>

      <span className={styles.metaWrap}>
        <span className={styles.cell}>
          <span className={styles.caption}>Этап</span>
          <span className={styles.cellLine}>
            <span className={styles.stagePill} style={{ color: m.color }}>{m.label}</span>
            {isFunnel && <span className={styles.muted}>{m.idx}/5</span>}
          </span>
        </span>

        <span className={styles.cell}>
          <span className={styles.caption}>Сроки</span>
          <span className={`${styles.stat} ${term.warn ? styles.statWarn : ''}`}>⏱ {term.text}</span>
          {r.deadline && <span className={styles.muted}>до {fmtDate(r.deadline)}</span>}
        </span>

        <span className={styles.cell}>
          <span className={styles.caption}>Штат</span>
          <span className={`${styles.hc} ${hcDone ? styles.hcDone : ''}`}>
            {hcDone ? '✓ ' : ''}{r.approved_count}/{r.headcount}
          </span>
          {r.candidate_count > 0 && <span className={styles.muted}>{r.candidate_count} канд.</span>}
        </span>
      </span>

      <span className={styles.assigneeCell}>
        {primary
          ? <><Avatar name={primary.full_name} id={primary.employee_id} /><span className={styles.assigneeName}>{primaryName}{r.assignees.length > 1 ? ` +${r.assignees.length - 1}` : ''}</span></>
          : <><Avatar name={null} unassigned /><span className={styles.muted}>Не назначен</span></>}
      </span>

      {r.stage === 'rework' && r.rework_reason && (
        <span className={styles.reworkLine} title={r.rework_reason}>↩ Возвращена: {r.rework_reason}</span>
      )}
    </button>
  );
};
