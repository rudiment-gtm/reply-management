// OAuth redirect target for the shared "Reply Management" HubSpot app.
// HubSpot redirects here with `code` and `state` (the client_id we passed
// when building the install link — see _shared/hubspot.ts buildInstallUrl)
// after a user authorizes the app on their portal.
//
// redirect_uri is read from HUBSPOT_OAUTH_REDIRECT_URI rather than derived
// from the request: Supabase's edge runtime rewrites both scheme and host
// internally (a lesson from the single-tenant prototype build), so the
// only reliable value is the fixed public URL registered in the HubSpot
// app's redirectUrls.
import { completeOAuthInstall } from "../_shared/hubspot.ts";

function html(body: string, status = 200) {
  return new Response(`<!doctype html><html><body style="font-family: sans-serif; padding: 2rem;">${body}</body></html>`, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return html(`<h1>HubSpot authorization failed</h1><p>${error}</p>`, 400);
  if (!code) return html(`<h1>Missing authorization code</h1>`, 400);
  if (!state) return html(`<h1>Missing state (client identifier)</h1><p>The install link must include ?state=&lt;client_id&gt;.</p>`, 400);

  try {
    const { portalId } = await completeOAuthInstall(state, code);
    return html(`<h1>Connected</h1><p>Portal ${portalId} is now linked to client ${state}. You can close this tab and continue onboarding.</p>`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[hubspot-oauth-callback] install failed:", message);
    return html(`<h1>Something went wrong</h1><pre>${message}</pre>`, 500);
  }
});
