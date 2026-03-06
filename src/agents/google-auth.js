import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { STATE_DIR } from "../config/paths.js";
import { log } from "./auth-profiles/constants.js";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.file",
];
export async function getGoogleOAuthClient() {
  const cfg = loadConfig();
  const googleCfg = cfg.google;
  if (!googleCfg?.enabled) {
    return null;
  }
  let credentials;
  const envJson = process.env.GOOGLE_WORKSPACE_OAUTH_JSON;
  const oauthJsonPathRaw = googleCfg.oauthJsonPath;
  if (envJson) {
    credentials = JSON.parse(envJson);
  } else if (oauthJsonPathRaw) {
    if (oauthJsonPathRaw.trim().startsWith("{")) {
      credentials = JSON.parse(oauthJsonPathRaw);
    } else {
      const oauthJsonPath = path.resolve(oauthJsonPathRaw);
      if (!fs.existsSync(oauthJsonPath)) {
        log.warn(`Google OAuth JSON not found at: ${oauthJsonPath}`);
        return null;
      }
      credentials = JSON.parse(fs.readFileSync(oauthJsonPath, "utf-8"));
    }
  } else {
    log.warn("Google Workspace enabled but no OAuth credentials provided (path or env var).");
    return null;
  }
  const clientConfig = credentials.installed || credentials.web;
  if (!clientConfig) {
    log.warn("Invalid Google OAuth JSON format.");
    return null;
  }
  const { client_secret, client_id, redirect_uris } = clientConfig;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || "http://localhost",
  );
  const tokensPathRaw = googleCfg.tokensPath;
  const tokensPath = tokensPathRaw
    ? path.resolve(tokensPathRaw)
    : path.join(STATE_DIR, "google-tokens.json");
  if (fs.existsSync(tokensPath)) {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, "utf-8"));
    oAuth2Client.setCredentials(tokens);
  } else {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
    });
    const errorMsg = [
      "Google Workspace NOT authenticated.",
      `1. Please visit this URL to authorize: ${authUrl}`,
      "2. After authorizing, you will be redirected to a 'localhost' page that might fail to load.",
      "3. Copy the 'code' parameter from that URL (e.g., http://localhost/?code=4/0Af...) ",
      "4. Run the following command to complete setup:",
      `   verso google auth --code "YOUR_CODE_HERE"`,
    ].join("\n");
    log.warn(errorMsg);
    throw new Error(errorMsg);
  }
  // Refresh token if needed
  oAuth2Client.on("tokens", (tokens) => {
    // Save tokens whenever they are updated (e.g. access token refreshed)
    const currentTokens = fs.existsSync(tokensPath)
      ? JSON.parse(fs.readFileSync(tokensPath, "utf-8"))
      : {};
    fs.mkdirSync(path.dirname(tokensPath), { recursive: true });
    fs.writeFileSync(tokensPath, JSON.stringify({ ...currentTokens, ...tokens }, null, 2));
  });
  return oAuth2Client;
}
export async function exchangeCodeForTokens(code) {
  const oAuth2Client = await getGoogleOAuthClientWithoutTokens();
  if (!oAuth2Client) {
    throw new Error("Google Workspace not enabled or OAuth credentials missing.");
  }
  const { tokens } = await oAuth2Client.getToken(code);
  const cfg = loadConfig();
  const googleCfg = cfg.google;
  const tokensPathRaw = googleCfg?.tokensPath;
  const tokensPath = tokensPathRaw
    ? path.resolve(tokensPathRaw)
    : path.join(STATE_DIR, "google-tokens.json");
  fs.mkdirSync(path.dirname(tokensPath), { recursive: true });
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
  log.info(`Google Workspace tokens saved to: ${tokensPath}`);
}
export async function getGoogleAuthUrl() {
  const oAuth2Client = await getGoogleOAuthClientWithoutTokens();
  if (!oAuth2Client) {
    throw new Error("Google Workspace not enabled or OAuth credentials missing.");
  }
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}
export async function getGoogleOAuthClientWithoutTokens() {
  const cfg = loadConfig();
  const googleCfg = cfg.google;
  if (!googleCfg?.enabled) {
    return null;
  }
  let credentials;
  const envJson = process.env.GOOGLE_WORKSPACE_OAUTH_JSON;
  const oauthJsonPathRaw = googleCfg.oauthJsonPath;
  if (envJson) {
    credentials = JSON.parse(envJson);
  } else if (oauthJsonPathRaw) {
    if (oauthJsonPathRaw.trim().startsWith("{")) {
      credentials = JSON.parse(oauthJsonPathRaw);
    } else {
      const oauthJsonPath = path.resolve(oauthJsonPathRaw);
      if (!fs.existsSync(oauthJsonPath)) {
        return null;
      }
      credentials = JSON.parse(fs.readFileSync(oauthJsonPath, "utf-8"));
    }
  } else {
    return null;
  }
  const clientConfig = credentials.installed || credentials.web;
  if (!clientConfig) {
    return null;
  }
  const { client_secret, client_id, redirect_uris } = clientConfig;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || "http://localhost");
}
