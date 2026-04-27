-- Migration 053: новые категории документов для вложений к заявлениям и корректировкам табеля.

BEGIN;

INSERT INTO document_categories (code, label, sort_order)
VALUES
  ('leave_request_attachment', 'Вложение к заявлению', 25),
  ('attendance_correction', 'Подтверждение корректировки табеля', 35)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label,
      sort_order = EXCLUDED.sort_order;

COMMIT;
