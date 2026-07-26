import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { superchatPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(superchatPlugin);
