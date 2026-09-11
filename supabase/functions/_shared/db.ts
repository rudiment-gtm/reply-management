import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured. Set it as a Supabase Edge Function secret.`);
  return value;
}

export async function getClientIdBySlug(slug: string): Promise<string> {
  const admin = adminClient();
  const { data, error } = await admin.from("clients").select("id").eq("slug", slug).maybeSingle();
  if (error || !data) throw new Error(`Unknown client slug "${slug}": ${error?.message ?? "no row"}`);
  return data.id;
}
