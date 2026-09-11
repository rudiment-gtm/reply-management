-- Readable labels alongside the raw IDs, so a client's HubSpot portal and
-- EmailBison workspace are identifiable at a glance once there are many
-- rows — not just an opaque portal_id / api_key.

alter table hubspot_installs add column if not exists hub_domain text;

alter table emailbison_credentials add column if not exists account_label text;
