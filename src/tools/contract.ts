import type {
  Icon,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';

import type { ZodType } from 'zod/v4';

export interface ToolContract {
  /**
   * The unique name of the tool (e.g., "read", "grep").
   * This name is used in registration and client calls.
   */
  name: string;

  /**
   * A short human-readable title for documentation (e.g., "Read File").
   */
  title: string;

  /**
   * A detailed description of what the tool does.
   */
  description: string;

  /**
   * Zod schema for the tool's input arguments.
   */
  inputSchema: ZodType;

  /**
   * Pre-built Standard Schema for the wire format. When set, used instead of
   * converting `inputSchema` at registration time. Use this to inject JSON Schema
   * constructs (e.g. oneOf/allOf) that Zod can't express natively.
   */
  inputSchemaJson?: StandardSchemaWithJSON;

  /**
   * Zod schema for the tool's output result (optional).
   */
  outputSchema?: ZodType;

  /**
   * Optional annotations for tool behavior hints.
   */
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };

  /**
   * Specific usage nuances or edge cases for documentation.
   */
  nuances?: string[];

  /**
   * Common pitfalls or warnings for documentation.
   */
  gotchas?: string[];

  /**
   * Optional icons for display in user interfaces.
   */
  icons?: Icon[];

  /**
   * Task support level for the tool. Defaults to 'forbidden'.
   */
  taskSupport?: 'optional' | 'required' | 'forbidden';

  /**
   * Default timeout in ms applied by the registration builder. If omitted,
   * no timeout is wired (tool's own `signal` lifetime applies).
   */
  defaultTimeoutMs?: number;
}
