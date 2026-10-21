import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ArrowUp, Bot, Check, Copy, GripHorizontal, RotateCcw, Square, X } from 'lucide-react';
import type { ChatEvent, ChatSource, Language } from '../shared/types';
import { products } from './lib';
import { useLocale } from './i18n';

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'done' | 'error';
  activity?: string;
  sources?: ChatSource[];
}

const HISTORY_LIMIT = 10;
const EDGE_MARGIN = 8;

function toolActivity(name: string, input: unknown, language: Language): string {
  const value = (input ?? {}) as Record<string, unknown>;
  const product = typeof value.product === 'string' && value.product in products ? products[value.product as keyof typeof products].name : '';
  const t = (ko: string, en: string) => language === 'en' ? en : ko;
  if (name === 'find_version') return t(`${product} ${String(value.version ?? '')} 버전을 찾고 있습니다`, `Looking up ${product} ${String(value.version ?? '')}`).replace(/\s+/g, ' ');
  if (name === 'search_changes') return t(`“${String(value.query ?? '')}” 관련 기록을 검색하고 있습니다`, `Searching for “${String(value.query ?? '')}”`);
  if (name === 'get_entry') return t('변경 기록을 자세히 읽고 있습니다', 'Reading the full change record');
  return t(`${product} 최근 기록을 확인하고 있습니다`, `Checking recent ${product} records`).replace(/\s+/g, ' ');
}

/** One conversation, kept while the reader app stays mounted. */
export function useChat(language: Language, entryId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const nextId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const busy = messages.at(-1)?.status === 'streaming';
  const update = useCallback((id: number, patch: (message: ChatMessage) => Partial<ChatMessage>) => {
    setMessages(current => current.map(message => message.id === id ? { ...message, ...patch(message) } : message));
  }, []);

  const send = useCallback(async (text: string) => {
    const question = text.trim().slice(0, 2000);
    if (!question || busy) return;
    const history = messages.filter(message => message.status === 'done' && message.content.trim())
      .slice(-HISTORY_LIMIT).map(({ role, content }) => ({ role, content }));
    // The API requires alternating turns that start and end with the user.
    while (history.length && history[0].role !== 'user') history.shift();
    const alternating = history.filter((message, index, all) => index === 0 || message.role !== all[index - 1].role);
    if (alternating.at(-1)?.role === 'user') alternating.pop();
    const userId = ++nextId.current;
    const answerId = ++nextId.current;
    setMessages(current => [...current,
      { id: userId, role: 'user', content: question, status: 'done' },
      { id: answerId, role: 'assistant', content: '', status: 'streaming', activity: language === 'en' ? 'Thinking' : '질문을 살펴보고 있습니다' }]);
    const abort = new AbortController();
    controller.current = abort;
    const fail = (message: string) => update(answerId, current => ({ status: 'error', activity: undefined, content: current.content ? `${current.content}\n\n${message}` : message }));
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', signal: abort.signal,
        headers: { 'content-type': 'application/json', 'x-code-pulse-client': '1' },
        body: JSON.stringify({ language, ...(entryId ? { entryId } : {}), messages: [...alternating, { role: 'user', content: question }] }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        return fail(body?.error ?? (language === 'en' ? 'The AI agent is unavailable right now.' : 'AI 에이전트에 연결하지 못했습니다.'));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ChatEvent;
          if (event.type === 'delta') update(answerId, current => ({ content: current.content + event.text, activity: undefined }));
          else if (event.type === 'retract') update(answerId, () => ({ content: '' }));
          else if (event.type === 'tool') update(answerId, () => ({ activity: toolActivity(event.name, event.input, language) }));
          else if (event.type === 'sources') update(answerId, () => ({ sources: event.sources }));
          else if (event.type === 'done') { update(answerId, () => ({ status: 'done', activity: undefined })); finished = true; }
          else if (event.type === 'error') { fail(event.message); finished = true; }
        }
        if (done) break;
      }
      if (!finished) fail(language === 'en' ? 'The answer was interrupted.' : '답변이 중간에 끊겼습니다.');
    } catch {
      if (abort.signal.aborted) update(answerId, current => ({ status: current.content ? 'done' : 'error', activity: undefined, content: current.content || (language === 'en' ? 'Stopped.' : '답변을 멈췄습니다.') }));
      else fail(language === 'en' ? 'Check your connection and try again.' : '연결 상태를 확인한 뒤 다시 질문해 주세요.');
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }, [busy, entryId, language, messages, update]);

  const stop = useCallback(() => controller.current?.abort(), []);
  const reset = useCallback(() => { controller.current?.abort(); setMessages([]); }, []);
  useEffect(() => () => controller.current?.abort(), []);
  return { messages, busy, send, stop, reset };
}

function inline(text: string, onEntry: (id: string) => void, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const id = `${key}-${match.index}`;
    if (match[1]) out.push(<code key={id}>{match[1].slice(1, -1)}</code>);
    else if (match[2]) out.push(<strong key={id}>{match[2].slice(2, -2)}</strong>);
    else {
      const [label, href] = [match[3], match[4]];
      const entry = /^\?entry=([a-z0-9-]{1,128})$/.exec(href);
      if (entry) out.push(<a key={id} href={href} onClick={event => { event.preventDefault(); onEntry(entry[1]); }}>{label}</a>);
      else if (/^https:\/\//.test(href)) out.push(<a key={id} href={href} target="_blank" rel="noopener noreferrer">{label}</a>);
      else out.push(label);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A deliberately small Markdown subset: paragraphs, headings, lists, code, bold and safe links. */
export function ChatMarkdown({ text, onEntry }: { text: string; onEntry: (id: string) => void }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(<p key={`p${blocks.length}`}>{inline(paragraph.join(' '), onEntry, `p${blocks.length}`)}</p>);
    paragraph = [];
    if (list) {
      const items = list.items.map((item, index) => <li key={index}>{inline(item, onEntry, `l${blocks.length}-${index}`)}</li>);
      blocks.push(list.ordered ? <ol key={`l${blocks.length}`}>{items}</ol> : <ul key={`l${blocks.length}`}>{items}</ul>);
    }
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) { flush(); blocks.push(<h4 key={`h${blocks.length}`}>{inline(heading[1], onEntry, `h${blocks.length}`)}</h4>); }
    else if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return <>{blocks}</>;
}

/** The same shareable address the article copy button uses. */
function entryAddress(id: string, language: Language): string {
  const url = new URL(window.location.pathname, window.location.origin);
  url.search = new URLSearchParams({ entry: id, lang: language }).toString();
  return url.href;
}
const unlinkedSources = (content: string, sources: ChatSource[] = []) => sources.filter(source => !content.includes(`(?entry=${source.id})`));
const sourceLabel = (source: ChatSource) => `${products[source.product].name}${source.version ? ` ${source.version}` : ''}, ${source.publishedDate}`;

/** Markdown for pasting elsewhere: reader-relative links become addresses and unlinked sources are listed. */
function answerMarkdown(content: string, sources: ChatSource[] | undefined, language: Language): string {
  const text = content.trim().replace(/\]\(\?entry=([a-z0-9-]{1,128})\)/g, (_, id: string) => `](${entryAddress(id, language)})`);
  const unlinked = unlinkedSources(content, sources);
  if (!unlinked.length) return text;
  const items = unlinked.map(source => `- [${source.title.replace(/[[\]]/g, '\\$&')}](${entryAddress(source.id, language)}) (${sourceLabel(source)})`);
  return `${text}\n\n${language === 'en' ? 'Referenced changes' : '참고한 변경 기록'}\n${items.join('\n')}`;
}

/** Formatted text for rich editors, built from the rendered answer rather than reparsed Markdown. */
function answerHtml(rendered: HTMLElement, content: string, sources: ChatSource[] | undefined, language: Language): string {
  const copy = rendered.cloneNode(true) as HTMLElement;
  for (const link of copy.querySelectorAll('a')) {
    const entry = /^\?entry=([a-z0-9-]{1,128})$/.exec(link.getAttribute('href') ?? '');
    if (entry) link.href = entryAddress(entry[1], language);
  }
  const unlinked = unlinkedSources(content, sources);
  if (unlinked.length) {
    const heading = copy.appendChild(document.createElement('p'));
    heading.textContent = language === 'en' ? 'Referenced changes' : '참고한 변경 기록';
    const list = copy.appendChild(document.createElement('ul'));
    for (const source of unlinked) {
      const item = list.appendChild(document.createElement('li'));
      const link = item.appendChild(document.createElement('a'));
      link.href = entryAddress(source.id, language);
      link.textContent = source.title;
      item.append(` (${sourceLabel(source)})`);
    }
  }
  return copy.innerHTML;
}

function AssistantMessage({ message, onEntry }: { message: ChatMessage; onEntry: (id: string) => void }) {
  const { language, t } = useLocale();
  const answer = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copied !== 'copied') return;
    const timer = window.setTimeout(() => setCopied('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    const plain = answerMarkdown(message.content, message.sources, language);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      let written = false;
      if (answer.current && typeof ClipboardItem !== 'undefined') {
        const html = answerHtml(answer.current, message.content, message.sources, language);
        try {
          await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([plain], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          })]);
          written = true;
        } catch { /* Some browsers accept only plain text. */ }
      }
      if (!written) await navigator.clipboard.writeText(plain);
      setCopied('copied');
    } catch {
      // Without clipboard access, select the answer so the reader can copy it manually.
      if (answer.current) window.getSelection()?.selectAllChildren(answer.current);
      setCopied('failed');
    }
  };
  return <>
    {message.content && <div ref={answer} className="chat-answer"><ChatMarkdown text={message.content} onEntry={onEntry} /></div>}
    {message.activity && <p className="chat-activity"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>{message.activity}</p>}
    {message.sources && message.sources.length > 0 && <div className="chat-sources" aria-label={t('참고한 변경 기록', 'Referenced changes')}>
      {message.sources.map(source => <a key={source.id} href={`?entry=${source.id}&lang=${language}`} onClick={event => { event.preventDefault(); onEntry(source.id); }}>
        <span>{products[source.product].name}{source.version ? ` ${source.version}` : ''}</span>{source.title}
      </a>)}
    </div>}
    {message.status === 'done' && message.content.trim() && <div className="chat-actions">
      <button type="button" className={`chat-copy ${copied}`} onClick={() => void copy()}>
        {copied === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        {copied === 'copied' ? t('복사했습니다', 'Copied') : t('답변 복사', 'Copy answer')}
      </button>
      {copied === 'failed' && <p className="chat-copy-note">{t('복사하지 못했습니다. 선택된 답변을 직접 복사하세요.', 'Could not copy. The answer is selected so you can copy it yourself.')}</p>}
    </div>}
  </>;
}

export function ChatWidget({ entryId, onOpenEntry }: { entryId: string | null; onOpenEntry: (id: string) => void }) {
  const { language, t } = useLocale();
  const chat = useChat(language, entryId);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) textarea.current?.focus();
    else if (wasOpen.current) launcher.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chat.messages]);

  // Only the title bar moves the window, clamped inside the viewport.
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = panel.current;
    if (event.button !== 0 || !element || window.matchMedia('(max-width: 640px)').matches) return;
    const rect = element.getBoundingClientRect();
    const start = { px: event.clientX, py: event.clientY, ...drag };
    const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));
    const bounds = {
      minX: start.x + EDGE_MARGIN - rect.left, maxX: start.x + window.innerWidth - rect.width - EDGE_MARGIN - rect.left,
      minY: start.y + EDGE_MARGIN - rect.top, maxY: start.y + window.innerHeight - rect.height - EDGE_MARGIN - rect.top,
    };
    event.preventDefault();
    let last = { x: start.x, y: start.y };
    const move = (next: PointerEvent) => {
      last = { x: clamp(start.x + next.clientX - start.px, bounds.minX, bounds.maxX), y: clamp(start.y + next.clientY - start.py, bounds.minY, bounds.maxY) };
      element.style.transform = `translate(${last.x}px, ${last.y}px)`;
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setDrag(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const submit = () => {
    if (!draft.trim() || chat.busy) return;
    void chat.send(draft);
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Korean IME confirms its last syllable with Enter; never send mid-composition.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  const openEntry = (id: string) => {
    onOpenEntry(id);
    if (window.matchMedia('(max-width: 640px)').matches) setOpen(false);
  };
  const suggestions = [
    ...(entryId ? [t('이 글의 변경 사항을 자세히 설명해 주세요', 'Explain the changes in this article in detail')] : []),
    t('Claude Code 최신 버전에서 무엇이 바뀌었나요?', 'What changed in the latest Claude Code release?'),
    t('Codex와 Claude Code의 최근 보안 관련 변경을 비교해 주세요', 'Compare recent security changes in Codex and Claude Code'),
    t('Kiro에서 최근 추가된 새 기능은 무엇인가요?', 'What new features were added to Kiro recently?'),
  ];

  return <>
    {!open && <button ref={launcher} className="chat-launcher" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={t('AI 에이전트에게 질문하기', 'Ask the AI agent')}>
      <Bot size={19} aria-hidden="true" /><span>{t('AI 에이전트', 'AI agent')}</span>
    </button>}
    {open && <div ref={panel} className="chat-window" role="dialog" aria-label={t('Code Pulse AI 에이전트', 'Code Pulse AI agent')}
      style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
      <div className="chat-titlebar" onPointerDown={startDrag}>
        <span className="chat-avatar"><Bot size={16} aria-hidden="true" /></span>
        <div className="chat-title"><strong>{t('AI 에이전트', 'AI agent')}</strong><span>Claude Haiku 5.5</span></div>
        <GripHorizontal className="chat-grip" size={16} aria-hidden="true" />
        <button className="icon-button" onPointerDown={event => event.stopPropagation()} onClick={chat.reset} disabled={!chat.messages.length} aria-label={t('대화 새로 시작', 'Start a new conversation')}><RotateCcw size={15} aria-hidden="true" /></button>
        <button className="icon-button" onPointerDown={event => event.stopPropagation()} onClick={() => setOpen(false)} aria-label={t('AI 에이전트 닫기', 'Close the AI agent')}><X size={17} aria-hidden="true" /></button>
      </div>
      <div ref={log} className="chat-log" role="log" aria-live="polite" aria-busy={chat.busy}>
        {!chat.messages.length && <div className="chat-intro">
          <p>{t('버전별 변경 사항이나 기능의 의미를 물어보세요. Code Pulse가 수집한 공식 변경 기록을 직접 찾아 분석해 답합니다.', 'Ask about a release or what a feature does. The agent searches the official changes collected by Code Pulse and answers from them.')}</p>
          <div className="chat-suggestions">{suggestions.map(text => <button key={text} onClick={() => void chat.send(text)}>{text}</button>)}</div>
        </div>}
        {chat.messages.map(message => <div key={message.id} className={`chat-message ${message.role} ${message.status}`}>
          {message.role === 'user' ? <p>{message.content}</p> : <AssistantMessage message={message} onEntry={openEntry} />}
        </div>)}
      </div>
      <form className="chat-input" onSubmit={event => { event.preventDefault(); submit(); }}>
        <textarea ref={textarea} rows={2} maxLength={2000} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown}
          placeholder={t('예: Claude Code 2.1 버전의 훅 변경을 설명해 주세요', 'e.g. Explain the hook changes in Claude Code 2.1')} aria-label={t('AI 에이전트에게 보낼 질문', 'Question for the AI agent')} />
        {chat.busy
          ? <button type="button" className="chat-send" onClick={chat.stop} aria-label={t('답변 멈추기', 'Stop the answer')}><Square size={14} aria-hidden="true" /></button>
          : <button type="submit" className="chat-send" disabled={!draft.trim()} aria-label={t('질문 보내기', 'Send question')}><ArrowUp size={17} aria-hidden="true" /></button>}
      </form>
      <p className="chat-disclaimer">{t('AI 답변은 틀릴 수 있습니다. 근거 링크의 공식 기록을 확인하세요.', 'AI answers can be wrong. Check the linked official records.')}</p>
    </div>}
  </>;
}
