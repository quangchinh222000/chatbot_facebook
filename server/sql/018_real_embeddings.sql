-- Giai đoạn A1: embedding thật.
--
-- knowledge.chunks.embedding đang là vector(64) sinh bằng feature hashing
-- SHA256 — không phải semantic embedding. Hai câu cùng nghĩa khác từ vựng cho
-- vector gần như trực giao, nên thêm tài liệu vào cũng không giúp AI hiểu thêm.
--
-- Đổi sang 1536 chiều (OpenAI text-embedding-3-small). Không cast được vector
-- 64 chiều thành 1536, nên vector cũ phải bỏ và nhúng lại — 2 chunk seed, rủi
-- ro không đáng kể.

------------------------------------------------------------------------------
-- 1. Hồ sơ embedding — biết vector sinh bằng model nào, bao nhiêu chiều
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge.embedding_profiles (
  code text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('openai','local')),
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
  batch_size integer NOT NULL DEFAULT 96,
  -- Chỉ dùng được ở Demo Mode; giao diện phải cảnh báo rõ.
  demo_only boolean NOT NULL DEFAULT false,
  cost_per_million_tokens numeric(10,4),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO knowledge.embedding_profiles (code, provider, model, dimensions, batch_size, demo_only, cost_per_million_tokens)
VALUES
  ('openai-text-embedding-3-small-1536','openai','text-embedding-3-small',1536,96,false,0.0200),
  ('local-feature-hash-64','local','feature-hash-v1',64,512,true,0)
ON CONFLICT (code) DO UPDATE SET dimensions = EXCLUDED.dimensions, demo_only = EXCLUDED.demo_only;

------------------------------------------------------------------------------
-- 2. Đổi chiều vector
--    HNSW index phải bỏ trước khi đổi kiểu cột.
------------------------------------------------------------------------------
DROP INDEX IF EXISTS knowledge.idx_knowledge_vector;

-- Vector cũ 64 chiều không cast được sang 1536. Xoá nội dung, giữ hàng chunk
-- để không mất liên kết với revision — chúng sẽ được nhúng lại.
ALTER TABLE knowledge.chunks ALTER COLUMN embedding DROP NOT NULL;
-- Chunk chưa nhúng thì chưa biết model nào, nên cột này không thể NOT NULL.
ALTER TABLE knowledge.chunks ALTER COLUMN embedding_model DROP NOT NULL;
UPDATE knowledge.chunks SET embedding = NULL;
ALTER TABLE knowledge.chunks
  ALTER COLUMN embedding TYPE vector(1536) USING NULL;

-- UNIQUE (document_revision_id, chunk_index, embedding_model) hở khi
-- embedding_model là NULL: Postgres coi mỗi NULL là khác nhau nên cùng một
-- (revision, index) có thể chèn trùng vô hạn. Nay mỗi lần index là xoá rồi
-- chèn lại toàn bộ revision, nên khoá đúng là (revision, index).
ALTER TABLE knowledge.chunks
  DROP CONSTRAINT IF EXISTS chunks_document_revision_id_chunk_index_embedding_model_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_chunks_revision_index
  ON knowledge.chunks(document_revision_id, chunk_index);

-- Trạng thái nhúng ở cấp chunk: một đoạn hỏng không được làm hỏng cả tài liệu.
ALTER TABLE knowledge.chunks
  ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'pending'
  CHECK (embedding_status IN ('pending','embedded','failed','skipped'));
ALTER TABLE knowledge.chunks ADD COLUMN IF NOT EXISTS embedding_error text;
ALTER TABLE knowledge.chunks ADD COLUMN IF NOT EXISTS embedded_at timestamptz;
ALTER TABLE knowledge.chunks ADD COLUMN IF NOT EXISTS token_estimate integer;

UPDATE knowledge.chunks SET embedding_status = 'pending', embedding_model = NULL;

-- HNSW dựng lại trên 1536 chiều. Chỉ index hàng đã nhúng để không tốn chỗ cho
-- hàng NULL.
CREATE INDEX IF NOT EXISTS idx_knowledge_vector
  ON knowledge.chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chunks_embedding_status
  ON knowledge.chunks(organization_id, embedding_status)
  WHERE embedding_status <> 'embedded';

------------------------------------------------------------------------------
-- 3. Collection biết mình đang dùng hồ sơ embedding nào
--    Đổi model thì phải nhúng lại toàn bộ, không trộn hai không gian vector.
------------------------------------------------------------------------------
ALTER TABLE knowledge.collections
  ADD COLUMN IF NOT EXISTS embedding_profile_code text REFERENCES knowledge.embedding_profiles(code);
ALTER TABLE knowledge.collections
  ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'pending'
  CHECK (embedding_status IN ('pending','embedding','ready','failed'));
ALTER TABLE knowledge.collections ADD COLUMN IF NOT EXISTS last_embedded_at timestamptz;
ALTER TABLE knowledge.collections ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0;
ALTER TABLE knowledge.collections ADD COLUMN IF NOT EXISTS failed_chunk_count integer NOT NULL DEFAULT 0;

UPDATE knowledge.collections
SET embedding_profile_code = 'openai-text-embedding-3-small-1536', embedding_status = 'pending'
WHERE embedding_profile_code IS NULL;

------------------------------------------------------------------------------
-- 4. Việc nhúng lại — chạy nền, theo dõi được tiến độ
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge.reembed_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  collection_id uuid REFERENCES knowledge.collections(id) ON DELETE CASCADE,
  document_revision_id uuid REFERENCES knowledge.document_revisions(id) ON DELETE CASCADE,
  from_profile_code text,
  to_profile_code text NOT NULL REFERENCES knowledge.embedding_profiles(code),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','cancelled')),
  total_chunks integer NOT NULL DEFAULT 0,
  embedded_chunks integer NOT NULL DEFAULT 0,
  failed_chunks integer NOT NULL DEFAULT 0,
  reason text,
  last_error text,
  created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_reembed_runs_recent
  ON knowledge.reembed_runs(organization_id, created_at DESC);

------------------------------------------------------------------------------
-- 5. Lịch sử test truy hồi — để người thêm tài liệu biết mình làm tốt hay không
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge.retrieval_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organizations(id),
  collection_id uuid REFERENCES knowledge.collections(id) ON DELETE CASCADE,
  document_revision_id uuid REFERENCES knowledge.document_revisions(id) ON DELETE SET NULL,
  question text NOT NULL,
  top_k integer NOT NULL DEFAULT 5,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_score numeric(6,4),
  average_score numeric(6,4),
  -- Người chạy test đánh dấu kết quả có đúng không — dữ liệu để tính Recall@K.
  relevant_chunk_ids uuid[] NOT NULL DEFAULT '{}',
  verdict text CHECK (verdict IN ('good','partial','bad')),
  run_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_retrieval_tests_recent
  ON knowledge.retrieval_tests(organization_id, created_at DESC);

------------------------------------------------------------------------------
-- 6. Mọi revision đã publish cần nhúng lại bằng model mới
------------------------------------------------------------------------------
INSERT INTO knowledge.reembed_runs (organization_id, to_profile_code, status, total_chunks, reason)
SELECT d.organization_id, 'openai-text-embedding-3-small-1536', 'queued',
       (SELECT count(*)::int FROM knowledge.chunks c WHERE c.organization_id = d.organization_id),
       'Chuyển từ local-feature-hash-64 sang embedding thật 1536 chiều'
FROM knowledge.documents d
GROUP BY d.organization_id;
