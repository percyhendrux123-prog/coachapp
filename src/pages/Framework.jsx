import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import FrameworkMedia from "../components/FrameworkMedia";

// Keep existing resource routes available for the owner's own content.
const PAGES = Object.fromEntries([
  ["appetite-framework", "Nutrition"],
  ["system-framework", "Planning"],
  ["structure-framework", "Training structure"],
  ["standard-framework", "Daily standards"],
  ["declassified-identity-scripting", "Coaching resource"],
].map(([slug, title]) => [slug, {
  kicker: "Resource placeholder",
  title,
  why: "The app owner can add their own coaching content here.",
  body: ["No resource has been published yet. Add your own explanation and optional video before sharing this page with clients."],
  video: "",
}]));

export default function Framework() {
  const { slug } = useParams();
  const page = PAGES[slug];

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [slug]);

  if (!page) {
    return (
      <main className="mx-auto max-w-2xl px-5 py-10">
        <span className="kicker">Content</span>
        <h1 className="display mt-2 text-3xl">Page not found</h1>
        <p className="mt-3 text-sm opacity-70">There is no resource at this address. Check the link, or go back to your content.</p>
        <Link to="/client" className="btn-primary mt-6 inline-flex min-h-[44px] items-center px-4">
          Back
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-5 pb-16 pt-8 md:py-14">
      <Link to="/client?tab=content" className="text-sm opacity-60 underline-offset-4 hover:underline hover:opacity-100">
        Back
      </Link>
      <span className="kicker mt-6 block">{page.kicker}</span>
      <h1 className="display mt-2 text-2xl sm:text-4xl md:text-5xl">{page.title}</h1>
      <p className="mt-3 max-w-[46ch] text-sm leading-relaxed opacity-70">{page.why}</p>

      {page.video ? (
        <FrameworkMedia url={page.video} className="mx-auto mt-8 aspect-[9/16] max-h-[28rem] w-full max-w-sm" />
      ) : (
        <div className="mt-8 rounded-xl border border-dashed border-ink/20 px-4 py-8 text-center text-sm opacity-55">
          The app owner can add a video here.
        </div>
      )}

      <div className="mt-8 space-y-4 text-sm leading-relaxed opacity-80">
        {page.body.map((p) => (
          <p key={p.slice(0, 24)}>{p}</p>
        ))}
      </div>

      <p className="mt-10">
        <Link to="/client" className="text-sm opacity-60 underline-offset-4 hover:underline hover:opacity-100">
          Back
        </Link>
      </p>
    </main>
  );
}
