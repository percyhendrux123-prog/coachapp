import Screen from "./Screen";
import { PARQ_QUESTIONS } from "../content/parqQuestions";

// Fixture preview of the health screen + waiver page: fictional client, no network, nothing
// saved anywhere but this browser. Exists only in dev and `npm run build:preview` builds
// (PREVIEW_ROUTES_ENABLED); production tree-shakes this module out.
const FIXTURE_API = {
  peek: async () => ({ status: "pending", display_name: "Alex Demo" }),
  submit: async ({ answers }) => {
    await new Promise((r) => setTimeout(r, 400));
    const flagged = PARQ_QUESTIONS.some((q) => answers[q.field] === true) || !!answers.medications;
    return { status: flagged ? "screen_review" : "screen_complete" };
  },
};

export default function ScreenPreview() {
  return <Screen api={FIXTURE_API} fixedToken="preview-fixture-screen-token" />;
}
