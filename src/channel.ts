import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { SuperchatClient } from "./client.js";
import { superchatSetupWizard } from "./onboarding.js";

export type ResolvedSuperchatAccount = {
  accountId: string | null;
  apiKey: string;
  /** Default Superchat channel (mc_...) for outbound sends. */
  channelId: string;
  /** The only contact (ct_...) this plugin may talk to. */
  contactId: string;
  /** Outbound identifier for that contact: E.164 phone or email. */
  contactIdentifier: string;
  /** Optional WABA id used when creating WhatsApp templates. */
  whatsAppBusinessAccountId?: string;
  senderName?: string;
  webhookToken?: string;
  dmPolicy: string | undefined;
};

function section(cfg: OpenClawConfig): Record<string, any> | undefined {
  return (cfg.channels as Record<string, any> | undefined)?.["superchat"];
}

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedSuperchatAccount {
  const s = section(cfg);
  if (!s?.apiKey) throw new Error("superchat: apiKey required");
  if (!s?.channelId) throw new Error("superchat: channelId (mc_...) required");
  if (!s?.contactId || !s?.contactIdentifier) {
    throw new Error(
      "superchat: contactId (ct_...) and contactIdentifier are required — this channel is locked to a single contact",
    );
  }
  return {
    accountId: accountId ?? null,
    apiKey: s.apiKey,
    channelId: s.channelId,
    contactId: s.contactId,
    contactIdentifier: s.contactIdentifier,
    whatsAppBusinessAccountId: s.whatsAppBusinessAccountId,
    senderName: s.senderName,
    webhookToken: s.webhookToken,
    dmPolicy: s.dmSecurity,
  };
}

/** True only for the single configured contact (id or identifier match). */
export function isAllowedSender(
  account: ResolvedSuperchatAccount,
  senderId?: string | null,
  senderIdentifier?: string | null,
): boolean {
  if (senderId && senderId === account.contactId) return true;
  if (senderIdentifier && senderIdentifier === account.contactIdentifier) {
    return true;
  }
  return false;
}

/** Throws unless the target is the configured contact (or empty = default). */
export function assertAllowedTarget(
  account: ResolvedSuperchatAccount,
  to?: string | null,
): void {
  if (!to) return;
  if (to === account.contactId || to === account.contactIdentifier) return;
  throw new Error(
    `superchat: refusing to send to "${to}" — channel is locked to contact ${account.contactId}`,
  );
}

export function clientFor(account: ResolvedSuperchatAccount): SuperchatClient {
  return new SuperchatClient(account.apiKey);
}

export const superchatPlugin = createChatChannelPlugin<ResolvedSuperchatAccount>({
  base: createChannelPluginBase({
    id: "superchat",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount,
      inspectAccount(cfg) {
        const s = section(cfg);
        const configured = Boolean(
          s?.apiKey && s?.channelId && s?.contactId && s?.contactIdentifier,
        );
        return {
          enabled: configured,
          configured,
          tokenStatus: s?.apiKey ? "available" : "missing",
        };
      },
    },
    setup: {
      applyAccountConfig: ({ cfg, input }) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          superchat: {
            ...(cfg.channels as any)?.["superchat"],
            ...input,
          },
        },
      }),
    },
  }),

  // DM security: allowlist containing exactly the one configured contact.
  security: {
    dm: {
      channelKey: "superchat",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => [
        account.contactId,
        account.contactIdentifier,
      ],
      defaultPolicy: "allowlist",
    },
  },

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    attachedResults: {
      channel: "superchat",
      sendText: async (params: {
        to: string;
        text: string;
        account: ResolvedSuperchatAccount;
        replyToId?: string | null;
      }) => {
        const { account } = params;
        assertAllowedTarget(account, params.to);
        const result = await clientFor(account).sendText({
          channelId: account.channelId,
          identifier: account.contactIdentifier,
          text: params.text,
          senderName: account.senderName,
          inReplyTo: params.replyToId ?? null,
        });
        return { messageId: result.id };
      },
    },
    base: {
      sendMedia: async (params: {
        to: string;
        filePath: string;
        account: ResolvedSuperchatAccount;
      }) => {
        const { account } = params;
        assertAllowedTarget(account, params.to);
        const client = clientFor(account);
        const file = await client.uploadFile(params.filePath);
        const result = await client.sendMessage({
          channelId: account.channelId,
          identifier: account.contactIdentifier,
          content: { type: "media", file_id: file.id },
          senderName: account.senderName,
        });
        return { messageId: result.id };
      },
    },
  },
});

// Interactive setup screen for `openclaw channels add --channel superchat`.
(superchatPlugin as any).setupWizard = superchatSetupWizard;
