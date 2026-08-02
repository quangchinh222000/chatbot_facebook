-- Bước 1–2 của lộ trình trong ARCHITECTURE.md:
-- Agent và Tool trở thành tài nguyên độc lập có version, thay cho prompt gắn
-- cứng vào 5 stage và 3 tool hard-code trong requiredToolForStage().
--
-- Migration này KHÔNG đổi hành vi runtime. Nó chỉ thêm bảng và nạp dữ liệu
-- tương đương từ prompt hiện có, để engine đồ thị ở bước sau có nền mà dựng.

------------------------------------------------------------------------------
-- 1. AGENT
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS studio.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  -- conversational: trả lời khách. classifier: trả JSON, không gửi khách.
  -- rewriter: viết lại đầu ra agent khác. extractor: bóc nội dung ảnh/tài liệu.
  kind text NOT NULL DEFAULT 'conversational'
    CHECK (kind IN ('conversational','classifier','rewriter','extractor')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS studio.agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES studio.agents(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  system_prompt text NOT NULL,
  user_template text,
  model_profile_code text,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Agent CHỈ được gọi tool có code nằm trong mảng này. Runtime chặn phần còn lại.
  tool_codes text[] NOT NULL DEFAULT '{}',
  -- Collection tri thức agent được đọc. Thêm tài liệu vào collection là agent
  -- dùng được ngay sau publish, không phải sửa agent.
  knowledge_codes text[] NOT NULL DEFAULT '{}',
  -- {"kind":"conversation_window","maxTurns":12,"scope":"conversation"}
  memory jsonb NOT NULL DEFAULT '{"kind":"none"}'::jsonb,
  -- Bắt buộc với kind='classifier'
  output_schema jsonb,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_review','published','archived')),
  change_summary text,
  created_by uuid REFERENCES iam.users(id),
  published_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version_no)
);

-- Classifier phải có output_schema, nếu không runtime không parse nổi kết quả.
-- Ràng buộc này cần đọc studio.agents nên phải là trigger, không phải CHECK.
CREATE OR REPLACE FUNCTION studio.assert_classifier_has_schema() RETURNS trigger AS $$
BEGIN
  IF NEW.output_schema IS NULL
     AND (SELECT kind FROM studio.agents WHERE id = NEW.agent_id) = 'classifier' THEN
    RAISE EXCEPTION 'Agent kind=classifier bắt buộc phải có output_schema';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_version_classifier_schema ON studio.agent_versions;
CREATE TRIGGER trg_agent_version_classifier_schema
  BEFORE INSERT OR UPDATE ON studio.agent_versions
  FOR EACH ROW EXECUTE FUNCTION studio.assert_classifier_has_schema();

CREATE INDEX IF NOT EXISTS idx_agent_versions_published
  ON studio.agent_versions(agent_id, status, version_no DESC);

DROP TRIGGER IF EXISTS trg_agents_updated ON studio.agents;
CREATE TRIGGER trg_agents_updated BEFORE UPDATE ON studio.agents
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

------------------------------------------------------------------------------
-- 2. TOOL REGISTRY — đã tồn tại từ migration 001 nhưng runtime chưa bao giờ
--    dùng tới (orchestrator hard-code 3 chuỗi tool trong source). Ở đây chỉ
--    bổ sung những gì engine đồ thị cần, giữ nguyên dữ liệu sẵn có.
------------------------------------------------------------------------------
ALTER TABLE studio.tools ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE studio.tools ADD COLUMN IF NOT EXISTS source_table_code text;
ALTER TABLE studio.tools ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Suy ra kind cho 3 tool sẵn có từ binding của chúng.
UPDATE studio.tools SET kind = 'structured_query', source_table_code = 'course-catalog'
  WHERE code = 'course_lookup' AND kind IS NULL;
UPDATE studio.tools SET kind = 'pricing_quote', source_table_code = 'pricing-rules'
  WHERE code = 'pricing_quote' AND kind IS NULL;
UPDATE studio.tools SET kind = 'knowledge_search'
  WHERE code = 'knowledge_search' AND kind IS NULL;
UPDATE studio.tools SET kind = 'structured_query' WHERE kind IS NULL;

ALTER TABLE studio.tools ALTER COLUMN kind SET NOT NULL;
ALTER TABLE studio.tools DROP CONSTRAINT IF EXISTS tools_kind_check;
ALTER TABLE studio.tools ADD CONSTRAINT tools_kind_check
  CHECK (kind IN ('structured_query','knowledge_search','pricing_quote','http'));

COMMENT ON COLUMN studio.tools.source_table_code IS
  'Bảng Structured Data sinh ra tool này. Bảng đổi schema thì biết tool nào phải dựng lại.';

-- Hành vi khi tool không tìm được dữ liệu phải khai báo tường minh, không để
-- runtime tự đoán. Ghi vào policy jsonb sẵn có thay vì thêm cột mới.
UPDATE studio.tool_versions
SET policy = policy || jsonb_build_object('zero_result_behaviour',
      CASE (SELECT code FROM studio.tools WHERE id = tool_id)
        WHEN 'pricing_quote' THEN 'handover'
        WHEN 'course_lookup' THEN 'ask_clarifying'
        ELSE 'return_empty'
      END)
WHERE NOT (policy ? 'zero_result_behaviour');

-- allowed_stages trong policy gắn tool với 5 stage cứng. Engine đồ thị cấp
-- quyền tool ở cấp AGENT (agent_versions.tool_codes), nên trường này thành
-- thông tin tham khảo, không còn là cổng chặn.
COMMENT ON COLUMN studio.tool_versions.policy IS
  'timeout_ms, max_rows, zero_result_behaviour. allowed_stages giữ lại cho tương thích ngược; quyền dùng tool nay do agent_versions.tool_codes quyết định.';

DROP TRIGGER IF EXISTS trg_tools_updated ON studio.tools;
CREATE TRIGGER trg_tools_updated BEFORE UPDATE ON studio.tools
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

------------------------------------------------------------------------------
-- 3. TRACE cho từng node của đồ thị
--    ai_runs hiện ghi một dòng cho cả lượt. Đồ thị cần chi tiết từng bước.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.ai_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_run_id uuid NOT NULL REFERENCES platform.ai_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  node_id text NOT NULL,
  node_type text NOT NULL,
  node_label text,
  agent_version_id uuid REFERENCES studio.agent_versions(id),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Cạnh nào được chọn để đi tiếp, và vì sao.
  next_node_id text,
  branch_reason text,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed','skipped','failed','loop_guard')),
  error text,
  token_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ai_run_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_ai_run_steps_run ON platform.ai_run_steps(ai_run_id, step_index);

------------------------------------------------------------------------------
-- 4. Chuyển prompt hiện có thành agent tương đương
--    Ánh xạ 1-1, không đổi nội dung, để engine đồ thị có sẵn dữ liệu mà chạy.
------------------------------------------------------------------------------
INSERT INTO studio.agents (organization_id, code, name, description, kind)
SELECT p.organization_id, p.code, p.name,
       COALESCE(p.purpose, 'Chuyển tự động từ Prompt Registry'),
       CASE WHEN p.code LIKE '%classifier%' THEN 'classifier' ELSE 'conversational' END
FROM studio.prompts p
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO studio.agent_versions (
  agent_id, version_no, system_prompt, user_template, model_profile_code,
  parameters, tool_codes, memory, output_schema, status, change_summary
)
SELECT a.id, pv.version_no, pv.system_template, pv.user_template, pv.model_profile_code,
       '{}'::jsonb, COALESCE(pv.allowed_tools, '{}'),
       CASE WHEN a.kind = 'conversational'
            THEN '{"kind":"conversation_window","maxTurns":12,"scope":"conversation"}'::jsonb
            ELSE '{"kind":"none"}'::jsonb END,
       pv.output_schema,
       pv.status,
       'Chuyển tự động từ prompt_versions'
FROM studio.prompt_versions pv
JOIN studio.prompts p ON p.id = pv.prompt_id
JOIN studio.agents a ON a.organization_id = p.organization_id AND a.code = p.code
ON CONFLICT (agent_id, version_no) DO NOTHING;

------------------------------------------------------------------------------
-- 5. Chỗ nối tài liệu phi cấu trúc với bản ghi có cấu trúc.
--    Cho phép câu trả lời vừa có diễn giải (tài liệu) vừa có số liệu (bảng),
--    và trace chỉ rõ số tiền đến từ bản ghi nào.
------------------------------------------------------------------------------
ALTER TABLE knowledge.chunks
  ADD COLUMN IF NOT EXISTS structured_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN knowledge.chunks.structured_refs IS
  'Tham chiếu tới bản ghi có cấu trúc: [{"table":"course-catalog","recordKey":"DIGI-PERF"}]';

CREATE INDEX IF NOT EXISTS idx_chunks_structured_refs
  ON knowledge.chunks USING gin (structured_refs jsonb_path_ops);
