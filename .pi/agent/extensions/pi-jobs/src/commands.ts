import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface JobCommandControls {
  showJobDetails(): boolean;
  setBashToolActive(active: boolean): void;
  registerCommands(): void;
}

/** Owns the extension-session command preferences and their slash-command surface. */
export function createJobCommandControls(pi: ExtensionAPI): JobCommandControls {
  let detailsVisible = false;

  const setBashToolActive = (active: boolean): void => {
    const activeTools = new Set(pi.getActiveTools());
    if (active) activeTools.add("bash");
    else activeTools.delete("bash");
    pi.setActiveTools([...activeTools]);
  };

  return {
    showJobDetails: () => detailsVisible,
    setBashToolActive,
    registerCommands(): void {
      pi.registerCommand("job-details", {
        description: "Show or hide full JavaScript/bash commands in job tool rows: /job-details on|off",
        handler: async (args, ctx) => {
          const requested = args.trim().toLowerCase();
          if (requested !== "on" && requested !== "off") {
            ctx.ui.notify("Usage: /job-details on|off", "warning");
            return;
          }
          detailsVisible = requested === "on";
          ctx.ui.notify(`Job command details ${detailsVisible ? "enabled" : "disabled"}.`, "info");
        },
      });

      pi.registerCommand("bash-tool", {
        description: "Enable or disable the model-facing bash tool: /bash-tool on|off",
        handler: async (args, ctx) => {
          const requested = args.trim().toLowerCase();
          if (requested !== "on" && requested !== "off") {
            ctx.ui.notify("Usage: /bash-tool on|off", "warning");
            return;
          }
          const active = requested === "on";
          setBashToolActive(active);
          ctx.ui.notify(`Model-facing bash tool ${active ? "enabled" : "disabled"}.`, "info");
        },
      });
    },
  };
}
