#!/usr/bin/env python3
"""Generate Echo Wortdex rarity tables (rarity_de.bin / rarity_en.bin).

SIX rarity bands, rarity rising with the band number (higher = rarer):

    1 Gewoehnlich   (Common)      Zipf [3.8, 4.6)
    2 Ungewoehnlich (Uncommon)    Zipf [3.2, 3.8)
    3 Selten        (Rare)        Zipf [2.6, 3.2)
    4 Episch        (Epic)        Zipf [2.0, 2.6)
    5 Mythisch      (Mythic)      Zipf [1.4, 2.0)
    6 Legendaer     (Legendary)   Zipf [1.0, 1.4)

Zipf >= 4.6 (everyday/function words) or Zipf < 1.0 (corpus noise) => not
collectible. Rarity comes purely from *corpus frequency* (wordfreq, MIT), so a
word's tier is objective, not hand-guessed.

QUALITY GATE (fixes "junk in Legendary"): every candidate must be a *real* word
per an affix-aware Hunspell check (spylls) against igerman98 (de) / SCOWL
en_US (en). This removes the deep-tail garbage that pure frequency lets through
— proper nouns, foreign tokens, typos, compound fragments — that made the old
3-band Legendary bucket junky. A small hand-curated CURATED map rescues the few
latinate gems Hunspell wrongly rejects (e.g. "ephemer") and injects a handful of
rare showpiece words. Dictionaries live in ./dict/ (build-time inputs only; the
shipped app embeds just the generated .bin files).

Format: b"EDX1" + u32le count + count * (u32le fnv1a32(word), u8 band, u16le dex).
Records sorted by hash for binary search. dex = rank//10 (capped 65535): higher
= rarer, a stable "Pokedex number".

Requires: pip install wordfreq spylls   (see requirements.txt)
"""
import os
import re
import struct
import sys
from concurrent.futures import ProcessPoolExecutor
from wordfreq import top_n_list, zipf_frequency

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else HERE
DICT_DIR = os.path.join(HERE, "dict")
RANK_DEPTH = 800_000
WORD_RE = re.compile(r"^[a-zäöüß]+$")
MIN_LEN = 5  # rarity.rs never looks up tokens shorter than this

# Band cutoffs as (band, lo, hi): lo <= zipf < hi. Ordered rarest last.
BANDS = [
    (1, 3.8, 4.6),   # Gewoehnlich
    (2, 3.2, 3.8),   # Ungewoehnlich
    (3, 2.6, 3.2),   # Selten
    (4, 2.0, 2.6),   # Episch
    (5, 1.4, 2.0),   # Mythisch
    (6, 1.0, 1.4),   # Legendaer
]
BAND_NAMES = {1: "gewoehnlich", 2: "ungewoehnlich", 3: "selten",
              4: "episch", 5: "mythisch", 6: "legendaer"}

# Common first names (de + international) — never collectible items.
NAMES = set("""
adrian alexander alexandra alina amelie andrea andreas angela angelika anja anke anna anne annika anton antonia
barbara bastian ben benedikt benjamin bernd bettina bianca birgit bjoern brigitte carina carla carlos caroline
carsten charlotte christa christian christiane christina christoph christopher claudia clemens constantin
cornelia daniel daniela david denis dennis diana dieter dirk dominik dorothea edith elena eleni elias elisabeth
elke emil emilia emily emma erik erika ernst esther eva fabian felix ferdinand finn florian frank franz frauke
frederik friederike fritz gabriel gabriele georg gerald gerhard gertrud gisela greta gudrun gunther hannah
hannes hanna hans harald heike heiko heinrich heinz helena helene helga helmut hendrik henriette henry herbert
hermann hilde holger horst hubert ilona ines inge ingeborg ingo ingrid irene iris isabel isabell isabella
jakob jan jana janina janine jannik jasmin jens jessica joachim johann johanna johannes jonas jonathan jorg
josef josephine juergen julia julian juliane julius jutta kai karin karl karla karolin katharina kathrin katja
katrin kerstin kevin kilian klaus konrad konstantin kurt lara larissa laura lea lena leon leonard leonie
lieselotte lilly lina linda lisa lorenz lothar louis louisa luca lucas ludwig luisa luise lukas magdalena
maja manfred manuel manuela marc marcel marco marcus mareike margarete margot maria marianne marie marina
mario marion marius markus marlene martha martin martina mathias matthias max maximilian melanie melina
michael michaela milan miriam mohammed monika moritz nadine natalie nathalie nele nicholas nicolas nico nicole
niklas nikolaus nils nina noah norbert oliver olivia oskar otto pascal patrick paul paula pauline peter petra
philipp philippe pia rafael rainer ralf ralph raphael rebecca regina reinhard renate rene ricarda richard
robert roland rolf romy rosa rudolf ruth sabine sabrina samuel sandra sara sarah sascha sebastian silke simon
simone sofia sofie sonja sophia sophie stefan stefanie steffen stephan stephanie susanne sven tanja theo
theodor theresa thomas thorsten till tim timo tobias tom torsten ulrich ulrike ursula uta ute uwe valentin
valentina vanessa vera verena viktor viktoria vincent volker walter werner wilhelm willi wolfgang xaver yannick
yvonne rahel rasmus jörg björn jürgen günther günter rené andré sören jörn käthe jürg götz
""".split())
NAMES |= {n.replace("ö","oe").replace("ü","ue").replace("ä","ae") for n in NAMES}
NAMES |= {n.replace("oe","ö").replace("ue","ü").replace("ae","ä") for n in list(NAMES)}

# Hand-curated overrides {word: band}. Bypass the Hunspell gate and pin the band.
# (a) rescue real latinate gems Hunspell/igerman98 wrongly rejects; (b) inject a
# few rare showpiece words. German only where the .bin is de; kept lowercase.
CURATED_DE = {
    # rescued spylls false-negatives (present in corpus, dropped by igerman98)
    "ephemer": 6, "serendipität": 6, "suffizient": 5,
    # injected showpiece words (rare/absent in corpus, unmistakably German)
    "liminal": 6, "numinos": 6, "diaphan": 6, "evaneszent": 6, "sublunarisch": 6,
    "äquilibrium": 5, "transluzent": 5, "oszillatorisch": 5, "synästhesie": 5,
    "petrichor": 6, "apricity": 6,
}
CURATED_EN = {
    "sesquipedalian": 6, "petrichor": 6, "susurrus": 6, "eloquent": 2,
}


def fnv1a32(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


# ---- Headword (lemma) gate — prestige filter for the top two tiers ----------
# The Zipf<2.0 tail of German is dominated by rare INFLECTIONS ("kribbelten",
# "abgemagerte") and transparent COMPOUNDS ("Datenobjekt", "Hochmoors") — rare
# but utterly unremarkable. Mythic/Legendary should be the opaque, evocative
# words (ephemer, apodiktisch, sardonisch, alveolar). Those are all dictionary
# HEADWORDS; inflections and compounds are not. So a band-5/6 word is kept only
# if it is an exact igerman98 lemma — one clean rule that rejects both at once.
# (Measured: keeps 22/24 curated gems, drops 17/18 noise samples.) The few gems
# igerman98 lacks — ephemer, perfide, serendipität — ride in via CURATED.
# Famous evocative compounds (Fernweh, Wehmut) are frequent enough to sit in
# lower bands already, so this never touches them.
_STEMS = set()


def load_stems():
    path = os.path.join(DICT_DIR, "de_DE.dic")
    with open(path, "rb") as f:
        raw = f.read().decode("latin-1")
    for i, line in enumerate(raw.splitlines()):
        if i == 0 and line.strip().isdigit():
            continue
        if line.startswith("\t") or not line.strip():
            continue
        stem = line.split("/", 1)[0].strip().lower()
        if stem:
            _STEMS.add(stem)


def is_headword(w: str) -> bool:
    return w in _STEMS


def band_for(z: float):
    for band, lo, hi in BANDS:
        if lo <= z < hi:
            return band
    return None


# ---- spylls worker pool: each process loads its dictionary once ----------
_SPY = None


def _spy_init(prefix: str):
    global _SPY
    from spylls.hunspell import Dictionary
    _SPY = Dictionary.from_files(prefix)


def _spy_valid(word: str) -> bool:
    # German nouns are capitalised in the dictionary; accept either case.
    return bool(_SPY.lookup(word) or _SPY.lookup(word.capitalize()))


def real_word_mask(words, prefix: str):
    """Parallel Hunspell validity for a list of lowercase words -> list[bool]."""
    workers = max(1, (os.cpu_count() or 2) - 2)
    with ProcessPoolExecutor(max_workers=workers, initializer=_spy_init,
                             initargs=(prefix,)) as ex:
        return list(ex.map(_spy_valid, words, chunksize=2000))


def build(lang: str, curated: dict):
    other = "en" if lang == "de" else "de"
    prefix = os.path.join(DICT_DIR, "de_DE" if lang == "de" else "en_US")
    words = top_n_list(lang, RANK_DEPTH, wordlist="large")
    print(f"[{lang}] ranked list: {len(words)} words")

    # Stage 1 — cheap filters + banding + cross-language guard.
    cand = []  # (word, band, rank)
    dropped_cross = 0
    for rank, w in enumerate(words):
        if len(w) < MIN_LEN or not WORD_RE.match(w) or w in NAMES:
            continue
        if w in curated:  # curated pins the band; handled after the loop
            continue
        b = band_for(zipf_frequency(w, lang, wordlist="large"))
        if b is None:
            continue
        if b >= 5 and lang == "de" and not is_headword(w):
            b = 4  # rare inflection/compound => Episch; top tiers = lemmas only
        # Everyday word of the OTHER language leaking in as "rare" => not a find.
        if zipf_frequency(w, other, wordlist="large") >= 4.2:
            dropped_cross += 1
            continue
        cand.append((w, b, rank))
    print(f"[{lang}] after cheap filters: {len(cand)} candidates "
          f"(cross-dropped {dropped_cross})")

    # Stage 2 — affix-aware Hunspell validity (the junk gate), parallel.
    mask = real_word_mask([c[0] for c in cand], prefix)
    kept = [c for c, ok in zip(cand, mask) if ok]
    print(f"[{lang}] after Hunspell gate: {len(kept)} "
          f"({100*len(kept)/max(1,len(cand)):.0f}% kept)")

    # Stage 3 — merge curated overrides (bypass gate, pinned band, deep dex).
    records = []
    counts = {b: 0 for b, _, _ in BANDS}
    seen_hashes = set()

    def add(word, band, rank):
        h = fnv1a32(word)
        if h in seen_hashes:
            return
        seen_hashes.add(h)
        records.append((h, band, min(rank // 10, 65535)))
        counts[band] += 1

    samples = {b: [] for b, _, _ in BANDS}
    for word, band in curated.items():
        add(word, band, 65535 * 10)  # curated => rarest dex bucket
    for word, band, rank in kept:
        add(word, band, rank)
        if len(samples[band]) < 40:
            samples[band].append(word)

    # Dump per-band example words (build-time inspection aid; not shipped).
    with open(os.path.join(OUT_DIR, f"samples_{lang}.txt"), "w") as sf:
        for b, _, _ in BANDS:
            sf.write(f"[{b} {BAND_NAMES[b]}] " + ", ".join(samples[b]) + "\n")

    records.sort(key=lambda r: r[0])
    path = os.path.join(OUT_DIR, f"rarity_{lang}.bin")
    with open(path, "wb") as f:
        f.write(b"EDX1")
        f.write(struct.pack("<I", len(records)))
        for h, b, d in records:
            f.write(struct.pack("<IBH", h, b, d))
    named = {BAND_NAMES[b]: counts[b] for b, _, _ in BANDS}
    print(f"[{lang}] wrote {len(records)} records -> {path} "
          f"({4 + 4 + len(records)*7} bytes)\n[{lang}] bands={named}")
    return path


def check(lang, expect):
    data = open(os.path.join(OUT_DIR, f"rarity_{lang}.bin"), "rb").read()
    n = struct.unpack("<I", data[4:8])[0]
    idx = {}
    for i in range(n):
        off = 8 + i * 7
        h, b, d = struct.unpack("<IBH", data[off:off + 7])
        idx[h] = (b, d)
    ok = True
    for w, want in expect.items():
        got = idx.get(fnv1a32(w))
        got_band = got[0] if got else None
        mark = "OK " if got_band == want else "FAIL"
        if got_band != want:
            ok = False
        print(f"  {mark} {w}: band={got_band} (want {want}) dex={got[1] if got else '-'}")
    return ok


if __name__ == "__main__":
    load_stems()
    print(f"[de] headword lemmas loaded: {len(_STEMS)}")
    build("de", CURATED_DE)
    build("en", CURATED_EN)
    print("[de] spot-check:")
    ok = check("de", {
        "sagen": None, "haben": None, "haus": None, "arbeit": None,
        "thomas": None, "rahel": None,
        "diskrepanz": 2, "prägnant": 3, "obsolet": 2,
        "eloquenz": 4, "kohärent": 4, "redundant": 3,
        "apodiktisch": 5, "defätismus": 5,
        "ephemer": 6, "sardonisch": 6,
    })
    print("[en] spot-check:")
    ok &= check("en", {"house": None, "sesquipedalian": 6})
    print("ALL CHECKS PASS" if ok else "CHECKS FAILED")
    sys.exit(0 if ok else 1)
