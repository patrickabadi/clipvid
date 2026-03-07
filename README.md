# ClipVid

A lightweight desktop video editor built with Electron, React, and TypeScript. Inspired by Clipchamp — fast, intuitive, and runs entirely offline.

![ClipVid](https://img.shields.io/badge/Electron-28-blue) ![React](https://img.shields.io/badge/React-18-61dafb) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6) ![License](https://img.shields.io/badge/License-MIT-green)

## Features

- **Multi-track timeline** — drag and drop video and audio clips with snap-to-grid
- **Real-time preview** — scrub and playback with frame-accurate seeking
- **Transitions** — fade, dissolve, flash, wipe, slide, zoom, and blur between clips
- **Clip editing** — trim, split, adjust speed, and volume per clip
- **Audio tracks** — separate audio clips with waveform visualization
- **Media bin** — import and organize your source files
- **Properties panel** — fine-tune clip and transition settings
- **Export** — render to MP4 via FFmpeg with full transition support
- **Adaptive preview** — player automatically matches video aspect ratio (portrait/landscape)
- **Remembers directories** — import and export dialogs open where you left off

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [Git](https://git-scm.com/)

FFmpeg is bundled automatically via `ffmpeg-static` — no separate installation needed.

## Installation

```bash
git clone https://github.com/patrickabadi/clipvid.git
cd clipvid
npm install
```

## Development

Start the app in development mode with hot reload:

```bash
npm run dev
```

This launches both the Vite dev server and the Electron window.

## Build

Build the production app:

```bash
npm run build
```

This compiles TypeScript, bundles with Vite, and packages with electron-builder. Output goes to the `release/` directory.

## Project Structure

```
clipvid/
├── electron/           # Electron main + preload process
│   ├── main.ts         # App window, IPC handlers, FFmpeg integration
│   ├── preload.ts      # Context bridge API
│   └── tsconfig.json
├── src/                # React renderer
│   ├── App.tsx         # Main layout (sidebar, player, timeline)
│   ├── main.tsx        # Entry point
│   ├── index.css       # All styles
│   ├── components/
│   │   ├── MediaBin.tsx        # Import & manage source media
│   │   ├── Player.tsx          # Video preview with dual-video transitions
│   │   ├── PropertiesPanel.tsx # Clip/transition property editor
│   │   ├── Timeline.tsx        # Multi-track timeline editor
│   │   └── TransitionsBin.tsx  # Transition type browser
│   ├── hooks/
│   │   └── useTimeline.ts      # State management with undo/redo
│   └── lib/
│       ├── TimelineContext.tsx  # React context provider
│       ├── types.ts            # TypeScript type definitions
│       └── electron.ts         # Electron API bridge
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 28 |
| UI framework | React 18 |
| Language | TypeScript 5 |
| Bundler | Vite 5 |
| Video processing | FFmpeg (via fluent-ffmpeg + ffmpeg-static) |
| Icons | Lucide React |

## License

MIT
