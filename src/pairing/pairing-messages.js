import { formatCliCommand } from "../cli/command-format.js";
export function buildPairingReply(params) {
  const { channel, idLine, code } = params;
  return [
    "Verso: access not configured.",
    "",
    idLine,
    "",
    `Pairing code: ${code}`,
    "",
    "Ask the bot owner to approve with:",
    formatCliCommand(`verso pairing approve ${channel} <code>`),
  ].join("\n");
}
