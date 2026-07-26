import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import {
  superchatPlugin,
  resolveAccount,
  isAllowedSender,
  clientFor,
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

  registerFull(api: any) {
    // Agent tools: template management, file uploads, custom attributes,
    // contact attribute values, generic sends, channel discovery.
    try {
      for (const tool of buildSuperchatTools(() => resolveAccount(api.config))) {
        api.registerTool(tool);
      }
    } catch (err) {
      console.warn(`superchat: tool registration unavailable: ${String(err)}`);
    }

    api.registerHttpRoute({
      path: "/superchat/webhook",
      auth: "plugin",
      handler: async (req: any, res: any) => {
        try {
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

          // Single-contact lock: drop anything not from the configured
          // contact. Messages from that contact are accepted on ALL
          // Superchat channels (WhatsApp, SMS, email, ...).
          if (!isAllowedSender(account, msg.from?.id, msg.from?.identifier)) {
            res.statusCode = 200;
            res.end("ignored (contact not allowed)");
            return true;
          }

          // Ack Superchat immediately; agent processing continues async.
          res.statusCode = 200;
          res.end("ok");

          const rt = api.runtime;
          const cfg = api.config;
          const text = describeInbound(msg);
          const senderId = msg.from?.id ?? account.contactId;
          const senderName = msg.from?.identifier ?? senderId;
          // Reply on the channel the message arrived on.
          const replyChannelId = msg.to?.channel_id ?? account.channelId;
          const timestamp = Date.parse(msg.created_at) || Date.now();

          const route = rt.channel.routing.resolveAgentRoute({
            cfg,
            channel: "superchat",
            accountId: "default",
            peer: { kind: "direct", id: account.contactId },
          });
          const storePath = rt.channel.session.resolveStorePath(
            cfg.session?.store,
            { agentId: route.agentId },
          );
          const envelopeOptions =
            rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
          const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey: route.sessionKey,
          });

          const body = rt.channel.reply.formatInboundEnvelope({
            channel: "Superchat",
            from: `${senderName} (${senderId})`,
            timestamp,
            body: text,
            chatType: "direct",
            sender: { name: senderName, id: senderId },
            previousTimestamp,
            envelope: envelopeOptions,
          });

          const ctx = rt.channel.reply.finalizeInboundContext({
            Body: body,
            RawBody: text,
            CommandBody: text,
            From: account.contactId,
            To: account.contactId,
            SessionKey: route.sessionKey,
            AccountId: "default",
            ChatType: "direct",
            ConversationLabel: `Superchat ${senderName}`,
            SenderName: senderName,
            SenderId: senderId,
            Provider: "superchat",
            Surface: "superchat",
            MessageSid: msg.id,
            Timestamp: timestamp,
            CommandAuthorized: true,
            OriginatingChannel: "superchat",
            OriginatingTo: account.contactId,
          });

          await rt.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctx.SessionKey || route.sessionKey,
            ctx,
            onRecordError: (err: unknown) => {
              console.error(
                `superchat: failed to record inbound session: ${String(err)}`,
              );
            },
          });

          const client = clientFor(account);
          await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx,
            cfg,
            dispatcherOptions: {
              responsePrefix: "",
              deliver: async (payload: { text?: string }) => {
                if (!payload?.text) return;
                await client.sendText({
                  channelId: replyChannelId,
                  identifier: account.contactIdentifier,
                  text: payload.text,
                  senderName: account.senderName,
                });
              },
            },
          });

          return true;
        } catch (err) {
          console.error(`superchat webhook error: ${String(err)}`);
          if (!res.headersSent && !res.writableEnded) {
            res.statusCode = 500;
            res.end(`superchat: ${String(err).slice(0, 300)}`);
          }
          return true;
        }
      },
    });
  },
});
