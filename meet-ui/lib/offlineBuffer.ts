import { API } from "./api";

// Offline-Resilienz (Phase 1, 2026-06-11): WS weg → die Aufnahme läuft als
// self-contained webm-Block weiter, Chunks landen crash-sicher in IndexedDB.
// Sobald die Verbindung zurück ist, lädt flushBlocks() jeden Block als EINE
// Datei über POST /v1/meetings/{code}/audio-block/{token}?age_s=… hoch — der
// Server legt dafür eine Connection-Datei mit korrektem Offset an (gleiches
// Modell wie ein WS-Reconnect). age_s = Alter des Block-Starts relativ zu
// JETZT (kein absoluter Timestamp → immun gegen Client-Uhr-Skew).

const DB_NAME = "meet-offline";
const DB_VER = 1;

interface BlockMeta {
  id: string; // `${code}:${token}:${startedMs}`
  code: string;
  token: string;
  startedMs: number; // Date.now() beim Block-Start (nur für age_s-Differenz benutzt)
  closed: boolean; // Recorder gestoppt → Block vollständig, upload-bereit
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("blocks")) db.createObjectStore("blocks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("chunks"))
        db.createObjectStore("chunks", { keyPath: ["blockId", "seq"] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class OfflineBuffer {
  private db: IDBDatabase | null = null;
  private blockId: string | null = null;
  private seq = 0;

  constructor(
    private code: string,
    private token: string,
  ) {}

  private async ensureDb(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    try {
      this.db = await openDb();
    } catch {
      this.db = null; // kein IndexedDB (privater Modus o. Ä.) → Chunks gehen verloren wie bisher
    }
    return this.db;
  }

  /** Neuen Offline-Block beginnen (beim WS-Drop). */
  async startBlock(): Promise<void> {
    const db = await this.ensureDb();
    if (!db) return;
    const meta: BlockMeta = {
      id: `${this.code}:${this.token}:${Date.now()}`,
      code: this.code,
      token: this.token,
      startedMs: Date.now(),
      closed: false,
    };
    this.blockId = meta.id;
    this.seq = 0;
    try {
      await reqDone(tx(db, "blocks", "readwrite").put(meta));
    } catch {
      this.blockId = null;
    }
  }

  /** Chunk des laufenden Offline-Blocks persistieren. */
  async addChunk(data: Blob): Promise<void> {
    if (!this.db || !this.blockId) return;
    try {
      await reqDone(
        tx(this.db, "chunks", "readwrite").put({ blockId: this.blockId, seq: this.seq++, data }),
      );
    } catch {
      /* voll/quota → Chunk verloren, Aufnahme läuft weiter */
    }
  }

  /** Laufenden Block als vollständig markieren (Recorder gestoppt). */
  async closeBlock(): Promise<void> {
    if (!this.db || !this.blockId) return;
    try {
      const store = tx(this.db, "blocks", "readwrite");
      const meta = (await reqDone(store.get(this.blockId))) as BlockMeta | undefined;
      if (meta) {
        meta.closed = true;
        await reqDone(tx(this.db, "blocks", "readwrite").put(meta));
      }
    } catch {
      /* ignore */
    }
    this.blockId = null;
  }

  /** Alle GESCHLOSSENEN Blöcke dieses Meetings/Tokens hochladen (ältester zuerst).
   *  Erfolgreich hochgeladene Blöcke werden gelöscht. Wirft nie. */
  async flushBlocks(): Promise<{ uploaded: number; failed: number }> {
    const db = await this.ensureDb();
    let uploaded = 0;
    let failed = 0;
    if (!db) return { uploaded, failed };
    let metas: BlockMeta[] = [];
    try {
      const all = (await reqDone(tx(db, "blocks", "readonly").getAll())) as BlockMeta[];
      metas = all
        .filter((m) => m.code === this.code && m.token === this.token && m.closed)
        .sort((a, b) => a.startedMs - b.startedMs);
    } catch {
      return { uploaded, failed };
    }
    for (const meta of metas) {
      try {
        const range = IDBKeyRange.bound([meta.id, 0], [meta.id, Number.MAX_SAFE_INTEGER]);
        const rows = (await reqDone(tx(db, "chunks", "readonly").getAll(range))) as {
          seq: number;
          data: Blob;
        }[];
        rows.sort((a, b) => a.seq - b.seq);
        const blob = new Blob(
          rows.map((r) => r.data),
          { type: "audio/webm" },
        );
        if (blob.size > 0) {
          const ageS = Math.max(0, (Date.now() - meta.startedMs) / 1000);
          const res = await fetch(
            `${API}/v1/meetings/${meta.code}/audio-block/${meta.token}?age_s=${ageS.toFixed(1)}`,
            { method: "POST", headers: { "content-type": "application/octet-stream" }, body: blob },
          );
          if (!res.ok && res.status !== 409) throw new Error(`http ${res.status}`);
          // 409 = Meeting nicht (mehr) im recording-Status → Block ist nicht mehr
          // zustellbar; aufräumen statt ewig wieder versuchen.
        }
        await reqDone(tx(db, "chunks", "readwrite").delete(range));
        await reqDone(tx(db, "blocks", "readwrite").delete(meta.id));
        uploaded += 1;
      } catch {
        failed += 1; // Netz wieder weg o. Ä. → Block bleibt, nächster Flush versucht erneut
      }
    }
    return { uploaded, failed };
  }
}
