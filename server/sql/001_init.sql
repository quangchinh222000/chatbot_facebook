CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS iam;
CREATE SCHEMA IF NOT EXISTS channel;
CREATE SCHEMA IF NOT EXISTS conversation;
CREATE SCHEMA IF NOT EXISTS case_mgmt;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS pricing;
CREATE SCHEMA IF NOT EXISTS knowledge;
CREATE SCHEMA IF NOT EXISTS studio;
CREATE SCHEMA IF NOT EXISTS platform;

CREATE OR REPLACE FUNCTION platform.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS iam.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Bangkok',
  locale text NOT NULL DEFAULT 'vi-VN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS iam.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  email citext NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
  mfa_enabled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE IF NOT EXISTS iam.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS iam.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS iam.user_roles (
  user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES iam.roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS iam.team_members (
  team_id uuid NOT NULL REFERENCES iam.teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  provider text NOT NULL DEFAULT 'facebook_messenger',
  name text NOT NULL,
  external_page_id text NOT NULL,
  status text NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','degraded','disconnected','expired','unknown')),
  secret_ref text,
  verify_token_hash text,
  graph_version text NOT NULL DEFAULT 'v22.0',
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, external_page_id)
);

CREATE TABLE IF NOT EXISTS channel.blocked_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  channel_account_id uuid REFERENCES channel.accounts(id),
  external_account_id text NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz,
  created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, channel_account_id, external_account_id)
);

CREATE TABLE IF NOT EXISTS channel.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  channel_account_id uuid NOT NULL REFERENCES channel.accounts(id),
  provider_event_id text,
  payload_hash text NOT NULL,
  raw_payload jsonb NOT NULL,
  signature_valid boolean NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','ignored','failed')),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (channel_account_id, payload_hash)
);

CREATE TABLE IF NOT EXISTS conversation.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  display_name text NOT NULL,
  phone text,
  email citext,
  segment text,
  tags text[] NOT NULL DEFAULT '{}',
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation.contact_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  contact_id uuid NOT NULL REFERENCES conversation.contacts(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel.accounts(id),
  external_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, external_user_id)
);

CREATE TABLE IF NOT EXISTS conversation.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  channel_account_id uuid NOT NULL REFERENCES channel.accounts(id),
  contact_id uuid NOT NULL REFERENCES conversation.contacts(id),
  external_thread_id text NOT NULL,
  bot_mode text NOT NULL DEFAULT 'bot' CHECK (bot_mode IN ('bot','human','paused')),
  current_state text NOT NULL DEFAULT 'NEW' CHECK (current_state IN ('NEW','ICE_BREAK','QUALIFICATION','QNA_COURSE','QNA_PRICE','CLOSING','HUMAN','RESOLVED')),
  assigned_team_id uuid REFERENCES iam.teams(id),
  assigned_user_id uuid REFERENCES iam.users(id),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  unread_count integer NOT NULL DEFAULT 0,
  selected_course_id uuid,
  last_message_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, channel_account_id, external_thread_id)
);

CREATE TABLE IF NOT EXISTS conversation.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  conversation_id uuid NOT NULL REFERENCES conversation.conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound','internal')),
  sender_type text NOT NULL CHECK (sender_type IN ('customer','bot','agent','system')),
  external_message_id text,
  raw_text text,
  normalized_text text,
  message_type text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','image','file','link','system')),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','pending','processing','generated','queued','sent','delivered','read','failed','cancelled')),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  batch_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  UNIQUE (organization_id, conversation_id, external_message_id)
);

CREATE TABLE IF NOT EXISTS conversation.attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES conversation.messages(id) ON DELETE CASCADE,
  object_key text,
  source_url text,
  mime_type text,
  size_bytes bigint,
  checksum text,
  extracted_text text,
  extraction_confidence numeric(5,4),
  scan_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation.message_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  conversation_id uuid NOT NULL REFERENCES conversation.conversations(id),
  inbound_message_ids uuid[] NOT NULL,
  debounce_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS conversation.state_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  conversation_id uuid NOT NULL REFERENCES conversation.conversations(id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  trigger text NOT NULL,
  reason text,
  rule_version_id uuid,
  ai_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_mgmt.cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  conversation_id uuid NOT NULL REFERENCES conversation.conversations(id),
  reason_code text NOT NULL,
  summary text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','in_progress','waiting_customer','escalated','resolved','reopened')),
  assigned_team_id uuid REFERENCES iam.teams(id),
  assigned_user_id uuid REFERENCES iam.users(id),
  sla_due_at timestamptz,
  breached_at timestamptz,
  resolved_at timestamptz,
  resolution_code text,
  resolution_summary text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_open_case_per_conversation
ON case_mgmt.cases(conversation_id)
WHERE status NOT IN ('resolved');

CREATE TABLE IF NOT EXISTS case_mgmt.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES case_mgmt.cases(id) ON DELETE CASCADE,
  author_id uuid REFERENCES iam.users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_mgmt.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES case_mgmt.cases(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_id uuid REFERENCES iam.users(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  category text,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','inactive','archived')),
  version integer NOT NULL DEFAULT 1,
  effective_from timestamptz,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

ALTER TABLE conversation.conversations
  ADD CONSTRAINT fk_conversation_selected_course
  FOREIGN KEY (selected_course_id) REFERENCES catalog.courses(id);

CREATE TABLE IF NOT EXISTS catalog.course_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES catalog.courses(id) ON DELETE CASCADE,
  alias citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, alias)
);

CREATE TABLE IF NOT EXISTS catalog.offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  course_id uuid NOT NULL REFERENCES catalog.courses(id),
  delivery_mode text NOT NULL CHECK (delivery_mode IN ('online','offline','hybrid')),
  cohort_name text,
  schedule_text text,
  start_at timestamptz,
  end_at timestamptz,
  capacity integer,
  certificate text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing.rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  course_id uuid NOT NULL REFERENCES catalog.courses(id),
  offering_id uuid REFERENCES catalog.offerings(id),
  audience_segment text NOT NULL,
  delivery_mode text,
  currency char(3) NOT NULL DEFAULT 'VND',
  standard_price numeric(16,2) NOT NULL CHECK (standard_price >= 0),
  early_bird_price numeric(16,2),
  promotion_name text,
  priority integer NOT NULL DEFAULT 100,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','review','approved','published','archived')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE IF NOT EXISTS knowledge.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  title text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('text','url','pdf','docx','pptx','image','html','markdown')),
  source_url text,
  object_key text,
  language text NOT NULL DEFAULT 'vi',
  owner_id uuid REFERENCES iam.users(id),
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge.document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES knowledge.documents(id) ON DELETE CASCADE,
  revision_no integer NOT NULL,
  parent_revision_id uuid REFERENCES knowledge.document_revisions(id),
  original_content text,
  clean_content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','changes_requested','approved','indexing','ready','published','archived','failed')),
  effective_from timestamptz,
  effective_to timestamptz,
  created_by uuid REFERENCES iam.users(id),
  approved_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision_no)
);

CREATE TABLE IF NOT EXISTS knowledge.chunk_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  target_chars integer NOT NULL DEFAULT 1200,
  max_chars integer NOT NULL DEFAULT 1800,
  overlap_chars integer NOT NULL DEFAULT 150,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS knowledge.chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  document_revision_id uuid NOT NULL REFERENCES knowledge.document_revisions(id) ON DELETE CASCADE,
  chunk_profile_id uuid REFERENCES knowledge.chunk_profiles(id),
  chunk_index integer NOT NULL,
  heading_path text,
  content text NOT NULL,
  embedding vector(64),
  embedding_model text NOT NULL DEFAULT 'local-hash-v1',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_revision_id, chunk_index, embedding_model)
);

CREATE TABLE IF NOT EXISTS knowledge.collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code, version)
);

CREATE TABLE IF NOT EXISTS knowledge.collection_members (
  collection_id uuid NOT NULL REFERENCES knowledge.collections(id) ON DELETE CASCADE,
  document_revision_id uuid NOT NULL REFERENCES knowledge.document_revisions(id),
  PRIMARY KEY (collection_id, document_revision_id)
);

CREATE TABLE IF NOT EXISTS studio.datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  dataset_type text NOT NULL CHECK (dataset_type IN ('typed_domain','managed','staging')),
  description text,
  owner_id uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS studio.dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES studio.datasets(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','published','archived')),
  schema_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES iam.users(id),
  approved_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (dataset_id, version_no)
);

CREATE TABLE IF NOT EXISTS studio.dataset_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id uuid NOT NULL REFERENCES studio.dataset_versions(id) ON DELETE CASCADE,
  record_key text NOT NULL,
  data jsonb NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_version_id, record_key)
);

CREATE TABLE IF NOT EXISTS studio.prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS studio.prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id uuid NOT NULL REFERENCES studio.prompts(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','published','retired')),
  system_template text NOT NULL,
  user_template text,
  variable_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_tools text[] NOT NULL DEFAULT '{}',
  model_profile_code text,
  change_reason text,
  created_by uuid REFERENCES iam.users(id),
  approved_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version_no)
);

CREATE TABLE IF NOT EXISTS studio.rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS studio.rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES studio.rule_sets(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES iam.users(id),
  approved_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_set_id, version_no)
);

CREATE TABLE IF NOT EXISTS studio.tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS studio.tool_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id uuid NOT NULL REFERENCES studio.tools(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  input_schema jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  binding jsonb NOT NULL,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'approved',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tool_id, version_no)
);

CREATE TABLE IF NOT EXISTS studio.model_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  fallback_chain jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS studio.evaluation_suites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  gate_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS studio.evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id uuid NOT NULL REFERENCES studio.evaluation_suites(id) ON DELETE CASCADE,
  code text NOT NULL,
  input jsonb NOT NULL,
  expected jsonb NOT NULL,
  severity text NOT NULL DEFAULT 'normal',
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (suite_id, code)
);

CREATE TABLE IF NOT EXISTS studio.evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  suite_id uuid NOT NULL REFERENCES studio.evaluation_suites(id),
  candidate_release_id uuid,
  baseline_release_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','passed','failed','cancelled')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS studio.evaluation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES studio.evaluation_runs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES studio.evaluation_cases(id),
  status text NOT NULL,
  actual jsonb NOT NULL,
  violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, case_id)
);

CREATE TABLE IF NOT EXISTS studio.releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  release_code text NOT NULL,
  environment text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validating','awaiting_approval','candidate','canary','active','rolled_back','archived')),
  manifest jsonb NOT NULL,
  checksum text NOT NULL,
  change_summary text,
  created_by uuid REFERENCES iam.users(id),
  approved_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (organization_id, environment, release_code),
  UNIQUE (organization_id, environment, checksum)
);

ALTER TABLE studio.evaluation_runs
  ADD CONSTRAINT fk_eval_candidate_release FOREIGN KEY (candidate_release_id) REFERENCES studio.releases(id);
ALTER TABLE studio.evaluation_runs
  ADD CONSTRAINT fk_eval_baseline_release FOREIGN KEY (baseline_release_id) REFERENCES studio.releases(id);

CREATE TABLE IF NOT EXISTS studio.release_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES studio.releases(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES iam.users(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected','changes_requested')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS studio.rollout_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES studio.releases(id) ON DELETE CASCADE,
  environment text NOT NULL,
  channel_account_id uuid REFERENCES channel.accounts(id),
  percentage integer NOT NULL CHECK (percentage BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'active',
  abort_thresholds jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  priority integer NOT NULL DEFAULT 100,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_at timestamptz,
  locked_by text,
  idempotency_key text NOT NULL,
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  current_step text,
  result jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS platform.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','dead_letter')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  idempotency_key text NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS platform.dead_letter_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  payload jsonb NOT NULL,
  error text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reprocessed_at timestamptz
);

CREATE TABLE IF NOT EXISTS platform.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  actor_id uuid REFERENCES iam.users(id),
  actor_type text NOT NULL DEFAULT 'user',
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  source_ip inet,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  user_id uuid REFERENCES iam.users(id),
  team_id uuid REFERENCES iam.teams(id),
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  entity_type text,
  entity_id text,
  read_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  conversation_id uuid REFERENCES conversation.conversations(id),
  batch_id uuid REFERENCES conversation.message_batches(id),
  release_id uuid REFERENCES studio.releases(id),
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input jsonb NOT NULL,
  output jsonb,
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_version_ids uuid[] NOT NULL DEFAULT '{}',
  rule_version_id uuid,
  token_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms integer,
  cost_usd numeric(12,6),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('queued','running','completed','failed','fallback')),
  error text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS platform.ai_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_run_id uuid NOT NULL REFERENCES platform.ai_runs(id) ON DELETE CASCADE,
  tool_code text NOT NULL,
  tool_version_id uuid,
  input jsonb NOT NULL,
  output jsonb,
  status text NOT NULL,
  latency_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.retrieval_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_run_id uuid NOT NULL REFERENCES platform.ai_runs(id) ON DELETE CASCADE,
  query text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_chunk_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.integration_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  provider text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL,
  request_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.settings (
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES iam.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON conversation.messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_status ON conversation.messages(status) WHERE status IN ('pending','queued','failed');
CREATE INDEX IF NOT EXISTS idx_conversations_inbox ON conversation.conversations(organization_id, bot_mode, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm ON conversation.contacts USING gin(display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_courses_name_trgm ON catalog.courses USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_alias_trgm ON catalog.course_aliases USING gin(alias gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_knowledge_fts ON knowledge.chunks USING gin(to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS idx_knowledge_vector ON knowledge.chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON platform.jobs(status, available_at, priority, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_outbox_claim ON platform.outbox_events(status, available_at, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cases_queue ON case_mgmt.cases(organization_id, status, priority, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON platform.audit_logs(organization_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_trace ON platform.ai_runs(organization_id, created_at DESC, status);

DROP TRIGGER IF EXISTS trg_users_updated ON iam.users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON iam.users FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
DROP TRIGGER IF EXISTS trg_conversations_updated ON conversation.conversations;
CREATE TRIGGER trg_conversations_updated BEFORE UPDATE ON conversation.conversations FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
DROP TRIGGER IF EXISTS trg_cases_updated ON case_mgmt.cases;
CREATE TRIGGER trg_cases_updated BEFORE UPDATE ON case_mgmt.cases FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
DROP TRIGGER IF EXISTS trg_documents_updated ON knowledge.documents;
CREATE TRIGGER trg_documents_updated BEFORE UPDATE ON knowledge.documents FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
DROP TRIGGER IF EXISTS trg_jobs_updated ON platform.jobs;
CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON platform.jobs FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
