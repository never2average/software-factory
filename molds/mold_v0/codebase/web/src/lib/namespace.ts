import { profile } from '@/config/profile.generated';

/**
 * The build's namespace (the API's src/namespace.ts, the same rule): its MCP server name in lower-case letters, digits
 * and underscores. The prefix of its Stripe lookup keys and of the files it names for download.
 */
export const NS = profile.mcp_server_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'app';
export const KEY_PREFIX = `${NS}_`;
