# Verso Desktop App Architecture Plan

## Overview

Verso is transitioning from a web-based UI (port 18789) to native desktop applications for macOS and Windows.

## Current State

- **macOS App**: Swift-based app in `apps/macos/` (uses WebView)
- **iOS App**: Swift-based app in `apps/ios/`
- **Old Web UI**: `ui/` directory (to be deprecated)
- **Backend**: Node.js gateway + agent system

## New Architecture

### Desktop UI Stack

- **Framework**: Electron (for cross-platform macOS + Windows)
- **UI**: React + TypeScript
- **Styling**: CSS modules
- **Communication**: IPC with Node.js backend

### Directory Structure

```
apps/
├── desktop/                    # New Electron app
│   ├── main/                   # Electron main process
│   │   ├── index.ts           # Entry point
│   │   ├── window.ts          # Window management
│   │   └── ipc.ts             # IPC handlers
│   ├── renderer/              # React UI
│   │   ├── index.tsx          # Entry point
│   │   ├── App.tsx            # Root component
│   │   ├── onboarding/        # Onboarding flow
│   │   ├── settings/          # Settings interface
│   │   ├── chat/              # Chat interface
│   │   └── orchestration/     # Orchestration board
│   └── package.json
├── macos/                     # Keep for native features (optional)
├── ios/                       # Keep for iOS
└── windows/                   # Windows-specific (if needed)

src/app/                       # Shared UI components (React)
├── onboarding/               # ✅ Already created
│   ├── welcome.tsx
│   ├── provider-setup.tsx
│   ├── channel-setup.tsx
│   ├── completion.tsx
│   └── index.tsx
└── settings/                 # ✅ Already created
    ├── general-settings.tsx
    ├── provider-settings.tsx
    ├── channel-settings.tsx
    └── index.tsx

ui/                           # ❌ TO BE DEPRECATED
└── (old web UI files)
```

## Migration Plan

### Phase 1: Electron Setup ✅ NEXT

1. Create `apps/desktop/` directory
2. Setup Electron with TypeScript
3. Configure build system (electron-builder)
4. Create basic window with React renderer

### Phase 2: UI Integration

1. Move React components from `src/app/` to `apps/desktop/renderer/`
2. Create main chat interface
3. Integrate orchestration board
4. Add system tray support

### Phase 3: Backend Integration

1. IPC bridge to Node.js gateway
2. Config file management
3. Provider authentication
4. Channel management

### Phase 4: Platform-Specific Features

**macOS:**

- Menu bar integration
- Dock icon
- Notifications
- Auto-updater (Sparkle)

**Windows:**

- System tray
- Notifications
- Auto-updater (Squirrel)

### Phase 5: Deprecation

1. Remove `ui/` directory
2. Remove web server (port 18789)
3. Update documentation
4. Update build scripts

## Technology Decisions

### Why Electron?

- Cross-platform (macOS + Windows)
- Native Node.js integration (reuse existing backend)
- Rich ecosystem
- Easy to package and distribute

### Alternative Considered: Tauri

- Pros: Smaller bundle, Rust-based
- Cons: Less mature, harder Node.js integration

### Keep Swift Apps?

**Option A: Replace with Electron**

- Simpler maintenance (one codebase)
- Easier cross-platform

**Option B: Keep Swift for macOS, Electron for Windows**

- Better native integration on macOS
- More work to maintain

**Recommendation**: Start with Electron for both, evaluate later.

## Build & Distribution

### macOS

```bash
# Development
pnpm desktop:dev

# Build
pnpm desktop:build:mac

# Package
pnpm desktop:package:mac
# Output: dist/Verso-1.0.0.dmg
```

### Windows

```bash
# Build
pnpm desktop:build:win

# Package
pnpm desktop:package:win
# Output: dist/Verso-Setup-1.0.0.exe
```

## Configuration

Desktop app will use the same config system:

- Config file: `~/.verso/config.json`
- First launch: Onboarding flow
- Settings: In-app settings panel

## Next Steps

1. ✅ Create onboarding UI components (DONE)
2. ✅ Create settings UI components (DONE)
3. ⏭️ Setup Electron project structure
4. ⏭️ Create main window with React
5. ⏭️ Integrate with backend
6. ⏭️ Build & test on macOS
7. ⏭️ Build & test on Windows
8. ⏭️ Remove old web UI

## Open Questions

1. Keep Swift macOS app or replace with Electron?
2. Auto-update strategy (Sparkle vs electron-updater)?
3. Code signing certificates for distribution?
4. App store distribution or direct download?
