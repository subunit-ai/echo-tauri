// Echo brand mark — 5 voice-meter bars inside 2 concentric "echo" rings (cyan).
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="16" cy="16" r="14" stroke="#22d3ee" strokeWidth="1.4" opacity="0.3" />
      <circle cx="16" cy="16" r="9.5" stroke="#22d3ee" strokeWidth="1.4" opacity="0.55" />
      <g fill="#22d3ee">
        <rect x="8" y="13" width="2" height="6" rx="1" />
        <rect x="11.5" y="10" width="2" height="12" rx="1" />
        <rect x="15" y="7.5" width="2" height="17" rx="1" />
        <rect x="18.5" y="10" width="2" height="12" rx="1" />
        <rect x="22" y="13" width="2" height="6" rx="1" />
      </g>
    </svg>
  );
}
