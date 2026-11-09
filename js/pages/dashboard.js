// L&D Dashboard: overall, by program, by learner and by step, for a chosen period,
// with Excel and PDF exports of exactly what's on screen.
import { sb } from "../supabase.js";
import {
  esc, toast, icons, fmtDate, statusPill, PROGRAM_TYPE, PROGRAM_STATUS, STEP_TYPE,
  LIBS, loadScript, safeName,
} from "../ui.js";

const PERIODS = { week: "This Week", month: "This Month", quarter: "This Quarter", year: "This Year", all: "All Time" };
const filters = { period: "month", program: "", type: "", market: "", department: "", designation: "", manager: "", view: "programs", q: "", groupBy: "program" };
// Learner details the dashboard can group and filter by
const GROUPS = { department: "Department", designation: "Designation", market: "Market", manager: "Reporting Manager" };
const ALL_LABEL = { department: "All Departments", designation: "All Designations", market: "All Markets", manager: "All Managers" };
const NOT_SET = "Not Set";
const peopleFiltered = () => Object.keys(GROUPS).some((k) => filters[k]);
const DAY = 86400000;
const today = () => new Date().toLocaleDateString("en-CA"); // 2026-11-04, local time

// ---------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------
// Supabase returns at most 1,000 rows per request, so read in pages
async function all(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function loadData() {
  const [programs, enrollments, progress, steps, stepProgress, attempts, uploads, threads, exclusions, responses, scaleQs] = await Promise.all([
    all(() => sb.from("programs").select("id, title, program_type, status, start_date, due_date, owner:profiles!programs_owner_id_fkey(full_name)").order("title")),
    all(() => sb.from("enrollments").select("id, program_id, learner_id, due_date_override, enrolled_at, learner:profiles(full_name, email, is_active, department, designation, market, manager)")),
    all(() => sb.from("v_enrollment_progress").select("*")),
    all(() => sb.from("program_steps").select("id, program_id, position, step_type, title, is_required, passing_score").order("position")),
    all(() => sb.from("step_progress").select("enrollment_id, step_id, status, score, started_at, completed_at")),
    all(() => sb.from("assessment_attempts").select("enrollment_id, step_id, status, score, max_score, percent, passed, submitted_at")),
    all(() => sb.from("uploads").select("enrollment_id, step_id, file_name, status, uploaded_at, reviewed_at, review_comment, reviewer:profiles!uploads_reviewed_by_fkey(full_name)")),
    all(() => sb.from("message_threads").select("id, program_id, status")),
    all(() => sb.from("enrollment_exclusions").select("enrollment_id, step_id")),
    all(() => sb.from("survey_responses").select("step_id, respondent_id, answers, submitted_at")),
    all(() => sb.from("assessment_questions").select("id, step_id, qtype").in("qtype", ["rating", "likert", "nps"])),
  ]);
  return { programs, enrollments, progress, steps, stepProgress, attempts, uploads, threads, exclusions, responses, scaleQs };
}

function periodStart(key) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (key === "week") {
    const d = new Date(y, m, now.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    return d;
  }
  if (key === "month") return new Date(y, m, 1);
  if (key === "quarter") return new Date(y, Math.floor(m / 3) * 3, 1);
  if (key === "year") return new Date(y, 0, 1);
  return null;
}

// Survey answers → average star rating (1–5), recommendation score (NPS, −100..100), % who agree
function feedbackOf(responses, scaleQs) {
  const ratings = [];
  const nps = [];
  const likert = [];
  for (const r of responses) {
    for (const q of scaleQs) {
      if (q.step_id !== r.step_id) continue;
      const v = r.answers?.[q.id];
      if (v == null || v === "") continue;
      if (q.qtype === "rating") ratings.push(Number(v));
      if (q.qtype === "nps") nps.push(Number(v));
      if (q.qtype === "likert") likert.push(Number(v));
    }
  }
  return {
    responses: responses.length,
    rating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
    nps: nps.length ? Math.round(((nps.filter((v) => v >= 9).length - nps.filter((v) => v <= 6).length) / nps.length) * 100) : null,
    agree: likert.length ? Math.round((likert.filter((v) => v >= 3).length / likert.length) * 100) : null,
  };
}
const fmtNps = (n) => (n == null ? "–" : `${n > 0 ? "+" : ""}${n}`);
const fmtRating = (r) => (r == null ? "–" : `${r} / 5`);

// Everything the screen, the Excel file and the PDF show, worked out once
function compute(d) {
  const start = periodStart(filters.period);
  const inPeriod = (v) => v && (!start || new Date(v) >= start);
  const today = new Date(new Date().toDateString());

  const programs = d.programs.filter((p) =>
    (filters.program ? p.id === filters.program : p.status !== "archived") &&
    (!filters.type || p.program_type === filters.type));
  const programById = Object.fromEntries(programs.map((p) => [p.id, p]));
  const matches = (e) => Object.keys(GROUPS).every((k) => !filters[k] || (e.learner[k] || NOT_SET) === filters[k]);
  const enrollments = d.enrollments.filter((e) => programById[e.program_id] && matches(e));
  const enrollmentById = Object.fromEntries(enrollments.map((e) => [e.id, e]));
  const pctByEnrollment = Object.fromEntries(d.progress.map((p) => [p.enrollment_id, p]));
  const steps = d.steps.filter((s) => programById[s.program_id]);
  const stepById = Object.fromEntries(steps.map((s) => [s.id, s]));
  const stepProgress = d.stepProgress.filter((p) => enrollmentById[p.enrollment_id]);
  // Finished attempts only (not ones still being taken)
  const attempts = d.attempts.filter((a) => enrollmentById[a.enrollment_id] && a.status !== "in_progress" && a.percent != null);
  const uploads = d.uploads.filter((u) => enrollmentById[u.enrollment_id]);
  // Steps L&D removed for individual learners
  const removed = new Set(d.exclusions.map((x) => `${x.enrollment_id}:${x.step_id}`));
  const assigned = (s) => enrollments.filter((e) => e.program_id === s.program_id && !removed.has(`${e.id}:${s.id}`)).length;
  // With a market / department / manager filter on, only named answers from those learners can count
  const inView = new Set(enrollments.map((e) => e.learner_id));
  const responses = d.responses.filter((r) => stepById[r.step_id] && (!peopleFiltered() || inView.has(r.respondent_id)));

  // --- Learners (one row per enrolment) ---
  const learners = enrollments.map((e) => {
    const p = pctByEnrollment[e.id] ?? {};
    const program = programById[e.program_id];
    const pct = Math.round(Number(p.percent_complete ?? 0));
    const due = e.due_date_override ?? program.due_date;
    const dueMs = due ? new Date(`${due}T23:59:59`).getTime() : null;
    const scores = stepProgress.filter((s) => s.enrollment_id === e.id && s.score != null).map((s) => Number(s.score));
    const status = pct === 100 ? "Completed"
      : dueMs && dueMs < today.getTime() ? "Overdue"
      : dueMs && dueMs - Date.now() <= 7 * DAY ? "Due Soon"
      : stepProgress.some((s) => s.enrollment_id === e.id) ? "In Progress" : "Not Started";
    return {
      name: e.learner.full_name, email: e.learner.email, program: program.title, programId: program.id, learnerId: e.learner_id,
      department: e.learner.department || "", designation: e.learner.designation || "", market: e.learner.market || "", manager: e.learner.manager || "",
      pct, done: p.completed_steps ?? 0, total: p.required_steps ?? 0, due, status,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      lastActivity: p.last_activity, extended: !!e.due_date_override,
    };
  }).sort((a, b) => a.program.localeCompare(b.program) || a.name.localeCompare(b.name));

  // --- Programs ---
  const programRows = programs.map((p) => {
    const rows = learners.filter((l) => l.programId === p.id);
    const scores = rows.map((r) => r.avgScore).filter((v) => v != null);
    const fb = feedbackOf(responses.filter((r) => stepById[r.step_id].program_id === p.id), d.scaleQs);
    return {
      id: p.id, title: p.title, type: PROGRAM_TYPE[p.program_type], status: p.status, owner: p.owner?.full_name ?? "",
      due: p.due_date, learners: rows.length,
      avgPct: rows.length ? Math.round(rows.reduce((a, r) => a + r.pct, 0) / rows.length) : 0,
      completed: rows.filter((r) => r.status === "Completed").length,
      overdue: rows.filter((r) => r.status === "Overdue").length,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      rating: fb.rating, nps: fb.nps,
    };
  });

  // --- By department / market / manager ---
  const groupRows = Object.fromEntries(Object.keys(GROUPS).map((k) => {
    const byValue = new Map();
    for (const l of learners) {
      const v = l[k] || NOT_SET;
      if (!byValue.has(v)) byValue.set(v, []);
      byValue.get(v).push(l);
    }
    const rows = [...byValue.entries()].map(([name, rows]) => {
      const scores = rows.map((r) => r.avgScore).filter((x) => x != null);
      return {
        name, learners: new Set(rows.map((r) => r.learnerId)).size, enrolments: rows.length,
        avgPct: Math.round(rows.reduce((a, r) => a + r.pct, 0) / rows.length),
        completed: rows.filter((r) => r.status === "Completed").length,
        inProgress: rows.filter((r) => r.status === "In Progress" || r.status === "Due Soon").length,
        notStarted: rows.filter((r) => r.status === "Not Started").length,
        overdue: rows.filter((r) => r.status === "Overdue").length,
        avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      };
    }).sort((a, b) => (a.name === NOT_SET) - (b.name === NOT_SET) || b.enrolments - a.enrolments || a.name.localeCompare(b.name));
    return [k, rows];
  }));

  // --- Steps (module-wise) ---
  const stepRows = steps.map((s) => {
    const enrolled = assigned(s);
    const prog = stepProgress.filter((p) => p.step_id === s.id);
    const done = prog.filter((p) => p.status === "completed");
    const scores = prog.filter((p) => p.score != null).map((p) => Number(p.score));
    const tried = new Set(attempts.filter((a) => a.step_id === s.id).map((a) => a.enrollment_id));
    const passed = new Set(attempts.filter((a) => a.step_id === s.id && a.passed).map((a) => a.enrollment_id));
    return {
      program: programById[s.program_id].title, position: s.position, title: s.title, type: STEP_TYPE[s.step_type].short,
      required: s.is_required, enrolled, completed: done.length,
      rate: enrolled ? Math.round((done.length / enrolled) * 100) : 0,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      passRate: tried.size ? Math.round((passed.size / tried.size) * 100) : null,
      pending: uploads.filter((u) => u.step_id === s.id && u.status === "pending").length,
      feedback: s.step_type === "survey" ? feedbackOf(responses.filter((r) => r.step_id === s.id), d.scaleQs) : null,
    };
  });

  // --- Survey feedback (for the period) ---
  const surveySteps = steps.filter((s) => s.step_type === "survey");
  const responsesInPeriod = responses.filter((r) => inPeriod(r.submitted_at));
  const fbPeriod = feedbackOf(responsesInPeriod, d.scaleQs);
  const surveyAssigned = surveySteps.reduce((a, s) => a + assigned(s), 0);
  const surveyDone = surveySteps.reduce((a, s) => a + stepProgress.filter((p) => p.step_id === s.id && p.status === "completed").length, 0);
  const feedback = [
    { label: "Average Rating", value: fmtRating(fbPeriod.rating), hint: "star questions in surveys" },
    { label: "Recommendation Score", value: fmtNps(fbPeriod.nps), hint: "NPS, from −100 to +100" },
    { label: "Agreement", value: fbPeriod.agree == null ? "–" : `${fbPeriod.agree}%`, hint: "answered Agree or Strongly Agree" },
    { label: "Survey Responses", value: fbPeriod.responses, hint: peopleFiltered() ? "named answers only (filtered)" : surveyAssigned ? `${Math.round((surveyDone / surveyAssigned) * 100)}% of learners have answered` : "no surveys yet" },
  ];
  const surveyRows = surveySteps.map((s) => {
    const fb = feedbackOf(responses.filter((r) => r.step_id === s.id), d.scaleQs);
    const n = assigned(s);
    return { program: programById[s.program_id].title, title: s.title, assigned: n, ...fb, rate: n ? Math.round((fb.responses / n) * 100) : 0 };
  });

  // --- Period activity ---
  const completedInPeriod = stepProgress.filter((p) => p.status === "completed" && inPeriod(p.completed_at));
  const attemptsInPeriod = attempts.filter((a) => inPeriod(a.submitted_at));
  const learnersFinishedInPeriod = learners.filter((l) => l.status === "Completed" && inPeriod(l.lastActivity)).length;

  const kpis = [
    { label: "Live Programs", value: programs.filter((p) => p.status === "live").length, hint: `${programs.length} in view` },
    { label: "Learners Enrolled", value: new Set(enrollments.map((e) => e.learner_id)).size, hint: `${enrollments.length} enrolment${enrollments.length === 1 ? "" : "s"}` },
    { label: "Average Completion", value: `${learners.length ? Math.round(learners.reduce((a, l) => a + l.pct, 0) / learners.length) : 0}%`, hint: "across all enrolments" },
    { label: "Programs Completed", value: learners.filter((l) => l.status === "Completed").length, hint: `${learnersFinishedInPeriod} finished ${PERIODS[filters.period].toLowerCase()}` },
    { label: "Steps Completed", value: completedInPeriod.length, hint: PERIODS[filters.period] },
    { label: "Average Assessment Score", value: attemptsInPeriod.length ? `${Math.round(attemptsInPeriod.reduce((a, t) => a + Number(t.percent), 0) / attemptsInPeriod.length)}%` : "–",
      hint: attemptsInPeriod.length ? `${Math.round((attemptsInPeriod.filter((t) => t.passed).length / attemptsInPeriod.length) * 100)}% pass rate, ${attemptsInPeriod.length} attempts` : `No attempts ${PERIODS[filters.period].toLowerCase()}` },
    { label: "Overdue Learners", value: learners.filter((l) => l.status === "Overdue").length, hint: `${learners.filter((l) => l.status === "Due Soon").length} due within 7 days`, tone: "crit" },
    { label: "Waiting For Review", value: uploads.filter((u) => u.status === "pending").length, hint: `${d.threads.filter((t) => t.status === "open" && (!t.program_id || programById[t.program_id])).length} open messages`, tone: "warn" },
  ];

  const trend = buckets(completedInPeriod.map((p) => p.completed_at), start);

  // Extra figures for the screen layout
  const count = (st) => learners.filter((l) => l.status === st).length;
  const statusMix = ["Completed", "In Progress", "Due Soon", "Overdue", "Not Started"].map((st) => ({ label: st, value: count(st) }));
  const pendingReviews = uploads.filter((u) => u.status === "pending").length;
  const openMessages = d.threads.filter((t) => t.status === "open" && (!t.program_id || programById[t.program_id])).length;
  const attention = learners.filter((l) => l.status === "Overdue" || l.status === "Due Soon")
    .sort((a, b) => (a.status === b.status ? String(a.due).localeCompare(String(b.due)) : a.status === "Overdue" ? -1 : 1));
  const summary = {
    live: programs.filter((p) => p.status === "live").length,
    programs: programs.length,
    learners: new Set(enrollments.map((e) => e.learner_id)).size,
    enrolments: enrollments.length,
    avgPct: learners.length ? Math.round(learners.reduce((a, l) => a + l.pct, 0) / learners.length) : 0,
    finished: count("Completed"),
    finishedInPeriod: learnersFinishedInPeriod,
    stepsInPeriod: completedInPeriod.length,
    avgScore: attemptsInPeriod.length ? Math.round(attemptsInPeriod.reduce((a, t) => a + Number(t.percent), 0) / attemptsInPeriod.length) : null,
    passRate: attemptsInPeriod.length ? Math.round((attemptsInPeriod.filter((t) => t.passed).length / attemptsInPeriod.length) * 100) : null,
    attempts: attemptsInPeriod.length,
    overdue: count("Overdue"), dueSoon: count("Due Soon"),
    pendingReviews, openMessages,
    fb: fbPeriod, surveyRate: surveyAssigned ? Math.round((surveyDone / surveyAssigned) * 100) : null,
  };

  // Raw lists for the Excel file
  const attemptRows = attempts.map((a) => {
    const e = enrollmentById[a.enrollment_id];
    return { learner: e.learner.full_name, email: e.learner.email, program: programById[e.program_id].title,
      step: stepById[a.step_id]?.title ?? "", percent: Number(a.percent), passed: a.passed, submitted: a.submitted_at };
  }).sort((a, b) => new Date(b.submitted) - new Date(a.submitted));
  const uploadRows = uploads.map((u) => {
    const e = enrollmentById[u.enrollment_id];
    return { learner: e.learner.full_name, email: e.learner.email, program: programById[e.program_id].title,
      step: stepById[u.step_id]?.title ?? "", file: u.file_name, status: { pending: "Waiting For Review", approved: "Approved", rejected: "Returned" }[u.status],
      uploaded: u.uploaded_at, reviewedBy: u.reviewer?.full_name ?? "", reviewed: u.reviewed_at, comment: u.review_comment ?? "" };
  });

  return { kpis, feedback, surveyRows, trend, programRows, groupRows, learners, stepRows, attemptRows, uploadRows, start, statusMix, attention, summary };
}

// Count completions per day / week / month, depending on the period
function buckets(dates, start) {
  const now = new Date();
  const out = [];
  const key = (d, unit) => unit === "month" ? `${d.getFullYear()}-${d.getMonth()}` : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let unit = "day";
  let first = start;
  if (filters.period === "quarter") unit = "week";
  if (filters.period === "year" || filters.period === "all") unit = "month";
  if (!first) {
    const earliest = dates.length ? new Date(Math.min(...dates.map((x) => new Date(x).getTime()))) : now;
    first = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
    if ((now.getFullYear() - first.getFullYear()) * 12 + now.getMonth() - first.getMonth() > 23) first = new Date(now.getFullYear(), now.getMonth() - 23, 1);
  }
  // Show the whole period (later days/weeks/months simply show zero)
  const y = now.getFullYear();
  const m = now.getMonth();
  const end = {
    week: new Date(first.getFullYear(), first.getMonth(), first.getDate() + 7),
    month: new Date(y, m + 1, 1),
    quarter: new Date(y, Math.floor(m / 3) * 3 + 3, 1),
    year: new Date(y + 1, 0, 1),
  }[filters.period] ?? new Date(y, m + 1, 1);
  const cursor = new Date(first);
  while (cursor < end) {
    let label;
    let next;
    if (unit === "day") {
      label = cursor.toLocaleDateString(undefined, filters.period === "week" ? { weekday: "short" } : { day: "numeric" });
      next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    } else if (unit === "week") {
      label = cursor.toLocaleDateString(undefined, { day: "numeric", month: "short" });
      next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7);
    } else {
      label = cursor.toLocaleDateString(undefined, { month: "short", ...(filters.period === "all" ? { year: "2-digit" } : {}) });
      next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    const from = cursor.getTime();
    const to = next.getTime();
    const full = unit === "month" ? cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : unit === "week" ? `Week of ${cursor.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
      : cursor.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    out.push({ label, full, value: dates.filter((x) => { const t = new Date(x).getTime(); return t >= from && t < to; }).length });
    cursor.setTime(to);
  }
  return { unit, points: out };
}

// ---------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------
export async function renderDashboard(main, ctx) {
  main.innerHTML = `
    <header class="topbar">
      <div><h1>Dashboard</h1><p>Progress, completions and scores across your programs.</p></div>
      <div class="top-actions">
        <div class="seg seg-sm" role="group" aria-label="Period">
          ${Object.entries(PERIODS).map(([k, l]) => `<button type="button" data-period="${k}" class="${k === filters.period ? "on" : ""}">${l}</button>`).join("")}
        </div>
        <div class="menu export-menu">
          <button class="btn sm subtle" data-export aria-haspopup="true">${icons.download} Export <span class="caret">▾</span></button>
          <div class="menu-list">
            <button data-excel><b>Excel Workbook</b><span>Every table, one sheet each</span></button>
            <button data-pdf><b>PDF Report</b><span>A formatted summary to share</span></button>
          </div>
        </div>
      </div>
    </header>
    <div class="filter-bar">
      <span class="filter-label">${icons.filter}Filter</span>
      <div class="filter-chips">
        <select class="chip-select" data-f="program" aria-label="Program"><option value="">All Programs</option></select>
        <select class="chip-select" data-f="type" aria-label="Program type">
          <option value="">All Types</option>
          ${Object.entries(PROGRAM_TYPE).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
        </select>
        ${Object.keys(GROUPS).map((k) => `<select class="chip-select" data-f="${k}" aria-label="${GROUPS[k]}"></select>`).join("")}
        <button type="button" class="clear-filters" data-clear hidden>Clear Filters</button>
      </div>
    </div>
    <div id="dash"><div class="empty"><div>Loading…</div></div></div>`;

  let data;
  try {
    data = await loadData();
  } catch (err) {
    main.querySelector("#dash").innerHTML = `<div class="empty"><div><strong>Couldn't Load The Dashboard</strong>${esc(err.message)}</div></div>`;
    return;
  }

  const programSelect = main.querySelector('[data-f="program"]');
  programSelect.insertAdjacentHTML("beforeend", data.programs.map((p) =>
    `<option value="${p.id}">${esc(p.title)}${p.status === "archived" ? " (Archived)" : ""}</option>`).join(""));
  programSelect.title = "All programs except archived ones";
  programSelect.value = data.programs.some((p) => p.id === filters.program) ? filters.program : "";
  main.querySelector('[data-f="type"]').value = filters.type;
  for (const k of Object.keys(GROUPS)) {
    const used = [...new Set(data.enrollments.map((e) => e.learner[k] || NOT_SET))].sort((a, b) => (a === NOT_SET) - (b === NOT_SET) || a.localeCompare(b));
    const el = main.querySelector(`[data-f="${k}"]`);
    el.innerHTML = `<option value="">${ALL_LABEL[k]}</option>${used.map((v) => `<option>${esc(v)}</option>`).join("")}`;
    if (!used.includes(filters[k])) filters[k] = "";
    el.value = filters[k];
  }

  let view;
  const chips = [...main.querySelectorAll("[data-f]")];
  const clear = main.querySelector("[data-clear]");
  const draw = () => {
    chips.forEach((el) => el.classList.toggle("active", !!el.value));
    clear.hidden = !chips.some((el) => el.value);
    view = compute(data);
    drawDashboard(main.querySelector("#dash"), view);
  };
  chips.forEach((el) => el.addEventListener("input", () => { filters[el.dataset.f] = el.value; draw(); }));
  clear.addEventListener("click", () => { chips.forEach((el) => { el.value = ""; filters[el.dataset.f] = ""; }); draw(); });

  // Export menu
  const exportMenu = main.querySelector(".export-menu");
  const exportBtn = main.querySelector("[data-export]");
  exportBtn.addEventListener("click", (e) => { e.stopPropagation(); exportMenu.classList.toggle("open"); });
  document.addEventListener("click", (e) => { if (!exportMenu.contains(e.target)) exportMenu.classList.remove("open"); });
  main.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => {
    filters.period = b.dataset.period;
    main.querySelectorAll("[data-period]").forEach((x) => x.classList.toggle("on", x === b));
    draw();
  }));
  main.querySelector("[data-excel]").addEventListener("click", () => { exportMenu.classList.remove("open"); runExport(exportBtn, () => exportExcel(view, data, ctx.me)); });
  main.querySelector("[data-pdf]").addEventListener("click", () => { exportMenu.classList.remove("open"); runExport(exportBtn, () => exportPdf(view, data, ctx.me)); });
  draw();
}

async function runExport(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try { await fn(); } catch (err) { toast(err.message, "err"); } finally { btn.disabled = false; btn.innerHTML = label; }
}

const STATUS_PILL = { Completed: "good", Overdue: "crit", "Due Soon": "warn", "In Progress": "prog", "Not Started": "" };
const pct = (v) => (v == null ? '<span class="muted">–</span>' : `${v}%`);
const meter = (v) => `<div class="meter"><i style="width:${v}%"></i></div> ${v}%`;

const STATUS_COLOR = { Completed: "#4fb3b8", "In Progress": "#2a7fc0", "Due Soon": "#e6a532", Overdue: "#d0504a", "Not Started": "#c9d5df" };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Five stars, filled to the average (e.g. 4.3)
const stars = (r) => `<span class="star-meter" style="--fill:${r == null ? 0 : (r / 5) * 100}%" aria-label="${r ?? 0} out of 5"><span>★★★★★</span><span>★★★★★</span></span>`;

function trendChart(t) {
  const pts = t.points;
  const max = Math.max(4, ...pts.map((p) => p.value));
  const top = Math.ceil(max / 4) * 4;
  const every = Math.ceil(pts.length / 12);
  const total = pts.reduce((a, p) => a + p.value, 0);
  const best = pts.reduce((a, p) => (p.value > a.value ? p : a), { value: 0 });
  return `
    <div class="chart-stats"><div><b>${total}</b><span>Total</span></div>
      <div><b>${best.value ? esc(best.full) : "–"}</b><span>Busiest ${t.unit === "day" ? "Day" : t.unit === "week" ? "Week" : "Month"}${best.value ? ` (${plural(best.value, "step")})` : ""}</span></div></div>
    <div class="cols">
      <div class="cols-axis">${[4, 3, 2, 1, 0].map((i) => `<span>${(top / 4) * i}</span>`).join("")}</div>
      <div class="cols-plot" style="--n:${pts.length}">
        ${pts.map((p, i) => `
          <div class="col" title="${esc(p.full)}: ${plural(p.value, "step")}">
            <i style="height:${(p.value / top) * 100}%">${p.value ? `<em>${p.value}</em>` : ""}</i>
            <span>${i % every === 0 ? esc(p.label) : ""}</span>
          </div>`).join("")}
      </div>
    </div>`;
}

function statusDonut(mix) {
  const total = mix.reduce((a, m) => a + m.value, 0);
  let at = 0;
  const stops = total ? mix.filter((m) => m.value).map((m) => {
    const from = at; at += (m.value / total) * 100;
    return `${STATUS_COLOR[m.label]} ${from}% ${at}%`;
  }).join(", ") : "var(--neutral-bg) 0 100%";
  return `
    <div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(${stops})"><span><b>${total}</b>${total === 1 ? "Enrolment" : "Enrolments"}</span></div>
      <ul class="legend">${mix.map((m) => `
        <li><i style="background:${STATUS_COLOR[m.label]}"></i>${m.label}<b>${m.value}</b><span>${total ? Math.round((m.value / total) * 100) : 0}%</span></li>`).join("")}
      </ul>
    </div>`;
}

function feedbackCard(s) {
  const fb = s.fb;
  const npsPos = fb.nps == null ? 50 : (fb.nps + 100) / 2;
  return `
    <div class="card fb-card">
      <div class="card-head"><h2>Learner Feedback</h2><span class="muted small">${esc(PERIODS[filters.period])}, from surveys</span></div>
      <div class="fb-rating">
        <b>${fb.rating ?? "–"}<small> / 5</small></b>
        <div>${stars(fb.rating)}<span class="muted small">Average rating from ${plural(fb.responses, "response")}</span></div>
      </div>
      <div class="fb-row">
        <div class="fb-label"><span>Recommendation Score (NPS)</span><b>${fmtNps(fb.nps)}</b></div>
        <div class="nps-track"><i style="left:${npsPos}%"${fb.nps == null ? ' hidden' : ""}></i></div>
        <div class="nps-ticks"><span>−100</span><span>0</span><span>+100</span></div>
      </div>
      <div class="fb-row">
        <div class="fb-label"><span>Agree Or Strongly Agree</span><b>${fb.agree == null ? "–" : `${fb.agree}%`}</b></div>
        <div class="hbar-track"><i style="width:${fb.agree ?? 0}%"></i></div>
      </div>
      <div class="fb-row">
        <div class="fb-label"><span>Response Rate</span><b>${s.surveyRate == null ? "–" : `${s.surveyRate}%`}</b></div>
        <div class="hbar-track"><i style="width:${s.surveyRate ?? 0}%"></i></div>
      </div>
    </div>`;
}

function attentionCard(v) {
  const s = v.summary;
  const items = [
    ...v.attention.slice(0, 5).map((l) => `
      <a class="att-item" href="#/programs/${l.programId}/learners">
        <span class="att-dot ${l.status === "Overdue" ? "crit" : "warn"}">${icons.clock}</span>
        <span class="att-text"><strong>${esc(l.name)}</strong><span>${esc(l.program)} · ${l.pct}% done</span></span>
        <span class="pill ${STATUS_PILL[l.status]}">${l.status === "Overdue" ? "Overdue" : `Due ${esc(fmtDate(l.due))}`}</span>
      </a>`),
    s.pendingReviews ? `
      <a class="att-item" href="#/review">
        <span class="att-dot warn">${icons.review}</span>
        <span class="att-text"><strong>${plural(s.pendingReviews, "Upload")} To Review</strong><span>Certificates and workbooks waiting</span></span>
        <span class="att-go">Open ›</span>
      </a>` : "",
    s.openMessages ? `
      <a class="att-item" href="#/messages">
        <span class="att-dot prog">${icons.messages}</span>
        <span class="att-text"><strong>${plural(s.openMessages, "Open Message")}</strong><span>Learners waiting for a reply</span></span>
        <span class="att-go">Open ›</span>
      </a>` : "",
  ].filter(Boolean);
  const more = v.attention.length - 5;
  return `
    <div class="card att-card">
      <div class="card-head"><h2>Needs Attention</h2><span class="muted small">${items.length ? plural(v.attention.length + (s.pendingReviews ? 1 : 0) + (s.openMessages ? 1 : 0), "item") : ""}</span></div>
      ${items.length ? `<div class="att-list">${items.join("")}</div>${more > 0 ? `<p class="muted small" style="margin:8px 0 0">+ ${more} more in the By Learner table below</p>` : ""}`
        : `<div class="all-clear"><span>${icons.check}</span><div><strong>All Clear</strong><span class="muted small">No overdue learners, reviews or messages.</span></div></div>`}
    </div>`;
}

function completionBars(v) {
  if (filters.groupBy === "program") {
    return v.programRows.length ? `<div class="prog-bars">${v.programRows.map((p) => `
      <a class="prog-bar" href="#/programs/${p.id}/learners">
        <span class="prog-bar-top"><strong title="${esc(p.title)}">${esc(p.title)}</strong><b>${p.avgPct}%</b></span>
        <span class="hbar-track"><i style="width:${p.avgPct}%"></i></span>
        <span class="muted small">${plural(p.learners, "learner")} · ${p.completed} completed${p.avgScore != null ? ` · avg. score ${p.avgScore}%` : ""}</span>
      </a>`).join("")}</div>` : '<p class="muted">No programs in view.</p>';
  }
  const rows = v.groupRows[filters.groupBy];
  return rows.length ? `<div class="prog-bars">${rows.map((g) => `
    <button type="button" class="prog-bar" data-pick="${esc(g.name)}" title="Show only ${esc(g.name)}">
      <span class="prog-bar-top"><strong>${esc(g.name)}</strong><b>${g.avgPct}%</b></span>
      <span class="hbar-track"><i style="width:${g.avgPct}%"></i></span>
      <span class="muted small">${plural(g.learners, "learner")} · ${g.completed} completed${g.overdue ? ` · ${g.overdue} overdue` : ""}</span>
    </button>`).join("")}</div>` : '<p class="muted">No learners in view.</p>';
}

// Each designation as a bar split by learner status, with completion and score beside it
function designationCard(v) {
  const rows = v.groupRows.designation;
  const parts = [["completed", "Completed"], ["inProgress", "In Progress"], ["overdue", "Overdue"], ["notStarted", "Not Started"]];
  const color = { completed: STATUS_COLOR.Completed, inProgress: STATUS_COLOR["In Progress"], overdue: STATUS_COLOR.Overdue, notStarted: STATUS_COLOR["Not Started"] };
  const most = Math.max(1, ...rows.map((r) => r.enrolments));
  return `
    <div class="card span3 desig-card">
      <div class="card-head"><h2>By Designation</h2>
        <div class="desig-legend">${parts.map(([k, l]) => `<span><i style="background:${color[k]}"></i>${l}</span>`).join("")}</div>
      </div>
      ${rows.length ? `
        <div class="desig-head"><span>Designation</span><span>Learners By Status</span><span>Completion</span><span>Avg. Score</span></div>
        <div class="desig-rows">${rows.map((g) => `
          <button type="button" class="desig-row" data-pick-desig="${esc(g.name)}" title="Show only ${esc(g.name)}">
            <span class="desig-name"><strong>${esc(g.name)}</strong><span>${plural(g.learners, "learner")}</span></span>
            <span class="desig-stack" style="width:${Math.max(18, (g.enrolments / most) * 100)}%">${parts.filter(([k]) => g[k]).map(([k, l]) =>
              `<i style="flex:${g[k]};background:${color[k]}" title="${l}: ${g[k]}">${g[k]}</i>`).join("")}</span>
            <span class="desig-pct"><span class="ring-mini" style="--p:${g.avgPct}"></span><b>${g.avgPct}%</b></span>
            <span class="desig-score">${g.avgScore == null ? '<span class="muted">–</span>' : `<b>${g.avgScore}%</b>`}</span>
          </button>`).join("")}</div>`
        : '<p class="muted">No learners in view.</p>'}
    </div>`;
}

function drawDashboard(box, v) {
  const s = v.summary;
  const tiles = [
    { icon: icons.check, tone: "teal", label: "Steps Completed", value: s.stepsInPeriod, hint: PERIODS[filters.period] },
    { icon: icons.assessment, tone: "sky", label: "Average Assessment Score", value: s.avgScore == null ? "–" : `${s.avgScore}%`,
      hint: s.attempts ? `${s.passRate}% passed · ${plural(s.attempts, "attempt")}` : `No attempts ${PERIODS[filters.period].toLowerCase()}`, bar: s.avgScore },
    { icon: icons.flag, tone: "crit", label: "Overdue Learners", value: s.overdue, hint: `${s.dueSoon} due within 7 days` },
    { icon: icons.review, tone: "warn", label: "Waiting For Review", value: s.pendingReviews, hint: plural(s.openMessages, "open message") },
  ];
  box.innerHTML = `
    <section class="dash-hero">
      <div class="dash-hero-main">
        <span class="eyebrow">${esc(PERIODS[filters.period])} Overview</span>
        <h2>${plural(s.learners, "learner")} across ${plural(s.live, "live program")}</h2>
        <p>${s.finishedInPeriod ? `${plural(s.finishedInPeriod, "learner")} finished a program ${PERIODS[filters.period].toLowerCase()}. ` : ""}${s.overdue ? `${plural(s.overdue, "learner")} ${s.overdue === 1 ? "is" : "are"} overdue.` : "Nobody is overdue."}</p>
        <div class="hero-stats">
          <div><b>${s.live}</b><span>Live Programs</span></div>
          <div><b>${s.learners}</b><span>Learners Enrolled</span></div>
          <div><b>${s.finished}</b><span>Programs Completed</span></div>
          <div><b>${s.fb.rating ?? "–"}</b><span>Average Rating</span></div>
        </div>
      </div>
      <div class="dash-hero-ring">
        <div class="ring anim hero-ring" style="--p:${s.avgPct}"><span><b>${s.avgPct}%</b>Average Completion</span></div>
      </div>
    </section>

    <div class="tile-grid">
      ${tiles.map((t) => `
        <div class="card tile ${t.tone}">
          <span class="tile-icon">${t.icon}</span>
          <div><span class="label">${esc(t.label)}</span><b>${esc(t.value)}</b><span class="muted small">${esc(t.hint)}</span></div>
        </div>`).join("")}
    </div>

    <div class="dash-grid">
      <div class="card span2">
        <div class="card-head"><h2>Steps Completed</h2><span class="muted small">${esc(PERIODS[filters.period])}, by ${v.trend.unit}</span></div>
        ${trendChart(v.trend)}
      </div>
      <div class="card">
        <div class="card-head"><h2>Learner Status</h2><span class="muted small">All enrolments in view</span></div>
        ${statusDonut(v.statusMix)}
      </div>
      <div class="card">
        <div class="card-head"><h2>Completion By ${filters.groupBy === "program" ? "Program" : GROUPS[filters.groupBy] === "Reporting Manager" ? "Manager" : GROUPS[filters.groupBy]}</h2><span class="muted small">Average of all learners</span></div>
        <div class="seg mini-seg" role="group" aria-label="Group by">
          ${[["program", "Program"], ["market", "Market"], ["department", "Department"], ["manager", "Manager"]].map(([k, l]) =>
            `<button type="button" data-group="${k}" class="${filters.groupBy === k ? "on" : ""}">${l}</button>`).join("")}
        </div>
        ${completionBars(v)}
      </div>
      ${feedbackCard(s)}
      ${attentionCard(v)}
      ${designationCard(v)}
    </div>

    <div class="tabs" style="margin-top:22px">
      ${[["programs", "By Program"], ["learners", "By Learner"], ["department", "By Department"], ["designation", "By Designation"], ["market", "By Market"], ["manager", "By Manager"], ["steps", "By Step"]].map(([k, l]) =>
        `<a href="#" data-view="${k}" class="${filters.view === k ? "active" : ""}">${l}</a>`).join("")}
    </div>
    <div id="dash-table"></div>`;

  box.querySelectorAll("[data-view]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    filters.view = a.dataset.view;
    box.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("active", x === a));
    drawTable(box.querySelector("#dash-table"), v);
  }));
  box.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
    filters.groupBy = b.dataset.group;
    drawDashboard(box, v);
  }));
  box.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => pickGroup(filters.groupBy, b.dataset.pick)));
  box.querySelectorAll("[data-pick-desig]").forEach((b) => b.addEventListener("click", () => pickGroup("designation", b.dataset.pickDesig)));
  drawTable(box.querySelector("#dash-table"), v);
}

// Clicking a market / department / manager narrows the whole dashboard to it
function pickGroup(key, value) {
  const el = document.querySelector(`[data-f="${key}"]`);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

function drawTable(el, v) {
  if (GROUPS[filters.view]) {
    const rows = v.groupRows[filters.view];
    el.innerHTML = rows.length ? `
      <div class="table-wrap"><table class="data clickable">
        <thead><tr><th>${GROUPS[filters.view]}</th><th>Learners</th><th>Enrolments</th><th>Avg. Completion</th><th>Completed</th><th>In Progress</th><th>Overdue</th><th>Avg. Score</th></tr></thead>
        <tbody>${rows.map((g) => `
          <tr data-pick="${esc(g.name)}"><td class="name"><strong>${esc(g.name)}</strong></td><td>${g.learners}</td><td>${g.enrolments}</td>
            <td>${meter(g.avgPct)}</td><td>${g.completed}</td><td>${g.inProgress}</td>
            <td>${g.overdue ? `<span class="pill crit">${g.overdue}</span>` : 0}</td><td>${pct(g.avgScore)}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="muted small" style="margin-top:8px">Click a row to see only those learners across the whole dashboard.</p>`
      : '<div class="empty"><div><strong>No Learners In View</strong>Enroll learners in a program first.</div></div>';
    el.querySelectorAll("[data-pick]").forEach((r) => r.addEventListener("click", () => pickGroup(filters.view, r.dataset.pick)));
    return;
  }

  if (filters.view === "programs") {
    el.innerHTML = v.programRows.length ? `
      <div class="table-wrap"><table class="data clickable">
        <thead><tr><th>Program</th><th>Type</th><th>Status</th><th>Learners</th><th>Avg. Completion</th><th>Completed</th><th>Overdue</th><th>Avg. Score</th><th>Avg. Rating</th><th>NPS</th><th>Due Date</th></tr></thead>
        <tbody>${v.programRows.map((p) => `
          <tr data-open="${p.id}"><td class="name"><strong>${esc(p.title)}</strong><span>${esc(p.owner)}</span></td>
            <td>${esc(p.type)}</td><td>${statusPill(p.status)}</td><td>${p.learners}</td><td>${meter(p.avgPct)}</td>
            <td>${p.completed}</td><td>${p.overdue ? `<span class="pill crit">${p.overdue}</span>` : 0}</td><td>${pct(p.avgScore)}</td>
            <td>${p.rating == null ? '<span class="muted">–</span>' : `★ ${p.rating}`}</td><td>${p.nps == null ? '<span class="muted">–</span>' : fmtNps(p.nps)}</td>
            <td>${esc(fmtDate(p.due))}</td></tr>`).join("")}</tbody>
      </table></div>` : '<div class="empty"><div><strong>No Programs In View</strong>Change the filters above.</div></div>';
    el.querySelector("tbody")?.addEventListener("click", (e) => {
      const row = e.target.closest("[data-open]");
      if (row) location.hash = `#/programs/${row.dataset.open}/learners`;
    });
    return;
  }

  if (filters.view === "learners") {
    el.innerHTML = `
      <div class="toolbar"><input class="input search" type="search" placeholder="Search learner, department, market, manager" value="${esc(filters.q)}" data-q><span class="count"></span></div>
      <div data-rows></div>`;
    const rows = el.querySelector("[data-rows]");
    const drawRows = () => {
      const q = filters.q.trim().toLowerCase();
      const shown = v.learners.filter((l) => !q || `${l.name} ${l.email} ${l.program} ${l.department} ${l.market} ${l.manager}`.toLowerCase().includes(q));
      el.querySelector(".count").textContent = `${shown.length} of ${v.learners.length}`;
      rows.innerHTML = shown.length ? `
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Learner</th><th>Department</th><th>Market</th><th>Reporting Manager</th><th>Program</th><th>Progress</th><th>Status</th><th>Due Date</th><th>Avg. Score</th><th>Last Activity</th></tr></thead>
          <tbody>${shown.map((l) => `
            <tr><td class="name"><strong>${esc(l.name)}</strong><span>${esc(l.email)}</span></td>
              <td class="name"><strong>${esc(l.department || "–")}</strong><span>${esc(l.designation)}</span></td>
              <td>${esc(l.market || "–")}</td><td>${esc(l.manager || "–")}</td>
              <td>${esc(l.program)}</td><td>${meter(l.pct)} <span class="muted small">(${l.done}/${l.total})</span></td>
              <td><span class="pill ${STATUS_PILL[l.status]}">${l.status}</span></td>
              <td>${esc(fmtDate(l.due))}${l.extended ? ' <span class="pill warn">Extended</span>' : ""}</td>
              <td>${pct(l.avgScore)}</td><td>${esc(fmtDate(l.lastActivity))}</td></tr>`).join("")}</tbody>
        </table></div>` : '<div class="empty"><div><strong>No Learners In View</strong>Enroll learners in a program first.</div></div>';
    };
    el.querySelector("[data-q]").addEventListener("input", (e) => { filters.q = e.target.value; drawRows(); });
    drawRows();
    return;
  }

  el.innerHTML = v.stepRows.length ? `
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Program</th><th>Step</th><th>Type</th><th>Completed</th><th>Completion Rate</th><th>Avg. Score</th><th>Pass Rate</th><th>Waiting For Review</th></tr></thead>
      <tbody>${v.stepRows.map((s) => `
        <tr><td>${esc(s.program)}</td><td class="name"><strong>${s.position}. ${esc(s.title)}</strong>${s.required ? "" : "<span>Optional</span>"}</td>
          <td>${esc(s.type)}</td><td>${s.completed} / ${s.enrolled}</td><td>${meter(s.rate)}</td>
          <td>${s.feedback ? (s.feedback.rating != null ? `★ ${s.feedback.rating} / 5` : s.feedback.nps != null ? `NPS ${fmtNps(s.feedback.nps)}` : '<span class="muted">–</span>') : pct(s.avgScore)}</td>
          <td>${pct(s.passRate)}</td><td>${s.pending || ""}</td></tr>`).join("")}</tbody>
    </table></div>` : '<div class="empty"><div><strong>No Steps In View</strong>Add steps to a program’s learning journey.</div></div>';
}

// ---------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------
function filterSummary(data) {
  const program = data.programs.find((p) => p.id === filters.program);
  return [
    ["Period", PERIODS[filters.period]],
    ["Program", program ? program.title : "All Programs (Not Archived)"],
    ["Designation", filters.designation || "All Designations"],
    ["Type", filters.type ? PROGRAM_TYPE[filters.type] : "All Types"],
    ["Market", filters.market || "All Markets"],
    ["Department", filters.department || "All Departments"],
    ["Reporting Manager", filters.manager || "All Managers"],
  ];
}

const xDate = (v) => (v ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v) : "");

async function exportExcel(v, data, me) {
  await loadScript(LIBS.xlsx);
  const X = window.XLSX;
  const wb = X.utils.book_new();
  const sheet = (name, rows, widths) => {
    const ws = Array.isArray(rows[0]) ? X.utils.aoa_to_sheet(rows, { cellDates: true }) : X.utils.json_to_sheet(rows, { cellDates: true });
    ws["!cols"] = widths.map((w) => ({ wch: w }));
    X.utils.book_append_sheet(wb, ws, name);
  };

  sheet("Summary", [
    ["L&D Learning Report"],
    ["Generated", new Date(), "By", me.full_name],
    [],
    ...filterSummary(data),
    [],
    ["Measure", "Value", "Detail"],
    ...v.kpis.map((k) => [k.label, k.value, k.hint]),
    [],
    ["Learner Feedback", "", ""],
    ...v.feedback.map((k) => [k.label, k.value, k.hint]),
  ], [28, 22, 40, 24]);

  sheet("Programs", v.programRows.map((p) => ({
    Program: p.title, Type: p.type, Status: PROGRAM_STATUS[p.status].label, Owner: p.owner, "Due Date": xDate(p.due),
    Learners: p.learners, "Average Completion %": p.avgPct, Completed: p.completed, Overdue: p.overdue, "Average Score %": p.avgScore ?? "",
    "Average Rating (1-5)": p.rating ?? "", NPS: p.nps ?? "",
  })), [34, 12, 12, 22, 12, 10, 20, 11, 9, 16, 18, 8]);

  sheet("Survey Feedback", v.surveyRows.length ? v.surveyRows.map((r) => ({
    Program: r.program, Survey: r.title, "Learners Assigned": r.assigned, Responses: r.responses, "Response Rate %": r.rate,
    "Average Rating (1-5)": r.rating ?? "", NPS: r.nps ?? "", "Agreement %": r.agree ?? "",
  })) : [["No surveys yet."]], [32, 32, 16, 11, 15, 18, 8, 12]);

  sheet("Learners", v.learners.map((l) => ({
    Learner: l.name, Email: l.email, Department: l.department, Designation: l.designation, Market: l.market, "Reporting Manager": l.manager,
    Program: l.program, "Completion %": l.pct, "Steps Done": l.done, "Steps Required": l.total,
    Status: l.status, "Due Date": xDate(l.due), "Deadline Extended": l.extended ? "Yes" : "No",
    "Average Score %": l.avgScore ?? "", "Last Activity": xDate(l.lastActivity),
  })), [26, 32, 20, 20, 13, 22, 32, 13, 11, 14, 13, 12, 17, 16, 18]);

  for (const [k, label] of Object.entries(GROUPS)) {
    sheet(`By ${label === "Reporting Manager" ? "Manager" : label}`, v.groupRows[k].length ? v.groupRows[k].map((g) => ({
      [label]: g.name, Learners: g.learners, Enrolments: g.enrolments, "Average Completion %": g.avgPct,
      Completed: g.completed, "In Progress": g.inProgress, Overdue: g.overdue, "Average Score %": g.avgScore ?? "",
    })) : [["No learners in view."]], [28, 10, 12, 20, 11, 12, 9, 16]);
  }

  sheet("Steps", v.stepRows.map((s) => ({
    Program: s.program, "#": s.position, Step: s.title, Type: s.type, Required: s.required ? "Yes" : "No",
    Enrolled: s.enrolled, Completed: s.completed, "Completion Rate %": s.rate, "Average Score %": s.avgScore ?? "",
    "Pass Rate %": s.passRate ?? "", "Waiting For Review": s.pending,
  })), [32, 4, 36, 14, 9, 9, 10, 17, 16, 12, 18]);

  sheet("Assessment Attempts", v.attemptRows.length ? v.attemptRows.map((a) => ({
    Learner: a.learner, Email: a.email, Program: a.program, Assessment: a.step, "Score %": a.percent,
    Result: a.passed ? "Passed" : "Not Passed", Submitted: xDate(a.submitted),
  })) : [["No assessment attempts yet."]], [26, 32, 32, 32, 9, 12, 18]);

  sheet("Uploads", v.uploadRows.length ? v.uploadRows.map((u) => ({
    Learner: u.learner, Email: u.email, Program: u.program, Step: u.step, File: u.file, Status: u.status,
    Uploaded: xDate(u.uploaded), "Reviewed By": u.reviewedBy, Reviewed: xDate(u.reviewed), Comment: u.comment,
  })) : [["No uploads yet."]], [26, 32, 32, 30, 30, 18, 18, 20, 18, 40]);

  X.writeFile(wb, `L and D Learning Report ${today()}.xlsx`);
  toast("Excel file downloaded.");
}

// ---------------------------------------------------------------------
// PDF report (A4, corporate layout)
// ---------------------------------------------------------------------
const NAVY = [18, 48, 77];
const TEAL = [79, 179, 184];
const SKY = [42, 127, 192];
const INK = [22, 50, 74];
const MUTED = [91, 111, 130];
const LINE = [223, 231, 238];

async function exportPdf(v, data, me) {
  await loadScript(LIBS.jspdf);
  await loadScript(LIBS.autotable);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  const program = data.programs.find((p) => p.id === filters.program);
  const scope = program ? program.title : "All Programs";
  const generated = new Date().toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" });

  // Header band
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, W, 112, "F");
  const stripe = [SKY, TEAL, [109, 181, 158]];
  stripe.forEach((c, i) => { doc.setFillColor(...c); doc.rect((W / 3) * i, 112, W / 3 + 1, 4, "F"); });
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("L&D Learning Report", M, 52);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(200, 220, 232);
  doc.text([scope, PERIODS[filters.period], filters.type && PROGRAM_TYPE[filters.type], filters.market, filters.department, filters.designation, filters.manager && `Manager: ${filters.manager}`].filter(Boolean).join("  |  "), M, 74);
  doc.text(`Generated ${generated} by ${me.full_name}`, M, 92);

  // KPI tiles (4 x 2)
  let y = 140;
  const gap = 10;
  const tileW = (W - M * 2 - gap * 3) / 4;
  const tileH = 64;
  v.kpis.forEach((k, i) => {
    const x = M + (i % 4) * (tileW + gap);
    const ty = y + Math.floor(i / 4) * (tileH + gap);
    doc.setFillColor(246, 249, 251);
    doc.setDrawColor(...LINE);
    doc.roundedRect(x, ty, tileW, tileH, 6, 6, "FD");
    doc.setFillColor(...(k.tone === "crit" ? [208, 80, 74] : k.tone === "warn" ? [230, 165, 50] : TEAL));
    doc.rect(x, ty + 6, 3, tileH - 12, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(doc.splitTextToSize(k.label, tileW - 18)[0], x + 12, ty + 17);
    doc.setFontSize(18);
    doc.setTextColor(...INK);
    doc.text(String(k.value), x + 12, ty + 40);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(doc.splitTextToSize(k.hint, tileW - 18)[0], x + 12, ty + 54);
  });
  y += tileH * 2 + gap + 12;

  // Learner feedback tiles
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`LEARNER FEEDBACK  (${PERIODS[filters.period].toUpperCase()}, FROM SURVEYS)`, M, y + 8);
  y += 14;
  v.feedback.forEach((k, i) => {
    const x = M + i * (tileW + gap);
    doc.setFillColor(243, 248, 247);
    doc.setDrawColor(...LINE);
    doc.roundedRect(x, y, tileW, tileH - 8, 6, 6, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(k.label, x + 12, y + 16);
    doc.setFontSize(16);
    doc.setTextColor(...INK);
    doc.text(String(k.value).replace("−", "-"), x + 12, y + 36);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(doc.splitTextToSize(k.hint.replace("−", "-"), tileW - 18)[0], x + 12, y + 48);
  });
  y += tileH + 20;

  // Chart: steps completed over time
  const sectionTitle = (title, sub, at) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...INK);
    doc.text(title, M, at);
    if (sub) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...MUTED);
      doc.text(sub, W - M, at, { align: "right" });
    }
  };
  sectionTitle("Steps Completed", `${PERIODS[filters.period]}, by ${v.trend.unit}`, y);
  y += 12;
  const chartH = 110;
  const chartW = W - M * 2;
  const pts = v.trend.points;
  const max = Math.max(1, ...pts.map((p) => p.value));
  const slot = chartW / Math.max(1, pts.length);
  doc.setDrawColor(...LINE);
  doc.line(M, y + chartH, M + chartW, y + chartH);
  const labelEvery = Math.ceil(pts.length / 16);
  pts.forEach((p, i) => {
    const h = (p.value / max) * (chartH - 18);
    const bx = M + i * slot + slot * 0.18;
    const bw = slot * 0.64;
    doc.setFillColor(...TEAL);
    if (h > 0) doc.rect(bx, y + chartH - h, bw, h, "F");
    doc.setFontSize(7);
    if (p.value) { doc.setTextColor(...INK); doc.text(String(p.value), bx + bw / 2, y + chartH - h - 3, { align: "center" }); }
    if (i % labelEvery === 0) { doc.setTextColor(...MUTED); doc.text(p.label, bx + bw / 2, y + chartH + 10, { align: "center" }); }
  });
  y += chartH + 34;

  // Chart: completion by program
  sectionTitle("Completion By Program", "Average of all learners", y);
  y += 14;
  const rows = v.programRows.slice(0, 12);
  if (!rows.length) {
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text("No programs in view.", M, y + 10);
    y += 20;
  }
  rows.forEach((p) => {
    if (y > doc.internal.pageSize.getHeight() - 70) { doc.addPage(); y = 50; }
    doc.setFontSize(8.5);
    doc.setTextColor(...INK);
    doc.text(doc.splitTextToSize(p.title, 150)[0], M, y + 8);
    doc.setFillColor(237, 242, 246);
    doc.rect(M + 160, y, chartW - 200, 10, "F");
    doc.setFillColor(...SKY);
    if (p.avgPct) doc.rect(M + 160, y, (chartW - 200) * (p.avgPct / 100), 10, "F");
    doc.setFont("helvetica", "bold");
    doc.text(`${p.avgPct}%`, W - M, y + 8, { align: "right" });
    doc.setFont("helvetica", "normal");
    y += 18;
  });

  // Tables flow on one after another; a new page starts only when the current one is full
  const H = doc.internal.pageSize.getHeight();
  y += 16;
  const table = (title, head, body, columnStyles = {}) => {
    // Keep short tables in one piece; long ones start here if a few rows fit
    const need = 50 + Math.min(Math.max(body.length, 1), 6) * 26;
    if (y + need > H - 50) { doc.addPage(); y = 50; }
    sectionTitle(title, `${scope}  |  ${PERIODS[filters.period]}`, y);
    doc.autoTable({
      startY: y + 10, head: [head], body: body.length ? body : [[{ content: "Nothing to show yet.", colSpan: head.length }]],
      margin: { top: 50, left: M, right: M, bottom: 50 },
      styles: { font: "helvetica", fontSize: 8, cellPadding: 5, textColor: INK, lineColor: LINE, lineWidth: 0.5 },
      headStyles: { fillColor: NAVY, textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [246, 249, 251] },
      rowPageBreak: "avoid",
      columnStyles,
    });
    y = doc.lastAutoTable.finalY + 30;
  };
  const fmt = (n) => (n == null ? "–" : `${n}%`);
  table("Programs", ["Program", "Type", "Status", "Learners", "Avg. Completion", "Completed", "Overdue", "Avg. Score", "Rating", "NPS"],
    v.programRows.map((p) => [p.title, p.type, PROGRAM_STATUS[p.status].label, p.learners, `${p.avgPct}%`, p.completed, p.overdue, fmt(p.avgScore), p.rating == null ? "–" : `${p.rating}/5`, fmtNps(p.nps)]),
    { 0: { cellWidth: 150 } });
  for (const [k, label] of Object.entries(GROUPS)) {
    table(`By ${label === "Reporting Manager" ? "Manager" : label}`, [label, "Learners", "Enrolments", "Avg. Completion", "Completed", "In Progress", "Overdue", "Avg. Score"],
      v.groupRows[k].map((g) => [g.name, g.learners, g.enrolments, `${g.avgPct}%`, g.completed, g.inProgress, g.overdue, fmt(g.avgScore)]),
      { 0: { cellWidth: 140 } });
  }
  table("Learners", ["Learner", "Department / Market", "Manager", "Program", "Progress", "Status", "Due Date", "Score"],
    v.learners.map((l) => [`${l.name}\n${l.email}`, [l.department, l.designation, l.market].filter(Boolean).join("\n") || "–", l.manager || "–", l.program,
      `${l.pct}% (${l.done}/${l.total})`, l.status, fmtDate(l.due), fmt(l.avgScore)]),
    { 0: { cellWidth: 110 } });
  table("Steps", ["Program", "Step", "Type", "Completed", "Rate", "Avg. Score", "Pass Rate"],
    v.stepRows.map((s) => [s.program, `${s.position}. ${s.title}`, s.type, `${s.completed} / ${s.enrolled}`, `${s.rate}%`, fmt(s.avgScore), fmt(s.passRate)]),
    { 1: { cellWidth: 150 } });

  // Footer on every page
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    const H = doc.internal.pageSize.getHeight();
    doc.setDrawColor(...LINE);
    doc.line(M, H - 32, W - M, H - 32);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text("GrowthPoint  |  HRC Learning & Development  |  Confidential: For Internal Use", M, H - 20);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 20, { align: "right" });
  }

  doc.save(`${safeName(`L and D Learning Report - ${scope} - ${today()}`)}.pdf`);
  toast("PDF report downloaded.");
}
