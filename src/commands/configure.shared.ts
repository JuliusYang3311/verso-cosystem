import {
  confirm as clackConfirm,
  intro as clackIntro,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";

export const CONFIGURE_WIZARD_SECTIONS = [
  "workspace",
  "model",
  "browser",
  "nodehost",
  "compaction",
  "thinking",
  "web",
  "gateway",
  "daemon",
  "channels",
  "skills",
  "crypto",
  "moltbook",
  "google",
  "videogeneration",
  "twitter",
  "evolver",
  "health",
] as const;

export type WizardSection = (typeof CONFIGURE_WIZARD_SECTIONS)[number];

export type ChannelsWizardMode = "configure" | "remove";

export type ConfigureWizardParams = {
  command: "configure" | "update";
  sections?: WizardSection[];
};

export const CONFIGURE_SECTION_OPTIONS: Array<{
  value: WizardSection;
  label: string;
  hint: string;
}> = [
  { value: "workspace", label: "Workspace", hint: "Set workspace + sessions" },
  { value: "model", label: "Model", hint: "Pick provider + credentials" },
  { value: "browser", label: "Browser", hint: "Headless browser & snapshot settings" },
  { value: "nodehost", label: "Node Host", hint: "Browser proxy for remote agents" },
  {
    value: "compaction",
    label: "Compaction",
    hint: "Max session tokens, compaction, memory flush",
  },
  { value: "thinking", label: "Thinking", hint: "Internal thought process settings" },
  { value: "web", label: "Web tools", hint: "Configure Brave search + fetch" },
  { value: "gateway", label: "Gateway", hint: "Port, bind, auth, tailscale" },
  {
    value: "daemon",
    label: "Daemon",
    hint: "Install/manage the background service",
  },
  {
    value: "channels",
    label: "Channels",
    hint: "Link WhatsApp/Telegram/etc and defaults",
  },
  { value: "skills", label: "Skills", hint: "Install/enable workspace skills" },
  { value: "crypto", label: "Crypto", hint: "Wallet & Exchange keys" },
  { value: "moltbook", label: "Moltbook", hint: "Connect to the Agent Social Network" },
  { value: "google", label: "Google Workspace", hint: "Gmail, Docs, Calendar, OAuth" },
  {
    value: "videogeneration",
    label: "Video Generation",
    hint: "Pexels/Pixabay API keys for stock video",
  },
  {
    value: "twitter",
    label: "Twitter",
    hint: "Consumer key/secret, access token/secret",
  },
  {
    value: "evolver",
    label: "Evolver",
    hint: "Configure evolver path + workspace + review/rollback",
  },
  {
    value: "health",
    label: "Health check",
    hint: "Run gateway + channel checks",
  },
];

export const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
export const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);
export const text = (params: Parameters<typeof clackText>[0]) =>
  clackText({
    ...params,
    message: stylePromptMessage(params.message),
  });
export const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });
export const select = <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  clackSelect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });
