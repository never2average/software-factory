// When a workspace key staff issue stops working (mold_v0-334; src/admin.ts issueKey `expires_in_days`): never (as
// before), or after a number of days. A rotated key keeps its key's span.
export const KEY_EXPIRY: [string, string][] = [['', 'Never expires'], ['30', 'Expires in 30 days'], ['90', 'Expires in 90 days'], ['365', 'Expires in a year']];
