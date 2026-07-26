import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import {
  superchatPlugin,
  resolveAccount,
  isAllowedSender
} from "./src/channel.js";
import { buildSuperchatTools } from "./src/tools.js";
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function describeInbound(msg) {
  const c = msg.content;
  if (!c) return "[empty message]";
  if (c.type === "text" && c.body) return c.body;
  if (c.type === "media") {
    return `[media message, file_id: ${c.file_id ?? "unknown"} \u2014 fetch via superchat_get_file]`;
  }
  return `[${c.type} message]${c.body ? ` ${c.body}` : ""}`;
}
var index_default = defineChannelPluginEntry({
  id: "superchat",
  name: "Superchat",
  description: "Superchat channel plugin: all message types incl. WhatsApp templates, locked to a single contact",
  plugin: superchatPlugin,
  registerFull(api) {
    for (const tool of buildSuperchatTools(() => resolveAccount(api.config))) {
      api.registerTool(tool);
    }
    api.registerHttpRoute({
      path: "/superchat/webhook",
      auth: "plugin",
      handler: async (req, res) => {
        const account = resolveAccount(api.config);
        if (account.webhookToken) {
          const url = new URL(req.url ?? "", "http://localhost");
          if (url.searchParams.get("token") !== account.webhookToken) {
            res.statusCode = 401;
            res.end("unauthorized");
            return true;
          }
        }
        let event;
        try {
          event = JSON.parse(await readBody(req));
        } catch {
          res.statusCode = 400;
          res.end("bad payload");
          return true;
        }
        const msg = event.message;
        if (event.event !== "message_inbound" || !msg || msg.direction !== "inbound") {
          res.statusCode = 200;
          res.end("ignored");
          return true;
        }
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
            replyToId: msg.in_reply_to ?? void 0,
            // Which Superchat channel the message arrived on — the agent can
            // pass this as channel_id to superchat_send_message to reply on
            // the same channel.
            meta: { superchatChannelId: msg.to?.channel_id }
          }
        });
        res.statusCode = 200;
        res.end("ok");
        return true;
      }
    });
  }
});
export {
  index_default as default
};
