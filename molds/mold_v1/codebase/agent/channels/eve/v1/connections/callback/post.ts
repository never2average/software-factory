// eve's unauthenticated connection-callback route (POST), replaced by one that refuses: agent/lib/callback-guard.ts.
import { closedCallbackChannel } from "../../../../../lib/callback-guard.ts";

export default closedCallbackChannel("eve/v1/connections/callback/post");
