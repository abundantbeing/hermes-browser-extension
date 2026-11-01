import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../extension/lib/common.mjs';
import { presentMarkdownParts, renderAdaptiveMarkdown, splitAdaptiveSegments } from '../extension/lib/adaptive-ui.mjs';

test('nested lists keep their hierarchy', () => {
  assert.equal(
    renderMarkdown('- Parent\n  - Child one\n  - Child two\n- Sibling'),
    '<ul><li>Parent<ul><li>Child one</li><li>Child two</li></ul></li><li>Sibling</li></ul>',
  );
  assert.equal(
    renderMarkdown('1. Install\n   - run npm ci\n   - run npm test\n2. Build'),
    '<ol><li>Install<ul><li>run npm ci</li><li>run npm test</li></ul></li><li>Build</li></ol>',
  );
  assert.equal(
    renderMarkdown('- [ ] parent\n  - [x] child'),
    '<ul><li><span class="md-task " aria-hidden="true">□</span>parent<ul><li><span class="md-task checked" aria-hidden="true">✓</span>child</li></ul></li></ul>',
  );
  assert.equal(
    renderMarkdown('- one\n\t- tab indented child'),
    '<ul><li>one<ul><li>tab indented child</li></ul></li></ul>',
  );
});

test('an indented line continues its list item instead of ending the list', () => {
  assert.equal(
    renderMarkdown('1. First item\n   continued on the next line\n2. Second'),
    '<ol><li>First item continued on the next line</li><li>Second</li></ol>',
  );
  assert.equal(renderMarkdown('- a\n\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(
    renderMarkdown('1. Step\n\n   More about the step.\n\n2. Next'),
    '<ol><li><p>Step</p><p>More about the step.</p></li><li>Next</li></ol>',
  );
});

test('a fenced block inside a list item stays in the item and loses only the item indentation', () => {
  assert.equal(
    renderMarkdown('1. Run:\n   ```bash\n   npm test\n     --watch\n   ```\n2. Done'),
    '<ol><li>Run:<pre><code data-lang="bash">npm test\n  --watch</code></pre></li><li>Done</li></ol>',
  );
  // A fence the reply closed at the left margin still closes; the list then ends as before.
  assert.equal(
    renderMarkdown('1. Run:\n   ```\n   npm test\n```\n\nAfter'),
    '<ol><li>Run:<pre><code>npm test</code></pre></li></ol><p>After</p>',
  );
});

test('existing list behaviour is unchanged', () => {
  // Explicit numbering across separated fragments (issue #45) and plain lists.
  assert.equal(
    renderMarkdown('1. First item\n\nExplanation one.\n\n2. Second item'),
    '<ol><li>First item</li></ol><p>Explanation one.</p><ol start="2"><li>Second item</li></ol>',
  );
  assert.equal(renderMarkdown('- one\n- two\nText after'), '<ul><li>one</li><li>two</li></ul><p>Text after</p>');
  assert.equal(renderMarkdown('- one\n1. two'), '<ul><li>one</li></ul><ol><li>two</li></ol>');
  assert.equal(renderMarkdown('**Bold start** of a paragraph'), '<p><strong>Bold start</strong> of a paragraph</p>');
  assert.equal(renderMarkdown('* * *'), '<hr />');
});

test('consecutive quote lines are one blockquote, and a bare > separates its paragraphs', () => {
  assert.equal(renderMarkdown('> line one\n> line two'), '<blockquote>line one line two</blockquote>');
  assert.equal(
    renderMarkdown('> first paragraph\n>\n> second paragraph'),
    '<blockquote><p>first paragraph</p><p>second paragraph</p></blockquote>',
  );
  assert.equal(renderMarkdown('> - a\n> - b'), '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>');
  assert.equal(renderMarkdown('> single'), '<blockquote>single</blockquote>');
  assert.doesNotMatch(renderMarkdown('> quoted\n>\n> more'), /&gt;/);
});

test('an escaped pipe stays inside its table cell', () => {
  const html = renderMarkdown('| expr | note |\n|---|---|\n| a \\| b | escaped |');
  assert.match(html, /<td>a \| b<\/td><td>escaped<\/td>/);
});

test('link targets keep balanced parentheses', () => {
  assert.equal(
    renderMarkdown('See [Rust](https://en.wikipedia.org/wiki/Rust_(programming_language)) now'),
    '<p>See <a href="https://en.wikipedia.org/wiki/Rust_(programming_language)" target="_blank" rel="noopener noreferrer">Rust</a> now</p>',
  );
  assert.equal(
    renderMarkdown('(see [docs](https://example.com/docs))'),
    '<p>(see <a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>)</p>',
  );
});

test('tilde fences and longer backtick fences are code', () => {
  assert.equal(renderMarkdown('~~~python\nprint("hi")\n~~~'), '<pre><code data-lang="python">print(&quot;hi&quot;)</code></pre>');
  assert.equal(renderMarkdown('````md\n```js\nx\n```\n````'), '<pre><code data-lang="md">```js\nx\n```</code></pre>');
  assert.equal(renderMarkdown('~~~\n```\nstill code\n~~~'), '<pre><code>```\nstill code</code></pre>');
  // Tabs inside code keep their bytes.
  assert.equal(renderMarkdown('```make\nall:\n\tcc main.c\n```'), '<pre><code data-lang="make">all:\n\tcc main.c</code></pre>');
  assert.equal(renderMarkdown('```js\nconst a = 1;'), '<pre><code data-lang="js">const a = 1;</code></pre>');
});

test('Vivid UI fence splitting follows the same fence rule', () => {
  const segments = splitAdaptiveSegments('Intro\n\n````md\n```hermes-ui\n{"not":"a block"}\n```\n````\n\nOutro', { streaming: false });
  assert.deepEqual(segments.map((segment) => segment.kind), ['markdown']);
  assert.match(segments[0].text, /````md[\s\S]*````/);

  const tilde = splitAdaptiveSegments('~~~text\n```\n~~~\n\nAfter', { streaming: false });
  assert.deepEqual(tilde.map((segment) => segment.kind), ['markdown']);
  assert.match(renderMarkdown(tilde[0].text), /<pre><code data-lang="text">```<\/code><\/pre><p>After<\/p>/);
});

test('the sanitized panel markup keeps nested lists, quote paragraphs and fenced code', async () => {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  const { renderMarkdownSafe } = await import('../extension/lib/sanitizer.mjs');
  const markdown = '- Parent\n  - Child\n\n> one\n>\n> two\n\n~~~sh\necho hi\n~~~';
  assert.equal(renderMarkdownSafe(markdown), renderMarkdown(markdown));
});

const blockCount = (html, tag) => html.split(`<${tag}>`).length - 1;

test('quotes and lists nested far past the limit render as text instead of overflowing the stack', () => {
  const quotes = renderMarkdown(`${'>'.repeat(10_000)} deep text`);
  assert.match(quotes, /deep text/);
  assert.ok(blockCount(quotes, 'blockquote') <= 64);
  assert.match(quotes, /&gt;&gt;&gt;/);

  const lists = renderMarkdown(`${'- '.repeat(10_000)}deep item`);
  assert.match(lists, /deep item/);
  assert.ok(blockCount(lists, 'ul') <= 64);

  const indented = renderMarkdown(Array.from({ length: 2_000 }, (_, level) => `${'  '.repeat(level)}- level ${level}`).join('\n'));
  assert.match(indented, /level 1999/);
  assert.ok(blockCount(indented, 'ul') <= 64);

  const mixed = renderMarkdown(`${'> - '.repeat(5_000)}mixed text`);
  assert.match(mixed, /mixed text/);
  assert.ok(blockCount(mixed, 'blockquote') + blockCount(mixed, 'ul') <= 64);
});

test('ordinary nesting depth is untouched by the limit', () => {
  assert.equal(
    renderMarkdown('- a\n  - b\n    - c\n      - d'),
    '<ul><li>a<ul><li>b<ul><li>c<ul><li>d</li></ul></li></ul></li></ul></li></ul>',
  );
  assert.equal(renderMarkdown('> > > deep'), '<blockquote><blockquote><blockquote>deep</blockquote></blockquote></blockquote>');
});

test('a longer fence opened inside a nested item keeps its inner example and closing line', () => {
  assert.equal(
    renderMarkdown('- parent\n  - ````md\n    ```js\n    x\n    ```\n    ````\n  - sibling\n- next'),
    '<ul><li>parent<ul><li><pre><code data-lang="md">```js\nx\n```</code></pre></li><li>sibling</li></ul></li><li>next</li></ul>',
  );
  // A fence closes only on its own character: the ``` line stays code inside a ~~~ fence one level down.
  assert.equal(
    renderMarkdown('1. Outer\n   - ~~~\n     ```\n     kept\n     ~~~\n   - after\n2. Next'),
    '<ol><li>Outer<ul><li><pre><code>```\nkept</code></pre></li><li>after</li></ul></li><li>Next</li></ol>',
  );
  // Three levels down.
  assert.equal(
    renderMarkdown('- a\n  - b\n    - ````md\n      ```js\n      x\n      ```\n      ````\n    - c'),
    '<ul><li>a<ul><li>b<ul><li><pre><code data-lang="md">```js\nx\n```</code></pre></li><li>c</li></ul></li></ul></li></ul>',
  );
});

test('a tab after a list marker starts the item and sets its content column', () => {
  assert.equal(renderMarkdown('-\tfirst\n-\tsecond'), '<ul><li>first</li><li>second</li></ul>');
  assert.equal(renderMarkdown('1.\tfirst\n2.\tsecond'), '<ol><li>first</li><li>second</li></ol>');
  assert.equal(renderMarkdown('*\tstar'), '<ul><li>star</li></ul>');
  // `-\t` puts the content at column 4, so four spaces nest and two do not.
  assert.equal(renderMarkdown('-\tparent\n    - child'), '<ul><li>parent<ul><li>child</li></ul></li></ul>');
  assert.equal(renderMarkdown('-\tone\n  - two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(renderMarkdown('1.\tparent\n    - child'), '<ol><li>parent<ul><li>child</li></ul></li></ol>');
  assert.equal(renderMarkdown('-\tparent\n\t-\tchild'), '<ul><li>parent<ul><li>child</li></ul></li></ul>');
});

test('Vivid UI keeps a tilde or longer fence whole instead of reading its contents as metrics', () => {
  const html = renderAdaptiveMarkdown('~~~md\n\n- **A:** 1\n- **B:** 2\n\n~~~\n\nAfter');
  assert.doesNotMatch(html, /haui-/);
  assert.match(html, /^<pre><code data-lang="md">[\s\S]*- \*\*A:\*\* 1[\s\S]*<\/code><\/pre><p>After<\/p>$/);

  const longer = renderAdaptiveMarkdown('````md\n```\n\n- **A:** 1\n- **B:** 2\n\n```\n````\n\nAfter');
  assert.doesNotMatch(longer, /haui-/);
  assert.match(longer, /<\/code><\/pre><p>After<\/p>$/);

  assert.deepEqual(presentMarkdownParts('~~~\n\n- **A:** 1\n- **B:** 2\n\n~~~\n\nAfter').map((part) => part.kind), ['markdown']);
  // Outside a fence the same run still becomes metric cards.
  assert.match(renderAdaptiveMarkdown('- **A:** 1\n- **B:** 2\n\nAfter'), /haui-stat-grid/);
});

test('link targets keep deeper balanced parentheses and stay validated', () => {
  assert.equal(
    renderMarkdown('[docs](https://example.com/a_(b_(c)))'),
    '<p><a href="https://example.com/a_(b_(c))" target="_blank" rel="noopener noreferrer">docs</a></p>',
  );
  assert.equal(
    renderMarkdown('see ([docs](https://example.com/a_(b_(c_(d)))))'),
    '<p>see (<a href="https://example.com/a_(b_(c_(d)))" target="_blank" rel="noopener noreferrer">docs</a>)</p>',
  );
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>x</p>');
  assert.equal(renderMarkdown('[x](javascript:a(b(c)))'), '<p>x</p>');
  assert.doesNotMatch(renderMarkdown('[x](https://example.com/a_(b)'), />x<\/a>/);
  // An unclosed target, or one nested absurdly deep, is plain text and returns at once.
  assert.doesNotMatch(renderMarkdown(`[a](${'('.repeat(100_000)}`), /<a /);
  assert.doesNotMatch(renderMarkdown(`[a](https://example.com/${'('.repeat(50_000)}${')'.repeat(50_000)})`), />a<\/a>/);
});

test('plain responses keep ~~~ fences and a ``` line inside a longer fence as code', async () => {
  const { markdownToPlainText, renderPlainResponse } = await import('../extension/lib/adaptive-ui.mjs');
  const tilde = '~~~md\n- **A:** 1\n~~~\n\nAfter';
  assert.equal(markdownToPlainText(tilde), '- **A:** 1\n\nAfter');
  const html = renderPlainResponse(tilde);
  assert.match(html, /<pre class="plain-response-code">- \*\*A:\*\* 1<\/pre>/);
  assert.match(html, /<p class="plain-response">After<\/p>/);
  const nested = '````md\n```js\nlet x = 1;\n```\n````\nDone';
  assert.match(renderPlainResponse(nested), /<pre class="plain-response-code">```js\nlet x = 1;\n```<\/pre><p class="plain-response">Done<\/p>/);
});

test('malformed links never rescan a failed target, so hostile replies render at once', () => {
  const hostile = [
    `${'['.repeat(1000)}a](https://example.com/a_(b_(${'a'.repeat(100_000)}`,
    `${'['.repeat(5000)}a](https://example.com/a_(b_(${'a'.repeat(1_000_000)}`,
    '[a](x[b](y)'.repeat(5_000),
    '[a]((x)('.repeat(50_000),
  ];
  for (const input of hostile) {
    const begin = Date.now();
    const html = renderMarkdown(input);
    const elapsed = Date.now() - begin;
    assert.ok(elapsed < 100, `rendered in ${elapsed} ms`);
    // No Markdown link is made (a long bare URL may still be linked as itself).
    assert.doesNotMatch(html, />[ab]<\/a>/);
  }
});

test('link rendering keeps its label and target rules', () => {
  const link = (text, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  assert.equal(renderMarkdown('[a](https://x.test/1) and [b](https://x.test/2)'), `<p>${link('a', 'https://x.test/1')} and ${link('b', 'https://x.test/2')}</p>`);
  assert.equal(renderMarkdown('[a [b](https://x.test/)'), `<p>${link('a [b', 'https://x.test/')}</p>`);
  assert.equal(renderMarkdown('x] [a](https://x.test/)'), `<p>x] ${link('a', 'https://x.test/')}</p>`);
  assert.equal(renderMarkdown('[](https://x.test/)'), '<p>[](<a href="https://x.test/" target="_blank" rel="noopener noreferrer">https://x.test/</a>)</p>');
  assert.equal(renderMarkdown('[a]() [b](https://x.test/)'), `<p>[a]() ${link('b', 'https://x.test/')}</p>`);
  assert.equal(renderMarkdown('[a](https://x.test/p q)'), '<p>[a](<a href="https://x.test/p" target="_blank" rel="noopener noreferrer">https://x.test/p</a> q)</p>');
});

test('a fence opened by a child item ends with that child', () => {
  assert.equal(
    renderMarkdown('- parent\n  - ~~~js\n    code\n  - sibling\n\n~~~\noutside\n~~~\nAfter'),
    '<ul><li>parent<ul><li><pre><code data-lang="js">code</code></pre></li><li>sibling</li></ul></li></ul><pre><code>outside</code></pre><p>After</p>',
  );
  // Still closed by its own marker while the child lasts.
  assert.equal(
    renderMarkdown('- parent\n  - ~~~js\n    a\n    b\n    ~~~\n  - sibling'),
    '<ul><li>parent<ul><li><pre><code data-lang="js">a\nb</code></pre></li><li>sibling</li></ul></li></ul>',
  );
  // An unclosed child fence runs to the end of the child, not into the next child's text.
  assert.equal(
    renderMarkdown('1. one\n   - ```\n     x\n   - two\n2. three'),
    '<ol><li>one<ul><li><pre><code>x</code></pre></li><li>two</li></ul></li><li>three</li></ol>',
  );
});

test('a tab after a nested marker keeps its original width when the parent indentation is removed', () => {
  assert.equal(
    renderMarkdown('- parent\n  -\tchild\n    continued\n  - sibling'),
    '<ul><li>parent<ul><li>child continued</li><li>sibling</li></ul></li></ul>',
  );
  assert.equal(
    renderMarkdown('- -\tinner\n    more'),
    '<ul><li><ul><li>inner more</li></ul></li></ul>',
  );
  assert.equal(
    renderMarkdown('> -\tquoted\n>   still quoted\n> - next'),
    '<blockquote><ul><li>quoted still quoted</li><li>next</li></ul></blockquote>',
  );
  // Tabs inside code keep their bytes.
  assert.equal(
    renderMarkdown('- parent\n  ```make\n  -\trm x\n  ```'),
    '<ul><li>parent<pre><code data-lang="make">-\trm x</code></pre></li></ul>',
  );
});
