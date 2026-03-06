import { Type } from "@sinclair/typebox";
import { google } from "googleapis";
import { getGoogleOAuthClient } from "../google-auth.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
export const docsCreateDocument = {
  name: "docs_create_document",
  label: "Create Google Doc",
  description: "Create a new Google Document.",
  parameters: Type.Object({
    title: Type.String({ description: "Title of the document" }),
    content: Type.Optional(Type.String({ description: "Initial content for the document" })),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const docsClient = google.docs({ version: "v1", auth });
    const driveClient = google.drive({ version: "v3", auth }); // Drive is easier for initial title
    const title = readStringParam(params, "title", { required: true });
    const content = readStringParam(params, "content") || "";
    const config = (await import("../../config/config.js")).loadConfig();
    const parents = config.google?.defaultDriveFolderId
      ? [config.google.defaultDriveFolderId]
      : undefined;
    // Create the document via Drive API to set the title more easily
    const res = await driveClient.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.document",
        parents,
      },
    });
    const documentId = res.data.id;
    if (!documentId) {
      throw new Error("Failed to create document");
    }
    if (content) {
      await docsClient.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: content,
              },
            },
          ],
        },
      });
    }
    return jsonResult({
      documentId,
      title,
      url: `https://docs.google.com/document/d/${documentId}/edit`,
    });
  },
};
export const sheetsCreateSpreadsheet = {
  name: "sheets_create_spreadsheet",
  label: "Create Google Sheet",
  description: "Create a new Google Spreadsheet.",
  parameters: Type.Object({
    title: Type.String({ description: "Title of the spreadsheet" }),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const driveClient = google.drive({ version: "v3", auth });
    const title = readStringParam(params, "title", { required: true });
    const config = (await import("../../config/config.js")).loadConfig();
    const parents = config.google?.defaultDriveFolderId
      ? [config.google.defaultDriveFolderId]
      : undefined;
    const res = await driveClient.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents,
      },
    });
    return jsonResult({
      spreadsheetId: res.data.id,
      title,
      url: `https://docs.google.com/spreadsheets/d/${res.data.id}/edit`,
    });
  },
};
export const sheetsAppendValues = {
  name: "sheets_append_values",
  label: "Append to Google Sheet",
  description: "Append rows/values to a Google Spreadsheet.",
  parameters: Type.Object({
    spreadsheetId: Type.String({ description: "The ID of the spreadsheet" }),
    range: Type.String({ description: "The range to append to (e.g. 'Sheet1!A1')" }),
    values: Type.Array(Type.Array(Type.Any()), { description: "2D array of values to append" }),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = readStringParam(params, "spreadsheetId", { required: true });
    const range = readStringParam(params, "range", { required: true });
    const values = params.values;
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: {
        values,
      },
    });
    return jsonResult(res.data);
  },
};
export const calendarListEvents = {
  name: "calendar_list_events",
  label: "List Calendar Events",
  description: "List upcoming events from the user's primary Google Calendar.",
  parameters: Type.Object({
    maxResults: Type.Optional(
      Type.Number({ description: "Max events to return (default: 10)", default: 10 }),
    ),
    timeMin: Type.Optional(
      Type.String({ description: "ISO date string to filter events after (default: now)" }),
    ),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const calendar = google.calendar({ version: "v3", auth });
    const maxResults = readNumberParam(params, "maxResults") || 10;
    const timeMin = readStringParam(params, "timeMin") || new Date().toISOString();
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
    });
    return jsonResult(res.data);
  },
};
export const calendarCreateEvent = {
  name: "calendar_create_event",
  label: "Create Calendar Event",
  description: "Create a new event in the user's primary Google Calendar.",
  parameters: Type.Object({
    summary: Type.String({ description: "Event title" }),
    description: Type.Optional(Type.String({ description: "Event description" })),
    start: Type.String({ description: "ISO start date/time" }),
    end: Type.String({ description: "ISO end date/time" }),
    location: Type.Optional(Type.String({ description: "Event location" })),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const calendar = google.calendar({ version: "v3", auth });
    const summary = readStringParam(params, "summary", { required: true });
    const description = readStringParam(params, "description");
    const start = readStringParam(params, "start", { required: true });
    const end = readStringParam(params, "end", { required: true });
    const location = readStringParam(params, "location");
    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description,
        start: { dateTime: start, timeZone: "UTC" },
        end: { dateTime: end, timeZone: "UTC" },
        location,
      },
    });
    return jsonResult(res.data);
  },
};
export const driveListFiles = {
  name: "drive_list_files",
  label: "List Drive Files",
  description: "List or search files in the user's Google Drive.",
  parameters: Type.Object({
    q: Type.Optional(
      Type.String({
        description:
          "Search query (e.g. \"name contains 'budget'\" or \"mimeType = 'application/pdf'\")",
      }),
    ),
    maxResults: Type.Optional(
      Type.Number({ description: "Max files to return (default: 20)", default: 20 }),
    ),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const drive = google.drive({ version: "v3", auth });
    const q = readStringParam(params, "q") || "";
    const maxResults = readNumberParam(params, "maxResults") || 20;
    const res = await drive.files.list({
      q,
      pageSize: maxResults,
      fields: "nextPageToken, files(id, name, mimeType, webViewLink)",
    });
    return jsonResult(res.data);
  },
};
export const slidesCreatePresentation = {
  name: "slides_create_presentation",
  label: "Create Google Slides",
  description: "Create a new Google Slides presentation.",
  parameters: Type.Object({
    title: Type.String({ description: "Title of the presentation" }),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const driveClient = google.drive({ version: "v3", auth });
    const title = readStringParam(params, "title", { required: true });
    const config = (await import("../../config/config.js")).loadConfig();
    const parents = config.google?.defaultDriveFolderId
      ? [config.google.defaultDriveFolderId]
      : undefined;
    const res = await driveClient.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.presentation",
        parents,
      },
    });
    return jsonResult({
      presentationId: res.data.id,
      title,
      url: `https://docs.google.com/presentation/d/${res.data.id}/edit`,
    });
  },
};
export const driveUploadFile = {
  name: "drive_upload_file",
  label: "Upload to Drive",
  description: "Upload a local file to Google Drive.",
  parameters: Type.Object({
    filePath: Type.String({ description: "Path to the local file to upload" }),
    name: Type.Optional(
      Type.String({ description: "Name for the file in Drive (defaults to local filename)" }),
    ),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const drive = google.drive({ version: "v3", auth });
    const filePath = readStringParam(params, "filePath", { required: true });
    const name = readStringParam(params, "name") || (await import("node:path")).basename(filePath);
    const config = (await import("../../config/config.js")).loadConfig();
    const parents = config.google?.defaultDriveFolderId
      ? [config.google.defaultDriveFolderId]
      : undefined;
    const res = await drive.files.create({
      requestBody: {
        name,
        parents,
      },
      media: {
        body: (await import("node:fs")).createReadStream(filePath),
      },
    });
    return jsonResult(res.data);
  },
};
export const driveDownloadFile = {
  name: "drive_download_file",
  label: "Download from Drive",
  description: "Download a file from Google Drive to local filesystem.",
  parameters: Type.Object({
    fileId: Type.String({ description: "The ID of the file to download from Google Drive" }),
    localPath: Type.String({
      description: "Local path where the file should be saved (including filename)",
    }),
    exportMimeType: Type.Optional(
      Type.String({
        description: "MIME type to export Google Workspace files as (e.g., application/pdf)",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const auth = await getGoogleOAuthClient();
    if (!auth) {
      throw new Error("Google Workspace is not enabled in your configuration.");
    }
    const drive = google.drive({ version: "v3", auth });
    const fileId = readStringParam(params, "fileId", { required: true });
    const localPath = readStringParam(params, "localPath", { required: true });
    const exportMimeType = readStringParam(params, "exportMimeType");
    // First, get file metadata to check mimeType
    const metadata = await drive.files.get({
      fileId,
      fields: "mimeType, name",
    });
    const mimeType = metadata.data.mimeType;
    const isGoogleDoc = mimeType?.startsWith("application/vnd.google-apps.");
    const fs = await import("node:fs");
    const path = await import("node:path");
    // Ensure directory exists
    const dir = path.dirname(localPath);
    fs.mkdirSync(dir, { recursive: true });
    let res;
    if (isGoogleDoc) {
      // It's a Google Workspace file, must export
      const targetMimeType = exportMimeType || "application/pdf";
      res = await drive.files.export(
        { fileId, mimeType: targetMimeType },
        { responseType: "stream" },
      );
    } else {
      // It's a binary file, simple download
      res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
    }
    // Write to local file
    const dest = fs.createWriteStream(localPath);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (!dest.destroyed) {
          dest.destroy();
        }
      };
      res.data
        .on("end", () => {
          cleanup();
          resolve(
            jsonResult({
              success: true,
              fileId,
              localPath,
              originalMimeType: mimeType,
              message: `File ${isGoogleDoc ? "exported" : "downloaded"} successfully to ${localPath}`,
            }),
          );
        })
        .on("error", (err) => {
          cleanup();
          reject(new Error(`Download failed: ${err.message}`));
        })
        .pipe(dest);
      dest.on("error", (err) => {
        res.data.destroy();
        reject(new Error(`Write failed: ${err.message}`));
      });
    });
  },
};
