// Notes a person sent to a delegated specialist WHILE IT WORKS, delivered at its next step (mold_v1-235).
//
// eve has no way to address a running delegation: its continuation token is not reachable over HTTP, and a message to
// the child's session starts an unrelated conversation (lib/specialist-run-actions.ts). So the application keeps a
// per-delegation inbox (agent/lib/steering.ts) and eve asks it, at the start of every step of a DELEGATED session, for
// the notes that are due. Each note is appended to the step's messages as a user-role message, AFTER everything the
// session already holds: the stable prefix (and its prompt cache) is untouched, and the note is saved with the step's
// messages like any other input, so later steps keep reading it. Each delivery is reported on the specialist's own
// stream as `steering.delivered`.
//
// The application registers the reader at `globalThis[Symbol.for("eve.app.steeringNotes")]`:
//   ({ sessionId, parent: { sessionId, callId, rootSessionId }, turnId, stepIndex }) => Promise<Array<{ id, text }>>
// It must answer the SAME notes again for the same (session, turn, step) — a step that is retried re-reads them — and
// never throw (a failure here delivers nothing and the step goes on). Without a reader nothing changes.
const READER = Symbol.for(`eve.app.steeringNotes`);

/** Append the notes due for this step of a delegated session; report each on the stream. Never throws. */
async function deliverSteeringNotes(input) {
  const read = globalThis[READER];
  const parent = input.parent;
  if (typeof read !== `function` || parent === null || typeof parent !== `object` || typeof parent.sessionId !== `string` || typeof parent.callId !== `string`) return;
  let notes;
  try {
    notes = await read({
      sessionId: input.sessionId,
      parent: { sessionId: parent.sessionId, callId: parent.callId, rootSessionId: parent.rootSessionId },
      turnId: input.emissionState?.turnId,
      stepIndex: input.emissionState?.stepIndex,
    });
  } catch {
    return;
  }
  if (!Array.isArray(notes) || notes.length === 0) return;
  const delivered = [];
  for (const note of notes) {
    if (note === null || typeof note !== `object` || typeof note.text !== `string` || note.text === `` || typeof note.id !== `string`) continue;
    input.messages.push({ role: `user`, content: note.text });
    delivered.push(note.id);
  }
  if (delivered.length === 0 || input.emit === undefined) return;
  try {
    await input.emit({
      data: {
        noteIds: delivered,
        sequence: input.emissionState?.sequence,
        stepIndex: input.emissionState?.stepIndex,
        turnId: input.emissionState?.turnId,
      },
      type: `steering.delivered`,
    });
  } catch {
    // The notes are in the step's messages; a lost report is only a missing confirmation.
  }
}

export { deliverSteeringNotes };
