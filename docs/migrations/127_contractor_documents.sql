-- 127_contractor_documents.sql
-- Документы подрядчика, прикладываемые к организации (видны во всех её заявках).
-- Подрядчик грузит/удаляет; админ просматривает в модалке заявки на согласование.

CREATE TABLE IF NOT EXISTS contractor_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_department_id  uuid NOT NULL REFERENCES org_departments(id) ON DELETE CASCADE,
  file_name          text NOT NULL,
  file_size          integer NOT NULL,
  mime_type          text NOT NULL,
  r2_key             text NOT NULL UNIQUE,
  uploaded_by        uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contractor_documents_org_idx
  ON contractor_documents (org_department_id, created_at DESC);

COMMENT ON TABLE contractor_documents IS
  'Документы подрядчика, привязанные к подрядной организации (org_departments). Видны админу в модалке заявки на согласование пропусков.';
