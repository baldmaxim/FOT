import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent, FC } from 'react';
import { Upload, AlertTriangle } from 'lucide-react';
import { downloadsService } from '../../services/downloadsService';
import styles from '../../styles/SigurDriverUploader.module.css';

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; fileName: string; sizeMb: string }
  | { kind: 'success'; sizeMb: string }
  | { kind: 'error'; message: string };

export const SigurDriverUploader: FC = () => {
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    setState({ kind: 'uploading', fileName: file.name, sizeMb });
    try {
      const res = await downloadsService.uploadSigurReaderDriver(file);
      setState({ kind: 'success', sizeMb: (res.size / 1024 / 1024).toFixed(1) });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Не удалось загрузить файл',
      });
    }
  }, []);

  return (
    <div className={styles.wrapper}>
      <div className={styles.label}>
        <span className={styles.title}>
          <AlertTriangle size={14} />
          Временно: загрузка драйвера Sigur Reader EH в R2
        </span>
        <span className={styles.hint}>
          Выберите файл <code>Sigur Reader EH Setup 1.0.0.exe</code> — он зальётся в S3 под ключом{' '}
          <code>public/downloads/sigur-reader-eh-setup-1.0.0.exe</code> и станет доступен по кнопке «Скачать драйвер».
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        className={styles.input}
        onChange={handleChange}
        accept=".exe,application/octet-stream"
      />

      <button
        type="button"
        className={styles.btn}
        onClick={handlePick}
        disabled={state.kind === 'uploading'}
      >
        <Upload size={14} />
        {state.kind === 'uploading' ? 'Загрузка…' : 'Выбрать файл'}
      </button>

      {state.kind === 'uploading' && (
        <span className={styles.status}>
          Загружаю {state.fileName} ({state.sizeMb} МБ)…
        </span>
      )}
      {state.kind === 'success' && (
        <span className={`${styles.status} ${styles.statusOk}`}>
          Готово ({state.sizeMb} МБ загружено в R2). Можно нажимать «Скачать драйвер».
        </span>
      )}
      {state.kind === 'error' && (
        <span className={`${styles.status} ${styles.statusError}`}>
          Ошибка: {state.message}
        </span>
      )}
    </div>
  );
};
