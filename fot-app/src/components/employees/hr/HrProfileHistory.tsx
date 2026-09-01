import { type FC } from 'react';
import type { IHrCatalog, IHrHistoryItem } from '../../../types/hrProfile';
import { displayFieldValue, fmtDateTime } from './hrFormat';
import styles from './HrProfileModal.module.css';

const EVENT_LABEL: Record<IHrHistoryItem['event_type'], string> = {
  created: 'Реквизиты заведены',
  profile_update: 'Изменены данные сотрудника',
  file_upload: 'Загружен файл',
  file_delete: 'Удалён файл',
  ocr_run: 'Документ распознан',
  ocr_apply: 'Применено из документа',
  ocr_dismiss: 'Расхождение отклонено',
  zup_toggle: 'Изменён статус выгрузки в ЗУП',
  zup_export: 'Сформирована выгрузка ЗУП',
  attach_existing: 'Прикреплён черновик мастера',
};

const EVENT_TAG: Record<IHrHistoryItem['event_type'], string> = {
  created: 'Карточка', profile_update: 'Карточка', file_upload: 'Файлы', file_delete: 'Файлы',
  ocr_run: 'Распознавание', ocr_apply: 'Распознавание', ocr_dismiss: 'Распознавание',
  zup_toggle: 'Статусы', zup_export: 'Статусы', attach_existing: 'Карточка',
};

const TAG_CLASS: Record<string, string> = {
  Статусы: styles.tagStatuses,
  Файлы: styles.tagFiles,
  Распознавание: styles.tagOcr,
};

interface IHrProfileHistoryProps {
  items: IHrHistoryItem[];
  catalog: IHrCatalog | undefined;
  loading?: boolean;
}

/** Лента «История изменений» (правая колонка «Реквизитов», как в PassDesk). */
export const HrProfileHistory: FC<IHrProfileHistoryProps> = ({ items, catalog, loading }) => {
  const labels = new Map((catalog?.fields ?? []).map(f => [f.key, f.label]));
  return (
    <div className={styles.history}>
      <h4>История изменений</h4>
      {loading && <div className={styles.muted}>Загрузка…</div>}
      {!loading && items.length === 0 && <div className={styles.muted}>Пока пусто</div>}
      {items.map(item => {
        const fields = (item.changed_fields ?? []).filter(f => !f.startsWith('conflict:'));
        const conflicts = (item.changed_fields ?? []).filter(f => f.startsWith('conflict:')).map(f => f.slice(9));
        return (
          <div key={item.id} className={styles.historyItem}>
            <div className={styles.historyWhen}>{fmtDateTime(item.changed_at)}</div>
            <span className={`${styles.historyTag} ${TAG_CLASS[EVENT_TAG[item.event_type]] ?? ''}`}>{EVENT_TAG[item.event_type]}</span>
            <div className={styles.historyTitle}>{EVENT_LABEL[item.event_type]}</div>
            {item.document_name && <div className={styles.historyLine}>Файл: {item.document_name}</div>}
            {fields.length > 0 && (
              <div className={styles.historyLine}>
                Изменены поля: {fields.map(f => labels.get(f) ?? f).join(', ')}
              </div>
            )}
            {item.old_values && Object.keys(item.old_values).length > 0 && (
              <div className={styles.historyOld}>
                {Object.entries(item.old_values).map(([k, v]) => (
                  <div key={k}>{labels.get(k) ?? k}: {displayFieldValue(k, v, catalog)} →</div>
                ))}
              </div>
            )}
            {conflicts.length > 0 && <div className={styles.historyLine}>Расхождения: {conflicts.map(f => labels.get(f) ?? f).join(', ')}</div>}
            <div className={styles.historyBy}>
              {item.changed_source === 'ocr' ? 'Распознавание' : item.changed_source === 'migration' ? 'Перенос из PassDesk' : `Изменил: ${item.changed_by_name ?? '—'}`}
            </div>
          </div>
        );
      })}
    </div>
  );
};
