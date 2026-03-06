import { Type } from "@sinclair/typebox";
import { google } from "googleapis";
import { getGoogleOAuthClient } from "../google-auth.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
export const gmailListMessages = {
  name: "gmail_list_messages",
  label: "List Gmail Messages",
  description: "List recent messages from the user's Gmail inbox.",
  parameters: Type.Object({
    q: Type.Optional(
      Type.String({ description: "Search query (same format as Gmail search box)" }),
    ),
    maxResults: Type.Optional(
      Type.Number({ description: "Max results to return (default: 10)", default: 10 }),
    ),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const gmail = google.gmail({ version: "v1", auth });
    const q = readStringParam(params, "q") || "";
    const maxResults = readNumberParam(params, "maxResults") || 10;
    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults,
    });
    return jsonResult(res.data);
  },
};
export const gmailGetMessage = {
  name: "gmail_get_message",
  label: "Get Gmail Message",
  description: "Get details of a specific Gmail message by ID.",
  parameters: Type.Object({
    id: Type.String({ description: "The message ID" }),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const gmail = google.gmail({ version: "v1", auth });
    const id = readStringParam(params, "id", { required: true });
    const res = await gmail.users.messages.get({
      userId: "me",
      id,
    });
    // Simple text extraction for the agent
    const part =
      res.data.payload?.parts?.find((p) => p.mimeType === "text/plain") || res.data.payload;
    const body = part?.body?.data ? Buffer.from(part.body.data, "base64").toString("utf-8") : "";
    return jsonResult({
      ...res.data,
      bodyText: body,
    });
  },
};
export const gmailSendEmail = {
  name: "gmail_send_email",
  label: "Send Gmail Email",
  description: "Send an email via Gmail.",
  parameters: Type.Object({
    to: Type.String({ description: "Recipient email address" }),
    subject: Type.String({ description: "Email subject" }),
    body: Type.String({ description: "Email body text" }),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const gmail = google.gmail({ version: "v1", auth });
    const to = readStringParam(params, "to", { required: true });
    const subject = readStringParam(params, "subject", { required: true });
    const body = readStringParam(params, "body", { required: true });
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
    const messageParts = [
      `To: ${to}`,
      "Content-Type: text/plain; charset=utf-8",
      "MIME-Version: 1.0",
      `Subject: ${utf8Subject}`,
      "",
      body,
    ];
    const message = messageParts.join("\n");
    const encodedMessage = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMessage,
      },
    });
    return jsonResult(res.data);
  },
};
export const gmailSendEmailWithAttachment = {
  name: "gmail_send_email_with_attachment",
  label: "Send Gmail Email with Attachment",
  description: "Send an email via Gmail with file attachments.",
  parameters: Type.Object({
    to: Type.String({ description: "Recipient email address" }),
    subject: Type.String({ description: "Email subject" }),
    body: Type.String({ description: "Email body text" }),
    attachmentPath: Type.String({
      description: "Path to the local file to attach (e.g., /path/to/document.pdf)",
    }),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const gmail = google.gmail({ version: "v1", auth });
    const to = readStringParam(params, "to", { required: true });
    const subject = readStringParam(params, "subject", { required: true });
    const body = readStringParam(params, "body", { required: true });
    const attachmentPath = readStringParam(params, "attachmentPath", { required: true });
    const fs = await import("node:fs");
    const path = await import("node:path");
    const mime = await import("mime-types");
    if (!fs.existsSync(attachmentPath)) {
      throw new Error(`Attachment file not found: ${attachmentPath}`);
    }
    const fileName = path.basename(attachmentPath);
    const mimeType = mime.lookup(attachmentPath) || "application/octet-stream";
    const fileContent = fs.readFileSync(attachmentPath);
    const base64File = fileContent.toString("base64");
    const boundary = "----=_Part_" + Date.now();
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
    const messageParts = [
      `To: ${to}`,
      `Subject: ${utf8Subject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${fileName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${fileName}"`,
      "",
      base64File,
      "",
      `--${boundary}--`,
    ];
    const message = messageParts.join("\n");
    const encodedMessage = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMessage,
      },
    });
    return jsonResult({
      ...res.data,
      attachmentSent: fileName,
    });
  },
};
