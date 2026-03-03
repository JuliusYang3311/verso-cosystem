# Telegram Status Reactions Integration - Complete

## Summary

Successfully integrated status reactions from OpenClaw into Verso's Telegram bot. Status reactions provide real-time visual feedback to users via emoji reactions on their messages, showing the bot's current state (thinking, using tools, done, error).

## Changes Made

### 1. Configuration Types ([src/config/types.messages.ts](src/config/types.messages.ts))

Added status reactions configuration types:

```typescript
export type StatusReactionsEmojiConfig = {
  thinking?: string;
  tool?: string;
  coding?: string;
  web?: string;
  done?: string;
  error?: string;
  stallSoft?: string;
  stallHard?: string;
};

export type StatusReactionsTimingConfig = {
  debounceMs?: number;
  stallSoftMs?: number;
  stallHardMs?: number;
  doneHoldMs?: number;
  errorHoldMs?: number;
};

export type StatusReactionsConfig = {
  enabled?: boolean;
  emojis?: StatusReactionsEmojiConfig;
  timing?: StatusReactionsTimingConfig;
};
```

Added `statusReactions?: StatusReactionsConfig` to `MessagesConfig`.

### 2. Reply Options ([src/auto-reply/types.ts](src/auto-reply/types.ts))

Added `onToolStart` callback to `GetReplyOptions`:

```typescript
onToolStart?: (payload: { name?: string; phase?: string }) => Promise<void> | void;
```

This callback is invoked when a tool starts executing, allowing channels to react to tool usage.

### 3. Agent Runner ([src/auto-reply/reply/agent-runner-execution.ts](src/auto-reply/reply/agent-runner-execution.ts))

Implemented `onToolStart` callback invocation in the agent event handler:

```typescript
if (evt.stream === "tool") {
  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
  if (phase === "start" || phase === "update") {
    await params.typingSignals.signalToolStart();
    // Notify onToolStart callback
    if (phase === "start") {
      const name = typeof evt.data.name === "string" ? evt.data.name : undefined;
      await params.opts?.onToolStart?.({ name, phase });
    }
  }
}
```

### 4. Message Context ([src/telegram/bot-message-context.ts](src/telegram/bot-message-context.ts))

Added status reaction controller creation:

- Imported `createStatusReactionController` and status reaction utilities
- Created status reaction controller with Telegram-specific adapter
- Integrated with ack reactions (status reactions replace simple ack when enabled)
- Added `statusReactionController` to return value

Key features:

- Resolves Telegram-supported emoji variants
- Checks chat-allowed reactions dynamically
- Falls back to supported emojis if requested emoji not available
- Replaces simple ack reaction with `setQueued()` when enabled

### 5. Message Dispatch ([src/telegram/bot-message-dispatch.ts](src/telegram/bot-message-dispatch.ts))

Integrated status reactions into message lifecycle:

1. **Extract controller from context**:

   ```typescript
   const { statusReactionController } = context;
   ```

2. **Set thinking state** before dispatching reply:

   ```typescript
   if (statusReactionController) {
     void statusReactionController.setThinking();
   }
   ```

3. **Set tool state** when tools are used:

   ```typescript
   onToolStart: statusReactionController
     ? async (payload) => {
         await statusReactionController.setTool(payload.name);
       }
     : undefined,
   ```

4. **Set error state** if no response generated:

   ```typescript
   if (statusReactionController && !hasFinalResponse) {
     void statusReactionController.setError().catch((err) => {
       logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
     });
   }
   ```

5. **Set done state** after successful completion:
   ```typescript
   if (statusReactionController) {
     void statusReactionController.setDone().catch((err) => {
       logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
     });
   }
   ```

## How It Works

### Lifecycle Flow

```
User Message
    ↓
[👀] setQueued() - Acknowledges message received
    ↓
[🤔] setThinking() - Bot is processing
    ↓
[🔥] setTool(name) - Bot is using a tool (emoji varies by tool type)
    ↓
[👍] setDone() - Success
    OR
[😱] setError() - No response generated
```

### Emoji Variants

The controller automatically selects appropriate emojis based on:

- **Tool type**: coding tools (👨‍💻), web tools (⚡), generic tools (🔥)
- **Chat restrictions**: Falls back to supported emojis if requested emoji not available
- **Stall detection**: Shows ⏳ (soft stall) or ⚠️ (hard stall) if processing takes too long

### Configuration

Enable status reactions in `config.json`:

```json
{
  "messages": {
    "statusReactions": {
      "enabled": true,
      "emojis": {
        "thinking": "🤔",
        "tool": "🔥",
        "done": "👍",
        "error": "😱"
      },
      "timing": {
        "debounceMs": 700,
        "stallSoftMs": 10000,
        "stallHardMs": 30000
      }
    }
  }
}
```

## Benefits

1. **Real-time feedback**: Users see exactly what the bot is doing
2. **Better UX**: Visual indicators are more engaging than text
3. **Reduced confusion**: Users know the bot is working, not stuck
4. **Tool awareness**: Different emojis for different tool types
5. **Error visibility**: Clear indication when something goes wrong

## Testing

To test status reactions:

1. Enable in config: `"messages": { "statusReactions": { "enabled": true } }`
2. Send a message to the bot
3. Observe emoji reactions changing:
   - 👀 when message received
   - 🤔 when bot starts thinking
   - 🔥 when bot uses tools
   - 👍 when bot completes successfully

## Compatibility

- Requires Telegram Bot API with `setMessageReaction` support
- Automatically falls back to simple ack reactions if API unavailable
- Works in both private chats and groups
- Respects chat-specific emoji restrictions

## Next Steps

This completes the minimal integration (Plan C from TELEGRAM_SYNC_SUMMARY.md). Future enhancements could include:

1. **Multi-lane delivery** (Plan B/A): Separate reasoning and answer streams
2. **Reasoning level support**: Configure reasoning visibility per session
3. **Preview management**: Enhanced draft message handling

## Files Modified

- `src/config/types.messages.ts` - Added status reactions config types
- `src/auto-reply/types.ts` - Added onToolStart callback
- `src/auto-reply/reply/agent-runner-execution.ts` - Implemented onToolStart invocation
- `src/telegram/bot-message-context.ts` - Created status reaction controller
- `src/telegram/bot-message-dispatch.ts` - Integrated lifecycle reactions

## Build Status

✅ All TypeScript compilation successful
✅ All lint checks passed
✅ Ready for testing
