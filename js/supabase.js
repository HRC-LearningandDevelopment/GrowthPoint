import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// Calls the "admin-users" account manager (create, reset_password, change_email, set_active, delete)
export async function manageAccount(body) {
  const { data, error } = await sb.functions.invoke("admin-users", { body });
  if (error) {
    let message = error.message;
    try {
      const details = await error.context.json();
      if (details?.error) message = details.error;
    } catch { /* keep the generic message */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
