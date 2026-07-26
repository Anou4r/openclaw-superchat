import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import {
  superchatPlugin,
  resolveAccount,
  isAllowedSender,
} from "./src/channel.js";
import { buildSuperchatTools } from "./src/tools.js";

/**
 * Superchat webhook delivery for message_inbound events.
 * Docs: https://developers.superchat.com/reference/webhook-payload-model
 */
type SuperchatWebhookEvent = {
  event: string;
  id: string;
  message?: {
    id: string;
    conversation_id: string;
    created_at: string;
    direction: "inbound" | "outbound";
    in_reply_to?: string | null;
    content?: { type: string; body?: string; file_id?: string };
    from?: { id?: string; identifier?: string };
    to?: { channel_id?: string };
  };
};

async function readBody(req: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function describeInbound(msg: NonNullable<SuperchatWebhookEvent["message"]>): string {
  const c = msg.content;
  if (!c) return "[empty message]";
  if (c.type === "text" && c.body) return c.body;
  if (c.type === "media") {
    return `[media message, file_id: ${c.file_id ?? "unknown"} — fetch via superchat_get_file]`;
  }
  return `[${c.type} message]${c.body ? ` ${c.body}` : ""}`;
}

export default defineChannelPluginEntry({
  id: "superchat",
  name: "Superchat",
  description:
    "Superchat channel plugin: all message types incl. WhatsApp templates, locked to a single contact",
  plugin: superchatPlugin,

  registerFull(api) {
    // Agent tools: template management, file uploads, custom attributes,
    // contact attribute values, generic sends, channel discovery.
    for (const tool of buildSuperchatTools(() => resolveAccount(api.config))) {
      api.registerTool(tool);
    }

    api.registerHttpRoute({
      path: "/superchat/webhook",
      auth: "plugin",
      handler: async (req: any, res: any) => {
        const account = resolveAccount(api.config);

        // Optional shared-secret check: Superchat signs deliveries with a
        // subscription secret but does not document the scheme, so we gate
        // on a token embedded in the target URL instead.
        if (account.webhookToken) {
          const url = new URL(req.url ?? "", "http://localhost");
          if (url.searchParams.get("token") !== account.webhookToken) {
            res.statusCode = 401;
            res.end("unauthorized");
            return true;
          }
        }

        let event: SuperchatWebhookEvent;
        try {
          event = JSON.parse(await readBody(req));
        } catch {
          res.statusCode = 400;
          res.end("bad payload");
          return true;
        }

        // Only inbound messages are of interest; ack everything else so
        // Superchat does not retry.
        const msg = event.message;
        if (
          event.event !== "message_inbound" ||
          !msg ||
          msg.direction !== "inbound"
        ) {
          res.statusCode = 200;
          res.end("ignored");
          return true;
        }

        // Single-contact lock: drop anything not from the configured contact.
        // Messages from that contact are accepted on ALL Superchat channels
        // (WhatsApp, SMS, email, ...), not just the default outbound channel.
        if (!isAllowedSender(account, msg.from?.id, msg.from?.identifier)) {
          res.statusCode = 200;
          res.end("ignored (contact not allowed)");
          return true;
        }

        await api.runtime.channel.inbound.dispatch({
          channel: "superchat",
          accountId: "default",
          envelope: {
            raw: event,
            conversationId: msg.conversation_id,
            senderId: msg.from?.id ?? account.contactId,
            timestamp: Date.parse(msg.created_at) || Date.now(),
            text: describeInbound(msg),
            messageId: msg.id,
            replyToId: msg.in_reply_to ?? undefined,
            // Which Superchat channel the message arrived on — the agent can
            // pass this as channel_id to superchat_send_message to reply on
            // the same channel.
            meta: { superchatChannelId: msg.to?.channel_id },
          },
        });

        res.statusCode = 200;
        res.end("ok");
        return true;
      },
    });
  },
});
