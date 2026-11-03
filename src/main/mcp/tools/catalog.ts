import { READ_TOOLS } from './read-tools.js';
import type { ToolDef } from './tool-kit.js';

/** Every tool the MCP server offers; each session enables what it may use. */
export const MCP_TOOLS: readonly ToolDef[] = [...READ_TOOLS];
