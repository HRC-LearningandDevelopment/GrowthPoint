// Small shared helpers: safe HTML, toasts, modals, passwords

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind === "err" ? "err" : ""}`;
  el.textContent = message;
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), kind === "err" ? 6000 : 3500);
}

// Opens a modal. `body` is trusted HTML (escape user values with esc()).
// `onSubmit(form)` returns false to keep the modal open; throw to show an error.
export function openModal({ title, intro = "", body, submitLabel = "Save", danger = false, wide = false, onSubmit, cancelLabel = "Cancel" }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <form class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title" novalidate>
      <div class="modal-head">
        <h2 id="modal-title">${esc(title)}</h2>
        ${intro ? `<p>${intro}</p>` : ""}
      </div>
      <div class="modal-body">
        <div class="form-error" hidden></div>
        ${body}
      </div>
      <div class="modal-foot">
        ${cancelLabel ? `<button type="button" class="btn" data-close>${esc(cancelLabel)}</button>` : ""}
        ${submitLabel ? `<button type="submit" class="btn ${danger ? "danger solid" : "primary"}">${esc(submitLabel)}</button>` : ""}
      </div>
    </form>`;
  document.body.append(backdrop);

  const form = backdrop.querySelector("form");
  const errorBox = form.querySelector(".form-error");
  const submitBtn = form.querySelector('[type="submit"]');
  const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  form.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    errorBox.hidden = true;
    if (submitBtn) submitBtn.disabled = true;
    try {
      const keepOpen = (await onSubmit(form)) === false;
      if (!keepOpen) close();
    } catch (err) {
      errorBox.textContent = err.message || "Something went wrong.";
      errorBox.hidden = false;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  setTimeout(() => form.querySelector("input, select, textarea, button[type=submit]")?.focus(), 0);
  return { form, close };
}

// Readable temporary password, e.g. "Kp7m-Qx4t-Rw9z" (no 0/O or 1/l/I)
export function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  const raw = Array.from(bytes, (b) => chars[b % chars.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    toast("Could not copy. Select the text and copy it manually.", "err");
  }
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Third-party libraries, loaded only when an export needs them
export const LIBS = {
  xlsx: "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  jspdf: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  autotable: "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js",
  jszip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
};
const loaded = {};
export function loadScript(url) {
  loaded[url] ??= new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement("script"), { src: url, onload: resolve });
    el.onerror = () => { delete loaded[url]; reject(new Error("A download library couldn't load. Check your connection and try again.")); };
    document.head.append(el);
  });
  return loaded[url];
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// "Learner Name" style file names: no characters that upset Windows or zip tools
export const safeName = (s) => String(s ?? "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";

export const ROLE_LABEL = { admin: "Admin", ld: "L&D", learner: "Learner" };

export const PROGRAM_TYPE = { self_paced: "Self-Paced", ilt: "ILT", blended: "Blended" };

export const PROGRAM_STATUS = {
  draft:     { label: "Draft",     pill: "" },
  scheduled: { label: "Scheduled", pill: "prog" },
  live:      { label: "Live",      pill: "good" },
  on_hold:   { label: "On Hold",   pill: "warn" },
  completed: { label: "Completed", pill: "teal" },
  archived:  { label: "Archived",  pill: "" },
};

export const STEP_TYPE = {
  module:      { label: "Self-Paced Module", short: "Module" },
  ilt_session: { label: "Live Session (Teams)", short: "Live Session" },
  assessment:  { label: "Assessment", short: "Assessment" },
  survey:      { label: "Survey", short: "Survey" },
  upload:      { label: "Upload (Certificate / Workbook)", short: "Upload" },
};

// Question types for the assessment and survey builder
export const QTYPE = {
  single:    { label: "Single Choice",            forms: ["assessment", "survey"], choices: true },
  multi:     { label: "Multiple Choice (Several Answers)", forms: ["assessment", "survey"], choices: true },
  truefalse: { label: "True / False",             forms: ["assessment"] },
  short:     { label: "Short Answer",             forms: ["assessment"] },
  rating:    { label: "Rating (1 To 5 Stars)",    forms: ["survey"] },
  likert:    { label: "Agree / Disagree Scale",   forms: ["survey"] },
  nps:       { label: "0 To 10 Scale",            forms: ["survey"] },
  text:      { label: "Short Text",               forms: ["survey"] },
  paragraph: { label: "Long Text",                forms: ["survey"] },
};
export const LIKERT = ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"];

export const statusPill = (status) =>
  `<span class="pill ${PROGRAM_STATUS[status]?.pill ?? ""}">${esc(PROGRAM_STATUS[status]?.label ?? status)}</span>`;

// Dates: "2026-11-04" (date columns) and ISO timestamps
export function fmtDate(value) {
  if (!value) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// <input type="datetime-local"> works in local time without a zone
export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

export const icons = {
  // Open book with a spark of insight: GrowthPoint's mark
  brand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M12 11c-2-1.4-5-1.9-8.5-1.4v10c3.5-.5 6.5 0 8.5 1.4 2-1.4 5-1.9 8.5-1.4v-10c-3.5-.5-6.5 0-8.5 1.4z"/><path d="M12 11v10"/><path d="M12 2.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" stroke-width="1"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 4.8"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  programs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 13h8M8 16.5h5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8.5 14.5l2.5 2.5 4.5-5"/></svg>',
  messages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  // Learning-journey step types
  module: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M10 8.5v5l4-2.5z" fill="currentColor"/><path d="M8 21h8"/></svg>',
  ilt_session: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10.5 21 7.5v9l-5.5-3"/></svg>',
  assessment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3.5" width="14" height="18" rx="2"/><path d="M9 3.5h6v3H9zM8.5 12l2 2 4-4M8.5 17.5h7"/></svg>',
  survey: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
  upload_step: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-6M9.5 14.5 12 12l2.5 2.5"/></svg>',
};

export const stepIcon = (type) => icons[type === "upload" ? "upload_step" : type] ?? icons.module;
