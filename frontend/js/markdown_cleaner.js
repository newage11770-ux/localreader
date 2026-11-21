/**
 * Optional Markdown Symbol Cleaner (OFF by default).
 * Strips formatting punctuation (**, ###, backticks, etc.)
 * while preserving 100% of actual words verbatim.
 */
(function (global) {
  "use strict";

  function stripMarkdownSymbols(text) {
    if (!text) return "";

    let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Markdown table divider rows like | --- | :---: |
    out = out.replace(/^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-{2,}:?[ \t]*\|?[ \t]*$/gm, "");
    // Fenced code delimiters ```lang or ```
    out = out.replace(/^[ \t]*`{3,}[a-zA-Z0-9_+-]*[ \t]*$/gm, "");
    // Horizontal rules --- / *** / ___
    out = out.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "");
    // Headings ### Title -> Title
    out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
    // Blockquotes > quote -> quote
    out = out.replace(/^[ \t]*(?:>[ \t]*)+/gm, "");
    // Unordered bullet markers at start of line
    out = out.replace(/^([ \t]*)(?:[-*+•])[ \t]+/gm, "$1");
    // Links & images [anchor text](url) -> anchor text
    out = out.replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    // Inline code backticks `code` -> code
    out = out.replace(/`+([^`]+)`+/g, "$1");

    // Bold / italic / strikethrough wrappers (run twice for nested ***text***)
    for (let i = 0; i < 2; i++) {
      out = out.replace(/(\*{1,3}|_{1,3}|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2");
    }

    // Stray formatting tokens attached to word edges
    out = out.replace(/(^|[\s(])[`*~]+(?=\w)/g, "$1");
    out = out.replace(/(?<=\w)[`*~]+(?=[\s.,;:!?)]|$)/g, "");
    // Markdown pipe separators
    out = out.replace(/[ \t]*\|[ \t]*/g, ", ");
    // Collapse excess empty lines
    out = out.replace(/\n{3,}/g, "\n\n");

    return out.trim();
  }

  /**
   * Clean a single display token for speech when Skip Markdown Symbols is ON.
   * Returns "" if the token is pure markdown syntax (e.g., "###", "---", "```").
   */
  function cleanTokenForSpeech(token) {
    if (!token) return "";
    // Pure markdown syntax tokens
    if (/^(?:#{1,6}|`{1,}|[-*_]{3,}|>{1,}|\|+|[-*+•]|~~)$/.test(token)) {
      return "";
    }
    let t = token;
    // Strip markdown link syntax if single token
    t = t.replace(/^!?\[([^\]]+)\]\([^)]+\)$/, "$1");
    // Strip wrapping backticks / asterisks / tildes / underscores
    t = t.replace(/^[`*~_]+/, "").replace(/[`*~_]+$/, "");
    // Keep internal underscores only if it looks like snake_case identifier, otherwise remove emphasis markers
    return t;
  }

  global.LocalReaderMarkdown = {
    stripMarkdownSymbols,
    cleanTokenForSpeech,
  };
})(window);
