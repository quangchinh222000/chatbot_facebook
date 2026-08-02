-- Bước 1 + 5 + 6 của lộ trình trong ARCHITECTURE.md Phần II.
--
-- Nút thắt lớn nhất: sales-agent chỉ có 4 quyền và không có knowledge.write /
-- studio.write, nên toàn bộ tiền đề "đội sale tự thêm tài liệu, prompt, agent"
-- đang bị chặn ngay ở tầng quyền. Không sửa thì ba module làm xong vẫn chỉ một
-- người dùng được.

------------------------------------------------------------------------------
-- 1. VAI TRÒ CHO SELF-SERVICE
--    Nguyên tắc: tri thức tự do hơn, hành vi chặt hơn.
--    Tài liệu chỉ cần publish là tới bot. Prompt/agent/flow phải qua release.
------------------------------------------------------------------------------

-- Sale nội dung: tự thêm và sửa tài liệu, đề xuất prompt, KHÔNG được publish
-- tài liệu và KHÔNG chạm được vào release.
INSERT INTO iam.roles (id, organization_id, code, name, description, permissions)
SELECT '00000000-0000-4000-8000-000000000201', id, 'sales-contributor', 'Sale — Đóng góp nội dung',
       'Tự thêm/sửa tài liệu và đề xuất prompt. Không publish, không release.',
       '["dashboard.view","conversation.read.team","conversation.reply.assigned",
         "conversation.takeover","knowledge.read","knowledge.write",
         "studio.read","studio.write","ai_trace.read","feedback.write"]'::jsonb
FROM iam.organizations
ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions, description = EXCLUDED.description;

-- Trưởng nhóm sale: duyệt và publish TÀI LIỆU (tri thức), chạy đánh giá,
-- duyệt đề xuất prompt do AI sinh. Vẫn KHÔNG được kích hoạt release.
INSERT INTO iam.roles (id, organization_id, code, name, description, permissions)
SELECT '00000000-0000-4000-8000-000000000202', id, 'knowledge-lead', 'Trưởng nhóm — Tri thức',
       'Duyệt và publish tài liệu, duyệt đề xuất prompt của AI, chạy đánh giá. Không kích hoạt release.',
       '["dashboard.view","conversation.read.team","conversation.reply.assigned",
         "conversation.takeover","conversation.release_bot","case.assign.team",
         "knowledge.read","knowledge.write","knowledge.approve","knowledge.publish",
         "studio.read","studio.write","studio.approve","studio.evaluate",
         "ai_trace.read","feedback.write","proposal.review"]'::jsonb
FROM iam.organizations
ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions, description = EXCLUDED.description;

-- Vai trò sales-agent cũ chỉ có 4 quyền — bổ sung quyền đọc tri thức và gửi
-- phản hồi "AI trả lời sai", vì đó là nguồn tín hiệu cho Module 2.
UPDATE iam.roles
SET permissions = permissions || '["knowledge.read","ai_trace.read","feedback.write"]'::jsonb
WHERE code = 'sales-agent'
  AND NOT (permissions @> '["feedback.write"]'::jsonb);

-- Quyền mới cho platform-admin.
UPDATE iam.roles
SET permissions = permissions || '["feedback.write","proposal.review","schedule.manage"]'::jsonb
WHERE code = 'platform-admin'
  AND NOT (permissions @> '["proposal.review"]'::jsonb);

------------------------------------------------------------------------------
-- 2. PHẢN HỒI "AI TRẢ LỜI SAI" — nhiên liệu cho vòng tự cải tiến
--    Không có tín hiệu này thì Module 2 không có gì để học.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.response_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  ai_run_id uuid REFERENCES platform.ai_runs(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversation.conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES conversation.messages(id) ON DELETE SET NULL,
  -- Ai chấm: người dùng nội bộ, hay hệ thống tự phát hiện.
  source text NOT NULL DEFAULT 'human' CHECK (source IN ('human','system')),
  rating text NOT NULL CHECK (rating IN ('good','wrong','incomplete','wrong_tone','unsafe')),
  reason_code text,
  comment text,
  -- Câu trả lời đúng theo người chấm. Đây là tín hiệu mạnh nhất để cải tiến
  -- prompt: nhân viên đã takeover và viết lại thì bản viết lại là nhãn vàng.
  corrected_text text,
  reported_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_response_feedback_recent
  ON platform.response_feedback(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_response_feedback_rating
  ON platform.response_feedback(organization_id, rating, created_at DESC);

COMMENT ON TABLE platform.response_feedback IS
  'Tín hiệu chất lượng câu trả lời. Đầu vào cho job hàng tuần đề xuất nâng cấp prompt.';

------------------------------------------------------------------------------
-- 3. LỊCH CHẠY ĐỊNH KỲ — platform.jobs chỉ chạy một lần, không có recurrence
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Biểu thức cron 5 trường, giờ theo timezone bên dưới.
  cron_expression text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_status text,
  next_run_at timestamptz,
  created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_schedules_due
  ON platform.schedules(enabled, next_run_at) WHERE enabled;

DROP TRIGGER IF EXISTS trg_schedules_updated ON platform.schedules;
CREATE TRIGGER trg_schedules_updated BEFORE UPDATE ON platform.schedules
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

-- Lịch mặc định: 8h sáng thứ Hai hàng tuần, rà hội thoại 7 ngày trước.
-- Mặc định TẮT — bật khi agent analyst/improver đã sẵn sàng.
INSERT INTO platform.schedules (organization_id, code, name, job_type, payload, cron_expression, enabled)
SELECT id, 'weekly-prompt-review', 'Rà soát prompt hàng tuần',
       'REVIEW_CONVERSATIONS',
       '{"lookbackDays":7,"minSignals":3}'::jsonb,
       '0 8 * * 1', false
FROM iam.organizations
ON CONFLICT (organization_id, code) DO NOTHING;

------------------------------------------------------------------------------
-- 4. ĐỀ XUẤT NÂNG CẤP PROMPT DO AI SINH
--    AI chỉ tạo được đề xuất. Không bao giờ tự publish.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS studio.improvement_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  -- Đề xuất cho agent nào (agent nay là nơi chứa prompt — xem migration 016).
  agent_id uuid NOT NULL REFERENCES studio.agents(id) ON DELETE CASCADE,
  base_version_id uuid REFERENCES studio.agent_versions(id),
  -- Version nháp mà AI soạn ra. NULL khi đề xuất bị loại trước khi tạo version.
  proposed_version_id uuid REFERENCES studio.agent_versions(id),
  title text NOT NULL,
  rationale text NOT NULL,
  -- Bằng chứng bắt buộc: đề xuất không dẫn được trace hỏng thì không hiển thị.
  evidence_run_ids uuid[] NOT NULL DEFAULT '{}',
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  signal_count integer NOT NULL DEFAULT 0,
  -- Kết quả evaluation. Trượt thì tự loại, không lên bàn duyệt.
  evaluation_run_id uuid REFERENCES studio.evaluation_runs(id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','evaluating','awaiting_review','approved','rejected','auto_discarded')),
  review_comment text,
  reviewed_by uuid REFERENCES iam.users(id),
  reviewed_at timestamptz,
  generated_by_run_id uuid REFERENCES platform.ai_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Không có bằng chứng thì không được lên bàn duyệt.
  CONSTRAINT proposal_needs_evidence CHECK (
    status <> 'awaiting_review' OR array_length(evidence_run_ids, 1) >= 1
  )
);

CREATE INDEX IF NOT EXISTS idx_proposals_review_queue
  ON studio.improvement_proposals(organization_id, status, created_at DESC);

COMMENT ON TABLE studio.improvement_proposals IS
  'Đề xuất nâng cấp prompt do AI soạn. AI chỉ tạo draft; người duyệt mới publish được.';

------------------------------------------------------------------------------
-- 5. Agent kind mới cho Module 2
------------------------------------------------------------------------------
ALTER TABLE studio.agents DROP CONSTRAINT IF EXISTS agents_kind_check;
ALTER TABLE studio.agents ADD CONSTRAINT agents_kind_check
  CHECK (kind IN ('conversational','classifier','rewriter','extractor','analyst','improver'));

------------------------------------------------------------------------------
-- 6. Collection: tách phạm vi khỏi nội dung (sửa hướng ở mục 11)
--    Release pin PHẠM VI collection, không đóng băng nội dung — nhờ vậy sale
--    thêm tài liệu là bot dùng được ngay sau publish, không phải đợi release.
------------------------------------------------------------------------------
ALTER TABLE knowledge.collections
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE knowledge.collections
  ADD COLUMN IF NOT EXISTS auto_publish boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN knowledge.collections.pinned IS
  'true = release đóng băng version của collection này (dùng cho nội dung pháp lý). '
  'false (mặc định) = release chỉ cấp quyền đọc collection, nội dung mới publish là tới bot ngay.';
COMMENT ON COLUMN knowledge.collections.auto_publish IS
  'true = tài liệu do người có quyền knowledge.publish lưu sẽ publish luôn, bỏ bước duyệt riêng.';
