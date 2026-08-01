INSERT INTO studio.evaluation_cases(id,suite_id,code,input,expected,severity,tags) VALUES
  (
    '35300000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','english-ice-break-response',
    '{"message":"Hello, I need some guidance","state":"NEW"}',
    '{"stage":"ICE_BREAK","route":"bot","response_grounded":true}',
    'critical',ARRAY['english','ice-break','model-response','grounded-output']
  ),
  (
    '35300000-0000-4000-8000-000000000002','35000000-0000-4000-8000-000000000001','english-qualification-response',
    '{"message":"I want to improve my skills but I am not sure where to start","state":"QUALIFICATION"}',
    '{"stage":"QUALIFICATION","route":"bot","response_grounded":true}',
    'critical',ARRAY['english','qualification','model-response','grounded-output']
  ),
  (
    '35300000-0000-4000-8000-000000000003','35000000-0000-4000-8000-000000000001','english-course-response',
    '{"message":"Tell me about Digital Performance","state":"QUALIFICATION"}',
    '{"stage":"QNA_COURSE","route":"bot","required_tool":"course_lookup","response_grounded":true,"required_phrases":["Digital Performance"]}',
    'critical',ARRAY['english','course','model-response','grounded-output']
  )
ON CONFLICT (suite_id,code) DO NOTHING;
