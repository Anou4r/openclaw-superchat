import { randomBytes } from "node:crypto";
import { SuperchatClient } from "./client.js";
const channel = "superchat";
function getSection(cfg) {
  return cfg.channels?.[channel] ?? {};
}
function isConfigured(s) {
  return Boolean(s.apiKey && s.channelId && s.contactId && s.contactIdentifier);
}
function applySection(cfg, patch) {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: { ...getSection(cfg), ...patch, enabled: true }
    }
  };
}
function required(value) {
  return String(value ?? "").trim() ? void 0 : "Required";
}
async function promptApiKey(prompter, current) {
  await prompter.note(
    [
      "You need a Superchat API key (admin required):",
      "Superchat web app -> Settings -> API",
      "https://app.superchat.de/settings/integrations",
      "The key is sent as the X-API-KEY header and grants global access -",
      "it is stored only in your OpenClaw config."
    ].join("\n"),
    "Superchat setup"
  );
  return String(
    await prompter.text({
      message: "Superchat API key",
      placeholder: "sk_...",
      initialValue: current.apiKey ?? void 0,
      validate: required
    })
  ).trim();
}
async function promptChannelId(prompter, client, current) {
  try {
    const res = await client.listChannels();
    const channels = res.results ?? [];
    if (channels.length === 0) {
      await prompter.note(
        "The API key works, but no channels were found in this Superchat account.",
        "Superchat channels"
      );
      return {
        channelId: String(
          await prompter.text({
            message: "Default outbound channel id (mc_...)",
            placeholder: "mc_XXXXXXXXXXXXXXXXXXXXX",
            initialValue: current.channelId ?? void 0,
            validate: required
          })
        ).trim(),
        apiKeyValid: true
      };
    }
    const picked = await prompter.select({
      message: "Default outbound channel (used unless a send overrides it)",
      options: channels.map((c) => ({
        label: `${c.name ?? c.id} [${c.type ?? "?"}]${c.phone_number ? ` ${c.phone_number}` : c.email_address ? ` ${c.email_address}` : ""}`,
        value: c.id
      })),
      initialValue: channels.find((c) => c.id === current.channelId)?.id ?? channels[0]?.id
    });
    return { channelId: String(picked), apiKeyValid: true };
  } catch (err) {
    await prompter.note(
      [
        `Could not list channels with this API key: ${String(err).slice(0, 200)}`,
        "You can still enter the channel id manually, but double-check the key."
      ].join("\n"),
      "Superchat API"
    );
    return {
      channelId: String(
        await prompter.text({
          message: "Default outbound channel id (mc_...)",
          placeholder: "mc_XXXXXXXXXXXXXXXXXXXXX",
          initialValue: current.channelId ?? void 0,
          validate: required
        })
      ).trim(),
      apiKeyValid: false
    };
  }
}
function normalizeHandle(value) {
  return value.replace(/[^a-z0-9@.]/gi, "").toLowerCase();
}
function handleMatches(handleValue, query) {
  const a = normalizeHandle(handleValue);
  const b = normalizeHandle(query);
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}
async function findContacts(client, field, value, onNote) {
  try {
    const res = await client.searchContactsByHandle(field, value);
    if ((res.results ?? []).length > 0) return res.results;
  } catch {
    await onNote("Search API rejected the query \u2014 scanning the contact list instead...");
  }
  const matches = [];
  let after;
  for (let page = 0; page < 20; page++) {
    const res = await client.listContacts(after);
    for (const c of res.results ?? []) {
      if ((c.handles ?? []).some((h) => handleMatches(h.value, value))) {
        matches.push(c);
      }
    }
    after = res.pagination?.next_cursor ?? void 0;
    if (!after || matches.length >= 10) break;
  }
  return matches;
}
async function promptContact(prompter, client, current, apiKeyValid) {
  await prompter.note(
    [
      "This plugin is locked to exactly ONE Superchat contact.",
      "Messages from every other contact are ignored, and outbound",
      "messages can only go to this contact (on any of their channels)."
    ].join("\n"),
    "Single-contact lock"
  );
  const method = apiKeyValid ? await prompter.select({
    message: "How do you want to pick the allowed contact?",
    options: [
      { label: "Search by phone number", value: "phone" },
      { label: "Search by email", value: "mail" },
      { label: "Enter contact id (ct_...) manually", value: "manual" }
    ],
    initialValue: current.contactId ? "manual" : "phone"
  }) : "manual";
  if (method === "phone" || method === "mail") {
    const value = String(
      await prompter.text({
        message: method === "phone" ? "Contact phone number (E.164, e.g. +491701234567)" : "Contact email address",
        placeholder: method === "phone" ? "+491701234567" : "name@example.com",
        validate: required
      })
    ).trim();
    try {
      const contacts = await findContacts(
        client,
        method,
        value,
        (msg) => prompter.note(msg, "Contact search")
      );
      if (contacts.length === 0) {
        await prompter.note(
          `No contact found for ${value}. Falling back to manual entry.`,
          "Contact search"
        );
      } else {
        const pickedId = await prompter.select({
          message: "Select the allowed contact",
          options: contacts.map((c) => ({
            label: `${[c.first_name, c.last_name].filter(Boolean).join(" ") || c.id} (${c.handles?.map((h) => h.value).join(", ") ?? "no handles"})`,
            value: c.id
          })),
          initialValue: contacts[0]?.id
        });
        const picked = contacts.find((c) => c.id === pickedId) ?? contacts[0];
        const handles = picked.handles ?? [];
        let identifier = value;
        if (handles.length > 1) {
          identifier = String(
            await prompter.select({
              message: "Which identifier should outbound messages use? (must match the outbound channel type)",
              options: handles.map((h) => ({
                label: `${h.value} [${h.type}]`,
                value: h.value
              })),
              initialValue: handles.find((h) => h.value === value)?.value ?? handles[0]?.value
            })
          );
        } else if (handles.length === 1) {
          identifier = handles[0].value;
        }
        return { contactId: picked.id, contactIdentifier: identifier };
      }
    } catch (err) {
      await prompter.note(
        [
          `Contact search failed: ${String(err).slice(0, 200)}`,
          "Falling back to manual entry (copy the ct_... id from the",
          "contact's URL in the Superchat web app)."
        ].join("\n"),
        "Contact search"
      );
    }
  }
  const contactId = String(
    await prompter.text({
      message: "Allowed contact id (ct_...)",
      placeholder: "ct_XXXXXXXXXXXXXXXXXXXXX",
      initialValue: current.contactId ?? void 0,
      validate: required
    })
  ).trim();
  const contactIdentifier = String(
    await prompter.text({
      message: "Contact identifier for outbound sends (E.164 phone or email)",
      placeholder: "+491701234567",
      initialValue: current.contactIdentifier ?? void 0,
      validate: required
    })
  ).trim();
  return { contactId, contactIdentifier };
}
function extractWabaId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return void 0;
  const prefixed = s.match(/waba_[A-Za-z0-9]+/);
  if (prefixed) return prefixed[0];
  const labeled = s.match(/waba[\s_-]*id\s*[:=]?\s*(\d{6,})/i);
  if (labeled) return labeled[1];
  const numbers = s.match(/\d{6,}/g) ?? [];
  if (numbers.length === 1) return numbers[0];
  return void 0;
}
async function promptOptionals(prompter, current) {
  const senderName = String(
    await prompter.text({
      message: "Sender display name (optional, shown as 'from' name)",
      placeholder: "OpenClaw",
      initialValue: current.senderName ?? void 0
    })
  ).trim();
  const wantsWaba = await prompter.confirm({
    message: "Configure a WhatsApp Business Account id for template creation?",
    initialValue: Boolean(current.whatsAppBusinessAccountId)
  });
  let whatsAppBusinessAccountId = current.whatsAppBusinessAccountId;
  if (wantsWaba) {
    const raw = String(
      await prompter.text({
        message: 'WhatsApp Business Account id (paste is fine \u2014 e.g. "WABA ID: 465726..., Business ID: 394530...")',
        placeholder: "WABA ID: 4657... or waba_XXXX or bare digits",
        initialValue: current.whatsAppBusinessAccountId ?? void 0,
        validate: (value) => extractWabaId(value) ? void 0 : "No WABA id found in the input"
      })
    );
    whatsAppBusinessAccountId = extractWabaId(raw);
  }
  return {
    ...senderName ? { senderName } : {},
    ...whatsAppBusinessAccountId ? { whatsAppBusinessAccountId } : {}
  };
}
async function promptWebhookToken(prompter, current) {
  if (current.webhookToken) {
    const keep = await prompter.confirm({
      message: "Keep the existing webhook token?",
      initialValue: true
    });
    if (keep) return current.webhookToken;
  }
  const generate = await prompter.confirm({
    message: "Generate a random webhook token? (protects /superchat/webhook)",
    initialValue: true
  });
  if (generate) return randomBytes(32).toString("hex");
  const manual = String(
    await prompter.text({
      message: "Webhook token (leave empty to disable the token check)",
      placeholder: "long-random-string",
      initialValue: ""
    })
  ).trim();
  return manual || void 0;
}
async function noteCompletion(prompter, webhookToken) {
  const tokenSuffix = webhookToken ? `?token=${webhookToken}` : "";
  await prompter.note(
    [
      "Superchat channel configured. Two steps remain:",
      "",
      "1. Restart the gateway:",
      "   openclaw gateway restart",
      "",
      "2. Subscribe the webhook (gateway must be public HTTPS):",
      "   curl -X POST https://api.superchat.com/v1.0/webhooks \\",
      '     -H "X-API-KEY: <YOUR-API-KEY>" -H "Content-Type: application/json" \\',
      `     -d '{"target_url":"https://<your-host>/superchat/webhook${tokenSuffix}","events":[{"type":"message_inbound"}]}'`,
      "",
      "Then send a test message from the allowed contact."
    ].join("\n"),
    "Superchat setup complete"
  );
}
const superchatSetupWizard = {
  channel,
  credentials: [],
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs setup",
    resolveConfigured: ({ cfg }) => isConfigured(getSection(cfg)),
    resolveStatusLines: ({ cfg, configured }) => {
      const s = getSection(cfg);
      return [
        `Superchat: ${configured ? "configured" : "needs setup"}`,
        ...configured ? [
          `Locked to contact ${s.contactId} (${s.contactIdentifier})`,
          `Default outbound channel ${s.channelId}`
        ] : []
      ];
    },
    resolveSelectionHint: ({ configured }) => configured ? "configured" : "Superchat inbox (single contact)"
  },
  finalize: async ({ cfg, accountId: _accountId, prompter }) => {
    const current = getSection(cfg);
    const apiKey = await promptApiKey(prompter, current);
    const client = new SuperchatClient(apiKey);
    const { channelId, apiKeyValid } = await promptChannelId(
      prompter,
      client,
      current
    );
    const { contactId, contactIdentifier } = await promptContact(
      prompter,
      client,
      current,
      apiKeyValid
    );
    const optionals = await promptOptionals(prompter, current);
    const webhookToken = await promptWebhookToken(prompter, current);
    const nextCfg = applySection(cfg, {
      apiKey,
      channelId,
      contactId,
      contactIdentifier,
      ...optionals,
      ...webhookToken ? { webhookToken } : {}
    });
    await noteCompletion(prompter, webhookToken);
    return { cfg: nextCfg };
  }
};
export {
  extractWabaId,
  superchatSetupWizard
};
