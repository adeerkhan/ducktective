import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

/**
 * Vite's `base` prefixes asset URLs only; the router matches locations itself.
 * Without this, `/ducktective/protocol` serves the shell and then renders the
 * not-found route, because the router compares against `/protocol`.
 */
const basepath = import.meta.env.BASE_URL.replace(/\/+$/, "") || "/";

const router = createRouter({
  routeTree,
  basepath,
  defaultErrorComponent: AppErrorComponent,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root — index.html was not served");

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
