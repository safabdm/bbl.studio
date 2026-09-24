type MarkVariant = 'white' | 'black';

export function BblsMark({ size = 24, variant = 'white' }: { size?: number; variant?: MarkVariant }) {
  return (
    <img
      src={variant === 'black' ? '/brand/bbl-mark-black.png' : '/brand/bbl-mark-white.png'}
      alt=""
      width={size}
      height={size}
      decoding="async"
      className="brand-mark"
    />
  );
}

export function BblWordmark({ height = 34, variant = 'white' }: { height?: number; variant?: MarkVariant }) {
  return (
    <img
      src={variant === 'black' ? '/brand/bbl-wordmark-black.png' : '/brand/bbl-wordmark-white.png'}
      alt="BBL Studio"
      width={Math.round(height * 3.2)}
      height={height}
      decoding="async"
      fetchPriority={height >= 40 ? 'high' : 'auto'}
      className="brand-wordmark"
      style={{ height, width: 'auto' }}
    />
  );
}
