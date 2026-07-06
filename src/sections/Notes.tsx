import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { copyText, onSessionRestored } from "../lib/ipc";
import {
  deleteNote,
  deleteNoteFolder,
  displayText,
  FOLDER_COLORS,
  FOLDER_ICON_KEYS,
  FOLDER_ICONS,
  listNoteFolders,
  listNotes,
  makeNote,
  noteRecordCancel,
  noteRecordLevel,
  noteRecordStart,
  noteRecordStop,
  notesSyncNow,
  onNotesChanged,
  saveNote,
  saveNoteFolder,
  uuid,
  type NoteFolder,
  type NotePayload,
  type NoteRow,
} from "../lib/notes";
import { useToast } from "../state/ToastContext";
import { ConfirmDialog } from "../components/ConfirmDialog";

/** A folder as shown in the rail — either a real cosmetic row or one rebuilt from
 *  a note's denormalized folderId/folderName (reconcile, like iOS FoldersStore). */
interface RailFolder {
  id: string;
  name: string;
  icon: string;
  color: string;
  count: number;
}

function FolderGlyph({ icon, size = 14 }: { icon: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={FOLDER_ICONS[icon] ?? FOLDER_ICONS.folder} />
    </svg>
  );
}

function fmtDate(secsOrIso: number | string | undefined): string {
  if (secsOrIso == null) return "";
  const d = typeof secsOrIso === "number" ? new Date(secsOrIso * 1000) : new Date(secsOrIso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("de-DE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtDur(s: number): string {
  if (!s || s <= 0) return "";
  const total = Math.round(s); // round once, then split — avoids a ":60" carry
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function Notes() {
  const { t } = useTranslation();
  const toast = useToast();

  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null); // folderId | null = "Alle"
  const [copied, setCopied] = useState<string | null>(null);

  const [showRecord, setShowRecord] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [detail, setDetail] = useState<NoteRow | null>(null);
  const [editingFolder, setEditingFolder] = useState<RailFolder | "new" | null>(null);
  const [confirmDelNote, setConfirmDelNote] = useState<NoteRow | null>(null);
  const [confirmDelFolder, setConfirmDelFolder] = useState<RailFolder | null>(null);

  const refresh = useCallback(() => {
    listNotes().then(setNotes).catch(() => setNotes([]));
    listNoteFolders().then(setFolders).catch(() => setFolders([]));
  }, []);

  // Load + live-refresh on sync; sync on mount, on window focus, and after a
  // fresh sign-in — mirrors the iPhone's launch/foreground triggers so both stay
  // permanently in step.
  useEffect(() => {
    refresh();
    notesSyncNow().catch(() => {});
    const un = onNotesChanged(refresh);
    const unSess = onSessionRestored(() => notesSyncNow().catch(() => {}));
    const onFocus = () => notesSyncNow().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => {
      un.then((f) => f());
      unSess.then((f) => f());
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  // Keep the open detail view in sync with the freshest stored copy (a sync from
  // the phone could update it while it's open).
  useEffect(() => {
    if (!detail) return;
    const fresh = notes.find((n) => n.id === detail.id);
    if (fresh && fresh.updated_at !== detail.updated_at) setDetail(fresh);
    if (!fresh) setDetail(null); // deleted elsewhere
  }, [notes, detail]);

  // Folder rail: real cosmetic rows + any folder a note references but we have no
  // cosmetics for (reconcile — a folder created on the phone). Counts from notes.
  const rail: RailFolder[] = useMemo(() => {
    const byId = new Map<string, RailFolder>();
    for (const f of folders) byId.set(f.id, { id: f.id, name: f.name, icon: f.icon, color: f.color, count: 0 });
    for (const n of notes) {
      const fid = n.payload.folderId;
      if (!fid) continue;
      if (!byId.has(fid)) {
        byId.set(fid, {
          id: fid,
          name: n.payload.folderName || t("notes.untitledFolder"),
          icon: "folder",
          color: FOLDER_COLORS[0],
          count: 0,
        });
      }
      byId.get(fid)!.count++;
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [folders, notes, t]);

  // If the selected folder vanishes (deleted / all its notes unfiled on another
  // device, arriving via sync), fall back to "Alle" instead of showing an empty
  // list under a dead selection.
  useEffect(() => {
    if (selected && !rail.some((f) => f.id === selected)) setSelected(null);
  }, [rail, selected]);

  const activeFolder = rail.find((f) => f.id === selected) || null;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = notes;
    if (selected) list = list.filter((n) => n.payload.folderId === selected);
    if (q) {
      list = list.filter((n) => {
        const p = n.payload;
        return (
          (p.title || "").toLowerCase().includes(q) ||
          (p.rawText || "").toLowerCase().includes(q) ||
          (p.cleanedText?.toLowerCase().includes(q) ?? false) ||
          (p.tags?.some((tg) => tg.toLowerCase().includes(q)) ?? false)
        );
      });
    }
    return [...list].sort((a, b) => {
      const ap = a.payload.pinned ? 1 : 0;
      const bp = b.payload.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap; // pinned first
      return (b.payload.createdAt || "").localeCompare(a.payload.createdAt || ""); // newest first
    });
  }, [notes, selected, query]);

  const onCopy = useCallback(
    async (text: string, id: string) => {
      try {
        await copyText(text);
      } catch {
        toast(t("history.copyFailed"), "error");
        return;
      }
      toast(t("common.copied"), "success");
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    },
    [toast, t],
  );

  const persist = useCallback(
    async (payload: NotePayload) => {
      try {
        await saveNote(payload);
        refresh();
      } catch (e) {
        toast(String(e), "error");
      }
    },
    [refresh, toast],
  );

  const doDeleteNote = useCallback(
    async (n: NoteRow) => {
      try {
        await deleteNote(n.id);
        if (detail?.id === n.id) setDetail(null);
        refresh();
        toast(t("notes.deleted"), "success");
      } catch (e) {
        toast(String(e), "error");
      }
    },
    [detail, refresh, toast, t],
  );

  // Copy every note of a folder as one block (the "prompt collection → paste at PC").
  const copyFolder = useCallback(
    async (fid: string) => {
      const texts = notes
        .filter((n) => n.payload.folderId === fid)
        .sort((a, b) => (b.payload.createdAt || "").localeCompare(a.payload.createdAt || ""))
        .map((n) => displayText(n.payload));
      if (!texts.length) {
        toast(t("notes.folderEmpty"), "error");
        return;
      }
      try {
        await copyText(texts.join("\n\n———\n\n"));
        toast(t("notes.folderCopied"), "success");
      } catch {
        toast(t("history.copyFailed"), "error");
      }
    },
    [notes, toast, t],
  );

  const deleteFolder = useCallback(
    async (f: RailFolder) => {
      // Notes stay — they're just unfiled (folderId/folderName cleared), then the
      // cosmetics row is forgotten. Each unfiling syncs.
      const inFolder = notes.filter((n) => n.payload.folderId === f.id);
      for (const n of inFolder) {
        const p = { ...n.payload };
        delete p.folderId;
        delete p.folderName;
        await saveNote(p);
      }
      await deleteNoteFolder(f.id).catch(() => {});
      if (selected === f.id) setSelected(null);
      refresh();
      toast(t("notes.folderDeleted"), "success");
    },
    [notes, selected, refresh, toast, t],
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h1 className="section-title">{t("notes.title")}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="sub-tab" onClick={() => setShowManual(true)}>{t("notes.newNote")}</button>
          <button className="note-record-cta" onClick={() => setShowRecord(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4" />
            </svg>
            {t("notes.record")}
          </button>
        </div>
      </div>
      <p className="section-sub">{t("notes.sub")}</p>

      {/* Folder rail */}
      <div className="folder-rail">
        <FolderChip
          label={t("notes.all")} icon="tray" color="var(--accent, #06b6d4)" count={notes.length}
          active={selected === null} onClick={() => setSelected(null)}
        />
        {rail.map((f) => (
          <FolderChip
            key={f.id} label={f.name} icon={f.icon} color={f.color} count={f.count}
            active={selected === f.id} onClick={() => setSelected(f.id)}
            onEdit={() => setEditingFolder(f)}
            onCopyAll={() => copyFolder(f.id)}
            onDelete={() => setConfirmDelFolder(f)}
          />
        ))}
        <button className="folder-chip folder-chip-add" onClick={() => setEditingFolder("new")}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>+</span> {t("notes.folder")}
        </button>
      </div>

      {activeFolder && (
        <div className="folder-head" style={{ "--fc": activeFolder.color } as CSSProperties}>
          <span className="folder-head-icon" style={{ color: activeFolder.color }}>
            <FolderGlyph icon={activeFolder.icon} size={16} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="folder-head-name">{activeFolder.name}</div>
            <div className="folder-head-sub">{t("notes.folderRecordHint", { count: activeFolder.count })}</div>
          </div>
          <span style={{ flex: 1 }} />
          <button className="sub-tab" onClick={() => copyFolder(activeFolder.id)}>{t("notes.copyAll")}</button>
          <button className="sub-tab" onClick={() => setEditingFolder(activeFolder)}>{t("common.edit")}</button>
        </div>
      )}

      <input
        type="text" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder={t("notes.searchPlaceholder")} style={{ marginBottom: 14, maxWidth: 360 }}
      />

      {visible.length === 0 ? (
        <div className="empty">
          {query ? t("notes.noResults") : selected ? t("notes.folderIsEmpty") : t("notes.empty")}
        </div>
      ) : (
        visible.map((n) => {
          const text = displayText(n.payload);
          const fname = n.payload.folderName;
          const fcolor = rail.find((f) => f.id === n.payload.folderId)?.color;
          return (
            <div key={n.id} className="history-item note-card">
              <div className="note-card-head">
                {n.payload.pinned && <span className="note-pin" title={t("notes.pinned")}>★</span>}
                <span className="note-title" onClick={() => setDetail(n)}>{n.payload.title || t("notes.untitled")}</span>
                {selected === null && fname && (
                  <span className="note-folder-badge" style={{ color: fcolor, borderColor: fcolor }}>
                    <FolderGlyph icon={rail.find((f) => f.id === n.payload.folderId)?.icon || "folder"} size={11} />
                    {fname}
                  </span>
                )}
              </div>
              <div
                className={`text${copied === n.id ? " copied" : ""}`}
                onClick={() => onCopy(text, n.id)}
                title={t("history.clickToCopy")}
              >
                {text}
              </div>
              <div className="meta" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span>{fmtDate(n.payload.createdAt)}</span>
                {n.payload.duration > 0 && <span>{fmtDur(n.payload.duration)}</span>}
                {n.payload.tags?.map((tg) => <span key={tg} className="note-tag">#{tg}</span>)}
                <span style={{ flex: 1 }} />
                <button className="sub-tab" onClick={() => setDetail(n)}>{t("notes.open")}</button>
                <button className="sub-tab" onClick={() => onCopy(text, n.id)}>
                  {copied === n.id ? t("common.copied") : t("common.copy")}
                </button>
                <button className="sub-tab" onClick={() => setConfirmDelNote(n)}>{t("common.delete")}</button>
              </div>
            </div>
          );
        })
      )}

      {showRecord && (
        <RecordModal
          folder={activeFolder}
          onClose={() => setShowRecord(false)}
          onSaved={() => { setShowRecord(false); refresh(); }}
          toastErr={(m) => toast(m, "error")}
        />
      )}
      {showManual && (
        <ManualModal
          folder={activeFolder}
          onClose={() => setShowManual(false)}
          onSave={async (title, text) => {
            await persist(makeNote({
              title, rawText: text, cleanedText: text, duration: 0,
              folderId: activeFolder?.id, folderName: activeFolder?.name,
            }));
            setShowManual(false);
          }}
        />
      )}
      {detail && (
        <NoteDetail
          note={detail} folders={rail}
          onClose={() => setDetail(null)}
          onCopy={(text) => onCopy(text, detail.id)}
          copied={copied === detail.id}
          onSave={persist}
          onDelete={() => setConfirmDelNote(detail)}
        />
      )}
      {editingFolder && (
        <FolderEditor
          folder={editingFolder === "new" ? null : editingFolder}
          onClose={() => setEditingFolder(null)}
          onSave={async (name, icon, color) => {
            if (editingFolder === "new") {
              const id = uuid();
              await saveNoteFolder(id, name, icon, color, rail.length);
              setSelected(id);
            } else {
              await saveNoteFolder(editingFolder.id, name, icon, color, 0);
              // Propagate the (possibly new) name onto every note in the folder.
              const inFolder = notes.filter((n) => n.payload.folderId === editingFolder.id);
              for (const n of inFolder) {
                if (n.payload.folderName !== name) await saveNote({ ...n.payload, folderName: name });
              }
            }
            setEditingFolder(null);
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelNote} title={t("notes.deleteTitle")} message={t("notes.deleteMsg")}
        confirmLabel={t("common.delete")} cancelLabel={t("common.cancel")} destructive
        onConfirm={() => { if (confirmDelNote) doDeleteNote(confirmDelNote); setConfirmDelNote(null); }}
        onCancel={() => setConfirmDelNote(null)}
      />
      <ConfirmDialog
        open={!!confirmDelFolder} title={t("notes.deleteFolderTitle")} message={t("notes.deleteFolderMsg")}
        confirmLabel={t("notes.deleteFolderConfirm")} cancelLabel={t("common.cancel")} destructive
        onConfirm={() => { if (confirmDelFolder) deleteFolder(confirmDelFolder); setConfirmDelFolder(null); }}
        onCancel={() => setConfirmDelFolder(null)}
      />
    </div>
  );
}

// ── Folder chip ──────────────────────────────────────────────────────────────

function FolderChip({
  label, icon, color, count, active, onClick, onEdit, onCopyAll, onDelete,
}: {
  label: string; icon: string; color: string; count: number; active: boolean;
  onClick: () => void; onEdit?: () => void; onCopyAll?: () => void; onDelete?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="folder-chip-wrap" onMouseLeave={() => setMenu(false)}>
      <button
        className={`folder-chip${active ? " active" : ""}`}
        style={{ "--fc": color } as CSSProperties}
        onClick={onClick}
        onContextMenu={onEdit ? (e) => { e.preventDefault(); setMenu((m) => !m); } : undefined}
      >
        <span className="folder-chip-icon"><FolderGlyph icon={icon} size={13} /></span>
        <span className="folder-chip-label">{label}</span>
        <span className="folder-chip-count">{count}</span>
      </button>
      {menu && onEdit && (
        <div className="folder-menu" onClick={() => setMenu(false)}>
          <button onClick={onEdit}>✎</button>
          <button onClick={onCopyAll}>⧉</button>
          <button className="danger" onClick={onDelete}>🗑</button>
        </div>
      )}
    </div>
  );
}

// ── Record modal ─────────────────────────────────────────────────────────────

function RecordModal({
  folder, onClose, onSaved, toastErr,
}: {
  folder: RailFolder | null; onClose: () => void; onSaved: () => void; toastErr: (m: string) => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"starting" | "recording" | "transcribing" | "error">("starting");
  const [level, setLevel] = useState(0);
  const [secs, setSecs] = useState(0);
  const started = useRef(false);
  const stopping = useRef(false);
  const done = useRef(false); // recording was cleanly stopped or cancelled

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    noteRecordStart()
      .then(() => setPhase("recording"))
      .catch((e) => { done.current = true; setPhase("error"); toastErr(t("notes.recordFailed") + " (" + String(e) + ")"); });
  }, [t, toastErr]);

  // Safety net: if the modal is torn down while still recording (e.g. the user
  // switches sidebar sections mid-take), cancel so the mic + the session guard
  // are released instead of stranded. No-op once stop/cancel already ran.
  useEffect(() => () => { if (!done.current) noteRecordCancel().catch(() => {}); }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const lv = window.setInterval(() => { noteRecordLevel().then(setLevel).catch(() => {}); }, 66);
    const tm = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => { window.clearInterval(lv); window.clearInterval(tm); };
  }, [phase]);

  const stop = async () => {
    if (stopping.current) return;
    stopping.current = true;
    done.current = true; // we own the recorder teardown now
    setPhase("transcribing");
    try {
      const r = await noteRecordStop();
      const p = makeNote({
        rawText: r.raw_text,
        cleanedText: r.cleaned_text || undefined,
        duration: r.duration_s,
        language: r.language || undefined,
        folderId: folder?.id, folderName: folder?.name,
      });
      await saveNote(p);
      onSaved();
    } catch (e) {
      toastErr(t("notes.transcribeFailed") + " (" + String(e) + ")");
      onClose();
    }
  };
  const cancel = async () => { done.current = true; await noteRecordCancel().catch(() => {}); onClose(); };

  const mm = Math.floor(secs / 60);
  const ss = (secs % 60).toString().padStart(2, "0");
  const scale = 1 + Math.min(level, 1) * 0.5;

  return (
    <div className="modal-backdrop" onClick={phase === "recording" ? undefined : cancel}>
      <div className="modal-card note-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-title">
          {folder ? t("notes.recordInto", { name: folder.name }) : t("notes.recordTitle")}
        </h3>
        <div className="rec-stage">
          <div className="rec-orb" style={{ transform: `scale(${scale})` }} />
          {phase === "transcribing" ? (
            <div className="rec-status">{t("notes.transcribing")}…</div>
          ) : (
            <div className="rec-timer">{mm}:{ss}</div>
          )}
        </div>
        <div className="confirm-actions">
          <button className="confirm-btn" onClick={cancel} disabled={phase === "transcribing"}>
            {t("common.cancel")}
          </button>
          <button className="confirm-btn primary" onClick={stop} disabled={phase !== "recording"}>
            {t("notes.stopSave")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Manual (typed) note modal ────────────────────────────────────────────────

function ManualModal({
  folder, onClose, onSave,
}: {
  folder: RailFolder | null; onClose: () => void; onSave: (title: string, text: string) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card note-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-title">
          {folder ? t("notes.newNoteInto", { name: folder.name }) : t("notes.newNoteTitle")}
        </h3>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder={t("notes.titlePlaceholder")} style={{ marginBottom: 10 }} />
        <textarea className="note-textarea" value={text} onChange={(e) => setText(e.target.value)}
          placeholder={t("notes.textPlaceholder")} rows={7} autoFocus />
        <div className="confirm-actions">
          <button className="confirm-btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="confirm-btn primary" disabled={!text.trim()}
            onClick={() => onSave(title, text)}>{t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}

// ── Note detail ──────────────────────────────────────────────────────────────

function NoteDetail({
  note, folders, onClose, onCopy, copied, onSave, onDelete,
}: {
  note: NoteRow; folders: RailFolder[]; onClose: () => void;
  onCopy: (text: string) => void; copied: boolean;
  onSave: (p: NotePayload) => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const p = note.payload;
  const hasCleaned = !!(p.cleanedText && p.cleanedText.trim());
  const [showRaw, setShowRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayText(p));
  const [title, setTitle] = useState(p.title);
  const [tagInput, setTagInput] = useState((p.tags ?? []).join(", "));

  // Reset the local edit buffers only when a DIFFERENT note is opened — NOT on
  // every payload change. `p` changes on every save/sync round-trip (the parent
  // re-feeds the fresh note); keying on `p` would wipe whatever the user is
  // currently typing. The read-only display below reads `p` directly, so remote
  // updates still show live; only the in-progress edit buffers are protected.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDraft(displayText(p));
    setTitle(p.title);
    setTagInput((p.tags ?? []).join(", "));
  }, [note.id]);

  const text = showRaw ? p.rawText : displayText(p);

  const saveEdit = () => {
    const next: NotePayload = { ...p, cleanedText: draft };
    onSave(next);
    setEditing(false);
  };
  const saveTags = (raw: string) => {
    const tags = Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)));
    onSave({ ...p, tags: tags.length ? tags : undefined });
  };
  const setFolder = (fid: string | null) => {
    const next = { ...p };
    if (fid) { next.folderId = fid; next.folderName = folders.find((f) => f.id === fid)?.name; }
    else { delete next.folderId; delete next.folderName; }
    onSave(next);
  };
  const togglePin = () => onSave({ ...p, pinned: !p.pinned });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card note-detail" onClick={(e) => e.stopPropagation()}>
        <div className="note-detail-head">
          <input className="note-detail-title" value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { if (title.trim() !== p.title) onSave({ ...p, title: title.trim() }); }}
            placeholder={t("notes.untitled")} />
          <button className="icon-btn" onClick={togglePin} title={t("notes.pin")}>{p.pinned ? "★" : "☆"}</button>
          <button className="icon-btn" onClick={onClose} title={t("common.cancel")}>✕</button>
        </div>

        <div className="note-detail-meta">
          <span>{fmtDate(p.createdAt)}</span>
          {p.duration > 0 && <span>· {fmtDur(p.duration)}</span>}
          {p.language && <span>· {p.language.toUpperCase()}</span>}
          {hasCleaned && (
            <button className="sub-tab" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? t("notes.showCleaned") : t("notes.showRaw")}
            </button>
          )}
        </div>

        {editing ? (
          <textarea className="note-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} rows={9} autoFocus />
        ) : (
          <div className="note-detail-body" onClick={() => onCopy(text)} title={t("history.clickToCopy")}>
            {text}
          </div>
        )}

        <div className="note-detail-row">
          <label className="note-detail-label">{t("notes.folderLabel")}</label>
          <select value={p.folderId ?? ""} onChange={(e) => setFolder(e.target.value || null)}>
            <option value="">{t("notes.noFolder")}</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="note-detail-row">
          <label className="note-detail-label">{t("notes.tagsLabel")}</label>
          <input type="text" value={tagInput} onChange={(e) => setTagInput(e.target.value)}
            onBlur={() => saveTags(tagInput)} placeholder={t("notes.tagsPlaceholder")} />
        </div>

        <div className="confirm-actions" style={{ justifyContent: "space-between" }}>
          <button className="confirm-btn danger" onClick={onDelete}>{t("common.delete")}</button>
          <div style={{ display: "flex", gap: 8 }}>
            {editing ? (
              <>
                <button className="confirm-btn" onClick={() => { setDraft(displayText(p)); setEditing(false); }}>{t("common.cancel")}</button>
                <button className="confirm-btn primary" onClick={saveEdit}>{t("common.save")}</button>
              </>
            ) : (
              <>
                <button className="confirm-btn" onClick={() => setEditing(true)}>{t("common.edit")}</button>
                <button className="confirm-btn primary" onClick={() => onCopy(text)}>
                  {copied ? t("common.copied") : t("common.copy")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Folder editor ────────────────────────────────────────────────────────────

function FolderEditor({
  folder, onClose, onSave,
}: {
  folder: RailFolder | null; onClose: () => void; onSave: (name: string, icon: string, color: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(folder?.name ?? "");
  const [icon, setIcon] = useState(folder?.icon ?? "folder");
  const [color, setColor] = useState(folder?.color ?? FOLDER_COLORS[0]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card note-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-title">{folder ? t("notes.editFolder") : t("notes.newFolder")}</h3>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)}
          placeholder={t("notes.folderNamePlaceholder")} autoFocus style={{ marginBottom: 12 }} />
        <div className="picker-label">{t("notes.icon")}</div>
        <div className="icon-grid">
          {FOLDER_ICON_KEYS.map((k) => (
            <button key={k} className={`icon-swatch${icon === k ? " active" : ""}`}
              style={{ "--fc": color } as CSSProperties} onClick={() => setIcon(k)}>
              <FolderGlyph icon={k} size={16} />
            </button>
          ))}
        </div>
        <div className="picker-label">{t("notes.color")}</div>
        <div className="color-grid">
          {FOLDER_COLORS.map((c) => (
            <button key={c} className={`color-swatch${color === c ? " active" : ""}`}
              style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
          ))}
        </div>
        <div className="confirm-actions">
          <button className="confirm-btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="confirm-btn primary" disabled={!name.trim()}
            onClick={() => onSave(name.trim(), icon, color)}>{t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}
