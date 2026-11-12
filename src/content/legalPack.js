// Client-facing legal pack (implementation). Versioned so intake can record what was accepted.
// Not a substitute for counsel review — the owner should have a lawyer sign off before
// high-volume onboarding. Tone: plain, calm, no medical practice claims.

export const LEGAL_VERSION = "2026-08-06";

export const LEGAL_DOCS = [
  {
    id: "medical_disclaimer",
    title: "Medical disclaimer",
    summary: "This is coaching, not medical care.",
    body: `This platform and your coach provide fitness and lifestyle coaching only.

Nothing here is medical advice, diagnosis, treatment, or a substitute for care from a licensed physician, dietitian, or other qualified clinician. Your coach is not acting as a licensed dietitian or healthcare provider unless they separately hold and disclose that license outside this app.

If you have a medical condition, take medication, are pregnant, or have any doubt about whether exercise or nutrition changes are safe for you, get clearance from a qualified professional before you start.

Stop training and seek care if you feel chest pain, severe dizziness, unusual shortness of breath, or any other warning sign.`,
  },
  {
    id: "parq",
    title: "Health readiness (PAR-Q style)",
    summary: "You confirm you are ready to train, or you will get medical clearance.",
    body: `Before starting a new exercise program, answer these honestly. If you answer YES to any, get medical clearance before training hard:

1. Has a doctor ever said you have a heart condition or should only do physical activity recommended by a doctor?
2. Do you feel pain in your chest when you do physical activity?
3. In the past month, have you had chest pain when you were not doing physical activity?
4. Do you lose your balance because of dizziness or do you ever lose consciousness?
5. Do you have a bone or joint problem that could be made worse by a change in physical activity?
6. Is your doctor currently prescribing drugs for blood pressure or a heart condition?
7. Do you know of any other reason why you should not do physical activity?

By signing, you either (a) answered NO to all, or (b) answered YES to one or more and will obtain medical clearance before following any program built from this intake.`,
  },
  {
    id: "informed_consent",
    title: "Informed consent — training & nutrition",
    summary: "You understand risks and your responsibilities.",
    body: `Physical training and dietary change carry risks, including but not limited to muscle soreness, injury, fatigue, and, rarely, more serious events.

You agree to:
- Provide honest health and training information
- Follow form and load progressions reasonably
- Stop and report pain that is not normal training discomfort
- Tell your coach about new injuries, illnesses, or medication changes

Nutrition guidance is educational coaching. Results vary. No specific body-composition outcome is guaranteed.`,
  },
  {
    id: "assumption_of_risk",
    title: "Assumption of risk & waiver",
    summary: "You accept training risks and release the coach and platform within the law.",
    body: `You voluntarily participate in coaching programs delivered through this application.

To the fullest extent allowed by law, you assume the risks of participation and release and hold harmless the coach, the coach’s business, and the platform operator from claims arising from ordinary negligence related to your use of programs, content, and recommendations — except where the law does not allow such a release (including gross negligence or willful misconduct where those limits apply).

This does not waive rights that cannot be waived under the law of your jurisdiction.`,
  },
  {
    id: "coaching_agreement",
    title: "Coaching relationship",
    summary: "How coaching works in this app.",
    body: `Your coach designs training and nutrition structure for you. You own the work of executing it.

The coach may adjust programs based on check-ins, messages, and adherence. You may message your coach according to the features your coach enables.

Access depends on your coach’s account remaining active on the platform. If hosting is paused, some updates may stop until the coach reactivates.

You will not share login access or invite tokens. Content in the app is for your personal use as a client of this coach.`,
  },
  {
    id: "privacy",
    title: "Privacy notice",
    summary: "What we store and who sees it.",
    body: `We store account data, intake answers, training logs, check-ins, messages, and related coaching records needed to run the service.

Your coach (and any staff they authorize inside their tenant) can see data for clients on their roster. Platform operators may access data only as needed to operate, secure, and support the service, or as required by law.

Optional AI connectors: if you or your coach connect an external AI with a token, that AI receives only what the connector is allowed to read or send under the token’s scope. Conversations with that AI are between you and that provider.

You can request access or deletion of personal data through your coach; platform support may assist where required.

Do not submit someone else’s personal health information without authority.`,
  },
];

export function legalAcceptancePayload({ signature, acceptedIds }) {
  return {
    legal_version: LEGAL_VERSION,
    legal_signature: signature.trim(),
    legal_accepted_at: new Date().toISOString(),
    legal_docs: acceptedIds,
  };
}
