// Receives a client's EmailBison reply_received webhook and pushes the
// real reply into their HubSpot channel account. EmailBison has no way to
// inject a custom identifier into its own webhook payload, so each client
// gets a distinct webhook URL to register in their own EmailBison account:
//   .../emailbison-reply-webhook?client=<slug>
// which is how this resolves which client's credentials to use.
//
// CAUTION — two guesses, both self-correcting via the returned raw
// payload/reply object on a lookup failure: (1) which field in
// EmailBison's webhook payload holds the reply ID (tries several
// candidates), and (2) which fields on the full reply object (fetched via
// getReply(), a confirmed-real endpoint) hold the lead's email/name and
// message text (also tries several candidates) — carried over from the
// single-tenant prototype build, still pending a real live webhook call to
// confirm.
//
// No signature verification on the EmailBison side yet (their webhook
// docs are thin on this) — a known gap. The ?client= slug acts as a weak
// identifier, not an auth boundary; treat this as trusted-network-only
// until EmailBison's webhook signing (if any) is confirmed and added.
import { adminClient } from "../_shared/db.ts";
import { getCredentials, getReply } from "../_shared/emailbison.ts";
import { pushInboundMessage } from "../_shared/hubspot.ts";

function firstDefined(obj: Record<string, unknown>, paths: string[]): unknown {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>((acc, key) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
      return undefined;
    }, obj);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const url = new URL(req.url);
  const slug = url.searchParams.get("client");
  if (!slug) {
    return new Response(JSON.stringify({ error: "Missing ?client=<slug> on the webhook URL" }, null, 2), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const admin = adminClient();
  const { data: client, error: clientError } = await admin.from("clients").select("id").eq("slug", slug).maybeSingle();
  if (clientError || !client) {
    return new Response(JSON.stringify({ error: `Unknown client slug "${slug}"`, dbError: clientError?.message }, null, 2), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawPayload = await req.json().catch(() => ({}));
  const replyId = firstDefined(rawPayload, [
    "id", "reply_id", "data.id", "data.reply_id", "data.reply.id", "reply.id",
  ]);

  if (!replyId) {
    return new Response(JSON.stringify({ error: "Could not find a reply ID in the webhook payload", rawPayload }, null, 2), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const creds = await getCredentials(client.id);
    const reply = await getReply(creds, replyId as number | string);
    const replyObj = reply as Record<string, unknown>;

    const leadEmail = firstDefined(replyObj, ["lead.email", "lead_email", "from_email", "sender_email", "email"]) as string | undefined;
    const leadName = firstDefined(replyObj, ["lead.first_name", "lead.name", "from_name", "sender_name", "name"]) as string | undefined;
    const messageText = firstDefined(replyObj, ["text_body", "body", "message", "snippet", "text", "content"]) as string | undefined;

    if (!leadEmail || !messageText) {
      return new Response(JSON.stringify({
        error: "Could not extract lead email or message text from the reply object — check field names below",
        rawPayload,
        emailBisonReply: reply,
      }, null, 2), { status: 422, headers: { "Content-Type": "application/json" } });
    }

    const hsData = await pushInboundMessage({
      clientId: client.id,
      leadEmail,
      leadName,
      text: messageText,
      integrationThreadId: `eb-reply-${replyId}`,
    });

    return new Response(JSON.stringify({ ok: true, hubspotResponse: hsData }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[emailbison-reply-webhook] failed for client ${slug}:`, message);
    return new Response(JSON.stringify({ error: message, rawPayload }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
