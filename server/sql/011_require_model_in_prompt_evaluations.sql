UPDATE studio.evaluation_cases
SET expected = expected || '{"model_required":true}'::jsonb
WHERE suite_id='35000000-0000-4000-8000-000000000001'
  AND COALESCE((expected->>'response_grounded')::boolean,false)=true;
