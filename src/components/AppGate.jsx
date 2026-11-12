import { Link } from "react-router-dom";

/**
 * Shared blocked / empty / not-found shell for public and signed-out paths.
 * Glass card + display title so dead links and auth walls feel intentional,
 * not a single gray sentence on bare paper.
 */
export default function AppGate({
  kicker = "COACH APP",
  title,
  children,
  actionTo,
  actionLabel,
  secondaryTo,
  secondaryLabel,
}) {
  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <div className="glass p-6 sm:p-8">
        {kicker ? <span className="kicker">{kicker}</span> : null}
        <h1 className={`display text-2xl sm:text-3xl ${kicker ? "mt-2" : ""}`}>{title}</h1>
        {children != null && children !== "" && (
          <div className="mt-3 text-sm leading-relaxed opacity-70">{children}</div>
        )}
        {(actionTo && actionLabel) || (secondaryTo && secondaryLabel) ? (
          <div className="mt-6 flex flex-wrap items-center gap-2">
            {actionTo && actionLabel ? (
              <Link
                to={actionTo}
                className="btn-primary inline-flex min-h-[44px] items-center px-4"
              >
                {actionLabel}
              </Link>
            ) : null}
            {secondaryTo && secondaryLabel ? (
              <Link
                to={secondaryTo}
                className="btn-ghost inline-flex min-h-[44px] items-center px-4"
              >
                {secondaryLabel}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
