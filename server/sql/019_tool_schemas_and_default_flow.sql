-- Sửa input_schema của 3 tool seed cho khớp cách runtime thật sự gọi chúng,
-- và nạp một flow đa agent mặc định tương đương workflow n8n đang chạy.

------------------------------------------------------------------------------
-- 1. input_schema của tool seed
--    as_of và audience là tuỳ chọn: không truyền thì lấy thời điểm hiện tại và
--    phân khúc mặc định. Bản seed để as_of vào required nên mọi lời gọi đều
--    trượt validation.
------------------------------------------------------------------------------
UPDATE studio.tool_versions tv
SET input_schema = '{
  "type":"object","additionalProperties":false,
  "required":["course_id"],
  "properties":{
    "course_id":{"type":"string","description":"ID khoá học cần báo giá"},
    "audience":{"type":"string","description":"Phân khúc học viên, ví dụ NGƯỜI ĐI LÀM hoặc SINH VIÊN"},
    "delivery_mode":{"type":"string","description":"Hình thức học: online, offline, hybrid"},
    "as_of":{"type":"string","description":"Thời điểm áp dụng giá, mặc định là hiện tại"}
  }}'::jsonb
FROM studio.tools t WHERE t.id = tv.tool_id AND t.code = 'pricing_quote';

UPDATE studio.tool_versions tv
SET input_schema = '{
  "type":"object","additionalProperties":false,
  "required":["course_id"],
  "properties":{"course_id":{"type":"string","description":"ID khoá học cần tra cứu"}}}'::jsonb
FROM studio.tools t WHERE t.id = tv.tool_id AND t.code = 'course_lookup';

UPDATE studio.tool_versions tv
SET input_schema = '{
  "type":"object","additionalProperties":false,
  "required":["query"],
  "properties":{
    "query":{"type":"string","description":"Câu cần tìm trong tài liệu"},
    "top_k":{"type":"integer","minimum":1,"maximum":20,"description":"Số đoạn trả về"}
  }}'::jsonb
FROM studio.tools t WHERE t.id = tv.tool_id AND t.code = 'knowledge_search';

------------------------------------------------------------------------------
-- 2. Cấp tool cho agent
--    Quyền dùng tool nay thuộc về agent, không thuộc về stage. Bản chuyển từ
--    prompt sang agent chỉ mang theo allowed_tools cũ, nhiều agent còn rỗng.
------------------------------------------------------------------------------
UPDATE studio.agent_versions av SET tool_codes = ARRAY['pricing_quote','course_lookup','knowledge_search']
FROM studio.agents a WHERE a.id = av.agent_id AND a.code = 'qna-price';

UPDATE studio.agent_versions av SET tool_codes = ARRAY['course_lookup','knowledge_search']
FROM studio.agents a WHERE a.id = av.agent_id AND a.code = 'qna-course';

UPDATE studio.agent_versions av SET tool_codes = ARRAY['knowledge_search']
FROM studio.agents a WHERE a.id = av.agent_id AND a.code IN ('qualification','ice-break');

UPDATE studio.agent_versions av SET knowledge_codes = ARRAY['sales-insights-vi']
FROM studio.agents a WHERE a.id = av.agent_id
  AND a.code IN ('qualification','ice-break','qna-course','qna-price')
  AND cardinality(av.knowledge_codes) = 0;

------------------------------------------------------------------------------
-- 3. Flow đa agent mặc định
--    Dựng lại cấu trúc workflow n8n: phân loại -> rẽ nhánh theo intent ->
--    agent chuyên trách -> trả lời, cộng nhánh chuyển người.
------------------------------------------------------------------------------
INSERT INTO studio.flows (organization_id, code, name, description)
SELECT id, 'multi-agent-default', 'Luồng đa Agent mặc định',
       'Phân loại ý định rồi giao cho agent chuyên trách. Tương đương cấu trúc workflow n8n đang vận hành.'
FROM iam.organizations
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO studio.flow_versions (flow_id, version_no, status, graph, change_reason)
SELECT f.id, 1, 'published', '{
  "entryNodeId": "vao",
  "maxSteps": 25,
  "nodes": [
    {"id":"vao","type":"entry","label":"Tin nhắn vào","config":{},"position":{"x":40,"y":200}},
    {"id":"chan","type":"guard","label":"Luật cứng","config":{"ruleSetCode":"safety-core"},"position":{"x":200,"y":200}},
    {"id":"phanloai","type":"classifier","label":"Phân loại ý định","config":{"agentCode":"intent-classifier"},"position":{"x":380,"y":200}},
    {"id":"ag_gia","type":"agent","label":"Tư vấn học phí","config":{"agentCode":"qna-price"},"position":{"x":600,"y":80}},
    {"id":"ag_khoa","type":"agent","label":"Tư vấn khoá học","config":{"agentCode":"qna-course"},"position":{"x":600,"y":200}},
    {"id":"ag_khaithac","type":"agent","label":"Khai thác nhu cầu","config":{"agentCode":"qualification"},"position":{"x":600,"y":320}},
    {"id":"ag_chao","type":"agent","label":"Chào hỏi","config":{"agentCode":"ice-break"},"position":{"x":600,"y":440}},
    {"id":"chuyennguoi","type":"handover","label":"Chuyển tư vấn viên","config":{"reasonCode":"POLICY_HANDOVER","priority":"normal"},"position":{"x":840,"y":560}},
    {"id":"traloi","type":"respond","label":"Trả lời khách","config":{"segmentation":true,"typingIndicator":true},"position":{"x":900,"y":200}}
  ],
  "edges": [
    {"id":"e1","source":"vao","target":"chan","priority":10,"label":""},
    {"id":"e2","source":"chan","target":"chuyennguoi","when":"route == ''human''","priority":10,"label":"luật cứng bắt"},
    {"id":"e3","source":"chan","target":"phanloai","priority":100,"label":"tiếp tục"},
    {"id":"e4","source":"phanloai","target":"chuyennguoi","when":"route == ''human'' || confidence < 0.5","priority":10,"label":"không chắc"},
    {"id":"e5","source":"phanloai","target":"ag_gia","when":"stage == ''QNA_PRICE''","priority":20,"label":"hỏi giá"},
    {"id":"e6","source":"phanloai","target":"ag_khoa","when":"stage == ''QNA_COURSE''","priority":30,"label":"hỏi khoá"},
    {"id":"e7","source":"phanloai","target":"ag_khaithac","when":"stage == ''QUALIFICATION''","priority":40,"label":"khai thác"},
    {"id":"e8","source":"phanloai","target":"ag_chao","priority":100,"label":"mặc định"},
    {"id":"e9","source":"ag_gia","target":"traloi","priority":100,"label":""},
    {"id":"e10","source":"ag_khoa","target":"traloi","priority":100,"label":""},
    {"id":"e11","source":"ag_khaithac","target":"traloi","priority":100,"label":""},
    {"id":"e12","source":"ag_chao","target":"traloi","priority":100,"label":""}
  ]
}'::jsonb, 'Flow mặc định dựng theo cấu trúc workflow n8n'
FROM studio.flows f
WHERE f.code = 'multi-agent-default'
ON CONFLICT (flow_id, version_no) DO UPDATE SET graph = EXCLUDED.graph;

------------------------------------------------------------------------------
-- 4. binding của tool seed
--    Bản seed ghi {"method":"lookup","service":"catalog"} — mô tả dịch vụ chứ
--    không chỉ ra nguồn dữ liệu, nên executor không biết đọc bảng nào.
------------------------------------------------------------------------------
UPDATE studio.tool_versions tv
SET binding = binding || '{"tableCode":"course-catalog","limit":1}'::jsonb
FROM studio.tools t WHERE t.id = tv.tool_id AND t.code = 'course_lookup';

UPDATE studio.tool_versions tv
SET binding = binding || '{"tableCode":"pricing-rules","requirePublished":true}'::jsonb
FROM studio.tools t WHERE t.id = tv.tool_id AND t.code = 'pricing_quote';

UPDATE studio.tool_versions tv
SET binding = binding || '{"collectionCode":"sales-insights-vi","topK":3}'::jsonb
FROM studio.tools t WHERE t.id = tv.tool_id AND t.code = 'knowledge_search';
