// The app and the onboarding pipeline read intake measurements with ONE parser.
//
// This file is a re-export, not a port. Two implementations of "what does 210.7 mean"
// would eventually disagree, and the way they would announce it is a client being fed
// against a number from the other copy. The module it points at is pure TypeScript with no
// imports and no Deno APIs, so Vite transpiles it like any other source file.
//
// Authority: supabase/functions/_shared/units.ts (moved from intake-onboard/ when that
// pipeline was retired, Slice 4, 2026-09-07 — the parser outlived the function).
export {
  CM_PER_IN,
  inToCm,
  KG_PER_LB,
  lbToKg,
  parseAge,
  parseGoalWeightLb,
  parseHeightIn,
  parseWeightLb,
} from "../../supabase/functions/_shared/units.ts";
