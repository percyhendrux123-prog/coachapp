import { useSearchParams } from "react-router-dom";
import AppGate from "../components/AppGate";

// P33: there is no payment to confirm any more. This page is "check your email". An old
// payment-return link (?session_id=…) is told plainly that the plan is free now.
export default function SystemWelcome() {
  const [params] = useSearchParams();
  if (params.get("session_id")) {
    return (
      <AppGate kicker="SELF-SERVE PLAN" title="This plan is free now." actionTo="/system/start" actionLabel="Get my link">
        Enter your email to get your link.
      </AppGate>
    );
  }
  return (
    <AppGate kicker="SELF-SERVE PLAN" title="Check your email." actionTo="/system/start" actionLabel="Send it again">
      Your intake link was emailed to you. Open it on this device. When the intake is done, sign in with the same address.
    </AppGate>
  );
}
