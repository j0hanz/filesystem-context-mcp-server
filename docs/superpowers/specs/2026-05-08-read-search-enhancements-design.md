# Design Spec: Precision Read & Enhanced Search

## Goal
Enhance the existing `read` and `search-content` tools to provide more precision (partial file reads via line/byte offsets) and better contextual search (surrounding lines, fuzzy matching). This prevents context-window overflow for LLMs and improves code navigation.

## 1. `read` Tool Enhancements (Precision Reading)

### New Input Schema Parameters (Optional)
- `startLine` (number): 1-indexed, inclusive starting line.
- `endLine` (number): 1-indexed, inclusive ending line.
- `offset` (number): Byte offset to start reading.
- `length` (number): Number of bytes to read.

### Behavior & Constraints
- **Mutual Exclusivity:** The tool will reject requests (return a schema validation error) if both line-based and byte-based parameters are provided simultaneously.
- **Graceful Bounds:** If `endLine` or `offset + length` exceeds the file size, it will read up to the end of the file without throwing an error.
- **Implementation:**
  - Byte-based reads will use `fs.createReadStream({ start, end })`.
  - Line-based reads will use the `node:readline` module over a stream to minimize memory footprint.

### Output Schema Update
- Add metadata field `reachedEOF` (boolean) to indicate if the requested range hit the end of the file.

## 2. `search-content` Tool Enhancements (Context & Fuzzy Match)

### New Input Schema Parameters (Optional)
- `contextBefore` (number): Lines of code to include before the matching line.
- `contextAfter` (number): Lines of code to include after the matching line.
- `fuzzy` (boolean): Default `false`. Enables approximate string matching instead of strict literal/regex.

### Behavior & Constraints
- **Context Grouping:** If multiple matches occur close to each other, their context windows will overlap. The tool will merge these overlapping matches into a single contiguous hunk.
- **Result Format:** Output format changes from an array of matched strings to an array of structural objects: `{ startLine, endLine, content }` to provide exact line mappings.
- **Fuzzy Matching:** Uses a lightweight subsequence or approximate match algorithm.
- **Performance Safeguard:** If `fuzzy: true` is used, stricter performance limits (max file count or timeout) will be enforced to prevent hanging the server on large directory trees.

## Testing Strategy
- Unit tests for mutually exclusive parameters in `read` input schema.
- Streaming tests verifying correct line extraction and byte bounds in `read`.
- Overlap logic tests for `search-content` verifying that adjacent context chunks merge correctly.
- Fuzzy match unit tests verifying correct approximations and performance boundary cutoffs.
