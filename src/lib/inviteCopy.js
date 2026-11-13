// The words that go out under the coach's own name, in their own mail client.
//
// Kept in one file, separate from the buttons, so the copy can be edited without touching
// the mailto encoding — and so what a client receives can be read in full in one place.
//
// VOICE. Calm, direct, no hype. No exclamation marks, no emoji, no marketing cadence. This
// is a coach writing to a client they already have, not an announcement. Short lines.
//
// NO SIGNATURE BLOCK, deliberately. The message leaves from the coach's real address, so
// their name and signature are already attached by their mail client. Adding a name here
// would either duplicate it or contradict it on a white-label tenant.
//
// Subjects avoid the brand name for the same white-label reason: this app is not always
// called OWNER, and a subject line is not worth a config round-trip to personalise.

import { firstName } from "./mailto.js";

const greeting = (name) => {
  const first = firstName(name);
  return first ? `${first},\n\n` : "";
};

// Account claim — the invite that gets a client into the app for the first time.
export function accountInviteEmail({ displayName, link }) {
  return {
    subject: "Your coaching app access",
    body:
      `${greeting(displayName)}` +
      `Your account is ready. Open this link to set it up:\n\n` +
      `${link}\n\n` +
      `Enter this same email address. You will get a sign-in code by email. ` +
      `Type the code in the app. Do not use a link from the email if one is there. ` +
      `There is no password to remember.\n\n` +
      `The link is good for 14 days. If it expires before you get to it, tell me and I will send a new one.\n\n` +
      `Your program, check-ins and messages all live in there from now on.`,
  };
}

// Intake form — the questionnaire that has to be filled in before programming starts.
export function intakeInviteEmail({ displayName, link }) {
  return {
    subject: "Your intake form",
    body:
      `${greeting(displayName)}` +
      `Before we go further, fill this out:\n\n` +
      `${link}\n\n` +
      `It takes about ten minutes. Answer it straight — the plan gets built off what you put in here, ` +
      `so a rounded-off answer costs you accuracy later.\n\n` +
      `The link is good for 14 days.`,
  };
}
