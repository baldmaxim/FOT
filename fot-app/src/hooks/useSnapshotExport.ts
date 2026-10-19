import { useState } from 'react';

import { ApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { triggerBlobDownload } from '../utils/download';
import type { ITableExportSnapshot } from '../utils/tableView';

/** Предел снимка xlsx на сервере (TABLE_SNAPSHOT_MAX_ROWS). */
export const SNAPSHOT_EXPORT_MAX_ROWS = 1000;

/**
 * «Экспорт» клиентской таблицы (общежитие, таблицы «Справочника» «Зарплаты»): ровно видимые строки —
 * снимок собирает build, xlsx оформляет сервер (send). Больше предела снимка — сообщение без запроса.
 */
export const useSnapshotExport = <Row,>(
  build: (rows: ReadonlyArray<Row>) => ITableExportSnapshot,
  send: (snapshot: ITableExportSnapshot) => Promise<{ blob: Blob; filename: string }>,
) => {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const exportRows = async (rows: ReadonlyArray<Row>) => {
    if (exporting) return;
    if (rows.length > SNAPSHOT_EXPORT_MAX_ROWS) {
      toast.error(`Больше ${SNAPSHOT_EXPORT_MAX_ROWS} строк — сузьте фильтр`);
      return;
    }
    setExporting(true);
    try {
      const { blob, filename } = await send(build(rows));
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось выгрузить таблицу');
    } finally {
      setExporting(false);
    }
  };

  return { exporting, exportRows };
};
