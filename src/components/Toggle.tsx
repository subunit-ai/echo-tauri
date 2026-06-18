export function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`toggle ${checked ? "on" : ""}${disabled ? " disabled" : ""}`}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="thumb" />
    </button>
  );
}
