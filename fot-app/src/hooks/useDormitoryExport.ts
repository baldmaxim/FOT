import { useState } from 'react';

import { ApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { dormitoryService, type IDormitoryStay } from '../services/dormitoryService';
import { triggerBlobDownload } from '../utils/download';
import { buildDormitoryExport, DORMITORY_EXPORT_MAX_ROWS } from '../utils/dormitoryTable';

/**
 * «Экспорт» таблицы «Общежитие» (вкладка кадров и окно «Справочника»): ровно видимые строки.
 * Больше предела снимка сервера — сообщение без запроса.
 */
export const useDormitoryExport = () => {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const exportRows = async (rows: ReadonlyArray<IDormitoryStay>) => {
    if (exporting) return;
    if (rows.length > DORMITORY_EXPORT_MAX_ROWS) {
      toast.error(`Больше ${DORMITORY_EXPORT_MAX_ROWS} строк — сузьте фильтр`);
      return;
    }
    setExporting(true);
    try {
      const { blob, filename } = await dormitoryService.exportTable(buildDormitoryExport(rows));
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось выгрузить таблицу');
    } finally {
      setExporting(false);
    }
  };

  return { exporting, exportRows };
};
