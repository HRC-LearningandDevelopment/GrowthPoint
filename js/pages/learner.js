// Learner side: My learning dashboard, a program page, the module player and assessments.
//   #/home                          dashboard
//   #/home/<program>                program page
//   #/home/<program>/module/<step>  module inside the Companion
//   #/home/<program>/assessment/<step>
//
// Admin and L&D get the same pages read-only under "Learner view":
//   #/preview/new/...          as a new learner (every program, welcome steps treated as done)
//   #/preview/<learner id>/... as a specific learner, with their real progress
import { sb } from "../supabase.js";
import { esc, toast, openModal, icons, stepIcon, fmtDate, fmtDateTime, PROGRAM_TYPE, STEP_TYPE } from "../ui.js";
import { newMessage } from "./messages.js";

const UPLOAD_BUCKET = "learner-uploads";
const VIDEO_BUCKET = "welcome-videos";
const MAX_PDF_MB = 5;
const DAY = 86400000;

// Who the pages are showing, and where their links point
let mode = { preview: false, base: "#/home", learnerId: null, name: "" };

export async function renderLearning(main, ctx) {
  mode = { preview: false, base: "#/home", learnerId: ctx.me.id, name: ctx.me.full_name };
  return route(main, ctx, ctx.params);
}

export async function renderPreview(main, ctx) {
  const [as = "new", ...rest] = ctx.params;
  const { data: learners } = await sb.from("profiles").select("id, full_name")
    .eq("role", "learner").order("full_name");
  const viewed = (learners ?? []).find((l) => l.id === as);
  const learnerId = viewed ? as : null;
  mode = { preview: true, base: `#/preview/${learnerId ?? "new"}`, learnerId, name: viewed?.full_name ?? "Learner" };

  main.innerHTML = `
    <div class="preview-bar">
      <span class="pill prog">Learner View</span>
      <span>You're seeing the Companion as a learner does. <b>Nothing you do here is saved.</b></span>
      <label>View as
        <select class="select" data-as>
          <option value="new">A New Learner (Every Program)</option>
          ${(learners ?? []).map((l) => `<option value="${l.id}" ${l.id === learnerId ? "selected" : ""}>${esc(l.full_name)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div id="preview-body"></div>`;
  main.querySelector("[data-as]").addEventListener("change", (e) => { location.hash = `#/preview/${e.target.value}`; });
  return route(main.querySelector("#preview-body"), ctx, rest);
}

function route(main, ctx, params) {
  const [programId, view, stepId] = params;
  if (!programId) return dashboard(main);
  if (view === "module") return modulePlayer(main, ctx, programId, stepId);
  if (view === "assessment") return assessmentPage(main, ctx, programId, stepId);
  return programPage(main, ctx, programId);
}

const previewOnly = () => toast("This is the learner view. Nothing is saved here.");

// =====================================================================
// Shared: load everything about one or more enrolments
// =====================================================================
async function loadEnrollments(programId = null) {
  let enrollments;
  if (mode.preview && !mode.learnerId) {
    // A made-up enrolment in every program that isn't archived
    let q = sb.from("programs").select("*").neq("status", "archived").order("created_at", { ascending: false });
    if (programId) q = q.eq("id", programId);
    const { data, error } = await q;
    if (error) throw error;
    const now = new Date().toISOString();
    enrollments = data.map((p) => ({
      id: null, program_id: p.id, program: p, due_date_override: null,
      welcome_watched_seconds: 0, welcome_completed_at: now, reading_ack_at: now,
    }));
  } else {
    let q = sb.from("enrollments").select("*, program:programs(*)").eq("learner_id", mode.learnerId);
    if (programId) q = q.eq("program_id", programId);
    const { data: rows, error } = await q;
    if (error) throw error;
    enrollments = rows.filter((e) => e.program && e.program.status !== "draft"); // learners never see drafts
  }

  const programIds = enrollments.map((e) => e.program_id);
  const enrollmentIds = enrollments.map((e) => e.id).filter(Boolean);
  if (!programIds.length) return [];

  const none = Promise.resolve({ data: [] });
  const [{ data: steps }, { data: progress }, { data: uploads }] = await Promise.all([
    sb.from("program_steps").select("*").in("program_id", programIds).order("position"),
    enrollmentIds.length ? sb.from("step_progress").select("*").in("enrollment_id", enrollmentIds) : none,
    enrollmentIds.length
      ? sb.from("uploads").select("*").in("enrollment_id", enrollmentIds).order("uploaded_at", { ascending: false })
      : none,
  ]);
  const stepIds = (steps ?? []).map((s) => s.id);
  // Only links for steps that are open come back (the database hides the rest)
  const { data: links } = stepIds.length
    ? await sb.from("step_links").select("step_id, url").in("step_id", stepIds)
    : { data: [] };
  const linkByStep = Object.fromEntries((links ?? []).map((l) => [l.step_id, l.url]));

  return enrollments.map((e) => {
    const mySteps = (steps ?? []).filter((s) => s.program_id === e.program_id);
    const progressByStep = Object.fromEntries((progress ?? []).filter((p) => p.enrollment_id === e.id).map((p) => [p.step_id, p]));
    const uploadsByStep = {};
    for (const u of (uploads ?? []).filter((u) => u.enrollment_id === e.id)) (uploadsByStep[u.step_id] ??= []).push(u);
    const view = { ...e, steps: mySteps, progressByStep, uploadsByStep, linkByStep };
    view.steps = mySteps.map((s) => ({ ...s, state: stepState(s, view) }));
    const required = view.steps.filter((s) => s.is_required);
    view.done = required.filter((s) => s.state.key === "done").length;
    view.total = required.length;
    view.pct = view.total ? Math.round((view.done / view.total) * 100) : 0;
    view.dueDate = e.due_date_override ?? e.program.due_date;
    return view;
  });
}

const gatesPassed = (e) =>
  (!e.program.welcome_video_path || e.welcome_completed_at) &&
  (!e.program.required_reading || e.reading_ack_at);

// What a step looks like to the learner right now
function stepState(step, e) {
  const p = e.progressByStep[step.id];
  const latestUpload = e.uploadsByStep[step.id]?.[0];
  if (p?.status === "completed") return { key: "done", label: "Completed" };

  const status = e.program.status;
  if (status === "scheduled") return { key: "locked", label: "Opens When The Program Starts" };
  if (status === "on_hold") return { key: "locked", label: "Paused: The Program Is On Hold" };
  if (status === "completed" || status === "archived") return { key: "locked", label: "Closed: The Program Has Ended" };
  if (!gatesPassed(e)) {
    return { key: "locked", label: e.program.welcome_video_path && !e.welcome_completed_at
      ? "Watch The Welcome Video First" : "Read The Required Reading First" };
  }
  if (step.unlock_at && new Date(step.unlock_at) > new Date()) return { key: "locked", label: `Opens ${fmtDateTime(step.unlock_at)}` };
  if (step.step_type === "upload" && latestUpload?.status === "pending") return { key: "review", label: "Waiting For L&D Review" };
  if (step.step_type === "upload" && latestUpload?.status === "rejected") return { key: "redo", label: "Returned: Please Upload Again" };
  if (p?.status === "in_progress") return { key: "open", label: "In Progress" };
  return { key: "open", label: "Ready To Start" };
}

// "Due in 3 days" / "Overdue by 2 days" / "Due 30 Nov 2026"
function dueInfo(value, done = false) {
  if (!value || done) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59`) : new Date(value);
  const days = Math.ceil((d - Date.now()) / DAY);
  if (days < 0) return { cls: "crit", text: `Overdue By ${-days} Day${days === -1 ? "" : "s"}` };
  if (days === 0) return { cls: "crit", text: "Due Today" };
  if (days <= 7) return { cls: "warn", text: `Due In ${days} Day${days === 1 ? "" : "s"}` };
  return { cls: "", text: `Due ${fmtDate(value)}` };
}
const duePill = (info) => (info ? `<span class="pill ${info.cls}">${esc(info.text)}</span>` : "");

// =====================================================================
// Dashboard
// =====================================================================
async function dashboard(main) {
  main.innerHTML = `
    <header class="topbar"><div><h1>My Learning</h1><p>Welcome, ${esc(mode.name.split(" ")[0])}. Here's where you are with each program.</p></div></header>
    <div id="dash"><div class="empty"><div>Loading…</div></div></div>`;
  const box = main.querySelector("#dash");

  let list;
  try {
    list = await loadEnrollments();
  } catch (err) {
    box.innerHTML = `<div class="empty"><div><strong>Couldn't Load Your Programs</strong>${esc(err.message)}</div></div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="empty"><div><strong>No Programs Yet</strong>Programs will appear here once the L&amp;D team enrolls you.</div></div>';
    return;
  }

  const active = list.filter((e) => !["completed", "archived"].includes(e.program.status));
  const finished = list.filter((e) => ["completed", "archived"].includes(e.program.status));

  // Things needing attention across all programs
  const now = Date.now();
  const attention = [];
  for (const e of active) {
    for (const s of e.steps) {
      if (s.state.key === "done") continue;
      const info = dueInfo(s.due_at);
      if (info && info.cls) attention.push({ e, s, info, when: new Date(s.due_at).getTime() });
      if (s.state.key === "redo") attention.push({ e, s, info: { cls: "crit", text: "Upload Returned" }, when: 0 });
    }
    const pInfo = dueInfo(e.dueDate, e.pct === 100);
    if (pInfo && pInfo.cls) attention.push({ e, s: null, info: pInfo, when: new Date(e.dueDate).getTime() });
  }
  attention.sort((a, b) => a.when - b.when);

  const sessions = active.flatMap((e) => e.steps
    .filter((s) => s.step_type === "ilt_session" && s.session_start && new Date(s.session_end ?? s.session_start).getTime() > now)
    .map((s) => ({ e, s })))
    .sort((a, b) => new Date(a.s.session_start) - new Date(b.s.session_start))
    .slice(0, 5);

  const totalDone = list.reduce((n, e) => n + e.done, 0);
  const totalSteps = list.reduce((n, e) => n + e.total, 0);

  box.innerHTML = `
    <div class="kpi-row">
      <div class="card kpi"><span class="label">Programs</span><b>${active.length}</b><span class="muted">in progress</span></div>
      <div class="card kpi"><span class="label">Steps Completed</span><b>${totalDone}<small> / ${totalSteps}</small></b><span class="muted">across all programs</span></div>
      <div class="card kpi ${attention.length ? "warn" : ""}"><span class="label">Need Attention</span><b>${attention.length}</b><span class="muted">due soon, overdue or returned</span></div>
    </div>

    <div class="learn-grid">
      <div class="stack">
        ${active.length ? active.map(programCard).join("") : '<div class="empty"><div><strong>Nothing In Progress</strong>You have finished all your current programs.</div></div>'}
        ${finished.length ? `<h2 class="section-title">Finished</h2>${finished.map(programCard).join("")}` : ""}
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>Needs Attention</h2></div>
          ${attention.length ? `<ul class="mini-list">${attention.slice(0, 8).map(({ e, s, info }) => `
            <li><a href="${mode.base}/${e.program_id}">${esc(s ? s.title : e.program.title)}</a>
              <span class="muted">${esc(s ? e.program.title : "Program deadline")}</span>${duePill(info)}</li>`).join("")}</ul>`
            : '<p class="muted">You\'re on track. Nothing is due in the next 7 days.</p>'}
        </div>
        <div class="card">
          <div class="card-head"><h2>Upcoming Live Sessions</h2></div>
          ${sessions.length ? `<ul class="mini-list">${sessions.map(({ e, s }) => `
            <li><a href="${mode.base}/${e.program_id}">${esc(s.title)}</a>
              <span class="muted">${esc(fmtDateTime(s.session_start))}</span>
              ${e.linkByStep[s.id] ? `<a class="pill good" href="${esc(e.linkByStep[s.id])}" target="_blank" rel="noopener">Join On Teams</a>` : '<span class="pill">Link Opens On The Day</span>'}</li>`).join("")}</ul>`
            : '<p class="muted">No live sessions coming up.</p>'}
        </div>
      </div>
    </div>`;
}

function programCard(e) {
  const next = e.steps.find((s) => s.is_required && s.state.key !== "done");
  const info = dueInfo(e.dueDate, e.pct === 100);
  return `
    <a class="card program-card" href="${mode.base}/${e.program_id}">
      <div class="program-card-top">
        <div>
          <div class="step-type">${esc(PROGRAM_TYPE[e.program.program_type])}</div>
          <h2>${esc(e.program.title)}</h2>
        </div>
        <div class="ring" style="--p:${e.pct}"><span>${e.pct}%</span></div>
      </div>
      <div class="program-card-meta">
        <span>${e.done} of ${e.total} steps done</span>
        ${duePill(info)}
        ${e.program.status === "on_hold" ? '<span class="pill warn">On Hold</span>' : ""}
        ${e.program.status === "scheduled" ? '<span class="pill prog">Starting Soon</span>' : ""}
      </div>
      ${next ? `<div class="next-up">Next: <strong>${esc(next.title)}</strong> <span class="muted">· ${esc(next.state.label)}</span></div>`
        : e.total ? '<div class="next-up good">All Steps Complete 🎉</div>' : ""}
    </a>`;
}

// =====================================================================
// Program page
// =====================================================================
async function programPage(main, ctx, programId) {
  main.innerHTML = '<div class="empty" style="margin-top:24px"><div>Loading…</div></div>';
  let e;
  try {
    [e] = await loadEnrollments(programId);
  } catch (err) {
    main.innerHTML = `<div class="empty" style="margin-top:24px"><div><strong>Couldn't Load This Program</strong>${esc(err.message)}</div></div>`;
    return;
  }
  if (!e) {
    main.innerHTML = `
      <header class="topbar"><div><a class="back-link" href="${mode.base}">${icons.back} My Learning</a><h1>Program Not Available</h1></div></header>
      <div class="empty"><div>You're not enrolled in this program, or it hasn't started yet.</div></div>`;
    return;
  }

  const reload = () => programPage(main, ctx, programId);
  const p = e.program;
  const info = dueInfo(e.dueDate, e.pct === 100);
  const needVideo = p.welcome_video_path && !e.welcome_completed_at;
  const needReading = p.required_reading && !e.reading_ack_at;
  const objectives = (p.objectives ?? "").split(/\r?\n/).map((l) => l.replace(/^[-•*\d.)\s]+/, "").trim()).filter(Boolean);
  const firstName = mode.name.split(" ")[0];
  const greeting = e.pct === 100 ? `Well Done, ${esc(firstName)} <span class="wave">🎉</span>`
    : e.pct > 0 ? `Welcome Back, ${esc(firstName)}` : `Welcome, ${esc(firstName)} <span class="wave">👋</span>`;
  const eyebrow = e.pct === 100 ? "Program Complete" : e.pct > 0 ? "Keep Going" : "Your Program Starts Here";
  const shortDate = (v) => new Date(`${v}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const nextStep = e.steps.find((s) => ["open", "redo"].includes(s.state.key)) ?? e.steps.find((s) => s.state.key !== "done");
  const nowIndex = e.steps.indexOf(nextStep);
  const doneCount = e.steps.filter((s) => s.state.key === "done").length;
  const letter = (p.welcome_message ?? "").split(/\n\s*\n|\r?\n/).map((l) => l.trim()).filter(Boolean);
  const points = (p.required_reading ?? "").split(/\r?\n/).map((l) => l.replace(/^[-•*\d.)\s]+/, "").trim()).filter(Boolean);
  const cta = needVideo ? "Watch The Welcome Video" : needReading ? "Read Before You Begin"
    : e.pct === 100 ? "Review Your Journey" : e.pct > 0 ? "Continue Your Journey" : "Start Your Journey";

  main.innerHTML = `<div data-root>
    <a class="back-link page-back reveal" href="${mode.base}">${icons.back} My Learning</a>

    ${p.status === "draft" ? '<div class="notice info" style="margin-top:10px">This program is a draft. Learners can\'t see it until it\'s scheduled or live.</div>' : ""}
    ${p.status === "on_hold" ? '<div class="notice" style="margin-top:10px">This program is on hold. Steps are paused until the L&amp;D team resumes it.</div>' : ""}
    ${p.status === "scheduled" ? `<div class="notice info" style="margin-top:10px">This program starts ${p.start_date ? esc(fmtDate(p.start_date)) : "soon"}. Steps open once it begins.</div>` : ""}

    <section class="hero reveal" style="--i:1">
      <div class="aurora"><span></span><span></span><span></span></div>
      <div class="hero-grid ${p.welcome_video_path ? "" : "single"}">
        <div>
          <div class="hero-top">
            <span class="eyebrow"><i></i> ${eyebrow}</span>
            <div class="ring anim big" style="--p:${e.pct}"><span>${e.pct}%</span></div>
          </div>
          <h1>${greeting}</h1>
          <div class="program-name">You're enrolled in <b>${esc(p.title)}</b></div>
          <div class="chips">
            ${p.start_date ? `<span class="chip">${icons.calendar} Starts ${esc(shortDate(p.start_date))}</span>` : ""}
            ${e.dueDate ? `<span class="chip ${info?.cls ?? ""}">${icons.flag} ${info?.cls ? esc(info.text) : `Due ${esc(shortDate(e.dueDate))}`}</span>` : ""}
            <span class="chip">${icons.route} ${e.steps.length} Step${e.steps.length === 1 ? "" : "s"} · ${esc(PROGRAM_TYPE[p.program_type])}</span>
          </div>
          <div class="hero-actions">
            <button class="btn light" data-cta>${esc(cta)} →</button>
            <button class="btn glass" data-message>${icons.messages} Message L&amp;D</button>
          </div>
        </div>
        ${p.welcome_video_path ? `
          <div data-video-area>
            <div class="video-card">
              <video data-welcome playsinline controls controlslist="nodownload noplaybackrate" disablepictureinpicture preload="metadata"></video>
            </div>
            ${needVideo ? `
              <div class="video-meter"><i data-watch-bar></i></div>
              <div class="video-hint" data-watch-text>Watch the full video to unlock your learning journey.</div>`
              : '<div class="video-hint done">✓ Welcome video watched. Replay it any time.</div>'}
          </div>` : ""}
      </div>
      ${letter.length ? `
        <div class="letter">
          ${letter.map((l) => `<p>${esc(l)}</p>`).join("")}
          <div class="sign"><span class="mark">${icons.brand}</span> The L&amp;D Team</div>
        </div>` : ""}
    </section>

    ${e.steps.length ? `
      <section class="card glance reveal" style="--i:2">
        <div class="card-head"><h2>Your Journey At A Glance</h2><span class="muted small">${doneCount} of ${e.steps.length} step${e.steps.length === 1 ? "" : "s"} done</span></div>
        <div class="track" style="--n:${e.steps.length}; --fill:${e.steps.length > 1 ? (Math.max(0, nowIndex === -1 ? e.steps.length - 1 : nowIndex) / (e.steps.length - 1)) * (100 - 100 / e.steps.length) : 0}%">
          <div class="fill"></div>
          ${e.steps.map((s, i) => `
            <button type="button" class="milestone ${s.state.key === "done" ? "done" : i === nowIndex ? "now" : ""}" data-goto="${s.id}">
              <span class="dot">${s.state.key === "done" ? icons.check : stepIcon(s.step_type)}</span>
              <span>${esc(s.title)}</span>
              <small>${s.state.key === "done" ? "Done" : i === nowIndex ? "You Are Here" : s.state.key === "locked" ? "Locked" : "Ready"}</small>
            </button>`).join("")}
        </div>
      </section>` : ""}

    ${p.overview || objectives.length ? `
      <section class="card reveal" style="--i:3; margin-top:16px">
        <div class="card-head"><h2>About This Program</h2></div>
        ${p.overview ? `<div class="prose-text">${esc(p.overview)}</div>` : ""}
        ${objectives.length ? `<h3 class="sub-title">What You'll Be Able To Do</h3><ul class="objectives">${objectives.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : ""}
      </section>` : ""}

    ${p.required_reading ? `
      <section class="card begin reveal ${needReading && !needVideo ? "gate" : ""}" style="--i:4; margin-top:16px" data-begin>
        <div class="confetti" data-confetti></div>
        <div class="head">
          <div class="badge">${icons.review}</div>
          <div><h2>Before You Begin</h2><div class="muted small">A few things to know so your progress counts.</div></div>
        </div>
        ${points.length > 1 ? `<ol class="points">${points.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>` : `<div class="prose-text">${esc(p.required_reading)}</div>`}
        <div class="ack-row">
          ${e.reading_ack_at
            ? `<button class="btn ack done" disabled>${icons.check.replace("<svg", '<svg class="tick"')}<span>Read And Understood</span></button>`
            : `<button class="btn primary ack" data-ack ${needVideo ? "disabled" : ""}>${icons.check.replace("<svg", '<svg class="tick"')}<span>I Have Read And Understood This</span></button>`}
          <button class="link-remark" data-remark="reading">${icons.messages} Questions About This? Leave A Remark</button>
        </div>
        ${needVideo ? '<p class="muted small" style="margin:10px 0 0">Watch the welcome video first.</p>' : ""}
        <div class="remark flat" data-panel="reading"><div><div class="remark-box"></div></div></div>
      </section>` : ""}

    <section class="reveal" style="--i:5" data-journey>
      <h2 class="section-title" style="margin-top:22px">Learning Journey</h2>
      ${e.steps.length ? `<ol class="steps learner">${e.steps.map((s, i) => learnerStep(s, i, e)).join("")}</ol>`
        : '<div class="empty"><div>The L&amp;D team hasn\'t added any steps yet.</div></div>'}
    </section>
  </div>`;
  const root = main.querySelector("[data-root]");

  // Welcome video (no skipping ahead; progress is saved)
  const video = main.querySelector("[data-welcome]");
  if (video) setUpVideo(video, e, needVideo && !mode.preview, reload);

  const scrollTo = (el) => el?.scrollIntoView({ behavior: "smooth", block: "center" });
  main.querySelector("[data-cta]").addEventListener("click", () => {
    if (needVideo && video) { scrollTo(video); video.play().catch(() => {}); return; }
    if (needReading) return scrollTo(main.querySelector("[data-begin]"));
    scrollTo(nextStep ? main.querySelector(`[data-step-card="${nextStep.id}"]`) : main.querySelector("[data-journey]"));
  });
  main.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => scrollTo(main.querySelector(`[data-step-card="${b.dataset.goto}"]`))));
  main.querySelector("[data-message]").addEventListener("click", () => (mode.preview ? previewOnly() : newMessage(ctx.me, p.id)));

  main.querySelector("[data-ack]")?.addEventListener("click", async (ev) => {
    if (mode.preview) return previewOnly();
    const btn = ev.currentTarget;
    btn.disabled = true;
    const { error } = await sb.rpc("acknowledge_reading", { p_program: p.id });
    if (error) { toast(error.message, "err"); btn.disabled = false; return; }
    btn.classList.add("done");
    btn.classList.remove("primary");
    btn.querySelector("span").textContent = "Read And Understood";
    celebrate(main.querySelector("[data-confetti]"));
    toast("Thanks! Your learning journey is open.");
    setTimeout(reload, 1300);
  });

  // "Leave A Remark" on the reading and on every step → the L&D Messages inbox
  root.addEventListener("click", async (ev) => {
    const open = ev.target.closest("[data-remark]");
    const cancel = ev.target.closest("[data-remark-cancel]");
    const send = ev.target.closest("[data-remark-send]");
    if (open) {
      const key = open.dataset.remark;
      const panel = main.querySelector(`[data-panel="${key}"]`);
      const about = key === "reading" ? "Before You Begin" : e.steps.find((s) => s.id === key)?.title ?? "";
      const box = panel.querySelector(".remark-box");
      if (!panel.classList.contains("open")) {
        box.innerHTML = `
          <p>Your remark about <b>${esc(about)}</b> goes straight to the L&amp;D team's inbox. You'll see their reply in Messages.</p>
          <textarea class="input prose short" placeholder="Share a question, feedback or a problem…"></textarea>
          <div class="row"><button type="button" class="btn" data-remark-cancel>Cancel</button><button type="button" class="btn primary" data-remark-send="${esc(key)}">Send To L&amp;D</button></div>`;
        setTimeout(() => box.querySelector("textarea")?.focus(), 300);
      }
      panel.classList.toggle("open");
    }
    if (cancel) cancel.closest(".remark").classList.remove("open");
    if (send) {
      if (mode.preview) return previewOnly();
      const box = send.closest(".remark-box");
      const text = box.querySelector("textarea").value.trim();
      if (!text) return toast("Write your remark first.", "err");
      const key = send.dataset.remarkSend;
      const about = key === "reading" ? "Before You Begin" : e.steps.find((s) => s.id === key)?.title ?? "";
      send.disabled = true;
      try {
        await sendRemark(ctx.me, p.id, about, text);
        box.innerHTML = `<div class="remark-sent">${icons.check} Sent to the L&amp;D team. You'll see their reply in Messages.</div>`;
        toast("Remark sent to the L&D team.");
        setTimeout(() => box.closest(".remark")?.classList.remove("open"), 2600);
      } catch (err) {
        toast(err.message, "err");
        send.disabled = false;
      }
    }
  });

  main.querySelector(".steps")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const step = e.steps.find((s) => s.id === btn.dataset.step);
    if (mode.preview && btn.dataset.act !== "view-file" && btn.dataset.act !== "join") return previewOnly();
    if (btn.dataset.act === "join" && mode.preview) return;
    if (btn.dataset.act === "survey-done") surveyDone(step, reload);
    if (btn.dataset.act === "upload") uploadFile(step, e, reload);
    if (btn.dataset.act === "view-file") viewFile(btn.dataset.path);
    if (btn.dataset.act === "join") sb.rpc("start_step", { p_step: step.id }).then(() => {});
  });
}

// A remark becomes a conversation in the L&D Messages inbox
async function sendRemark(me, programId, about, text) {
  const { data: thread, error } = await sb.from("message_threads")
    .insert({ learner_id: me.id, program_id: programId, subject: `Remark: ${about}`.slice(0, 120) })
    .select("id").single();
  if (error) throw error;
  const { error: msgErr } = await sb.from("thread_messages").insert({ thread_id: thread.id, body: text });
  if (msgErr) throw msgErr;
}

// A small burst of colour when the learner confirms the reading
function celebrate(box) {
  if (!box || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#4fb3b8", "#2a7fc0", "#6db59e", "#e6a532"];
  box.innerHTML = Array.from({ length: 22 }, (_, i) => `<i style="left:${14 + Math.random() * 22}%;background:${colors[i % 4]};--x:${Math.round(Math.random() * 260 - 60)}px;--y:${Math.round(-60 - Math.random() * 120)}px;--r:${Math.round(Math.random() * 540)}deg;animation-delay:${(Math.random() * 0.15).toFixed(2)}s"></i>`).join("");
}

function learnerStep(s, i, e) {
  const st = s.state;
  const url = e.linkByStep[s.id];
  const p = e.progressByStep[s.id];
  const ups = e.uploadsByStep[s.id] ?? [];
  const info = dueInfo(s.due_at, st.key === "done");
  const open = st.key === "open" || st.key === "redo";
  const base = `${mode.base}/${e.program_id}`;

  let action = "";
  if (open || (st.key === "done" && s.step_type === "module")) {
    if (s.step_type === "module") {
      action = url ? `<a class="btn ${st.key === "done" ? "" : "primary"}" href="${base}/module/${s.id}">${st.key === "done" ? "Review Module" : p?.status === "in_progress" ? "Continue Module" : "Start Module"}</a>`
        : '<span class="muted">The module link isn\'t ready yet.</span>';
    }
  }
  if (open) {
    if (s.step_type === "ilt_session") {
      action = url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener" data-act="join" data-step="${s.id}">Join On Teams</a>` : "";
    }
    if (s.step_type === "assessment") action = `<a class="btn primary" href="${base}/assessment/${s.id}">${p ? "Try Again" : "Start Assessment"}</a>`;
    if (s.step_type === "survey") {
      action = `${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open Survey</a>` : ""}
        <button class="btn primary" data-act="survey-done" data-step="${s.id}">I've Completed It</button>`;
    }
    if (s.step_type === "upload") action = `<button class="btn primary" data-act="upload" data-step="${s.id}">${icons.upload} Upload PDF</button>`;
  }

  const stateClass = { done: "good", review: "prog", redo: "crit", locked: "", open: "teal" }[st.key];
  const sessionLine = s.step_type === "ilt_session" && s.session_start
    ? `<div class="step-meta">Session: ${esc(fmtDateTime(s.session_start))}${s.session_end ? ` – ${esc(new Date(s.session_end).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}` : ""}</div>` : "";
  const score = p?.score != null && ["module", "assessment"].includes(s.step_type) ? `<span class="pill">Score ${Number(p.score)}%</span>` : "";
  const latest = ups[0];

  return `
    <li class="step-wrap" data-step-card="${s.id}">
    <div class="step ${st.key}">
      <div class="step-num"><span>${st.key === "done" ? "✓" : i + 1}</span></div>
      <div class="step-icon">${st.key === "locked" ? icons.lock : stepIcon(s.step_type)}</div>
      <div class="step-body">
        <div class="step-type">${esc(STEP_TYPE[s.step_type].short)}${s.is_required ? "" : " · Optional"}</div>
        <strong>${esc(s.title)}</strong>
        ${sessionLine}
        ${s.description && st.key !== "locked" ? `<div class="step-desc">${esc(s.description)}</div>` : ""}
        <div class="step-flags">
          <span class="pill ${stateClass}">${esc(st.label)}</span>${score}${duePill(info)}
          ${s.step_type === "ilt_session" && open ? '<span class="muted small">Attendance is recorded by L&amp;D.</span>' : ""}
        </div>
        ${latest ? `<div class="upload-line">
            <button class="link-btn dark" data-act="view-file" data-path="${esc(latest.file_path)}">${esc(latest.file_name)}</button>
            <span class="muted">uploaded ${esc(fmtDate(latest.uploaded_at))}</span>
            ${latest.status === "rejected" && latest.review_comment ? `<div class="notice">L&amp;D: ${esc(latest.review_comment)}</div>` : ""}
          </div>` : ""}
      </div>
      <div class="step-actions stacked">
        ${action}
        <button type="button" class="remark-btn" data-remark="${s.id}">${icons.messages} Leave A Remark</button>
      </div>
    </div>
    <div class="remark" data-panel="${s.id}"><div><div class="remark-box"></div></div></div>
    </li>`;
}

function setUpVideo(video, e, gated, reload) {
  let maxWatched = Number(e.welcome_watched_seconds) || 0;
  let lastSaved = maxWatched;
  let finished = !gated;
  const area = video.closest("[data-video-area]") ?? video.parentElement;
  const bar = area.querySelector("[data-watch-bar]");
  const text = area.querySelector("[data-watch-text]");

  sb.storage.from(VIDEO_BUCKET).createSignedUrl(e.program.welcome_video_path, 4 * 3600).then(({ data }) => {
    if (data?.signedUrl) video.src = data.signedUrl;
    else toast("The welcome video couldn't be loaded. Please refresh the page.", "err");
  });

  const showProgress = () => {
    if (!bar || !video.duration) return;
    const pct = Math.min(100, (maxWatched / video.duration) * 100);
    bar.style.width = `${pct}%`;
    text.textContent = `${Math.round(pct)}% watched`;
  };
  const save = async (force = false) => {
    if (mode.preview || finished || !video.duration) return;
    if (!force && maxWatched - lastSaved < 5) return;
    lastSaved = maxWatched;
    const { data: done } = await sb.rpc("record_video_progress", {
      p_program: e.program_id, p_seconds: maxWatched, p_duration: video.duration,
    });
    if (done) {
      finished = true;
      toast("Thanks for watching! The next part is open.");
      reload();
    }
  };

  video.addEventListener("loadedmetadata", () => {
    if (gated && maxWatched > 1 && maxWatched < video.duration - 1) video.currentTime = maxWatched;
    showProgress();
  });
  video.addEventListener("timeupdate", () => {
    if (!video.seeking && video.currentTime > maxWatched && video.currentTime - maxWatched < 3) maxWatched = video.currentTime;
    showProgress();
    save();
  });
  video.addEventListener("seeking", () => {
    if (gated && !finished && video.currentTime > maxWatched + 1) video.currentTime = maxWatched;
  });
  video.addEventListener("pause", () => save(true));
  video.addEventListener("ended", () => { maxWatched = video.duration; save(true); });
}

function surveyDone(step, reload) {
  openModal({
    title: "Completed The Survey?",
    intro: "Only confirm once you've submitted your answers in the survey.",
    body: "",
    submitLabel: "Yes, I've Submitted It",
    onSubmit: async () => {
      const { error } = await sb.rpc("complete_step", { p_step: step.id });
      if (error) throw error;
      toast("Survey marked as completed.");
      reload();
    },
  });
}

function uploadFile(step, e, reload) {
  const { form } = openModal({
    title: `Upload: ${step.title}`,
    intro: step.description ? esc(step.description) : "Upload your file as a PDF. The L&amp;D team will check it before it counts toward your completion.",
    body: `
      <label class="dropzone">
        ${icons.upload}
        <strong data-file-name>Choose A PDF</strong>
        <span class="muted">PDF only · up to ${MAX_PDF_MB} MB</span>
        <input type="file" name="file" accept="application/pdf,.pdf" hidden>
      </label>`,
    submitLabel: "Upload",
    onSubmit: async (f) => {
      const file = f.file.files[0];
      if (!file) throw new Error("Choose a PDF first.");
      if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) throw new Error("Please upload a PDF file.");
      if (file.size > MAX_PDF_MB * 1024 * 1024) throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_PDF_MB} MB.`);

      // A returned (rejected) file is replaced, which frees its storage
      const rejected = (e.uploadsByStep[step.id] ?? []).filter((u) => u.status === "rejected").map((u) => u.file_path);
      if (rejected.length) await sb.storage.from(UPLOAD_BUCKET).remove(rejected);

      const safe = file.name.replace(/[^\w.-]+/g, "_");
      const path = `${e.id}/${step.id}/${Date.now()}-${safe}`;
      const { error: upErr } = await sb.storage.from(UPLOAD_BUCKET).upload(path, file, { contentType: "application/pdf" });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
      const { error } = await sb.from("uploads").insert({
        enrollment_id: e.id, step_id: step.id, file_path: path, file_name: file.name, size_bytes: file.size,
      });
      if (error) {
        await sb.storage.from(UPLOAD_BUCKET).remove([path]);
        throw error;
      }
      toast("Uploaded. The L&D team will review it.");
      reload();
    },
  });
  form.file.addEventListener("change", () => {
    form.querySelector("[data-file-name]").textContent = form.file.files[0]?.name ?? "Choose A PDF";
  });
}

async function viewFile(path) {
  const { data, error } = await sb.storage.from(UPLOAD_BUCKET).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) return toast("That file is no longer available.", "err");
  window.open(data.signedUrl, "_blank", "noopener");
}

// =====================================================================
// Module player: the module runs inside the Companion and reports completion
// =====================================================================
async function modulePlayer(main, ctx, programId, stepId) {
  const back = `${mode.base}/${programId}`;
  const [{ data: step }, { data: link }, { data: enrollment }] = await Promise.all([
    sb.from("program_steps").select("*").eq("id", stepId).maybeSingle(),
    sb.from("step_links").select("url").eq("step_id", stepId).maybeSingle(),
    mode.learnerId
      ? sb.from("enrollments").select("id").eq("program_id", programId).eq("learner_id", mode.learnerId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!step || step.step_type !== "module" || (!enrollment && !mode.preview)) { location.hash = back; return; }
  if (!link?.url) {
    main.innerHTML = `
      <header class="topbar"><div><a class="back-link" href="${back}">${icons.back} Back To Program</a><h1>${esc(step.title)}</h1></div></header>
      <div class="empty"><div><strong>This Module Isn't Open Yet</strong>Check its “opens” date on the program page.</div></div>`;
    return;
  }

  const { data: progress } = enrollment
    ? await sb.from("step_progress").select("status, score").eq("enrollment_id", enrollment.id).eq("step_id", stepId).maybeSingle()
    : { data: null };
  let done = progress?.status === "completed";

  main.innerHTML = `
    <header class="topbar compact">
      <div>
        <a class="back-link" href="${back}">${icons.back} Back To Program</a>
        <h1>${esc(step.title)}</h1>
      </div>
      <div class="top-actions">
        <span class="pill ${done ? "good" : "teal"}" data-module-status>${done ? "Completed" : "In progress"}</span>
        <button class="btn primary" data-fullscreen>${icons.expand} Full Screen</button>
      </div>
    </header>
    <p class="muted module-note">Your completion is recorded automatically when you finish the module. Keep this page open while you work through it.</p>
    <div class="module-frame" data-frame>
      <button class="btn sm module-exit" data-exit hidden>${icons.collapse} Exit Full Screen</button>
      <iframe title="${esc(step.title)}" allow="fullscreen; autoplay" referrerpolicy="strict-origin-when-cross-origin"></iframe>
    </div>`;

  if (!done && !mode.preview) sb.rpc("start_step", { p_step: stepId }).then(() => {});

  const frame = main.querySelector("iframe");
  const moduleOrigin = new URL(link.url).origin;
  const statusPill = main.querySelector("[data-module-status]");

  const recordCompletion = async (rawScore) => {
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, rawScore)) : null;
    if (mode.preview) {
      toast(`The module was completed${score === null ? "" : ` with a score of ${score}%`}. In the learner view nothing is recorded.`);
      return;
    }
    const { error } = await sb.rpc("complete_step", { p_step: stepId, p_score: score });
    if (error) return toast(`Couldn't record your completion: ${error.message}`, "err");
    if (!done) toast("Module completed. Well done!");
    done = true;
    statusPill.className = "pill good";
    statusPill.textContent = "Completed";
  };

  // 1) Modules on the same website: watch for the final-screen words
  const stopWatching = watchForFinalScreen(frame, step.completion_text, recordCompletion);

  // 2) Modules that include module-bridge.js report completion themselves
  const onMessage = (ev) => {
    if (ev.source !== frame.contentWindow || ev.origin !== moduleOrigin || !ev.data?.type) return;
    if (ev.data.type === "lc:hello") ev.source.postMessage({ type: "lc:welcome", learner: mode.name }, ev.origin);
    if (ev.data.type === "lc:complete") recordCompletion(ev.data.score);
  };
  window.addEventListener("message", onMessage);

  // Stop listening when the learner leaves this page
  const stopFullScreen = setUpFullScreen(main);
  window.addEventListener("hashchange", () => {
    window.removeEventListener("message", onMessage);
    stopWatching();
    stopFullScreen();
  }, { once: true });
  frame.src = link.url;
}

// Looks at what the learner can see in the module. When the final-screen words
// appear, reports completion with any score shown on that screen.
// Works when the module and the Companion are on the same website (same GitHub account).
function watchForFinalScreen(frame, words, onFinish) {
  const target = (words ?? "").trim().toLowerCase();
  if (!target) return () => {};
  let observer = null;
  let timer = null;
  let pending = null;
  let finished = false;

  const visibleText = (doc) => doc.body?.innerText ?? "";
  const check = (doc) => {
    if (finished || !visibleText(doc).toLowerCase().includes(target)) return;
    finished = true;
    // Give the final screen a moment to show its score
    setTimeout(() => onFinish(findScore(visibleText(doc))), 800);
  };
  const attach = () => {
    let doc;
    try { doc = frame.contentDocument; } catch { doc = null; } // a different website: can't look inside
    observer?.disconnect();
    clearInterval(timer);
    if (!doc?.body) return;
    observer = new MutationObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(() => check(doc), 400);
    });
    observer.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true });
    timer = setInterval(() => check(doc), 2000); // catches screens shown purely by styling
    check(doc);
  };
  frame.addEventListener("load", attach);
  return () => {
    observer?.disconnect();
    clearInterval(timer);
    clearTimeout(pending);
    frame.removeEventListener("load", attach);
  };
}

// "Score: 85%", "Your score is 17/20", "17 out of 20" → 85
function findScore(text) {
  const pct = text.match(/score[^\d%]{0,40}(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (pct) return Number(pct[1]);
  const frac = text.match(/score[^\d]{0,40}(\d+)\s*(?:\/|out of)\s*(\d+)/i) ?? text.match(/(\d+)\s*out of\s*(\d+)/i);
  if (frac && Number(frac[2]) > 0) return Math.round((Number(frac[1]) / Number(frac[2])) * 1000) / 10;
  return null;
}

// Full screen for the module: the browser's own full screen where it's allowed,
// otherwise the module fills the window (e.g. on iPhone)
function setUpFullScreen(main) {
  const wrap = main.querySelector("[data-frame]");
  const exitBtn = wrap.querySelector("[data-exit]");
  const request = wrap.requestFullscreen ?? wrap.webkitRequestFullscreen;
  const nativeOn = () => (document.fullscreenElement ?? document.webkitFullscreenElement) === wrap;

  const expand = (on) => {
    wrap.classList.toggle("expanded", on);
    document.body.classList.toggle("no-scroll", on);
    sync();
  };
  const sync = () => { exitBtn.hidden = !(nativeOn() || wrap.classList.contains("expanded")); };
  const onKey = (e) => { if (e.key === "Escape" && wrap.classList.contains("expanded")) expand(false); };

  main.querySelector("[data-fullscreen]").addEventListener("click", () => {
    // Some browsers (and embedded views) refuse full screen quietly; fill the window instead
    try { request?.call(wrap)?.catch?.(() => {}); } catch { /* not allowed here */ }
    setTimeout(() => { if (!nativeOn()) expand(true); }, 400);
  });
  exitBtn.addEventListener("click", () => {
    if (nativeOn()) (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
    else expand(false);
  });
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync);
  document.addEventListener("keydown", onKey);

  return () => {
    if (nativeOn()) (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
    document.body.classList.remove("no-scroll");
    document.removeEventListener("fullscreenchange", sync);
    document.removeEventListener("webkitfullscreenchange", sync);
    document.removeEventListener("keydown", onKey);
  };
}

// =====================================================================
// Assessment (scored on the server; answers never reach the browser)
// =====================================================================
async function assessmentPage(main, ctx, programId, stepId) {
  const back = `${mode.base}/${programId}`;
  const [{ data: step }, { data: questions }, { data: enrollment }] = await Promise.all([
    sb.from("program_steps").select("*").eq("id", stepId).maybeSingle(),
    sb.from("assessment_questions").select("id, question, options, points").eq("step_id", stepId).order("position"),
    mode.learnerId
      ? sb.from("enrollments").select("id").eq("program_id", programId).eq("learner_id", mode.learnerId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!step || step.step_type !== "assessment" || (!enrollment && !mode.preview)) { location.hash = back; return; }
  const { data: progress } = enrollment
    ? await sb.from("step_progress").select("status, score").eq("enrollment_id", enrollment.id).eq("step_id", stepId).maybeSingle()
    : { data: null };

  const header = `
    <header class="topbar"><div>
      <a class="back-link" href="${back}">${icons.back} Back To Program</a>
      <h1>${esc(step.title)}</h1>
      <p>${questions?.length ?? 0} question${questions?.length === 1 ? "" : "s"}${step.passing_score != null ? ` · Pass mark ${Number(step.passing_score)}%` : ""}${progress?.score != null ? ` · Your best so far: ${Number(progress.score)}%` : ""}</p>
    </div></header>`;

  if (!questions?.length) {
    main.innerHTML = `${header}<div class="empty"><div><strong>This Assessment Isn't Open</strong>It may not have started yet, or the L&amp;D team is still preparing it.</div></div>`;
    return;
  }
  if (progress?.status === "completed") {
    main.innerHTML = `${header}<div class="card result good"><h2>You've Passed This Assessment</h2><p>Your score: <b>${Number(progress.score)}%</b></p><a class="btn" href="${back}">Back To Program</a></div>`;
    return;
  }

  main.innerHTML = `${header}
    <form class="stack assessment" novalidate>
      ${step.description ? `<div class="card prose-text">${esc(step.description)}</div>` : ""}
      ${questions.map((q, i) => `
        <fieldset class="card question">
          <legend><span class="q-no">${i + 1}</span> ${esc(q.question)}</legend>
          ${q.options.map((o, j) => `
            <label class="choice"><input type="radio" name="${q.id}" value="${j}"> <span>${esc(o)}</span></label>`).join("")}
        </fieldset>`).join("")}
      <div class="form-error" hidden></div>
      <div class="form-actions">${mode.preview
        ? '<span class="muted">Learner view: answers can\'t be submitted here.</span><button class="btn primary" type="submit" disabled>Submit Answers</button>'
        : '<button class="btn primary" type="submit">Submit Answers</button>'}</div>
    </form>`;

  const form = main.querySelector("form");
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const answers = {};
    const missing = [];
    questions.forEach((q, i) => {
      const picked = form.querySelector(`input[name="${q.id}"]:checked`);
      if (picked) answers[q.id] = Number(picked.value);
      else missing.push(i + 1);
    });
    const errorBox = form.querySelector(".form-error");
    if (missing.length) {
      errorBox.textContent = `Please answer question${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`;
      errorBox.hidden = false;
      return;
    }
    openModal({
      title: "Submit Your Answers?",
      intro: "You can't change them after submitting.",
      body: "",
      submitLabel: "Submit",
      onSubmit: async () => {
        const { data, error } = await sb.rpc("submit_assessment", { p_step: stepId, p_answers: answers });
        if (error) throw error;
        main.innerHTML = `${header}
          <div class="card result ${data.passed ? "good" : "warn"}">
            <h2>${data.passed ? "You passed!" : "Not quite there yet"}</h2>
            <p>Your score: <b>${Number(data.percent)}%</b> (${Number(data.score)} of ${Number(data.max_score)} points)</p>
            ${data.passed ? "" : `<p class="muted">You need ${Number(step.passing_score)}% to pass. Review the material and try again.</p>`}
            <div class="row-actions">
              <a class="btn ${data.passed ? "primary" : ""}" href="${back}">Back To Program</a>
              ${data.passed ? "" : '<button class="btn primary" data-retry>Try Again</button>'}
            </div>
          </div>`;
        main.querySelector("[data-retry]")?.addEventListener("click", () => assessmentPage(main, ctx, programId, stepId));
      },
    });
  });
}
