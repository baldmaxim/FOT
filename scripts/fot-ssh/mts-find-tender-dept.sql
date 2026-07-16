SELECT id, name, parent_id, is_active
FROM org_departments
WHERE lower(name) LIKE '%тендер%'
ORDER BY name;
