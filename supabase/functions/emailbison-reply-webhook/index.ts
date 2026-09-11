// Receives a client's EmailBison reply_received webhook (event type
// LEAD_REPLIED) and pushes the real reply into their HubSpot channel
// account. EmailBison has no way to inject a custom identifier into its
// own webhook payload, so each client gets a distinct webhook URL to
// register in their own EmailBison account:
//   .../emailbison-reply-webhook?client=<slug>
// which is how this resolves which client's HubSpot install to use.
//
// Payload shape confirmed against a real EmailBison webhook (via their
// "send test event" feature) — no more field-name guessing:
//   event.type                    -- "LEAD_REPLIED"
//   data.reply.id                 -- the reply ID (-> eb-reply-{id} thread tag)
//   data.reply.from_name          -- sender display name
//   data.reply.text_body          -- message text (includes quoted history —
//                                     EmailBison doesn't separate new text
//                                     from the quoted thread, so this shows
//                                     the full quote-included body; fine for
//                                     now, a known limitation to revisit)
//   data.lead.email               -- the lead's canonical email address
//
// The payload already carries everything needed — no extra GET
// /replies/{id} call required (that was the previous design; it's also
// what failed against EmailBison's synthetic test payload, since a fake
// reply ID doesn't exist to look up).
//
// No signature verification on the EmailBison side yet (their webhook
// docs don't document one) — the ?client= slug is a weak identifier, not
// an auth boundary.
import { adminClient } from "../_shared/db.ts";
import { pushInboundMessage } from "../_shared/hubspot.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const url = new URL(req.url);
  const slug = url.searchParams.get("client");
  if (!slug) {
    return json({ error: "Missing ?client=<slug> on the webhook URL" }, 400);
  }

  const admin = adminClient();
  const { data: client, error: clientError } = await admin.from("clients").select("id").eq("slug", slug).maybeSingle();
  if (clientError || !client) {
    return json({ error: `Unknown client slug "${slug}"`, dbError: clientError?.message }, 404);
  }

  const payload = await req.json().catch(() => ({})) as Record<string, unknown>;

  const eventType = (payload.event as Record<string, unknown> | undefined)?.type;
  if (eventType !== "LEAD_REPLIED") {
    console.log(`[emailbison-reply-webhook] ignoring event type "${eventType}" for client ${slug}`);
    return json({ ignored: true, eventType });
  }

  const data = payload.data as Record<string, unknown> | undefined;
  const reply = data?.reply as Record<string, unknown> | undefined;
  const lead = data?.lead as Record<string, unknown> | undefined;

  const replyId = reply?.id as number | string | undefined;
  const leadEmail = lead?.email as string | undefined;
  const fullNameFromLead = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || undefined;
  const leadName = (reply?.from_name as string | undefined) ?? fullNameFromLead;
  const messageText = reply?.text_body as string | undefined;

  if (!replyId || !leadEmail || !messageText) {
    return json({
      error: "Payload is missing reply.id, lead.email, or reply.text_body — check the raw payload below against the expected shape",
      payload,
    }, 422);
  }

  try {
    const hsData = await pushInboundMessage({
      clientId: client.id,
      leadEmail,
      leadName,
      text: messageText,
      integrationThreadId: `eb-reply-${replyId}`,
    });
    return json({ ok: true, hubspotResponse: hsData });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[emailbison-reply-webhook] failed for client ${slug}:`, message);
    return json({ error: message }, 500);
  }
});
