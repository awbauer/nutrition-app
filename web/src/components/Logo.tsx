/** Clem's mark: the clementine from the app icon, without its tile and plate. */
export function Logo(props: { size?: number; class?: string }) {
  const s = props.size ?? 28;
  return (
    <svg width={s} height={s} viewBox="96 56 312 340" class={props.class} aria-hidden="true">
      <defs>
        <radialGradient id="clem-peel" cx="0.36" cy="0.32" r="0.78">
          <stop offset="0" stop-color="#ffc35a" />
          <stop offset="0.45" stop-color="#ff8a1c" />
          <stop offset="0.85" stop-color="#e5590b" />
          <stop offset="1" stop-color="#b8420a" />
        </radialGradient>
        <linearGradient id="clem-leaf-a" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="#2f8f4e" />
          <stop offset="1" stop-color="#7fd36b" />
        </linearGradient>
        <linearGradient id="clem-leaf-b" x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stop-color="#26763f" />
          <stop offset="1" stop-color="#5fbf5c" />
        </linearGradient>
      </defs>
      <circle cx="236" cy="262" r="128" fill="url(#clem-peel)" />
      <ellipse cx="186" cy="204" rx="38" ry="24" fill="#fff" opacity="0.35" transform="rotate(-32 186 204)" />
      <ellipse cx="176" cy="196" rx="14" ry="8" fill="#fff" opacity="0.9" transform="rotate(-32 176 196)" />
      <path d="M246 142 C 244 126, 250 114, 260 106" stroke="#6b4a1e" stroke-width="10" fill="none" stroke-linecap="round" />
      <path d="M258 108 C 290 62, 362 52, 392 78 C 370 122, 302 140, 258 108 Z" fill="url(#clem-leaf-a)" />
      <path d="M254 110 C 222 72, 170 70, 150 92 C 172 124, 222 132, 254 110 Z" fill="url(#clem-leaf-b)" />
    </svg>
  );
}
