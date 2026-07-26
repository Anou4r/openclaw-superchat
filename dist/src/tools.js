import { clientFor } from "./channel.js";
function buildSuperchatTools(getAccount) {
  const client = () => clientFor(getAccount());
  return [
    // -- Messaging ----------------------------------------------------------
    {
      name: "superchat_send_message",
      description: 'Send a message to the allowed Superchat contact. Supports every content type: {"type":"text","body":...}, {"type":"media","file_id":"fi_..."}, {"type":"whats_app_template","template_id":"tn_...","variables":[{"position":1,"value":"..."}],"file":{"id":"fi_..."}}, {"type":"whats_app_quick_reply","body":...,"replies":[{"value":...}]}, {"type":"whats_app_list","body":...,"title":...,"sections":[...]}, {"type":"generic_template","template_id":"tn_..."}, {"type":"email","subject":...,"text":...}. channel_id is optional and defaults to the configured channel; use superchat_list_channels to find others (e.g. WhatsApp vs email).',
      parameters: {
        type: "object",
        required: ["content"],
        additionalProperties: false,
        properties: {
          content: {
            type: "object",
            description: "Superchat message content object (see description)"
          },
          channel_id: {
            type: "string",
            description: "Superchat channel to send from (mc_...). Defaults to the configured channelId."
          },
          in_reply_to: {
            type: "string",
            description: "Optional message id (msg_...) to reply to."
          }
        }
      },
      execute: async (input) => {
        const account = getAccount();
        return client().sendMessage({
          channelId: input.channel_id ?? account.channelId,
          identifier: account.contactIdentifier,
          content: input.content,
          senderName: account.senderName,
          inReplyTo: input.in_reply_to ?? null
        });
      }
    },
    // -- Templates ----------------------------------------------------------
    {
      name: "superchat_create_template",
      description: 'Create a Superchat message template. For WhatsApp use content.type "whats_app_template" with language, category (e.g. marketing, utility, authentication), body with {{1}}-style placeholders, optional header (text or media via file_id from superchat_upload_file), footer, buttons, and variables mapping positions to contact attribute identifiers (create attributes first via superchat_create_custom_attribute). New WhatsApp templates start in status "pending" until Meta approves \u2014 check with superchat_get_template before sending.',
      parameters: {
        type: "object",
        required: ["name", "content"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          content: {
            type: "object",
            description: "Template definition (whats_app_template or generic_template)"
          },
          folder_id: { type: "string" },
          whats_app_business_account_id: {
            type: "string",
            description: "Optional WABA id; defaults to the configured whatsAppBusinessAccountId if set."
          }
        }
      },
      execute: async (input) => {
        const account = getAccount();
        return client().createTemplate({
          ...input,
          whats_app_business_account_id: input.whats_app_business_account_id ?? account.whatsAppBusinessAccountId ?? null
        });
      }
    },
    {
      name: "superchat_list_templates",
      description: "List all Superchat templates with their ids (tn_...) and approval status.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => client().listTemplates()
    },
    {
      name: "superchat_get_template",
      description: "Get one template by id (tn_...), including WhatsApp approval status (pending / approved / rejected).",
      parameters: {
        type: "object",
        required: ["template_id"],
        additionalProperties: false,
        properties: { template_id: { type: "string" } }
      },
      execute: async (input) => client().getTemplate(input.template_id)
    },
    {
      name: "superchat_delete_template",
      description: "Delete a template by id (tn_...).",
      parameters: {
        type: "object",
        required: ["template_id"],
        additionalProperties: false,
        properties: { template_id: { type: "string" } }
      },
      execute: async (input) => {
        await client().deleteTemplate(input.template_id);
        return { deleted: input.template_id };
      }
    },
    // -- Files --------------------------------------------------------------
    {
      name: "superchat_upload_file",
      description: "Upload a local file to Superchat (returns fi_... id) for media messages or WhatsApp template media headers. Supports images, video, audio and documents.",
      parameters: {
        type: "object",
        required: ["file_path"],
        additionalProperties: false,
        properties: {
          file_path: { type: "string", description: "Local path of the file" },
          file_name: { type: "string", description: "Optional filename override" }
        }
      },
      execute: async (input) => client().uploadFile(input.file_path, input.file_name)
    },
    {
      name: "superchat_list_files",
      description: "List files uploaded to Superchat.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => client().listFiles()
    },
    {
      name: "superchat_get_file",
      description: "Get one uploaded file by id (fi_...), including a signed URL.",
      parameters: {
        type: "object",
        required: ["file_id"],
        additionalProperties: false,
        properties: { file_id: { type: "string" } }
      },
      execute: async (input) => client().getFile(input.file_id)
    },
    // -- Custom attributes ----------------------------------------------------
    {
      name: "superchat_create_custom_attribute",
      description: "Create a contact custom attribute (returns cat_... id) usable as a template variable. Types: text, number, datetime, dateonly, single_select, multi_select (selects need option_values).",
      parameters: {
        type: "object",
        required: ["name", "attribute_type"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          attribute_type: {
            type: "string",
            enum: [
              "text",
              "number",
              "datetime",
              "dateonly",
              "single_select",
              "multi_select"
            ]
          },
          option_values: {
            type: "array",
            items: { type: "string" },
            description: "Required for single_select / multi_select"
          }
        }
      },
      execute: async (input) => client().createCustomAttribute({
        name: input.name,
        type: input.attribute_type,
        option_values: input.option_values
      })
    },
    {
      name: "superchat_list_custom_attributes",
      description: "List all contact custom attributes with their ids (cat_...) and types.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => client().listCustomAttributes()
    },
    // -- The one allowed contact ---------------------------------------------
    {
      name: "superchat_get_contact",
      description: "Get the allowed contact including current custom attribute values (used to resolve template variables).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => client().getContact(getAccount().contactId)
    },
    {
      name: "superchat_set_contact_attributes",
      description: 'Set custom attribute values on the allowed contact so template variables resolve. attributes: [{"id":"cat_...","value":...}].',
      parameters: {
        type: "object",
        required: ["attributes"],
        additionalProperties: false,
        properties: {
          attributes: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "value"],
              properties: {
                id: { type: "string" },
                value: {}
              }
            }
          }
        }
      },
      execute: async (input) => client().setContactAttributes(getAccount().contactId, input.attributes)
    },
    // -- Channels -------------------------------------------------------------
    {
      name: "superchat_list_channels",
      description: "List Superchat channels (mc_... ids) \u2014 e.g. to find the WhatsApp channel id for template sends vs. the email channel.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => client().listChannels()
    }
  ];
}
export {
  buildSuperchatTools
};
