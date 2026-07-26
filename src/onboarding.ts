/**
 * Interactive setup wizard for `openclaw channels add --channel superchat`.
 *
 * Flow:
 *   1. API key (validated live against GET /channels)
 *   2. Default outbound channel — picked from the account's real channels
 *   3. The single allowed contact — found via contact search (phone/email)
 *      or entered manually (ct_... + identifier)
 *   4. Optional: sender name, WhatsApp Business Account id
 *   5. Webhook token — auto-generated, with the ready-to-run subscription
 *      curl printed at the end
 */

import { randomBytes } from "node:crypto";
import type {
  ChannelSetupWizard,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { SuperchatClient } from "./client.js";

const channel = "superchat" as const;

type SuperchatSection = {
  apiKey?: string;
  channelId?: string;
  contactId?: string;
  contactIdentifier?: string;
  senderName?: string;
  whatsAppBusinessAccountId?: string;
  webhookToken?: string;
  enabled?: boolean;
};

function getSection(cfg: OpenClawConfig): SuperchatSection {
  return ((cfg.channels as Record<string, any> | undefined)?.[channel] ??
    {}) as SuperchatSection;
}

function isConfigured(s: SuperchatSection): boolean {
  return Boolean(s.apiKey && s.channelId && s.contactId && s.contactIdentifier);
}

function applySection(
  cfg: OpenClawConfig,
  patch: SuperchatSection,
): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: { ...getSection(cfg), ...patch, enabled: true },
    },
  } as OpenClawConfig;
}

function required(value: string): string | undefined {
  return String(value ?? "").trim() ? undefined : "Required";
}

async function promptApiKey(
  prompter: WizardPrompter,
  current: SuperchatSection,
): Promise<string> {
  await prompter.note(
    [
      "You need a Superchat API key (admin required):",
      "Superchat web app -> Settings -> API",
      "https://app.superchat.de/settings/integrations",
      "The key is sent as the X-API-KEY header and grants global access -",
      "it is stored only in your OpenClaw config.",
    ].join("\n"),
    "Superchat setup",
  );
  return String(
    await prompter.text({
      message: "Superchat API key",
      placeholder: "sk_...",
      initialValue: current.apiKey ?? undefined,
      validate: required,
    }),
  ).trim();
}

async function promptChannelId(
  prompter: WizardPrompter,
  client: SuperchatClient,
  current: SuperchatSection,
): Promise<{ channelId: string; apiKeyValid: boolean }> {
  try {
    const res = (await client.listChannels()) as {
      results?: { id: string; name?: string; type?: string; phone_number?: string; email_address?: string }[];
    };
    const channels = res.results ?? [];
    if (channels.length === 0) {
      await prompter.note(
        "The API key works, but no channels were found in this Superchat account.",
        "Superchat channels",
      );
      return {
        channelId: String(
          await prompter.text({
            message: "Default outbound channel id (mc_...)",
            placeholder: "mc_XXXXXXXXXXXXXXXXXXXXX",
            initialValue: current.channelId ?? undefined,
            validate: required,
          }),
        ).trim(),
        apiKeyValid: true,
      };
    }
    const picked = await prompter.select({
      message: "Default outbound channel (used unless a send overrides it)",
      options: channels.map((c) => ({
        label: `${c.name ?? c.id} [${c.type ?? "?"}]${
          c.phone_number ? ` ${c.phone_number}` : c.email_address ? ` ${c.email_address}` : ""
        }`,
        value: c.id,
      })),
      initialValue:
        channels.find((c) => c.id === current.channelId)?.id ?? channels[0]?.id,
    });
    return { channelId: String(picked), apiKeyValid: true };
  } catch (err) {
    await prompter.note(
      [
        `Could not list channels with this API key: ${String(err).slice(0, 200)}`,
        "You can still enter the channel id manually, but double-check the key.",
      ].join("\n"),
      "Superchat API",
    );
    return {
      channelId: String(
        await prompter.text({
          message: "Default outbound channel id (mc_...)",
          placeholder: "mc_XXXXXXXXXXXXXXXXXXXXX",
          initialValue: current.channelId ?? undefined,
          validate: required,
        }),
      ).trim(),
      apiKeyValid: false,
    };
  }
}

type FoundContact = {
  id: string;
  first_name?: string;
  last_name?: string;
  handles?: { type: string; value: string }[];
};

/** Normalize a phone number to E.164: strip formatting, map 00-prefix to +. */
export function normalizePhoneE164(raw: string): string | undefined {
  let s = String(raw ?? "").replace(/[\s\-()./]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : undefined;
}

function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw ?? "").trim());
}

function normalizeHandle(value: string): string {
  return value.replace(/[^a-z0-9@.]/gi, "").toLowerCase();
}

function handleMatches(handleValue: string, query: string): boolean {
  const a = normalizeHandle(handleValue);
  const b = normalizeHandle(query);
  if (!a || !b) return false;
  // Phones come in +49 / 0049 / local formats — compare loosely.
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/**
 * Find contacts by handle. Tries POST /contacts/search first; if Superchat
 * rejects the query (its search DSL is only partially documented), falls
 * back to scanning GET /contacts pages and matching handles client-side.
 */
async function findContacts(
  client: SuperchatClient,
  field: "phone" | "mail",
  value: string,
  onNote: (msg: string) => Promise<void>,
): Promise<FoundContact[]> {
  try {
    const res = (await client.searchContactsByHandle(field, value)) as {
      results?: FoundContact[];
    };
    if ((res.results ?? []).length > 0) return res.results!;
  } catch {
    await onNote("Search API rejected the query — scanning the contact list instead...");
  }

  // Fallback: page through contacts and match locally (max 20 pages = 2000).
  const matches: FoundContact[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = (await client.listContacts(after)) as {
      results?: FoundContact[];
      pagination?: { next_cursor?: string | null };
    };
    for (const c of res.results ?? []) {
      if ((c.handles ?? []).some((h) => handleMatches(h.value, value))) {
        matches.push(c);
      }
    }
    after = res.pagination?.next_cursor ?? undefined;
    if (!after || matches.length >= 10) break;
  }
  return matches;
}

async function promptContact(
  prompter: WizardPrompter,
  client: SuperchatClient,
  current: SuperchatSection,
  apiKeyValid: boolean,
): Promise<{ contactId: string; contactIdentifier: string }> {
  await prompter.note(
    [
      "This plugin is locked to exactly ONE Superchat contact.",
      "Messages from every other contact are ignored, and outbound",
      "messages can only go to this contact (on any of their channels).",
    ].join("\n"),
    "Single-contact lock",
  );

  const method = apiKeyValid
    ? await prompter.select({
        message: "How do you want to pick the allowed contact?",
        options: [
          { label: "Search by phone number", value: "phone" },
          { label: "Search by email", value: "mail" },
          { label: "Enter contact id (ct_...) manually", value: "manual" },
        ],
        initialValue: current.contactId ? "manual" : "phone",
      })
    : "manual";

  if (method === "phone" || method === "mail") {
    const rawValue = String(
      await prompter.text({
        message:
          method === "phone"
            ? "Contact phone number (E.164, e.g. +491701234567)"
            : "Contact email address",
        placeholder: method === "phone" ? "+491701234567" : "name@example.com",
        validate: (v: string) => {
          if (!String(v ?? "").trim()) return "Required";
          if (method === "phone" && !normalizePhoneE164(v)) {
            return "Not a valid E.164 number (start with +country code, e.g. +49...)";
          }
          if (method === "mail" && !isValidEmail(v)) {
            return "Not a valid email address";
          }
          return undefined;
        },
      }),
    ).trim();
    const value =
      method === "phone" ? normalizePhoneE164(rawValue)! : rawValue;
    try {
      const contacts = await findContacts(
        client,
        method as "phone" | "mail",
        value,
        (msg) => prompter.note(msg, "Contact search"),
      );
      if (contacts.length === 0) {
        const create = await prompter.confirm({
          message: `No contact found for ${value}. Create it in Superchat now?`,
          initialValue: true,
        });
        if (create) {
          const firstName = String(
            await prompter.text({
              message: "First name (optional)",
              placeholder: "Max",
              initialValue: "",
            }),
          ).trim();
          const lastName = String(
            await prompter.text({
              message: "Last name (optional)",
              placeholder: "Mustermann",
              initialValue: "",
            }),
          ).trim();
          const created = (await client.createContact({
            field: method as "phone" | "mail",
            value,
            firstName: firstName || undefined,
            lastName: lastName || undefined,
          })) as { id: string };
          await prompter.note(
            `Contact created: ${created.id} (${value})`,
            "Contact created",
          );
          return { contactId: created.id, contactIdentifier: value };
        }
        await prompter.note(
          "Falling back to manual entry.",
          "Contact search",
        );
      } else {
        const pickedId = await prompter.select({
          message: "Select the allowed contact",
          options: contacts.map((c) => ({
            label: `${[c.first_name, c.last_name].filter(Boolean).join(" ") || c.id} (${
              c.handles?.map((h) => h.value).join(", ") ?? "no handles"
            })`,
            value: c.id,
          })),
          initialValue: contacts[0]?.id,
        });
        const picked = contacts.find((c) => c.id === pickedId) ?? contacts[0];
        const handles = picked.handles ?? [];
        let identifier = value;
        if (handles.length > 1) {
          identifier = String(
            await prompter.select({
              message:
                "Which identifier should outbound messages use? (must match the outbound channel type)",
              options: handles.map((h) => ({
                label: `${h.value} [${h.type}]`,
                value: h.value,
              })),
              initialValue:
                handles.find((h) => h.value === value)?.value ?? handles[0]?.value,
            }),
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
          "contact's URL in the Superchat web app).",
        ].join("\n"),
        "Contact search",
      );
    }
  }

  const contactId = String(
    await prompter.text({
      message: "Allowed contact id (ct_...)",
      placeholder: "ct_XXXXXXXXXXXXXXXXXXXXX",
      initialValue: current.contactId ?? undefined,
      validate: required,
    }),
  ).trim();
  const contactIdentifier = String(
    await prompter.text({
      message: "Contact identifier for outbound sends (E.164 phone or email)",
      placeholder: "+491701234567",
      initialValue: current.contactIdentifier ?? undefined,
      validate: required,
    }),
  ).trim();
  return { contactId, contactIdentifier };
}

/**
 * Extract the WhatsApp Business Account id from messy pasted input.
 * Accepts: "WABA ID: 465726029962969, Business ID: 394530232597033",
 * "waba_1aBcD...", or bare digits. The Business ID is deliberately ignored.
 */
export function extractWabaId(raw: string): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  // Superchat-internal id form
  const prefixed = s.match(/waba_[A-Za-z0-9]+/);
  if (prefixed) return prefixed[0];
  // "WABA ID: <digits>" — labeled value wins over other numbers in the paste
  const labeled = s.match(/waba[\s_-]*id\s*[:=]?\s*(\d{6,})/i);
  if (labeled) return labeled[1];
  // Bare digits (only if unambiguous — exactly one long number in the input)
  const numbers = s.match(/\d{6,}/g) ?? [];
  if (numbers.length === 1) return numbers[0];
  return undefined;
}

async function promptOptionals(
  prompter: WizardPrompter,
  current: SuperchatSection,
): Promise<Pick<SuperchatSection, "senderName" | "whatsAppBusinessAccountId">> {
  const senderName = String(
    await prompter.text({
      message: "Sender display name (optional, shown as 'from' name)",
      placeholder: "OpenClaw",
      initialValue: current.senderName ?? undefined,
    }),
  ).trim();

  const wantsWaba = await prompter.confirm({
    message: "Configure a WhatsApp Business Account id for template creation?",
    initialValue: Boolean(current.whatsAppBusinessAccountId),
  });
  let whatsAppBusinessAccountId = current.whatsAppBusinessAccountId;
  if (wantsWaba) {
    const raw = String(
      await prompter.text({
        message:
          "WhatsApp Business Account id (paste is fine — e.g. \"WABA ID: 465726..., Business ID: 394530...\")",
        placeholder: "WABA ID: 4657... or waba_XXXX or bare digits",
        initialValue: current.whatsAppBusinessAccountId ?? undefined,
        validate: (value: string) =>
          extractWabaId(value) ? undefined : "No WABA id found in the input",
      }),
    );
    whatsAppBusinessAccountId = extractWabaId(raw)!;
  }

  return {
    ...(senderName ? { senderName } : {}),
    ...(whatsAppBusinessAccountId ? { whatsAppBusinessAccountId } : {}),
  };
}

async function promptWebhookToken(
  prompter: WizardPrompter,
  current: SuperchatSection,
): Promise<string | undefined> {
  if (current.webhookToken) {
    const keep = await prompter.confirm({
      message: "Keep the existing webhook token?",
      initialValue: true,
    });
    if (keep) return current.webhookToken;
  }
  const generate = await prompter.confirm({
    message: "Generate a random webhook token? (protects /superchat/webhook)",
    initialValue: true,
  });
  if (generate) return randomBytes(32).toString("hex");
  const manual = String(
    await prompter.text({
      message: "Webhook token (leave empty to disable the token check)",
      placeholder: "long-random-string",
      initialValue: "",
    }),
  ).trim();
  return manual || undefined;
}

async function noteCompletion(
  prompter: WizardPrompter,
  webhookToken: string | undefined,
): Promise<void> {
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
      `     -d '{"target_url":"https://<your-host>/superchat/webhook${tokenSuffix}",` +
        `"events":[{"type":"message_inbound"}]}'`,
      "",
      "Then send a test message from the allowed contact.",
    ].join("\n"),
    "Superchat setup complete",
  );
}

export const superchatSetupWizard: ChannelSetupWizard = {
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
        ...(configured
          ? [
              `Locked to contact ${s.contactId} (${s.contactIdentifier})`,
              `Default outbound channel ${s.channelId}`,
            ]
          : []),
      ];
    },
    resolveSelectionHint: ({ configured }) =>
      configured ? "configured" : "Superchat inbox (single contact)",
  },
  finalize: async ({ cfg, accountId: _accountId, prompter }) => {
    const current = getSection(cfg);

    const apiKey = await promptApiKey(prompter, current);
    const client = new SuperchatClient(apiKey);

    const { channelId, apiKeyValid } = await promptChannelId(
      prompter,
      client,
      current,
    );
    const { contactId, contactIdentifier } = await promptContact(
      prompter,
      client,
      current,
      apiKeyValid,
    );
    const optionals = await promptOptionals(prompter, current);
    const webhookToken = await promptWebhookToken(prompter, current);

    const nextCfg = applySection(cfg, {
      apiKey,
      channelId,
      contactId,
      contactIdentifier,
      ...optionals,
      ...(webhookToken ? { webhookToken } : {}),
    });

    await noteCompletion(prompter, webhookToken);
    return { cfg: nextCfg };
  },
};
