-- Debug query for the remaining preflight blocker:
-- employee_assignments overlap

SELECT
  a.employee_id,
  a.id AS left_id,
  a.effective_from AS left_from,
  a.effective_to AS left_to,
  b.id AS right_id,
  b.effective_from AS right_from,
  b.effective_to AS right_to,
  to_jsonb(a) AS left_row,
  to_jsonb(b) AS right_row
FROM employee_assignments a
JOIN employee_assignments b
  ON a.employee_id = b.employee_id
 AND a.id < b.id
 AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
     && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]')
ORDER BY a.employee_id, a.effective_from, b.effective_from;

-- Optional: fetch full rows for manual inspection after you know the ids.
-- Replace 123 and 456 with the ids from the result above.
--
-- SELECT *
-- FROM employee_assignments
-- WHERE id IN (123, 456)
-- ORDER BY effective_from, id;
