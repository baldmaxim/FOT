import { useCallback, useMemo, useState } from 'react';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { payrollRegistryService, type IPayrollSupplementFile } from '../../../services/payrollRegistryService';
import { isPreviewableSupplementFile } from '../../../utils/payrollSupplementFiles';
import type { FileDisposition } from '../../documents/FileViewer';

interface IPreviewTarget {
  supplementId: number;
  file: IPayrollSupplementFile;
}

export interface ISupplementFilePreview {
  fileName: string;
  mimeType: string;
  /** Стабильна на всё время просмотра: FileViewer перезапрашивает ссылку при её смене. */
  urlLoader: (disposition: FileDisposition) => Promise<string>;
}

/**
 * Открыть файл разовой доплаты по клику (ссылку сервер выдаёт только тогда): PDF и картинки — в просмотрщике
 * (preview → FilePreviewModal), DOC/DOCX — сразу скачиваются. Пока открыт просмотр, окна под ним не закрываются
 * по Escape — проверяйте preview.
 */
export const useSupplementFileOpen = () => {
  const toast = useToast();
  const [target, setTarget] = useState<IPreviewTarget | null>(null);

  const open = useCallback((supplementId: number, file: IPayrollSupplementFile) => {
    if (isPreviewableSupplementFile(file.mime_type)) {
      setTarget({ supplementId, file });
      return;
    }
    void payrollRegistryService.getSupplementFileUrl(supplementId, file.id, 'attachment')
      .then(url => {
        // Content-Disposition: attachment у ссылки — браузер скачивает файл, не уходя со страницы.
        const link = document.createElement('a');
        link.href = url;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось скачать файл');
      });
  }, [toast]);

  const preview = useMemo<ISupplementFilePreview | null>(() => (target && {
    fileName: target.file.file_name,
    mimeType: target.file.mime_type,
    urlLoader: disposition => payrollRegistryService.getSupplementFileUrl(target.supplementId, target.file.id, disposition),
  }), [target]);

  const closePreview = useCallback(() => setTarget(null), []);

  return { open, preview, closePreview };
};
