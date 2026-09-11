// TEST SCRIPT — not part of the product, just a one-off way to prove the
// real EmailBison reply_received webhook works end-to-end. Creates a
// one-step test campaign in the given client's EmailBison workspace and
// attaches one lead to it (their own inbox, so replying is safe — this
// sends a REAL email to whatever address you pass).
//
// ?client=<slug>&email=<leadEmail>&firstName=<optional, defaults to "Test">
//
// After running: wait for the campaign to actually send (may not be
// instant — depends on EmailBison's sending schedule), open the email
// when it arrives, and reply to it. If the emailbison-reply-webhook has
// been registered for this client (see onboard-client's "connect" step
// output), that reply should show up in their HubSpot inbox shortly
// after.
import { getClientIdBySlug } from "../_shared/db.ts";
import { getCredentials, createCampaign, createSequenceSteps, createOrUpdateLeads, attachLeadsToCampaign } from "../_shared/emailbison.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const slug = url.searchParams.get("client");
  const email = url.searchParams.get("email");
  const firstName = url.searchParams.get("firstName") ?? "Test";

  if (!slug || !email) {
    return json({ error: "Required: client=<slug>&email=<leadEmail>" }, 400);
  }

  try {
    const clientId = await getClientIdBySlug(slug);
    const creds = await getCredentials(clientId);

    const campaign = await createCampaign(creds, `Reply Management test — ${slug} — ${new Date().toISOString()}`);

    await createSequenceSteps(creds, campaign.id, "Test sequence", [{
      email_subject: "Quick question",
      email_body: `Hi ${firstName},\n\nThis is a one-off test message from the Reply Management build — reply to this email to test the full loop (EmailBison -> HubSpot -> reply back through EmailBison).\n\nThanks!`,
      wait_in_days: 1, // EmailBison rejects 0 with a 422 — minimum is 1
      order: 1,
    }]);

    const leads = await createOrUpdateLeads(creds, [{ first_name: firstName, email }]);
    const lead = leads[0];

    await attachLeadsToCampaign(creds, campaign.id, [lead.id]);

    return json({
      ok: true,
      campaignId: campaign.id,
      leadId: lead.id,
      leadEmail: email,
      nextStep: `Watch ${email} for the test email (may take a few minutes depending on EmailBison's send schedule), then reply to it. If it worked, the reply should show up in this client's HubSpot inbox shortly after.`,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
