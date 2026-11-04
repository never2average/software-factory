import { defineAgent } from "eve";
import { agentModel, compactionFor, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Write the desk's briefing from its story calendar: what is due today and by when, what is embargoed and until when, slots nobody has picked up, assignments at risk of missing their deadline, and what was published since the last briefing. Reads the calendar however it arrives (the assignments list, a CSV export of the planning sheet, a calendar feed, wire budget lines) and cites where each line came from. Delegate here for the morning or weekend briefing, or to ask what is at risk on a desk today.",
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
  compaction: compactionFor("story-briefing", "specialist"),
});
