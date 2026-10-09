/**
 * ONE resolver for "which workspace's data room is this caller in", shared by
 * every tool that opens one.
 *
 * It lived inside dataroom-tools.ts, which was fine while that file was the only
 * reader. `read_image` (vision-tools.ts) is a second one, and the shape it must
 * not have is `getDataroomStore()` with no argument — three call sites in this
 * repo still use that, it returns org #1's legacy-root tree, and a tool built
 * that way reads one workspace's documents for every caller while looking
 * completely correct. A module of its own is what makes "the same door" a fact
 * rather than a convention: the tools do not resolve a workspace, they ask.
 *
 * Kept free of `#lib/*.js` specifiers deliberately — those resolve only through
 * eve's bundler, so a module that uses them cannot be imported by the offline
 * tests, and an access-control rule nothing can execute is a comment.
 */
import { getDataroomStore, type DataroomStore } from "./dataroom-store.ts";
import { orgForSession, type SessionCtxLike } from "./org-context.ts";

/**
 * The data-room store scoped to the CALLER's workspace. Fail-safe: with the
 * multi-tenant flag off (or no tenancy), every caller resolves to org #1, so
 * this returns the legacy-root store — byte-identical to before.
 */
export async function storeForSession(ctx: SessionCtxLike | undefined): Promise<DataroomStore> {
  return getDataroomStore(await orgForSession(ctx));
}
