// The audit trails (mold_v0-197; src/audit-trail.ts on the server): which are on in this build, from the features
// registry (mold_v0-219: profile.json `features`, else its legacy `audit` keys, as gen-packs resolved them into
// web/src/config/features.generated.ts). Both off: no page, no sidebar entry, no route answers.
import { featureOn } from '../../config/features';

export const dataTrailOn = () => featureOn('audit.data');
export const platformTrailOn = () => featureOn('audit.platform');
export const auditOn = () => dataTrailOn() || platformTrailOn();
