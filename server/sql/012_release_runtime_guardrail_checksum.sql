WITH next_manifest AS (
  SELECT id,
    jsonb_set(
      jsonb_set(manifest,'{runtimeGuardrailVersion}','"grounded-structured-v3"'::jsonb,true),
      '{evaluationGateVersion}','"prompt-stage-v2"'::jsonb,true
    ) AS value
  FROM studio.releases
  WHERE id='36000000-0000-4000-8000-000000000001'
)
UPDATE studio.releases r
SET manifest=n.value,
    checksum=encode(digest(n.value::text,'sha256'),'hex'),
    change_summary='Runtime-connected prompts, structured output, grounded repair, and full prompt-stage evaluation gate'
FROM next_manifest n
WHERE r.id=n.id;
