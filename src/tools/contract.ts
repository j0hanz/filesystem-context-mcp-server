import type { Icon } from '@modelcontextprotocol/server';

import type { ZodType } from 'zod';

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
}
