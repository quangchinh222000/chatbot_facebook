-- Đợt 1: ngôn ngữ runtime, cổng chặn outbound theo environment, và quan sát hệ thống.
-- Xem docs/AUDIT-2026-08.md mục 1.2, 1.3 và 4 (Đợt 1).

------------------------------------------------------------------------------
-- 1. Cấu hình runtime cấp tổ chức (ngôn ngữ mặc định, debounce mặc định...)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.runtime_settings (
  organization_id uuid PRIMARY KEY REFERENCES iam.organizations(id),
  default_language text NOT NULL DEFAULT 'vi',
  supported_languages text[] NOT NULL DEFAULT ARRAY['vi','en'],
  language_mode text NOT NULL DEFAULT 'follow_customer'
    CHECK (language_mode IN ('follow_customer','force_default')),
  debounce_seconds integer NOT NULL DEFAULT 8 CHECK (debounce_seconds BETWEEN 0 AND 300),
  updated_by uuid REFERENCES iam.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform.runtime_settings(organization_id, default_language, supported_languages, language_mode, debounce_seconds)
SELECT id, 'vi', ARRAY['vi','en'], 'follow_customer', 8 FROM iam.organizations
ON CONFLICT (organization_id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_runtime_settings_updated ON platform.runtime_settings;
CREATE TRIGGER trg_runtime_settings_updated
  BEFORE UPDATE ON platform.runtime_settings
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

------------------------------------------------------------------------------
-- 2. Ngôn ngữ ở cấp hội thoại và tin nhắn
------------------------------------------------------------------------------
ALTER TABLE conversation.conversations
  ADD COLUMN IF NOT EXISTS primary_language text;

ALTER TABLE conversation.messages
  ADD COLUMN IF NOT EXISTS detected_language text;

COMMENT ON COLUMN conversation.conversations.primary_language IS
  'Ngôn ngữ chính của hội thoại, chốt sau vài lượt đầu. NULL = chưa xác định.';
COMMENT ON COLUMN conversation.messages.detected_language IS
  'Ngôn ngữ phát hiện được của riêng tin nhắn này (vi, vi-latin, en, mixed, unknown).';

------------------------------------------------------------------------------
-- 3. Heartbeat của worker — API/UI phải trả lời được "worker còn sống không"
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.worker_heartbeats (
  worker_id text PRIMARY KEY,
  hostname text,
  pid integer,
  app_env text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('starting','running','draining','stopped')),
  jobs_processed bigint NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_last_seen
  ON platform.worker_heartbeats(last_seen_at DESC);

------------------------------------------------------------------------------
-- 4. Trace: phân biệt môi trường / chế độ chạy / ngôn ngữ của mỗi lượt AI
------------------------------------------------------------------------------
ALTER TABLE platform.ai_runs
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'live';
ALTER TABLE platform.ai_runs
  ADD COLUMN IF NOT EXISTS run_mode text NOT NULL DEFAULT 'live'
  CHECK (run_mode IN ('live','test','eval'));
ALTER TABLE platform.ai_runs
  ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE platform.ai_runs
  ADD COLUMN IF NOT EXISTS runtime_config jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ai_runs_mode_recent
  ON platform.ai_runs(organization_id, run_mode, created_at DESC);

COMMENT ON COLUMN platform.ai_runs.runtime_config IS
  'Ảnh chụp cấu hình đã resolve từ release cho lượt chạy này (prompt, flow, tool, ngôn ngữ, model).';

------------------------------------------------------------------------------
-- 5. Chặn revision draft rò vào runtime (5.7)
--    searchKnowledge từ nay chỉ đọc status = 'published'. Nâng các revision
--    đang 'ready' lên 'published' để dữ liệu hiện có không biến mất khỏi RAG.
------------------------------------------------------------------------------
UPDATE knowledge.document_revisions
SET status = 'published', updated_at = now()
WHERE status = 'ready';

------------------------------------------------------------------------------
-- 6. Chặn outbound theo environment (5.16 / 1.2)
--    Ghi lại kết quả gửi để phân biệt tin thật với tin mô phỏng.
------------------------------------------------------------------------------
ALTER TABLE platform.outbox_events
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'live';
ALTER TABLE platform.outbox_events
  ADD COLUMN IF NOT EXISTS delivery_mode text
  CHECK (delivery_mode IN ('real','simulated','blocked'));

COMMENT ON COLUMN platform.outbox_events.delivery_mode IS
  'real = đã gọi Meta thật. simulated = môi trường test/demo, không gọi ra ngoài. blocked = bị chặn vì thiếu điều kiện.';

-- Mọi outbox đang chờ thuộc hội thoại test phải được đánh dấu lại cho đúng.
UPDATE platform.outbox_events o
SET environment = c.environment
FROM conversation.messages m
JOIN conversation.conversations c ON c.id = m.conversation_id
WHERE o.aggregate_type = 'message'
  AND o.aggregate_id = m.id
  AND o.environment <> c.environment;

------------------------------------------------------------------------------
-- 7. Debounce theo channel (5.3) — channel.accounts.policy đã là jsonb sẵn có.
------------------------------------------------------------------------------
UPDATE channel.accounts
SET policy = policy || jsonb_build_object(
      'debounceSeconds', COALESCE((policy->>'debounceSeconds')::int, 8),
      'language', COALESCE(policy->'language', jsonb_build_object('mode','inherit'))
    )
WHERE NOT (policy ? 'debounceSeconds');
