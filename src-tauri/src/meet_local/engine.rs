//! Orchestrierung des lokalen Meet-Backends (Pro-Feature, Feature `local-meet`).
//!
//! Ein Engine-Thread besitzt den kompletten Zustand (Store, Whisper,
//! Embedder, Teilnehmer) und wird per Command-Channel gesteuert — Whisper-
//! Läufe dauern Sekunden bis Minuten und dürfen nie einen IPC-Command
//! blockieren. Die UI liest einen geteilten Status-Snapshot (+ Events
//! `echo://meet-local`).
//!
//! Ablauf = der Server-Pod-Flow, nur lokal:
//!   Aufnahme (cpal→PcmStore) → Stimm-Check-In pro Teilnehmer (Zahl vorlesen
//!   → Whisper → digits-Match → wespeaker-Voiceprint) → inkrementelle
//!   Fenster-Transkription (alle 20 s) → bei Stop: Tail + Naming-Kette
//!   (meet-core, GT-validiert) → Transkript + lokale Ablage. Audio verlässt
//!   das Gerät NIE.

use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::Emitter;

use meet_core::{name_segments, Anchors, Embedder, Segment};

use super::capture::MeetCapture;
use super::incremental::{IncrementalState, WindowTranscriber};
use super::model_fetch;
use super::pcm_store::{PcmStore, SR};
use super::whisper_window::WhisperWindow;

/// Stimm-Check-In: Aufnahmefenster nach dem Klick (Server: ~7 s Clip).
const CHECKIN_WINDOW_S: f64 = 8.0;
/// Inkrementelle Transkription: Step-Intervall (Server: 20 s).
const STEP_EVERY: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, Default)]
pub struct ParticipantInfo {
    pub name: String,
    pub code: String,
    pub enrolled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "phase")]
pub enum Phase {
    Recording,
    Processing,
    Done,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    #[serde(flatten)]
    pub phase: Phase,
    pub meeting_id: String,
    pub duration_s: f64,
    pub participants: Vec<ParticipantInfo>,
    /// Laufender Check-In: (Name, Restsekunden) — UI zeigt „… liest vor".
    pub checkin_active: Option<String>,
    /// Letztes Check-In-Ergebnis für die UI: "ok:<Name>" | "failed:<Name>".
    pub checkin_result: Option<String>,
    pub segments_done: usize,
    /// Mic-Pegel 0..1 (geboostet, wie der Diktat-Recorder).
    pub level: f32,
}

enum Cmd {
    AddParticipant { name: String, reply: Sender<Result<String, String>> },
    StartCheckin { name: String, reply: Sender<Result<(), String>> },
    Stop,
}

struct EngineCore {
    dir: PathBuf,
    meeting_id: String,
    store: Arc<Mutex<PcmStore>>,
    capture: Option<MeetCapture>,
    whisper: WhisperWindow,
    embedder: Option<Embedder>,
    participants: Vec<ParticipantInfo>,
    anchors: Anchors,
    inc: IncrementalState,
    checkin: Option<(String, f64)>, // (Name, Fenster-Start in Store-Sekunden)
    status: Arc<Mutex<Snapshot>>,
    app: tauri::AppHandle,
    started_at: u64,
}

pub struct EngineHandle {
    cmd_tx: Sender<Cmd>,
    status: Arc<Mutex<Snapshot>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl EngineHandle {
    pub fn snapshot(&self) -> Snapshot {
        self.status.lock().clone()
    }

    pub fn add_participant(&self, name: String) -> Result<String, String> {
        let (tx, rx) = channel();
        self.cmd_tx.send(Cmd::AddParticipant { name, reply: tx }).map_err(|_| "Engine weg")?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Engine antwortet nicht")?
    }

    pub fn start_checkin(&self, name: String) -> Result<(), String> {
        let (tx, rx) = channel();
        self.cmd_tx.send(Cmd::StartCheckin { name, reply: tx }).map_err(|_| "Engine weg")?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Engine antwortet nicht")?
    }

    /// Beendet die Aufnahme; Verarbeitung läuft im Engine-Thread weiter
    /// (Status → processing → done/error, Events an die UI).
    pub fn stop(&self) {
        let _ = self.cmd_tx.send(Cmd::Stop);
    }

    pub fn is_finished(&self) -> bool {
        matches!(self.status.lock().phase, Phase::Done | Phase::Error { .. })
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(Cmd::Stop);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

pub fn meetings_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("echo").join("meetings")
}

/// Startet Aufnahme + Engine-Thread. Modelle werden VOR dem Start sichergestellt
/// (Download beim ersten Mal), damit ein fehlendes Modell nicht erst beim
/// Stop auffällt.
pub fn start(
    app: tauri::AppHandle,
    mic_device: Option<String>,
    model: String,
    language: Option<String>,
) -> Result<EngineHandle, String> {
    crate::models::ensure_blocking(&model).map_err(|e| format!("Whisper-Modell: {e}"))?;
    let sp = model_fetch::ensure_speaker_model().map_err(|e| format!("Voiceprint-Modell: {e}"))?;
    let embedder = Embedder::new(&sp).map_err(|e| format!("Voiceprint-Modell laden: {e}"))?;

    let started_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let meeting_id = format!("local-{started_at}");
    let dir = meetings_dir().join(&meeting_id);
    let store = Arc::new(Mutex::new(
        PcmStore::create(&dir.join("audio.pcm")).map_err(|e| format!("PCM-Datei: {e}"))?,
    ));
    let capture = MeetCapture::start(mic_device, store.clone())?;

    let status = Arc::new(Mutex::new(Snapshot {
        phase: Phase::Recording,
        meeting_id: meeting_id.clone(),
        duration_s: 0.0,
        participants: Vec::new(),
        checkin_active: None,
        checkin_result: None,
        segments_done: 0,
        level: 0.0,
    }));
    let (cmd_tx, cmd_rx) = channel::<Cmd>();

    let core = EngineCore {
        dir,
        meeting_id,
        store,
        capture: Some(capture),
        whisper: WhisperWindow { model, language },
        embedder: Some(embedder),
        participants: Vec::new(),
        anchors: Vec::new(),
        inc: IncrementalState::new(),
        checkin: None,
        status: status.clone(),
        app,
        started_at,
    };
    let join = std::thread::Builder::new()
        .name("echo-meet-engine".into())
        .spawn(move || run(core, cmd_rx))
        .map_err(|e| format!("Engine-Thread: {e}"))?;

    Ok(EngineHandle { cmd_tx, status, join: Some(join) })
}

fn run(mut c: EngineCore, cmd_rx: std::sync::mpsc::Receiver<Cmd>) {
    let mut last_step = Instant::now();
    loop {
        match cmd_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Cmd::AddParticipant { name, reply }) => {
                let _ = reply.send(c.add_participant(name));
                c.publish();
            }
            Ok(Cmd::StartCheckin { name, reply }) => {
                let _ = reply.send(c.start_checkin(name));
                c.publish();
            }
            Ok(Cmd::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        c.tick_checkin();
        if last_step.elapsed() >= STEP_EVERY {
            last_step = Instant::now();
            let dur = c.store.lock().duration_s();
            let mut store = c.store.lock();
            let n = c.inc.step(&mut store, &mut c.whisper);
            drop(store);
            if n > 0 {
                let _ = c.inc.write_manifest(&c.dir.join("audio.segs.json"));
            }
            let mut s = c.status.lock();
            s.duration_s = dur;
            s.segments_done = c.inc.segments.len();
            drop(s);
            c.publish();
        } else {
            let mut s = c.status.lock();
            s.duration_s = c.store.lock().duration_s();
            s.level = c.capture.as_ref().map(|cap| cap.level()).unwrap_or(0.0);
        }
        // Disk-/Stream-Ausfall während der Aufnahme → sofort sichtbar machen,
        // statt am Ende ein stilles Loch im Transkript zu haben.
        if c
            .capture
            .as_ref()
            .map(|cap| cap.failed.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(false)
        {
            c.status.lock().phase = Phase::Error {
                message: "Aufnahme-Fehler: PCM-Datei nicht beschreibbar".into(),
            };
            c.publish();
            break;
        }
    }
    c.finish();
}

impl EngineCore {
    fn publish(&self) {
        let snap = self.status.lock().clone();
        let _ = self.app.emit("echo://meet-local", &snap);
    }

    fn add_participant(&mut self, name: String) -> Result<String, String> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Name fehlt".into());
        }
        if self.participants.iter().any(|p| p.name == name) {
            return Err("Name existiert schon".into());
        }
        // 5-stellige Zahl, eindeutig unter den Teilnehmern (wie Server-Check-In)
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let code = loop {
            let c = rng.gen_range(10_000u32..100_000).to_string();
            if !self.participants.iter().any(|p| p.code == c) {
                break c;
            }
        };
        self.participants.push(ParticipantInfo { name, code: code.clone(), enrolled: false });
        self.status.lock().participants = self.participants.clone();
        Ok(code)
    }

    fn start_checkin(&mut self, name: String) -> Result<(), String> {
        if self.checkin.is_some() {
            return Err("Es läuft schon ein Check-In".into());
        }
        if !self.participants.iter().any(|p| p.name == name) {
            return Err("Unbekannter Teilnehmer".into());
        }
        let from = self.store.lock().duration_s();
        self.checkin = Some((name.clone(), from));
        let mut s = self.status.lock();
        s.checkin_active = Some(name);
        s.checkin_result = None;
        Ok(())
    }

    /// Check-In-Fenster abgelaufen? → Clip transkribieren, Zahl matchen,
    /// Voiceprint embedden. Fehlschlag ist kein Abbruch: UI zeigt „failed",
    /// Host startet den Check-In einfach nochmal (wie online).
    fn tick_checkin(&mut self) {
        let Some((name, from)) = self.checkin.clone() else { return };
        let now = self.store.lock().duration_s();
        if now < from + CHECKIN_WINDOW_S {
            return;
        }
        self.checkin = None;
        let ok = self.process_checkin(&name, from, from + CHECKIN_WINDOW_S);
        let mut s = self.status.lock();
        s.checkin_active = None;
        s.checkin_result = Some(format!("{}:{name}", if ok { "ok" } else { "failed" }));
        s.participants = self.participants.clone();
        drop(s);
        self.publish();
    }

    fn process_checkin(&mut self, name: &str, a: f64, b: f64) -> bool {
        let Some(p) = self.participants.iter().position(|p| p.name == name) else {
            return false;
        };
        let Ok(clip) = self.store.lock().read_slice_s(a, b) else { return false };
        if clip.len() < SR {
            return false; // < 1 s Audio — Capture-Problem
        }
        let norm: Vec<f32> = clip.iter().map(|&s| s as f32 / 32768.0).collect();
        let Ok(segs) = self.whisper.transcribe(&norm) else { return false };
        let text: String = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
        if !meet_core::spoken_code_matches(&text, &self.participants[p].code) {
            log::info!("meet-local checkin '{name}': Zahl nicht erkannt in '{text}'");
            return false;
        }
        let Some(emb) = self.embedder.as_mut() else { return false };
        let raw: Vec<f32> = clip.iter().map(|&s| s as f32).collect();
        let Some(anchor) = emb.embed(&raw) else { return false };
        self.anchors.retain(|(n, _)| n != name);
        self.anchors.push((name.to_string(), anchor));
        self.participants[p].enrolled = true;
        true
    }

    /// Stop-Pfad: Capture beenden → Tail transkribieren → Naming-Kette →
    /// Transkript rendern + alles lokal ablegen.
    fn finish(mut self) {
        if let Some(cap) = self.capture.take() {
            cap.stop();
        }
        {
            let mut s = self.status.lock();
            s.phase = Phase::Processing;
            s.duration_s = self.store.lock().duration_s();
        }
        self.publish();

        let mut store = self.store.lock();
        self.inc.finalize(&mut store, &mut self.whisper);
        drop(store);
        let _ = self.inc.write_manifest(&self.dir.join("audio.segs.json"));

        // Naming-Kette mit injiziertem Embedder über den PCM-Store —
        // exakt der Server-_embed-Vertrag (Dauer-Floor, None bei kaputt).
        let segments = self.inc.segments.clone();
        let names: Vec<Option<String>> = if self.anchors.len() >= 1 && !segments.is_empty() {
            let store = self.store.clone();
            let embedder = Mutex::new(self.embedder.take());
            let embed = move |a: f64, b: f64, min_s: f64| -> Option<Vec<f32>> {
                if b - a < min_s {
                    return None;
                }
                let clip = store.lock().read_slice_s(a, b).ok()?;
                if (clip.len() as f64) < min_s * SR as f64 {
                    return None;
                }
                let raw: Vec<f32> = clip.iter().map(|&s| s as f32).collect();
                embedder.lock().as_mut()?.embed(&raw)
            };
            let r = name_segments(&segments, &self.anchors, embed, None);
            // name_segments kann Segmente splitten — die gesplittete Liste übernehmen
            let segs = r.segments;
            let names = r.names;
            return self.persist(segs, names);
        } else {
            vec![None; segments.len()]
        };
        self.persist(segments, names);
    }

    fn persist(&self, segments: Vec<Segment>, names: Vec<Option<String>>) {
        let duration = self.store.lock().duration_s();
        let transcript = render_transcript(&segments, &names);
        let meeting = serde_json::json!({
            "id": self.meeting_id,
            "started_at": self.started_at,
            "duration_s": duration,
            "params_version": meet_core::params().version,
            "usable": self.inc.usable,
            "participants": self.participants.iter().map(|p| &p.name).collect::<Vec<_>>(),
            "segments": segments.iter().zip(&names).map(|(s, n)| serde_json::json!({
                "start": s.start, "end": s.end, "text": s.text, "name": n,
            })).collect::<Vec<_>>(),
        });
        let ok = std::fs::write(self.dir.join("transcript.md"), &transcript).is_ok()
            && std::fs::write(
                self.dir.join("meeting.json"),
                serde_json::to_vec_pretty(&meeting).unwrap_or_default(),
            )
            .is_ok();
        // Voiceprints separat (Biometrie): Transkript-Artefakte bleiben teilbar.
        let vp: serde_json::Value = self
            .anchors
            .iter()
            .map(|(n, a)| (n.clone(), serde_json::json!(a)))
            .collect::<serde_json::Map<_, _>>()
            .into();
        let _ = std::fs::write(
            self.dir.join("voiceprints.json"),
            serde_json::to_vec(&vp).unwrap_or_default(),
        );

        let mut s = self.status.lock();
        s.duration_s = duration;
        s.segments_done = segments.len();
        s.phase = if ok {
            Phase::Done
        } else {
            Phase::Error { message: "Transkript konnte nicht gespeichert werden".into() }
        };
        drop(s);
        self.publish();
    }
}

/// Markdown-Transkript: aufeinanderfolgende Segmente desselben Sprechers
/// werden zu einem Block gruppiert (wie der Server-Renderer).
pub fn render_transcript(segments: &[Segment], names: &[Option<String>]) -> String {
    let mut out = String::from("# Meeting-Transkript (lokal verarbeitet)\n\n");
    let mut cur: Option<(String, f64, Vec<String>)> = None;
    let fmt_t = |t: f64| format!("{:02}:{:02}", (t as u64) / 60, (t as u64) % 60);
    let flush = |cur: &mut Option<(String, f64, Vec<String>)>, out: &mut String| {
        if let Some((name, t0, texts)) = cur.take() {
            out.push_str(&format!("[{}] **{}:** {}\n\n", fmt_t(t0), name, texts.join(" ")));
        }
    };
    for (s, n) in segments.iter().zip(names) {
        let name = n.clone().unwrap_or_else(|| "Sprecher".to_string());
        match cur.as_mut() {
            Some((cn, _, texts)) if *cn == name => texts.push(s.text.clone()),
            _ => {
                flush(&mut cur, &mut out);
                cur = Some((name, s.start, vec![s.text.clone()]));
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_groups_consecutive_speakers() {
        let seg = |a: f64, b: f64, t: &str| Segment {
            start: a,
            end: b,
            text: t.into(),
            words: None,
            energy: None,
        };
        let segs = vec![seg(0.0, 2.0, "Hallo."), seg(2.0, 4.0, "Wie geht's?"), seg(4.0, 6.0, "Gut!")];
        let names = vec![Some("Tom".into()), Some("Tom".into()), Some("Erik".into())];
        let md = render_transcript(&segs, &names);
        assert!(md.contains("[00:00] **Tom:** Hallo. Wie geht's?"));
        assert!(md.contains("[00:04] **Erik:** Gut!"));
        // unbenannt → neutraler Sprecher
        let md2 = render_transcript(&segs[..1], &[None]);
        assert!(md2.contains("**Sprecher:**"));
    }
}
