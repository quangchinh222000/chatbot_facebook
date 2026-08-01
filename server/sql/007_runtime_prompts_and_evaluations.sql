INSERT INTO studio.prompt_versions(
  id,prompt_id,version_no,status,system_template,user_template,variable_schema,output_schema,
  allowed_tools,model_profile_code,change_reason,created_by,approved_by
) VALUES
  (
    '31200000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000002',2,'published',
    'You edit the opening response for TM Academy Messenger. Answer what the customer actually wrote. Sound calm, human, and professional. Ask no more than one useful follow-up question. Do not recommend a course unless the grounded draft already does so.',
    'Produce the final opening reply from the grounded draft. Keep the useful answer and remove filler.',
    '{"stage":"string","customer_message":"string","grounded_draft":"string"}',
    '{"type":"object","required":["message"],"properties":{"message":{"type":"string"}}}',
    ARRAY[]::text[],'conversation-primary','Connect the prompt registry to the runtime gateway with a grounded output contract.',
    '00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'
  ),
  (
    '31200000-0000-4000-8000-000000000003','31000000-0000-4000-8000-000000000003',2,'published',
    'You edit a qualification response for TM Academy Messenger. Acknowledge the specific goal or problem in the grounded draft, then ask one question that helps determine fit. Do not claim that a course is suitable without grounded evidence.',
    'Produce the final qualification reply from the grounded draft. Keep it concise and specific.',
    '{"stage":"string","customer_message":"string","grounded_draft":"string"}',
    '{"type":"object","required":["message"],"properties":{"message":{"type":"string"}}}',
    ARRAY['knowledge_search'],'conversation-primary','Connect the prompt registry to the runtime gateway with a grounded output contract.',
    '00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'
  ),
  (
    '31200000-0000-4000-8000-000000000004','31000000-0000-4000-8000-000000000004',2,'published',
    'You edit a course-information response for TM Academy Messenger. Lead with the direct answer. Use only the selected course and offering facts already present in the grounded draft. Preserve qualifications such as delivery mode, start date, schedule, region, and certificate conditions.',
    'Produce the final course-information reply from the grounded draft. Include at most one relevant next question.',
    '{"stage":"string","customer_message":"string","grounded_draft":"string"}',
    '{"type":"object","required":["message"],"properties":{"message":{"type":"string"}}}',
    ARRAY['course_lookup'],'conversation-primary','Connect the prompt registry to the runtime gateway with a grounded output contract.',
    '00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'
  ),
  (
    '31200000-0000-4000-8000-000000000005','31000000-0000-4000-8000-000000000005',2,'published',
    'You edit a tuition response for TM Academy Messenger. State the course and Standard tuition first, followed by an applicable promotional amount only when it exists in the grounded draft. Never round, convert, calculate, or infer an amount. Preserve installment qualifications exactly.',
    'Produce the final pricing reply from the grounded draft. Do not delay the quoted price behind a follow-up question.',
    '{"stage":"string","customer_message":"string","grounded_draft":"string"}',
    '{"type":"object","required":["message"],"properties":{"message":{"type":"string"}}}',
    ARRAY['pricing_quote'],'conversation-primary','Connect the prompt registry to the runtime gateway with a grounded output contract.',
    '00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'
  ),
  (
    '31200000-0000-4000-8000-000000000006','31000000-0000-4000-8000-000000000006',2,'published',
    'You edit a handover acknowledgement for TM Academy Messenger. Say that an advisor will continue the conversation. Do not claim that payment, enrollment, seat availability, or any external action has been verified or completed.',
    'Produce the final handover acknowledgement from the grounded draft. Keep it to one or two short sentences.',
    '{"stage":"string","customer_message":"string","grounded_draft":"string"}',
    '{"type":"object","required":["message"],"properties":{"message":{"type":"string"}}}',
    ARRAY[]::text[],'conversation-primary','Connect the prompt registry to the runtime gateway with a grounded output contract.',
    '00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000030'
  )
ON CONFLICT (prompt_id,version_no) DO NOTHING;

UPDATE studio.releases
SET manifest = jsonb_set(
  jsonb_set(manifest,'{promptRuntime}','"registry-connected-v2"'::jsonb,true),
  '{promptVersionIds}',
  '{"ice-break":"31200000-0000-4000-8000-000000000002","qualification":"31200000-0000-4000-8000-000000000003","qna-course":"31200000-0000-4000-8000-000000000004","qna-price":"31200000-0000-4000-8000-000000000005","handover-summary":"31200000-0000-4000-8000-000000000006"}'::jsonb,
  true
), change_summary='Runtime-connected prompts, structured output, and grounded response validation'
WHERE id='36000000-0000-4000-8000-000000000001';

INSERT INTO studio.evaluation_cases(id,suite_id,code,input,expected,severity,tags) VALUES
  ('35200000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','english-price-first-message','{"message":"What is the tuition fee for Digital Performance?","state":"NEW"}','{"stage":"QNA_PRICE","route":"bot","required_tool":"pricing_quote"}','critical',ARRAY['english','price','grounding']),
  ('35200000-0000-4000-8000-000000000002','35000000-0000-4000-8000-000000000001','english-payment-handover','{"message":"I have completed the bank transfer","state":"QNA_PRICE"}','{"stage":"HUMAN","route":"human","reason":"PAYMENT_NOTIFICATION"}','critical',ARRAY['english','payment','handover']),
  ('35200000-0000-4000-8000-000000000003','35000000-0000-4000-8000-000000000001','english-human-request','{"message":"Please connect me with a real person","state":"QUALIFICATION"}','{"stage":"HUMAN","route":"human","reason":"HUMAN_REQUEST"}','critical',ARRAY['english','handover']),
  ('35200000-0000-4000-8000-000000000004','35000000-0000-4000-8000-000000000001','english-phone-capture','{"message":"Please call me on 0901234567","state":"QUALIFICATION"}','{"stage":"HUMAN","route":"human","reason":"CONTACT_CAPTURE"}','critical',ARRAY['english','privacy','handover']),
  ('35200000-0000-4000-8000-000000000005','35000000-0000-4000-8000-000000000001','english-closing-handover','{"message":"I would like to enroll now","state":"QNA_COURSE"}','{"stage":"HUMAN","route":"human","reason":"CLOSING"}','critical',ARRAY['english','closing','handover'])
ON CONFLICT (suite_id,code) DO NOTHING;
