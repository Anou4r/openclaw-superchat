/**
 * Superchat Public API client.
 *
 * Scope: everything needed to send any message type — including WhatsApp
 * templates and what that implies: template management, file uploads (media
 * headers / media messages), custom attributes (template variables), and
 * reading/updating the single allowed contact so variable values resolve.
 *
 * Docs: https://developers.superchat.com/reference/welcome
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE_URL = "https://api.superchat.com/v1.0";

// ---------------------------------------------------------------------------
// Message content types (POST /messages)
// ---------------------------------------------------------------------------

export type TextContent = { type: "text"; body: string };
export type MediaContent = { type: "media"; file_id: string };
export type EmailContent = {
  type: "email";
  subject: string;
  text?: string;
  html?: string;
  files?: { id: string }[];
};
export type GenericTemplateContent = {
  type: "generic_template";
  template_id: string;
  variables?: { position: number; value: string }[];
};
export type WhatsAppTemplateContent = {
  type: "whats_app_template";
  template_id: string;
  variables?: { position: number; value: string }[];
  file?: { id: string };
};
export type WhatsAppQuickReplyContent = {
  type: "whats_app_quick_reply";
  body: string;
  footer?: string;
  header?: Record<string, unknown>;
  replies: { value: string }[];
};
export type WhatsAppListContent = {
  type: "whats_app_list";
  body: string;
  title: string;
  footer?: string;
  header?: { value: string };
  sections: {
    title: string;
    rows: { title: string; description?: string }[];
  }[];
};

export type MessageContent =
  | TextContent
  | MediaContent
  | EmailContent
  | GenericTemplateContent
  | WhatsAppTemplateContent
  | WhatsAppQuickReplyContent
  | WhatsAppListContent;

export type SuperchatMessage = {
  id: string;
  status: string;
  conversation_id: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Template types (POST /templates)
// ---------------------------------------------------------------------------

export type WhatsAppTemplateDefinition = {
  type: "whats_app_template";
  language: string;
  category: string;
  body: string;
  header?: {
    type: "text" | "image" | "video" | "document";
    value?: string;
    file_id?: string;
    is_persistent?: boolean;
  };
  footer?: string;
  buttons?: {
    type: "quick_reply" | "phone_number" | "url" | "dynamic_url";
    text: string;
    phone_number?: string;
    target?: string;
    example_url_suffix?: string;
  }[];
  variables?: { position: number; attribute_identifier: string }[];
  track_links?: boolean;
};

export type GenericTemplateDefinition = {
  type: "generic_template";
  subject?: string;
  body: string;
  file_ids?: { id: string }[];
  variables?: { position: number; attribute_identifier: string }[];
};

export type CreateTemplateInput = {
  name: string;
  folder_id?: string | null;
  whats_app_business_account_id?: string | null;
  content: WhatsAppTemplateDefinition | GenericTemplateDefinition;
};

export class SuperchatClient {
  constructor(private readonly apiKey: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "X-API-KEY": this.apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `superchat: ${method} ${path} failed with ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // -- Messages -------------------------------------------------------------

  /** Send any supported content type to a single recipient. */
  async sendMessage(params: {
    channelId: string;
    identifier: string;
    content: MessageContent;
    senderName?: string;
    inReplyTo?: string | null;
  }): Promise<SuperchatMessage> {
    return this.request("POST", "/messages", {
      to: [{ identifier: params.identifier }],
      from: {
        channel_id: params.channelId,
        ...(params.senderName ? { name: params.senderName } : {}),
      },
      content: params.content,
      in_reply_to: params.inReplyTo ?? null,
    });
  }

  sendText(params: {
    channelId: string;
    identifier: string;
    text: string;
    senderName?: string;
    inReplyTo?: string | null;
  }): Promise<SuperchatMessage> {
    return this.sendMessage({
      ...params,
      content: { type: "text", body: params.text },
    });
  }

  // -- Templates ------------------------------------------------------------

  createTemplate(input: CreateTemplateInput): Promise<any> {
    return this.request("POST", "/templates", input);
  }

  listTemplates(): Promise<any> {
    return this.request("GET", "/templates");
  }

  /** Includes `status` — WhatsApp templates start "pending" until Meta approves. */
  getTemplate(id: string): Promise<any> {
    return this.request("GET", `/templates/${encodeURIComponent(id)}`);
  }

  updateTemplate(id: string, input: Partial<CreateTemplateInput>): Promise<any> {
    return this.request("PATCH", `/templates/${encodeURIComponent(id)}`, input);
  }

  deleteTemplate(id: string): Promise<void> {
    return this.request("DELETE", `/templates/${encodeURIComponent(id)}`);
  }

  // -- Files ----------------------------------------------------------------

  /** Upload a local file (multipart/form-data). Returns fi_... id. */
  async uploadFile(filePath: string, fileName?: string): Promise<any> {
    const data = await readFile(filePath);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(data)]),
      fileName ?? basename(filePath),
    );
    const res = await fetch(`${BASE_URL}/files`, {
      method: "POST",
      headers: { "X-API-KEY": this.apiKey },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `superchat: POST /files failed with ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    return res.json();
  }

  listFiles(): Promise<any> {
    return this.request("GET", "/files");
  }

  getFile(id: string): Promise<any> {
    return this.request("GET", `/files/${encodeURIComponent(id)}`);
  }

  deleteFile(id: string): Promise<void> {
    return this.request("DELETE", `/files/${encodeURIComponent(id)}`);
  }

  // -- Custom attributes (template variables) -------------------------------

  createCustomAttribute(input: {
    name: string;
    type:
      | "text"
      | "number"
      | "datetime"
      | "dateonly"
      | "single_select"
      | "multi_select";
    option_values?: string[];
  }): Promise<any> {
    return this.request("POST", "/custom-attributes", {
      resource: "contact",
      ...input,
    });
  }

  listCustomAttributes(): Promise<any> {
    return this.request("GET", "/custom-attributes");
  }

  updateCustomAttribute(id: string, input: Record<string, unknown>): Promise<any> {
    return this.request("PUT", `/custom-attributes/${encodeURIComponent(id)}`, input);
  }

  deleteCustomAttribute(id: string): Promise<void> {
    return this.request("DELETE", `/custom-attributes/${encodeURIComponent(id)}`);
  }

  // -- Contact (values for template variables) ------------------------------

  getContact(contactId: string): Promise<any> {
    return this.request("GET", `/contacts/${encodeURIComponent(contactId)}`);
  }

  /** Set custom attribute values on a contact: [{ id: "cat_...", value }] */
  setContactAttributes(
    contactId: string,
    attributes: { id: string; value: unknown }[],
  ): Promise<any> {
    return this.request("PATCH", `/contacts/${encodeURIComponent(contactId)}`, {
      custom_attributes: attributes,
    });
  }

  // -- Channels (discover WhatsApp / other channel ids) ----------------------

  listChannels(): Promise<any> {
    return this.request("GET", "/channels");
  }
}
