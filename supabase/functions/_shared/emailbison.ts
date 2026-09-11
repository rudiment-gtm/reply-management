// Multitenant EmailBison REST helpers. Unlike the single-tenant M5-Services
// version this was ported from, every call takes the client's own
// {baseUrl, apiKey} explicitly — there is no single global
// EMAILBISON_API_KEY secret here, since each client runs their own
// EmailBison workspace (possibly even their own subdomain), not Rudiment's
// internal send.getrudiment.com account.
import { adminClient } from "./db.ts";

export interface EmailBisonCredentials {
  baseUrl: string;
  apiKey: string;
}

export async function getCredentials(clientId: string): Promise<EmailBisonCredentials> {
  const admin = adminClient();
  const { data, error } = await admin
    .from("emailbison_credentials")
    .select("base_url, api_key")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) throw new Error(`No EmailBison credentials found for client ${clientId}: ${error?.message ?? "no row"}`);
  return { baseUrl: data.base_url, apiKey: data.api_key };
}

async function bisonFetch(creds: EmailBisonCredentials, path: string, init: RequestInit = {}) {
  const res = await fetch(`${creds.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data as { message?: string })?.message ?? `EmailBison API ${path} failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function getReply(creds: EmailBisonCredentials, replyId: number | string): Promise<unknown> {
  return await bisonFetch(creds, `/replies/${replyId}`);
}

export interface SendReplyInput {
  replyId: number | string;
  message: string;
  senderEmailId?: number;
}

export async function sendReply(creds: EmailBisonCredentials, input: SendReplyInput): Promise<unknown> {
  const body: Record<string, unknown> = {
    message: input.message,
    reply_all: true,
    content_type: "text",
    inject_previous_email_body: true,
  };
  if (input.senderEmailId !== undefined) body.sender_email_id = input.senderEmailId;

  return await bisonFetch(creds, `/replies/${input.replyId}/reply`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Campaign/lead creation — used only by the test-create-lead setup
// script, to prove the real reply_received webhook end-to-end. Ported
// from the M5-Services prototype's _shared/emailbison.ts, parameterized
// by client credentials like everything else here.
export interface SequenceStepInput {
  email_subject: string;
  email_body: string;
  wait_in_days: number;
  order: number;
}

export async function createCampaign(creds: EmailBisonCredentials, name: string): Promise<{ id: number }> {
  const res = await bisonFetch(creds, "/campaigns", {
    method: "POST",
    body: JSON.stringify({ name }),
  }) as { data: { id: number } };
  return res.data;
}

export async function createSequenceSteps(creds: EmailBisonCredentials, campaignId: number, title: string, steps: SequenceStepInput[]) {
  const res = await bisonFetch(creds, `/campaigns/v1.1/${campaignId}/sequence-steps`, {
    method: "POST",
    body: JSON.stringify({ title, sequence_steps: steps }),
  }) as { data: { id: number; sequence_steps: { id: number }[] } };
  return res.data;
}

export interface LeadInput {
  first_name: string;
  last_name?: string;
  email: string;
  title?: string;
  company?: string;
}

export async function createOrUpdateLeads(creds: EmailBisonCredentials, leads: LeadInput[]): Promise<{ id: number; email: string }[]> {
  const res = await bisonFetch(creds, "/leads/create-or-update/multiple", {
    method: "POST",
    body: JSON.stringify({ existing_lead_behavior: "patch", leads }),
  }) as { data: { id: number; email: string }[] };
  return res.data;
}

export async function attachLeadsToCampaign(creds: EmailBisonCredentials, campaignId: number, leadIds: number[]) {
  await bisonFetch(creds, `/campaigns/${campaignId}/leads/attach-leads`, {
    method: "POST",
    body: JSON.stringify({ lead_ids: leadIds }),
  });
}
