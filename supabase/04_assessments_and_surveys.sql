-- =====================================================================
-- L&D Learning Companion — update 04: assessment and survey builder
-- Sections, question types, timer, open/close dates, attempts, shuffling,
-- built-in surveys with anonymous answers, and Admin-only score changes.
-- Run ONCE in SQL Editor → New query → paste → Run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Settings on assessment / survey steps
-- ---------------------------------------------------------------------
alter table public.program_steps
  add column if not exists close_at           timestamptz,
  add column if not exists time_limit_minutes int check (time_limit_minutes between 1 and 600),
  add column if not exists max_attempts       int check (max_attempts between 1 and 20),   -- empty = unlimited
  add column if not exists shuffle_questions  boolean not null default false,
  add column if not exists shuffle_options    boolean not null default false,
  add column if not exists show_answers       boolean not null default false,
  add column if not exists identity_mode      text not null default 'choose'
                                               check (identity_mode in ('choose', 'anonymous', 'named')),
  add column if not exists thank_you          text;

-- ---------------------------------------------------------------------
-- 2. Sections and question types (used by assessments and surveys)
-- ---------------------------------------------------------------------
create table if not exists public.form_sections (
  id          uuid primary key default gen_random_uuid(),
  step_id     uuid not null references public.program_steps(id) on delete cascade,
  position    int not null default 0,
  title       text,
  description text
);
create index if not exists form_sections_step_idx on public.form_sections (step_id, position);

alter table public.assessment_questions
  add column if not exists section_id  uuid references public.form_sections(id) on delete set null,
  add column if not exists qtype       text not null default 'single'
    check (qtype in ('single', 'multi', 'truefalse', 'short', 'rating', 'likert', 'nps', 'text', 'paragraph')),
  add column if not exists required    boolean not null default true,
  add column if not exists description text;

-- Correct answers: a list of choice numbers (0 = first), or accepted words for short answers
alter table public.assessment_answer_keys add column if not exists correct jsonb;
alter table public.assessment_answer_keys alter column correct_option drop not null;
update public.assessment_answer_keys
   set correct = jsonb_build_array(correct_option)
 where correct is null and correct_option is not null;

-- ---------------------------------------------------------------------
-- 3. Attempts: started → submitted (timer, order, per-question results)
-- ---------------------------------------------------------------------
alter table public.assessment_attempts
  alter column answers   drop not null,
  alter column score     drop not null,
  alter column max_score drop not null,
  alter column percent   drop not null,
  alter column passed    drop not null,
  alter column submitted_at drop not null,
  alter column submitted_at drop default;

alter table public.assessment_attempts
  add column if not exists status text not null default 'submitted'
    check (status in ('in_progress', 'submitted', 'expired', 'manual')),
  add column if not exists started_at       timestamptz,
  add column if not exists deadline_at      timestamptz,
  add column if not exists question_order   jsonb,
  add column if not exists results          jsonb,
  add column if not exists original_percent numeric,
  add column if not exists changed_by       uuid references public.profiles(id) on delete set null,
  add column if not exists change_reason    text;

-- ---------------------------------------------------------------------
-- 4. Survey responses (no link to the learner when anonymous)
-- ---------------------------------------------------------------------
create table if not exists public.survey_responses (
  id            uuid primary key default gen_random_uuid(),
  step_id       uuid not null references public.program_steps(id) on delete cascade,
  respondent_id uuid references public.profiles(id) on delete set null,   -- empty = anonymous
  answers       jsonb not null,
  submitted_at  timestamptz not null default now()
);
create index if not exists survey_responses_step_idx on public.survey_responses (step_id);

-- ---------------------------------------------------------------------
-- 5. Only Admin can change scores
-- ---------------------------------------------------------------------
create or replace function public.guard_scores() returns trigger
language plpgsql as $$
begin
  if current_user = 'authenticated' and not public.is_admin() then
    if tg_table_name = 'assessment_attempts' then
      raise exception 'Only Admin can add or change assessment scores.';
    end if;
    if tg_op = 'INSERT' and new.score is not null then
      raise exception 'Only Admin can add or change scores.';
    end if;
    if tg_op = 'UPDATE' and new.score is distinct from old.score then
      raise exception 'Only Admin can add or change scores.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_scores on public.step_progress;
create trigger guard_scores before insert or update on public.step_progress
  for each row execute function public.guard_scores();
drop trigger if exists guard_scores on public.assessment_attempts;
create trigger guard_scores before insert or update on public.assessment_attempts
  for each row execute function public.guard_scores();

-- ---------------------------------------------------------------------
-- 6. Learner actions
-- ---------------------------------------------------------------------

-- Start (or resume) an attempt: checks dates and attempts, fixes the question order
create or replace function public.start_assessment(p_step uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s       public.program_steps;
  v_enr   uuid;
  a       public.assessment_attempts;
  v_used  int;
  v_order jsonb;
  v_opts  jsonb := '{}'::jsonb;
  q       record;
  v_id    uuid;
  v_deadline timestamptz;
begin
  select * into s from public.program_steps where id = p_step and step_type = 'assessment';
  if not found then raise exception 'This is not an assessment.'; end if;
  if not public.step_is_open(p_step) then raise exception 'This assessment is not open yet.'; end if;
  if s.close_at is not null and now() > s.close_at then raise exception 'This assessment has closed.'; end if;
  v_enr := public.my_enrollment_id(s.program_id);

  if exists (select 1 from public.step_progress p
             where p.enrollment_id = v_enr and p.step_id = p_step and p.status = 'completed') then
    raise exception 'You have already passed this assessment.';
  end if;

  -- Resume an unfinished attempt while time remains
  select * into a from public.assessment_attempts
   where enrollment_id = v_enr and step_id = p_step and status = 'in_progress'
   order by started_at desc limit 1;
  if found then
    if a.deadline_at is null or now() <= a.deadline_at + interval '2 minutes' then
      return jsonb_build_object('attempt_id', a.id, 'deadline_at', a.deadline_at, 'order', a.question_order, 'resumed', true);
    end if;
    update public.assessment_attempts
       set status = 'expired', submitted_at = a.deadline_at, score = 0, percent = 0, passed = false
     where id = a.id;
  end if;

  select count(*) into v_used from public.assessment_attempts
   where enrollment_id = v_enr and step_id = p_step and status <> 'manual';
  if s.max_attempts is not null and v_used >= s.max_attempts then
    raise exception 'You have used all % attempt(s) for this assessment.', s.max_attempts;
  end if;

  -- Question order: sections in order; questions shuffled inside each section if asked
  select coalesce(jsonb_agg(x.id order by x.sec_pos, x.sort), '[]'::jsonb) into v_order
  from (
    select q2.id,
           coalesce(fs.position, -1) as sec_pos,
           case when s.shuffle_questions then random() else q2.position end as sort
    from public.assessment_questions q2
    left join public.form_sections fs on fs.id = q2.section_id
    where q2.step_id = p_step
  ) x;
  if jsonb_array_length(v_order) = 0 then raise exception 'This assessment has no questions yet.'; end if;

  if s.shuffle_options then
    for q in select id, options from public.assessment_questions
             where step_id = p_step and qtype in ('single', 'multi') loop
      v_opts := v_opts || jsonb_build_object(q.id::text,
        (select jsonb_agg(i order by random()) from generate_series(0, jsonb_array_length(q.options) - 1) i));
    end loop;
  end if;

  v_deadline := case when s.time_limit_minutes is not null then now() + make_interval(mins => s.time_limit_minutes) end;
  if s.close_at is not null and v_deadline is not null and v_deadline > s.close_at then v_deadline := s.close_at; end if;

  insert into public.assessment_attempts (enrollment_id, step_id, status, started_at, deadline_at, question_order)
  values (v_enr, p_step, 'in_progress', now(), v_deadline,
          jsonb_build_object('questions', v_order, 'options', v_opts))
  returning id into v_id;

  insert into public.step_progress (enrollment_id, step_id, status, started_at)
  values (v_enr, p_step, 'in_progress', now())
  on conflict (enrollment_id, step_id) do update
    set status = case when public.step_progress.status = 'completed' then 'completed' else 'in_progress' end,
        started_at = coalesce(public.step_progress.started_at, now());

  return jsonb_build_object('attempt_id', v_id, 'deadline_at', v_deadline,
                            'order', jsonb_build_object('questions', v_order, 'options', v_opts), 'resumed', false);
end $$;

-- Mark and save an attempt (answers never reach the browser before this)
drop function if exists public.submit_assessment(uuid, jsonb);
create or replace function public.submit_assessment(p_attempt uuid, p_answers jsonb, p_auto boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a        public.assessment_attempts;
  s        public.program_steps;
  q        record;
  v_ans    jsonb;
  v_key    jsonb;
  v_earned numeric;
  v_score  numeric := 0;
  v_max    numeric := 0;
  v_pct    numeric;
  v_passed boolean;
  v_results jsonb := '{}'::jsonb;
  v_keys   jsonb := '{}'::jsonb;
  v_missing int := 0;
begin
  select * into a from public.assessment_attempts where id = p_attempt;
  if not found or a.status <> 'in_progress'
     or a.enrollment_id not in (select e.id from public.enrollments e where e.learner_id = public.my_profile_id()) then
    raise exception 'This attempt is not open.';
  end if;
  select * into s from public.program_steps where id = a.step_id;

  if a.deadline_at is not null and now() > a.deadline_at + interval '2 minutes' then
    update public.assessment_attempts
       set status = 'expired', submitted_at = a.deadline_at, score = 0, percent = 0, passed = false
     where id = a.id;
    -- Not an error, so the expired attempt is saved
    return jsonb_build_object('expired', true, 'score', 0, 'max_score', null, 'percent', 0, 'passed', false);
  end if;

  for q in
    select aq.id, aq.qtype, aq.points, aq.required, k.correct
    from public.assessment_questions aq
    left join public.assessment_answer_keys k on k.question_id = aq.id
    where aq.step_id = a.step_id
  loop
    v_ans := p_answers -> q.id::text;
    v_key := coalesce(q.correct, '[]'::jsonb);
    v_earned := 0;
    if q.required and (v_ans is null or v_ans = 'null'::jsonb or v_ans = '""'::jsonb or v_ans = '[]'::jsonb) then
      v_missing := v_missing + 1;
    end if;

    if q.qtype in ('single', 'truefalse') then
      if v_ans is not null and jsonb_typeof(v_ans) = 'number' and v_key @> jsonb_build_array(v_ans) and jsonb_array_length(v_key) = 1 then
        v_earned := q.points;
      end if;
    elsif q.qtype = 'multi' then
      if v_ans is not null and jsonb_typeof(v_ans) = 'array'
         and v_ans @> v_key and v_key @> v_ans and jsonb_array_length(v_key) > 0 then
        v_earned := q.points;
      end if;
    elsif q.qtype = 'short' then
      if v_ans is not null and jsonb_typeof(v_ans) = 'string' and exists (
           select 1 from jsonb_array_elements_text(v_key) t
           where lower(btrim(t)) = lower(btrim(v_ans #>> '{}'))) then
        v_earned := q.points;
      end if;
    end if;

    v_max := v_max + q.points;
    v_score := v_score + v_earned;
    v_results := v_results || jsonb_build_object(q.id::text, v_earned);
    v_keys := v_keys || jsonb_build_object(q.id::text, v_key);
  end loop;

  if v_missing > 0 and not p_auto then
    raise exception 'Please answer all required questions (% left).', v_missing;
  end if;

  v_pct := case when v_max > 0 then round(v_score * 100 / v_max, 1) else 0 end;
  v_passed := s.passing_score is null or v_pct >= s.passing_score;

  update public.assessment_attempts
     set answers = p_answers, score = v_score, max_score = v_max, percent = v_pct, passed = v_passed,
         results = v_results, status = 'submitted', submitted_at = now()
   where id = a.id;

  insert into public.step_progress (enrollment_id, step_id, status, score, started_at, completed_at)
  values (a.enrollment_id, a.step_id, case when v_passed then 'completed' else 'in_progress' end, v_pct, a.started_at,
          case when v_passed then now() end)
  on conflict (enrollment_id, step_id) do update
    set score        = greatest(public.step_progress.score, excluded.score),
        status       = case when public.step_progress.status = 'completed' or v_passed then 'completed' else 'in_progress' end,
        completed_at = coalesce(public.step_progress.completed_at, excluded.completed_at);

  return jsonb_build_object('score', v_score, 'max_score', v_max, 'percent', v_pct, 'passed', v_passed,
                            'results', v_results, 'correct', case when s.show_answers then v_keys end);
end $$;

-- Built-in survey: one response per learner; the learner may stay anonymous
create or replace function public.submit_survey(p_step uuid, p_answers jsonb, p_share_name boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  s       public.program_steps;
  v_enr   uuid;
  v_missing int;
  v_who   uuid;
begin
  select * into s from public.program_steps where id = p_step and step_type = 'survey';
  if not found then raise exception 'This is not a survey.'; end if;
  if not public.step_is_open(p_step) then raise exception 'This survey is not open yet.'; end if;
  if s.close_at is not null and now() > s.close_at then raise exception 'This survey has closed.'; end if;
  v_enr := public.my_enrollment_id(s.program_id);
  if exists (select 1 from public.step_progress p
             where p.enrollment_id = v_enr and p.step_id = p_step and p.status = 'completed') then
    raise exception 'You have already answered this survey. Thank you!';
  end if;

  select count(*) into v_missing from public.assessment_questions q
   where q.step_id = p_step and q.required
     and (p_answers -> q.id::text is null or p_answers -> q.id::text in ('null'::jsonb, '""'::jsonb, '[]'::jsonb));
  if v_missing > 0 then raise exception 'Please answer all required questions (% left).', v_missing; end if;

  v_who := case s.identity_mode
             when 'anonymous' then null
             when 'named' then public.my_profile_id()
             else case when p_share_name then public.my_profile_id() end
           end;
  insert into public.survey_responses (step_id, respondent_id, answers) values (p_step, v_who, p_answers);

  insert into public.step_progress (enrollment_id, step_id, status, started_at, completed_at)
  values (v_enr, p_step, 'completed', now(), now())
  on conflict (enrollment_id, step_id) do update
    set status = 'completed', completed_at = coalesce(public.step_progress.completed_at, now());
end $$;

-- External surveys keep "I've completed it"; built-in ones must be answered in the Companion
create or replace function public.complete_step(p_step uuid, p_score numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_enr  uuid;
  v_type text;
begin
  select s.step_type, public.my_enrollment_id(s.program_id) into v_type, v_enr
  from public.program_steps s where s.id = p_step;

  if v_type not in ('module', 'survey') then
    raise exception 'This step is completed by L&D or by an upload, not here.';
  end if;
  if v_type = 'survey' and exists (select 1 from public.assessment_questions q where q.step_id = p_step) then
    raise exception 'Please answer this survey in the Learning Companion.';
  end if;
  if not public.step_is_open(p_step) then raise exception 'This step is not open yet.'; end if;

  insert into public.step_progress (enrollment_id, step_id, status, score, started_at, completed_at)
  values (v_enr, p_step, 'completed', p_score, now(), now())
  on conflict (enrollment_id, step_id) do update
    set status       = 'completed',
        score        = greatest(public.step_progress.score, excluded.score),
        completed_at = coalesce(public.step_progress.completed_at, now());
end $$;

-- ---------------------------------------------------------------------
-- 7. Admin: change a score, or enter one (e.g. a paper assessment)
-- ---------------------------------------------------------------------
create or replace function public.admin_set_score(
  p_step uuid, p_enrollment uuid, p_attempt uuid, p_percent numeric, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  s        public.program_steps;
  a        public.assessment_attempts;
  v_best   numeric;
  v_passed boolean;
begin
  if not public.is_admin() then raise exception 'Only Admin can change scores.'; end if;
  if p_percent is null or p_percent < 0 or p_percent > 100 then raise exception 'Enter a score from 0 to 100.'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Please give a reason for the change.'; end if;
  select * into s from public.program_steps where id = p_step and step_type = 'assessment';
  if not found then raise exception 'This is not an assessment.'; end if;
  if not exists (select 1 from public.enrollments e where e.id = p_enrollment and e.program_id = s.program_id) then
    raise exception 'This learner is not enrolled in the program.';
  end if;

  if p_attempt is null then
    insert into public.assessment_attempts
      (enrollment_id, step_id, status, started_at, submitted_at, score, max_score, percent, passed, changed_by, change_reason)
    values (p_enrollment, p_step, 'manual', now(), now(), p_percent, 100, p_percent,
            s.passing_score is null or p_percent >= s.passing_score, public.my_profile_id(), btrim(p_reason));
  else
    select * into a from public.assessment_attempts where id = p_attempt and step_id = p_step and enrollment_id = p_enrollment;
    if not found then raise exception 'Attempt not found.'; end if;
    update public.assessment_attempts
       set original_percent = coalesce(original_percent, percent),
           percent = p_percent,
           score = case when coalesce(max_score, 0) > 0 then round(p_percent * max_score / 100, 2) else p_percent end,
           max_score = coalesce(max_score, 100),
           passed = s.passing_score is null or p_percent >= s.passing_score,
           status = case when status in ('in_progress', 'expired') then 'manual' else status end,
           submitted_at = coalesce(submitted_at, now()),
           changed_by = public.my_profile_id(),
           change_reason = btrim(p_reason)
     where id = p_attempt;
  end if;

  -- The learner's result for the step = their best attempt
  select max(percent), bool_or(passed) into v_best, v_passed
  from public.assessment_attempts
  where enrollment_id = p_enrollment and step_id = p_step and status in ('submitted', 'manual', 'expired');

  insert into public.step_progress (enrollment_id, step_id, status, score, started_at, completed_at)
  values (p_enrollment, p_step, case when v_passed then 'completed' else 'in_progress' end, v_best, now(),
          case when v_passed then now() end)
  on conflict (enrollment_id, step_id) do update
    set score = v_best,
        status = case when v_passed then 'completed' else 'in_progress' end,
        completed_at = case when v_passed then coalesce(public.step_progress.completed_at, now()) end;

  insert into public.activity_log (actor_id, action, entity_type, entity_id, details)
  values (public.my_profile_id(), 'change_score', 'assessment', p_step,
          jsonb_build_object('enrollment_id', p_enrollment, 'attempt_id', p_attempt, 'percent', p_percent, 'reason', btrim(p_reason)));
end $$;

-- ---------------------------------------------------------------------
-- 8. Security rules and access
-- ---------------------------------------------------------------------
alter table public.form_sections    enable row level security;
alter table public.survey_responses enable row level security;

drop policy if exists "read sections" on public.form_sections;
create policy "read sections" on public.form_sections for select to authenticated
  using (public.is_staff() or public.step_is_open(step_id));
drop policy if exists "staff manage sections" on public.form_sections;
create policy "staff manage sections" on public.form_sections for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists "read responses" on public.survey_responses;
create policy "read responses" on public.survey_responses for select to authenticated
  using (public.is_staff() or respondent_id = public.my_profile_id());
drop policy if exists "admin removes responses" on public.survey_responses;
create policy "admin removes responses" on public.survey_responses for delete to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.form_sections, public.survey_responses to authenticated;
grant all on public.form_sections, public.survey_responses to service_role;

revoke execute on function public.start_assessment(uuid) from public, anon;
revoke execute on function public.submit_assessment(uuid, jsonb, boolean) from public, anon;
revoke execute on function public.submit_survey(uuid, jsonb, boolean) from public, anon;
revoke execute on function public.admin_set_score(uuid, uuid, uuid, numeric, text) from public, anon;
grant execute on function
  public.start_assessment(uuid), public.submit_assessment(uuid, jsonb, boolean),
  public.submit_survey(uuid, jsonb, boolean), public.admin_set_score(uuid, uuid, uuid, numeric, text),
  public.complete_step(uuid, numeric)
to authenticated;
