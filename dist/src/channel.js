import {
  createChatChannelPlugin,
  createChannelPluginBase
} from "openclaw/plugin-sdk/channel-core";
import { SuperchatClient } from "./client.js";
function section(cfg) {
  return cfg.channels?.["superchat"];
}
function resolveAccount(cfg, accountId) {
  const s = section(cfg);
  if (!s?.apiKey) throw new Error("superchat: apiKey required");
  if (!s?.channelId) throw new Error("superchat: channelId (mc_...) required");
  if (!s?.contactId || !s?.contactIdentifier) {
    throw new Error(
      "superchat: contactId (ct_...) and contactIdentifier are required \u2014 this channel is locked to a single contact"
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
    dmPolicy: s.dmSecurity
  };
}
function isAllowedSender(account, senderId, senderIdentifier) {
  if (senderId && senderId === account.contactId) return true;
  if (senderIdentifier && senderIdentifier === account.contactIdentifier) {
    return true;
  }
  return false;
}
function assertAllowedTarget(account, to) {
  if (!to) return;
  if (to === account.contactId || to === account.contactIdentifier) return;
  throw new Error(
    `superchat: refusing to send to "${to}" \u2014 channel is locked to contact ${account.contactId}`
  );
}
function clientFor(account) {
  return new SuperchatClient(account.apiKey);
}
const superchatPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "superchat",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount,
      inspectAccount(cfg) {
        const s = section(cfg);
        const configured = Boolean(
          s?.apiKey && s?.channelId && s?.contactId && s?.contactIdentifier
        );
        return {
          enabled: configured,
          configured,
          tokenStatus: s?.apiKey ? "available" : "missing"
        };
      }
    },
    setup: {
      applyAccountConfig: ({ cfg, input }) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          superchat: {
            ...cfg.channels?.["superchat"],
            ...input
          }
        }
      })
    }
  }),
  // DM security: allowlist containing exactly the one configured contact.
  security: {
    dm: {
      channelKey: "superchat",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => [
        account.contactId,
        account.contactIdentifier
      ],
      defaultPolicy: "allowlist"
    }
  },
  threading: { topLevelReplyToMode: "reply" },
  outbound: {
    attachedResults: {
      channel: "superchat",
      sendText: async (params) => {
        const { account } = params;
        assertAllowedTarget(account, params.to);
        const result = await clientFor(account).sendText({
          channelId: account.channelId,
          identifier: account.contactIdentifier,
          text: params.text,
          senderName: account.senderName,
          inReplyTo: params.replyToId ?? null
        });
        return { messageId: result.id };
      }
    },
    base: {
      sendMedia: async (params) => {
        const { account } = params;
        assertAllowedTarget(account, params.to);
        const client = clientFor(account);
        const file = await client.uploadFile(params.filePath);
        const result = await client.sendMessage({
          channelId: account.channelId,
          identifier: account.contactIdentifier,
          content: { type: "media", file_id: file.id },
          senderName: account.senderName
        });
        return { messageId: result.id };
      }
    }
  }
});
export {
  assertAllowedTarget,
  clientFor,
  isAllowedSender,
  resolveAccount,
  superchatPlugin
};
