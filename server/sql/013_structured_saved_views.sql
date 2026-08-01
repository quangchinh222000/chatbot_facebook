CREATE TABLE IF NOT EXISTS structured.views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  table_id uuid NOT NULL REFERENCES structured.tables(id) ON DELETE CASCADE,
  name text NOT NULL,
  view_type text NOT NULL DEFAULT 'grid' CHECK (view_type IN ('grid')),
  config jsonb NOT NULL DEFAULT '{"filters":[],"sorts":[],"hiddenColumns":[]}'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, name)
);

CREATE INDEX IF NOT EXISTS idx_structured_views_table_status
  ON structured.views(table_id, status, created_at);

INSERT INTO structured.views(organization_id,table_id,name,is_default,config)
SELECT organization_id,id,'All records',true,'{"filters":[],"sorts":[],"hiddenColumns":[]}'::jsonb
FROM structured.tables
ON CONFLICT(table_id,name) DO NOTHING;

UPDATE structured.tables
SET import_config = jsonb_set(import_config,'{primaryKey}','"code"'::jsonb,true)
WHERE code='course-catalog' AND import_config->>'primaryKey'='cousera';

