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
    const value = String(
      await prompter.text({
        message:
          method === "phone"
            ? "Contact phone number (E.164, e.g. +491701234567)"
            : "Contact email address",
        placeholder: method === "phone" ? "+491701234567" : "name@example.com",
        validate: required,
      }),
    ).trim();
    try {
      const res = (await client.searchContactsByHandle(
        method as "phone" | "mail",
        value,
      )) as {
        results?: {
          id: string;
          first_name?: string;
          last_name?: string;
          handles?: { type: string; value: string }[];
        }[];
      };
      const contacts = res.results ?? [];
      if (contacts.length === 0) {
        await prompter.note(
          `No contact found for ${value}. Falling back to manual entry.`,
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
    whatsAppBusinessAccountId = String(
      await prompter.text({
        message: "WhatsApp Business Account id",
        placeholder: "waba_XXXX",
        initialValue: current.whatsAppBusinessAccountId ?? undefined,
        validate: required,
      }),
    ).trim();
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
