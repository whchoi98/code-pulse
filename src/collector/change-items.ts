import { createHash } from 'node:crypto';

export interface SourceChangeItem {
  id: string;
  section?: string;
  text: string;
}

interface Fence {
  marker: string;
  length: number;
}

interface Heading {
  level: number;
  text: string;
  represented: boolean;
}

interface Block {
  kind: 'list' | 'paragraph' | 'code';
  contentIndent: number;
  lines: string[];
  literalContent?: boolean;
}

function columns(prefix: string): number {
  let width = 0;
  for (const character of prefix) {
    width += character === '\t' ? 4 - width % 4 : 1;
  }
  return width;
}

function indentation(line: string): number {
  return columns(line.match(/^[ \t]*/)![0]);
}

function listItem(line: string): { contentIndent: number; text: string } | undefined {
  const match = line.match(/^([ \t]*)([-+*]|\d+[.)])(?:([ \t]+)(.*)|$)/);
  return match ? { contentIndent: columns(match[1] + match[2] + (match[3] ?? ' ')), text: match[4] ?? '' } : undefined;
}

function atxHeading(line: string): { level: number; text: string } | undefined {
  const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/);
  return match ? { level: match[1].length, text: (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim() } : undefined;
}

function openingFence(line: string): Fence | undefined {
  const match = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return undefined;
  return { marker: match[1][0], length: match[1].length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = line.match(/^[ \t]*(`+|~+)[ \t]*$/);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

function thematicBreak(line: string): boolean {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
}

function meaningful(text: string): boolean {
  let fence: Fence | undefined;
  for (const line of text.split('\n')) {
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      else if (line.trim()) return true;
      continue;
    }
    if (thematicBreak(line) || /^ {0,3}=+[ \t]*$/.test(line)) continue;
    const body = listItem(line)?.text ?? line;
    fence = openingFence(body);
    if (fence) continue;
    if ((atxHeading(body)?.text ?? body).trim()) return true;
  }
  return false;
}

/**
 * Defines the complete source inventory, not a list of selected highlights.
 * Unknown blocks remain paragraphs; losing source text is worse than retaining
 * a small contextual item. Flattened HTML has no reliable heading/list markers.
 */
export function extractChangeItems(candidate: { originalTitle: string; originalText: string }): SourceChangeItem[] {
  const items: SourceChangeItem[] = [];
  const occurrences = new Map<string, number>();
  const headings: Heading[] = [];
  let block: Block | undefined;
  let blanks: string[] = [];
  let fence: Fence | undefined;
  let literalIndent: number | undefined;

  function emit(text: string, literalContent = false): void {
    if (!literalContent && !meaningful(text)) return;
    const section = headings.map(heading => heading.text).join(' > ') || undefined;
    const digest = createHash('sha256').update(JSON.stringify([section ?? null, text])).digest('hex').slice(0, 24);
    const occurrence = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, occurrence);
    items.push({ id: `change-${digest}-${occurrence}`, section, text });
    for (const heading of headings) heading.represented = true;
  }

  function flush(): void {
    if (block) emit(block.lines.join('\n'), block.literalContent);
    block = undefined;
    blanks = [];
    literalIndent = undefined;
  }

  function append(line: string): void {
    block ??= { kind: 'paragraph', contentIndent: 0, lines: [] };
    block.lines.push(...blanks, line);
    blanks = [];
  }

  function closeHeadings(level: number): void {
    while (headings.length && headings[headings.length - 1].level >= level) {
      const heading = headings.pop()!;
      // A heading with no body can itself describe a change. Emitting it before
      // the next section also retains its original position in the inventory.
      if (!heading.represented) emit(heading.text);
    }
  }

  function addHeading(level: number, text: string): void {
    flush();
    if (!text) return;
    closeHeadings(level);
    headings.push({ level, text, represented: false });
  }

  for (const line of candidate.originalText.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      append(line);
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    if (!line.trim()) {
      if (block) blanks.push(line);
      continue;
    }

    const indent = indentation(line);
    if (literalIndent !== undefined) {
      if (indent >= literalIndent) {
        append(line);
        continue;
      }
      literalIndent = undefined;
      if (block?.kind === 'code') flush();
    }
    const codeIndent = (block?.kind === 'list' ? block.contentIndent : 0) + 4;
    if (indent >= codeIndent && (!block || blanks.length)) {
      // Indented code is literal too: backticks within it must not open a
      // fence that would accidentally consume the next change.
      if (block?.kind !== 'list') {
        flush();
        block = { kind: 'code', contentIndent: 0, lines: [] };
      }
      literalIndent = codeIndent;
      block.literalContent = true;
      append(line);
      continue;
    }
    const nestedInList = block?.kind === 'list' && indent >= block.contentIndent;
    const heading = atxHeading(line);
    if (heading && !nestedInList) {
      addHeading(heading.level, heading.text);
      continue;
    }

    const setext = line.match(/^ {0,3}(=+|-+)[ \t]*$/);
    if (setext && block?.kind === 'paragraph' && !blanks.length) {
      const text = block.lines.join('\n');
      block = undefined;
      addHeading(setext[1][0] === '=' ? 1 : 2, text);
      continue;
    }
    if (thematicBreak(line) && !nestedInList) {
      flush();
      continue;
    }

    const bullet = listItem(line);
    if (bullet) {
      if (nestedInList) append(line);
      else {
        flush();
        block = { kind: 'list', contentIndent: bullet.contentIndent, lines: [bullet.text] };
      }
      fence = openingFence(bullet.text);
      continue;
    }

    const opened = openingFence(line);
    if (opened) {
      // Releases often put an unindented fenced example after its bullet.
      // Keep the complete example attached even across a blank line.
      append(line);
      fence = opened;
      continue;
    }

    if (blanks.length && (block?.kind === 'paragraph' || !nestedInList)) flush();
    append(line);
  }

  flush();
  closeHeadings(0);
  if (!items.length) throw new Error('The official source contains no meaningful change items.');
  return items;
}
