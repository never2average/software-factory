// The internal docs /admin/docs shows (mold_v0-205): every bundled doc (admin-docs.generated.ts, scripts/sync-docs.mjs),
// less the on-premises runner's guide where the app does not offer runners (profile.json `onprem_runners`, the same flag
// as the customer guide's page: pack-guides.generated.ts ONPREM_GUIDE). Pure TS with relative imports only.
import { ONPREM_GUIDE } from '../config/pack-guides.generated';
import { ADMIN_DOCS as BUNDLED, type AdminDoc } from './admin-docs.generated';

export type { AdminDoc };
export const ONPREM_DOC_SLUG = 'on-premises-runner';
export const ADMIN_DOCS: AdminDoc[] = BUNDLED.filter((d) => ONPREM_GUIDE || d.slug !== ONPREM_DOC_SLUG);
