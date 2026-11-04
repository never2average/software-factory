import { defineAgent } from "eve";
import { agentModel, compactionFor, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Read a building inspection report, however it arrives (a checklist spreadsheet, a written report, a photo log), and turn every defect into a proposed maintenance ticket: where it is (unit or common area, named the building's way), what is wrong, its severity and due date by the desk's rulebook, and whether a ticket for it is already open. Delegate here when an inspection report lands in a building's folder, or to ask what an inspection found that is not ticketed yet.",
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
  compaction: compactionFor("inspection-intake", "specialist"),
});
