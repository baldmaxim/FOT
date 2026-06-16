import { type FC, type ReactNode, useMemo, useState } from 'react';
import type { IDepartmentStat } from '../../services/feedbackService';
import {
  type SortKey,
  STATUS_COLORS,
  pctOf,
  fillColor,
  bucketOf,
  computeKpi,
  sortRows,
} from './deptStats';
import styles from './DeptStatsGrid.module.css';

interface IDeptStatsGridProps {
  rows: IDepartmentStat[];
  verb: string;
  onSelect: (s: IDepartmentStat) => void;
  /** true → карточки показывают «N/M verb» и виджет — «Σ/Σ»; false → только % */
  showCounts: boolean;
  /** Подпись периода под общим % (опц.) */
  overallNote?: ReactNode;
  /** Контролы периода/фильтров слева в строке управления (опц.) */
  leadingControls?: ReactNode;
  /** Доп. виджет в строке статистики, напр. график по дням (опц.) */
  activity?: ReactNode;
}

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'lagging', label: 'Отстающие' },
  { key: 'pctdesc', label: '% ↓' },
  { key: 'alpha', label: 'А–Я' },
];

const DeptCard: FC<{
  s: IDepartmentStat;
  verb: string;
  showCounts: boolean;
  onSelect: (s: IDepartmentStat) => void;
}> = ({ s, verb, showCounts, onSelect }) => {
  const pct = pctOf(s);
  const color = fillColor(pct);
  return (
    <button
      type="button"
      className={styles.card}
      style={{ borderLeftColor: color }}
      aria-label={`${s.department_name}: ${verb.toLowerCase()} ${s.filled} из ${s.total}, ${pct}%`}
      onClick={() => onSelect(s)}
    >
      <div className={styles.cardTop}>
        <div className={styles.cardName}>{s.department_name}</div>
        <div className={styles.cardPct} style={{ color }}>{pct}%</div>
      </div>
      <div className={styles.barTrack}>
        <div className={styles.barFill} style={{ width: `${pct}%`, background: color }} />
      </div>
      {showCounts && (
        <div className={styles.cardMeta}><b>{s.filled}/{s.total}</b> {verb}</div>
      )}
    </button>
  );
};

export const DeptStatsGrid: FC<IDeptStatsGridProps> = ({
  rows,
  verb,
  onSelect,
  showCounts,
  overallNote,
  leadingControls,
  activity,
}) => {
  const [sort, setSort] = useState<SortKey>('lagging');
  const [grouped, setGrouped] = useState(false);

  const kpi = useMemo(() => computeKpi(rows), [rows]);
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const statusTotal = kpi.none + kpi.part + kpi.done || 1;

  const groups = useMemo(
    () =>
      grouped
        ? ([
            { title: 'Не начато', color: STATUS_COLORS.none, list: sorted.filter(s => bucketOf(s) === 'none') },
            { title: 'Частично', color: STATUS_COLORS.part, list: sorted.filter(s => bucketOf(s) === 'part') },
            { title: 'Завершено', color: STATUS_COLORS.done, list: sorted.filter(s => bucketOf(s) === 'done') },
          ] as const).filter(g => g.list.length)
        : [],
    [grouped, sorted],
  );

  const renderCards = (list: IDepartmentStat[]): ReactNode => (
    <div className={styles.cards}>
      {list.map(s => (
        <DeptCard
          key={s.department_id ?? s.department_name}
          s={s}
          verb={verb}
          showCounts={showCounts}
          onSelect={onSelect}
        />
      ))}
    </div>
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.controlsRow}>
        {leadingControls}
        <div className={styles.controls}>
          <div className={styles.segmented} role="group" aria-label="Сортировка">
            {SORTS.map(s => (
              <button
                key={s.key}
                type="button"
                className={`${styles.segBtn} ${sort === s.key ? styles.segBtnActive : ''}`}
                aria-pressed={sort === s.key}
                onClick={() => setSort(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`${styles.toggle} ${grouped ? styles.toggleOn : ''}`}
            aria-pressed={grouped}
            onClick={() => setGrouped(g => !g)}
          >
            <span className={styles.toggleLabel}>Группировать</span>
            <span className={styles.switch} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className={styles.statsRow}>
        <div className={`${styles.stat} ${styles.statOverall}`}>
          <div className={styles.ovPct} style={{ color: fillColor(kpi.overallPct) }}>{kpi.overallPct}%</div>
          {showCounts && <div className={styles.ovSub}>{kpi.sumFilled}/{kpi.sumTotal} {verb.toLowerCase()}</div>}
          {overallNote && <div className={styles.ovPeriod}>{overallNote}</div>}
        </div>

        <div className={`${styles.stat} ${styles.statStatus}`}>
          <div className={styles.statusBar}>
            <i style={{ width: `${(kpi.none / statusTotal) * 100}%`, background: STATUS_COLORS.none }} />
            <i style={{ width: `${(kpi.part / statusTotal) * 100}%`, background: STATUS_COLORS.part }} />
            <i style={{ width: `${(kpi.done / statusTotal) * 100}%`, background: STATUS_COLORS.done }} />
          </div>
          <div className={styles.statusLegend}>
            <span className={styles.leg}><span className={styles.dot} style={{ background: STATUS_COLORS.none }} />Не начато <b>{kpi.none}</b></span>
            <span className={styles.leg}><span className={styles.dot} style={{ background: STATUS_COLORS.part }} />Частично <b>{kpi.part}</b></span>
            <span className={styles.leg}><span className={styles.dot} style={{ background: STATUS_COLORS.done }} />Завершено <b>{kpi.done}</b></span>
          </div>
        </div>

        {activity}
      </div>

      {!rows.length ? (
        <div className={styles.empty}>Нет отделов</div>
      ) : grouped ? (
        groups.map(g => (
          <div key={g.title} className={styles.groupSection}>
            <div className={styles.groupHead}>
              <span className={styles.gdot} style={{ background: g.color }} />
              {g.title} <span className={styles.cnt}>({g.list.length})</span>
            </div>
            {renderCards(g.list)}
          </div>
        ))
      ) : (
        renderCards(sorted)
      )}
    </div>
  );
};
