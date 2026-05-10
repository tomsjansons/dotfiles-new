import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerBashTool } from "./bash-tool.ts";
import { registerEditTool } from "./edit-tool.ts";
// import { registerFindTool } from "./find-tool.ts";
export {
  buildHashlinePreview,
  computeLineHash,
  normalizeHashlinePath,
  prefixHashLines,
  resolveHashlinePath,
  stripHashlinePrefix,
  stripHashlinePrefixesFromText,
} from "./hashline.ts";
import { registerReadTool } from "./read-tool.ts";
import { registerWriteTool } from "./write-tool.ts";

export default function hashlineTools(pi: ExtensionAPI): void {
  registerBashTool(pi);
  registerReadTool(pi);
  // registerFindTool(pi);
  registerEditTool(pi);
  registerWriteTool(pi);
}
