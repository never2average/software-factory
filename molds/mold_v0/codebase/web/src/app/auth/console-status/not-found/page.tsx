import NotFound from '../../not-found';

// This area's not-found page as a page of its own, drawn on the server (mold_v0-155): web/src/proxy.ts rewrites an
// address under /auth that is no page of this build (web/src/lib/console-routes.ts) here, with status 404. A page that
// throws notFound() is drawn in the browser only (Next 16: its HTML is an empty error shell until the scripts run).
// Never linked; opened directly it is a 404 as well.
export default NotFound;
