CREATE TABLE IF NOT EXISTS studio.flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,code)
);

CREATE TABLE IF NOT EXISTS studio.flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES studio.flows(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','published','retired')),
  graph jsonb NOT NULL,
  change_reason text,
  created_by uuid REFERENCES iam.users(id),
  approved_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(flow_id,version_no)
);

CREATE INDEX IF NOT EXISTS idx_flow_versions_flow_status
  ON studio.flow_versions(flow_id,status,version_no DESC);

INSERT INTO studio.flows(id,organization_id,code,name,description)
VALUES (
  '37000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'messenger-sales-assistant',
  'Messenger Sales Assistant',
  'Runtime stage-to-prompt routing for customer replies, tool grounding, and human handover.'
)
ON CONFLICT(organization_id,code) DO UPDATE SET
  name=EXCLUDED.name,description=EXCLUDED.description,updated_at=now();

INSERT INTO studio.flow_versions(id,flow_id,version_no,status,graph,change_reason,created_by,approved_by)
VALUES (
  '37100000-0000-4000-8000-000000000001',
  '37000000-0000-4000-8000-000000000001',
  1,
  'published',
  '{
    "entryNodeId":"ice-break",
    "nodes":[
      {"id":"ice-break","label":"Ice Break","runtimeStage":"ICE_BREAK","promptCode":"ice-break","description":"Welcome the customer and discover the first learning signal","position":{"x":80,"y":100}},
      {"id":"qualification","label":"Qualification","runtimeStage":"QUALIFICATION","promptCode":"qualification","description":"Clarify background, goals, and learning preferences","position":{"x":340,"y":100}},
      {"id":"qna-course","label":"Course Q&A","runtimeStage":"QNA_COURSE","promptCode":"qna-course","description":"Answer with grounded course facts","position":{"x":600,"y":40}},
      {"id":"qna-price","label":"Pricing Q&A","runtimeStage":"QNA_PRICE","promptCode":"qna-price","description":"Quote only an effective structured pricing rule","position":{"x":600,"y":180}},
      {"id":"human","label":"Human Handover","runtimeStage":"HUMAN","promptCode":"handover-summary","description":"Stop automation and create an auditable advisor case","position":{"x":860,"y":100}}
    ],
    "edges":[
      {"id":"e1","source":"ice-break","target":"qualification","label":"needs discovered"},
      {"id":"e2","source":"qualification","target":"qna-course","label":"course identified"},
      {"id":"e3","source":"qualification","target":"qna-price","label":"price intent"},
      {"id":"e4","source":"qna-course","target":"qna-price","label":"asks price"},
      {"id":"e5","source":"qna-course","target":"human","label":"handover signal"},
      {"id":"e6","source":"qna-price","target":"human","label":"closing or payment"}
    ]
  }'::jsonb,
  'Initial runtime-connected flow replacing the implicit fixed stage map',
  '00000000-0000-4000-8000-000000000030',
  '00000000-0000-4000-8000-000000000030'
)
ON CONFLICT(flow_id,version_no) DO NOTHING;

UPDATE studio.releases
SET manifest=jsonb_set(manifest,'{flowVersionId}','"37100000-0000-4000-8000-000000000001"'::jsonb,true),
    checksum=encode(digest((jsonb_set(manifest,'{flowVersionId}','"37100000-0000-4000-8000-000000000001"'::jsonb,true))::text,'sha256'),'hex'),
    change_summary='Runtime-connected prompts, versioned conversation flow, structured output, grounded repair, and full prompt-stage evaluation gate'
WHERE status IN ('active','canary') AND environment='development';

