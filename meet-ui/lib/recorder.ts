import { WSB } from "./api";

// Web audio capture + streaming — 1:1 port of the vanilla startRecording/openWS/
// startRecorder/stopRecording. Captures the mic via getUserMedia, streams webm/opus
// chunks over a WebSocket to transcribe.subunit.ai, reconnects on drops, holds a wake
// lock, and supports mute. This is the WEB audio adapter; Echo desktop will swap in a
// native (Rust dual-audio) adapter behind the same surface.

export interface RecorderCallbacks {
  /** Recording UI state: on=streaming, msg overrides the default label. */
  onState: (on: boolean, msg?: string) => void;
  /** Connection-lost banner toggle (reconnecting). */
  onConnLost: (on: boolean) => void;
  /** Terminal close: "ended" = host ended (code 4003), "stopped" = server stopped (>=4000). */
  onEnded?: (reason: "ended" | "stopped") => void;
}

export interface RecorderOpts {
  code: string;
  joinToken: string;
  micDeviceId?: string | null;
}

export class MeetingRecorder {
  private recording = false;
  private ws: WebSocket | null = null;
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  muted = false;

  constructor(
    private opts: RecorderOpts,
    private cb: RecorderCallbacks,
  ) {}

  isRecording() {
    return this.recording;
  }

  async start(): Promise<boolean> {
    if (this.recording) return true;
    this.recording = true;
    try {
      const audio: MediaTrackConstraints = Object.assign(
        this.opts.micDeviceId ? { deviceId: { exact: this.opts.micDeviceId } } : {},
        { echoCancellation: true, noiseSuppression: true },
      );
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch {
      this.recording = false;
      return false;
    }
    this.openWS();
    this.acquireWakeLock();
    document.addEventListener("visibilitychange", this.onVisibility);
    return true;
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && this.recording) {
      this.acquireWakeLock();
      if (!this.ws || this.ws.readyState > 1) this.openWS();
    }
  };

  private async acquireWakeLock() {
    try {
      if ("wakeLock" in navigator) this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      /* ignore */
    }
  }
  private releaseWakeLock() {
    try {
      this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }

  private openWS() {
    if (!this.recording) return;
    const url = `${WSB}/v1/meetings/${this.opts.code}/audio/${this.opts.joinToken}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.startRecorder();
      this.cb.onState(true);
      this.cb.onConnLost(false);
    };
    ws.onclose = (e) => {
      this.stopRecorder();
      if (e.code === 4003) {
        this.recording = false;
        this.cb.onConnLost(false);
        this.cb.onEnded?.("ended");
        return;
      }
      if (this.recording && e.code >= 4000) {
        this.cb.onState(false, "Aufnahme beendet.");
        this.recording = false;
        this.cb.onConnLost(false);
        this.cb.onEnded?.("stopped");
        return;
      }
      if (this.recording && e.code !== 1000) {
        this.cb.onState(false, "Verbindung unterbrochen — verbinde neu…");
        this.cb.onConnLost(true);
        setTimeout(() => {
          if (this.recording) this.openWS();
        }, 1500);
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private startRecorder() {
    if (!this.stream) return;
    let mime = "audio/webm;codecs=opus";
    if (!(window.MediaRecorder && MediaRecorder.isTypeSupported(mime))) mime = "audio/webm";
    try {
      this.rec = new MediaRecorder(this.stream, { mimeType: mime, audioBitsPerSecond: 64000 });
    } catch {
      try {
        this.rec = new MediaRecorder(this.stream);
      } catch {
        this.cb.onState(false, "Aufnahme nicht unterstützt.");
        return;
      }
    }
    this.rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size && this.ws && this.ws.readyState === 1) {
        ev.data.arrayBuffer().then((b) => {
          try {
            this.ws?.send(b);
          } catch {
            /* ignore */
          }
        });
      }
    };
    this.rec.start(1000);
  }

  private stopRecorder() {
    try {
      if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }

  stop() {
    this.recording = false;
    this.releaseWakeLock();
    this.stopRecorder();
    document.removeEventListener("visibilitychange", this.onVisibility);
    setTimeout(() => {
      try {
        if (this.ws && this.ws.readyState === 1) this.ws.send("stop");
      } catch {
        /* ignore */
      }
      try {
        this.ws?.close(1000);
      } catch {
        /* ignore */
      }
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
    }, 800);
  }

  /** Toggle mute (track.enabled). Returns the new muted state. */
  toggleMute(): boolean {
    if (!this.stream) return this.muted;
    this.muted = !this.muted;
    try {
      this.stream.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    } catch {
      /* ignore */
    }
    return this.muted;
  }
}
