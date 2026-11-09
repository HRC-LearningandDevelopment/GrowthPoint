// GrowthPoint — sign-in, first-time password, and the page shell
import { sb } from "./supabase.js";
import { esc, toast, openModal, icons, ROLE_LABEL } from "./ui.js";
import { renderPeople } from "./pages/people.js";
import { renderPrograms } from "./pages/programs.js";
import { renderLearning, renderPreview } from "./pages/learner.js";
import { renderReview } from "./pages/review.js";
import { renderMessages } from "./pages/messages.js";
import { renderDashboard } from "./pages/dashboard.js";

const root = document.getElementById("root");
const MIN_PASSWORD = 8;

let me = null; // the signed-in person's profile

// Pages in the sidebar, and who can open them
const STAFF = ["admin", "ld"];
const PAGES = {
  home:      { title: "My Learning",  icon: icons.home,      roles: ["learner"], render: renderLearning },
  dashboard: { title: "Dashboard",    icon: icons.dashboard, roles: STAFF,       render: renderDashboard },
  programs:  { title: "Programs",     icon: icons.programs,  roles: STAFF,       render: renderPrograms },
  review:    { title: "Review Queue", icon: icons.review,    roles: STAFF,       render: renderReview, badge: "review" },
  messages:  { title: "Messages",     icon: icons.messages,  roles: [...STAFF, "learner"], render: renderMessages, badge: "messages" },
  people:    { title: "People",       icon: icons.people,    roles: STAFF,       render: renderPeople },
  // Opened from a program (Preview As Learner / View As Learner), not from the sidebar
  preview:   { title: "Learner View", icon: icons.eye,       roles: STAFF,       render: renderPreview, hidden: true, navAs: "programs" },
};

const allowedPages = () => Object.entries(PAGES).filter(([, p]) => p.roles.includes(me.role));

// ---------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------
async function start() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return showSignIn();
  await enter();
}

async function enter() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showSignIn();

  const { data: profile, error } = await sb.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
  if (error || !profile || !profile.is_active) {
    await sb.auth.signOut();
    return showSignIn("Your account isn't set up for GrowthPoint, or it has been deactivated. Please contact the L&D team.");
  }
  me = profile;
  if (me.must_change_password) return showNewPassword();
  showApp();
}

// All tabs share one sign-in. If another tab signs out or signs in as someone
// else, follow it here so this tab never acts as a different person than it shows.
sb.auth.onAuthStateChange((event, session) => {
  if (!me) return;
  if (event === "SIGNED_OUT" || !session) { me = null; showSignIn(); return; }
  if (session.user.id !== me.user_id) {
    me = null;
    setTimeout(() => { toast("You signed in as someone else in another tab, so this tab switched too."); enter(); }, 0);
  }
});

// ---------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------
function showSignIn(message = "") {
  root.innerHTML = `
    <div class="auth">
      <div class="auth-card">
        <div class="brand-mark">${icons.brand}</div>
        <h1>GrowthPoint</h1>
        <p class="lead">Sign in with the email and password the L&amp;D team gave you.</p>
        <form id="signin" novalidate>
          <div class="form-error" ${message ? "" : "hidden"}>${esc(message)}</div>
          <label class="field">Email
            <input class="input" type="email" name="email" autocomplete="username" required>
          </label>
          <label class="field">Password
            <input class="input" type="password" name="password" autocomplete="current-password" required>
          </label>
          <button class="btn primary" type="submit">Sign In</button>
        </form>
        <p class="auth-note">Forgot your password? Ask the L&amp;D team to reset it.</p>
      </div>
    </div>`;

  const form = root.querySelector("#signin");
  const errorBox = form.querySelector(".form-error");
  form.email.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) return showError("Please enter your email and password.");

    const btn = form.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Signing In…";
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      btn.disabled = false;
      btn.textContent = "Sign In";
      const msg = /banned/i.test(error.message)
        ? "This account has been deactivated. Please contact the L&D team."
        : /invalid login/i.test(error.message)
          ? "Email or password is incorrect."
          : error.message;
      return showError(msg);
    }
    await enter();
  });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
}

// ---------------------------------------------------------------------
// First sign-in: replace the temporary password
// ---------------------------------------------------------------------
function showNewPassword() {
  root.innerHTML = `
    <div class="auth">
      <div class="auth-card">
        <div class="brand-mark">${icons.brand}</div>
        <h1>Set Your Own Password</h1>
        <p class="lead">Welcome, ${esc(me.full_name)}. You signed in with a temporary password. Choose a new one that only you know.</p>
        <form id="newpass" novalidate>
          <div class="form-error" hidden></div>
          ${passwordFields()}
          <button class="btn primary" type="submit">Save And Continue</button>
        </form>
        <p class="auth-note"><button class="link-btn" style="color:var(--ink-3)" data-signout>Sign Out</button></p>
      </div>
    </div>`;

  const form = root.querySelector("#newpass");
  const errorBox = form.querySelector(".form-error");
  root.querySelector("[data-signout]").addEventListener("click", () => sb.auth.signOut());
  form.password.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await saveNewPassword(form);
      me.must_change_password = false;
      toast("Password saved.");
      showApp();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      btn.disabled = false;
    }
  });
}

function passwordFields() {
  return `
    <label class="field">New Password
      <input class="input" type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
      <span class="hint">At least ${MIN_PASSWORD} characters.</span>
    </label>
    <label class="field">Type It Again
      <input class="input" type="password" name="confirm" autocomplete="new-password" required>
    </label>`;
}

async function saveNewPassword(form) {
  const password = form.password.value;
  if (password.length < MIN_PASSWORD) throw new Error(`Your password needs at least ${MIN_PASSWORD} characters.`);
  if (password !== form.confirm.value) throw new Error("The two passwords don't match.");

  const { error } = await sb.auth.updateUser({ password });
  if (error) {
    throw new Error(/different/i.test(error.message)
      ? "Please choose a password different from the temporary one."
      : error.message);
  }
  await sb.rpc("password_changed");
}

// ---------------------------------------------------------------------
// The app shell (sidebar + page)
// ---------------------------------------------------------------------
function showApp() {
  const nav = allowedPages().filter(([, p]) => !p.hidden)
    .map(([key, p]) => `<a href="#/${key}" data-page="${key}">${p.icon}<span>${esc(p.title)}</span>${p.badge ? `<b class="count" data-badge="${p.badge}" hidden></b>` : ""}</a>`)
    .join("");

  root.innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">${icons.brand}</div>
          <div><strong>GrowthPoint</strong><span>${esc(ROLE_LABEL[me.role])}</span></div>
        </div>
        <nav class="nav">${nav}</nav>
        <div class="sidebar-foot">
          <strong>${esc(me.full_name)}</strong>
          ${esc(me.email)}
          <div class="links">
            <button class="link-btn" data-changepass>Change Password</button>
            <button class="link-btn" data-signout>Sign Out</button>
          </div>
        </div>
      </aside>
      <main id="page"></main>
    </div>`;

  root.querySelector("[data-signout]").addEventListener("click", () => sb.auth.signOut());
  root.querySelector("[data-changepass]").addEventListener("click", changePassword);
  route();
}

function route() {
  if (!me || me.must_change_password) return;
  const main = document.getElementById("page");
  if (!main) return;

  // #/programs/<id>/<tab> → page "programs", params [id, tab]
  const pages = allowedPages();
  const [wanted, ...params] = location.hash.replace(/^#\//, "").split("/");
  const found = pages.find(([k]) => k === wanted);
  const [key, page] = found ?? pages[0];
  if (!found) history.replaceState(null, "", `#/${key}`);

  root.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === (page.navAs ?? key)));
  document.title = `${page.title} · GrowthPoint`;
  page.render(main, { me, params: found ? params.map(decodeURIComponent) : [] });
  refreshBadges();
}
window.addEventListener("hashchange", route);

// Sidebar counts for L&D: uploads waiting for review, open messages
async function refreshBadges() {
  if (!STAFF.includes(me?.role)) return;
  const [{ count: pending }, { count: open }] = await Promise.all([
    sb.from("uploads").select("id", { count: "exact", head: true }).eq("status", "pending"),
    sb.from("message_threads").select("id", { count: "exact", head: true }).eq("status", "open"),
  ]);
  for (const [name, n] of [["review", pending], ["messages", open]]) {
    const el = root.querySelector(`[data-badge="${name}"]`);
    if (!el) continue;
    el.textContent = n ?? "";
    el.hidden = !n;
  }
}

function changePassword() {
  openModal({
    title: "Change Your Password",
    body: passwordFields(),
    submitLabel: "Save Password",
    onSubmit: async (form) => {
      await saveNewPassword(form);
      toast("Password changed.");
    },
  });
}

start();
