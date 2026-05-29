const {
  Plugin, Notice, PluginSettingTab, Setting, Modal, Menu
} = require("obsidian");

// Electron's desktopCapturer moved to the renderer process in newer versions.
// Try multiple access patterns so it works across Obsidian versions.
let desktopCapturer;
try {
  // Obsidian 1.x — exposed on window by Electron's contextBridge
  desktopCapturer = window.require
    ? window.require("electron").desktopCapturer
    : require("electron").desktopCapturer;
} catch {}
if (!desktopCapturer && window.__electronDesktopCapturer) {
  desktopCapturer = window.__electronDesktopCapturer;
}
if (!desktopCapturer) {
  // Last resort: use the remote module (older Obsidian / Electron 12-)
  try {
    const remote = require("@electron/remote") || require("electron").remote;
    desktopCapturer = remote?.desktopCapturer;
  } catch {}
}

// Visual indicators are handled via MutationObserver — no CM6 imports needed.

// ─── Quality presets ──────────────────────────────────────────────────────────
const QUALITY_PRESETS = {
  low:    { audioBitsPerSecond: 32000,  label: "Low  (32 kbps — smallest files)" },
  medium: { audioBitsPerSecond: 96000,  label: "Medium (96 kbps — balanced)"     },
  high:   { audioBitsPerSecond: 192000, label: "High (192 kbps — best quality)"  },
};

const DEFAULT_SETTINGS = {
  audioSource:        "desktop",
  saveFolderMode:     "relative",
  relativeFolderName: "sounds",
  absoluteFolderPath: "",
  quality:            "medium",
};

// ─── Manifest helpers ─────────────────────────────────────────────────────────
// sounds/index.json  →  { "word": ["path/to/file.webm", ...], ... }
async function loadManifest(vault, folder) {
  const path = `${folder}/index.json`;
  try {
    const f = vault.getAbstractFileByPath(path);
    if (f) return JSON.parse(await vault.read(f));
  } catch {}
  return {};
}

async function saveManifest(vault, folder, data) {
  const path = `${folder}/index.json`;
  const json = JSON.stringify(data, null, 2);
  const f = vault.getAbstractFileByPath(path);
  if (f) await vault.modify(f, json);
  else    await vault.create(path, json);
}

// ─── Floating Recording Modal ─────────────────────────────────────────────────
class RecordingModal extends Modal {
  constructor(app, word, onStop, onCancel) {
    super(app);
    this.word     = word;
    this.onStop   = onStop;
    this.onCancel = onCancel;
    this.modalEl.style.cssText +=
      "max-width:340px; border-radius:16px; overflow:hidden;";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.style.cssText =
      "padding:28px 32px 24px; text-align:center; font-family: inherit;";

    // Pulsing dot
    const dot = contentEl.createEl("div");
    dot.style.cssText =
      "width:18px; height:18px; border-radius:50%; background:#e03e3e;" +
      "margin:0 auto 16px; animation: sb-pulse 1.2s ease-in-out infinite;";

    contentEl.createEl("h2", { text: "Recording…" }).style.cssText =
      "margin:0 0 6px; font-size:18px; font-weight:700;";

    const sub = contentEl.createEl("p");
    sub.style.cssText = "margin:0 0 4px; color:var(--text-muted); font-size:13px;";
    sub.setText("Capturing audio for");

    const wordLabel = contentEl.createEl("p");
    wordLabel.style.cssText =
      "margin:0 0 20px; font-size:15px; font-weight:600;" +
      "color:var(--text-accent); word-break:break-all;";
    wordLabel.setText(`"${this.word}"`);

    // Live timer
    this.startTime = Date.now();
    this.timerEl = contentEl.createEl("p");
    this.timerEl.style.cssText =
      "font-size:26px; font-variant-numeric:tabular-nums;" +
      "font-weight:700; margin:0 0 24px; letter-spacing:2px;";
    this.timerEl.setText("0:00");
    this._tick();
    this._tickInterval = setInterval(() => this._tick(), 500);

    // Buttons row
    const row = contentEl.createEl("div");
    row.style.cssText = "display:flex; gap:10px; justify-content:center;";

    const cancelBtn = row.createEl("button");
    cancelBtn.style.cssText =
      "background:var(--background-modifier-border); color:var(--text-normal);" +
      "border:none; border-radius:8px; padding:9px 20px; font-size:14px;" +
      "cursor:pointer; font-weight:500;";
    cancelBtn.setText("Cancel");
    cancelBtn.addEventListener("click", () => { this.close(); this.onCancel(); });

    const stopBtn = row.createEl("button");
    stopBtn.style.cssText =
      "background:#e03e3e; color:#fff; border:none; border-radius:8px;" +
      "padding:9px 24px; font-size:14px; cursor:pointer; font-weight:700;" +
      "display:flex; align-items:center; gap:6px;";
    stopBtn.innerHTML = "&#9209; Stop &amp; Save";
    stopBtn.addEventListener("click", () => { this.close(); this.onStop(); });

    // Inject keyframes once
    if (!document.getElementById("sb-styles")) {
      const s = document.createElement("style");
      s.id = "sb-styles";
      s.textContent = `
        @keyframes sb-pulse {
          0%,100% { transform:scale(1);   opacity:1;   }
          50%      { transform:scale(1.5); opacity:0.4; }
        }
        .sb-sound-word {
          border-bottom: 2px solid var(--text-accent, #7c6af7);
          padding-bottom: 1px;
          cursor: pointer;
          position: relative;
        }
        .sb-sound-word::after {
          content: "🔊";
          font-size: 0.65em;
          vertical-align: super;
          margin-left: 1px;
          opacity: 0.7;
        }
        .sb-sound-word:hover::after { opacity: 1; }
        .sb-gutter-icon {
          color: var(--text-accent, #7c6af7);
          cursor: default;
          font-size: 13px;
          padding-right: 4px;
          opacity: 0.75;
        }
      `;
      document.head.appendChild(s);
    }
  }

  _tick() {
    const s = Math.floor((Date.now() - this.startTime) / 1000);
    const m = Math.floor(s / 60);
    this.timerEl.setText(`${m}:${String(s % 60).padStart(2, "0")}`);
  }

  onClose() {
    clearInterval(this._tickInterval);
    this.contentEl.empty();
  }
}

// ─── Partial-word picker Modal ────────────────────────────────────────────────
class MatchPickerModal extends Modal {
  // matches: [{ word, src }]
  constructor(app, partial, matches, onPick) {
    super(app);
    this.partial  = partial;
    this.matches  = matches;
    this.onPick   = onPick;
    this.modalEl.style.cssText += "max-width:380px; border-radius:14px;";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.style.cssText = "padding:24px 28px;";
    contentEl.createEl("h2", { text: "Multiple matches found" }).style.cssText =
      "margin:0 0 8px; font-size:16px;";

    const sub = contentEl.createEl("p");
    sub.style.cssText = "margin:0 0 16px; color:var(--text-muted); font-size:13px;";
    sub.setText(
      `"${this.partial}" matches several sound words. Which should play?`
    );

    this.matches.forEach(({ word, src }) => {
      const btn = contentEl.createEl("button");
      btn.style.cssText =
        "display:block; width:100%; text-align:left; margin-bottom:8px;" +
        "background:var(--background-secondary); border:1px solid var(--background-modifier-border);" +
        "border-radius:8px; padding:10px 14px; cursor:pointer; font-size:14px;" +
        "transition: background 0.15s;";
      btn.innerHTML = `🔊 <strong>${word}</strong><br>` +
        `<span style="font-size:11px;color:var(--text-muted)">${src}</span>`;
      btn.addEventListener("mouseenter", () =>
        btn.style.background = "var(--background-modifier-hover)"
      );
      btn.addEventListener("mouseleave", () =>
        btn.style.background = "var(--background-secondary)"
      );
      btn.addEventListener("click", () => { this.close(); this.onPick({ word, src }); });
    });

    const cancel = contentEl.createEl("button");
    cancel.style.cssText =
      "margin-top:4px; background:transparent; border:none; color:var(--text-muted);" +
      "cursor:pointer; font-size:13px; padding:4px;";
    cancel.setText("Cancel");
    cancel.addEventListener("click", () => this.close());
  }

  onClose() { this.contentEl.empty(); }
}


// ─── Main Plugin ──────────────────────────────────────────────────────────────
module.exports = class WordSoundbyte extends Plugin {
  mediaRecorder  = null;
  audioChunks    = [];
  isRecording    = false;
  pendingEditor  = null;
  pendingWord    = null;
  pendingFile    = null;
  activeModal    = null;
  statusBarItem  = null;

  async onload() {
    await this.loadSettings();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("");

    // ── Commands ──────────────────────────────────────────────────────────
    this.addCommand({
      id:   "start-word-recording",
      name: "Start soundbyte recording for selection",
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "R" }],
      editorCallback: (editor, view) =>
        this.initiateRecording(editor, view.file),
    });

    this.addCommand({
      id:   "stop-word-recording",
      name: "Stop soundbyte recording",
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "S" }],
      callback: () => this.stopRecording(),
    });

    // ── Context menu ──────────────────────────────────────────────────────
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selected = editor.getSelection().trim();
        if (!selected) return;

        menu.addSeparator();

        if (this.isRecording) {
          // While recording show stop option
          menu.addItem((item) =>
            item
              .setTitle("⏹ Stop & save recording")
              .setIcon("stop-circle")
              .onClick(() => this.stopRecording())
          );
        } else {
          // Check if selection is or contains a sound word
          const folder  = this.resolveSaveFolder(view.file);
          const matches = this.findMatchesForPartial(selected, view.file, folder);

          if (matches.length > 0) {
            menu.addItem((item) =>
              item
                .setTitle(`🔊 Play soundbyte for "${selected}"`)
                .setIcon("volume-2")
                .onClick(() => this.playSoundForSelection(selected, matches))
            );
          }

          menu.addItem((item) =>
            item
              .setTitle(`🎙 Record soundbyte for "${selected}"`)
              .setIcon("microphone")
              .onClick(() => this.initiateRecording(editor, view.file))
          );
        }
      })
    );

    // ── Reading view: render sound spans ──────────────────────────────────
    this.registerMarkdownPostProcessor((el, ctx) => {
      el.querySelectorAll("span[data-soundbyte]").forEach((span) => {
        const src = span.getAttribute("data-soundbyte");
        if (!src) return;
        span.classList.add("sb-sound-word");
        span.addEventListener("click", () => this.playSound(src));
        span.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const menu = new Menu();
          menu.addItem((i) =>
            i.setTitle("🔊 Play sound").setIcon("volume-2")
             .onClick(() => this.playSound(src))
          );
          menu.showAtMouseEvent(e);
        });
      });
    });

    // ── Live Preview: inline decoration + gutter icons ────────────────────
    // ── MutationObserver: style sound spans in the live editor DOM ──────────
    // We skip the CM6 StateField approach entirely — it requires internal
    // Obsidian APIs that aren't reliably accessible. Instead we watch the
    // editor DOM for rendered <span data-soundbyte> elements and style them.
    this._observeLiveEditor();

    this.addSettingTab(new WordSoundbyteSetting(this.app, this));
    console.log("[WordSoundbyte] loaded");
  }

  _observeLiveEditor() {
    const plugin = this;

    const styleSpan = (span) => {
      if (span._sbDone) return;
      span._sbDone = true;
      span.classList.add("sb-sound-word");
      span.title = "🔊 Click to play";
      span.style.cursor = "pointer";
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        const src = span.getAttribute("data-soundbyte");
        if (src) plugin.playSound(src);
      });
      span.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const src = span.getAttribute("data-soundbyte");
        if (!src) return;
        const menu = new Menu();
        menu.addItem((i) =>
          i.setTitle("🔊 Play sound").setIcon("volume-2")
           .onClick(() => plugin.playSound(src))
        );
        menu.showAtMouseEvent(e);
      });
    };

    const scanRoot = (root) => {
      root.querySelectorAll("span[data-soundbyte]").forEach(styleSpan);
    };

    // Scan everything already in the DOM
    scanRoot(document.body);

    // Watch for new nodes (Live Preview renders spans dynamically)
    this._mutationObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.("span[data-soundbyte]")) styleSpan(node);
          else scanRoot(node);
        }
      }
    });

    this._mutationObserver.observe(document.body, {
      childList: true,
      subtree:   true,
    });
  }

  // ── Partial-word matching ─────────────────────────────────────────────────
  // Scans the active file content for all data-soundbyte spans,
  // returns those whose word contains or equals the partial selection.
  findMatchesForPartial(partial, file, folder) {
    if (!file) return [];
    const cache = this.app.metadataCache.getFileCache(file);
    // Read raw content synchronously via adapter if possible
    const content = this._fileContentCache || "";
    const results = [];
    const spanRe  = /<span\s+data-soundbyte="([^"]+)">([^<]*)<\/span>/g;
    let m;
    while ((m = spanRe.exec(content)) !== null) {
      const [, src, word] = m;
      if (
        word.toLowerCase().includes(partial.toLowerCase()) ||
        partial.toLowerCase().includes(word.toLowerCase())
      ) {
        results.push({ word, src });
      }
    }
    return results;
  }

  playSoundForSelection(partial, matches) {
    if (matches.length === 1) {
      this.playSound(matches[0].src);
    } else {
      new MatchPickerModal(this.app, partial, matches, ({ src }) =>
        this.playSound(src)
      ).open();
    }
  }

  // ── Record flow ───────────────────────────────────────────────────────────
  async initiateRecording(editor, file) {
    if (this.isRecording) {
      this.stopRecording();
      return;
    }
    const selected = editor.getSelection().trim();
    if (!selected) {
      new Notice("⚠️ Highlight a word or phrase first!");
      return;
    }

    // Cache file content for partial matching
    try {
      this._fileContentCache = await this.app.vault.read(file);
    } catch { this._fileContentCache = ""; }

    // Check if partial selection matches an existing sound word
    const folder  = this.resolveSaveFolder(file);
    const matches = this.findMatchesForPartial(selected, file, folder);

    // If it's a partial match (selection ≠ full word) ask what to do
    const isExactMatch = matches.some(
      (m) => m.word.toLowerCase() === selected.toLowerCase()
    );
    const isPartialHit = matches.length > 0 && !isExactMatch;

    if (isPartialHit) {
      // Show a modal: use existing sound or record new one?
      new PartialActionModal(
        this.app, selected, matches,
        () => {
          // Play existing
          this.playSoundForSelection(selected, matches);
        },
        () => {
          // Record new anyway
          this.pendingEditor = editor;
          this.pendingWord   = selected;
          this.pendingFile   = file;
          this.startRecording();
        }
      ).open();
      return;
    }

    this.pendingEditor = editor;
    this.pendingWord   = selected;
    this.pendingFile   = file;
    await this.startRecording();
  }

  async startRecording() {
    try {
      const stream = this.settings.audioSource === "desktop"
        ? await this.getDesktopAudioStream()
        : await navigator.mediaDevices.getUserMedia({ audio: true });

      this.audioChunks = [];

      const mimeType =
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" :
        MediaRecorder.isTypeSupported("audio/webm")             ? "audio/webm" :
                                                                   "audio/ogg";

      const { audioBitsPerSecond } =
        QUALITY_PRESETS[this.settings.quality] || QUALITY_PRESETS.medium;

      this.mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond });
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };
      this.mediaRecorder.onstop = () => this.saveRecording(stream);
      this.mediaRecorder.start(100);

      this.isRecording = true;
      this.statusBarItem.setText("🔴 Recording… (Ctrl+Shift+S to stop)");

      this.activeModal = new RecordingModal(
        this.app,
        this.pendingWord,
        () => this.stopRecording(),
        () => {
          // Cancel — stop but don't save
          this._cancelRecording = true;
          this.stopRecording();
        }
      );
      this.activeModal.open();
    } catch (err) {
      new Notice("❌ Recording failed: " + err.message);
      console.error("[WordSoundbyte] startRecording:", err);
      this.isRecording = false;
      this.statusBarItem.setText("");
    }
  }

  async getDesktopAudioStream() {
    if (!desktopCapturer) {
      new Notice("⚠️ Desktop audio unavailable in this Obsidian version — using microphone instead.");
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ["screen"], fetchWindowIcons: false });
    } catch (err) {
      new Notice("⚠️ Could not access desktop audio — using microphone instead.");
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (!sources?.length) {
      new Notice("⚠️ No screen sources found — using microphone instead.");
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const sourceId = sources[0].id;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } },
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId,
                              maxWidth: 1, maxHeight: 1, maxFrameRate: 1 } },
      });
      stream.getVideoTracks().forEach((t) => t.stop());
      return new MediaStream(stream.getAudioTracks());
    } catch (err) {
      new Notice("⚠️ Desktop capture failed, using microphone instead. (" + err.message + ")");
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      this.isRecording = false;
      this.statusBarItem.setText("");
      if (this.activeModal) { this.activeModal.close(); this.activeModal = null; }
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  resolveSaveFolder(file) {
    if (
      this.settings.saveFolderMode === "absolute" &&
      this.settings.absoluteFolderPath.trim()
    ) {
      return this.settings.absoluteFolderPath.trim().replace(/\/$/, "");
    }
    const noteDir    = file?.parent?.path || "";
    const folderName = this.settings.relativeFolderName.trim() || "sounds";
    return noteDir ? `${noteDir}/${folderName}` : folderName;
  }

  async saveRecording(stream) {
    if (this._cancelRecording) {
      this._cancelRecording = false;
      stream.getTracks().forEach((t) => t.stop());
      this.pendingEditor = this.pendingWord = this.pendingFile = null;
      this.audioChunks = [];
      new Notice("Recording cancelled.");
      return;
    }

    try {
      const blob = new Blob(this.audioChunks, { type: "audio/webm" });
      if (blob.size < 100) {
        new Notice("⚠️ Recording appears empty — check your audio source.");
        return;
      }

      const saveFolder = this.resolveSaveFolder(this.pendingFile);
      const safeName   = this.pendingWord
        .replace(/[^a-zA-Z0-9_\-]/g, "_").substring(0, 40);
      const fileName = `${saveFolder}/${safeName}_${Date.now()}.webm`;

      try { await this.app.vault.createFolder(saveFolder); } catch {}

      // Save audio file
      const ab = await blob.arrayBuffer();
      await this.app.vault.createBinary(fileName, new Uint8Array(ab));

      // Update manifest
      const manifest = await loadManifest(this.app.vault, saveFolder);
      const key = this.pendingWord.toLowerCase();
      if (!manifest[key]) manifest[key] = [];
      manifest[key].push(fileName);
      await saveManifest(this.app.vault, saveFolder, manifest);

      // Replace selection in editor with annotated span
      if (this.pendingEditor && this.pendingWord) {
        this.pendingEditor.replaceSelection(
          `<span data-soundbyte="${fileName}">${this.pendingWord}</span>`
        );
      }

      new Notice(`✅ Soundbyte saved — click "${this.pendingWord}" to play.`);
    } catch (err) {
      new Notice("❌ Save failed: " + err.message);
      console.error("[WordSoundbyte] saveRecording:", err);
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      this.pendingEditor = this.pendingWord = this.pendingFile = null;
      this.audioChunks = [];
    }
  }

  // ── Playback ──────────────────────────────────────────────────────────────
  playSound(src) {
    // Try to resolve broken relative paths by searching vault
    let path = src;
    const f = this.app.vault.getAbstractFileByPath(src);
    if (!f) {
      new Notice(`⚠️ Audio file not found: ${src}`);
      return;
    }
    new Audio(this.app.vault.adapter.getResourcePath(path))
      .play()
      .catch((err) => new Notice("❌ Playback error: " + err.message));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() { await this.saveData(this.settings); }
  onunload() {
    if (this.isRecording) this.stopRecording();
    if (this._mutationObserver) this._mutationObserver.disconnect();
  }
};

// ─── Partial action modal ────────────────────────────────────────────────────
class PartialActionModal extends Modal {
  constructor(app, partial, matches, onPlay, onRecord) {
    super(app);
    this.partial  = partial;
    this.matches  = matches;
    this.onPlay   = onPlay;
    this.onRecord = onRecord;
    this.modalEl.style.cssText += "max-width:360px; border-radius:14px;";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.style.cssText = "padding:24px 28px;";
    contentEl.createEl("h2", { text: "Partial selection detected" }).style.cssText =
      "margin:0 0 10px; font-size:16px;";

    const desc = contentEl.createEl("p");
    desc.style.cssText = "margin:0 0 18px; color:var(--text-muted); font-size:13px; line-height:1.5;";
    desc.setText(
      `"${this.partial}" is part of ${this.matches.length} existing sound word(s). ` +
      `Play the existing sound, or record a new one for this exact selection?`
    );

    const playBtn = contentEl.createEl("button");
    playBtn.style.cssText =
      "display:block; width:100%; margin-bottom:10px; padding:10px 14px;" +
      "background:var(--interactive-accent); color:var(--text-on-accent);" +
      "border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer;";
    playBtn.setText("🔊 Play existing sound");
    playBtn.addEventListener("click", () => { this.close(); this.onPlay(); });

    const recBtn = contentEl.createEl("button");
    recBtn.style.cssText =
      "display:block; width:100%; margin-bottom:10px; padding:10px 14px;" +
      "background:var(--background-secondary); color:var(--text-normal);" +
      "border:1px solid var(--background-modifier-border); border-radius:8px;" +
      "font-size:14px; font-weight:500; cursor:pointer;";
    recBtn.setText("🎙 Record new soundbyte");
    recBtn.addEventListener("click", () => { this.close(); this.onRecord(); });

    const cancel = contentEl.createEl("button");
    cancel.style.cssText =
      "display:block; width:100%; padding:8px; background:transparent;" +
      "border:none; color:var(--text-muted); font-size:13px; cursor:pointer;";
    cancel.setText("Cancel");
    cancel.addEventListener("click", () => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
class WordSoundbyteSetting extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Word Soundbyte" });
    containerEl.createEl("p", {
      text: "Attach audio recordings to words in your notes.",
    }).style.cssText = "color:var(--text-muted); margin-top:-8px; margin-bottom:20px; font-size:13px;";

    // ── Audio ──────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Audio" });

    new Setting(containerEl)
      .setName("Audio source")
      .setDesc("Desktop captures all system/app audio (Windows). Microphone uses your mic.")
      .addDropdown((d) =>
        d.addOption("desktop", "Desktop audio (Windows)")
         .addOption("microphone", "Microphone")
         .setValue(this.plugin.settings.audioSource)
         .onChange(async (v) => { this.plugin.settings.audioSource = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Recording quality")
      .setDesc("Higher quality = larger file. Low is fine for short voice clips.")
      .addDropdown((d) => {
        Object.entries(QUALITY_PRESETS).forEach(([k, { label }]) => d.addOption(k, label));
        d.setValue(this.plugin.settings.quality)
         .onChange(async (v) => { this.plugin.settings.quality = v; await this.plugin.saveSettings(); });
      });

    // ── Save Location ──────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Save location" });

    new Setting(containerEl)
      .setName("Folder mode")
      .setDesc("Relative: saves next to each note. Absolute: one fixed vault folder.")
      .addDropdown((d) =>
        d.addOption("relative", "Relative to note (recommended)")
         .addOption("absolute", "Fixed vault path")
         .setValue(this.plugin.settings.saveFolderMode)
         .onChange(async (v) => {
           this.plugin.settings.saveFolderMode = v;
           await this.plugin.saveSettings();
           this.display();
         })
      );

    if (this.plugin.settings.saveFolderMode === "relative") {
      new Setting(containerEl)
        .setName("Subfolder name")
        .setDesc('Folder created next to your note. Default: "sounds". E.g. Notes/Ideas.md → Notes/sounds/')
        .addText((t) =>
          t.setPlaceholder("sounds")
           .setValue(this.plugin.settings.relativeFolderName)
           .onChange(async (v) => {
             this.plugin.settings.relativeFolderName = v || "sounds";
             await this.plugin.saveSettings();
           })
        );
    } else {
      new Setting(containerEl)
        .setName("Vault folder path")
        .setDesc('Full path inside your vault. E.g. "Assets/soundbytes"')
        .addText((t) =>
          t.setPlaceholder("Assets/soundbytes")
           .setValue(this.plugin.settings.absoluteFolderPath)
           .onChange(async (v) => {
             this.plugin.settings.absoluteFolderPath = v;
             await this.plugin.saveSettings();
           })
        );
    }

    // ── Usage ──────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "How to use" });
    [
      "Open a note in Source mode (Ctrl+E)",
      "Highlight a word or phrase",
      "Right-click → 'Record soundbyte'  or press Ctrl+Shift+R",
      "A popup appears — click ⏹ Stop & Save when done",
      "Click the underlined 🔊 word to play it back",
      "Right-click a highlighted word to play or stop",
      "Highlighting part of a sound word offers to play the existing sound",
    ].forEach((s, i) => {
      const p = containerEl.createEl("p", { text: `${i + 1}. ${s}` });
      p.style.cssText = "margin:4px 0; font-size:13px;";
    });
  }
}
