-- =====================================================================
-- L&D Learning Companion — update 03: track modules by their final screen
-- The words shown on a module's last screen (e.g. "Congratulations").
-- When a learner reaches that screen, the module is marked Completed.
-- Run ONCE in SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.program_steps
  add column if not exists completion_text text;
