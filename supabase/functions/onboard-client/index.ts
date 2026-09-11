// Three-step onboarding flow for a new client, driven by ?action=. Meant to
// be run manually (or from a future admin UI) by whoever's setting up a
// new client — not called by HubSpot or EmailBison themselves.
//
//   1. ?action=create&name=<name>&slug=<slug>&emailbisonApiKey=<key>&emailbisonBaseUrl=<url>&emailbisonAccountLabel=<label>
//      Creates the client + stores their EmailBison credentials.
//      emailbisonAccountLabel is optional (defaults to name) — a readable
//      tag for which EmailBison workspace this is, since the API key
//      itself isn't. Returns clientId and an installUrl for them (or you,
//      on their behalf) to open and authorize.
//
//   2. ?action=list-inboxes&client=<clientId>
//      Once the HubSpot OAuth install (step 1's installUrl) has completed,
//      lists that portal's Conversations inboxes so you can pick one.
//
//   3. ?action=connect&client=<clientId>&inboxId=<id>&deliveryIdentifier=<email>
//      Creates the channel account, completing onboarding — after this,
//      real replies for this client will show up in their HubSpot inbox.
import { adminClient } from "../_shared/db.ts";
import { buildInstallUrl, listInboxes, createChannelAccount } from "../_shared/hubspot.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const admin = adminClient();

  try {
    if (action === "create") {
      const name = url.searchParams.get("name");
      const slug = url.searchParams.get("slug");
      const emailbisonApiKey = url.searchParams.get("emailbisonApiKey");
      const emailbisonBaseUrl = url.searchParams.get("emailbisonBaseUrl");
      const emailbisonAccountLabel = url.searchParams.get("emailbisonAccountLabel") ?? name;
      if (!name || !slug || !emailbisonApiKey || !emailbisonBaseUrl) {
        return json({ error: "Required: name, slug, emailbisonApiKey, emailbisonBaseUrl" }, 400);
      }

      const { data: client, error: clientError } = await admin
        .from("clients")
        .insert({ name, slug })
        .select("id")
        .single();
      if (clientError) return json({ error: `Failed to create client: ${clientError.message}` }, 500);

      const { error: credError } = await admin.from("emailbison_credentials").insert({
        client_id: client.id,
        api_key: emailbisonApiKey,
        base_url: emailbisonBaseUrl,
        account_label: emailbisonAccountLabel,
      });
      if (credError) return json({ error: `Failed to store EmailBison credentials: ${credError.message}` }, 500);

      return json({
        step: "create",
        clientId: client.id,
        installUrl: buildInstallUrl(client.id),
        nextStep: "Open installUrl, authorize on the client's HubSpot portal, then call ?action=list-inboxes&client=" + client.id,
      });
    }

    if (action === "list-inboxes") {
      const clientId = url.searchParams.get("client");
      if (!clientId) return json({ error: "Required: client=<clientId>" }, 400);
      const inboxes = await listInboxes(clientId);
      return json({
        step: "list-inboxes",
        inboxes,
        nextStep: `Re-visit with ?action=connect&client=${clientId}&inboxId=<id from above>&deliveryIdentifier=<an email address>`,
      });
    }

    if (action === "connect") {
      const clientId = url.searchParams.get("client");
      const inboxId = url.searchParams.get("inboxId");
      const deliveryIdentifier = url.searchParams.get("deliveryIdentifier");
      if (!clientId || !inboxId || !deliveryIdentifier) {
        return json({ error: "Required: client, inboxId, deliveryIdentifier" }, 400);
      }
      const channelAccountId = await createChannelAccount(clientId, inboxId, deliveryIdentifier);

      const { data: client } = await admin.from("clients").select("name, slug").eq("id", clientId).single();
      const { data: install } = await admin.from("hubspot_installs").select("portal_id, hub_domain").eq("client_id", clientId).single();
      const { data: emailbison } = await admin.from("emailbison_credentials").select("account_label").eq("client_id", clientId).single();
      // SUPABASE_URL rather than deriving from req.url — Supabase's edge
      // runtime rewrites the request's own scheme/host internally (the
      // same issue that broke the OAuth redirect_uri in the single-tenant
      // prototype), so this env var is the only reliable source.
      const projectUrl = Deno.env.get("SUPABASE_URL");
      return json({
        step: "connect",
        channelAccountId,
        onboardingComplete: true,
        summary: {
          client: client?.name,
          hubspotPortal: install ? `${install.hub_domain ?? "unknown domain"} (${install.portal_id})` : undefined,
          emailBisonAccount: emailbison?.account_label,
        },
        emailBisonWebhookUrlToRegister: client && projectUrl
          ? `${projectUrl}/functions/v1/emailbison-reply-webhook?client=${client.slug}`
          : "(lookup failed — build the URL manually as <project-url>/functions/v1/emailbison-reply-webhook?client=<slug>)",
      });
    }

    return json({
      error: "Unknown or missing action",
      validActions: ["create", "list-inboxes", "connect"],
    }, 400);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
