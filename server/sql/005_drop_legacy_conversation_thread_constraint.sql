DO $$
DECLARE
  legacy_constraint record;
BEGIN
  FOR legacy_constraint IN
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'conversation'
      AND table_name = 'conversations'
      AND constraint_type = 'UNIQUE'
      AND constraint_name <> 'uq_conversations_thread_environment'
  LOOP
    EXECUTE format('ALTER TABLE conversation.conversations DROP CONSTRAINT %I', legacy_constraint.constraint_name);
  END LOOP;
END $$;
