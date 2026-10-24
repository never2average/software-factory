// What the admin console's shared pages show for this build (mold_v0-104). The session engine (a host pack's tables:
// its products, their research, simulations and agent sessions) has its own sections on the account pages, Analytics,
// Health and the plan editor; a build without it shows the packs' runs there instead, per job kind and in the pack's
// words (its job kinds' labels, the build's {run} word). The same rule as the server's src/host-tables.ts.
import { HOST_TABLES, JOB_KINDS } from '@/config/build-facts.generated';
import { packOnboardingSteps } from '@/config/pack-nav.generated';

const ENGINE_TABLES = ['products', 'scenarios', 'simulations', 'agent_sessions'];
/** Whether this build has the session engine (a host pack owns its tables). */
export const sessionEngine = (): boolean => ENGINE_TABLES.every((t) => HOST_TABLES.includes(t));
/** Whether this build shows the packs' runs where the session engine's sections were: no engine, and a job kind. */
export const packRuns = (): boolean => !sessionEngine() && JOB_KINDS.length > 0;
/** A job kind's label (the pack's words), else its name. With no pack named, the first kind of that name. */
export const kindLabel = (kind: string, pack?: string): string =>
  JOB_KINDS.find((k) => k.name === kind && (pack == null || k.pack === pack))?.label ?? kind;
/** Whether the packs declare onboarding steps (the account stages after the first tool call, src/admin.ts accountStages). */
export const packSteps = (): boolean => packOnboardingSteps > 0;
