import { useMemo, useState, useEffect, type FC } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { useToast } from '../../../contexts/ToastContext';
import { skudService } from '../../../services/skudService';
import { triggerBlobDownload } from '../../../utils/download';
import { presetRange, todayIso, type PresetKey } from '../../../components/feedback/deptStats';
import { EntityFilter, type IEntityFilterOption } from './EntityFilter';
import { buildMonthOptions, monthFileSuffix, monthRange, shiftMonth } from './presenceExportMonths';
import styles from './PresenceExportModal.module.css';

interface IPresenceExportModalProps {
  onClose: () => void;
}

type ExportMode = 'daily' | 'month';

const MODES: Array<{ key: ExportMode; label: string }> = [
  { key: 'daily', label: 'Списки по дням' },
  { key: 'month', label: 'Статистика за месяц' },
];

const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'yesterday', label: 'Вчера' },
  { key: 'today', label: 'Сегодня' },
  { key: 'week', label: '7 дней' },
  { key: 'month', label: 'Текущий месяц' },
  { key: 'prevmonth', label: 'Прошлый месяц' },
];

const formatDateShort = (iso: string): string => iso.split('-').reverse().join('.');

/** Оставляет в выборе только ключи, которые есть в списке; без изменений — тот же Set. */
const pruneSelection = (prev: Set<string>, available: Set<string>): Set<string> => {
  const next = new Set([...prev].filter(key => available.has(key)));
  return next.size === prev.size ? prev : next;
};

export const PresenceExportModal: FC<IPresenceExportModalProps> = ({ onClose }) => {
  const overlayHandlers = useOverlayDismiss(onClose);
  const toast = useToast();
  const today = useMemo(() => todayIso(), []);
  const initial = useMemo(() => presetRange('month', todayIso()), []);
  const monthOptions = useMemo(() => buildMonthOptions(today), [today]);

  const [mode, setMode] = useState<ExportMode>('daily');
  // У каждого режима свой выбор: переключение туда и обратно ничего не сбрасывает.
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [dailyObjects, setDailyObjects] = useState<Set<string>>(new Set());
  const [dailyGroups, setDailyGroups] = useState<Set<string>>(new Set());
  const [month, setMonth] = useState(() => shiftMonth(today.slice(0, 7), -1));
  const [monthObjects, setMonthObjects] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const isMonth = mode === 'month';
  const range = useMemo(
    () => (isMonth ? monthRange(month, today) : { from, to }),
    [isMonth, month, today, from, to],
  );
  const periodValid = !!range.from && !!range.to && range.from <= range.to;

  const filtersQuery = useQuery({
    queryKey: ['presence-export-filters', range.from, range.to],
    queryFn: ({ signal }) => skudService.getPresenceExportFilters(range.from, range.to, signal),
    enabled: periodValid,
    staleTime: 60_000,
  });

  const objectOptions: IEntityFilterOption[] = useMemo(
    () => (filtersQuery.data?.objects ?? []).map(o => ({ id: o.key, name: o.name })),
    [filtersQuery.data],
  );
  const groupOptions: IEntityFilterOption[] = useMemo(
    () => (filtersQuery.data?.groups ?? []).map(g => ({
      id: g.key,
      name: g.name,
      group: g.company_name,
    })),
    [filtersQuery.data],
  );

  // Ключи, исчезнувшие из списка (сменили период), вычищаем — только у активного
  // режима: списки пришли за ЕГО период, выбор другого режима они не касаются.
  useEffect(() => {
    if (!filtersQuery.data) return;
    const objectKeys = new Set(filtersQuery.data.objects.map(o => o.key));
    if (isMonth) {
      setMonthObjects(prev => pruneSelection(prev, objectKeys));
      return;
    }
    const groupKeys = new Set(filtersQuery.data.groups.map(g => g.key));
    setDailyObjects(prev => pruneSelection(prev, objectKeys));
    setDailyGroups(prev => pruneSelection(prev, groupKeys));
  }, [filtersQuery.data, isMonth]);

  const activePreset = PRESETS.find(p => {
    const presetDates = presetRange(p.key, today);
    return presetDates.from === from && presetDates.to === to;
  })?.key;

  const selectedObjects = isMonth ? monthObjects : dailyObjects;
  const setSelectedObjects = isMonth ? setMonthObjects : setDailyObjects;

  const toggle = (setter: typeof setDailyObjects) => (id: string) => {
    setter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroupBlock = (ids: string[], checked: boolean) => {
    setDailyGroups(prev => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const handleDownload = async () => {
    if (!periodValid || downloading) return;
    setDownloading(true);
    try {
      const { blob, filename } = isMonth
        ? await skudService.exportPresenceMonthStats(
          { month, object_keys: [...monthObjects] },
          `Сотрудники_на_объектах_${monthFileSuffix(month)}.xlsx`,
        )
        : await skudService.exportPresenceByObject(
          {
            date_from: from,
            date_to: to,
            object_keys: [...dailyObjects],
            group_keys: [...dailyGroups],
          },
          `Сотрудники_на_объектах_${formatDateShort(from)}-${formatDateShort(to)}.xlsx`,
        );
      triggerBlobDownload(blob, filename);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось сформировать файл');
    } finally {
      setDownloading(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className={styles.overlay} {...overlayHandlers}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Экспорт в Excel">
        <div className={styles.header}>
          <span className={styles.title}>Экспорт в Excel</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className={styles.body}>
          <div className={styles.modeSwitch} role="group" aria-label="Что выгрузить">
            {MODES.map(item => (
              <button
                key={item.key}
                type="button"
                className={`${styles.modeButton} ${mode === item.key ? styles.modeButtonActive : ''}`}
                aria-pressed={mode === item.key}
                onClick={() => setMode(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {isMonth ? (
            <div className={styles.section}>
              <label className={styles.label} htmlFor="presence-export-month">Месяц</label>
              <select
                id="presence-export-month"
                className={styles.monthSelect}
                value={month}
                onChange={e => setMonth(e.target.value)}
              >
                {monthOptions.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className={styles.section}>
              <span className={styles.label}>Период</span>
              <div className={styles.dates}>
                <input
                  type="date"
                  className={styles.dateInput}
                  value={from}
                  max={to || undefined}
                  onChange={e => setFrom(e.target.value)}
                />
                <span className={styles.dash}>—</span>
                <input
                  type="date"
                  className={styles.dateInput}
                  value={to}
                  min={from || undefined}
                  onChange={e => setTo(e.target.value)}
                />
              </div>
              <div className={styles.presets}>
                {PRESETS.map(preset => (
                  <button
                    key={preset.key}
                    type="button"
                    className={`${styles.preset} ${activePreset === preset.key ? styles.presetActive : ''}`}
                    aria-pressed={activePreset === preset.key}
                    onClick={() => {
                      const presetDates = presetRange(preset.key, today);
                      setFrom(presetDates.from);
                      setTo(presetDates.to);
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              {!periodValid && <div className={styles.error}>Начало периода позже конца</div>}
            </div>
          )}

          <div className={styles.section}>
            <span className={styles.label}>Фильтры</span>
            {filtersQuery.isLoading && <div className={styles.hint}>Загрузка списков…</div>}
            {filtersQuery.isError && (
              <div className={styles.error}>
                {filtersQuery.error instanceof Error
                  ? filtersQuery.error.message
                  : 'Не удалось загрузить списки'}
              </div>
            )}
            <div className={styles.filtersRow}>
              <EntityFilter
                label="Фильтр по объектам"
                searchPlaceholder="Поиск объекта"
                emptyText="За период данных нет"
                allEntities={objectOptions}
                selected={selectedObjects}
                onToggle={toggle(setSelectedObjects)}
                onClear={() => setSelectedObjects(new Set())}
              />
              {!isMonth && (
                <EntityFilter
                  label="Фильтр по отделам"
                  searchPlaceholder="Поиск отдела"
                  emptyText="За период данных нет"
                  allEntities={groupOptions}
                  selected={dailyGroups}
                  onToggle={toggle(setDailyGroups)}
                  onClear={() => setDailyGroups(new Set())}
                  groupByGroup
                  onToggleGroup={toggleGroupBlock}
                />
              )}
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.cancel} onClick={onClose}>Отмена</button>
          <button
            type="button"
            className={styles.submit}
            onClick={handleDownload}
            disabled={!periodValid || downloading}
          >
            {downloading ? 'Формируется…' : 'Скачать'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
