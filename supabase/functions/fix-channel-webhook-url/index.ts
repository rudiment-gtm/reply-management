// ONE-TIME FIX SCRIPT — updates the shared custom channel's webhookUrl to
// point at THIS project instead of the single-tenant prototype's Supabase
// project (ryyfoaekvrvxobfzpvcr.supabase.co), which is what it was
// registered with originally. The channel is a single, shared, app-level
// resource (see README) — there's only ever one to fix, regardless of how
// many clients are onboarded.
//
// Visit this function's URL once. Uses the same Developer API key +
// appId auth as channel registration (PATCH, unlike most other calls in
// this codebase, does NOT accept the OAuth access token — confirmed by
// the same testing that established this for POST /custom-channels).
const APP_ID = 52264375;
const CHANNEL_ID = "3519390";
const NEW_WEBHOOK_URL = "https://dnucrisnkcrzalxlskuq.supabase.co/functions/v1/hubspot-custom-channel-webhook";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured. Set it as a Supabase Edge Function secret.`);
  return value;
}

Deno.serve(async (_req) => {
  try {
    const hapikey = requireEnv("HUBSPOT_DEVELOPER_API_KEY");
    const url = `https://api.hubapi.com/conversations/v3/custom-channels/${CHANNEL_ID}?hapikey=${encodeURIComponent(hapikey)}&appId=${APP_ID}`;

    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookUrl: NEW_WEBHOOK_URL }),
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    return new Response(JSON.stringify({ status: res.status, ok: res.ok, data }, null, 2), {
      status: res.ok ? 200 : 502,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
