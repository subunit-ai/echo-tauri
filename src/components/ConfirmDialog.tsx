import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Style the confirm button as a destructive action (red). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * On-brand confirmation popup (glass card + dimmed backdrop). The Tauri webview has
 * no native window.confirm (it no-ops), so destructive actions that warrant a clear
 * "are you sure?" — like signing out — use this instead of acting on a single click.
 * Esc / backdrop-click cancels; Enter confirms; the confirm button is auto-focused.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    // Focus the confirm button so Enter works and the dialog reads as modal.
    confirmRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title">{title}</h3>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button className="confirm-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={`confirm-btn ${destructive ? "danger" : "primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
