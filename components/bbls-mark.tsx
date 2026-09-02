export function BblsMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="brand-mark"
    >
      <path
        d="M12 2.35 20.4 7.2v9.6L12 21.65 3.6 16.8V7.2L12 2.35Z"
        fill="#0A0A0A"
        stroke="#FFFFFF"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M9.05 7.65v8.8M9.05 7.65h2.95a2.1 2.1 0 0 1 0 4.2H9.05M9.05 11.85h3.3a2.3 2.3 0 0 1 0 4.6"
        stroke="#F7F9FF"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="14.7" y="15.35" width="1.9" height="1.9" rx="0.25" fill="#FFFFFF" />
    </svg>
  );
}
