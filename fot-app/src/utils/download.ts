export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.style.display = 'none';
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Имя файла из заголовка Content-Disposition.
 * Приоритет у RFC 5987 (`filename*=UTF-8''…`) — сервер кодирует туда кириллицу;
 * при битом percent-encoding возвращаем сырое значение, а не падаем.
 */
export function parseContentDispositionFilename(
  contentDisposition: string | null,
  fallbackName: string,
): string {
  if (!contentDisposition) return fallbackName;

  const utfMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1]);
    } catch {
      return utfMatch[1];
    }
  }

  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) {
    try {
      return decodeURIComponent(plainMatch[1]);
    } catch {
      return plainMatch[1];
    }
  }

  return fallbackName;
}
