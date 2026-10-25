// One setup checklist (mold_v0-146): the shell's setup steps (joining, connecting an AI client, its tools, a first
// question; src/app.ts setup, or a host pack's own) and the packs' onboarding steps (src/onboarding.ts) as one ordered
// list, so a home tab and the Setup page never show two checklists that ask the same thing.
//
// Order: the shell's steps first (an AI client is how most pack steps are done), then the packs' steps in their
// declared order. A pack step whose condition is one the shell measures (`workspace`, `connected`, `first_call`:
// /api/onboarding `covers`) takes that shell step's place: the shell's step is dropped, and the shell steps after it
// follow the pack's step. So a pack places the connection where it wants it by declaring a step `done_when: connected`.

export interface ShellSetupStep { id: string; label: string; done: boolean; at: string | null; help: string; prompt?: string | null }
export interface PackSetupStep { pack: string; id: string; label: string; help: string | null; done: boolean; at: string | null; covers?: string | null }

export interface ChecklistStep {
  /** Unique in the list: `shell:<id>` or `<pack>/<id>`. */
  key: string;
  label: string;
  help: string | null;
  prompt: string | null;
  done: boolean;
  at: string | null;
  /** A pack's step: its pack (a step the page links to by its anchor). */
  pack?: string;
  id: string;
  /** The shell's step it is or stands for (`joined`, `connected`, ...), if any: `connected` carries the connection panel. */
  shell: string | null;
}

export function mergeSetupSteps(shell: ShellSetupStep[], packSteps: PackSetupStep[]): ChecklistStep[] {
  const out: ChecklistStep[] = packSteps.map((p) => ({ key: `${p.pack}/${p.id}`, label: p.label, help: p.help, prompt: null, done: p.done, at: p.at, pack: p.pack, id: p.id, shell: p.covers ?? null }));
  let cursor = 0;
  for (const x of shell) {
    const at = out.findIndex((p) => p.pack && p.shell === x.id);
    if (at >= 0) { cursor = at + 1; continue; }
    out.splice(cursor++, 0, { key: `shell:${x.id}`, label: x.label.replace(' (team)', ''), help: x.help, prompt: x.prompt ?? null, done: x.done, at: x.at, id: x.id, shell: x.id });
  }
  return out;
}
