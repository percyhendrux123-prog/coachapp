import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { submitIntake } from "../lib/intake";
import AppGate from "../components/AppGate";
import YesNo from "../components/YesNo";
import { COACHING_APPLICATION_URL, copyFor } from "../lib/systemMode";
import { LEGAL_DOCS, LEGAL_VERSION, legalAcceptancePayload } from "../content/legalPack";
import { inToCm, lbToKg } from "../lib/intakeUnits";
import { PARQ_QUESTIONS } from "../content/parqQuestions";

// Consultation / onboarding intake. Public: ?token=… (coach invite, or a self-serve plan
// buyer's token from system-provision). The old ?session_id= mode is gone (server dropped
// it 2026-07-22).
// Body metrics + legal acceptance are required so the plan generator never invents sex/height/weight.

const GOALS = [
  ["fat_loss", "Lose fat"], ["muscle_gain", "Build muscle"],
  ["recomp", "Recomposition (both)"], ["maintain", "Maintain / general health"],
];
const EQUIPMENT = [
  ["full_gym", "Full gym access"], ["home_basic", "Home setup (dumbbells, bands)"], ["bodyweight", "Bodyweight only"],
];
const EXPERIENCE = [
  ["beginner", "Beginner (< 1 year)"], ["intermediate", "Intermediate (1–3 years)"], ["advanced", "Advanced (3+ years)"],
];
const INJURY_OPTIONS = [
  ["none", "None"], ["knee", "Knee"], ["shoulder", "Shoulder"],
  ["lower_back", "Lower back"], ["elbow", "Elbow"], ["wrist", "Wrist"],
];
const SEX = [["male", "Male"], ["female", "Female"]];
const UNITS = [["imperial", "Pounds & inches"], ["metric", "Kilograms & centimeters"]];

const FIELD = "w-full rounded-xl border border-ink/15 px-3 py-2.5 text-sm";
const LABEL = "mb-1 block text-sm font-medium";

export default function Intake() {
  const [params] = useSearchParams();
  const token = params.get("token");
  // Wording only. SYSTEM links carry &system=1 so a buyer never reads "your coach" on a
  // page that cannot yet know its tenant; every real decision is the server's, from the token.
  const mode = params.get("system") === "1" ? "self_serve" : "coached";
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (!token) {
    return (
      <AppGate
        title="This intake link isn’t valid"
        kicker="INTAKE"
        actionTo="/"
        actionLabel="Go home"
        secondaryTo="/login"
        secondaryLabel="Sign in"
      >
        Ask your coach for a fresh invite link. Old links expire and cannot be reused once they do.
      </AppGate>
    );
  }
  if (result) return <Result r={result} />;

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <span className="kicker">Intake</span>
      <h1 className="display mt-2 text-3xl">
        Let’s get you set up.
      </h1>
      <p className="mt-2 text-sm opacity-70">
        {copyFor(mode, "intake_intro")}{" "}
        Answer honestly. There are no wrong answers.
      </p>
      <p className="mt-2 text-xs opacity-55">
        This is fitness coaching, not medical care. See the legal section before you submit.
      </p>
      <IntakeForm
        busy={busy} err={err} mode={mode}
        onSubmit={async (answers) => {
          setErr(null); setBusy(true);
          try { setResult(await submitIntake({ token, answers })); }
          catch (e) { setErr(e.message); } finally { setBusy(false); }
        }}
      />
    </main>
  );
}

function IntakeForm({ onSubmit, busy, err, mode = "coached" }) {
  const [a, setA] = useState({
    injuries: [],
    unit_pref: "imperial",
    parq: {},
    legalOpen: null,
    legalChecked: {},
    signature: "",
  });
  const set = (k, v) => setA((s) => ({ ...s, [k]: v }));

  function toggleInjury(key) {
    setA((s) => {
      let next = s.injuries.includes(key) ? s.injuries.filter((i) => i !== key) : [...s.injuries, key];
      if (key === "none") next = next.includes("none") ? ["none"] : [];
      else next = next.filter((i) => i !== "none");
      return { ...s, injuries: next };
    });
  }

  function setParq(key, val) {
    // tristate: null = unanswered, true = yes, false = no
    setA((s) => ({ ...s, parq: { ...s.parq, [key]: val } }));
  }

  const allLegalChecked = LEGAL_DOCS.every((d) => a.legalChecked[d.id]);
  const imperial = a.unit_pref !== "metric";

  function submit(e) {
    e.preventDefault();
    if (!allLegalChecked || !a.signature?.trim()) {
      return;
    }

    // Convert body metrics to SI for the generator; keep raw strings for coach review.
    const age = Number(a.age);
    let height_cm;
    let weight_kg;
    let goal_weight_kg;
    let height_raw;
    let weight_raw;
    let goal_weight_raw;

    // Goal weight is optional — never invent a value when the client left it blank.
    const hasGoalWeight = a.goal_weight !== "" && a.goal_weight != null;

    if (imperial) {
      const ft = Number(a.height_ft);
      const inch = Number(a.height_in || 0);
      const totalIn = ft * 12 + inch;
      height_cm = inToCm(totalIn);
      weight_kg = lbToKg(Number(a.weight));
      goal_weight_kg = hasGoalWeight ? lbToKg(Number(a.goal_weight)) : undefined;
      height_raw = `${a.height_ft}'${a.height_in || 0}"`;
      weight_raw = `${a.weight} lb`;
      goal_weight_raw = hasGoalWeight ? `${a.goal_weight} lb` : undefined;
    } else {
      height_cm = Number(a.height_cm);
      weight_kg = Number(a.weight);
      goal_weight_kg = hasGoalWeight ? Number(a.goal_weight) : undefined;
      height_raw = `${a.height_cm} cm`;
      weight_raw = `${a.weight} kg`;
      goal_weight_raw = hasGoalWeight ? `${a.goal_weight} kg` : undefined;
    }

    const answers = {
      goal: a.goal,
      equipment: a.equipment,
      days_per_week: a.days_per_week,
      experience: a.experience,
      injuries: a.injuries.length ? a.injuries : ["none"],
      allergies: a.allergies || "",
      meals_per_day: a.meals_per_day || "",
      cardio_regimen: a.cardio_regimen || "",
      competition_history: a.competition_history || "",
      sex: a.sex,
      age,
      unit_pref: a.unit_pref,
      height_cm,
      weight_kg,
      goal_weight_kg,
      age_raw: String(a.age),
      height_raw,
      weight_raw,
      goal_weight_raw,
      parq_heart_condition: a.parq.heart,
      parq_chest_pain: a.parq.chest,
      parq_dizziness: a.parq.dizzy,
      parq_bone_joint: a.parq.joint,
      parq_bp_meds: a.parq.bp,
      parq_other_reason: a.parq.other,
      pregnant: a.parq.pregnant,
      eating_disorder_history: a.parq.ed,
      ...legalAcceptancePayload({
        signature: a.signature,
        acceptedIds: LEGAL_DOCS.map((d) => d.id),
      }),
    };

    if (a.medications?.trim()) answers.medications = a.medications.trim();

    onSubmit(answers);
  }

  const PARQ_FIELDS = ["heart", "chest", "dizzy", "joint", "bp", "other", "pregnant", "ed"];
  const parqReady = PARQ_FIELDS.every((k) => a.parq[k] != null);

  const coreReady =
    a.goal && a.equipment && a.days_per_week && a.experience && a.sex && a.age
    && a.weight
    && (imperial ? a.height_ft : a.height_cm)
    && parqReady
    && allLegalChecked && a.signature?.trim();

  return (
    <form onSubmit={submit} className="mt-6 space-y-6">
      <Section title="Training">
        <Select label="Primary goal" options={GOALS} value={a.goal} onChange={(v) => set("goal", v)} required />
        <Select label="Equipment access" options={EQUIPMENT} value={a.equipment} onChange={(v) => set("equipment", v)} required />
        <Select label="Days you can train each week" value={a.days_per_week}
          options={[3, 4, 5, 6].map((n) => [n, `${n} days`])} onChange={(v) => set("days_per_week", Number(v))} required />
        <Select label="Training experience" options={EXPERIENCE} value={a.experience} onChange={(v) => set("experience", v)} required />
        <div>
          <p className={`${LABEL}`}>Injury history or physical limitations</p>
          <div className="flex flex-wrap gap-1.5">
            {INJURY_OPTIONS.map(([key, label]) => (
              <button key={key} type="button" onClick={() => toggleInjury(key)} aria-pressed={a.injuries.includes(key)}
                className={`min-h-[44px] rounded-xl px-3 py-2.5 text-sm transition ${a.injuries.includes(key) ? "bg-ink text-paper" : "border border-ink/15 hover:bg-ink/[0.03]"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Body metrics">
        <p className="text-xs opacity-55">
          Required for calories and protein targets. Missing values stop auto-planning — we will not invent them.
        </p>
        <Select label="Units" options={UNITS} value={a.unit_pref} onChange={(v) => set("unit_pref", v)} required />
        <Select label="Sex" options={SEX} value={a.sex} onChange={(v) => set("sex", v)} required />
        <Field label="Age" required>
          <input type="number" id="age" name="age" min={14} max={90} required value={a.age ?? ""} onChange={(e) => set("age", e.target.value)} className={FIELD} />
        </Field>
        {imperial ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Height (ft)" required>
              <input type="number" id="height_ft" name="height_ft" min={3} max={8} required value={a.height_ft ?? ""} onChange={(e) => set("height_ft", e.target.value)} className={FIELD} />
            </Field>
            <Field label="Height (in)">
              <input type="number" id="height_in" name="height_in" min={0} max={11.9} step={0.1} value={a.height_in ?? ""} onChange={(e) => set("height_in", e.target.value)} className={FIELD} />
            </Field>
          </div>
        ) : (
          <Field label="Height (cm)" required>
            <input type="number" id="height_cm" name="height_cm" min={120} max={230} required value={a.height_cm ?? ""} onChange={(e) => set("height_cm", e.target.value)} className={FIELD} />
          </Field>
        )}
        <Field label={imperial ? "Current weight (lb)" : "Current weight (kg)"} required>
          <input type="number" id="weight" name="weight" min={imperial ? 70 : 35} max={imperial ? 550 : 250} step={0.1} required
            value={a.weight ?? ""} onChange={(e) => set("weight", e.target.value)} className={FIELD} />
        </Field>
        <Field label={imperial ? "Goal weight (lb)" : "Goal weight (kg)"}>
          <input type="number" id="goal_weight" name="goal_weight" min={imperial ? 70 : 35} max={imperial ? 550 : 250} step={0.1}
            value={a.goal_weight ?? ""} onChange={(e) => set("goal_weight", e.target.value)} className={FIELD} />
          <p className="mt-1 text-xs opacity-55">Optional — never required to generate a plan.</p>
        </Field>
      </Section>

      <Section title="Health screen">
        <p className="text-xs opacity-55">{copyFor(mode, "intake_parq_note")}</p>
        {PARQ_QUESTIONS.map(({ key, label }) => (
          <YesNo key={key} label={label} value={a.parq[key]} onChange={(v) => setParq(key, v)} />
        ))}
        <Text label={copyFor(mode, "intake_meds_label")} value={a.medications} onChange={(v) => set("medications", v)}
          placeholder="Medications, conditions, doctor guidance — leave blank if nothing"
          hint={copyFor(mode, "intake_meds_hint")} />
      </Section>

      <Section title="Nutrition context">
        <Text label="Food sensitivities or allergies" value={a.allergies} onChange={(v) => set("allergies", v)}
          placeholder="e.g. lactose, shellfish — or leave blank" />
        <Text label="Meals per day — what they usually look like" value={a.meals_per_day} onChange={(v) => set("meals_per_day", v)} rows={3} />
        <Text label="Current cardio, if any" value={a.cardio_regimen} onChange={(v) => set("cardio_regimen", v)}
          placeholder="e.g. incline walks 3x/week — or none" />
        <Text label="Competition history, if any" value={a.competition_history} onChange={(v) => set("competition_history", v)}
          placeholder="Shows, meets, sports — or none" />
      </Section>

      <Section title="Legal acceptance">
        <p className="text-xs opacity-55">
          Version {LEGAL_VERSION}. Open each document, then check the box. Type your full name to sign.
        </p>
        <ul className="space-y-2">
          {LEGAL_DOCS.map((doc) => (
            <li key={doc.id} className="rounded-xl border border-ink/10 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{doc.title}</p>
                  <p className="mt-0.5 text-xs opacity-55">{doc.summary}</p>
                </div>
                <button type="button" className="btn-ghost shrink-0 px-3 py-2 text-xs min-h-[44px] flex items-center"
                  onClick={() => set("legalOpen", a.legalOpen === doc.id ? null : doc.id)}
                  aria-expanded={a.legalOpen === doc.id}>
                  {a.legalOpen === doc.id ? "Hide" : "Read"}
                </button>
              </div>
              {a.legalOpen === doc.id && (
                <pre className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl bg-ink/[0.03] p-3 text-xs leading-relaxed opacity-80">
                  {doc.body}
                </pre>
              )}
              <label className="mt-3 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  id={`legal-${doc.id}`}
                  className="mt-1"
                  checked={!!a.legalChecked[doc.id]}
                  onChange={(e) => setA((s) => ({
                    ...s,
                    legalChecked: { ...s.legalChecked, [doc.id]: e.target.checked },
                  }))}
                />
                <span>I have read and agree to: {doc.title}</span>
              </label>
            </li>
          ))}
        </ul>
        <Field label="Type your full legal name as signature" required>
          <input
            id="intake-signature"
            name="signature"
            required
            value={a.signature}
            onChange={(e) => set("signature", e.target.value)}
            placeholder="Full name"
            className={FIELD}
            autoComplete="name"
          />
        </Field>
        <p className="text-xs opacity-50">
          Typing your name is your electronic signature for this pack on {new Date().toLocaleDateString()}.
        </p>
      </Section>

      {err && <p className="text-sm text-danger">{err}</p>}
      <button type="submit" disabled={busy || !coreReady}
        className="btn-primary w-full py-3 disabled:opacity-40">
        {busy ? "Submitting…" : "Submit intake"}
      </button>
      <p className="text-center text-xs opacity-45">
        Full legal text version {LEGAL_VERSION}. {copyFor(mode, "intake_legal_footer")}
      </p>
    </form>
  );
}

function Section({ title, children }) {
  return (
    <section className="glass space-y-4 p-5">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, required, children }) {
  const id = label?.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}{required && <span className="opacity-40"> *</span>}</label>
      {children}
    </div>
  );
}

function Select({ label, options, value, onChange, required }) {
  const id = label?.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return (
    <Field label={label} required={required}>
      <select id={id} name={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} required={required} className={`${FIELD} max-w-md`}>
        <option value="" disabled>Choose…</option>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </Field>
  );
}

function Text({ label, value, onChange, placeholder, rows = 2, hint }) {
  const id = label?.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}</label>
      <textarea id={id} name={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder}
        className={FIELD} />
      {hint && <p className="mt-0.5 text-xs opacity-50">{hint}</p>}
    </div>
  );
}

function Result({ r }) {
  const held = r.status === "held_medical";
  const selfServe = r.mode === "self_serve" || r.self_serve === true;
  const published = r.status === "published";
  const kicker = held ? "Held for review" : published ? "Built" : "Received";
  const title = held
    ? (selfServe ? "Not this one. Coaching instead." : "Your coach is on it.")
    : published ? "Your week is built." : "Intake received.";
  const body = held
    ? (selfServe
      ? "Because of what you shared on the health screen, a self-serve plan was not built. You have not been charged again. Coaching is the right next step."
      : "Because of what you shared on the health screen, your coach will review personally before any program is built. Expect direct contact — that is deliberate, not delay.")
    : published
      ? "Sign in with the email you used and open Program."
      : "Your coach is reviewing your details and building structure. You’ll hear from them soon.";
  return (
    <main className="mx-auto max-w-2xl px-5 py-16">
      <span className="kicker">{kicker}</span>
      <h1 className="display mt-2 text-3xl">{title}</h1>
      <p className="mt-3 max-w-lg text-sm opacity-80">{body}</p>
      {published && r.meal_plan_error && (
        <p className="mt-3 max-w-lg text-sm text-danger">Nutrition did not build: {r.meal_plan_error}. Your program is ready; reply to your receipt email and nutrition gets added.</p>
      )}
      <p className="mt-4 text-xs opacity-50">
        Reminder: this is not medical care. If symptoms arise, stop and contact a clinician.
      </p>
      {held && selfServe && COACHING_APPLICATION_URL
        ? <a href={COACHING_APPLICATION_URL} className="btn-primary mt-6 inline-flex">Apply for coaching</a>
        : <Link to="/login" className="btn-primary mt-6 inline-flex">Sign in</Link>}
    </main>
  );
}
