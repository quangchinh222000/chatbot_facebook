UPDATE studio.evaluation_cases
SET expected = expected || '{"response_grounded":true,"required_phrases":["Digital Performance","9,800,000","7,900,000"]}'::jsonb,
    tags = ARRAY(SELECT DISTINCT unnest(tags || ARRAY['model-response','grounded-output']))
WHERE suite_id='35000000-0000-4000-8000-000000000001'
  AND code='english-price-first-message';

UPDATE studio.evaluation_suites
SET description='Production routing, hard-rule, tool-policy, and grounded model-response scenarios',
    gate_config='{"pass_rate":1,"critical_violations":0,"grounded_model_responses":true}'::jsonb
WHERE id='35000000-0000-4000-8000-000000000001';
