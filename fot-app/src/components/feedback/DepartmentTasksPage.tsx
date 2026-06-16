import { type FC, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { feedbackService, type IDailyCount } from '../../services/feedbackService';
import { fillColor, periodLabel } from './deptStats';
import { DailyActivity } from './DailyActivity';
import styles from './DepartmentTasksPage.module.css';

interface IDepartmentTasksPageProps {
  departmentId: string;
  from: string;
  to: string;
  single: boolean;
  onBack: () => void;
}

const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const parseIso = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const fmtRu = (iso: string): string => {
  const d = parseIso(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const DepartmentTasksPage: FC<IDepartmentTasksPageProps> = ({ departmentId, from, to, single, onBack }) => {
  const { data, isLoading } = useQuery({
    queryKey: ['fb-dept-tasks', departmentId, from, to],
    queryFn: () => feedbackService.getDepartmentTasks(departmentId, { from, to }),
    staleTime: 30_000,
  });

  const employees = useMemo(() => data?.employees ?? [], [data]);
  const workingDates = useMemo(() => data?.workingDates ?? [], [data]);

  const enriched = useMemo(() => {
    const slots = single ? 1 : workingDates.length || 1;
    return employees
      .map(e => {
        const map = new Map(e.fills.map(f => [f.date, f.content]));
        const filled = single
          ? (map.has(from) ? 1 : 0)
          : workingDates.reduce((n, d) => n + (map.has(d) ? 1 : 0), 0);
        return { ...e, map, filled, slots, pct: Math.round((filled / slots) * 100) };
      })
      .sort((a, b) => a.pct - b.pct || (a.full_name ?? '').localeCompare(b.full_name ?? '', 'ru'));
  }, [employees, workingDates, single, from]);

  const sumFilled = enriched.reduce((n, e) => n + e.filled, 0);
  const sumSlots = enriched.reduce((n, e) => n + e.slots, 0);
  const overallPct = sumSlots > 0 ? Math.round((sumFilled / sumSlots) * 100) : 0;

  const daily = useMemo<IDailyCount[]>(() => {
    const m = new Map<string, number>();
    for (const e of employees) for (const f of e.fills) m.set(f.date, (m.get(f.date) ?? 0) + 1);
    return [...m.entries()].map(([date, count]) => ({ date, count }));
  }, [employees]);

  const colTemplate = `minmax(160px, 1fr) repeat(${workingDates.length}, 30px) 56px 48px`;
  const tableMinWidth = 264 + workingDates.length * 36;
  const useWeekdayLabels = workingDates.length <= 7;

  return (
    <div className={styles.page}>
      <button type="button" className={styles.back} onClick={onBack}><ArrowLeft size={15} /> К отделам</button>

      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>{data?.department_name ?? '—'}</h2>
          <div className={styles.sub}>{periodLabel(from, to)} · {employees.length} сотр.</div>
        </div>
      </div>

      <div className={styles.summary}>
        <div className={styles.statOverall}>
          <div className={styles.ovPct} style={{ color: fillColor(overallPct) }}>{overallPct}%</div>
          <div className={styles.ovSub}>
            {single ? `${sumFilled}/${enriched.length} заполнили` : `заполнено ${sumFilled} / ${sumSlots}`}
          </div>
        </div>
        {!single && <DailyActivity daily={daily} from={from} to={to} />}
      </div>

      {isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : !enriched.length ? (
        <div className={styles.empty}>Нет сотрудников</div>
      ) : single ? (
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span>Сотрудники · {periodLabel(from, to)}</span>
            <span className={styles.hint}>{sumFilled} из {enriched.length} заполнили</span>
          </div>
          <div className={styles.elist}>
            {enriched.map(e => {
              const done = e.map.has(from);
              return (
                <div key={e.id} className={styles.erow}>
                  <div className={styles.ename}>{e.full_name ?? '—'}</div>
                  <div className={`${styles.estatus} ${done ? styles.done : styles.miss}`}>
                    <span className={styles.dot} style={{ background: done ? 'var(--success)' : 'var(--error)' }} />
                    {done ? 'Заполнил' : 'Не заполнил'}
                  </div>
                  <div className={`${styles.etask} ${done ? '' : styles.etaskEmpty}`}>
                    {done ? e.map.get(from) : '— задача не заполнена'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span>Сотрудники · по дням</span>
            <span className={styles.hint}>наведите на клетку — задача за день</span>
          </div>
          <div className={styles.scroll}>
            <div className={styles.wtable} style={{ minWidth: `${tableMinWidth}px` }}>
              <div className={`${styles.wrow} ${styles.whead}`} style={{ gridTemplateColumns: colTemplate }}>
                <div>Сотрудник</div>
                {workingDates.map(d => (
                  <div key={d} className={styles.wd}>{useWeekdayLabels ? WD[parseIso(d).getDay()] : String(parseIso(d).getDate())}</div>
                ))}
                <div className={styles.ch}>Дней</div>
                <div className={styles.cp}>%</div>
              </div>
              {enriched.map(e => (
                <div key={e.id} className={styles.wrow} style={{ gridTemplateColumns: colTemplate }}>
                  <div className={styles.wname}>{e.full_name ?? '—'}</div>
                  {workingDates.map(d => {
                    const has = e.map.has(d);
                    return (
                      <div
                        key={d}
                        className={`${styles.cell} ${has ? styles.cellDone : styles.cellMiss}`}
                        title={has ? `${fmtRu(d)}: ${e.map.get(d)}` : `${fmtRu(d)}: не заполнено`}
                      >
                        {has ? '✓' : '✗'}
                      </div>
                    );
                  })}
                  <div className={styles.wcount}>{e.filled}/{e.slots}</div>
                  <div className={styles.wpct} style={{ color: fillColor(e.pct) }}>{e.pct}%</div>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.wlegend}>
            <span className={styles.lg}><span className={styles.sq} style={{ background: 'rgba(34,197,94,.18)' }} />заполнено</span>
            <span className={styles.lg}><span className={styles.sq} style={{ background: 'rgba(239,68,68,.14)' }} />пропущено</span>
          </div>
        </div>
      )}
    </div>
  );
};
