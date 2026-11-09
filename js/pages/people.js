// People: create accounts, reset passwords, change email / role, deactivate, delete.
// Admin manages everyone; L&D manages learners only (also enforced on the server).
import { sb, manageAccount } from "../supabase.js";
import { esc, toast, openModal, generatePassword, copyText, downloadCsv, ROLE_LABEL, icons, MARKETS, cleanMarket, LIBS, loadScript } from "../ui.js";

const filters = { q: "", role: "", status: "active", market: "", department: "" };
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
      <input class="input search" type="search" placeholder="Search name, email, department, manager" value="${esc(filters.q)}" data-f="q">
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
      <select class="select" data-f="market"></select>
      <select class="select" data-f="department"></select>
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
    .select("id, email, full_name, role, is_active, must_change_password, user_id, created_at, department, designation, market, manager")
    .order("full_name");
  if (error) {
    main.querySelector("#people-list").innerHTML =
      `<div class="empty"><div><strong>Couldn't Load People</strong>${esc(error.message)}</div></div>`;
    return;
  }
  people = data;
  fillFilter(main, "market", "All Markets", people.map((p) => p.market));
  fillFilter(main, "department", "All Departments", people.map((p) => p.department));
  draw(main);
}

// Market / Department dropdowns list only the values in use
function fillFilter(main, key, all, values) {
  const el = main.querySelector(`[data-f="${key}"]`);
  const used = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (filters[key] && !used.includes(filters[key])) filters[key] = "";
  el.innerHTML = `<option value="">${all}</option>${used.map((v) => `<option>${esc(v)}</option>`).join("")}`;
  el.value = filters[key];
}

const missingDetails = (p) => p.role === "learner" && !(p.department && p.designation && p.market && p.manager);

function draw(main) {
  const q = filters.q.trim().toLowerCase();
  const shown = people.filter((p) =>
    (!q || [p.full_name, p.email, p.department, p.designation, p.market, p.manager].some((v) => (v ?? "").toLowerCase().includes(q))) &&
    (!filters.role || p.role === filters.role) &&
    (!filters.market || p.market === filters.market) &&
    (!filters.department || p.department === filters.department) &&
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
        <thead><tr><th>Name</th><th>Department</th><th>Market</th><th>Reporting Manager</th><th>Role</th><th>Sign-In</th><th>Status</th><th></th></tr></thead>
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
      <td class="name">${p.department || p.designation
        ? `<strong>${esc(p.department || "–")}</strong><span>${esc(p.designation || "")}</span>`
        : missingDetails(p) && canManage(p) ? `<button class="pill warn pill-btn" data-act="details" data-id="${p.id}">Add Details</button>` : '<span class="muted">–</span>'}</td>
      <td>${p.market ? esc(p.market) : '<span class="muted">–</span>'}</td>
      <td>${p.manager ? esc(p.manager) : '<span class="muted">–</span>'}</td>
      <td><span class="pill ${roleClass}">${esc(ROLE_LABEL[p.role])}</span></td>
      <td>${signIn}</td>
      <td>${p.is_active ? '<span class="pill good">Active</span>' : '<span class="pill">Deactivated</span>'}</td>
      <td class="actions">${canManage(p) ? actionsMenu(p, self) : ""}</td>
    </tr>`;
}

function actionsMenu(p, self) {
  const items = [
    !p.user_id && ["create_login", "Create Login"],
    p.user_id && ["reset", "Reset Password"],
    ["details", "Edit Details"],
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
    create_login: createLogin, reset: resetPassword, details: editDetails, email: changeEmail, role: changeRole,
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

// Department, Designation, Market and Reporting Manager (needed for learners)
function detailFields(p = {}) {
  const other = p.market && !MARKETS.includes(p.market);
  return `
    <div class="form-grid">
      <label class="field">Department <input class="input" name="department" value="${esc(p.department ?? "")}" list="dl-dept" autocomplete="off"></label>
      <label class="field">Designation <input class="input" name="designation" value="${esc(p.designation ?? "")}" list="dl-desig" autocomplete="off"></label>
      <label class="field">Market
        <select class="select" name="market_pick">
          <option value="">Choose…</option>
          ${MARKETS.map((m) => `<option ${p.market === m ? "selected" : ""}>${m}</option>`).join("")}
          <option value="other" ${other ? "selected" : ""}>Other</option>
        </select>
        <input class="input" name="market_other" placeholder="Type the market" value="${other ? esc(p.market) : ""}" ${other ? "" : "hidden"} style="margin-top:6px">
      </label>
      <label class="field">Reporting Manager <input class="input" name="manager" value="${esc(p.manager ?? "")}" list="dl-mgr" autocomplete="off"></label>
    </div>
    ${datalist("dl-dept", "department")}${datalist("dl-desig", "designation")}${datalist("dl-mgr", "manager")}`;
}

// Suggest values already used, so spellings stay consistent for the dashboard
const datalist = (id, key) =>
  `<datalist id="${id}">${[...new Set(people.map((p) => p[key]).filter(Boolean))].sort().map((v) => `<option value="${esc(v)}">`).join("")}</datalist>`;

function wireDetails(form) {
  const pick = form.market_pick;
  pick?.addEventListener("change", () => {
    form.market_other.hidden = pick.value !== "other";
    if (pick.value === "other") form.market_other.focus();
  });
}

function readDetails(f, required) {
  const d = {
    department: f.department.value.trim() || null,
    designation: f.designation.value.trim() || null,
    market: (f.market_pick.value === "other" ? cleanMarket(f.market_other.value) : f.market_pick.value) || null,
    manager: f.manager.value.trim() || null,
  };
  if (required) {
    const missing = Object.entries({ department: "Department", designation: "Designation", market: "Market", manager: "Reporting Manager" })
      .filter(([k]) => !d[k]).map(([, l]) => l);
    if (missing.length) throw new Error(`Please fill in: ${missing.join(", ")}.`);
  }
  return d;
}

async function saveDetails(profileId, details) {
  const { error } = await sb.from("profiles").update(details).eq("id", profileId);
  if (error) throw error;
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
      ${detailFields()}
      <span class="hint" style="margin-top:-6px">Required for learners: the dashboard reports by these.</span>
      ${passwordField()}`,
    submitLabel: "Create Account",
    onSubmit: async (f) => {
      const person = { full_name: f.full_name.value.trim(), email: f.email.value.trim().toLowerCase(), role: f.role.value };
      const details = readDetails(f, person.role === "learner");
      const password = f.password.value.trim();
      const { profile_id } = await manageAccount({ action: "create", ...person, password });
      await saveDetails(profile_id, details);
      toast(`Account created for ${person.full_name}.`);
      await load(main);
      showCredentials(person, password);
    },
  });
  wireGenerate(form);
  wireDetails(form);
}

// ---------------------------------------------------------------------
// Add many: paste rows from Excel
// Full Name | Email | Department | Designation | Market | Reporting Manager
// ---------------------------------------------------------------------
const BULK_COLUMNS = ["Full Name", "Email", "Department", "Designation", "Market", "Reporting Manager"];

function addMany(main) {
  const { form } = openModal({
    title: "Add Many People",
    intro: `Copy the rows from Excel and paste them below, one person per line, in this order: <b>${BULK_COLUMNS.join(" · ")}</b>.`,
    wide: true,
    body: `
      <button type="button" class="btn sm" data-template>${icons.download} Download Excel Template</button>
      <textarea class="input" name="lines" rows="8" placeholder="Juan Dela Cruz&#9;juan.delacruz@company.com&#9;Operations&#9;Team Lead&#9;Philippines&#9;Maria Santos"></textarea>
      ${isAdmin()
        ? `<label class="field">Role For Everyone In This List <select class="select" name="role">${roleOptions()}</select></label>`
        : '<input type="hidden" name="role" value="learner">'}
      <div class="notice info">Market can be US, Sri Lanka, India, Philippines, or another market. Each person gets their own temporary password, and you can download everyone's sign-in details when it finishes.</div>`,
    submitLabel: "Create Accounts",
    onSubmit: async (f) => {
      const lines = f.lines.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        .filter((l) => !/^full name\b/i.test(l)); // skip a pasted header row
      const parsed = lines.map((line) => {
        const parts = (line.includes("\t") ? line.split("\t") : line.split(/,|;/)).map((x) => x.trim());
        const [full_name = "", email = "", department = "", designation = "", market = "", manager = ""] = parts;
        return { line, full_name, email: email.toLowerCase(), department, designation, market: cleanMarket(market), manager };
      });
      if (!parsed.length) throw new Error("Paste at least one line.");
      const learners = f.role.value === "learner";
      const bad = parsed.filter((p) => !p.full_name || !p.email.includes("@") ||
        (learners && !(p.department && p.designation && p.market && p.manager)));
      if (bad.length) {
        throw new Error(`These lines are missing ${learners ? "a column" : "a name or email"}: ${bad.slice(0, 5).map((b) => `"${b.line.replace(/\t/g, " | ")}"`).join(", ")}${bad.length > 5 ? ` and ${bad.length - 5} more` : ""}`);
      }

      const submit = f.querySelector('[type="submit"]');
      const results = [];
      for (const [i, person] of parsed.entries()) {
        submit.textContent = `Creating ${i + 1} of ${parsed.length}…`;
        const password = generatePassword();
        try {
          const { profile_id } = await manageAccount({ action: "create", full_name: person.full_name, email: person.email, role: f.role.value, password });
          const { department, designation, market, manager } = person;
          await saveDetails(profile_id, { department: department || null, designation: designation || null, market: market || null, manager: manager || null });
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
  form.querySelector("[data-template]").addEventListener("click", () => downloadTemplate());
}

async function downloadTemplate() {
  await loadScript(LIBS.xlsx);
  const X = window.XLSX;
  const ws = X.utils.aoa_to_sheet([BULK_COLUMNS, ["Juan Dela Cruz", "juan.delacruz@healthreconconnect.com", "Operations", "Team Lead", "Philippines", "Maria Santos"]]);
  ws["!cols"] = [26, 36, 22, 22, 14, 24].map((w) => ({ wch: w }));
  const lists = X.utils.aoa_to_sheet([["Markets"], ...MARKETS.map((m) => [m]), ["(or type another market)"]]);
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, "People");
  X.utils.book_append_sheet(wb, lists, "Markets");
  X.writeFile(wb, "GrowthPoint People Template.xlsx");
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
      ["Full Name", "Email", "Temporary Password", "Link", "Department", "Designation", "Market", "Reporting Manager"],
      ...created.map((r) => [r.full_name, r.email, r.password, portalUrl(), r.department, r.designation, r.market, r.manager]),
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

function editDetails(p, main) {
  const { form } = openModal({
    title: `Edit Details For ${p.full_name}`,
    body: `<label class="field">Full Name <input class="input" name="full_name" value="${esc(p.full_name)}" required></label>
           ${detailFields(p)}`,
    onSubmit: async (f) => {
      const full_name = f.full_name.value.trim();
      if (!full_name) throw new Error("Please enter a name.");
      const details = readDetails(f, p.role === "learner");
      await saveDetails(p.id, { full_name, ...details });
      toast("Details updated.");
      await load(main);
    },
  });
  wireDetails(form);
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
