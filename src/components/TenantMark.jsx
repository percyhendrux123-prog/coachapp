// Uploaded tenant logos win; only the owner uses the neutral fallback mark.

export function BrandMark({ className = "h-6 w-6" }) {
  return (
    <img
      src="/icons/mark.svg"
      alt=""
      className={`shrink-0 rounded-xl ${className}`}
    />
  );
}

export default function TenantMark({ brand, owner = false, className = "h-6 w-6" }) {
  if (brand?.logo_url) {
    return (
      <img
        src={brand.logo_url}
        alt=""
        className={`shrink-0 rounded-xl object-cover ${className}`}
      />
    );
  }
  if (owner) return <BrandMark className={className} />;
  return <span className={`shrink-0 rounded-xl bg-ink/5 ${className}`} aria-hidden />;
}
