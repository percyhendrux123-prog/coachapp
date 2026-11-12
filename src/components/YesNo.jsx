// Two-button yes/no row. Shared by the coach intake and the SYSTEM pre-pay screen.
// `value` is true, false, or undefined (unanswered) — the server treats unanswered as
// missing, never as "no", so the button state must reflect exactly what was pressed.
export default function YesNo({ label, value, onChange }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/5 py-2 text-sm">
      <span className="max-w-[70%] opacity-80">{label}</span>
      <div className="flex gap-1.5">
        {[["No", false], ["Yes", true]].map(([t, v]) => (
          <button key={t} type="button" onClick={() => onChange(v)} aria-pressed={value === v}
            className={`min-h-[44px] rounded-xl px-3 py-2 text-xs font-semibold ${value === v ? "bg-ink text-paper" : "border border-ink/15"}`}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
