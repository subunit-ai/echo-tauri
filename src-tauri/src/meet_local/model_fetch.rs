//! Download des wespeaker-Voiceprint-Modells (ONNX, ~26 MB) — EXAKT dieselbe
//! Datei wie auf dem Server (transcribe-api), darum md5-verifiziert: nur mit
//! identischem Modell gelten die GT-validierten Schwellen aus meet-core.
//! Quelle = die offizielle wespeakerruntime-Hub-URL (Tencent COS); die
//! Erreichbarkeit + md5-Gleichheit wurde 2026-06-11 vom Server aus verifiziert.

use std::io::Read;
use std::path::PathBuf;

const URL: &str =
    "https://wespeaker-1256283475.cos.ap-shanghai.myqcloud.com/models/voxceleb/voxceleb_resnet34_LM.onnx";
/// md5 der Server-Kopie (/root/.wespeaker/en/model.onnx im transcribe-api-Container).
const MD5: &str = "28caea8939ee1ba5107b31e5a62dc129";
const FILENAME: &str = "wespeaker_voxceleb_resnet34_LM.onnx";

pub fn speaker_model_path() -> PathBuf {
    crate::models::models_dir().join(FILENAME)
}

pub fn speaker_model_downloaded() -> bool {
    speaker_model_path()
        .metadata()
        .map(|m| m.len() > 1_000_000)
        .unwrap_or(false)
}

fn md5_of(path: &std::path::Path) -> anyhow::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = md5::Context::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.consume(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.compute()))
}

/// Lädt das Modell, falls es fehlt (blocking — vom Engine-Thread aufrufen).
/// Auch ein vorhandener Cache wird md5-verifiziert (Codex P2: korrupte/
/// manipulierte Datei darf den Integritäts-Check nicht umgehen) — bei
/// Mismatch wird gelöscht + frisch geladen.
pub fn ensure_speaker_model() -> anyhow::Result<PathBuf> {
    let path = speaker_model_path();
    if speaker_model_downloaded() {
        if md5_of(&path).map(|h| h == MD5).unwrap_or(false) {
            return Ok(path);
        }
        log::warn!("meet-local: gecachtes Voiceprint-Modell md5-Mismatch — lade neu");
        let _ = std::fs::remove_file(&path);
    }
    std::fs::create_dir_all(crate::models::models_dir())?;
    let tmp = path.with_extension("part");
    let _ = std::fs::remove_file(&tmp);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()?;
    let mut resp = client.get(URL).header("User-Agent", "Echo/0.1").send()?;
    if !resp.status().is_success() {
        anyhow::bail!("Voiceprint-Modell-Download: HTTP {}", resp.status());
    }
    let mut f = std::fs::File::create(&tmp)?;
    let mut hasher = md5::Context::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = resp.read(&mut buf)?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut f, &buf[..n])?;
        hasher.consume(&buf[..n]);
    }
    std::io::Write::flush(&mut f)?;
    drop(f);
    let got = format!("{:x}", hasher.compute());
    if got != MD5 {
        let _ = std::fs::remove_file(&tmp);
        anyhow::bail!("Voiceprint-Modell: md5-Mismatch ({got}) — Download verworfen");
    }
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}
