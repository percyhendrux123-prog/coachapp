// Fictional, in-memory transport. Never imported by the application.
export const ctx = { clientId: "demo-client", tenantId: "demo-tenant" };
export function createFixture() {
  const sets = [0, 1, 2].map((set_index) => ({ set_index, target_reps: "8–12" }));
  const days = [
    { day_id: "upper", label: "Upper body", kind: "training", groups: [{ type: "straight", exercises: [
      { exercise_id: "press", name: "Bench press", sets },
      { exercise_id: "row", name: "Cable row", sets },
    ] }] },
    { day_id: "cardio", label: "Conditioning", kind: "training", groups: [{ type: "straight", exercises: [
      { exercise_id: "bike", name: "Stationary bike", type: "cardio", sets: [{ set_index: 0 }], cardio: { target_duration_min: 15, target_distance_unit: "km" } },
    ] }] },
    { day_id: "rest", label: "Rest", kind: "rest", groups: [] },
  ];
  const fixture = {
    pack: { assignment: { id: "demo-assignment", current_day_index: 0 }, program: { name: "Fictional foundation block", structure: { days } } },
    messages: [], logs: [], writes: [], activities: [], reads: 0, session: null,
    failRead: false, failSend: false, failLog: false, sendWait: null, readWait: null,
    auth: { user: { id: "demo-coach" }, role: "coach", profile: { tenant_id: ctx.tenantId } },
  };
  fixture.client = {
    getMyProgram: async () => fixture.pack,
    listMessages: async () => {
      fixture.reads += 1;
      if (fixture.readWait) await fixture.readWait;
      if (fixture.failRead) throw new Error("Demo thread unavailable");
      return [...fixture.messages];
    },
    sendMessage: async (payload) => {
      fixture.writes.push({ kind: "message", ...payload });
      if (fixture.sendWait) await fixture.sendWait;
      if (fixture.failSend) throw new Error("Demo insert unavailable");
      fixture.messages.push({ id: `demo-message-${fixture.messages.length}`, client_id: payload.clientId, tenant_id: payload.tenantId, sender_role: "client", body: payload.body, sent_at: new Date().toISOString() });
    },
  };
  fixture.workouts = {
    getSession: async () => fixture.session,
    startSession: async () => { fixture.writes.push({ kind: "start" }); fixture.session = { id: "demo-session", status: "in_progress" }; return fixture.session; },
    listSessionLogs: async () => fixture.logs,
    getLastPerformance: async () => null,
    logSet: async (payload) => {
      fixture.writes.push({ kind: "log", ...payload });
      if (fixture.failLog) throw new Error("Demo workout save unavailable");
    },
    closeDay: async () => { throw new Error("Finish disabled in this fixture"); },
  };
  fixture.activity = { recordActivity: async (payload) => { fixture.activities.push(payload); } };
  fixture.coachClients = {
    getCoachInbox: async () => fixture.messages.length ? [{
      client_id: ctx.clientId, display_name: "Demo Client", unread_count: fixture.messages.length,
      last_body: fixture.messages.at(-1).body, last_sent_at: fixture.messages.at(-1).sent_at, last_sender_role: "client",
    }] : [],
    getClientMessages: async (clientId) => fixture.messages.filter((m) => m.client_id === clientId && m.tenant_id === ctx.tenantId),
    markThreadRead: async () => {},
  };
  return fixture;
}
