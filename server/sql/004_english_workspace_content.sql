UPDATE iam.users
SET display_name = 'Admin User'
WHERE id = '00000000-0000-4000-8000-000000000030';

UPDATE conversation.contacts SET
  segment = CASE id
    WHEN '40000000-0000-4000-8000-000000000001' THEN 'Working professionals'
    WHEN '40000000-0000-4000-8000-000000000002' THEN 'Students'
    ELSE segment END,
  tags = CASE id
    WHEN '40000000-0000-4000-8000-000000000001' THEN ARRAY['marketing-interest']
    WHEN '40000000-0000-4000-8000-000000000002' THEN ARRAY['power-bi']
    ELSE tags END,
  profile = CASE id
    WHEN '40000000-0000-4000-8000-000000000001' THEN '{"occupation":"Content Executive","goal":"Build a stronger marketing foundation"}'::jsonb
    WHEN '40000000-0000-4000-8000-000000000002' THEN '{"occupation":"Final-year student","goal":"Apply for Data Analyst roles"}'::jsonb
    ELSE profile END
WHERE id IN ('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002');

UPDATE pricing.rules
SET audience_segment = CASE audience_segment
  WHEN 'NGƯỜI ĐI LÀM' THEN 'Working professionals'
  WHEN 'SINH VIÊN' THEN 'Students'
  ELSE audience_segment END;

UPDATE conversation.messages SET raw_text = normalized_text = CASE id
  WHEN '42000000-0000-4000-8000-000000000001' THEN 'I work in content and want to build a stronger marketing foundation.'
  WHEN '42000000-0000-4000-8000-000000000002' THEN 'That makes sense. A solid foundation makes each channel easier to evaluate. Is strategy or performance measurement the bigger challenge for you?'
  WHEN '42000000-0000-4000-8000-000000000003' THEN 'What will I learn in Marketing Foundation?'
  WHEN '42000000-0000-4000-8000-000000000004' THEN 'I have transferred the tuition for Power BI.'
  ELSE raw_text END
WHERE id IN (
  '42000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000002',
  '42000000-0000-4000-8000-000000000003','42000000-0000-4000-8000-000000000004'
);

UPDATE case_mgmt.cases
SET summary = 'The customer reported a Power BI tuition transfer. An agent must verify the transaction.'
WHERE id = '43000000-0000-4000-8000-000000000001';

UPDATE platform.notifications SET
  title = CASE id
    WHEN '44000000-0000-4000-8000-000000000001' THEN 'New payment case'
    WHEN '44000000-0000-4000-8000-000000000002' THEN 'Release active'
    ELSE title END,
  body = CASE id
    WHEN '44000000-0000-4000-8000-000000000001' THEN 'Huyen Trang reported a Power BI tuition transfer.'
    WHEN '44000000-0000-4000-8000-000000000002' THEN 'R-2026.08.01.1 serves 100% of development traffic.'
    ELSE body END
WHERE id IN ('44000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000002');

UPDATE knowledge.documents SET title = CASE id
  WHEN '20000000-0000-4000-8000-000000000010' THEN 'Sales insight - choosing a course by goal'
  WHEN '20000000-0000-4000-8000-000000000011' THEN 'Payment advisory policy'
  ELSE title END,
  language = 'en'
WHERE id IN ('20000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000011');

UPDATE knowledge.document_revisions SET
  original_content = CASE id
    WHEN '20000000-0000-4000-8000-000000000020' THEN 'When a learner is unsure where to start, ask about their current role, their goal for the next three to six months, and the skill blocking progress. Recommend a course only after enough context is available.'
    WHEN '20000000-0000-4000-8000-000000000021' THEN 'When a customer reports a transfer or payment, record the information and immediately hand the conversation to an agent. Never confirm that the transaction succeeded.'
    ELSE original_content END,
  clean_content = CASE id
    WHEN '20000000-0000-4000-8000-000000000020' THEN 'When a learner is unsure where to start, ask about their current role, their goal for the next three to six months, and the skill blocking progress. Recommend a course only after enough context is available.'
    WHEN '20000000-0000-4000-8000-000000000021' THEN 'When a customer reports a transfer or payment, record the information and immediately hand the conversation to an agent. Never confirm that the transaction succeeded.'
    ELSE clean_content END
WHERE id IN ('20000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000021');

UPDATE knowledge.chunks SET content = CASE id
  WHEN '20000000-0000-4000-8000-000000000030' THEN 'When a learner is unsure where to start, ask about their current role, their goal for the next three to six months, and the skill blocking progress. Recommend a course only after enough context is available.'
  WHEN '20000000-0000-4000-8000-000000000031' THEN 'When a customer reports a transfer or payment, record the information and immediately hand the conversation to an agent. Never confirm that the transaction succeeded.'
  ELSE content END
WHERE id IN ('20000000-0000-4000-8000-000000000030','20000000-0000-4000-8000-000000000031');

UPDATE studio.datasets SET description = CASE code
  WHEN 'course-catalog' THEN 'Typed course catalog replacing workflow database lookups'
  WHEN 'pricing-rules' THEN 'Effective-dated tuition and promotion rules'
  WHEN 'faq-mapping' THEN 'Small schema-controlled lookup dataset'
  ELSE description END;

UPDATE studio.prompt_versions SET system_template = CASE version_no || ':' || prompt_id::text
  WHEN '1:31000000-0000-4000-8000-000000000001' THEN 'Classify intent, stage, course, and route. Payment, human request, and existing HUMAN-mode rules always take precedence over the model.'
  WHEN '1:31000000-0000-4000-8000-000000000002' THEN 'Open naturally without selling a course. Use at most three or four short messages and avoid exclamation marks.'
  WHEN '1:31000000-0000-4000-8000-000000000003' THEN 'Discover the learner role, goal, and pain point. Use knowledge insights without selling a course yet.'
  WHEN '1:31000000-0000-4000-8000-000000000004' THEN 'Always run course_lookup first. Use one or two grounded facts and one follow-up question.'
  WHEN '1:31000000-0000-4000-8000-000000000005' THEN 'Always run pricing_quote. Never guess or round an amount. Quote the grounded price before asking a follow-up.'
  WHEN '1:31000000-0000-4000-8000-000000000006' THEN 'Create a concise handover summary and a friendly acknowledgement. Never confirm payment.'
  ELSE system_template END,
  change_reason = 'English operational baseline';

UPDATE studio.tools SET purpose = CASE code
  WHEN 'course_lookup' THEN 'Look up typed course and offering facts'
  WHEN 'pricing_quote' THEN 'Select deterministic tuition by course, audience, mode, and effective time'
  WHEN 'knowledge_search' THEN 'Hybrid FTS and pgvector search with citations'
  ELSE purpose END;

UPDATE studio.evaluation_suites
SET description = 'Required regression scenarios from the approved system design'
WHERE code = 'conversation-regression';

UPDATE studio.evaluation_cases SET input = CASE code
  WHEN 'first-message-price' THEN '{"message":"What is the Marketing Foundation tuition?","state":"NEW"}'::jsonb
  WHEN 'payment-handover' THEN '{"message":"I have already made the bank transfer.","state":"QNA_PRICE"}'::jsonb
  WHEN 'human-request' THEN '{"message":"Please connect me with a human advisor.","state":"QUALIFICATION"}'::jsonb
  ELSE input END;

UPDATE platform.settings
SET value = jsonb_set(value, '{safe_response}', '"I am verifying the information so I can respond accurately."'::jsonb)
WHERE key = 'ai';
