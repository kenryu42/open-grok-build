import { tool } from '@opencode-ai/plugin/tool';

/** Zod arg schemas for Cursor/Grok shim tools (execute logic comes from pi tool collectors). */
export const grokToolArgSchemas: Record<string, Record<string, unknown>> = {
  Grep: {
    pattern: tool.schema.string().describe('Regex pattern to search for in file contents'),
    path: tool.schema
      .string()
      .optional()
      .describe('Directory or file to search. Defaults to current working directory.'),
    include: tool.schema
      .string()
      .optional()
      .describe('Glob pattern to filter which files are searched (e.g. *.ts, **/*.md)'),
  },
  Glob: {
    pattern: tool.schema
      .string()
      .describe('Glob pattern to match files (e.g. **/*.ts, src/**/*.json)'),
    path: tool.schema
      .string()
      .optional()
      .describe('Directory to search within. Defaults to current working directory.'),
  },
  LS: {
    path: tool.schema.string().describe('Directory path to list'),
  },
  Read: {
    path: tool.schema.string().describe('Path to the file to read'),
    offset: tool.schema
      .number()
      .optional()
      .describe('Line number to start reading from (0-indexed)'),
    limit: tool.schema.number().optional().describe('Maximum number of lines to read'),
  },
  Write: {
    path: tool.schema.string().describe('Path to the file to write'),
    content: tool.schema.string().describe('Content to write to the file'),
  },
  StrReplace: {
    path: tool.schema.string().describe('Path to the file to modify'),
    old_str: tool.schema.string().describe('String to search for (exact match)'),
    new_str: tool.schema.string().describe('String to replace with'),
  },
  Edit: {
    path: tool.schema.string().describe('Path to the file to modify'),
    edits: tool.schema
      .array(
        tool.schema.object({
          oldText: tool.schema.string(),
          newText: tool.schema.string(),
        }),
      )
      .optional()
      .describe('Exact text replacements to apply sequentially'),
    applyPatch: tool.schema
      .object({ patchContent: tool.schema.string() })
      .optional()
      .describe('Unsupported unified patch content'),
    strReplace: tool.schema
      .object({
        oldText: tool.schema.string(),
        newText: tool.schema.string(),
      })
      .optional(),
    multiStrReplace: tool.schema
      .object({
        edits: tool.schema.array(
          tool.schema.object({
            oldText: tool.schema.string(),
            newText: tool.schema.string(),
          }),
        ),
      })
      .optional(),
  },
  Delete: {
    path: tool.schema.string().describe('Path to the file to delete'),
  },
  Shell: {
    command: tool.schema.string().describe('Shell command to execute'),
    working_directory: tool.schema
      .string()
      .optional()
      .describe('Working directory for the command'),
    timeout: tool.schema.number().optional().describe('Timeout in milliseconds (default: 120000)'),
  },
} as const;
