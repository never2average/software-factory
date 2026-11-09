// The data-repository fixture's code entry (mold_v0-059). Its loader read an upstream catalog until mold_v0-283 removed
// that repository kind (shared lists are staff-kept platform records): what is left is the entry itself, so the tests
// that install the fixture with code (scripts/lib/catalog-fixture.ts catalogPack) still do. A loader for a
// workspace_files repository is proved in scripts/data-repositories-test.ts.
import { definePack } from "../../src/pack-api.js";

export default definePack({ id: "fixture_catalog" });
