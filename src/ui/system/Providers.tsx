import { LayerProvider } from "@astryxdesign/core/Layer";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import type { ReactNode } from "react";

export interface ProvidersProps {
  children: ReactNode;
}

/**
 * App-level Astryx integrations.
 *
 * The neutral theme is intentionally built and imported from its stable
 * package entrypoint, while LayerProvider supplies the accessible notification
 * viewport used by Astryx toast and layer APIs. Native anchors keep the
 * existing app behavior intact until routing is introduced.
 */
export const Providers = ({ children }: ProvidersProps) => (
  <Theme theme={neutralTheme}>
    <LinkProvider component="a">
      <LayerProvider>{children}</LayerProvider>
    </LinkProvider>
  </Theme>
);
