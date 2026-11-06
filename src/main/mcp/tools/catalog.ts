import { ENTITY_CONFIG_TOOLS } from './config-entity-tools.js';
import { WORKFLOW_CONFIG_TOOLS } from './config-workflow-tools.js';
import { CONTROL_TOOLS } from './control-tools.js';
import { READ_TOOLS } from './read-tools.js';
import type { ToolDef } from './tool-kit.js';

/** Every tool the MCP server offers; each session enables what it may use. */
export const MCP_TOOLS: readonly ToolDef[] = [
  ...READ_TOOLS,
  ...CONTROL_TOOLS,
  ...ENTITY_CONFIG_TOOLS,
  ...WORKFLOW_CONFIG_TOOLS,
];
