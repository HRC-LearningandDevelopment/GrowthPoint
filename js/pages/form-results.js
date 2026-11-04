// Results for one assessment (scores, attempts, Admin score changes) or survey
// (summary per question, every response, names only when shared).
//   #/programs/<program>/results/<step>
import { sb } from "../supabase.js";
import { esc, toast, openModal, icons, fmtDate, fmtDateTime, QTYPE, LIKERT, LIBS, loadScript, safeName } from "../ui.js";

export async function renderFormResults(main, program, stepId, me) {
  main.innerHTML = '<div class="empty" style="margin-top:24px"><div>Loading…</div></div>';
  const [{ data: step }, { data: questions }, { data: sections }, { data: enrolled }] = await Promise.all([
    sb.from("program_steps").select("*").eq("id", stepId).maybeSingle(),
    sb.from("assessment_questions").select("*, assessment_answer_keys(correct)").eq("step_id", stepId).order("position"),
    sb.from("form_sections").select("*").eq("step_id", stepId).order("position"),
    sb.from("enrollments").select("id, learner:profiles(full_name, email), enrollment_exclusions(step_id)").eq("program_id", program.id),
  ]);
  if (!step) { location.hash = `#/programs/${program.id}/journey`; return; }
  const reload = () => renderFormResults(main, program, stepId, me);
  const header = (title, sub, actions = "") => `
    <header class="topbar">
      <div>
        <a class="back-link" href="#/programs/${program.id}/journey">${icons.back} ${esc(program.title)}</a>
        <h1>${title}</h1><p>${sub}</p>
      </div>
      <div class="top-actions">${actions}
        <a class="btn" href="#/programs/${program.id}/form/${step.id}">Edit ${step.step_type === "assessment" ? "Assessment" : "Survey"}</a>
      </div>
    </header>`;
  const sectionTitle = Object.fromEntries((sections ?? []).map((s) => [s.id, s.title]));
  const ctx = { main, program, step, questions: questions ?? [], enrolled: (enrolled ?? [])
    .filter((e) => !(e.enrollment_exclusions ?? []).some((x) => x.step_id === stepId)) // only learners who have this step
    .sort((a, b) => a.learner.full_name.localeCompare(b.learner.full_name)), me, reload, header, sectionTitle };
  return step.step_type === "assessment" ? assessmentResults(ctx) : surveyResults(ctx);
}

const minutes = (a) => (a.started_at && a.submitted_at ? Math.max(0, Math.round((new Date(a.submitted_at) - new Date(a.started_at)) / 60000)) : null);
const STATUS = { submitted: "Submitted", manual: "Entered By Admin", expired: "Time Ran Out", in_progress: "In Progress" };

// =====================================================================
// Assessment
// =====================================================================
async function assessmentResults({ main, program, step, questions, enrolled, me, reload, header }) {
  const ids = enrolled.map((e) => e.id);
  const { data: attempts } = ids.length
    ? await sb.from("assessment_attempts").select("*, changer:profiles!assessment_attempts_changed_by_fkey(full_name)").eq("step_id", step.id).in("enrollment_id", ids).order("started_at")
    : { data: [] };
  const isAdmin = me.role === "admin";
  const done = (attempts ?? []).filter((a) => a.status !== "in_progress" && a.percent != null);

  const rows = enrolled.map((e) => {
    const mine = (attempts ?? []).filter((a) => a.enrollment_id === e.id);
    const finished = mine.filter((a) => a.status !== "in_progress" && a.percent != null);
    const best = finished.length ? Math.max(...finished.map((a) => Number(a.percent))) : null;
    const passed = finished.some((a) => a.passed);
    const result = passed ? "Passed" : finished.length ? "Not Passed" : mine.length ? "In Progress" : "Not Started";
    return { e, mine, finished, best, result, used: mine.filter((a) => a.status !== "manual").length, last: finished.at(-1)?.submitted_at };
  });
  const tried = rows.filter((r) => r.finished.length);
  const avgBest = tried.length ? Math.round(tried.reduce((a, r) => a + r.best, 0) / tried.length) : null;
  const passRate = tried.length ? Math.round((tried.filter((r) => r.result === "Passed").length / tried.length) * 100) : null;
  const times = done.map(minutes).filter((m) => m != null);
  const avgTime = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;

  // Per question: share of submitted attempts that earned the points
  const graded = done.filter((a) => a.results);
  const qStats = questions.map((q) => {
    const seen = graded.filter((a) => a.results[q.id] !== undefined);
    const right = seen.filter((a) => Number(a.results[q.id]) > 0).length;
    return { q, seen: seen.length, rate: seen.length ? Math.round((right / seen.length) * 100) : null };
  });

  const PILL = { Passed: "good", "Not Passed": "crit", "In Progress": "prog", "Not Started": "" };
  main.innerHTML = `
    ${header(`Results: ${esc(step.title)}`, `${questions.length} questions${step.passing_score != null ? ` · Pass mark ${Number(step.passing_score)}%` : ""}${step.max_attempts ? ` · ${step.max_attempts} attempt${step.max_attempts === 1 ? "" : "s"} allowed` : ""}`,
      `<button class="btn" data-export>${icons.download} Export Excel</button>`)}
    <div class="kpi-grid">
      <div class="card kpi"><span class="label">Learners Who Took It</span><b>${tried.length}<small> / ${enrolled.length}</small></b><span class="muted small">enrolled learners</span></div>
      <div class="card kpi"><span class="label">Average Best Score</span><b>${avgBest == null ? "–" : `${avgBest}%`}</b><span class="muted small">each learner's best attempt</span></div>
      <div class="card kpi"><span class="label">Pass Rate</span><b>${passRate == null ? "–" : `${passRate}%`}</b><span class="muted small">of learners who took it</span></div>
      <div class="card kpi"><span class="label">Average Time</span><b>${avgTime == null ? "–" : `${avgTime} min`}</b><span class="muted small">per attempt</span></div>
    </div>
    ${isAdmin ? "" : '<div class="notice info" style="margin-bottom:12px">Only Admin can change scores or enter scores manually.</div>'}
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Learner</th><th>Best Score</th><th>Result</th><th>Attempts</th><th>Last Submitted</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td class="name"><strong>${esc(r.e.learner.full_name)}</strong><span>${esc(r.e.learner.email)}</span></td>
            <td>${r.best == null ? '<span class="muted">–</span>' : `<div class="meter"><i style="width:${r.best}%"></i></div> ${r.best}%`}</td>
            <td><span class="pill ${PILL[r.result]}">${r.result}</span></td>
            <td>${r.used}${step.max_attempts ? ` / ${step.max_attempts}` : ""}${r.mine.some((a) => a.status === "manual") ? ' <span class="pill">Manual</span>' : ""}</td>
            <td>${esc(fmtDateTime(r.last))}</td>
            <td class="actions">
              ${r.mine.length ? `<button class="btn sm" data-attempts="${r.e.id}">Attempts</button>` : ""}
              ${isAdmin ? `<button class="btn sm" data-enter="${r.e.id}">Enter Score</button>` : ""}
            </td>
          </tr>`).join("") || '<tr><td colspan="6" class="muted">No learners enrolled yet.</td></tr>'}</tbody>
      </table>
    </div>
    <h2 class="section-title" style="margin-top:22px">Question Analysis</h2>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>#</th><th>Question</th><th>Type</th><th>Points</th><th>Answered Correctly</th></tr></thead>
        <tbody>${qStats.map((s, i) => `
          <tr><td>${i + 1}</td><td>${esc(s.q.question)}</td><td>${esc(QTYPE[s.q.qtype]?.label ?? "")}</td><td>${Number(s.q.points)}</td>
            <td>${s.rate == null ? '<span class="muted">No answers yet</span>' : `<div class="meter ${s.rate < 50 ? "low" : ""}"><i style="width:${s.rate}%"></i></div> ${s.rate}% <span class="muted small">of ${s.seen}</span>`}</td></tr>`).join("")}</tbody>
      </table>
    </div>`;

  const byEnrollment = Object.fromEntries(rows.map((r) => [r.e.id, r]));
  main.querySelector("tbody").addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-attempts]");
    const m = ev.target.closest("[data-enter]");
    if (a) showAttempts(byEnrollment[a.dataset.attempts]);
    if (m) changeScore(byEnrollment[m.dataset.enter], null);
  });

  function showAttempts(r) {
    const { form } = openModal({
      title: `Attempts: ${r.e.learner.full_name}`,
      wide: true,
      body: `<div class="table-wrap"><table class="data">
        <thead><tr><th>#</th><th>Started</th><th>Time</th><th>Score</th><th>Status</th><th></th></tr></thead>
        <tbody>${r.mine.map((a, i) => `
          <tr>
            <td>${i + 1}</td><td>${esc(fmtDateTime(a.started_at ?? a.submitted_at))}</td>
            <td>${minutes(a) == null ? "–" : `${minutes(a)} min`}</td>
            <td>${a.percent == null ? "–" : `<b>${Number(a.percent)}%</b>`}${a.max_score ? ` <span class="muted small">(${Number(a.score)} / ${Number(a.max_score)})</span>` : ""}
              ${a.original_percent != null ? `<div class="muted small">Was ${Number(a.original_percent)}%</div>` : ""}
              ${a.change_reason ? `<div class="muted small">${esc(a.changer?.full_name ?? "Admin")}: “${esc(a.change_reason)}”</div>` : ""}</td>
            <td><span class="pill ${a.passed ? "good" : a.status === "in_progress" ? "prog" : ""}">${STATUS[a.status]}${a.passed ? " · Passed" : ""}</span></td>
            <td class="actions">${isAdmin ? `<button type="button" class="btn sm" data-change="${a.id}">Change Score</button>` : ""}</td>
          </tr>`).join("")}</tbody></table></div>`,
      submitLabel: "Close",
      cancelLabel: "",
    });
    form.querySelector("tbody").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-change]");
      if (!b) return;
      form.closest(".modal-backdrop").remove();
      changeScore(r, r.mine.find((a) => a.id === b.dataset.change));
    });
  }

  function changeScore(r, attempt) {
    openModal({
      title: attempt ? `Change Score: ${r.e.learner.full_name}` : `Enter Score: ${r.e.learner.full_name}`,
      intro: attempt
        ? `Current score ${attempt.percent == null ? "–" : `${Number(attempt.percent)}%`}. The original score is kept in the record.`
        : "Use this for an assessment taken outside the Companion, for example on paper. It counts as a separate attempt.",
      body: `
        <label class="field">Score (%) <input class="input" type="number" name="pct" min="0" max="100" step="0.1" value="${attempt?.percent ?? ""}" style="max-width:160px"></label>
        <label class="field">Reason <input class="input" name="reason" placeholder="${attempt ? "e.g. Re-marked question 4" : "e.g. Paper assessment on 12 Nov"}"></label>`,
      submitLabel: "Save Score",
      onSubmit: async (f) => {
        const pct = f.pct.value === "" ? NaN : Number(f.pct.value);
        if (!(pct >= 0 && pct <= 100)) throw new Error("Enter a score from 0 to 100.");
        if (!f.reason.value.trim()) throw new Error("Please give a reason.");
        const { error } = await sb.rpc("admin_set_score", {
          p_step: step.id, p_enrollment: r.e.id, p_attempt: attempt?.id ?? null, p_percent: pct, p_reason: f.reason.value.trim(),
        });
        if (error) throw error;
        toast("Score saved. Dashboards now show the new score.");
        reload();
      },
    });
  }

  main.querySelector("[data-export]").addEventListener("click", async () => {
    try {
      await loadScript(LIBS.xlsx);
      const X = window.XLSX;
      const wb = X.utils.book_new();
      const add = (name, data, widths) => {
        const ws = Array.isArray(data[0]) ? X.utils.aoa_to_sheet(data, { cellDates: true }) : X.utils.json_to_sheet(data, { cellDates: true });
        ws["!cols"] = widths.map((w) => ({ wch: w }));
        X.utils.book_append_sheet(wb, ws, name);
      };
      add("Learners", rows.map((r) => ({
        Learner: r.e.learner.full_name, Email: r.e.learner.email, "Best Score %": r.best ?? "", Result: r.result,
        "Attempts Used": r.used, "Last Submitted": r.last ? new Date(r.last) : "",
      })), [26, 32, 13, 12, 13, 20]);
      const who = Object.fromEntries(enrolled.map((e) => [e.id, e.learner]));
      add("Attempts", (attempts ?? []).length ? attempts.map((a) => ({
        Learner: who[a.enrollment_id]?.full_name, Email: who[a.enrollment_id]?.email, Status: STATUS[a.status],
        Started: a.started_at ? new Date(a.started_at) : "", Submitted: a.submitted_at ? new Date(a.submitted_at) : "",
        "Minutes Taken": minutes(a) ?? "", Score: a.score ?? "", "Out Of": a.max_score ?? "", "Score %": a.percent ?? "",
        Passed: a.passed == null ? "" : a.passed ? "Yes" : "No", "Original Score %": a.original_percent ?? "",
        "Changed By": a.changer?.full_name ?? "", Reason: a.change_reason ?? "",
      })) : [["No attempts yet."]], [26, 32, 16, 18, 18, 13, 8, 8, 9, 8, 16, 20, 30]);
      add("Questions", qStats.map((s, i) => ({
        "#": i + 1, Question: s.q.question, Type: QTYPE[s.q.qtype]?.label, Points: Number(s.q.points),
        "Answered Correctly %": s.rate ?? "", "Times Answered": s.seen,
      })), [4, 60, 24, 8, 20, 15]);
      X.writeFile(wb, `${safeName(step.title)} - Assessment Results.xlsx`);
    } catch (err) { toast(err.message, "err"); }
  });
}

// =====================================================================
// Survey
// =====================================================================
async function surveyResults({ main, step, questions, enrolled, header, sectionTitle }) {
  const [{ data: responses }, { data: people }] = await Promise.all([
    sb.from("survey_responses").select("*").eq("step_id", step.id).order("submitted_at"),
    sb.from("profiles").select("id, full_name, email"),
  ]);
  const name = Object.fromEntries((people ?? []).map((p) => [p.id, p]));
  const list = responses ?? [];
  const named = list.filter((r) => r.respondent_id).length;
  const answersFor = (q) => list.map((r) => ({ r, v: r.answers?.[q.id] })).filter((x) => x.v != null && x.v !== "" && !(Array.isArray(x.v) && !x.v.length));
  const who = (r) => (r.respondent_id ? esc(name[r.respondent_id]?.full_name ?? "Former Learner") : "Anonymous");

  const bars = (labels, counts, total) => `<div class="bars-h">${labels.map((l, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    return `<div class="bar-row"><span class="bar-name">${esc(l)}</span><div class="hbar-track"><i style="width:${pct}%"></i></div><b>${counts[i]}</b><span class="muted small">${pct}%</span></div>`;
  }).join("")}</div>`;

  const summary = (q) => {
    const ans = answersFor(q);
    if (!ans.length) return '<p class="muted">No answers yet.</p>';
    if (q.qtype === "rating") {
      const counts = [1, 2, 3, 4, 5].map((n) => ans.filter((a) => Number(a.v) === n).length);
      const avg = ans.reduce((s, a) => s + Number(a.v), 0) / ans.length;
      return `<div class="big-stat"><b>${avg.toFixed(1)}</b><span class="stars">${Array.from({ length: 5 }, (_, i) => `<span class="star ${i < Math.round(avg) ? "on" : ""}">${icons.star}</span>`).join("")}</span><span class="muted small">average of ${ans.length}</span></div>
        ${bars(["5 Stars", "4 Stars", "3 Stars", "2 Stars", "1 Star"], counts.slice().reverse(), ans.length)}`;
    }
    if (q.qtype === "likert") return bars(LIKERT, LIKERT.map((_, i) => ans.filter((a) => Number(a.v) === i).length), ans.length);
    if (q.qtype === "nps") {
      const promoters = ans.filter((a) => Number(a.v) >= 9).length;
      const detractors = ans.filter((a) => Number(a.v) <= 6).length;
      const score = Math.round(((promoters - detractors) / ans.length) * 100);
      return `<div class="big-stat"><b>${score > 0 ? "+" : ""}${score}</b><span class="muted small">Net Promoter Score (from −100 to +100)</span></div>
        ${bars(["Promoters (9–10)", "Passives (7–8)", "Detractors (0–6)"], [promoters, ans.length - promoters - detractors, detractors], ans.length)}`;
    }
    if (q.qtype === "single" || q.qtype === "multi") {
      const counts = q.options.map((_, i) => ans.filter((a) => (Array.isArray(a.v) ? a.v.includes(i) : Number(a.v) === i)).length);
      return bars(q.options, counts, ans.length);
    }
    return `<ul class="text-answers">${ans.map((a) => `<li><div class="prose-text">${esc(a.v)}</div><span class="muted small">${who(a.r)} · ${esc(fmtDate(a.r.submitted_at))}</span></li>`).join("")}</ul>`;
  };

  let lastSection = undefined;
  main.innerHTML = `
    ${header(`Responses: ${esc(step.title)}`, `${questions.length} questions`, `<button class="btn" data-export>${icons.download} Export Excel</button>`)}
    <div class="kpi-grid">
      <div class="card kpi"><span class="label">Responses</span><b>${list.length}<small> / ${enrolled.length}</small></b><span class="muted small">enrolled learners</span></div>
      <div class="card kpi"><span class="label">Shared Their Name</span><b>${named}</b><span class="muted small">${list.length - named} anonymous</span></div>
      <div class="card kpi"><span class="label">Response Rate</span><b>${enrolled.length ? Math.round((list.length / enrolled.length) * 100) : 0}%</b><span class="muted small">of enrolled learners</span></div>
      <div class="card kpi"><span class="label">Last Response</span><b class="small-b">${list.length ? esc(fmtDate(list.at(-1).submitted_at)) : "–"}</b><span class="muted small">&nbsp;</span></div>
    </div>
    <div class="stack">${questions.map((q, i) => {
      const sec = q.section_id && q.section_id !== lastSection ? `<h2 class="section-title">${esc(sectionTitle[q.section_id] ?? "")}</h2>` : "";
      lastSection = q.section_id;
      return `${sec}<section class="card q-result">
        <div class="card-head"><h2>${i + 1}. ${esc(q.question)}</h2><span class="muted small">${esc(QTYPE[q.qtype]?.label ?? "")} · ${answersFor(q).length} answer${answersFor(q).length === 1 ? "" : "s"}</span></div>
        ${summary(q)}
      </section>`;
    }).join("") || '<div class="empty"><div><strong>No Questions Yet</strong>Build the survey first.</div></div>'}</div>`;

  main.querySelector("[data-export]").addEventListener("click", async () => {
    try {
      await loadScript(LIBS.xlsx);
      const X = window.XLSX;
      const wb = X.utils.book_new();
      const text = (q, v) => {
        if (v == null || v === "") return "";
        if (q.qtype === "likert") return LIKERT[v] ?? v;
        if (q.qtype === "single") return q.options[v] ?? v;
        if (q.qtype === "multi") return (Array.isArray(v) ? v : [v]).map((i) => q.options[i] ?? i).join("; ");
        return v;
      };
      const rowsOut = list.map((r) => {
        const row = { Submitted: new Date(r.submitted_at), Name: r.respondent_id ? name[r.respondent_id]?.full_name ?? "" : "Anonymous", Email: r.respondent_id ? name[r.respondent_id]?.email ?? "" : "" };
        questions.forEach((q, i) => { row[`${i + 1}. ${q.question}`.slice(0, 250)] = text(q, r.answers?.[q.id]); });
        return row;
      });
      const ws = rowsOut.length ? X.utils.json_to_sheet(rowsOut, { cellDates: true }) : X.utils.aoa_to_sheet([["No responses yet."]]);
      ws["!cols"] = [{ wch: 18 }, { wch: 24 }, { wch: 30 }, ...questions.map(() => ({ wch: 30 }))];
      X.utils.book_append_sheet(wb, ws, "Responses");
      X.writeFile(wb, `${safeName(step.title)} - Survey Responses.xlsx`);
    } catch (err) { toast(err.message, "err"); }
  });
}
