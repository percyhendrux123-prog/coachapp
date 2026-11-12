// The eight health-screen questions, worded exactly as the client has always seen them.
// One list for both the full intake and the short screen-and-waiver page, so the wording
// can never drift between them. Changing a label here is a legal-content change: don't,
// without the owner.
//
// key   = the page's short key; `field` = the stored answer key the server gates on.
export const PARQ_QUESTIONS = [
  { key: "heart", field: "parq_heart_condition", label: "Heart condition / doctor-limited activity?" },
  { key: "chest", field: "parq_chest_pain", label: "Chest pain with activity?" },
  { key: "dizzy", field: "parq_dizziness", label: "Dizziness or loss of consciousness?" },
  { key: "joint", field: "parq_bone_joint", label: "Bone/joint problem worsened by activity?" },
  { key: "bp", field: "parq_bp_meds", label: "Blood pressure or heart medication?" },
  { key: "other", field: "parq_other_reason", label: "Any other reason not to exercise?" },
  { key: "pregnant", field: "pregnant", label: "Pregnant or could be pregnant?" },
  { key: "ed", field: "eating_disorder_history", label: "History of an eating disorder?" },
];
