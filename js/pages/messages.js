// Messages between learners and the L&D team.
//   Learners: their own conversations, and "New Message".
//   Admin / L&D: every conversation, reply, mark resolved.
//   #/messages            list
//   #/messages/<thread>   one conversation
import { sb } from "../supabase.js";
import { esc, toast, openModal, icons, fmtDateTime } from "../ui.js";

const filters = { status: "open", q: "" };

export async function renderMessages(main, ctx) {
  const [threadId] = ctx.params;
  return threadId ? threadPage(main, ctx, threadId) : listPage(main, ctx);
}

const isStaff = (me) => me.role === "admin" || me.role === "ld";

// Learner: start a conversation (optionally about one program)
export async function newMessage(me, programId = null) {
  const { data: enrolled } = await sb.from("enrollments").select("program:programs(id, title)").eq("learner_id", me.id);
  const programs = (enrolled ?? []).map((e) => e.program).filter(Boolean);
  openModal({
    title: "Message The L&D Team",
    intro: "Ask a question or report a problem. The L&D team will reply here.",
    body: `
      <label class="field">About
        <select class="select" name="program">
          <option value="">General Question</option>
          ${programs.map((p) => `<option value="${p.id}" ${p.id === programId ? "selected" : ""}>${esc(p.title)}</option>`).join("")}
        </select>
      </label>
      <label class="field">Subject <input class="input" name="subject" maxlength="120" placeholder="e.g. Can't open Module 2"></label>
      <label class="field">Message <textarea class="input prose" name="body"></textarea></label>`,
    submitLabel: "Send Message",
    onSubmit: async (f) => {
      const subject = f.subject.value.trim();
      const body = f.body.value.trim();
      if (!subject || !body) throw new Error("Please add a subject and a message.");
      const { data: thread, error } = await sb.from("message_threads")
        .insert({ learner_id: me.id, program_id: f.program.value || null, subject })
        .select("id").single();
      if (error) throw error;
      const { error: msgErr } = await sb.from("thread_messages").insert({ thread_id: thread.id, body });
      if (msgErr) throw msgErr;
      toast("Message sent to the L&D team.");
      location.hash = `#/messages/${thread.id}`;
    },
  });
}

async function listPage(main, { me }) {
  const staff = isStaff(me);
  main.innerHTML = `
    <header class="topbar">
      <div><h1>Messages</h1><p>${staff ? "Questions and requests from learners." : "Your conversations with the L&amp;D team."}</p></div>
      ${staff ? "" : `<div class="top-actions"><button class="btn primary" data-new>${icons.plus} New Message</button></div>`}
    </header>
    ${staff ? `
      <div class="toolbar">
        <input class="input search" type="search" placeholder="Search learner or subject" data-f="q" value="${esc(filters.q)}">
        <select class="select" data-f="status">
          <option value="open">Open</option><option value="resolved">Resolved</option><option value="">All Messages</option>
        </select>
        <span class="count"></span>
      </div>` : ""}
    <div id="thread-list"><div class="empty"><div>Loading…</div></div></div>`;

  main.querySelector("[data-new]")?.addEventListener("click", () => newMessage(me));

  const { data: threads, error } = await sb.from("message_threads")
    .select("id, subject, status, created_at, updated_at, program:programs(title), learner:profiles(full_name, email), thread_messages(count)")
    .order("updated_at", { ascending: false });
  const list = main.querySelector("#thread-list");
  if (error) {
    list.innerHTML = `<div class="empty"><div><strong>Couldn't Load Messages</strong>${esc(error.message)}</div></div>`;
    return;
  }

  const draw = () => {
    const q = filters.q.trim().toLowerCase();
    const shown = staff
      ? threads.filter((t) => (!filters.status || t.status === filters.status) &&
          (!q || `${t.learner.full_name} ${t.learner.email} ${t.subject}`.toLowerCase().includes(q)))
      : threads;
    const count = main.querySelector(".count");
    if (count) count.textContent = `${shown.length} of ${threads.length}`;

    if (!shown.length) {
      list.innerHTML = staff
        ? '<div class="empty"><div><strong>No Messages Here</strong>New questions from learners will appear here.</div></div>'
        : '<div class="empty"><div><strong>No Messages Yet</strong>Use <b>New Message</b> to ask the L&amp;D team a question.</div></div>';
      return;
    }
    list.innerHTML = `<div class="thread-list">${shown.map((t) => `
      <a class="card thread-row" href="#/messages/${t.id}">
        <div>
          <strong>${esc(t.subject)}</strong>
          <div class="muted small">${staff ? `${esc(t.learner.full_name)} · ` : ""}${esc(t.program?.title ?? "General Question")}</div>
        </div>
        <div class="thread-meta">
          <span class="pill ${t.status === "open" ? "prog" : "good"}">${t.status === "open" ? "Open" : "Resolved"}</span>
          <span class="muted small">${t.thread_messages[0]?.count ?? 0} message${t.thread_messages[0]?.count === 1 ? "" : "s"} · ${esc(fmtDateTime(t.updated_at))}</span>
        </div>
      </a>`).join("")}</div>`;
  };
  main.querySelectorAll("[data-f]").forEach((el) => {
    if (el.dataset.f === "status") el.value = filters.status;
    el.addEventListener("input", () => { filters[el.dataset.f] = el.value; draw(); });
  });
  draw();
}

async function threadPage(main, ctx, threadId) {
  const { me } = ctx;
  const staff = isStaff(me);
  const reload = () => threadPage(main, ctx, threadId);

  const [{ data: thread }, { data: messages }] = await Promise.all([
    sb.from("message_threads").select("*, program:programs(id, title), learner:profiles(full_name, email)").eq("id", threadId).maybeSingle(),
    sb.from("thread_messages").select("id, body, created_at, author_id, author:profiles(full_name, role)").eq("thread_id", threadId).order("created_at"),
  ]);
  if (!thread) {
    main.innerHTML = `
      <header class="topbar"><div><a class="back-link" href="#/messages">${icons.back} Messages</a><h1>Conversation Not Found</h1></div></header>
      <div class="empty"><div>It may have been removed.</div></div>`;
    return;
  }

  main.innerHTML = `
    <header class="topbar">
      <div>
        <a class="back-link" href="#/messages">${icons.back} Messages</a>
        <h1>${esc(thread.subject)}</h1>
        <p>${staff ? `${esc(thread.learner.full_name)} (${esc(thread.learner.email)}) · ` : ""}${esc(thread.program?.title ?? "General Question")}
          &nbsp;<span class="pill ${thread.status === "open" ? "prog" : "good"}">${thread.status === "open" ? "Open" : "Resolved"}</span></p>
      </div>
      ${staff ? `<div class="top-actions">
        ${thread.program ? `<a class="btn" href="#/preview/${thread.learner_id}/${thread.program.id}">${icons.eye} View As Learner</a>` : ""}
        <button class="btn ${thread.status === "open" ? "primary" : ""}" data-toggle>${thread.status === "open" ? "Mark Resolved" : "Reopen"}</button>
      </div>` : ""}
    </header>
    <div class="conversation">
      ${(messages ?? []).map((m) => {
        const mine = m.author_id === me.id;
        const fromStaff = m.author && m.author.role !== "learner";
        return `
          <div class="bubble ${mine ? "mine" : ""} ${fromStaff ? "staff" : ""}">
            <div class="bubble-head"><strong>${esc(m.author?.full_name ?? "Former User")}</strong>${fromStaff ? ' <span class="pill teal">L&amp;D</span>' : ""}
              <span class="muted small">${esc(fmtDateTime(m.created_at))}</span></div>
            <div class="prose-text">${esc(m.body)}</div>
          </div>`;
      }).join("")}
    </div>
    <form class="card reply" novalidate>
      <div class="form-error" hidden></div>
      <label class="field">Reply <textarea class="input prose short" name="body" placeholder="Write a reply…"></textarea></label>
      ${!staff && thread.status === "resolved" ? '<p class="muted small">This conversation is marked resolved. Replying reopens it.</p>' : ""}
      <div class="form-actions">
        ${staff && thread.status === "open" ? '<label class="check" style="margin-right:auto"><input type="checkbox" name="resolve"> Mark Resolved When Sent</label>' : ""}
        <button class="btn primary" type="submit">Send Reply</button>
      </div>
    </form>`;

  main.querySelector(".conversation").lastElementChild?.scrollIntoView({ block: "nearest" });

  main.querySelector("[data-toggle]")?.addEventListener("click", async () => {
    const { error } = await sb.from("message_threads").update({ status: thread.status === "open" ? "resolved" : "open" }).eq("id", thread.id);
    if (error) return toast(error.message, "err");
    toast(thread.status === "open" ? "Marked resolved." : "Reopened.");
    reload();
  });

  const form = main.querySelector("form.reply");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = form.body.value.trim();
    const errorBox = form.querySelector(".form-error");
    if (!body) { errorBox.textContent = "Write a reply first."; errorBox.hidden = false; return; }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const { error } = await sb.from("thread_messages").insert({ thread_id: thread.id, body });
    if (error) { errorBox.textContent = error.message; errorBox.hidden = false; btn.disabled = false; return; }
    if (form.resolve?.checked) await sb.from("message_threads").update({ status: "resolved" }).eq("id", thread.id);
    toast("Reply sent.");
    reload();
  });
}
