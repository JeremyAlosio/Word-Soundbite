# Word Soundbite

An [Obsidian](https://obsidian.md) plugin that lets you attach audio recordings directly to words and phrases in your notes through either your desktop audio or a microphone. Highlight a word, record the sound, and click it later to hear it played back inline. Originally created for studying Japanese pronunciation.

## Features

- **Record desktop audio** — capture system/app audio playing on your computer (pronunciation from videos, dictionaries, etc.)
- **Record microphone** — use your own mic to record pronunciations
- **Click-to-play** — recorded words are underlined with a 🔊 icon; click to play back instantly
- **Trim sounds** — right-click a sound word to trim the start/end of the recording
- **Adjust volume** — set individual volume (0–150%) per soundbite if some are too loud or quiet
- **Delete sounds** — right-click to remove a sound and its audio file with confirmation
- **Works on Windows and macOS**
- **Quality presets** — Low (32 kbps), Medium (96 kbps), or High (192 kbps)
- **Flexible save locations** — save audio files next to your notes or in a fixed vault folder

## Installation

1. Copy the `word-soundbite` folder into your vault's `.obsidian/plugins/` directory
2. Restart Obsidian (or reload plugins)
3. Go to **Settings → Community Plugins** and enable **Word Soundbite**

## How to Use

1. Open a note in **Source mode** (Ctrl/Cmd+E)
2. **Highlight** a word or phrase
3. **Right-click → "Record soundbite"** or press **Ctrl+Shift+R**
4. A recording popup appears — click **⏹ Stop & Save** when done
5. The word is now underlined with a 🔊 icon — **click it** to play the sound
6. **Right-click** a sound word to:
   - 🔊 Play the sound
   - 🔈 Adjust volume (0–150% per soundbite)
   - ✂️ Trim the recording (set start/end times)
   - 🗑 Delete the sound (with confirmation)

## Desktop Audio Setup

### Windows

Desktop audio capture works out of the box. The plugin uses Electron's `desktopCapturer` to record all system audio.

### macOS

On Mac, the plugin uses screen sharing to capture desktop audio:

1. When you start a desktop recording, a system dialog asks you to **share a screen or window**
2. **Important:** Check the **"Share audio"** checkbox in that dialog
3. The plugin discards the video and only keeps the audio track

> **Tip:** If you don't see the "Share audio" option or it doesn't capture sound, you can install a virtual audio loopback driver like [BlackHole](https://existential.audio/blackhole/) and set it as your system audio output, then select "Microphone" in the plugin settings and choose BlackHole as your input device.

### Microphone Fallback

If desktop audio capture fails for any reason, the plugin automatically falls back to your microphone. You can also set the audio source to "Microphone" explicitly in settings.

## Settings

| Setting | Description |
|---------|-------------|
| **Audio source** | Desktop audio (captures system sound) or Microphone |
| **Recording quality** | Low (32 kbps), Medium (96 kbps), or High (192 kbps) |
| **Folder mode** | Relative (saves next to each note) or Absolute (one fixed folder) |
| **Subfolder name** | Name of the folder created next to notes (default: `sounds`) |
| **File name pattern** | Customize audio file names using tokens: `{word}`, `{YYYY}`, `{MM}`, `{DD}`, `{HH}`, `{mm}`, `{SS}`, `{timestamp}` |

## How It Works

- Recorded audio is saved as `.webm` files in a `sounds/` subfolder next to your note (or a custom folder)
- A `sounds/index.json` manifest tracks which words map to which audio files
- In your note, sound words are wrapped in `<span data-soundbite="path/to/file.webm">word</span>`
- Volume adjustments are stored directly on the span: `<span data-soundbite="..." data-volume="0.65">word</span>` (omitted when 100%)
- The plugin styles these spans with an underline and speaker icon, and attaches click-to-play behavior

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+R | Start recording for selected text |
| Ctrl+Shift+S | Stop recording and save |

## Requirements

- Obsidian v1.0.0 or later
- Desktop only (not available on mobile)
