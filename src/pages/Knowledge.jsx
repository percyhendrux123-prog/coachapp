import { useEffect } from "react";
import { Link } from "react-router-dom";
import { neutralBrand } from "../lib/whiteLabelPolicy";

export default function Knowledge() {
  useEffect(() => {
    const prev = document.title;
    document.title = `Knowledge — ${neutralBrand().appName}`;
    return () => { document.title = prev; };
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-5 py-10 md:py-14">
      <span className="kicker">Knowledge</span>
      <h1 className="display mt-2 text-4xl md:text-5xl">Your knowledge library</h1>
      <p className="mt-3 max-w-[42ch] text-sm leading-relaxed opacity-70">
        No articles have been published yet.
      </p>
      <section className="mt-8 glass p-4" aria-label="Knowledge placeholder">
        <h2 className="display text-xl">Add your own content</h2>
        <p className="mt-2 text-sm leading-relaxed opacity-70">
          The app owner can replace this placeholder with their own educational resources and guidance for clients.
        </p>
      </section>
      <p className="mt-4">
        <Link to="/" className="text-sm opacity-60 underline-offset-4 hover:underline hover:opacity-100">
          Back
        </Link>
      </p>
    </main>
  );
}
