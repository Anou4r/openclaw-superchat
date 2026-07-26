import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { superchatPlugin } from "./src/channel.js";
var setup_entry_default = defineSetupPluginEntry(superchatPlugin);
export {
  setup_entry_default as default
};
