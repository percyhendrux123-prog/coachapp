import { useEffect } from "react";
import { Link } from "react-router-dom";
import { STANDARD_LINE } from "../lib/systemMode";

// Self-serve plan landing with one action.
export default function System() {
  // Tab title + share preview belong to this page, not the tenant shell. Restored on leave.
  useEffect(() => {
    const prev = document.title;
    document.title = "Self-serve plan — a week built from your numbers.";
    return () => { document.title = prev; };
  }, []);

  return (
    <main className="mx-auto max-w-md px-5 py-16 md:py-24">
      <span className="kicker">SELF-SERVE PLAN</span>
      <h1 className="display mt-3 text-4xl md:text-5xl">A week built<br />from your numbers.</h1>
      <p className="mt-5 text-sm leading-relaxed opacity-80">
        Answer a short health screen and an intake. You get a real training week and real nutrition targets, calculated from your own sex, age, height, weight, goal, and training days. Then you log against it. Sets, weight, reps, meals, a weekly check-in.
      </p>
      <ul className="mt-6 space-y-2 text-sm opacity-80">
        <li>Seven days. Training days and rest days. Real exercises, sets and reps.</li>
        <li>Calories and protein, fat, carbs from your numbers. A meal structure filled from the app library.</li>
        <li>Rest timer, last-time ghost text, day swaps, progress trends.</li>
        <li>Optional: connect your own AI and let it rewrite your plan by talking to it.</li>
      </ul>
      <p className="mt-6 text-sm font-semibold">Review your plan price at checkout.</p>
      <Link to="/system/start" className="btn-primary mt-6 block py-3 text-center text-base">Start the health screen</Link>
      <p className="mt-8 border-t border-ink/10 pt-5 text-sm opacity-70">{STANDARD_LINE}</p>
      <p className="mt-6 text-xs opacity-50">This is fitness structure, not medical care. Anyone with a flagged health screen is not charged and is pointed to coaching instead.</p>
    </main>
  );
}
