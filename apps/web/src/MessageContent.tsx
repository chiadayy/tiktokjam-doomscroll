import { Fragment, type ReactNode } from "react";

interface MessageContentProps {
  content: string;
  rich?: boolean;
}

/**
 * Agent replies are Markdown, but the chat used to show the source punctuation.
 * This intentionally small renderer covers the structures Agents commonly use
 * without accepting raw HTML or adding a general-purpose UI dependency.
 */
export function MessageContent({ content, rich = false }: MessageContentProps) {
  if (!rich) return <div className="message-body">{content}</div>;
  return <div className="message-body message-body-rich">{renderBlocks(content)}</div>;
}

function renderBlocks(content: string): ReactNode[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = /^\s*```([^`]*)$/.exec(line);
    if (fence !== null) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre className="message-code-block" key={`code:${index}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading?.[2] !== undefined) {
      const level = heading[1]?.length ?? 2;
      const Heading = level <= 2 ? "h3" : "h4";
      blocks.push(<Heading key={`heading:${index}`}>{renderInline(heading[2])}</Heading>);
      index += 1;
      continue;
    }

    if (isBullet(line)) {
      const items: Array<{ text: string; depth: number }> = [];
      while (index < lines.length && isBullet(lines[index] ?? "")) {
        const match = /^(\s*)[-*+]\s+(.+)$/.exec(lines[index] ?? "");
        if (match?.[2] !== undefined) {
          items.push({ text: match[2], depth: Math.min(2, Math.floor((match[1]?.length ?? 0) / 2)) });
        }
        index += 1;
      }
      blocks.push(
        <ul className="message-list" key={`list:${index}`}>
          {items.map((item, itemIndex) => (
            <li className={`message-list-depth-${item.depth}`} key={itemIndex}>
              {renderInline(item.text)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (isNumbered(line)) {
      const items: string[] = [];
      while (index < lines.length && isNumbered(lines[index] ?? "")) {
        const match = /^\s*\d+[.)]\s+(.+)$/.exec(lines[index] ?? "");
        if (match?.[1] !== undefined) items.push(match[1]);
        index += 1;
      }
      blocks.push(
        <ol className="message-list" key={`numbered:${index}`}>
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}
        </ol>,
      );
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index] ?? "")) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push(<p key={`paragraph:${index}`}>{renderInline(paragraph.join(" "))}</p>);
  }

  return blocks;
}

function startsBlock(line: string): boolean {
  return line.trim() === "" || /^\s*```/.test(line) || /^#{1,4}\s+/.test(line) || isBullet(line) || isNumbered(line);
}

function isBullet(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line);
}

function isNumbered(line: string): boolean {
  return /^\s*\d+[.)]\s+/.test(line);
}

function renderInline(text: string): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];
    const key = `${start}:${token}`;

    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      nodes.push(
        link?.[1] !== undefined && link[2] !== undefined
          ? <a href={link[2]} key={key} rel="noreferrer" target="_blank">{link[1]}</a>
          : <Fragment key={key}>{token}</Fragment>,
      );
    }
    cursor = start + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
