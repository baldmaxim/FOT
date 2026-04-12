-- Migration 019: rename legacy /tender page access to /employees

-- Merge all historical employees-page access under the new /employees key.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT
  role_code,
  '/employees',
  BOOL_OR(COALESCE(can_view, false) OR COALESCE(can_edit, false)),
  BOOL_OR(COALESCE(can_edit, false))
FROM role_page_access
WHERE page_path IN ('/my-employees', '/tender')
GROUP BY role_code
ON CONFLICT (role_code, page_path) DO UPDATE
SET
  can_view = role_page_access.can_view OR EXCLUDED.can_view,
  can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

-- Remove retired aliases after the new key is filled.
DELETE FROM role_page_access
WHERE page_path IN ('/my-employees', '/tender');
