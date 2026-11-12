export async function readOutcome(work) {
  try {
    return { state: "ready", value: await work };
  } catch (error) {
    return { state: "failed", error };
  }
}
