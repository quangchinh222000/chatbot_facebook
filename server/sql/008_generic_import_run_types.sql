ALTER TABLE platform.import_runs
  DROP CONSTRAINT IF EXISTS import_runs_import_type_check;

ALTER TABLE platform.import_runs
  ADD CONSTRAINT import_runs_import_type_check
  CHECK (import_type IN ('courses','pricing') OR import_type LIKE 'table:%');
