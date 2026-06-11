//! Die Naming-Kette: ordnet Whisper-Segmente eines Mono-Pod-Streams den
//! enrollten Sprechern zu. Verhaltensgleicher Port von
//! `python/meet_core/matching.py` (GT-validiert: 922462 98,4 %, 301304 100 %) —
//! die Golden-Replay-Tests beweisen die Parität gegen dieselben Fixtures.
//!
//! Stufen (Reihenfolge ist Teil der Spezifikation):
//!   1. Pass 1: argmax + Margin gegen die Enroll-Anker (Gate: cos ≥ T, Margin ≥ M)
//!   2. Anker-Adaption — RELATIVER Drift-Guard + all-or-nothing
//!   3. Sub-Segment-Splitting an Satzenden (.?!) oder Pausen ≥ SW_PAUSE
//!   4. Pass 2 gegen die finalen Anker
//!   5. Naming: direct → argmax → Mini-Embed-Rescue → ffill/bfill
//!
//! Der Embedder wird injiziert: `embed(start_s, end_s, min_s) -> Option<Vec<f32>>`
//! (L2-normierter Voiceprint des Audio-Ausschnitts, None wenn zu kurz/kaputt).

use serde::{Deserialize, Serialize};

use crate::params::{params, Params};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub word: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<Word>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NameStats {
    pub pass1_direct: usize,
    pub pass2_direct: usize,
    pub named: usize,
    pub adapted: bool,
    pub splits: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct NameResult {
    pub segments: Vec<Segment>,
    pub names: Vec<Option<String>>,
    pub stats: NameStats,
}

/// Anker mit stabiler Reihenfolge (Python: dict-Insertion-Order).
pub type Anchors = Vec<(String, Vec<f32>)>;

fn cos(a: &[f32], b: &[f32]) -> f64 {
    // Eingaben sind L2-normiert (wie np.dot in der Referenz, f32-Akkumulation)
    a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>() as f64
}

/// `[(cos, name)]` absteigend — Tie-Break wie Pythons Tupel-Sort (Name absteigend).
fn rank<'a>(e: &[f32], anchors: &'a Anchors) -> Vec<(f64, &'a str)> {
    let mut v: Vec<(f64, &str)> = anchors.iter().map(|(n, a)| (cos(e, a), n.as_str())).collect();
    v.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap().then_with(|| y.1.cmp(x.1)));
    v
}

fn word_text(w: &Word) -> &str {
    w.word.as_deref().unwrap_or("")
}

/// Rekursives Sub-Segment-Splitting (Stufe 3). Gibt Wort-Listen zurück
/// (1 Element = kein Schnitt).
fn split_words<F>(words: &[Word], anchors: &Anchors, embed: &F, p: &Params, depth: usize) -> Vec<Vec<Word>>
where
    F: Fn(f64, f64, f64) -> Option<Vec<f32>>,
{
    let sw = &p.split;
    if depth >= sw.sw_depth || words.len() < 2 {
        return vec![words.to_vec()];
    }
    let (st, en) = (words[0].start, words[words.len() - 1].end);
    if en - st < sw.sw_min_dur {
        return vec![words.to_vec()];
    }
    let ends_sentence = |w: &Word| {
        let t = word_text(w).trim();
        sw.sentence_ends.iter().any(|s| t.ends_with(s.as_str()))
    };
    let mut best: Option<(f64, usize)> = None;
    for k in 0..words.len() - 1 {
        let pause = words[k + 1].start - words[k].end;
        if pause < sw.sw_pause && !ends_sentence(&words[k]) {
            continue;
        }
        let (la, lb) = (st, words[k].end);
        let (ra, rb) = (words[k + 1].start, en);
        if lb - la < sw.sw_min_part || rb - ra < sw.sw_min_part {
            continue;
        }
        let (el, er) = (embed(la, lb, sw.sw_min_part), embed(ra, rb, sw.sw_min_part));
        let (el, er) = match (el, er) {
            (Some(el), Some(er)) => (el, er),
            _ => continue,
        };
        let (sl, sr) = (rank(&el, anchors), rank(&er, anchors));
        let (ml, mr) = (sl[0].0 - sl[1].0, sr[0].0 - sr[1].0);
        if sl[0].1 != sr[0].1 && ml >= sw.sw_m && mr >= sw.sw_m {
            if best.map_or(true, |(b, _)| ml + mr > b) {
                best = Some((ml + mr, k));
            }
        }
    }
    let Some((_, k)) = best else {
        return vec![words.to_vec()];
    };
    let mut out = split_words(&words[..k + 1], anchors, embed, p, depth + 1);
    out.extend(split_words(&words[k + 1..], anchors, embed, p, depth + 1));
    out
}

/// Komplette Naming-Kette — siehe Modul-Doku. `anchors` sind L2-normierte
/// Enroll-Voiceprints in stabiler Reihenfolge.
pub fn name_segments<F>(segs: &[Segment], anchors: &Anchors, embed: F, params_override: Option<&Params>) -> NameResult
where
    F: Fn(f64, f64, f64) -> Option<Vec<f32>>,
{
    let p = params_override.unwrap_or_else(|| params());
    let (t, m, min_emb) = (p.matching.t, p.matching.m, p.matching.min_emb_s);
    let ad = &p.adapt;
    let mini = &p.mini;
    let mut segs: Vec<Segment> = segs.to_vec();
    let mut work_anchors: Anchors = anchors.clone();

    // ── Pass 1: argmax + Margin für JEDES eingebettete Segment ──
    let n0 = segs.len();
    let mut embs: Vec<Option<Vec<f32>>> = vec![None; n0];
    let mut p1: Vec<Option<String>> = vec![None; n0];
    let mut arg1: Vec<Option<String>> = vec![None; n0];
    let mut p1m: Vec<f64> = vec![0.0; n0];
    for i in 0..n0 {
        let (st, en) = (segs[i].start, segs[i].end);
        if en - st < min_emb {
            continue;
        }
        let Some(e) = embed(st, en, min_emb) else { continue };
        let sc = rank(&e, &work_anchors);
        arg1[i] = Some(sc[0].1.to_string());
        p1m[i] = sc[0].0 - sc[1].0;
        if sc[0].0 >= t && p1m[i] >= m {
            p1[i] = Some(sc[0].1.to_string());
        }
        embs[i] = Some(e);
    }

    // ── Anker-Adaption (relativer Drift-Guard + all-or-nothing) ──
    let mut adapted: Vec<(usize, Vec<f32>)> = Vec::new();
    for (ai, (n, enroll)) in work_anchors.iter().enumerate() {
        let mut cand: Vec<(f64, &Vec<f32>)> = (0..n0)
            .filter(|&i| {
                arg1[i].as_deref() == Some(n.as_str())
                    && embs[i].is_some()
                    && p1m[i] >= ad.ad_margin
                    && (segs[i].end - segs[i].start) >= ad.ad_dur
            })
            .map(|i| (p1m[i], embs[i].as_ref().unwrap()))
            .collect();
        cand.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap()); // stabil, Margin absteigend
        cand.truncate(ad.ad_top);
        if cand.len() < ad.ad_min_cand {
            continue;
        }
        let dim = cand[0].1.len();
        let mut r = vec![0.0f32; dim];
        for (_, e) in &cand {
            for (j, x) in e.iter().enumerate() {
                r[j] += x;
            }
        }
        let len = cand.len() as f32;
        for x in r.iter_mut() {
            *x /= len;
        }
        let rn = r.iter().map(|x| x * x).sum::<f32>().sqrt();
        if rn > 0.0 {
            let a: Vec<f32> = r.iter().map(|x| x / rn).collect(); // re-L2-Norm
            let self_c = cos(enroll, &a);
            let other_c = work_anchors
                .iter()
                .filter(|(o, _)| o != n)
                .map(|(_, oe)| cos(oe, &a))
                .fold(-1.0f64, f64::max);
            if self_c - other_c >= ad.ad_rel {
                adapted.push((ai, a));
            }
        }
    }
    let all_adapted = adapted.len() == work_anchors.len();
    if all_adapted {
        for (ai, a) in adapted {
            work_anchors[ai].1 = a;
        }
    }

    // ── Sub-Segment-Splitting (nur Segmente mit Wort-Zeitstempeln) ──
    let mut n_split = 0usize;
    if segs.iter().any(|s| s.words.as_ref().map_or(false, |w| !w.is_empty())) {
        let mut segs2: Vec<Segment> = Vec::new();
        let mut embs2: Vec<Option<Vec<f32>>> = Vec::new();
        for (i, s) in segs.iter().enumerate() {
            let w: &[Word] = s.words.as_deref().unwrap_or(&[]);
            let parts = if w.len() >= 2 {
                split_words(w, &work_anchors, &embed, p, 0)
            } else {
                vec![w.to_vec()]
            };
            if parts.len() <= 1 {
                segs2.push(s.clone());
                embs2.push(embs[i].clone());
                continue;
            }
            n_split += 1;
            for part in parts {
                let (ps, pe) = (part[0].start, part[part.len() - 1].end);
                let text: String = part.iter().map(word_text).collect::<String>().trim().to_string();
                segs2.push(Segment {
                    start: ps,
                    end: pe,
                    text,
                    energy: Some(s.energy.unwrap_or(0.0)),
                    words: Some(part),
                });
                embs2.push(embed(ps, pe, p.split.sw_min_part));
            }
        }
        if n_split > 0 {
            segs = segs2;
            embs = embs2;
        }
    }

    // ── Pass 2: gegen die finalen Anker ──
    let n1 = segs.len();
    let mut direct: Vec<Option<String>> = vec![None; n1];
    let mut p2arg: Vec<Option<String>> = vec![None; n1];
    for i in 0..n1 {
        let Some(e) = embs[i].as_ref() else { continue };
        let sc = rank(e, &work_anchors);
        p2arg[i] = Some(sc[0].1.to_string());
        if sc[0].0 >= t && (sc[0].0 - sc[1].0) >= m {
            direct[i] = Some(sc[0].1.to_string());
        }
    }

    // ── Naming: direct → argmax → Mini-Rescue → ffill/bfill ──
    let mut seg_name = direct.clone();
    for i in 0..n1 {
        if seg_name[i].is_none() && p2arg[i].is_some() {
            seg_name[i] = p2arg[i].clone();
        }
    }
    for i in 0..n1 {
        if seg_name[i].is_some() || embs[i].is_some() {
            continue;
        }
        let Some(e) = embed(segs[i].start, segs[i].end, mini.mini_floor) else { continue };
        let sc = rank(&e, &work_anchors);
        if sc[0].0 - sc[1].0 >= mini.mini_m {
            seg_name[i] = Some(sc[0].1.to_string());
        }
    }
    let mut last: Option<String> = None;
    for i in 0..n1 {
        if seg_name[i].is_some() {
            last = seg_name[i].clone();
        } else if last.is_some() {
            seg_name[i] = last.clone();
        }
    }
    let mut nxt: Option<String> = None;
    for i in (0..n1).rev() {
        if seg_name[i].is_some() {
            nxt = seg_name[i].clone();
        } else if nxt.is_some() {
            seg_name[i] = nxt.clone();
        }
    }

    let stats = NameStats {
        pass1_direct: p1.iter().filter(|x| x.is_some()).count(),
        pass2_direct: direct.iter().filter(|x| x.is_some()).count(),
        named: seg_name.iter().filter(|x| x.is_some()).count(),
        adapted: all_adapted,
        splits: n_split,
    };
    NameResult { segments: segs, names: seg_name, stats }
}
