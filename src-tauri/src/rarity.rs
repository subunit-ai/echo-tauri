//! Wortdex rarity lookup — deterministic, offline, zero-latency.
//!
//! Two embedded tables (de/en) generated from wordfreq (MIT) Zipf frequencies
//! by `src-tauri/data/gen_rarity.py`. A word is *collectible* when it exists in
//! a table, i.e. it is a real, alphabetic word of length >= 5 that is rare
//! enough (Zipf < 4.2) to be worth celebrating. Common words and unknown
//! tokens (ASR noise, typos) are equally non-collectible — absence carries no
//! information, which is exactly what keeps the Fund detection precise.
//!
//! Record format (little-endian, sorted by hash for binary search):
//!   b"EDX1" + u32 count + count x { u32 fnv1a32(word), u8 band, u16 dex }
//! Bands: 1 = bemerkenswert (3.0<=zipf<3.6), 2 = selten (2.0<=zipf<3.0),
//! 3 = legendaer (zipf<2.0). `dex` = frequency rank / 10 — a stable, meaningful
//! "Pokedex number": the higher, the deeper the word sits in the language.

const TABLE_DE: &[u8] = include_bytes!("../data/rarity_de.bin");
const TABLE_EN: &[u8] = include_bytes!("../data/rarity_en.bin");

const MAGIC: &[u8; 4] = b"EDX1";
const REC: usize = 7;

/// Rarity band of a collectible word. Ordered: higher = rarer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Band {
    Notable = 1,
    Rare = 2,
    Legendary = 3,
}

impl Band {
    pub fn as_i64(self) -> i64 {
        self as i64
    }
    fn from_u8(b: u8) -> Option<Band> {
        match b {
            1 => Some(Band::Notable),
            2 => Some(Band::Rare),
            3 => Some(Band::Legendary),
            _ => None,
        }
    }
}

fn fnv1a32(word: &str) -> u32 {
    let mut h: u32 = 0x811C_9DC5;
    for b in word.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Binary-search one table for `hash`; returns (band, dex).
fn lookup_table(table: &'static [u8], hash: u32) -> Option<(Band, u16)> {
    if table.len() < 8 || &table[0..4] != MAGIC {
        return None;
    }
    let count = u32::from_le_bytes([table[4], table[5], table[6], table[7]]) as usize;
    let body = &table[8..];
    if body.len() < count * REC {
        return None;
    }
    let (mut lo, mut hi) = (0usize, count);
    while lo < hi {
        let mid = (lo + hi) / 2;
        let off = mid * REC;
        let h = u32::from_le_bytes([body[off], body[off + 1], body[off + 2], body[off + 3]]);
        if h == hash {
            let band = Band::from_u8(body[off + 4])?;
            let dex = u16::from_le_bytes([body[off + 5], body[off + 6]]);
            return Some((band, dex));
        } else if h < hash {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    None
}

/// Look a lowercase token up in BOTH language tables. When a word exists in
/// both (shared vocabulary), the MORE COMMON classification wins — a word that
/// is everyday language anywhere is not a find.
pub fn lookup(word: &str) -> Option<(Band, u16)> {
    // Tokens shorter than 5 chars were never written to the tables; skip the
    // hash + search for the bulk of tokens up front.
    if word.chars().count() < 5 {
        return None;
    }
    let hash = fnv1a32(word);
    let de = lookup_table(TABLE_DE, hash);
    let en = lookup_table(TABLE_EN, hash);
    match (de, en) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_parse_and_are_sorted() {
        for table in [TABLE_DE, TABLE_EN] {
            assert_eq!(&table[0..4], MAGIC);
            let count = u32::from_le_bytes([table[4], table[5], table[6], table[7]]) as usize;
            assert!(count > 100_000, "table suspiciously small: {count}");
            assert_eq!(table.len(), 8 + count * REC);
            let body = &table[8..];
            let mut prev = 0u32;
            // Spot-check monotonicity on a stride (full scan is fine too, but
            // keep the test fast).
            for i in (0..count).step_by(997) {
                let off = i * REC;
                let h =
                    u32::from_le_bytes([body[off], body[off + 1], body[off + 2], body[off + 3]]);
                assert!(h >= prev, "hashes not sorted at record {i}");
                prev = h;
            }
        }
    }

    #[test]
    fn known_words_band_correctly() {
        // German educated vocabulary — bands verified against wordfreq Zipf
        // values at generation time (gen_rarity.py spot-checks the same).
        assert_eq!(lookup("diskrepanz").map(|r| r.0), Some(Band::Notable));
        assert_eq!(lookup("prägnant").map(|r| r.0), Some(Band::Notable));
        assert_eq!(lookup("eloquenz").map(|r| r.0), Some(Band::Rare));
        assert_eq!(lookup("kohärent").map(|r| r.0), Some(Band::Rare));
        assert_eq!(lookup("apodiktisch").map(|r| r.0), Some(Band::Legendary));
        assert_eq!(lookup("ephemer").map(|r| r.0), Some(Band::Legendary));
        // English side.
        assert_eq!(lookup("eloquent").map(|r| r.0), Some(Band::Notable));
        assert_eq!(lookup("sesquipedalian").map(|r| r.0), Some(Band::Legendary));
    }

    #[test]
    fn common_and_unknown_words_are_not_collectible() {
        for w in ["und", "haus", "sagen", "arbeit", "house", "the"] {
            assert_eq!(lookup(w), None, "{w} must not be collectible");
        }
        // ASR noise / non-words are absent from the tables.
        assert_eq!(lookup("xyzqwrtz"), None);
        // First names are excluded at generation time.
        assert_eq!(lookup("thomas"), None);
        assert_eq!(lookup("rahel"), None);
    }

    #[test]
    fn short_tokens_short_circuit() {
        assert_eq!(lookup("öde"), None);
        assert_eq!(lookup("blau"), None); // 4 chars — below collectible length
    }

    #[test]
    fn band_ordering_matches_rarity() {
        assert!(Band::Legendary > Band::Rare);
        assert!(Band::Rare > Band::Notable);
        assert_eq!(Band::Legendary.as_i64(), 3);
    }
}
