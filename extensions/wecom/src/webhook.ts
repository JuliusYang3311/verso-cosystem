import type { WecomHandleResult } from "./types.js";
import { WecomCrypto } from "./crypto.js";
import { WECOM_DUPLICATE } from "./types.js";

/** TTL-based message deduplication. */
class MessageDeduplicator {
  private seen = new Map<string, number>();
  private readonly ttl = 5 * 60 * 1000;

  isDuplicate(msgId: string): boolean {
    this.cleanup();
    if (this.seen.has(msgId)) return true;
    this.seen.set(msgId, Date.now());
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen) {
      if (now - ts > this.ttl) this.seen.delete(id);
    }
  }
}

/**
 * WeCom AI Bot webhook handler.
 * Messages are JSON (not XML). Responses use stream format.
 */
export class WecomWebhook {
  private readonly crypto: WecomCrypto;
  private readonly deduplicator = new MessageDeduplicator();

  constructor(config: { token: string; encodingAesKey: string }) {
    this.crypto = new WecomCrypto(config.token, config.encodingAesKey);
  }

  handleVerify(query: Record<string, string>): string | null {
    const { msg_signature, timestamp, nonce, echostr } = query;
    if (!msg_signature || !timestamp || !nonce || !echostr) return null;

    const calc = this.crypto.getSignature(timestamp, nonce, echostr);
    if (calc !== msg_signature) return null;

    try {
      return this.crypto.decrypt(echostr).message;
    } catch {
      return null;
    }
  }

  async handleMessage(query: Record<string, string>, body: string): Promise<WecomHandleResult> {
    const { msg_signature, timestamp, nonce } = query;
    if (!msg_signature || !timestamp || !nonce) return null;

    let encrypt: string | undefined;
    try {
      encrypt = JSON.parse(body).encrypt;
    } catch {
      return null;
    }
    if (!encrypt) return null;

    if (this.crypto.getSignature(timestamp, nonce, encrypt) !== msg_signature) return null;

    let data: Record<string, any>;
    try {
      data = JSON.parse(this.crypto.decrypt(encrypt).message);
    } catch {
      return null;
    }

    const msgtype = data.msgtype as string;
    const q = { timestamp, nonce };

    if (msgtype === "stream") {
      return { stream: { id: data.stream?.id }, query: q, rawData: data };
    }

    if (msgtype === "event") {
      return { event: data.event, query: q };
    }

    // Common fields for all message types
    const base = {
      msgId: data.msgid || `msg_${Date.now()}`,
      fromUser: data.from?.userid || "",
      responseUrl: data.response_url || "",
      chatType: data.chattype || "single",
      chatId: data.chatid || "",
      aibotId: data.aibotid || "",
    };

    if (msgtype === "text") {
      if (this.deduplicator.isDuplicate(base.msgId)) return WECOM_DUPLICATE;
      const quote = data.quote
        ? {
            msgType: data.quote.msgtype,
            content: data.quote.text?.content || data.quote.image?.url || "",
          }
        : null;
      return {
        message: { ...base, msgType: "text", content: data.text?.content || "", quote },
        query: q,
      };
    }

    if (msgtype === "voice") {
      if (this.deduplicator.isDuplicate(base.msgId)) return WECOM_DUPLICATE;
      const content = (data.voice?.content || "").trim();
      if (!content) return null;
      return { message: { ...base, msgType: "text", content }, query: q };
    }

    if (msgtype === "image") {
      if (this.deduplicator.isDuplicate(base.msgId)) return WECOM_DUPLICATE;
      return {
        message: { ...base, msgType: "image", content: "", imageUrl: data.image?.url },
        query: q,
      };
    }

    if (msgtype === "mixed") {
      if (this.deduplicator.isDuplicate(base.msgId)) return WECOM_DUPLICATE;
      const items: Array<{ msgtype: string; text?: { content: string }; image?: { url: string } }> =
        data.mixed?.msg_item || [];
      const textParts: string[] = [];
      const imageUrls: string[] = [];
      for (const item of items) {
        if (item.msgtype === "text" && item.text?.content) textParts.push(item.text.content);
        else if (item.msgtype === "image" && item.image?.url) imageUrls.push(item.image.url);
      }
      return {
        message: { ...base, msgType: "mixed", content: textParts.join("\n"), imageUrls },
        query: q,
      };
    }

    if (msgtype === "file") {
      if (this.deduplicator.isDuplicate(base.msgId)) return WECOM_DUPLICATE;
      return {
        message: {
          ...base,
          msgType: "file",
          content: "",
          fileUrl: data.file?.url || "",
          fileName: data.file?.name || data.file?.filename || "",
        },
        query: q,
      };
    }

    if (msgtype === "location") {
      if (this.deduplicator.isDuplicate(base.msgId)) return WECOM_DUPLICATE;
      const lat = data.location?.latitude || "";
      const lng = data.location?.longitude || "";
      const name = data.location?.name || data.location?.label || "";
      const content = name ? `[位置] ${name} (${lat}, ${lng})` : `[位置] ${lat}, ${lng}`;
      return { message: { ...base, msgType: "text", content }, query: q };
    }

    if (msgtype === "link") {
      if (this.deduplicator.isDuplicate(base.msgId)) return WECOM_DUPLICATE;
      const parts: string[] = [];
      if (data.link?.title) parts.push(`[链接] ${data.link.title}`);
      if (data.link?.description) parts.push(data.link.description);
      if (data.link?.url) parts.push(data.link.url);
      return {
        message: { ...base, msgType: "text", content: parts.join("\n") || "[链接]" },
        query: q,
      };
    }

    return null;
  }

  buildStreamResponse(
    streamId: string,
    content: string,
    finish: boolean,
    timestamp: string,
    nonce: string,
    options: {
      msgItem?: Array<{ msgtype: string; image: { base64: string; md5: string } }>;
      feedbackId?: string;
    } = {},
  ): string {
    const stream: Record<string, unknown> = { id: streamId, finish, content };
    if (options.msgItem?.length) stream.msg_item = options.msgItem;
    if (options.feedbackId) stream.feedback = { id: options.feedbackId };

    const plain = JSON.stringify({ msgtype: "stream", stream });
    const encrypted = this.crypto.encrypt(plain);
    const signature = this.crypto.getSignature(timestamp, nonce, encrypted);

    return JSON.stringify({ encrypt: encrypted, msgsignature: signature, timestamp, nonce });
  }
}
