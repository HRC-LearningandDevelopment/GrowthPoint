-- =====================================================================
-- L&D Learning Portal — database setup
-- Run ONCE in Supabase: SQL Editor → New query → paste all → Run.
-- If anything fails, nothing is saved — fix and run again.
--
-- BEFORE RUNNING: scroll to the very bottom (section 10) and put in
-- your own name and email so you become the first Admin.
-- =====================================================================


-- =====================================================================
-- 1. PEOPLE
-- Everyone who can use the portal. L&D/Admin add people here first;
-- they can only sign in once they are on this list.
-- =====================================================================
create table public.profiles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique references auth.users(id) on delete set null,  -- filled in automatically on first sign-in
  email       text not null,
  full_name   text not null,
  role        text not null default 'learner' check (role in ('admin', 'ld', 'learner')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (lower(email));


-- Who is signed in right now (used by every security rule below)
create or replace function public.my_profile_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.profiles p where p.user_id = auth.uid() and p.is_active
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role in ('admin', 'ld') from public.profiles p
                   where p.user_id = auth.uid() and p.is_active), false)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role = 'admin' from public.profiles p
                   where p.user_id = auth.uid() and p.is_active), false)
$$;

create or replace function public.try_uuid(p_text text) returns uuid
language plpgsql immutable as $$
begin
  return p_text::uuid;
exception when others then
  return null;
end $$;


-- =====================================================================
-- 2. PROGRAMS AND THEIR LEARNING JOURNEY
-- =====================================================================
create table public.programs (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  program_type       text not null check (program_type in ('self_paced', 'ilt', 'blended')),
  audience           text,
  objectives         text,
  overview           text,
  welcome_message    text,
  welcome_video_path text,          -- optional; if set, learners must watch it before continuing
  required_reading   text,          -- e.g. how to submit certificates and workbooks
  status             text not null default 'draft'
                     check (status in ('draft', 'scheduled', 'live', 'on_hold', 'completed', 'archived')),
  start_date         date,
  due_date           date,
  owner_id           uuid references public.profiles(id) on delete set null,
  created_by         uuid references public.profiles(id) on delete set null default public.my_profile_id(),
  files_purged_at    timestamptz,   -- set when Close & Archive deletes the PDFs and video
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Each step in the learning journey, in order
create table public.program_steps (
  id            uuid primary key default gen_random_uuid(),
  program_id    uuid not null references public.programs(id) on delete cascade,
  position      int not null default 0,
  step_type     text not null check (step_type in ('module', 'ilt_session', 'assessment', 'survey', 'upload')),
  title         text not null,
  description   text,
  session_start timestamptz,        -- ILT sessions: shown to learners even before the link unlocks
  session_end   timestamptz,
  unlock_at     timestamptz,        -- the link / module only becomes available from this moment
  due_at        timestamptz,
  is_required   boolean not null default true,
  passing_score numeric check (passing_score between 0 and 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index program_steps_program_idx on public.program_steps (program_id, position);

-- Links kept apart from the steps so learners cannot see them before unlock_at
create table public.step_links (
  step_id    uuid primary key references public.program_steps(id) on delete cascade,
  url        text not null,
  updated_at timestamptz not null default now()
);


-- =====================================================================
-- 3. ENROLMENTS AND PROGRESS
-- =====================================================================
create table public.enrollments (
  id                      uuid primary key default gen_random_uuid(),
  program_id              uuid not null references public.programs(id) on delete cascade,
  learner_id              uuid not null references public.profiles(id) on delete cascade,
  due_date_override       date,     -- individual deadline extension
  welcome_watched_seconds numeric not null default 0,
  welcome_completed_at    timestamptz,
  reading_ack_at          timestamptz,
  enrolled_at             timestamptz not null default now(),
  unique (program_id, learner_id)
);
create index enrollments_learner_idx on public.enrollments (learner_id);

create table public.step_progress (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  step_id       uuid not null references public.program_steps(id) on delete cascade,
  status        text not null default 'not_started'
                check (status in ('not_started', 'in_progress', 'submitted', 'completed', 'rejected')),
  score         numeric,
  started_at    timestamptz,
  completed_at  timestamptz,
  updated_at    timestamptz not null default now(),
  unique (enrollment_id, step_id)
);

-- Certificates and workbooks. Only count once L&D approves them.
create table public.uploads (
  id             uuid primary key default gen_random_uuid(),
  enrollment_id  uuid not null references public.enrollments(id) on delete cascade,
  step_id        uuid not null references public.program_steps(id) on delete cascade,
  file_path      text not null unique,
  file_name      text not null,
  size_bytes     bigint,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  review_comment text,
  reviewed_by    uuid references public.profiles(id) on delete set null,
  reviewed_at    timestamptz,
  uploaded_at    timestamptz not null default now()
);
create index uploads_status_idx on public.uploads (status);


-- =====================================================================
-- 4. ASSESSMENTS BUILT IN THE PORTAL (for ILT)
-- =====================================================================
create table public.assessment_questions (
  id       uuid primary key default gen_random_uuid(),
  step_id  uuid not null references public.program_steps(id) on delete cascade,
  position int not null default 0,
  question text not null,
  options  jsonb not null default '[]'::jsonb,   -- list of answer choices
  points   numeric not null default 1
);

-- Correct answers live in their own table so learners can never read them
create table public.assessment_answer_keys (
  question_id    uuid primary key references public.assessment_questions(id) on delete cascade,
  correct_option int not null                  -- 0 = first choice, 1 = second, ...
);

create table public.assessment_attempts (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  step_id       uuid not null references public.program_steps(id) on delete cascade,
  answers       jsonb not null,
  score         numeric not null,
  max_score     numeric not null,
  percent       numeric not null,
  passed        boolean not null,
  submitted_at  timestamptz not null default now()
);


-- =====================================================================
-- 5. MESSAGES TO L&D, AND THE ACTIVITY LOG
-- =====================================================================
create table public.message_threads (
  id         uuid primary key default gen_random_uuid(),
  program_id uuid references public.programs(id) on delete set null,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  subject    text not null,
  status     text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.thread_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.message_threads(id) on delete cascade,
  author_id  uuid references public.profiles(id) on delete set null default public.my_profile_id(),
  body       text not null,
  created_at timestamptz not null default now()
);

create table public.activity_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index activity_log_created_idx on public.activity_log (created_at desc);


-- =====================================================================
-- 6. MORE HELPERS (need the tables above)
-- =====================================================================
create or replace function public.my_enrollment_id(p_program uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select e.id from public.enrollments e
  where e.program_id = p_program and e.learner_id = public.my_profile_id()
$$;

-- Staff see every program; learners see programs they are enrolled in (not drafts)
create or replace function public.can_see_program(p_program uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() or exists (
    select 1 from public.enrollments e
    join public.programs p on p.id = e.program_id
    where e.program_id = p_program
      and e.learner_id = public.my_profile_id()
      and p.status <> 'draft')
$$;

-- A step is open to a learner when: enrolled, program is Live, the unlock
-- date has arrived, and they have watched the welcome video (if any)
-- and acknowledged the required reading (if any).
create or replace function public.step_is_open(p_step uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.program_steps s
    join public.programs p on p.id = s.program_id
    join public.enrollments e on e.program_id = p.id and e.learner_id = public.my_profile_id()
    where s.id = p_step
      and p.status = 'live'
      and (s.unlock_at is null or s.unlock_at <= now())
      and (p.welcome_video_path is null or e.welcome_completed_at is not null)
      and (coalesce(p.required_reading, '') = '' or e.reading_ack_at is not null))
$$;


-- =====================================================================
-- 7. AUTOMATIC BEHAVIOUR (triggers)
-- =====================================================================

-- Keep updated_at current
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger touch before update on public.profiles        for each row execute function public.touch_updated_at();
create trigger touch before update on public.programs        for each row execute function public.touch_updated_at();
create trigger touch before update on public.program_steps   for each row execute function public.touch_updated_at();
create trigger touch before update on public.step_links      for each row execute function public.touch_updated_at();
create trigger touch before update on public.step_progress   for each row execute function public.touch_updated_at();
create trigger touch before update on public.message_threads for each row execute function public.touch_updated_at();

-- Nobody can attach a profile to someone else's login from the portal
-- (only the sign-in linking below can). Changing a person's email unlinks
-- the old login; the new email links on next sign-in.
create or replace function public.guard_profile() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.user_id := null;
    elsif lower(new.email) <> lower(old.email) then
      new.user_id := null;
    else
      new.user_id := old.user_id;
    end if;
  elsif tg_op = 'UPDATE' and lower(new.email) <> lower(old.email) then
    new.user_id := null;
  end if;
  return new;
end $$;
create trigger guard before insert or update on public.profiles
  for each row execute function public.guard_profile();

-- When someone signs in for the first time, link their login to their profile
create or replace function public.link_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set user_id = new.id
  where lower(email) = lower(new.email) and user_id is null;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.link_auth_user();

-- Learner uploads: always start as Pending; L&D review sets who/when
create or replace function public.guard_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.review_comment := null;
  elsif new.status is distinct from old.status then
    new.reviewed_by := public.my_profile_id();
    new.reviewed_at := now();
  end if;
  return new;
end $$;
create trigger guard before insert or update on public.uploads
  for each row execute function public.guard_upload();

-- Upload submitted → step "Submitted"; approved → "Completed"; rejected → "Rejected"
create or replace function public.sync_upload_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  if exists (select 1 from public.uploads u
             where u.enrollment_id = new.enrollment_id and u.step_id = new.step_id and u.status = 'approved') then
    v_status := 'completed';
  elsif exists (select 1 from public.uploads u
                where u.enrollment_id = new.enrollment_id and u.step_id = new.step_id and u.status = 'pending') then
    v_status := 'submitted';
  else
    v_status := 'rejected';
  end if;

  insert into public.step_progress (enrollment_id, step_id, status, started_at, completed_at)
  values (new.enrollment_id, new.step_id, v_status, now(),
          case when v_status = 'completed' then now() end)
  on conflict (enrollment_id, step_id) do update
    set status       = excluded.status,
        completed_at = case when excluded.status = 'completed'
                            then coalesce(public.step_progress.completed_at, now()) end;
  return null;
end $$;
create trigger sync_progress after insert or update of status on public.uploads
  for each row execute function public.sync_upload_progress();

-- A learner reply re-opens a resolved thread
create or replace function public.bump_thread() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.message_threads t
     set updated_at = now(),
         status = case when t.learner_id = new.author_id then 'open' else t.status end
   where t.id = new.thread_id;
  return null;
end $$;
create trigger bump after insert on public.thread_messages
  for each row execute function public.bump_thread();

-- Activity log: who created / changed / deleted what, and when
create or replace function public.log_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.activity_log (actor_id, action, entity_type, entity_id, details)
  values (public.my_profile_id(),
          lower(tg_op),
          tg_table_name,
          public.try_uuid(coalesce(v_row ->> 'id', v_row ->> 'step_id')),
          case when tg_op = 'UPDATE' then jsonb_build_object('before', to_jsonb(old), 'after', v_row)
               else v_row end);
  return null;
end $$;

create trigger log after insert or update or delete on public.profiles      for each row execute function public.log_activity();
create trigger log after insert or update or delete on public.programs      for each row execute function public.log_activity();
create trigger log after insert or update or delete on public.program_steps for each row execute function public.log_activity();
create trigger log after insert or update or delete on public.step_links    for each row execute function public.log_activity();
create trigger log after insert or update or delete on public.enrollments   for each row execute function public.log_activity();
create trigger log after update or delete on public.uploads                 for each row execute function public.log_activity();


-- =====================================================================
-- 8. ACTIONS THE PORTAL CALLS FOR LEARNERS
-- (learners never write progress directly; these check the rules first)
-- =====================================================================

-- After sign-in: link this login to the matching invited profile (covers re-invited people)
create or replace function public.claim_profile() returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set user_id = auth.uid()
  where lower(email) = lower(auth.jwt() ->> 'email') and user_id is null and is_active;
  return public.my_profile_id();
end $$;

-- Welcome video: records the furthest point watched; completes at 95%
create or replace function public.record_video_progress(p_program uuid, p_seconds numeric, p_duration numeric)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_enr uuid := public.my_enrollment_id(p_program);
  v_done boolean;
begin
  if v_enr is null then raise exception 'You are not enrolled in this program.'; end if;

  update public.enrollments
     set welcome_watched_seconds = greatest(welcome_watched_seconds, p_seconds),
         welcome_completed_at = coalesce(welcome_completed_at,
           case when p_duration > 0 and p_seconds >= p_duration * 0.95 then now() end)
   where id = v_enr
  returning welcome_completed_at is not null into v_done;
  return v_done;
end $$;

-- Required reading: "I have read this"
create or replace function public.acknowledge_reading(p_program uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_enr uuid := public.my_enrollment_id(p_program);
begin
  if v_enr is null then raise exception 'You are not enrolled in this program.'; end if;
  update public.enrollments set reading_ack_at = coalesce(reading_ack_at, now()) where id = v_enr;
end $$;

-- Learner opened a step → "In progress"
create or replace function public.start_step(p_step uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_enr uuid;
begin
  if not public.step_is_open(p_step) then raise exception 'This step is not open yet.'; end if;
  select public.my_enrollment_id(s.program_id) into v_enr from public.program_steps s where s.id = p_step;

  insert into public.step_progress (enrollment_id, step_id, status, started_at)
  values (v_enr, p_step, 'in_progress', now())
  on conflict (enrollment_id, step_id) do update
    set status = 'in_progress', started_at = coalesce(public.step_progress.started_at, now())
    where public.step_progress.status = 'not_started';
end $$;

-- Self-paced module finished (sent by the module) or survey done
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
  if not public.step_is_open(p_step) then raise exception 'This step is not open yet.'; end if;

  insert into public.step_progress (enrollment_id, step_id, status, score, started_at, completed_at)
  values (v_enr, p_step, 'completed', p_score, now(), now())
  on conflict (enrollment_id, step_id) do update
    set status       = 'completed',
        score        = greatest(public.step_progress.score, excluded.score),
        completed_at = coalesce(public.step_progress.completed_at, now());
end $$;

-- Portal-built assessment: scored here so answers never reach the browser
create or replace function public.submit_assessment(p_step uuid, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prog   uuid;
  v_pass   numeric;
  v_enr    uuid;
  v_score  numeric := 0;
  v_max    numeric := 0;
  v_pct    numeric;
  v_passed boolean;
  q        record;
begin
  select s.program_id, s.passing_score into v_prog, v_pass
  from public.program_steps s where s.id = p_step and s.step_type = 'assessment';
  if v_prog is null then raise exception 'This is not an assessment.'; end if;
  if not public.step_is_open(p_step) then raise exception 'This assessment is not open yet.'; end if;
  v_enr := public.my_enrollment_id(v_prog);

  for q in
    select aq.id, aq.points, k.correct_option
    from public.assessment_questions aq
    join public.assessment_answer_keys k on k.question_id = aq.id
    where aq.step_id = p_step
  loop
    v_max := v_max + q.points;
    if p_answers ->> q.id::text = q.correct_option::text then
      v_score := v_score + q.points;
    end if;
  end loop;

  v_pct    := case when v_max > 0 then round(v_score * 100 / v_max, 1) else 0 end;
  v_passed := v_pass is null or v_pct >= v_pass;

  insert into public.assessment_attempts (enrollment_id, step_id, answers, score, max_score, percent, passed)
  values (v_enr, p_step, p_answers, v_score, v_max, v_pct, v_passed);

  insert into public.step_progress (enrollment_id, step_id, status, score, started_at, completed_at)
  values (v_enr, p_step, case when v_passed then 'completed' else 'in_progress' end, v_pct, now(),
          case when v_passed then now() end)
  on conflict (enrollment_id, step_id) do update
    set score        = greatest(public.step_progress.score, excluded.score),
        status       = case when public.step_progress.status = 'completed' or v_passed
                            then 'completed' else 'in_progress' end,
        completed_at = coalesce(public.step_progress.completed_at, excluded.completed_at);

  return jsonb_build_object('score', v_score, 'max_score', v_max, 'percent', v_pct, 'passed', v_passed);
end $$;


-- Progress summary per learner per program (used by both dashboards)
create view public.v_enrollment_progress with (security_invoker = true) as
select
  e.id         as enrollment_id,
  e.program_id,
  e.learner_id,
  coalesce(e.due_date_override, p.due_date) as due_date,
  count(s.id) filter (where s.is_required)                            as required_steps,
  count(s.id) filter (where s.is_required and sp.status = 'completed') as completed_steps,
  case when count(s.id) filter (where s.is_required) = 0 then 0
       else round(100.0 * count(s.id) filter (where s.is_required and sp.status = 'completed')
                         / count(s.id) filter (where s.is_required), 1)
  end as percent_complete,
  greatest(e.enrolled_at, max(sp.updated_at)) as last_activity
from public.enrollments e
join public.programs p on p.id = e.program_id
left join public.program_steps s  on s.program_id = e.program_id
left join public.step_progress sp on sp.enrollment_id = e.id and sp.step_id = s.id
group by e.id, p.id;


-- =====================================================================
-- 8b. INVITE-ONLY SIGN-IN
-- Supabase calls this before creating a new login. Emails that are not
-- on the People list are turned away. (Switched on in a later step.)
-- =====================================================================
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles p
             where lower(p.email) = lower(event -> 'user' ->> 'email') and p.is_active) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This email has not been invited to the L&D Learning Portal. Please contact the L&D team.'));
end $$;


-- =====================================================================
-- 9. SECURITY RULES (who can see and change what)
-- =====================================================================
alter table public.profiles               enable row level security;
alter table public.programs               enable row level security;
alter table public.program_steps          enable row level security;
alter table public.step_links             enable row level security;
alter table public.enrollments            enable row level security;
alter table public.step_progress          enable row level security;
alter table public.uploads                enable row level security;
alter table public.assessment_questions   enable row level security;
alter table public.assessment_answer_keys enable row level security;
alter table public.assessment_attempts    enable row level security;
alter table public.message_threads        enable row level security;
alter table public.thread_messages        enable row level security;
alter table public.activity_log           enable row level security;

-- People: you see yourself and the L&D team; staff see everyone.
-- L&D can add/edit learners only; Admin can do anything.
create policy "read people" on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_staff() or role in ('admin', 'ld'));
create policy "add people" on public.profiles for insert to authenticated
  with check (public.is_admin() or (public.is_staff() and role = 'learner'));
create policy "edit people" on public.profiles for update to authenticated
  using      (public.is_admin() or (public.is_staff() and role = 'learner'))
  with check (public.is_admin() or (public.is_staff() and role = 'learner'));
create policy "remove people" on public.profiles for delete to authenticated
  using (public.is_admin());

-- Programs: staff manage; only drafts can be deleted (Admin can delete anything)
create policy "read programs" on public.programs for select to authenticated
  using (public.can_see_program(id));
create policy "add programs" on public.programs for insert to authenticated
  with check (public.is_staff());
create policy "edit programs" on public.programs for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy "delete programs" on public.programs for delete to authenticated
  using (public.is_admin() or (public.is_staff() and status = 'draft'));

-- Steps
create policy "read steps" on public.program_steps for select to authenticated
  using (public.can_see_program(program_id));
create policy "staff manage steps" on public.program_steps for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Links: learners only once the step is open
create policy "read links" on public.step_links for select to authenticated
  using (public.is_staff() or public.step_is_open(step_id));
create policy "staff manage links" on public.step_links for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Enrolments
create policy "read enrollments" on public.enrollments for select to authenticated
  using (public.is_staff() or learner_id = public.my_profile_id());
create policy "staff manage enrollments" on public.enrollments for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Progress (learners change it only through the actions in section 8)
create policy "read progress" on public.step_progress for select to authenticated
  using (public.is_staff() or exists (select 1 from public.enrollments e
         where e.id = enrollment_id and e.learner_id = public.my_profile_id()));
create policy "staff manage progress" on public.step_progress for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Uploads: learners add their own to an open Upload step; staff review
create policy "read uploads" on public.uploads for select to authenticated
  using (public.is_staff() or exists (select 1 from public.enrollments e
         where e.id = enrollment_id and e.learner_id = public.my_profile_id()));
create policy "learners upload" on public.uploads for insert to authenticated
  with check (
    exists (select 1 from public.enrollments e
            where e.id = enrollment_id and e.learner_id = public.my_profile_id())
    and exists (select 1 from public.program_steps s
                where s.id = step_id and s.step_type = 'upload')
    and public.step_is_open(step_id));
create policy "staff manage uploads" on public.uploads for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Assessment questions (never the answers) once the step is open
create policy "read questions" on public.assessment_questions for select to authenticated
  using (public.is_staff() or public.step_is_open(step_id));
create policy "staff manage questions" on public.assessment_questions for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy "staff manage answer keys" on public.assessment_answer_keys for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy "read attempts" on public.assessment_attempts for select to authenticated
  using (public.is_staff() or exists (select 1 from public.enrollments e
         where e.id = enrollment_id and e.learner_id = public.my_profile_id()));
create policy "staff manage attempts" on public.assessment_attempts for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Messages
create policy "read threads" on public.message_threads for select to authenticated
  using (public.is_staff() or learner_id = public.my_profile_id());
create policy "learners start threads" on public.message_threads for insert to authenticated
  with check (learner_id = public.my_profile_id() and status = 'open'
              and (program_id is null or public.my_enrollment_id(program_id) is not null));
create policy "staff manage threads" on public.message_threads for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy "read messages" on public.thread_messages for select to authenticated
  using (exists (select 1 from public.message_threads t
                 where t.id = thread_id and (public.is_staff() or t.learner_id = public.my_profile_id())));
create policy "write messages" on public.thread_messages for insert to authenticated
  with check (author_id = public.my_profile_id()
              and exists (select 1 from public.message_threads t
                          where t.id = thread_id and (public.is_staff() or t.learner_id = public.my_profile_id())));
create policy "admin removes messages" on public.thread_messages for delete to authenticated
  using (public.is_admin());

-- Activity log: staff can read; nobody can edit or delete it
create policy "staff read log" on public.activity_log for select to authenticated
  using (public.is_staff());


-- Table and function access (logged-in users only; the rules above do the filtering)
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.my_profile_id(), public.is_staff(), public.is_admin(), public.try_uuid(text),
  public.my_enrollment_id(uuid), public.can_see_program(uuid), public.step_is_open(uuid),
  public.claim_profile(), public.record_video_progress(uuid, numeric, numeric),
  public.acknowledge_reading(uuid), public.start_step(uuid), public.complete_step(uuid, numeric),
  public.submit_assessment(uuid, jsonb)
to authenticated;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from authenticated;


-- =====================================================================
-- 9b. FILE STORAGE (private)
-- welcome-videos/<program id>/<file>                 max 50 MB
-- learner-uploads/<enrolment id>/<step id>/<file>    PDF only, max 5 MB
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('welcome-videos',  'welcome-videos',  false, 52428800, array['video/mp4', 'video/webm', 'video/quicktime']),
  ('learner-uploads', 'learner-uploads', false, 5242880,  array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "staff manage videos" on storage.objects for all to authenticated
  using      (bucket_id = 'welcome-videos' and public.is_staff())
  with check (bucket_id = 'welcome-videos' and public.is_staff());
create policy "learners watch videos" on storage.objects for select to authenticated
  using (bucket_id = 'welcome-videos'
         and public.can_see_program(public.try_uuid((storage.foldername(name))[1])));

create policy "staff manage learner files" on storage.objects for all to authenticated
  using      (bucket_id = 'learner-uploads' and public.is_staff())
  with check (bucket_id = 'learner-uploads' and public.is_staff());
create policy "learners read own files" on storage.objects for select to authenticated
  using (bucket_id = 'learner-uploads'
         and exists (select 1 from public.enrollments e
                     where e.id = public.try_uuid((storage.foldername(name))[1])
                       and e.learner_id = public.my_profile_id()));
create policy "learners add own files" on storage.objects for insert to authenticated
  with check (bucket_id = 'learner-uploads'
              and exists (select 1 from public.enrollments e
                          where e.id = public.try_uuid((storage.foldername(name))[1])
                            and e.learner_id = public.my_profile_id())
              and public.step_is_open(public.try_uuid((storage.foldername(name))[2])));
create policy "learners replace rejected files" on storage.objects for delete to authenticated
  using (bucket_id = 'learner-uploads'
         and exists (select 1 from public.enrollments e
                     where e.id = public.try_uuid((storage.foldername(name))[1])
                       and e.learner_id = public.my_profile_id())
         and not exists (select 1 from public.uploads u
                         where u.file_path = name and u.status <> 'rejected'));


-- =====================================================================
-- 10. FIRST ADMIN — EDIT THIS LINE BEFORE RUNNING
-- Use the SAME email you signed up to Supabase with (until we set up the
-- L&D email sender, Supabase only sends sign-in codes to that address).
-- =====================================================================
insert into public.profiles (email, full_name, role)
values ('jsan8574@gmail.com', 'L&D Admin', 'admin');
