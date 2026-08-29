import hljs from './highlight-core.mjs';
const EXTENDED_NUMBER_RE = '([-+]?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)|NaN|[-+]?Infinity'; // 0x..., 0..., decimal, float

const EXTENDED_NUMBER_MODE = {
  scope: 'number',
  match: EXTENDED_NUMBER_RE,
  relevance: 0
};

/*
Language: JSON
Description: JSON (JavaScript Object Notation) is a lightweight data-interchange format.
Websites: http://www.json.org, https://www.json5.org
Category: common, protocols, web
*/


function json(hljs) {
  const ATTRIBUTE = {
    className: 'attr',
    begin: /(("(\\.|[^\\"\r\n])*")|('(\\.|[^\\'\r\n])*'))(?=\s*:)/,
    relevance: 1.01
  };
  const PUNCTUATION = {
    match: /[{}[\],:]/,
    className: "punctuation",
    relevance: 0
  };
  const LITERALS = [
    "true",
    "false",
    "null"
  ];
  // NOTE: normally we would rely on `keywords` for this but using a mode here allows us
  // - to use the very tight `illegal: \S` rule later to flag any other character
  // - as illegal indicating that despite looking like JSON we do not truly have
  // - JSON and thus improve false-positively greatly since JSON will try and claim
  // - all sorts of JSON looking stuff
  const LITERALS_MODE = {
    scope: "literal",
    beginKeywords: LITERALS.join(" "),
  };

  return {
    name: 'JSON',
    aliases: ['jsonc', 'json5'],
    keywords:{
      literal: LITERALS,
    },
    contains: [
      ATTRIBUTE,
      PUNCTUATION,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      LITERALS_MODE,
      EXTENDED_NUMBER_MODE,
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE
    ],
    illegal: '\\S'
  };
}

const languageDefinition = json;

hljs.registerLanguage('json', languageDefinition);
