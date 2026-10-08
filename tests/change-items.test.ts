import { describe, expect, it } from 'vitest';
import { extractChangeItems } from '../src/collector/change-items.js';
import { plainText } from '../src/collector/sources.js';

function extract(originalText: string) {
  return extractChangeItems({ originalTitle: 'Release', originalText });
}

describe('complete source change inventory', () => {
  it('retains all 56 official-style bullets in their source order', () => {
    const changes = Array.from({ length: 56 }, (_, index) => `Change ${index + 1}`);
    const items = extract(`## What's changed\n\n${changes.map(change => `- ${change}`).join('\n')}`);

    expect(items).toHaveLength(56);
    expect(items.map(item => item.text)).toEqual(changes);
    expect(items.every(item => item.section === "What's changed")).toBe(true);
  });

  it('keeps nested bullets and continued paragraphs with their parent change', () => {
    const source = [
      '- Added workspace controls.',
      '  The existing workspace remains selected.',
      '',
      '  A second paragraph explains migration.',
      '  - Existing configuration remains valid.',
      '    - Nested exception: managed workspaces.',
      '',
      '  The exception applies only to managed workspaces.',
      '- Fixed a stalled request.',
    ].join('\n');
    const items = extract(source);

    expect(items.map(item => item.text)).toEqual([
      source.slice(2, source.lastIndexOf('\n- Fixed')),
      'Fixed a stalled request.',
    ]);
  });

  it('keeps fenced examples with their change even when code resembles Markdown', () => {
    const items = extract([
      '- Added a configuration example.',
      '',
      '```yaml',
      '# This is a literal comment, not a section.',
      '- enabled: true',
      '',
      '- nested: false',
      '```',
      '  This example uses the existing configuration file.',
      '- Fixed the final issue.',
    ].join('\n'));

    expect(items).toHaveLength(2);
    expect(items[0].text).toBe([
      'Added a configuration example.',
      '',
      '```yaml',
      '# This is a literal comment, not a section.',
      '- enabled: true',
      '',
      '- nested: false',
      '```',
      '  This example uses the existing configuration file.',
    ].join('\n'));
    expect(items[1].text).toBe('Fixed the final issue.');
  });

  it('honors the opening fence character and length, including a fence on a bullet line', () => {
    const items = extract([
      '- ````markdown',
      '  ```sh',
      '  - literal shell argument',
      '  ```',
      '  ~~~',
      '  # literal heading',
      '  ````',
      '- After the backtick example.',
      '',
      '  ~~~text',
      '  - literal bullet',
      '  ~~~~',
      '- After the tilde example.',
    ].join('\n'));

    expect(items).toHaveLength(3);
    expect(items[0].text).toContain('  ```\n  ~~~\n  # literal heading\n  ````');
    expect(items[1].text).toContain('  ~~~text\n  - literal bullet\n  ~~~~');
    expect(items[2].text).toBe('After the tilde example.');
  });

  it('preserves literal Markdown characters inside standalone indented code', () => {
    const code = [
      '    - literal command argument',
      '    # literal comment',
      '',
      '    ```',
      '    ---',
    ].join('\n');
    const items = extract(`${code}\n\n- The following change is separate.`);

    expect(items.map(item => item.text)).toEqual([code, 'The following change is separate.']);
  });

  it('keeps indented code within a list item without interpreting literal fences', () => {
    const items = extract([
      '- Added renderer support.',
      '',
      '      ```',
      '      - literal sample text',
      '',
      '- The following change is separate.',
    ].join('\n'));

    expect(items.map(item => item.text)).toEqual([
      'Added renderer support.\n\n      ```\n      - literal sample text',
      'The following change is separate.',
    ]);
  });

  it('does not erase punctuation-only literal code as empty formatting', () => {
    expect(extract('    -').map(item => item.text)).toEqual(['    -']);
  });

  it('retains narrative preambles and trailing paragraphs around a list', () => {
    const items = extract([
      'This release requires an explicit migration.',
      'Existing projects must retain their configuration.',
      '',
      '## Security',
      '',
      '- Fixed an authorization check.',
      '',
      'The fix applies only after restarting the service.',
      '',
      'An unusual but important final note remains included.',
    ].join('\n'));

    expect(items.map(({ section, text }) => ({ section, text }))).toEqual([
      { section: undefined, text: 'This release requires an explicit migration.\nExisting projects must retain their configuration.' },
      { section: 'Security', text: 'Fixed an authorization check.' },
      { section: 'Security', text: 'The fix applies only after restarting the service.' },
      { section: 'Security', text: 'An unusual but important final note remains included.' },
    ]);
  });

  it('recognizes numbered and mixed-marker lists without splitting nested changes', () => {
    const items = extract([
      '1. First numbered change.',
      '   1. Nested numbered detail.',
      '   + Nested unordered detail.',
      '2) Second numbered change.',
      '* A security change.',
      '+ Documentation change.',
    ].join('\n'));

    expect(items.map(item => item.text)).toEqual([
      'First numbered change.\n   1. Nested numbered detail.\n   + Nested unordered detail.',
      'Second numbered change.',
      'A security change.',
      'Documentation change.',
    ]);
  });

  it('keeps a sibling bullet separate when it is less indented than the preceding item content', () => {
    const items = extract([
      '- First sibling.',
      ' - Second sibling.',
      '   - A detail of the second sibling.',
      '  - Third sibling.',
    ].join('\n'));

    expect(items.map(item => item.text)).toEqual([
      'First sibling.',
      'Second sibling.\n   - A detail of the second sibling.',
      'Third sibling.',
    ]);
  });

  it('preserves complete flattened Kiro paragraphs without guessing which prose is unimportant', () => {
    const originalText = plainText([
      '<article><h2>A steadier workspace</h2>',
      '<p>This release preserves active work.\nIt also changes restart behavior.</p>',
      '<h3>Durable work</h3>',
      '<p>Accepted work resumes after a restart.</p>',
      '<ul><li>Fixed lost terminal state.</li><li>Updated migration documentation.</li></ul>',
      '<p>Learn more -&gt;</p></article>',
    ].join(''));
    const items = extractChangeItems({ originalTitle: 'A steadier workspace', originalText });

    expect(items.map(item => item.text)).toEqual([
      'A steadier workspace',
      'This release preserves active work.\nIt also changes restart behavior.',
      'Durable work',
      'Accepted work resumes after a restart.',
      'Fixed lost terminal state.',
      'Updated migration documentation.',
      'Learn more ->',
    ]);
  });

  it('carries the complete Markdown section hierarchy and resets sibling context', () => {
    const items = extract([
      '# Changes',
      '## Editor',
      '### Terminal',
      '- Fixed terminal focus.',
      '## Security',
      '- Rejected invalid credentials.',
      '# Documentation',
      '- Clarified restart behavior.',
    ].join('\n'));

    expect(items.map(item => item.section)).toEqual([
      'Changes > Editor > Terminal', 'Changes > Security', 'Documentation',
    ]);
    expect(items).toHaveLength(3);
  });

  it('retains meaningful headings that have no following body', () => {
    const items = extract([
      '# Release notes',
      '## Removed legacy authentication',
      '## New features',
      '- Added session controls.',
      '## A known issue still affects remote sessions',
    ].join('\n'));

    expect(items.map(({ section, text }) => ({ section, text }))).toEqual([
      { section: 'Release notes', text: 'Removed legacy authentication' },
      { section: 'Release notes > New features', text: 'Added session controls.' },
      { section: 'Release notes', text: 'A known issue still affects remote sessions' },
    ]);
    expect(extract('## Legacy authentication was removed')).toMatchObject([
      { text: 'Legacy authentication was removed' },
    ]);
  });

  it('retains setext headings as section context', () => {
    const items = extract([
      'Breaking changes',
      '================',
      '- Removed a legacy flag.',
      '',
      'Migration notes',
      '---------------',
      '- Existing configuration is still valid.',
    ].join('\n'));

    expect(items.map(({ section, text }) => ({ section, text }))).toEqual([
      { section: 'Breaking changes', text: 'Removed a legacy flag.' },
      { section: 'Breaking changes > Migration notes', text: 'Existing configuration is still valid.' },
    ]);
  });

  it('keeps IDs stable when an unrelated item is inserted', () => {
    const before = extract('## Fixes\n- Retained first fix.\n- Retained second fix.');
    const after = extract('## Fixes\n- An unrelated new fix.\n- Retained first fix.\n- Retained second fix.');

    expect(after.slice(1).map(item => item.id)).toEqual(before.map(item => item.id));
    expect(new Set(after.map(item => item.id)).size).toBe(3);
    expect(extract('## Security\n- Retained first fix.')[0].id).not.toBe(before[0].id);
  });

  it('disambiguates duplicate source occurrences without dropping them', () => {
    const before = extract('- Repeated change.\n- Different change.\n- Repeated change.');
    const after = extract('- Inserted change.\n- Repeated change.\n- Different change.\n- Repeated change.');

    expect(before.map(item => item.text)).toEqual(['Repeated change.', 'Different change.', 'Repeated change.']);
    expect(new Set(before.map(item => item.id)).size).toBe(3);
    expect(after.slice(1).map(item => item.id)).toEqual(before.map(item => item.id));
  });

  it('normalizes line endings while preserving code indentation', () => {
    const source = '- Added an example.\n\n  ```text\n    meaningful indentation\n  ```\n- Last change.';

    expect(extract(source)).toHaveLength(2);
    expect(extract(source.replaceAll('\n', '\r\n'))).toEqual(extract(source));
    expect(extract(source)[0].text).toContain('    meaningful indentation');
  });

  it('retains source bodies and individual items beyond 30,000 characters', () => {
    const longChange = `First detail. ${'A substantive detail remains present. '.repeat(1000)}The first change ends here.`;
    const longParagraph = `A full narrative paragraph. ${'The narrative remains present. '.repeat(1100)}The paragraph ends here.`;
    const items = extract(`- ${longChange}\n- The final bullet remains included.\n\n${longParagraph}`);

    expect(items).toHaveLength(3);
    expect(items.map(item => item.text)).toEqual([longChange, 'The final bullet remains included.', longParagraph]);
    expect(items[0].text.length).toBeGreaterThan(30_000);
    expect(items[2].text.length).toBeGreaterThan(30_000);
  });

  it('preserves unfamiliar prose, tables, references and maintenance changes', () => {
    const items = extract([
      'Release metadata with an unfamiliar label: retain this instruction.',
      '',
      '## Chores',
      '- Updated a build dependency. (#123)',
      '## Documentation',
      '- Repaired a help link. (#124)',
      '',
      '| Platform | Behavior |',
      '| --- | --- |',
      '| Linux | Requires restart |',
      '',
      '> A warning still applies to remote sessions.',
      '',
      '[full-diff]: https://example.invalid/compare/v1...v2',
      '',
      '<details>Additional behavior remains documented here.</details>',
    ].join('\n'));
    const represented = items.map(item => [item.section, item.text].filter(Boolean).join('\n')).join('\n');

    for (const substantiveText of [
      'Release metadata with an unfamiliar label: retain this instruction.',
      'Chores', 'Updated a build dependency. (#123)',
      'Documentation', 'Repaired a help link. (#124)',
      '| Platform | Behavior |\n| --- | --- |\n| Linux | Requires restart |',
      '> A warning still applies to remote sessions.',
      '[full-diff]: https://example.invalid/compare/v1...v2',
      '<details>Additional behavior remains documented here.</details>',
    ]) expect(represented).toContain(substantiveText);
  });

  it.each(['', ' \n\t\r\n', '#\n\n---\n\n* * *\n\n-\n\n```\n```'])('rejects empty or format-only source %j', source => {
    expect(() => extractChangeItems({ originalTitle: 'A title cannot invent source changes', originalText: source })).toThrow();
  });
});
