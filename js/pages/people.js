// People: create accounts, reset passwords, change email / role, deactivate, delete.
// Admin manages everyone; L&D manages learners only (also enforced on the server).
import { sb, manageAccount } from "../supabase.js";
import { esc, toast, openModal, generatePassword, copyText, downloadCsv, ROLE_LABEL, icons } from "../ui.js";

const filters = { q: "", role: "", status: "active" };
let people = [];
let me = null;

const isAdmin = () => me.role === "admin";
const canManage = (p) => isAdmin() || p.role === "learner";
const portalUrl = () => location.origin + location.pathname;

export async function renderPeople(main, ctx) {
  me = ctx.me;
  main.innerHTML = `
    <header class="topbar">
      <div>
        <h1>People</h1>
        <p>${isAdmin() ? "Create and manage accounts for L&amp;D members and learners." : "Create and manage learner accounts."}</p>
      </div>
      <div class="top-actions">
        <button class="btn" data-act="bulk">${icons.upload} Add Many</button>
        <button class="btn primary" data-act="add">${icons.plus} Add Person</button>
      </div>
    </header>
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search name or email" value="${esc(filters.q)}" data-f="q">
      <select class="select" data-f="role">
        <option value="">All Roles</option>
        <option value="learner">Learners</option>
        <option value="ld">L&amp;D</option>
        <option value="admin">Admin</option>
      </select>
      <select class="select" data-f="status">
        <option value="active">Active</option>
        <option value="inactive">Deactivated</option>
        <option value="">Active And Deactivated</option>
      </select>
      <span class="count"></span>
    </div>
    <div id="people-list"><div class="empty"><div>Loading…</div></div></div>`;

  main.querySelector('[data-f="role"]').value = filters.role;
  main.querySelector('[data-f="status"]').value = filters.status;
  main.querySelectorAll("[data-f]").forEach((el) =>
    el.addEventListener("input", () => { filters[el.dataset.f] = el.value; draw(main); }));
  main.querySelector('[data-act="add"]').addEventListener("click", () => addPerson(main));
  main.querySelector('[data-act="bulk"]').addEventListener("click", () => addMany(main));
  main.querySelector("#people-list").addEventListener("click", (e) => onListClick(e, main));

  await load(main);
}

async function load(main) {
  const { data, error } = await sb
    .from("profiles")
    .select("id, email, full_name, role, is_active, must_change_password, user_id, created_at")
    .order("full_name");
  if (error) {
    main.querySelector("#people-list").innerHTML =
      `<div class="empty"><div><strong>Couldn't Load People</strong>${esc(error.message)}</div></div>`;
    return;
  }
  people = data;
  draw(main);
}

function draw(main) {
  const q = filters.q.trim().toLowerCase();
  const shown = people.filter((p) =>
    (!q || p.full_name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)) &&
    (!filters.role || p.role === filters.role) &&
    (filters.status === "" || (filters.status === "active") === p.is_active));

  main.querySelector(".count").textContent = `${shown.length} of ${people.length}`;
  const list = main.querySelector("#people-list");

  if (!shown.length) {
    list.innerHTML = `<div class="empty"><div><strong>No One Here Yet</strong>Use <b>Add Person</b> or <b>Add Many</b> to create accounts.</div></div>`;
    return;
  }

  list.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Name</th><th>Role</th><th>Sign-In</th><th>Status</th><th>Added</th><th></th></tr></thead>
        <tbody>${shown.map(row).join("")}</tbody>
      </table>
    </div>`;
}

function row(p) {
  const self = p.id === me.id;
  const signIn = !p.user_id
    ? '<span class="pill crit">No Login</span>'
    : p.must_change_password
      ? '<span class="pill warn">Temporary Password</span>'
      : '<span class="pill good">Ready</span>';
  const roleClass = { admin: "prog", ld: "teal", learner: "" }[p.role];

  return `
    <tr class="${p.is_active ? "" : "inactive"}">
      <td class="name"><strong>${esc(p.full_name)}${self ? " (you)" : ""}</strong><span>${esc(p.email)}</span></td>
      <td><span class="pill ${roleClass}">${esc(ROLE_LABEL[p.role])}</span></td>
      <td>${signIn}</td>
      <td>${p.is_active ? '<span class="pill good">Active</span>' : '<span class="pill">Deactivated</span>'}</td>
      <td>${new Date(p.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</td>
      <td class="actions">${canManage(p) ? actionsMenu(p, self) : ""}</td>
    </tr>`;
}

function actionsMenu(p, self) {
  const items = [
    !p.user_id && ["create_login", "Create Login"],
    p.user_id && ["reset", "Reset Password"],
    ["rename", "Edit Name"],
    ["email", "Change Email"],
    isAdmin() && !self && ["role", "Change Role"],
    !self && (p.is_active ? ["deactivate", "Deactivate"] : ["reactivate", "Reactivate"]),
    isAdmin() && !self && ["delete", "Delete…", "danger"],
  ].filter(Boolean);

  return `
    <div class="menu">
      <button class="btn sm ghost" data-menu aria-label="Actions for ${esc(p.full_name)}">${icons.dots}</button>
      <div class="menu-list">
        ${items.map(([act, label, cls]) =>
          `${cls === "danger" ? "<hr>" : ""}<button class="${cls ?? ""}" data-act="${act}" data-id="${p.id}">${label}</button>`).join("")}
      </div>
    </div>`;
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu")) document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
});

// The table scrolls, so pin the menu to the window to stop it being cut off
function placeMenu(button, list) {
  const r = button.getBoundingClientRect();
  list.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  const below = r.bottom + 6;
  const height = list.offsetHeight;
  list.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, r.top - 6 - height) : below}px`;
}
window.addEventListener("scroll", () => document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")), true);

function onListClick(e, main) {
  const menuBtn = e.target.closest("[data-menu]");
  if (menuBtn) {
    const menu = menuBtn.closest(".menu");
    const wasOpen = menu.classList.contains("open");
    document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
    menu.classList.toggle("open", !wasOpen);
    if (!wasOpen) placeMenu(menuBtn, menu.querySelector(".menu-list"));
    return;
  }
  const actBtn = e.target.closest("[data-act]");
  if (!actBtn) return;
  actBtn.closest(".menu")?.classList.remove("open");
  const person = people.find((p) => p.id === actBtn.dataset.id);
  const actions = {
    create_login: createLogin, reset: resetPassword, rename, email: changeEmail, role: changeRole,
    deactivate: (p, m) => setActive(p, m, false), reactivate: (p, m) => setActive(p, m, true), delete: deletePerson,
  };
  actions[actBtn.dataset.act]?.(person, main);
}

// ---------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------
function passwordField(label = "Temporary password") {
  return `
    <label class="field">${label}
      <div class="field-row">
        <input class="input" name="password" value="${generatePassword()}" autocomplete="off" spellcheck="false">
        <button type="button" class="btn" data-generate>New</button>
      </div>
      <span class="hint">They'll be asked to change it the first time they sign in.</span>
    </label>`;
}

function wireGenerate(form) {
  form.querySelector("[data-generate]")?.addEventListener("click", () => { form.password.value = generatePassword(); });
}

function showCredentials(person, password) {
  const text = `GrowthPoint\n${portalUrl()}\n\nEmail: ${person.email}\nTemporary password: ${password}\n\nYou'll be asked to set your own password when you first sign in.`;
  const { form } = openModal({
    title: "Share These Sign-In Details",
    intro: `Send them to ${esc(person.full_name)} privately, for example in a Teams chat.`,
    body: `<div class="credentials">${esc(text)}</div>
           <button type="button" class="btn" data-copy>Copy Sign-In Details</button>`,
    submitLabel: "Done",
    cancelLabel: "",
  });
  form.querySelector("[data-copy]").addEventListener("click", () => copyText(text));
}

function roleOptions(selected = "learner") {
  return ["learner", "ld", "admin"]
    .map((r) => `<option value="${r}" ${r === selected ? "selected" : ""}>${esc(ROLE_LABEL[r])}</option>`)
    .join("");
}

// ---------------------------------------------------------------------
// Add one person
// ---------------------------------------------------------------------
function addPerson(main) {
  const { form } = openModal({
    title: "Add Person",
    body: `
      <label class="field">Full Name <input class="input" name="full_name" autocomplete="off" required></label>
      <label class="field">Work Email <input class="input" type="email" name="email" autocomplete="off" required></label>
      ${isAdmin()
        ? `<label class="field">Role <select class="select" name="role">${roleOptions()}</select>
             <span class="hint">L&amp;D can build programs and manage learners. Admin can also manage L&amp;D members.</span></label>`
        : '<input type="hidden" name="role" value="learner">'}
      ${passwordField()}`,
    submitLabel: "Create Account",
    onSubmit: async (f) => {
      const person = { full_name: f.full_name.value.trim(), email: f.email.value.trim().toLowerCase(), role: f.role.value };
      const password = f.password.value.trim();
      await manageAccount({ action: "create", ...person, password });
      toast(`Account created for ${person.full_name}.`);
      await load(main);
      showCredentials(person, password);
    },
  });
  wireGenerate(form);
}

// ---------------------------------------------------------------------
// Add many (one per line: Full name, email)
// ---------------------------------------------------------------------
function addMany(main) {
  const { form } = openModal({
    title: "Add Many People",
    intro: "One person per line: <b>Full name, email</b>. You can paste two columns straight from Excel.",
    wide: true,
    body: `
      <textarea class="input" name="lines" placeholder="Juan Dela Cruz, juan.delacruz@company.com&#10;Maria Santos, maria.santos@company.com"></textarea>
      ${isAdmin()
        ? `<label class="field">Role For Everyone In This List <select class="select" name="role">${roleOptions()}</select></label>`
        : '<input type="hidden" name="role" value="learner">'}
      <div class="notice info">Each person gets their own temporary password. When it finishes you can download everyone's sign-in details as a CSV file.</div>`,
    submitLabel: "Create Accounts",
    onSubmit: async (f) => {
      const parsed = f.lines.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
        const parts = line.split(/\t|,|;/).map((s) => s.trim()).filter(Boolean);
        const email = parts.find((s) => s.includes("@"));
        const full_name = parts.filter((s) => s !== email).join(" ");
        return { line, email: (email ?? "").toLowerCase(), full_name };
      });
      if (!parsed.length) throw new Error("Paste at least one line.");
      const bad = parsed.filter((p) => !p.email || !p.full_name);
      if (bad.length) throw new Error(`These lines need both a name and an email: ${bad.map((b) => `"${b.line}"`).join(", ")}`);

      const submit = f.querySelector('[type="submit"]');
      const results = [];
      for (const [i, person] of parsed.entries()) {
        submit.textContent = `Creating ${i + 1} of ${parsed.length}…`;
        const password = generatePassword();
        try {
          await manageAccount({ action: "create", full_name: person.full_name, email: person.email, role: f.role.value, password });
          results.push({ ...person, password, ok: true });
        } catch (err) {
          results.push({ ...person, ok: false, reason: err.message });
        }
      }
      submit.textContent = "Create Accounts";
      await load(main);
      showBulkResults(results);
    },
  });
}

function showBulkResults(results) {
  const created = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const { form } = openModal({
    title: `${created.length} Account${created.length === 1 ? "" : "s"} Created`,
    wide: true,
    body: `
      ${created.length ? `
        <button type="button" class="btn primary" data-download>Download Sign-In Details (CSV)</button>
        <div class="notice">This file contains passwords. Share each person's details privately, then delete the file.</div>` : ""}
      ${failed.length ? `
        <div><strong>Not Created (${failed.length})</strong>
          <ul>${failed.map((r) => `<li>${esc(r.full_name)} (${esc(r.email)}): ${esc(r.reason)}</li>`).join("")}</ul>
        </div>` : ""}`,
    submitLabel: "Done",
    cancelLabel: "",
  });
  form.querySelector("[data-download]")?.addEventListener("click", () => {
    downloadCsv(`growthpoint-sign-in-details-${new Date().toLocaleDateString("en-CA")}.csv`, [
      ["Full Name", "Email", "Temporary Password", "Link"],
      ...created.map((r) => [r.full_name, r.email, r.password, portalUrl()]),
    ]);
  });
}

// ---------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------
function createLogin(p, main) {
  const { form } = openModal({
    title: `Create Login For ${p.full_name}`,
    body: passwordField(),
    submitLabel: "Create Login",
    onSubmit: async (f) => {
      const password = f.password.value.trim();
      await manageAccount({ action: "create", full_name: p.full_name, email: p.email, role: p.role, password });
      await load(main);
      showCredentials(p, password);
    },
  });
  wireGenerate(form);
}

function resetPassword(p, main) {
  const { form } = openModal({
    title: `Reset Password For ${p.full_name}`,
    intro: "Their current password stops working straight away.",
    body: passwordField("New temporary password"),
    submitLabel: "Reset Password",
    onSubmit: async (f) => {
      const password = f.password.value.trim();
      await manageAccount({ action: "reset_password", profile_id: p.id, password });
      await load(main);
      showCredentials(p, password);
    },
  });
  wireGenerate(form);
}

function rename(p, main) {
  openModal({
    title: "Edit Name",
    body: `<label class="field">Full Name <input class="input" name="full_name" value="${esc(p.full_name)}" required></label>`,
    onSubmit: async (f) => {
      const full_name = f.full_name.value.trim();
      if (!full_name) throw new Error("Please enter a name.");
      const { error } = await sb.from("profiles").update({ full_name }).eq("id", p.id);
      if (error) throw error;
      toast("Name updated.");
      await load(main);
    },
  });
}

function changeEmail(p, main) {
  openModal({
    title: `Change Email For ${p.full_name}`,
    intro: "They'll sign in with the new email from now on. Their password stays the same.",
    body: `<label class="field">New Email <input class="input" type="email" name="email" value="${esc(p.email)}" required></label>`,
    onSubmit: async (f) => {
      await manageAccount({ action: "change_email", profile_id: p.id, email: f.email.value.trim() });
      toast("Email updated.");
      await load(main);
    },
  });
}

function changeRole(p, main) {
  openModal({
    title: `Change Role For ${p.full_name}`,
    body: `<label class="field">Role <select class="select" name="role">${roleOptions(p.role)}</select></label>`,
    onSubmit: async (f) => {
      const { error } = await sb.from("profiles").update({ role: f.role.value }).eq("id", p.id);
      if (error) throw error;
      toast("Role updated.");
      await load(main);
    },
  });
}

function setActive(p, main, active) {
  openModal({
    title: `${active ? "Reactivate" : "Deactivate"} ${p.full_name}?`,
    intro: active
      ? "They'll be able to sign in again with their current password."
      : "They won't be able to sign in. Their progress and records are kept, and you can reactivate them later.",
    body: "",
    submitLabel: active ? "Reactivate" : "Deactivate",
    danger: !active,
    onSubmit: async () => {
      await manageAccount({ action: "set_active", profile_id: p.id, active });
      toast(`${p.full_name} ${active ? "reactivated" : "deactivated"}.`);
      await load(main);
    },
  });
}

function deletePerson(p, main) {
  openModal({
    title: `Delete ${p.full_name}?`,
    intro: "This permanently removes their account <b>and all their progress, scores and uploads</b>. To keep their records, deactivate them instead.",
    body: `<label class="field">Type DELETE To Confirm <input class="input" name="confirm" autocomplete="off"></label>`,
    submitLabel: "Delete Permanently",
    danger: true,
    onSubmit: async (f) => {
      if (f.confirm.value.trim() !== "DELETE") throw new Error("Type DELETE in capitals to confirm.");
      await manageAccount({ action: "delete", profile_id: p.id });
      toast(`${p.full_name} deleted.`);
      await load(main);
    },
  });
}
