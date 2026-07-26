import { readFile } from "node:fs/promises";
import { basename } from "node:path";
const BASE_URL = "https://api.superchat.com/v1.0";
class SuperchatClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }
  apiKey;
  async request(method, path, body) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "X-API-KEY": this.apiKey,
        ...body !== void 0 ? { "Content-Type": "application/json" } : {}
      },
      body: body !== void 0 ? JSON.stringify(body) : void 0
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `superchat: ${method} ${path} failed with ${res.status}: ${text.slice(0, 500)}`
      );
    }
    if (res.status === 204) return void 0;
    return await res.json();
  }
  // -- Messages -------------------------------------------------------------
  /** Send any supported content type to a single recipient. */
  async sendMessage(params) {
    return this.request("POST", "/messages", {
      to: [{ identifier: params.identifier }],
      from: {
        channel_id: params.channelId,
        ...params.senderName ? { name: params.senderName } : {}
      },
      content: params.content,
      in_reply_to: params.inReplyTo ?? null
    });
  }
  sendText(params) {
    return this.sendMessage({
      ...params,
      content: { type: "text", body: params.text }
    });
  }
  // -- Templates ------------------------------------------------------------
  createTemplate(input) {
    return this.request("POST", "/templates", input);
  }
  listTemplates() {
    return this.request("GET", "/templates");
  }
  /** Includes `status` — WhatsApp templates start "pending" until Meta approves. */
  getTemplate(id) {
    return this.request("GET", `/templates/${encodeURIComponent(id)}`);
  }
  updateTemplate(id, input) {
    return this.request("PATCH", `/templates/${encodeURIComponent(id)}`, input);
  }
  deleteTemplate(id) {
    return this.request("DELETE", `/templates/${encodeURIComponent(id)}`);
  }
  // -- Files ----------------------------------------------------------------
  /** Upload a local file (multipart/form-data). Returns fi_... id. */
  async uploadFile(filePath, fileName) {
    const data = await readFile(filePath);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(data)]),
      fileName ?? basename(filePath)
    );
    const res = await fetch(`${BASE_URL}/files`, {
      method: "POST",
      headers: { "X-API-KEY": this.apiKey },
      body: form
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `superchat: POST /files failed with ${res.status}: ${text.slice(0, 500)}`
      );
    }
    return res.json();
  }
  listFiles() {
    return this.request("GET", "/files");
  }
  getFile(id) {
    return this.request("GET", `/files/${encodeURIComponent(id)}`);
  }
  deleteFile(id) {
    return this.request("DELETE", `/files/${encodeURIComponent(id)}`);
  }
  // -- Custom attributes (template variables) -------------------------------
  createCustomAttribute(input) {
    return this.request("POST", "/custom-attributes", {
      resource: "contact",
      ...input
    });
  }
  listCustomAttributes() {
    return this.request("GET", "/custom-attributes");
  }
  updateCustomAttribute(id, input) {
    return this.request("PUT", `/custom-attributes/${encodeURIComponent(id)}`, input);
  }
  deleteCustomAttribute(id) {
    return this.request("DELETE", `/custom-attributes/${encodeURIComponent(id)}`);
  }
  // -- Contact (values for template variables) ------------------------------
  getContact(contactId) {
    return this.request("GET", `/contacts/${encodeURIComponent(contactId)}`);
  }
  /** Search contacts by a phone or email handle (used by the setup wizard). */
  searchContactsByHandle(field, value) {
    return this.request("POST", "/contacts/search?limit=50", {
      query: {
        value: [{ field, operator: "=", value }]
      }
    });
  }
  /** Create a contact with a single phone/mail handle. */
  createContact(params) {
    return this.request("POST", "/contacts", {
      ...params.firstName ? { first_name: params.firstName } : {},
      ...params.lastName ? { last_name: params.lastName } : {},
      handles: [{ id: null, type: params.field, value: params.value }]
    });
  }
  /** List contacts, one page (cursor-based). Used as search fallback. */
  listContacts(after, limit = 100) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set("after", after);
    return this.request("GET", `/contacts?${params.toString()}`);
  }
  /** Set custom attribute values on a contact: [{ id: "cat_...", value }] */
  setContactAttributes(contactId, attributes) {
    return this.request("PATCH", `/contacts/${encodeURIComponent(contactId)}`, {
      custom_attributes: attributes
    });
  }
  // -- Channels (discover WhatsApp / other channel ids) ----------------------
  listChannels() {
    return this.request("GET", "/channels");
  }
}
export {
  SuperchatClient
};
