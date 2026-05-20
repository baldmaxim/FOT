import { type FC, Fragment, useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Save, RotateCcw } from 'lucide-react';
import { productionCalendarService, type IProductionCalendarEntry } from '../../services/productionCalendarService';
import { getProductionCalendarQueryKey, useProductionCalendar } from '../../hooks/useSettingsData';
import { useToast } from '../../contexts/ToastContext';
import { computeWorkingNorm } from '../../utils/calendarUtils';
import { MonthCalendar, type CalendarMode } from './MonthCalendar';
import styles from './ProductionCalendarPage.module.css';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

interface IEditingRow {
  month: number;
  norm_days: number;
  norm_hours: number;
  holidays: string[];
  mandatory_holidays: string[];
  pre_holidays: string[];
  mode: CalendarMode;
}

const EMPTY_ENTRIES: IProductionCalendarEntry[] = [];

const toggleInArray = (arr: string[], iso: string): string[] =>
  arr.includes(iso) ? arr.filter(d => d !== iso) : [...arr, iso].sort();

export const ProductionCalendarPage: FC = () => {
  const [year, setYear] = useState(new Date().getFullYear());
  const [saving, setSaving] = useState<number | null>(null);
  const [editing, setEditing] = useState<IEditingRow | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useProductionCalendar(year);
  const entries = data ?? EMPTY_ENTRIES;

  const entryMap = useMemo(() => new Map(entries.map(e => [e.month, e])), [entries]);

  const handleEdit = (month: number) => {
    if (editing?.month === month) {
      setEditing(null);
      return;
    }
    const entry = entryMap.get(month);
    const holidays = entry?.holidays ?? [];
    const mandatory_holidays = entry?.mandatory_holidays ?? [];
    const pre_holidays = entry?.pre_holidays ?? [];
    setEditing({
      month,
      norm_days: entry?.norm_days ?? 0,
      norm_hours: entry?.norm_hours ?? 0,
      holidays,
      mandatory_holidays,
      pre_holidays,
      mode: 'holiday',
    });
  };

  const handleToggleDay = (iso: string) => {
    if (!editing) return;
    const next: IEditingRow = { ...editing };
    if (editing.mode === 'holiday') {
      next.holidays = toggleInArray(editing.holidays, iso);
    } else if (editing.mode === 'mandatory') {
      next.mandatory_holidays = toggleInArray(editing.mandatory_holidays, iso);
    } else {
      next.pre_holidays = toggleInArray(editing.pre_holidays, iso);
    }
    const norm = computeWorkingNorm(year, editing.month, next.holidays, next.mandatory_holidays, next.pre_holidays);
    next.norm_days = norm.norm_days;
    next.norm_hours = norm.norm_hours;
    setEditing(next);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(editing.month);
    try {
      const updated = await productionCalendarService.update(year, editing.month, {
        norm_days: editing.norm_days,
        norm_hours: editing.norm_hours,
        holidays: editing.holidays,
        mandatory_holidays: editing.mandatory_holidays,
        pre_holidays: editing.pre_holidays,
      });
      queryClient.setQueryData<IProductionCalendarEntry[]>(
        getProductionCalendarQueryKey(year),
        (prev = EMPTY_ENTRIES) => {
          const next = prev.filter(entry => entry.month !== updated.month);
          next.push(updated);
          next.sort((left, right) => left.month - right.month);
          return next;
        },
      );
      setEditing(null);
      toast.success('Сохранено');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения календаря');
    } finally {
      setSaving(null);
    }
  };

  const handleCancel = () => setEditing(null);

  const totalDays = entries.reduce((s, e) => s + e.norm_days, 0);
  const totalHours = entries.reduce((s, e) => s + Number(e.norm_hours), 0);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>Производственный календарь</h2>
        <div className={styles.yearNav}>
          <button className={styles.yearBtn} onClick={() => { setEditing(null); setYear(y => y - 1); }}>
            <ChevronLeft size={18} />
          </button>
          <span className={styles.yearLabel}>{year}</span>
          <button className={styles.yearBtn} onClick={() => { setEditing(null); setYear(y => y + 1); }}>
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className={styles.loading}>Загрузка...</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Месяц</th>
                <th>Рабочих дней</th>
                <th>Рабочих часов</th>
                <th>Праздники</th>
                <th>Всегда-выходные</th>
                <th>Предпраздники</th>
                <th>Изменено</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {MONTH_NAMES.map((name, i) => {
                const month = i + 1;
                const entry = entryMap.get(month);
                const isEditing = editing?.month === month;

                return (
                  <Fragment key={month}>
                    <tr className={entry?.is_custom ? styles.customRow : ''}>
                      <td className={styles.monthCell}>{name}</td>
                      <td>
                        {isEditing ? (
                          <input
                            type="number"
                            className={styles.input}
                            value={editing.norm_days}
                            onChange={e => setEditing({ ...editing, norm_days: parseInt(e.target.value) || 0 })}
                            min={0}
                            max={31}
                          />
                        ) : (
                          entry?.norm_days ?? '—'
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            type="number"
                            className={styles.input}
                            value={editing.norm_hours}
                            onChange={e => setEditing({ ...editing, norm_hours: parseFloat(e.target.value) || 0 })}
                            min={0}
                            max={248}
                            step={0.5}
                          />
                        ) : (
                          entry?.norm_hours ?? '—'
                        )}
                      </td>
                      <td>
                        <span className={styles.countBadge}>
                          {(isEditing ? editing.holidays : entry?.holidays || []).length} дат
                        </span>
                      </td>
                      <td>
                        <span className={styles.countBadge}>
                          {(isEditing ? editing.mandatory_holidays : entry?.mandatory_holidays || []).length} дат
                        </span>
                      </td>
                      <td>
                        <span className={styles.countBadge}>
                          {(isEditing ? editing.pre_holidays : entry?.pre_holidays || []).length} дат
                        </span>
                      </td>
                      <td className={styles.customCell}>
                        {entry?.is_custom && (
                          <span className={styles.customBadge}>Изменено</span>
                        )}
                      </td>
                      <td>
                        <button
                          className={styles.editBtn}
                          onClick={() => handleEdit(month)}
                        >
                          {isEditing ? 'Закрыть' : 'Изменить'}
                        </button>
                      </td>
                    </tr>
                    {isEditing && (
                      <tr className={styles.calendarRow}>
                        <td colSpan={8}>
                          <div className={styles.calendarPanel}>
                            <div className={styles.modeSwitch}>
                              <button
                                type="button"
                                className={`${styles.modeBtn} ${editing.mode === 'holiday' ? styles.modeBtnActive : ''}`}
                                onClick={() => setEditing({ ...editing, mode: 'holiday' })}
                              >
                                <span className={`${styles.modeDot} ${styles.modeDotHoliday}`} />
                                Праздник
                              </button>
                              <button
                                type="button"
                                className={`${styles.modeBtn} ${editing.mode === 'mandatory' ? styles.modeBtnActive : ''}`}
                                onClick={() => setEditing({ ...editing, mode: 'mandatory' })}
                              >
                                <span className={`${styles.modeDot} ${styles.modeDotMandatory}`} />
                                Всегда-выходной
                              </button>
                              <button
                                type="button"
                                className={`${styles.modeBtn} ${editing.mode === 'pre_holiday' ? styles.modeBtnActive : ''}`}
                                onClick={() => setEditing({ ...editing, mode: 'pre_holiday' })}
                              >
                                <span className={`${styles.modeDot} ${styles.modeDotPreHoliday}`} />
                                Предпраздничный
                              </button>
                            </div>
                            <MonthCalendar
                              year={year}
                              month={month}
                              holidays={editing.holidays}
                              mandatoryHolidays={editing.mandatory_holidays}
                              preHolidays={editing.pre_holidays}
                              mode={editing.mode}
                              onToggleDay={handleToggleDay}
                            />
                            <div className={styles.calendarActions}>
                              <button
                                className={styles.saveBtn}
                                onClick={handleSave}
                                disabled={saving === month}
                              >
                                <Save size={14} />
                                {saving === month ? 'Сохранение...' : 'Сохранить'}
                              </button>
                              <button className={styles.cancelBtn} onClick={handleCancel}>
                                <RotateCcw size={14} />
                                Отмена
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              <tr className={styles.totalRow}>
                <td>Итого</td>
                <td>{totalDays}</td>
                <td>{totalHours}</td>
                <td colSpan={5} />
              </tr>
            </tbody>
          </table>
          <div className={styles.legend}>
            Кликните «Изменить» для месяца — раскроется календарик. Переключайте режим «Праздник» / «Всегда-выходной» / «Предпраздничный»
            и кликом помечайте дни. Поля «Рабочих дней» и «Рабочих часов» пересчитываются автоматически.
            «Праздники» и «Предпраздничный» учитываются только графиками с флагом «учитывать праздники РФ»;
            «Всегда-выходные» — для всех графиков. Предпраздничный день — рабочий, но норма часов на него −1ч.
          </div>
        </div>
      )}
    </div>
  );
};
