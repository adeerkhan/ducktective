import { createRootRoute, Outlet } from "@tanstack/react-router";

/**
 * The <html> shell and the global <head> tags live in `index.html` — this is a
 * client-rendered SPA, not a server-rendered document. Routes that need their
 * own title can add `head: () => ({ meta: [...] })`; TanStack Router applies it
 * on navigation.
 */
export const Route = createRootRoute({
  component: () => <Outlet />,
});
