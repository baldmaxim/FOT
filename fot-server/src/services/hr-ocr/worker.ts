/**
 * DB-очередь распознавания сканов hr_* (hr_ocr_jobs): FOR UPDATE SKIP LOCKED,
 * lease, backoff (порт backoff.js PassDesk: Retry-After либо 2^(n-1)·2с),
 * восстановление зависших lease при старте. Redis не используется.
 *
 * Результат: documents.recognition_result_enc (зашифрованный JSON нормализованных
 * полей). Для сотрудника — автозаполнение пустых полей профиля + конфликты;
 * для черновика — только сохранение (мастер сливает результаты на чтении).
 */
import { execute, query, queryOne, withTransaction } from '../../config/postgres.js';
import { env } from '../../config/env.js';
import { getHrDocumentType } from '../../config/hr-documents.js';
import { isHrCryptoConfigured, encryptJson } from '../hr-crypto.service.js';
import { recognizeDocument, HrOcrError } from './recognize.js';
import { resolveOcrType } from './normalize.js';
import { applyOcrToEmployee } from './apply-employee.js';

const BACKOFF_BASE_MS = 2000;
const TICK_MS = 3000;
const OCR_MAX_IMAGE_BYTES = 12 * 1024 * 1024;

interface IJobRow {
  id: number;
  document_id: number;
  attempts: number;
}

const maxAttempts = (): number => Math.max(1, Number(env.HR_OCR_MAX_ATTEMPTS) || 3);
const concurrency = (): number => Math.max(1, Number(env.HR_OCR_CONCURRENCY) || 2);
const leaseMs = (): number => Math.max(30_000, Number(env.HR_OCR_LEASE_MS) || 300_000);

export const backoffMs = (attemptsMade: number, retryAfterMs?: number | null): number => {
  if (Number.isFinite(retryAfterMs) && (retryAfterMs as number) > 0) return retryAfterMs as number;
  return Math.round(2 ** Math.max(0, attemptsMade - 1) * BACKOFF_BASE_MS);
};

/** Поставить документ в очередь (повторная постановка сбрасывает попытки). */
export const enqueueHrOcr = async (documentId: number, _opts?: { passportType?: 'russian' | 'foreign' | null }): Promise<void> => {
  if (!isHrCryptoConfigured()) return;
  await execute(
    `INSERT INTO hr_ocr_jobs (document_id, state, attempts, next_run_at, lease_until, last_error_code, updated_at)
     VALUES ($1, 'queued', 0, now(), NULL, NULL, now())
     ON CONFLICT (document_id) DO UPDATE SET state = 'queued', attempts = 0, next_run_at = now(), lease_until = NULL, last_error_code = NULL, updated_at = now()`,
    [documentId],
  );
  await execute(`UPDATE documents SET recognition_status = 'pending', recognition_error = NULL WHERE id = $1`, [documentId]);
};

const pickJobs = async (limit: number): Promise<IJobRow[]> =>
  withTransaction(async client => {
    const res = await client.query<IJobRow>(
      `UPDATE hr_ocr_jobs j
          SET state = 'leased', lease_until = now() + ($2 || ' milliseconds')::interval, attempts = attempts + 1, updated_at = now()
        WHERE j.id IN (
          SELECT id FROM hr_ocr_jobs
           WHERE next_run_at <= now()
             AND (state = 'queued' OR (state = 'leased' AND lease_until < now()))
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING j.id, j.document_id, j.attempts`,
      [limit, String(leaseMs())],
    );
    return res.rows;
  });

interface IDocForOcr {
  id: number;
  employee_id: number | null;
  category: string;
  mime_type: string;
  file_size: number;
  deleted_at: string | null;
}

const resolvePassportType = async (doc: IDocForOcr): Promise<'russian' | 'foreign' | null> => {
  if (doc.employee_id) {
    const row = await queryOne<{ passport_type: 'russian' | 'foreign' | null }>(
      `SELECT passport_type FROM employee_hr_profiles WHERE employee_id = $1`,
      [doc.employee_id],
    );
    return row?.passport_type ?? null;
  }
  // Черновик: тип паспорта из payload (расшифровывать не нужно — мастер передаёт при загрузке через link.purpose? нет) →
  // берём из employee_hr_drafts через hr-draft.service (ленивый импорт, чтобы не зациклить модули).
  const { resolveDraftPassportTypeForDocument } = await import('../hr-draft.service.js');
  return resolveDraftPassportTypeForDocument(doc.id);
};

const finishJob = async (jobId: number, documentId: number, state: 'done' | 'failed' | 'needs_review', errorCode: string | null): Promise<void> => {
  await execute(`UPDATE hr_ocr_jobs SET state = $2, last_error_code = $3, lease_until = NULL, updated_at = now() WHERE id = $1`, [jobId, state, errorCode]);
  const docStatus = state === 'done' ? 'done' : state === 'needs_review' ? 'needs_review' : 'failed';
  await execute(
    `UPDATE documents SET recognition_status = $2, recognition_error = $3, recognized_at = CASE WHEN $2 IN ('done','needs_review') THEN now() ELSE recognized_at END,
            recognition_attempts = COALESCE(recognition_attempts, 0) + 1
      WHERE id = $1`,
    [documentId, docStatus, errorCode],
  );
};

const rescheduleJob = async (jobId: number, documentId: number, attempts: number, errorCode: string, retryAfterMs?: number | null): Promise<void> => {
  if (attempts >= maxAttempts()) {
    await finishJob(jobId, documentId, 'failed', errorCode);
    return;
  }
  const delay = backoffMs(attempts, retryAfterMs);
  await execute(
    `UPDATE hr_ocr_jobs SET state = 'queued', next_run_at = now() + ($3 || ' milliseconds')::interval, last_error_code = $2, lease_until = NULL, updated_at = now() WHERE id = $1`,
    [jobId, errorCode, String(delay)],
  );
  await execute(`UPDATE documents SET recognition_status = 'pending', recognition_error = $2 WHERE id = $1`, [documentId, errorCode]);
};

export const processJob = async (job: IJobRow): Promise<void> => {
  const doc = await queryOne<IDocForOcr>(
    `SELECT id, employee_id, category, mime_type, file_size, deleted_at FROM documents WHERE id = $1`,
    [job.document_id],
  );
  if (!doc || doc.deleted_at) {
    await execute(`DELETE FROM hr_ocr_jobs WHERE id = $1`, [job.id]);
    return;
  }
  const type = getHrDocumentType(doc.category);
  const ocrType = resolveOcrType(type?.code ?? null, await resolvePassportType(doc));
  if (!type?.ocrType || !ocrType) {
    await finishJob(job.id, doc.id, 'failed', 'unsupported_document_type');
    return;
  }
  if (Number(doc.file_size) > OCR_MAX_IMAGE_BYTES) {
    await finishJob(job.id, doc.id, 'failed', 'file_too_large');
    return;
  }
  await execute(`UPDATE documents SET recognition_status = 'processing' WHERE id = $1`, [doc.id]);

  try {
    // Ленивый импорт: hr-documents.service импортирует enqueueHrOcr отсюда.
    const { loadHrDocument, loadDecryptedBytes } = await import('../hr-documents.service.js');
    const row = await loadHrDocument(doc.id);
    if (!row) throw new HrOcrError('document not found', 'no_data', false);
    const bytes = await loadDecryptedBytes(row);
    const imageDataUrl = `data:${row.mime_type};base64,${bytes.toString('base64')}`;
    const result = await recognizeDocument({ type: ocrType, imageDataUrl, documentId: doc.id });

    const { enc, keyVersion } = encryptJson({ type: result.type, model: result.model, normalized: result.normalized, qualityGate: result.qualityGate });
    await execute(`UPDATE documents SET recognition_result_enc = $2, recognition_key_version = $3 WHERE id = $1`, [doc.id, enc, keyVersion]);

    if (result.qualityGate === 'failed') {
      await finishJob(job.id, doc.id, 'needs_review', 'quality_gate_failed');
      return;
    }
    if (doc.employee_id) {
      await applyOcrToEmployee(doc.employee_id, doc.id, result.type, result.normalized);
    }
    await finishJob(job.id, doc.id, 'done', null);
  } catch (err) {
    if (err instanceof HrOcrError) {
      console.warn('[hr-ocr] job failed', { documentId: doc.id, type: ocrType, code: err.code, retryable: err.retryable, attempts: job.attempts });
      if (err.retryable) await rescheduleJob(job.id, doc.id, job.attempts, err.code, err.retryAfterMs);
      else await finishJob(job.id, doc.id, 'failed', err.code);
      return;
    }
    console.error('[hr-ocr] job error', { documentId: doc.id, type: ocrType, message: err instanceof Error ? err.message : 'unknown' });
    await rescheduleJob(job.id, doc.id, job.attempts, 'internal_error');
  }
};

let timer: NodeJS.Timeout | null = null;
let ticking = false;
const inFlight = new Set<number>();

const tick = async (): Promise<void> => {
  if (ticking) return;
  ticking = true;
  try {
    const free = concurrency() - inFlight.size;
    if (free <= 0) return;
    const jobs = await pickJobs(free);
    for (const job of jobs) {
      inFlight.add(job.id);
      void processJob(job)
        .catch(err => console.error('[hr-ocr] unhandled job error', { jobId: job.id, message: err instanceof Error ? err.message : err }))
        .finally(() => inFlight.delete(job.id));
    }
  } catch (err) {
    console.error('[hr-ocr] tick error', err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
};

export const startHrOcrWorker = (): void => {
  if (timer || !isHrCryptoConfigured()) return;
  // Просроченные lease (упавший процесс) вернутся в очередь сами через pickJobs.
  void query(`SELECT count(*)::int AS n FROM hr_ocr_jobs WHERE state IN ('queued','leased')`)
    .then(rows => {
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) console.log(`[hr-ocr] в очереди задач: ${n}`);
    })
    .catch(() => undefined);
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref();
};

export const stopHrOcrWorker = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
