# Verso Electron App

A desktop application for Verso that wraps the CLI with a native macOS interface.

## Features

- Native macOS menu bar app
- Settings UI matching the Swift app design
- Workspace configuration
- Model and provider settings
- Browser tools configuration
- Web tools settings
- Evolver configuration
- Health check

## Development

```bash
cd apps/electron
pnpm install
pnpm start
```

## Build

```bash
pnpm run build:mac
```

This will create a DMG in the `dist` folder.
