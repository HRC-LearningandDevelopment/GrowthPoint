// Review Queue: L&D checks uploaded certificates and workbooks.
// Only approved uploads count toward a learner's completion.
import { sb } from "../supabase.js";
import { esc, toast, openModal, icons, fmtDateTime } from "../ui.js";

const UPLOAD_BUCKET = "learner-uploads";
const STATUS = {
  pending:  { label: "Waiting For Review", pill: "prog" },
  approved: { label: "Approved", pill: "good" },
  rejected: { label: "Returned", pill: "crit" },
};
const filters = { status: "pending", program: "", q: "" };

export async function renderReview(main) {
  main.innerHTML = `
    <header class="topbar">
      <div><h1>Review Queue</h1><p>Check uploaded certificates and workbooks. Only approved files count toward completion.</p></div>
      <div class="top-actions"><button class="btn primary" data-approve-selected disabled>Approve Selected</button></div>
    </header>
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search learner or file" data-f="q" value="${esc(filters.q)}">
      <select class="select" data-f="status">
        <option value="pending">Waiting For Review</option>
        <option value="approved">Approved</option>
        <option value="rejected">Returned</option>
        <option value="">All Uploads</option>
      </select>
      <select class="select" data-f="program"><option value="">All Programs</option></select>
      <span class="count"></span>
    </div>
    <div id="review-list"><div class="empty"><div>Loading…</div></div></div>`;

  const { data: uploads, error } = await sb.from("uploads")
    .select(`id, file_path, file_name, size_bytes, status, review_comment, reviewed_at, uploaded_at,
      step:program_steps(title),
      reviewer:profiles!uploads_reviewed_by_fkey(full_name),
      enrollment:enrollments(program_id, program:programs(title), learner:profiles(full_name, email))`)
    .order("uploaded_at", { ascending: true });
  const list = main.querySelector("#review-list");
  if (error) {
    list.innerHTML = `<div class="empty"><div><strong>Couldn't Load Uploads</strong>${esc(error.message)}</div></div>`;
    return;
  }

  const programs = [...new Map(uploads.map((u) => [u.enrollment.program_id, u.enrollment.program.title])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const programSelect = main.querySelector('[data-f="program"]');
  programSelect.insertAdjacentHTML("beforeend", programs.map(([id, t]) => `<option value="${id}">${esc(t)}</option>`).join(""));
  main.querySelector('[data-f="status"]').value = filters.status;
  programSelect.value = programs.some(([id]) => id === filters.program) ? filters.program : "";

  const approveSelected = main.querySelector("[data-approve-selected]");
  const selected = () => [...list.querySelectorAll("tbody input[type=checkbox]:checked")].map((c) => c.value);
  const syncSelected = () => {
    const n = selected().length;
    approveSelected.disabled = !n;
    approveSelected.textContent = n ? `Approve Selected (${n})` : "Approve Selected";
  };

  const draw = () => {
    const q = filters.q.trim().toLowerCase();
    const shown = uploads.filter((u) =>
      (!filters.status || u.status === filters.status) &&
      (!filters.program || u.enrollment.program_id === filters.program) &&
      (!q || `${u.enrollment.learner.full_name} ${u.enrollment.learner.email} ${u.file_name}`.toLowerCase().includes(q)));
    main.querySelector(".count").textContent = `${shown.length} of ${uploads.length}`;
    if (!shown.length) {
      list.innerHTML = filters.status === "pending"
        ? '<div class="empty"><div><strong>All Caught Up</strong>No uploads are waiting for review.</div></div>'
        : '<div class="empty"><div><strong>No Uploads Match</strong>Try a different filter.</div></div>';
      syncSelected();
      return;
    }
    list.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th><input type="checkbox" data-all aria-label="Select all waiting uploads"></th>
            <th>Learner</th><th>Program / Step</th><th>File</th><th>Uploaded</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>${shown.map((u) => `
            <tr>
              <td>${u.status === "pending" ? `<input type="checkbox" value="${u.id}" aria-label="Select">` : ""}</td>
              <td class="name"><strong>${esc(u.enrollment.learner.full_name)}</strong><span>${esc(u.enrollment.learner.email)}</span></td>
              <td class="name"><strong>${esc(u.enrollment.program.title)}</strong><span>${esc(u.step?.title ?? "")}</span></td>
              <td><button class="link-btn dark" data-view="${esc(u.file_path)}">${esc(u.file_name)}</button>
                <span class="muted small">${u.size_bytes ? `${(u.size_bytes / 1048576).toFixed(1)} MB` : ""}</span></td>
              <td>${esc(fmtDateTime(u.uploaded_at))}</td>
              <td><span class="pill ${STATUS[u.status].pill}">${STATUS[u.status].label}</span>
                ${u.reviewer ? `<div class="muted small">by ${esc(u.reviewer.full_name)}</div>` : ""}
                ${u.review_comment ? `<div class="muted small">“${esc(u.review_comment)}”</div>` : ""}</td>
              <td class="actions">
                ${u.status !== "approved" ? `<button class="btn sm primary" data-approve="${u.id}">Approve</button>` : ""}
                ${u.status !== "rejected" ? `<button class="btn sm danger" data-return="${u.id}">Return</button>` : ""}
              </td>
            </tr>`).join("")}</tbody>
        </table>
      </div>`;
    syncSelected();
  };

  const setStatus = async (ids, status, comment = null) => {
    const { error: err } = await sb.from("uploads").update({ status, review_comment: comment }).in("id", ids);
    if (err) throw err;
    for (const u of uploads.filter((x) => ids.includes(x.id))) { u.status = status; u.review_comment = comment; }
  };

  main.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("input", () => { filters[el.dataset.f] = el.value; draw(); }));
  approveSelected.addEventListener("click", async () => {
    const ids = selected();
    approveSelected.disabled = true;
    try {
      await setStatus(ids, "approved");
      toast(`${ids.length} upload${ids.length === 1 ? "" : "s"} approved.`);
      renderReview(main);
    } catch (err) { toast(err.message, "err"); syncSelected(); }
  });

  list.addEventListener("change", (e) => {
    if (e.target.matches("[data-all]")) list.querySelectorAll("tbody input[type=checkbox]").forEach((c) => { c.checked = e.target.checked; });
    syncSelected();
  });
  list.addEventListener("click", async (e) => {
    const view = e.target.closest("[data-view]");
    const approve = e.target.closest("[data-approve]");
    const ret = e.target.closest("[data-return]");
    if (view) {
      const { data } = await sb.storage.from(UPLOAD_BUCKET).createSignedUrl(view.dataset.view, 300);
      if (!data?.signedUrl) return toast("That file is no longer available.", "err");
      window.open(data.signedUrl, "_blank", "noopener");
    }
    if (approve) {
      approve.disabled = true;
      try {
        await setStatus([approve.dataset.approve], "approved");
        toast("Approved. It now counts toward the learner's completion.");
        renderReview(main);
      } catch (err) { toast(err.message, "err"); approve.disabled = false; }
    }
    if (ret) {
      const u = uploads.find((x) => x.id === ret.dataset.return);
      openModal({
        title: `Return To ${u.enrollment.learner.full_name}?`,
        intro: "They'll see your comment and can upload a corrected file.",
        body: `<label class="field">What Needs Fixing
          <textarea class="input prose short" name="comment" placeholder="e.g. This is the Module 2 certificate. Please upload Module 1's."></textarea></label>`,
        submitLabel: "Return Upload",
        danger: true,
        onSubmit: async (f) => {
          const comment = f.comment.value.trim();
          if (!comment) throw new Error("Please tell the learner what needs fixing.");
          await setStatus([u.id], "rejected", comment);
          toast("Returned to the learner.");
          renderReview(main);
        },
      });
    }
  });

  draw();
}
