# openclaw-superchat

Custom OpenClaw channel plugin for [Superchat](https://developers.superchat.com/).

- **All message types** — text, media, email, generic templates, WhatsApp
  templates, WhatsApp quick replies, WhatsApp lists via `POST /v1.0/messages`.
- **WhatsApp template workflow built in** — agent tools for creating
  templates, uploading media files, managing contact custom attributes
  (template variables), and checking Meta approval status.
- **Single-contact lock** — the plugin talks to exactly one contact in your
  Superchat account, but on **all** of that contact's channels (WhatsApp,
  SMS, email, ...). Inbound messages from anyone else are dropped at the
  webhook, DM security allowlists only that contact, and every outbound tool
  is hard-wired to the configured contact.

## Files

| File | Purpose |
| --- | --- |
| `openclaw.plugin.json` | Manifest + config schema for `channels.superchat` |
| `index.ts` | Plugin entry: webhook route + agent tool registration |
| `setup-entry.ts` | Lightweight onboarding entry |
| `src/channel.ts` | Channel plugin: account resolution, DM allowlist, sendText/sendMedia |
| `src/client.ts` | Superchat API client (messages, templates, files, attributes, contact, channels) |
| `src/tools.ts` | Agent tools exposed to OpenClaw |
| `src/channel.test.ts` | Vitest tests for the contact lock |

## Agent tools

| Tool | What it does |
| --- | --- |
| `superchat_send_message` | Send any content type to the locked contact; optional `channel_id` to pick WhatsApp vs email etc., optional `in_reply_to` |
| `superchat_create_template` | Create a WhatsApp (or generic) template: language, category, body with `{{n}}` placeholders, header (text/media), footer, buttons, variables |
| `superchat_list_templates` / `superchat_get_template` | List templates / check one — WhatsApp templates start `pending` until Meta approves |
| `superchat_delete_template` | Delete a template |
| `superchat_upload_file` / `superchat_list_files` / `superchat_get_file` | Upload local files (`fi_...`) for media messages and template headers; inspect them |
| `superchat_create_custom_attribute` / `superchat_list_custom_attributes` | Define contact attributes (`cat_...`) used as template variables |
| `superchat_get_contact` / `superchat_set_contact_attributes` | Read/write attribute values on the locked contact so variables resolve |
| `superchat_list_channels` | Discover channel ids (`mc_...`) in the account |

**Typical template flow:** `superchat_create_custom_attribute` →
`superchat_upload_file` (media header, optional) → `superchat_create_template`
→ poll `superchat_get_template` until `status: "approved"` →
`superchat_set_contact_attributes` → `superchat_send_message` with
`{"type":"whats_app_template","template_id":"tn_...","variables":[...]}`.

## Setup

### 1. Get your Superchat API key

Superchat web app → **Settings → API** (admin required). The key is sent as
the `X-API-KEY` header. Note: the key has global read/write access to your
Superchat account — keep it in your OpenClaw config only.

### 2. Find your channel id and the contact

- Channel ids (`mc_...`): `GET https://api.superchat.com/v1.0/channels`
  (or use the `superchat_list_channels` tool once running)
- Contact id (`ct_...`): search once via `POST https://api.superchat.com/v1.0/contacts/search`
  (or copy it from the contact's URL in the web app). You also need the
  contact's identifier: phone in E.164 (`+49...`) for WhatsApp/SMS, or email.

```bash
curl -s -H "X-API-KEY: $SUPERCHAT_API_KEY" https://api.superchat.com/v1.0/channels
```

### 3. Configure OpenClaw

In your OpenClaw config (`openclaw.json`):

```json
{
  "channels": {
    "superchat": {
      "apiKey": "<SUPERCHAT-API-KEY>",
      "channelId": "mc_XXXXXXXXXXXXXXXXXXXXX",
      "whatsAppBusinessAccountId": "waba_XXXX",
      "contactId": "ct_XXXXXXXXXXXXXXXXXXXXX",
      "contactIdentifier": "+491701234567",
      "senderName": "OpenClaw",
      "webhookToken": "<LONG-RANDOM-STRING>"
    }
  },
  "plugins": {
    "load": { "paths": ["/path/to/openclaw-superchat"] }
  }
}
```

`channelId` is only the **default** for outbound sends; inbound messages from
the contact are accepted from every channel, and the inbound envelope carries
`meta.superchatChannelId` so replies can go out on the same channel.

### 4. Subscribe the webhook

Point Superchat at your OpenClaw gateway (must be public HTTPS). Include the
`token` query parameter matching `webhookToken`:

```bash
curl -s -X POST https://api.superchat.com/v1.0/webhooks \
  -H "X-API-KEY: $SUPERCHAT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "target_url": "https://<your-gateway-host>/superchat/webhook?token=<LONG-RANDOM-STRING>",
    "events": [{ "type": "message_inbound" }]
  }'
```

Only `message_inbound` is subscribed; the handler acks and ignores every
other event type so Superchat never retries.

> Superchat returns a subscription `secret` intended for signing deliveries,
> but the signing scheme is not documented. The `webhookToken` query check is
> used instead; if Superchat documents the signature header, verification can
> be added in `index.ts`.

### 5. Restart OpenClaw

Restart the gateway and send a test message from the allowed contact. Check
that a message from any *other* contact gets `ignored (contact not allowed)`
in the gateway logs.

## WhatsApp template notes

- **Categories:** `marketing`, `utility`, `transactional`, `authentication`
  etc. — Meta reviews the category against the content; mismatches get
  rejected.
- **Approval:** new templates are `pending`; sending a pending/rejected
  template fails. Poll `superchat_get_template` (approval typically takes
  minutes to hours).
- **Variables:** `{{1}}`, `{{2}}`, ... in the body map to contact attributes
  via `variables: [{position, attribute_identifier}]` at template-creation
  time; at send time you can pass explicit `variables: [{position, value}]`.
- **24-hour rule:** free-form messages (text/media/quick reply/list) only
  reach WhatsApp users inside the 24h customer-service window after their
  last inbound message; outside it, only approved templates deliver.
- **Media headers:** upload via `superchat_upload_file` first, then reference
  `file_id` in the template header or the send-time `file`.

## Notes / limitations

- Inbound media arrives as a `[media message, file_id: fi_...]` placeholder;
  the agent can fetch a signed URL via `superchat_get_file`.
- One account (`default`) is supported.
- Template folders and template analytics endpoints are not wired up; add
  them to `src/client.ts` if needed.
