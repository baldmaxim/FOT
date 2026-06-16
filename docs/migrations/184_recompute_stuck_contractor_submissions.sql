-- 184: расклин зависших заявок подрядчиков без оставшихся pending-пропусков.
--
-- Контекст: агрегатный статус contractor_submissions пересчитывался только в
-- decideSubmission. enqueueRevoke отвязывал пропуск (submission_id=NULL) без
-- пересчёта, поэтому после отзыва последнего pending-пропуска заявка навсегда
-- оставалась в 'partially_applied' и висела в очереди «Заявки на согласование»
-- (напр. ВОЛЬТЕКС ИНЖИНИРИНГ: 9/9 одобрено, статус «частично»). Код-фикс
-- (computeSubmissionStatus + атомарный пересчёт в enqueueRevoke) предотвращает
-- повторение; эта миграция приводит уже зависшие строки к корректному статусу.
--
-- Правило совпадает с computeSubmissionStatus при pending === 0:
--   нет пропусков → rejected; нет rejected → approved; нет approved → rejected;
--   иначе mixed → partially_applied (статус не меняется).
-- reviewed_at сохраняем, если был; иначе ставим now(). reviewed_by не трогаем.
--
-- Идемпотентно: HAVING pending = 0 не трогает актуальные заявки; IS DISTINCT FROM
-- обновляет только реально изменившиеся строки. На момент подготовки — 1 строка
-- (ВОЛЬТЕКС, 6e06990a-da52-4a5f-bec1-556c7b43135d).

UPDATE public.contractor_submissions s
   SET status = agg.new_status,
       reviewed_at = COALESCE(s.reviewed_at, now())
  FROM (
    SELECT s2.id,
           CASE
             WHEN COUNT(p.*) = 0 THEN 'rejected'
             WHEN COUNT(p.*) FILTER (WHERE p.approval_status = 'rejected') = 0 THEN 'approved'
             WHEN COUNT(p.*) FILTER (WHERE p.approval_status = 'approved') = 0 THEN 'rejected'
             ELSE 'partially_applied'
           END AS new_status
      FROM public.contractor_submissions s2
      LEFT JOIN public.contractor_passes p ON p.submission_id = s2.id
     WHERE s2.status IN ('pending', 'partially_applied')
     GROUP BY s2.id
    HAVING COUNT(p.*) FILTER (WHERE p.approval_status = 'pending') = 0
  ) AS agg
 WHERE s.id = agg.id
   AND s.status IS DISTINCT FROM agg.new_status;
