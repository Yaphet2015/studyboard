/** The 「我能解释」 seal: the round-cap A from the app icon on a vermilion rounded square. */
export const Seal = ({ size = 26, light = false, outline = false }: { size?: number; light?: boolean; outline?: boolean }) =>
  outline ? (
    // 摸底「已会」: the same stamp, outlined in currentColor so it never reads as a filled/hollow dot.
    <svg className="seal seal-known" width={size} height={size} viewBox="-50 -50 100 100" aria-hidden="true">
      <rect x="-44" y="-44" width="88" height="88" rx="24" fill="none" stroke="currentColor" strokeWidth="8" />
      <path d="M-20 26 L0 -26 L20 26" fill="none" stroke="currentColor" strokeWidth="9.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M-24 9 H24" stroke="currentColor" strokeWidth="7.5" strokeLinecap="round" />
    </svg>
  ) : (
  <svg
    className={`seal ${light ? "light" : ""}`}
    width={size}
    height={size}
    viewBox="-50 -50 100 100"
    role="img"
    aria-label={light ? "你已经会了（摸底推断）" : "我能解释"}
  >
    <rect x="-46" y="-46" width="92" height="92" rx="24" fill="var(--accent)" />
    <rect
      x="-46"
      y="-46"
      width="92"
      height="92"
      rx="24"
      fill="none"
      stroke="rgba(255,255,255,.28)"
      strokeWidth="3"
    />
    <path
      d="M-20 26 L0 -26 L20 26"
      fill="none"
      stroke="#FFF8F0"
      strokeWidth="9.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M-24 9 H24"
      stroke="#FFF8F0"
      strokeWidth="7.5"
      strokeLinecap="round"
    />
  </svg>
);
