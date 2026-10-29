import type { Preview } from "@storybook/react-vite";

import "../src/styles/theme.css";

const preview: Preview = {
  parameters: {
    layout: "padded",
    // Mỗi story phải qua axe không lỗi (P1).
    a11y: { test: "error" },
    viewport: {
      options: {
        mobile: { name: "Mobile 390", styles: { width: "390px", height: "844px" } },
        desktop: { name: "Desktop 1440", styles: { width: "1440px", height: "900px" } },
      },
    },
  },
};

export default preview;
