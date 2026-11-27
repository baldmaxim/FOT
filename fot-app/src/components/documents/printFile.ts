import styles from './FileViewer.module.css';

interface IPrintFileOptions {
  /** PDF печатается просмотрщиком браузера как есть; иначе — картинка, вписанная в лист. */
  pdf: boolean;
  /** Поворот картинки, как на экране (0/90/180/270). */
  rotation: number;
  /** Заголовок документа печати — им браузер предлагает имя PDF при «Сохранить как PDF». */
  title: string;
  /** Картинка не загрузилась — печатать нечего. */
  onError: () => void;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/**
 * Лист с одной картинкой: по центру, вписана в поле печати. Боком (90/270) — пределы ширины и высоты меняются местами:
 * повёрнутая картинка занимает на листе ширину своей высоты.
 */
export const imagePrintHtml = (url: string, rotation: number, title: string): string => {
  const sideways = rotation % 180 !== 0;
  const maxWidth = sideways ? '100vh' : '100vw';
  const maxHeight = sideways ? '100vw' : '100vh';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page { margin: 10mm; }
html, body { margin: 0; }
img { position: fixed; top: 50%; left: 50%; max-width: ${maxWidth}; max-height: ${maxHeight};
  transform: translate(-50%, -50%) rotate(${rotation}deg); }
</style></head><body><img src="${escapeHtml(url)}" alt=""></body></html>`;
};

/**
 * Печать файла без страницы портала (27.11.2026): скрытый iframe с одним файлом → окно печати браузера. url — своего
 * домена (blob:): iframe чужого домена (ссылка R2) скрипт распечатать не может. Возвращает cleanup — убирает iframe и
 * освобождает blob; вызывать по закрытии просмотра и перед следующей печатью: у PDF событие afterprint может не прийти.
 */
export const printFile = (url: string, { pdf, rotation, title, onError }: IPrintFileOptions): (() => void) => {
  const frame = document.createElement('iframe');
  frame.className = styles.printFrame;
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    frame.remove();
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  };

  frame.addEventListener('load', () => {
    const win = frame.contentWindow;
    if (done || !win) return;
    if (!pdf) {
      const image = win.document.querySelector('img');
      if (!image || !image.complete || image.naturalWidth === 0) {
        cleanup();
        onError();
        return;
      }
    }
    // Скан убираем после печати. PDF — нет: когда его кадр шлёт afterprint, не видно, а убранный раньше времени кадр
    // не распечатается; его убирает закрытие просмотра или следующая печать.
    if (!pdf) win.addEventListener('afterprint', cleanup, { once: true });
    // Фокус — обратно на страницу (кнопку «Печать»): иначе он остаётся в скрытом iframe и Escape не закрывает
    // просмотр, пока iframe не убран (у PDF — до закрытия просмотра).
    const previous = document.activeElement;
    try {
      win.focus();
      win.print();
    } catch {
      cleanup();
      onError();
    }
    if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) {
      previous.focus({ preventScroll: true });
    }
    if (document.activeElement === frame) frame.blur();
  }, { once: true });

  if (pdf) frame.src = url;
  else frame.srcdoc = imagePrintHtml(url, rotation, title);
  document.body.appendChild(frame);
  return cleanup;
};
