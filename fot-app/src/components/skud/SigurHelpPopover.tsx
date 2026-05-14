import { useCallback, useEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import { Download, HelpCircle, BookOpen } from 'lucide-react';
import { downloadsService } from '../../services/downloadsService';
import styles from '../../styles/SigurHelpPopover.module.css';

export const SigurHelpPopover: FC = () => {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open]);

  const handleDownload = useCallback(async () => {
    setError(null);
    setDownloading(true);
    try {
      const { download_url, file_name } = await downloadsService.getSigurReaderDriverUrl();
      const link = document.createElement('a');
      link.href = download_url;
      link.download = file_name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось получить ссылку на драйвер');
    } finally {
      setDownloading(false);
    }
  }, []);

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(prev => !prev)}
        title="Как привязать пропуск"
        aria-label="Как привязать пропуск"
        aria-expanded={open}
      >
        <HelpCircle size={18} />
      </button>

      {open && (
        <div className={styles.popover} role="dialog" aria-label="Привязка пропуска в ФОТ">
          <h3 className={styles.title}>Привязка пропуска в ФОТ</h3>
          <p className={styles.text}>
            Чтобы выдать сотруднику новый RFID-пропуск, нажмите <strong>Считать пропуск</strong>, приложите карту
            к USB-считывателю и привяжите её к сотруднику. Открывать Sigur Manager не нужно — биндинг полностью
            делается отсюда.
          </p>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.downloadBtn}
              onClick={() => { void handleDownload(); }}
              disabled={downloading}
            >
              <Download size={14} />
              {downloading ? 'Получение ссылки…' : 'Скачать драйвер Sigur Reader EH'}
            </button>

            <a
              className={styles.docsLink}
              href="/docs/skud-card-reader.html"
              target="_blank"
              rel="noreferrer"
            >
              <BookOpen size={14} />
              Подробная инструкция
            </a>
          </div>

          {error && <p className={styles.error}>{error}</p>}
        </div>
      )}
    </div>
  );
};
