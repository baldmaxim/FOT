import { useRef, useState, type ChangeEvent, type FC, type ReactElement } from 'react';
import { sigurAdminService, type ImportTabNumbersResult } from '../../../services/sigurAdminService';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { ApiError } from '../../../api/client';

interface IImportTabNumbersModalProps {
  onClose: () => void;
  onDone: () => void;
}

type Status = 'idle' | 'uploading' | 'done' | 'error';

interface ISection {
  title: string;
  count: number;
  render: () => ReactElement;
}

/**
 * ВРЕМЕННАЯ модалка импорта табельных номеров из Excel.
 * Формат файла: данные с 9-й строки, ФИО в объединённых колонках 1-3,
 * табельный номер в 4-й колонке. Пишет в Sigur только отсутствующие номера.
 */
export const ImportTabNumbersModal: FC<IImportTabNumbersModalProps> = ({ onClose, onDone }) => {
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ImportTabNumbersResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [openSection, setOpenSection] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const overlayDismiss = useOverlayDismiss(() => {
    if (status !== 'uploading') onClose();
  });

  const handleFile = async (file: File): Promise<void> => {
    setStatus('uploading');
    setErrorMsg('');
    setResult(null);
    try {
      const data = await sigurAdminService.importTabNumbers(file);
      setResult(data);
      setStatus('done');
      if (data.stats.updated > 0) onDone();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Ошибка импорта файла';
      setErrorMsg(message);
      setStatus('error');
    }
  };

  const onPickFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void handleFile(file);
  };

  const nameList = (items: string[]): ReactElement => (
    <ul className="ep-import-list">
      {items.map((name, idx) => <li key={`${name}-${idx}`}>{name}</li>)}
    </ul>
  );

  const sections: ISection[] = result
    ? [
        {
          title: 'Записано',
          count: result.updated.length,
          render: () => (
            <ul className="ep-import-list">
              {result.updated.map((r, idx) => <li key={idx}>{r.name} — {r.tab}</li>)}
            </ul>
          ),
        },
        {
          title: 'Конфликты (уже задан другой номер)',
          count: result.conflicts.length,
          render: () => (
            <ul className="ep-import-list">
              {result.conflicts.map((r, idx) => (
                <li key={idx}>{r.name}: в Sigur «{r.existing}», в файле «{r.fromFile}»</li>
              ))}
            </ul>
          ),
        },
        {
          title: 'Ошибки записи',
          count: result.failed.length,
          render: () => (
            <ul className="ep-import-list">
              {result.failed.map((r, idx) => <li key={idx}>{r.name}: {r.error}</li>)}
            </ul>
          ),
        },
        {
          title: 'Неоднозначные ФИО в файле',
          count: result.ambiguousFile.length,
          render: () => nameList(result.ambiguousFile),
        },
        {
          title: 'Неоднозначные ФИО в Sigur',
          count: result.ambiguousSigur.length,
          render: () => nameList(result.ambiguousSigur),
        },
        {
          title: 'В файле нет номера',
          count: result.emptyInFile.length,
          render: () => nameList(result.emptyInFile),
        },
        {
          title: 'Строки файла без сотрудника Sigur',
          count: result.unmatchedFileRows.length,
          render: () => (
            <ul className="ep-import-list">
              {result.unmatchedFileRows.map((r, idx) => <li key={idx}>{r.fio}{r.tab ? ` — ${r.tab}` : ''}</li>)}
            </ul>
          ),
        },
        {
          title: 'Сотрудники Sigur без строки в файле',
          count: result.notInFile.length,
          render: () => nameList(result.notInFile),
        },
      ]
    : [];

  return (
    <div className="ep-modal-overlay" {...overlayDismiss}>
      <div className="ep-modal ep-modal-wide">
        <div className="ep-modal-header">
          <div className="ep-modal-heading">
            <div className="ep-modal-title">Импорт табельных номеров (временный)</div>
          </div>
        </div>

        <div className="ep-modal-body">
          <div className="ep-modal-stack">
            <p style={{ margin: 0, opacity: 0.8, fontSize: 13 }}>
              Excel-файл: данные с 9-й строки, ФИО в объединённых колонках 1-3, табельный
              номер — в 4-й колонке. Запишутся только <b>отсутствующие</b> номера
              (существующие не перезаписываются).
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              hidden
              onChange={onPickFile}
            />

            {status !== 'done' && (
              <button
                className="ep-modal-btn primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={status === 'uploading'}
              >
                {status === 'uploading' ? 'Импорт...' : 'Выбрать Excel и импортировать'}
              </button>
            )}

            {status === 'error' && (
              <div className="ep-modal-field--error" style={{ color: 'var(--color-danger, #d33)' }}>
                {errorMsg}
              </div>
            )}

            {status === 'done' && result && (
              <>
                <div className="ep-import-stats">
                  <span>Всего в Sigur: <b>{result.stats.sigurTotal}</b></span>
                  <span>Строк в файле: <b>{result.stats.fileRows}</b></span>
                  <span>Записано: <b>{result.stats.updated}</b></span>
                  <span>Уже было: <b>{result.alreadySet}</b></span>
                  <span>Конфликтов: <b>{result.stats.conflicts}</b></span>
                  <span>Нет в файле: <b>{result.stats.notInFile}</b></span>
                  <span>Строк без сотрудника: <b>{result.stats.unmatched}</b></span>
                </div>

                {sections.map(section => (
                  <div key={section.title} className="ep-import-section">
                    <button
                      type="button"
                      className="ep-import-section-head"
                      onClick={() => setOpenSection(prev => (prev === section.title ? null : section.title))}
                      disabled={section.count === 0}
                    >
                      {openSection === section.title ? '▾' : '▸'} {section.title} ({section.count})
                    </button>
                    {openSection === section.title && section.count > 0 && (
                      <div className="ep-import-section-body">{section.render()}</div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="ep-modal-footer">
          <button className="ep-modal-btn secondary" onClick={onClose} disabled={status === 'uploading'}>
            {status === 'done' ? 'Закрыть' : 'Отмена'}
          </button>
          {status === 'done' && (
            <button
              className="ep-modal-btn primary"
              onClick={() => { setStatus('idle'); setResult(null); }}
            >
              Импортировать ещё
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
