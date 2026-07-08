import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";

import { RootLayout } from "./root-layout";
import { ChatView } from "@/containers/chat-view";
import { SettingsLayout } from "@/routes/settings/settings-layout";
import { InterfaceSettings } from "@/routes/settings/interface";
import { ModelsSettings } from "@/routes/settings/models";
import { ShortcutsSettings } from "@/routes/settings/shortcuts";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <ChatView draft />,
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/thread/$sessionId",
  component: ChatView,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/interface" });
  },
});

const interfaceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/interface",
  component: InterfaceSettings,
});

const modelsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/models",
  component: ModelsSettings,
});

const shortcutsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/shortcuts",
  component: ShortcutsSettings,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  threadRoute,
  settingsRoute.addChildren([
    settingsIndexRoute,
    interfaceRoute,
    modelsRoute,
    shortcutsRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
