import NotFound from '../../not-found';

// The console's not-found page (mold_v0-131) as a page of its own, drawn on the server (mold_v0-155): the page the API
// server sends a browser for an address that is neither the console's nor its own (src/status-pages.ts), so every
// unknown address looks the same. web/src/proxy.ts answers this address with status 404 (a page that threw notFound()
// would be drawn in the browser only, Next 16: its HTML an empty error shell).
export default NotFound;
