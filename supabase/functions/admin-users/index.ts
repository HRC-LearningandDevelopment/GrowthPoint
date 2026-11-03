// L&D Learning Portal — account manager (Supabase Edge Function "admin-users")
//
// Creating logins and setting other people's passwords needs Supabase's secret
// key, which must never be in the website code. This function runs on Supabase,
// holds the key, and only acts for signed-in Admin or L&D members.
//
//   Admin: manage everyone.   L&D: manage learner accounts only.
//
// Actions (POST JSON { action, ... }):
//   create          { email, full_name, role, password }
//   reset_password  { profile_id, password }
//   change_email    { profile_id, email }
//   set_active      { profile_id, active }
//   delete          { profile_id }                 (Admin only)

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROLES = ["admin", "ld", "learner"];
const MIN_PASSWORD = 8;
const FOREVER = "876000h"; // ~100 years: how Supabase "bans" a login

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

class Refusal extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ilike() treats _ and % as wildcards; escape them so emails match exactly
const exactly = (email: string) => email.replace(/[\\%_]/g, "\\$&");

function secretKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  return keys.default ?? Object.values(keys)[0];
}

function cleanEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Refusal("Please enter a valid email address.");
  return email;
}

function checkPassword(value: unknown): string {
  const password = String(value ?? "");
  if (password.length < MIN_PASSWORD) {
    throw new Refusal(`Passwords need at least ${MIN_PASSWORD} characters.`);
  }
  return password;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // --- Who is asking? ------------------------------------------------
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth?.user) throw new Refusal("Please sign in again.", 401);

    const { data: me } = await db
      .from("profiles")
      .select("id, role, is_active")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (!me || !me.is_active || !["admin", "ld"].includes(me.role)) {
      throw new Refusal("Only Admin and L&D members can manage accounts.", 403);
    }
    const isAdmin = me.role === "admin";

    const body = await req.json().catch(() => ({}));

    const log = (action: string, entityId: string, details: Record<string, unknown> = {}) =>
      db.from("activity_log").insert({
        actor_id: me.id,
        action,
        entity_type: "account",
        entity_id: entityId,
        details,
      });

    // The person being changed (L&D may only touch learners)
    const loadTarget = async () => {
      const { data, error } = await db.from("profiles").select("*").eq("id", body.profile_id).maybeSingle();
      if (error || !data) throw new Refusal("That person could not be found.", 404);
      if (!isAdmin && data.role !== "learner") {
        throw new Refusal("L&D members can only manage learner accounts.", 403);
      }
      return data;
    };

    switch (body.action) {
      // --- New account -------------------------------------------------
      case "create": {
        const email = cleanEmail(body.email);
        const fullName = String(body.full_name ?? "").trim();
        const role = String(body.role ?? "learner");
        const password = checkPassword(body.password);
        if (!fullName) throw new Refusal("Please enter the person's name.");
        if (!ROLES.includes(role)) throw new Refusal("Unknown role.");
        if (!isAdmin && role !== "learner") throw new Refusal("L&D members can only create learner accounts.", 403);

        const { data: existing } = await db.from("profiles").select("*").ilike("email", exactly(email)).maybeSingle();
        if (existing?.user_id) throw new Refusal("This email already has an account.");
        if (existing && !isAdmin && existing.role !== "learner") {
          throw new Refusal("L&D members can only manage learner accounts.", 403);
        }

        // Profile first, then the login (the login is linked to the profile by email)
        let profileId = existing?.id;
        if (existing) {
          const { error } = await db.from("profiles")
            .update({ full_name: fullName, role, is_active: true, must_change_password: true })
            .eq("id", existing.id);
          if (error) throw error;
        } else {
          const { data, error } = await db.from("profiles")
            .insert({ email, full_name: fullName, role, must_change_password: true })
            .select("id").single();
          if (error) throw error;
          profileId = data.id;
        }

        const { data: created, error: createError } = await db.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
        if (createError || !created?.user) {
          if (!existing) await db.from("profiles").delete().eq("id", profileId);
          throw new Refusal(createError?.message ?? "The login could not be created.");
        }

        await db.from("profiles").update({ user_id: created.user.id }).eq("id", profileId);
        await log("create_account", profileId!, { email, role });
        return reply({ ok: true, profile_id: profileId });
      }

      // --- Set a new temporary password -------------------------------
      case "reset_password": {
        const target = await loadTarget();
        const password = checkPassword(body.password);
        if (!target.user_id) throw new Refusal("This person has no login yet. Create their account first.");

        const { error } = await db.auth.admin.updateUserById(target.user_id, { password });
        if (error) throw new Refusal(error.message);
        await db.from("profiles").update({ must_change_password: true }).eq("id", target.id);
        await log("reset_password", target.id);
        return reply({ ok: true });
      }

      // --- Change sign-in email ----------------------------------------
      case "change_email": {
        const target = await loadTarget();
        const email = cleanEmail(body.email);
        const { data: clash } = await db.from("profiles").select("id").ilike("email", exactly(email)).neq("id", target.id).maybeSingle();
        if (clash) throw new Refusal("Another person already uses this email.");

        if (target.user_id) {
          const { error } = await db.auth.admin.updateUserById(target.user_id, { email, email_confirm: true });
          if (error) throw new Refusal(error.message);
        }
        const { error } = await db.from("profiles").update({ email }).eq("id", target.id);
        if (error) throw error;
        await log("change_email", target.id, { from: target.email, to: email });
        return reply({ ok: true });
      }

      // --- Deactivate / reactivate -------------------------------------
      case "set_active": {
        const target = await loadTarget();
        const active = Boolean(body.active);
        if (target.id === me.id && !active) throw new Refusal("You cannot deactivate your own account.");

        if (target.user_id) {
          const { error } = await db.auth.admin.updateUserById(target.user_id, {
            ban_duration: active ? "none" : FOREVER,
          });
          if (error) throw new Refusal(error.message);
        }
        const { error } = await db.from("profiles").update({ is_active: active }).eq("id", target.id);
        if (error) throw error;
        await log(active ? "reactivate_account" : "deactivate_account", target.id);
        return reply({ ok: true });
      }

      // --- Remove completely (Admin only; deactivating keeps their records) ---
      case "delete": {
        if (!isAdmin) throw new Refusal("Only Admin can delete accounts. Deactivate instead.", 403);
        const target = await loadTarget();
        if (target.id === me.id) throw new Refusal("You cannot delete your own account.");

        if (target.user_id) {
          const { error } = await db.auth.admin.deleteUser(target.user_id);
          if (error) throw new Refusal(error.message);
        }
        await log("delete_account", target.id, { email: target.email, full_name: target.full_name });
        const { error } = await db.from("profiles").delete().eq("id", target.id);
        if (error) throw error;
        return reply({ ok: true });
      }

      default:
        throw new Refusal("Unknown action.");
    }
  } catch (err) {
    const status = err instanceof Refusal ? err.status : 500;
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return reply({ error: message }, status);
  }
});
