// Programs: the list of all programs, and "New program". Opening one goes to the editor.
import { sb } from "../supabase.js";
import { esc, openModal, toast, icons, fmtDate, statusPill, PROGRAM_TYPE, PROGRAM_STATUS } from "../ui.js";
import { renderProgramEditor } from "./program-editor.js";

const filters = { q: "", status: "current", type: "" };

export async function renderPrograms(main, ctx) {
  if (ctx.params[0]) return renderProgramEditor(main, ctx);

  main.innerHTML = `
    <header class="topbar">
      <div><h1>Programs</h1><p>Create programs, build the learning journey and enroll learners.</p></div>
      <div class="top-actions"><button class="btn primary" data-new>${icons.plus} New Program</button></div>
    </header>
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search programs" data-f="q" value="${esc(filters.q)}">
      <select class="select" data-f="status">
        <option value="current">Not Archived</option>
        ${Object.entries(PROGRAM_STATUS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join("")}
        <option value="">All</option>
      </select>
      <select class="select" data-f="type">
        <option value="">All Types</option>
        ${Object.entries(PROGRAM_TYPE).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
      </select>
      <span class="count"></span>
    </div>
    <div id="program-list"><div class="empty"><div>Loading…</div></div></div>`;

  main.querySelector('[data-f="status"]').value = filters.status;
  main.querySelector('[data-f="type"]').value = filters.type;
  main.querySelector("[data-new]").addEventListener("click", newProgram);

  const [{ data: programs, error }, { data: progress }] = await Promise.all([
    sb.from("programs")
      .select("id, title, program_type, audience, status, start_date, due_date, owner:profiles!programs_owner_id_fkey(full_name), program_steps(count), enrollments(count)")
      .order("created_at", { ascending: false }),
    sb.from("v_enrollment_progress").select("program_id, percent_complete"),
  ]);
  const list = main.querySelector("#program-list");
  if (error) {
    list.innerHTML = `<div class="empty"><div><strong>Couldn't Load Programs</strong>${esc(error.message)}</div></div>`;
    return;
  }

  const avg = {};
  for (const p of progress ?? []) (avg[p.program_id] ??= []).push(Number(p.percent_complete));

  const draw = () => {
    const q = filters.q.trim().toLowerCase();
    const shown = programs.filter((p) =>
      (!q || p.title.toLowerCase().includes(q) || (p.audience ?? "").toLowerCase().includes(q)) &&
      (filters.status === "" || (filters.status === "current" ? p.status !== "archived" : p.status === filters.status)) &&
      (!filters.type || p.program_type === filters.type));
    main.querySelector(".count").textContent = `${shown.length} of ${programs.length}`;

    if (!shown.length) {
      list.innerHTML = programs.length
        ? '<div class="empty"><div><strong>No Programs Match</strong>Try a different search or filter.</div></div>'
        : '<div class="empty"><div><strong>No Programs Yet</strong>Click <b>New Program</b> to create the first one.</div></div>';
      return;
    }

    list.innerHTML = `
      <div class="table-wrap">
        <table class="data clickable">
          <thead><tr><th>Program</th><th>Type</th><th>Status</th><th>Dates</th><th>Steps</th><th>Learners</th><th>Avg. Completion</th><th>Owner</th></tr></thead>
          <tbody>${shown.map((p) => {
            const scores = avg[p.id] ?? [];
            const mean = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
            return `
              <tr data-open="${p.id}" tabindex="0">
                <td class="name"><strong>${esc(p.title)}</strong><span>${esc(p.audience ?? "")}</span></td>
                <td>${esc(PROGRAM_TYPE[p.program_type])}</td>
                <td>${statusPill(p.status)}</td>
                <td>${p.start_date || p.due_date ? `${esc(fmtDate(p.start_date) || "–")} → ${esc(fmtDate(p.due_date) || "–")}` : '<span class="muted">Not Set</span>'}</td>
                <td>${p.program_steps[0]?.count ?? 0}</td>
                <td>${p.enrollments[0]?.count ?? 0}</td>
                <td>${mean === null ? '<span class="muted">–</span>' : `<div class="meter"><i style="width:${mean}%"></i></div> ${mean}%`}</td>
                <td>${esc(p.owner?.full_name ?? "")}</td>
              </tr>`;
          }).join("")}</tbody>
        </table>
      </div>`;
  };

  main.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("input", () => { filters[el.dataset.f] = el.value; draw(); }));
  list.addEventListener("click", (e) => {
    const row = e.target.closest("[data-open]");
    if (row) location.hash = `#/programs/${row.dataset.open}`;
  });
  list.addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-open]");
    if (row && e.key === "Enter") location.hash = `#/programs/${row.dataset.open}`;
  });
  draw();

  function newProgram() {
    openModal({
      title: "New Program",
      intro: "Start with the basics. You can add the learning journey and learners next.",
      body: `
        <label class="field">Title <input class="input" name="title" required></label>
        <label class="field">Type
          <select class="select" name="program_type">
            ${Object.entries(PROGRAM_TYPE).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
          </select>
        </label>
        <label class="field">Audience <input class="input" name="audience" placeholder="e.g. Team leads, new hires"></label>
        <div class="two">
          <label class="field">Start Date <input class="input" type="date" name="start_date"></label>
          <label class="field">Due Date <input class="input" type="date" name="due_date"></label>
        </div>`,
      submitLabel: "Create Program",
      onSubmit: async (f) => {
        const title = f.title.value.trim();
        if (!title) throw new Error("Please give the program a title.");
        const { data, error: err } = await sb.from("programs").insert({
          title,
          program_type: f.program_type.value,
          audience: f.audience.value.trim() || null,
          start_date: f.start_date.value || null,
          due_date: f.due_date.value || null,
          owner_id: ctx.me.id,
        }).select("id").single();
        if (err) throw err;
        toast("Program created.");
        location.hash = `#/programs/${data.id}/journey`;
      },
    });
  }
}
