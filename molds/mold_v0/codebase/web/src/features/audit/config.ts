// The audit trails (mold_v0-197; src/audit-trail.ts on the server): which are on in this build, from the profile
// (profile.json `audit`, compiled into profile.generated.ts). Both off: no page, no sidebar entry, no route answers.
import { profile } from '../../config/profile.generated';

const audit = (profile as { audit?: { data?: boolean; platform?: boolean } }).audit ?? {};
export const dataTrailOn = () => audit.data === true;
export const platformTrailOn = () => audit.platform === true;
export const auditOn = () => dataTrailOn() || platformTrailOn();
