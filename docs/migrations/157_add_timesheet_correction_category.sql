INSERT INTO document_categories (code, label, sort_order)
VALUES ('timesheet_correction', 'Корректировка табеля', 50)
ON CONFLICT (code) DO NOTHING;
