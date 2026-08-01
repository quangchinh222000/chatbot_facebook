CREATE SCHEMA IF NOT EXISTS structured;

CREATE TABLE IF NOT EXISTS structured.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  adapter text NOT NULL DEFAULT 'generic_json',
  icon text NOT NULL DEFAULT 'table',
  schema_definition jsonb NOT NULL DEFAULT '{"columns":[]}'::jsonb,
  import_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS structured.records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  table_id uuid NOT NULL REFERENCES structured.tables(id) ON DELETE CASCADE,
  record_key text NOT NULL,
  data jsonb NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version integer NOT NULL DEFAULT 1,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, record_key)
);

CREATE INDEX IF NOT EXISTS idx_structured_tables_org_status
  ON structured.tables(organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_structured_records_table_status
  ON structured.records(table_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_structured_records_data_gin
  ON structured.records USING gin(data);

ALTER TABLE platform.import_runs
  ADD COLUMN IF NOT EXISTS table_id uuid REFERENCES structured.tables(id);

INSERT INTO structured.tables(
  id, organization_id, code, name, description, adapter, icon, schema_definition, import_config, status
) VALUES
  (
    '61000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'course-catalog',
    'Course Catalog',
    'Canonical course, curriculum, schedule, audience, and delivery facts used by matching and response generation.',
    'course_catalog',
    'graduation-cap',
    '{"primaryKey":"code","columns":[{"key":"code","label":"Code","type":"text","required":true},{"key":"name","label":"Course","type":"text","required":true},{"key":"category","label":"Category","type":"text"},{"key":"course_type","label":"Course type","type":"text"},{"key":"learning_modes","label":"Delivery","type":"list"},{"key":"next_start_date","label":"Next start","type":"date"},{"key":"status","label":"Status","type":"status"}]}'::jsonb,
    '{"format":"csv","template":"courses","primaryKey":"cousera"}'::jsonb,
    'active'
  ),
  (
    '61000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'pricing-rules',
    'Pricing Rules',
    'Effective tuition rules by course, audience, delivery mode, and promotion.',
    'pricing_rules',
    'badge-dollar-sign',
    '{"primaryKey":"id","columns":[{"key":"course_name","label":"Course","type":"text","required":true},{"key":"audience_segment","label":"Audience","type":"text","required":true},{"key":"delivery_mode","label":"Mode","type":"text"},{"key":"standard_price","label":"Standard","type":"currency","required":true},{"key":"early_bird_price","label":"Early Bird","type":"currency"},{"key":"group_price","label":"Group","type":"currency"},{"key":"alumni_price","label":"Alumni","type":"currency"},{"key":"status","label":"Status","type":"status"}]}'::jsonb,
    '{"format":"csv","template":"pricing","primaryKey":"source_key"}'::jsonb,
    'active'
  )
ON CONFLICT (organization_id, code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  adapter = EXCLUDED.adapter,
  icon = EXCLUDED.icon,
  schema_definition = EXCLUDED.schema_definition,
  import_config = EXCLUDED.import_config,
  updated_at = now();

UPDATE platform.import_runs
SET table_id = CASE import_type
  WHEN 'courses' THEN '61000000-0000-4000-8000-000000000001'::uuid
  WHEN 'pricing' THEN '61000000-0000-4000-8000-000000000002'::uuid
  ELSE table_id
END
WHERE table_id IS NULL;
