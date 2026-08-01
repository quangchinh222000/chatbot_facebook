INSERT INTO iam.organizations(id, code, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'tm-academy', 'TM Academy')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO iam.teams(id, organization_id, code, name) VALUES
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'sales', 'Sales & Student Success'),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'knowledge', 'Knowledge & Content'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'ai-ops', 'AI Operations')
ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO iam.roles(id, organization_id, code, name, description, permissions) VALUES
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000001', 'platform-admin', 'Platform Admin', 'Full local demo access',
   '["dashboard.view","conversation.read.team","conversation.reply.assigned","conversation.takeover","conversation.release_bot","case.assign.team","course.publish","pricing.publish","knowledge.read","knowledge.write","knowledge.approve","knowledge.publish","studio.read","studio.write","studio.approve","studio.evaluate","studio.release","prompt.activate","release.manage","ai_trace.read","pii.read","audit.export","channel.manage","user.manage"]'::jsonb),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', 'sales-agent', 'Sales Agent', 'Conversation and assigned case access',
   '["dashboard.view","conversation.read.team","conversation.reply.assigned","conversation.takeover"]'::jsonb)
ON CONFLICT (organization_id, code) DO UPDATE SET permissions = EXCLUDED.permissions;

INSERT INTO iam.users(id, organization_id, email, display_name, password_hash, status)
VALUES (
  '00000000-0000-4000-8000-000000000030',
  '00000000-0000-4000-8000-000000000001',
  'admin@tm.local',
  'Nguyễn Admin',
  crypt('Admin@123', gen_salt('bf', 10)),
  'active'
)
ON CONFLICT (organization_id, email) DO NOTHING;

INSERT INTO iam.user_roles(user_id, role_id)
VALUES ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000020')
ON CONFLICT DO NOTHING;
INSERT INTO iam.team_members(team_id, user_id)
VALUES ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000030')
ON CONFLICT DO NOTHING;

INSERT INTO channel.accounts(id, organization_id, provider, name, external_page_id, status, graph_version, policy) VALUES
  ('00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000001', 'demo', 'TM Academy Demo Channel', 'demo-page', 'healthy', 'local', '{"debounce_seconds":2,"send_delay_ms":100}')
ON CONFLICT (organization_id, provider, external_page_id) DO UPDATE SET status = 'healthy';

INSERT INTO catalog.courses(id, organization_id, code, name, category, description) VALUES
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','MKT-FOUND','Marketing Foundation','Marketing','Nền tảng tư duy và kiến thức marketing cho người mới.'),
  ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','DIGI-FOUND','Digital Foundation','Digital','Nền tảng các kênh Digital Marketing và cách phối hợp.'),
  ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','DIGI-PERF','Digital Performance','Digital','Lập kế hoạch, triển khai và đo lường performance marketing.'),
  ('10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','CONTENT','Content Marketing','Marketing','Xây dựng chiến lược và hệ thống nội dung.'),
  ('10000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','BRAND','Brand Development','Marketing','Phát triển chiến lược thương hiệu.'),
  ('10000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','CASE','Case Mastery','Career','Giải quyết business case có cấu trúc.'),
  ('10000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001','INTERVIEW','Master Interview & Job Application','Career','Chuẩn bị hồ sơ và phỏng vấn.'),
  ('10000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001','STRATEGY','Strategy Formulation','Strategy','Xây dựng chiến lược kinh doanh.'),
  ('10000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000001','CONSUMER','Consumer Psychology','Marketing','Tâm lý và hành vi người tiêu dùng.'),
  ('10000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','DECISION','Decision Science','Data','Ra quyết định dựa trên dữ liệu.'),
  ('10000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','GEN-AI','Generative AI','AI','Ứng dụng Generative AI trong công việc.'),
  ('10000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','POWERBI','Data Analysis with Power BI | Tableau','Data','Phân tích và trực quan dữ liệu với công cụ BI.'),
  ('10000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001','EXCEL','Data Visualization & Analytics with Excel','Data','Phân tích và trực quan dữ liệu với Excel.'),
  ('10000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000001','SQL','SQL for Data Analysis','Data','SQL phục vụ phân tích dữ liệu.'),
  ('10000000-0000-4000-8000-000000000015','00000000-0000-4000-8000-000000000001','ML-PY','AI & Machine Learning with Python','AI','Nền tảng AI và machine learning với Python.'),
  ('10000000-0000-4000-8000-000000000016','00000000-0000-4000-8000-000000000001','CMO','CMO Program','Management','Chương trình quản trị marketing dành cho quản lý.'),
  ('10000000-0000-4000-8000-000000000017','00000000-0000-4000-8000-000000000001','PDA','Professional Data Analyst Program','Data','Lộ trình nghề nghiệp Data Analyst.'),
  ('10000000-0000-4000-8000-000000000018','00000000-0000-4000-8000-000000000001','DM','Digital Manager Program','Management','Chương trình quản trị digital.'),
  ('10000000-0000-4000-8000-000000000019','00000000-0000-4000-8000-000000000001','AIP','AI Professional Program','AI','Lộ trình chuyên nghiệp AI.'),
  ('10000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000001','AI-MKT','AI Marketing','AI','Ứng dụng AI trong marketing.')
ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO catalog.course_aliases(course_id, alias) VALUES
  ('10000000-0000-4000-8000-000000000001','Marketing Foundation'),
  ('10000000-0000-4000-8000-000000000001','Marketing nền tảng'),
  ('10000000-0000-4000-8000-000000000002','Digital Foundation'),
  ('10000000-0000-4000-8000-000000000003','Digital Performance'),
  ('10000000-0000-4000-8000-000000000003','Digital Perf'),
  ('10000000-0000-4000-8000-000000000003','Perf'),
  ('10000000-0000-4000-8000-000000000004','Content'),
  ('10000000-0000-4000-8000-000000000005','Brand'),
  ('10000000-0000-4000-8000-000000000012','Power BI'),
  ('10000000-0000-4000-8000-000000000012','Tableau'),
  ('10000000-0000-4000-8000-000000000014','SQL')
ON CONFLICT DO NOTHING;

INSERT INTO catalog.offerings(id, organization_id, course_id, delivery_mode, cohort_name, schedule_text, start_at, certificate) VALUES
  ('11000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','online','MF Online 08/2026','Thứ 3 & Thứ 5, 19:30–21:30','2026-08-18T12:30:00Z','TM Academy Certificate'),
  ('11000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','online','DP Online 08/2026','Thứ 2 & Thứ 4, 19:30–21:30','2026-08-20T12:30:00Z','TM Academy Certificate'),
  ('11000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000012','online','Power BI 09/2026','Cuối tuần, 09:00–11:30','2026-09-05T02:00:00Z','TM Academy Certificate')
ON CONFLICT (id) DO UPDATE SET schedule_text = EXCLUDED.schedule_text;

INSERT INTO pricing.rules(id, organization_id, course_id, offering_id, audience_segment, delivery_mode, standard_price, early_bird_price, promotion_name, priority, effective_from) VALUES
  ('12000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','NGƯỜI ĐI LÀM','online',8100000,6210000,'Early Bird',10,'2026-01-01T00:00:00Z'),
  ('12000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','SINH VIÊN','online',7200000,5520000,'Student Early Bird',20,'2026-01-01T00:00:00Z'),
  ('12000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','11000000-0000-4000-8000-000000000002','NGƯỜI ĐI LÀM','online',9800000,7900000,'Early Bird',10,'2026-01-01T00:00:00Z'),
  ('12000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000012','11000000-0000-4000-8000-000000000003','NGƯỜI ĐI LÀM','online',8900000,7100000,'Early Bird',10,'2026-01-01T00:00:00Z')
ON CONFLICT (id) DO UPDATE SET standard_price = EXCLUDED.standard_price, early_bird_price = EXCLUDED.early_bird_price;

INSERT INTO knowledge.chunk_profiles(id, organization_id, code, name, target_chars, max_chars, overlap_chars)
VALUES ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','heading-aware-v1','Heading-aware Vietnamese',900,1400,120)
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO knowledge.documents(id, organization_id, title, source_type, language, owner_id, tags, status) VALUES
  ('20000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','Sales insight – Chọn khóa theo mục tiêu','text','vi','00000000-0000-4000-8000-000000000030',ARRAY['sales','qualification'],'published'),
  ('20000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','Chính sách tư vấn thanh toán','text','vi','00000000-0000-4000-8000-000000000030',ARRAY['policy','payment'],'published')
ON CONFLICT (id) DO NOTHING;

INSERT INTO knowledge.document_revisions(id, document_id, revision_no, original_content, clean_content, content_hash, status, created_by, approved_by) VALUES
  ('20000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000010',1,'Nhiều học viên chưa biết bắt đầu từ đâu.','Khi học viên chưa rõ nên bắt đầu từ đâu, hãy tìm hiểu vai trò hiện tại, mục tiêu trong 3–6 tháng và kỹ năng đang vướng. Chỉ gợi ý sau khi có đủ bối cảnh.','seed-sales-insight-v1','published','00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'),
  ('20000000-0000-4000-8000-000000000021','20000000-0000-4000-8000-000000000011',1,'Không xác nhận thanh toán.','Khi khách nói đã chuyển khoản hoặc đã thanh toán, bot chỉ tiếp nhận thông tin và chuyển ngay sang nhân viên. Tuyệt đối không xác nhận giao dịch thành công.','seed-payment-policy-v1','published','00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030')
ON CONFLICT (id) DO NOTHING;

INSERT INTO knowledge.chunks(id, organization_id, document_revision_id, chunk_profile_id, chunk_index, heading_path, content, metadata) VALUES
  ('20000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000001',0,'Qualification','Khi học viên chưa rõ nên bắt đầu từ đâu, hãy tìm hiểu vai trò hiện tại, mục tiêu trong 3–6 tháng và kỹ năng đang vướng. Chỉ gợi ý sau khi có đủ bối cảnh.','{"topic":"qualification"}'),
  ('20000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000021','20000000-0000-4000-8000-000000000001',0,'Payment policy','Khi khách nói đã chuyển khoản hoặc đã thanh toán, bot chỉ tiếp nhận thông tin và chuyển ngay sang nhân viên. Tuyệt đối không xác nhận giao dịch thành công.','{"topic":"payment"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO knowledge.collections(id, organization_id, code, name, description, status, active) VALUES
  ('20000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000001','sales-insights-vi','Sales Insights VI','Q&A, pain point và policy dùng cho tư vấn','published',true)
ON CONFLICT (organization_id, code, version) DO UPDATE SET active = true;
INSERT INTO knowledge.collection_members(collection_id, document_revision_id) VALUES
  ('20000000-0000-4000-8000-000000000040','20000000-0000-4000-8000-000000000020'),
  ('20000000-0000-4000-8000-000000000040','20000000-0000-4000-8000-000000000021')
ON CONFLICT DO NOTHING;

INSERT INTO studio.datasets(id, organization_id, code, name, dataset_type, description, owner_id) VALUES
  ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','course-catalog','Course Catalog','typed_domain','Danh mục khóa học typed thay NocoDB','00000000-0000-4000-8000-000000000030'),
  ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','pricing-rules','Pricing Rules','typed_domain','Giá và ưu đãi có effective date','00000000-0000-4000-8000-000000000030'),
  ('30000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','faq-mapping','FAQ Mapping','managed','Lookup dữ liệu nhỏ có schema','00000000-0000-4000-8000-000000000030')
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO studio.dataset_versions(id, dataset_id, version_no, status, schema_definition, validation_summary, row_count, created_by, approved_by, published_at) VALUES
  ('30000000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000001',1,'published','{"fields":["code","name","status"]}','{"errors":0,"warnings":0}',20,'00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030',now()),
  ('30000000-0000-4000-8000-000000000012','30000000-0000-4000-8000-000000000002',1,'published','{"fields":["course","audience","standard_price","early_bird_price","effective_from"]}','{"errors":0,"warnings":0}',4,'00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030',now())
ON CONFLICT (dataset_id, version_no) DO NOTHING;

INSERT INTO studio.prompts(id, organization_id, code, name, purpose) VALUES
  ('31000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','intent-classifier','Intent & Stage Classifier','classifier'),
  ('31000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','ice-break','Ice Break','conversation_stage'),
  ('31000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','qualification','Qualification','conversation_stage'),
  ('31000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','qna-course','Q&A Course','conversation_stage'),
  ('31000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','qna-price','Q&A Pricing','conversation_stage'),
  ('31000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','handover-summary','Handover Summary','operations')
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO studio.prompt_versions(id, prompt_id, version_no, status, system_template, variable_schema, output_schema, allowed_tools, model_profile_code, change_reason, created_by, approved_by) VALUES
  ('31100000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',1,'published','Phân loại intent, stage, course và route. Hard rule thanh toán, yêu cầu người thật và HUMAN mode luôn ưu tiên trước model.','{"latest_messages":"array","current_state":"string"}','{"intent":"string","stageCandidate":"string","routeCandidate":"string","courseCandidates":"array","confidence":"number","signals":"array"}',ARRAY[]::text[],'classifier-fast','Tách hard rules khỏi prompt n8n','00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'),
  ('31100000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000002',1,'published','Mở lời tự nhiên, chưa bán khóa học; tối đa 3–4 tin ngắn, không dùng dấu chấm than.','{"messages":"array","customer_profile":"object"}','{}',ARRAY['knowledge_search'],'conversation-primary','Chuẩn hóa Ice Break từ n8n','00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'),
  ('31100000-0000-4000-8000-000000000003','31000000-0000-4000-8000-000000000003',1,'published','Khai thác vai trò, mục tiêu và pain point; dùng knowledge insight nhưng chưa bán khóa học.','{"messages":"array","customer_profile":"object"}','{}',ARRAY['knowledge_search'],'conversation-primary','Chuẩn hóa Qualification từ n8n','00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'),
  ('31100000-0000-4000-8000-000000000004','31000000-0000-4000-8000-000000000004',1,'published','Bắt buộc course_lookup trước khi trả lời; chỉ dùng 1–2 dữ kiện tool và một follow-up.','{"messages":"array","course":"object","tool_results":"object"}','{}',ARRAY['course_lookup','knowledge_search'],'conversation-primary','Typed tool thay workflow con','00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'),
  ('31100000-0000-4000-8000-000000000005','31000000-0000-4000-8000-000000000005',1,'published','Bắt buộc pricing_quote; không đoán hoặc làm tròn giá; báo giá trước khi hỏi thêm.','{"messages":"array","course":"object","tool_results":"object"}','{}',ARRAY['pricing_quote'],'conversation-primary','Typed pricing rule thay NocoDB query do AI sinh','00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'),
  ('31100000-0000-4000-8000-000000000006','31000000-0000-4000-8000-000000000006',1,'published','Tóm tắt 2–3 câu và soạn lời tiếp nhận thân thiện; không xác nhận thanh toán.','{"messages":"array","reason":"string"}','{"summary":"string","reply":"string"}',ARRAY[]::text[],'conversation-primary','Thay Google Sheets/Base handover chain','00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030')
ON CONFLICT (prompt_id, version_no) DO NOTHING;

INSERT INTO studio.rule_sets(id, organization_id, code, name)
VALUES ('32000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','conversation-policy','Conversation Policy')
ON CONFLICT (organization_id, code) DO NOTHING;
INSERT INTO studio.rule_versions(id, rule_set_id, version_no, status, rules, conflicts, created_by, approved_by) VALUES
  ('32100000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001',1,'published',
   '[{"code":"existing_human","priority":0,"condition":"bot_mode=human","action":"STOP_BOT"},{"code":"payment","priority":1,"signals":["chuyển khoản","đã thanh toán","thanh toán"],"action":"TAKEOVER","reason":"PAYMENT_NOTIFICATION"},{"code":"human_request","priority":2,"signals":["người thật","tư vấn viên","không muốn nói với bot"],"action":"TAKEOVER","reason":"HUMAN_REQUEST"},{"code":"phone_capture","priority":3,"pattern":"phone","action":"TAKEOVER","reason":"CONTACT_CAPTURE"}]'::jsonb,
   '[]'::jsonb,'00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030')
ON CONFLICT (rule_set_id, version_no) DO NOTHING;

INSERT INTO studio.tools(id, organization_id, code, name, purpose) VALUES
  ('33000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','course_lookup','Course Lookup','Tra cứu course/offering typed'),
  ('33000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','pricing_quote','Pricing Quote','Chọn giá deterministic theo course, audience, mode và thời điểm'),
  ('33000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','knowledge_search','Knowledge Search','Hybrid FTS + pgvector có citation')
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO studio.tool_versions(tool_id, version_no, input_schema, output_schema, binding, policy) VALUES
  ('33000000-0000-4000-8000-000000000001',1,'{"type":"object","required":["course_id"],"properties":{"course_id":{"type":"string"}}}','{"type":"object","properties":{"course":{"type":"object"},"offerings":{"type":"array"}}}','{"service":"catalog","method":"lookup"}','{"allowed_stages":["QNA_COURSE","QNA_PRICE"],"timeout_ms":1000}'),
  ('33000000-0000-4000-8000-000000000002',1,'{"type":"object","required":["course_id","as_of"],"properties":{"course_id":{"type":"string"},"audience":{"type":"string"},"as_of":{"type":"string"}}}','{"type":"object","properties":{"currency":{"type":"string"},"standard_price":{"type":"number"},"early_bird_price":{"type":"number"},"selected_rule_id":{"type":"string"}}}','{"service":"pricing","method":"quote"}','{"allowed_stages":["QNA_PRICE"],"timeout_ms":1000}'),
  ('33000000-0000-4000-8000-000000000003',1,'{"type":"object","required":["query"],"properties":{"query":{"type":"string"},"top_k":{"type":"integer"}}}','{"type":"array","items":{"type":"object"}}','{"service":"knowledge","method":"hybridSearch"}','{"allowed_stages":["ICE_BREAK","QUALIFICATION","QNA_COURSE"],"timeout_ms":2000,"max_rows":8}')
ON CONFLICT (tool_id, version_no) DO NOTHING;

INSERT INTO studio.model_profiles(id, organization_id, code, name, provider, model, parameters, fallback_chain) VALUES
  ('34000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','classifier-fast','Classifier Fast','local_or_openai','gpt-4o-mini','{"temperature":0,"timeout_ms":8000}','["local-deterministic"]'),
  ('34000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','conversation-primary','Conversation Primary','local_or_openai','gpt-4.1-mini','{"temperature":0.3,"timeout_ms":15000}','["local-deterministic"]'),
  ('34000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','embedding-local','Embedding Local','local','local-hash-v1','{"dimensions":64}','[]')
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO studio.evaluation_suites(id, organization_id, code, name, description, gate_config) VALUES
  ('35000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','conversation-regression','Conversation Regression','Các scenario bắt buộc từ System Design','{"pass_rate":1,"critical_violations":0}')
ON CONFLICT (organization_id, code) DO NOTHING;
INSERT INTO studio.evaluation_cases(id, suite_id, code, input, expected, severity, tags) VALUES
  ('35100000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','first-message-price','{"message":"Học phí Marketing Foundation bao nhiêu?","state":"NEW"}','{"stage":"QNA_PRICE","route":"bot","required_tool":"pricing_quote"}','critical',ARRAY['price','first-message']),
  ('35100000-0000-4000-8000-000000000002','35000000-0000-4000-8000-000000000001','payment-handover','{"message":"Mình đã chuyển khoản rồi","state":"QNA_PRICE"}','{"stage":"HUMAN","route":"human","reason":"PAYMENT_NOTIFICATION"}','critical',ARRAY['payment','handover']),
  ('35100000-0000-4000-8000-000000000003','35000000-0000-4000-8000-000000000001','human-request','{"message":"Cho mình gặp tư vấn viên người thật","state":"QUALIFICATION"}','{"stage":"HUMAN","route":"human","reason":"HUMAN_REQUEST"}','critical',ARRAY['handover'])
ON CONFLICT (suite_id, code) DO NOTHING;

INSERT INTO studio.releases(id, organization_id, release_code, environment, status, manifest, checksum, change_summary, created_by, approved_by, activated_at) VALUES
  ('36000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','R-2026.08.01.1','development','active',
   '{"promptBundleVersion":"seed-v1","ruleSetVersionId":"32100000-0000-4000-8000-000000000001","knowledgeCollectionIds":["20000000-0000-4000-8000-000000000040"],"toolRegistryVersion":"seed-v1","modelProfileCodes":["classifier-fast","conversation-primary"],"courseDataset":{"mode":"pinned","versionId":"30000000-0000-4000-8000-000000000011"},"pricingDataset":{"mode":"effective_at_event_time"}}',
   'seed-release-2026-08-01-1','Baseline local demo release','00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030',now())
ON CONFLICT (organization_id, environment, release_code) DO NOTHING;

INSERT INTO conversation.contacts(id, organization_id, display_name, phone, segment, tags, profile) VALUES
  ('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Minh Anh',NULL,'NGƯỜI ĐI LÀM',ARRAY['quan-tam-marketing'],'{"occupation":"Content Executive","goal":"Củng cố nền tảng marketing"}'),
  ('40000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Huyền Trang','0900000000','SINH VIÊN',ARRAY['power-bi'],'{"occupation":"Sinh viên năm cuối","goal":"Ứng tuyển Data Analyst"}')
ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO conversation.contact_identities(id, organization_id, contact_id, channel_account_id, external_user_id) VALUES
  ('40000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','demo-minh-anh'),
  ('40000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000100','demo-huyen-trang')
ON CONFLICT (channel_account_id, external_user_id) DO NOTHING;

INSERT INTO conversation.conversations(id, organization_id, channel_account_id, contact_id, external_thread_id, bot_mode, current_state, priority, unread_count, selected_course_id, last_message_at) VALUES
  ('41000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','40000000-0000-4000-8000-000000000001','demo-minh-anh','bot','QUALIFICATION','normal',2,'10000000-0000-4000-8000-000000000001',now() - interval '3 minutes'),
  ('41000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','40000000-0000-4000-8000-000000000002','demo-huyen-trang','human','HUMAN','high',1,'10000000-0000-4000-8000-000000000012',now() - interval '8 minutes')
ON CONFLICT (organization_id, channel_account_id, external_thread_id) DO UPDATE SET last_message_at = EXCLUDED.last_message_at;

INSERT INTO conversation.messages(id, organization_id, conversation_id, direction, sender_type, external_message_id, raw_text, normalized_text, status, created_at) VALUES
  ('42000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','inbound','customer','seed-msg-1','Mình đang làm content và muốn học thêm nền tảng marketing','Mình đang làm content và muốn học thêm nền tảng marketing','read',now() - interval '5 minutes'),
  ('42000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','outbound','bot','seed-out-1','Nghe hợp lý nè, nền tảng tốt sẽ giúp mình nhìn các kênh rõ hơn. Bạn đang vướng nhất ở phần chiến lược hay đo hiệu quả nhỉ?','Nghe hợp lý nè, nền tảng tốt sẽ giúp mình nhìn các kênh rõ hơn. Bạn đang vướng nhất ở phần chiến lược hay đo hiệu quả nhỉ?','delivered',now() - interval '4 minutes'),
  ('42000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','inbound','customer','seed-msg-2','Mình muốn biết khóa Marketing Foundation học gì','Mình muốn biết khóa Marketing Foundation học gì','pending',now() - interval '3 minutes'),
  ('42000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000002','inbound','customer','seed-msg-3','Mình đã chuyển khoản học Power BI rồi','Mình đã chuyển khoản học Power BI rồi','read',now() - interval '8 minutes')
ON CONFLICT (id) DO NOTHING;

INSERT INTO case_mgmt.cases(id, organization_id, conversation_id, reason_code, summary, priority, status, assigned_team_id, assigned_user_id, sla_due_at) VALUES
  ('43000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000002','PAYMENT_NOTIFICATION','Khách báo đã chuyển khoản khóa Power BI, cần nhân viên kiểm tra giao dịch.','high','assigned','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000030',now() + interval '22 minutes')
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform.settings(organization_id, key, value, updated_by) VALUES
  ('00000000-0000-4000-8000-000000000001','conversation','{"debounce_seconds":20,"message_limit":1900,"working_hours":"08:00-21:00","default_team_id":"00000000-0000-4000-8000-000000000010"}','00000000-0000-4000-8000-000000000030'),
  ('00000000-0000-4000-8000-000000000001','knowledge','{"allowed_file_types":["pdf","docx","pptx","txt","md","html","image"],"max_file_mb":25,"default_chunk_profile":"heading-aware-v1"}','00000000-0000-4000-8000-000000000030'),
  ('00000000-0000-4000-8000-000000000001','ai','{"provider_mode":"local_or_openai","safe_response":"Mình đang kiểm tra lại thông tin để phản hồi chính xác nhất nhé.","pii_masking":true}','00000000-0000-4000-8000-000000000030'),
  ('00000000-0000-4000-8000-000000000001','release','{"canary_presets":[5,10,25,50,100],"auto_abort":true,"approval_required":true}','00000000-0000-4000-8000-000000000030')
ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO platform.notifications(id, organization_id, user_id, type, title, body, severity, entity_type, entity_id) VALUES
  ('44000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000030','new_case','Case thanh toán mới','Huyền Trang báo đã chuyển khoản khóa Power BI.','warning','case','43000000-0000-4000-8000-000000000001'),
  ('44000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000030','release_active','Release đang hoạt động','R-2026.08.01.1 đang phục vụ 100% traffic development.','info','release','36000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;
