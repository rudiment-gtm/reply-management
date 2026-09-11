-- ── Reply Management: multitenant schema ─────────────────────────────────
-- One client = one company we're selling this to. Each client gets their
-- own HubSpot OAuth install (their own portal, their own channel account)
-- and their own EmailBison credentials (their own workspace/sending
-- domains — NOT Rudiment's internal send.getrudiment.com account).
--
-- What's deliberately NOT per-client: the HubSpot custom channel itself
-- (channelId). Registering a channel is an app-level action done once
-- (see supabase/functions/onboard-client and its ONE_TIME_REGISTER mode);
-- every client's install creates their own *channel account* under that
-- same shared channel, same as HubSpot's own model for e.g. a WhatsApp
-- Business channel serving multiple portals.
--
-- All access to this schema is from service-role edge functions — there is
-- no end-user Supabase-authenticated frontend yet, so RLS is enabled with
-- no policies (deny-all for anon/authenticated; service role bypasses RLS
-- and is the only reader/writer).

create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Used as the ?client= query param on this client's EmailBison webhook
  -- URL — EmailBison has no way to inject an identifier into its own
  -- webhook payload, so the URL itself is how we resolve which client an
  -- inbound reply belongs to.
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table clients enable row level security;

drop trigger if exists clients_updated_at on clients;
create trigger clients_updated_at before update on clients
  for each row execute function update_updated_at_column();

create table if not exists hubspot_installs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade unique,
  -- HubSpot's hub/portal ID — how we resolve which client an outbound
  -- (rep-sent-a-reply) webhook event belongs to, since HubSpot's payload
  -- carries the portal ID, not our own client_id.
  portal_id bigint not null unique,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  -- Set after the channel-account creation step of onboarding; null until
  -- then, which is how we know a client's install is incomplete.
  channel_account_id text,
  inbox_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table hubspot_installs enable row level security;

drop trigger if exists hubspot_installs_updated_at on hubspot_installs;
create trigger hubspot_installs_updated_at before update on hubspot_installs
  for each row execute function update_updated_at_column();

create table if not exists emailbison_credentials (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade unique,
  -- Each client may run their own EmailBison instance/subdomain, not just
  -- a different API key on the same one — store both rather than assume
  -- a shared base_url.
  base_url text not null,
  api_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table emailbison_credentials enable row level security;

drop trigger if exists emailbison_credentials_updated_at on emailbison_credentials;
create trigger emailbison_credentials_updated_at before update on emailbison_credentials
  for each row execute function update_updated_at_column();
