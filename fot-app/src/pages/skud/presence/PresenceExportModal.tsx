import { useMemo, useState, useEffect, type FC } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { useToast } from '../../../contexts/ToastContext';
import { skudService } from '../../../services/skudService';
import { triggerBlobDownload } from '../../../utils/download';
import { presetRange, todayIso, type PresetKey } from '../../../components/feedback/deptStats';
import { EntityFilter, type IEntityFilterOption } from './EntityFilter';
import styles from './PresenceExportModal.module.css';

interface IPresenceExportModalProps {
  onClose: () => void;
}

const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'yesterday', label: 'Вчера' },
  { key: 'today', label: 'Сегодня' },
  { key: 'week', label: '7 дней' },
  { key: 'month', label: 'Текущий месяц' },
  { key: 'prevmonth', label: 'Прошлый месяц' },
];

const formatDateShort = (iso: string): string => iso.split('-').reverse().join('.');

export const PresenceExportModal: FC<IPresenceExportModalProps> = ({ onClose }) => {
  const overlayHandlers = useOverlayDismiss(onClose);
  const toast = useToast();
  const today = useMemo(() => todayIso(), []);
  const initial = useMemo(() => presetRange('month', todayIso()), []);

  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [selectedObjects, setSelectedObjects] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const periodValid = !!from && !!to && from <= to;

  const filtersQuery = useQuery({
    queryKey: ['presence-export-filters', from, to],
    queryFn: ({ signal }) => skudService.getPresenceExportFilters(from, to, signal),
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

  // Ключи, исчезнувшие из нового списка (сменили период), из выбора вычищаем.
  useEffect(() => {
    if (!filtersQuery.data) return;
    const objectKeys = new Set(filtersQuery.data.objects.map(o => o.key));
    const groupKeys = new Set(filtersQuery.data.groups.map(g => g.key));
    setSelectedObjects(prev => {
      const next = new Set([...prev].filter(key => objectKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
    setSelectedGroups(prev => {
      const next = new Set([...prev].filter(key => groupKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [filtersQuery.data]);

  const activePreset = PRESETS.find(p => {
    const range = presetRange(p.key, today);
    return range.from === from && range.to === to;
  })?.key;

  const toggle = (setter: typeof setSelectedObjects) => (id: string) => {
    setter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroupBlock = (ids: string[], checked: boolean) => {
    setSelectedGroups(prev => {
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
      const blob = await skudService.exportPresenceByObject({
        date_from: from,
        date_to: to,
        object_keys: [...selectedObjects],
        group_keys: [...selectedGroups],
      });
      triggerBlobDownload(
        blob,
        `Сотрудники_на_объектах_${formatDateShort(from)}-${formatDateShort(to)}.xlsx`,
      );
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
                    const range = presetRange(preset.key, today);
                    setFrom(range.from);
                    setTo(range.to);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {!periodValid && <div className={styles.error}>Начало периода позже конца</div>}
          </div>

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
              <EntityFilter
                label="Фильтр по отделам"
                searchPlaceholder="Поиск отдела"
                emptyText="За период данных нет"
                allEntities={groupOptions}
                selected={selectedGroups}
                onToggle={toggle(setSelectedGroups)}
                onClear={() => setSelectedGroups(new Set())}
                groupByGroup
                onToggleGroup={toggleGroupBlock}
              />
            </div>
            <div className={styles.hint}>Пусто = выгружаются все.</div>
          </div>

          <div className={styles.notes}>
            <div>В файле лист на каждый день; группы раскрываются кнопкой «+» слева.</div>
            <div>Отдел берётся текущий, а не на дату прохода.</div>
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
