#!/usr/bin/env python3
"""Generate Echo Wortdex rarity tables (rarity_de.bin / rarity_en.bin).

Format: b"EDX1" + u32le count + count * (u32le fnv1a32(word), u8 band, u16le dex).
Records sorted by hash for binary search. Bands: 1=bemerkenswert (3.0<=zipf<3.6),
2=selten (2.0<=zipf<3.0), 3=legendaer (zipf<2.0). zipf>=4.2 or absent => not
collectible (excluded). dex = rank//10 (capped 65535): higher = rarer.
"""
import re, struct, sys
from wordfreq import top_n_list, zipf_frequency

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else "."

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

WORD_RE = re.compile(r"^[a-zäöüß]+$")

def fnv1a32(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

def band_for(z: float):
    if z >= 3.6: return None
    if z >= 3.0: return 1
    if z >= 2.0: return 2
    if z >= 1.0: return 3
    return None

def build(lang: str, cap_band3: int):
    other = "en" if lang == "de" else "de"
    words = top_n_list(lang, 800_000, wordlist="large")
    print(f"[{lang}] ranked list: {len(words)} words")
    seen_hashes = set()
    records = []
    counts = {1: 0, 2: 0, 3: 0}
    dropped_cross = 0
    for rank, w in enumerate(words):
        if len(w) < 5 or not WORD_RE.match(w) or w in NAMES:
            continue
        z = zipf_frequency(w, lang, wordlist="large")
        b = band_for(z)
        if b is None:
            continue
        # Cross-language contamination guard: everyday words of the OTHER
        # language leak into this corpus as "rare" tokens ("sagen" sits in the
        # English list at zipf ~1.5). A word that is common anywhere is never
        # a find.
        if zipf_frequency(w, other, wordlist="large") >= 4.2:
            dropped_cross += 1
            continue
        if b == 3 and counts[3] >= cap_band3:
            continue
        h = fnv1a32(w)
        if h in seen_hashes:  # collision: first (more common) wins
            continue
        seen_hashes.add(h)
        records.append((h, b, min(rank // 10, 65535)))
        counts[b] += 1
    records.sort(key=lambda r: r[0])
    path = f"{OUT_DIR}/rarity_{lang}.bin"
    with open(path, "wb") as f:
        f.write(b"EDX1")
        f.write(struct.pack("<I", len(records)))
        for h, b, d in records:
            f.write(struct.pack("<IBH", h, b, d))
    print(f"[{lang}] wrote {len(records)} records -> {path} "
          f"({4 + 4 + len(records)*7} bytes) bands={counts} cross-dropped={dropped_cross}")
    return path

def check(lang, expect):
    """Spot-check banding against known words."""
    import struct as st
    data = open(f"{OUT_DIR}/rarity_{lang}.bin", "rb").read()
    n = st.unpack("<I", data[4:8])[0]
    idx = {}
    for i in range(n):
        off = 8 + i * 7
        h, b, d = st.unpack("<IBH", data[off:off+7])
        idx[h] = (b, d)
    ok = True
    for w, want in expect.items():
        got = idx.get(fnv1a32(w))
        got_band = got[0] if got else None
        mark = "OK " if got_band == want else "FAIL"
        if got_band != want: ok = False
        print(f"  {mark} {w}: band={got_band} (want {want}) dex={got[1] if got else '-'}")
    return ok

p1 = build("de", cap_band3=10_000_000)
p2 = build("en", cap_band3=10_000_000)
ok = check("de", {
    "sagen": None, "haben": None,
    "diskrepanz": 1, "prägnant": 1, "obsolet": 1, "sukzessive": 1,
    "eloquenz": 2, "redundant": 2, "kohärent": 2, "stringent": 2,
    "apodiktisch": 3, "ephemer": 3, "defätismus": 3,
    "haus": None, "sagen": None, "arbeit": None, "thomas": None, "rahel": None,
})
ok &= check("en", {"eloquent": 2 if zipf_frequency("eloquent","en","large")<3.0 else 1,
                   "sesquipedalian": 3, "house": None})
print("ALL CHECKS PASS" if ok else "CHECKS FAILED")
sys.exit(0 if ok else 1)
