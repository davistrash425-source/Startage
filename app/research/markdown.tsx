// A small, safe Markdown renderer for the agent's answers.
// Supports headings, paragraphs, bullet and numbered lists, simple tables,
// bold, italics, inline code and links. It never injects raw HTML.

import { Fragment, type ReactNode } from "react";

const SAFE_URL = /^https?:\/\//i;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // [label](url) | **bold** | *italic* or _italic_ | `code` | bare URL
  const pattern = /\[([^\]]+)\]\((\S+?)\)|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)|`([^`]+)`|(https?:\/\/[^\s)<>\]]+)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) {
      const url = m[2];
      out.push(
        SAFE_URL.test(url) ? (
          <a key={key} href={url} target="_blank" rel="noopener noreferrer">
            {renderInline(m[1], key)}
          </a>
        ) : (
          <Fragment key={key}>{m[1]}</Fragment>
        )
      );
    } else if (m[3] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[3], key)}</strong>);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      out.push(<em key={key}>{m[4] ?? m[5]}</em>);
    } else if (m[6] !== undefined) {
      out.push(<code key={key}>{m[6]}</code>);
    } else if (m[7] !== undefined) {
      const url = m[7].replace(/[.,;:]+$/, "");
      out.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>
      );
      if (url.length < m[7].length) out.push(m[7].slice(url.length));
    }
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    // Table: a row with pipes followed by a separator row like |---|---|
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line) && !bullet.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(re);
        if (m) items.push(m[1]);
        else items[items.length - 1] += " " + lines[i].trim(); // continuation line
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={className}>
      {blocks.map((block, b) => {
        const key = `b${b}`;
        switch (block.kind) {
          case "heading": {
            const level = Math.min(block.level + 1, 4);
            const Tag = `h${level}` as "h2" | "h3" | "h4";
            return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
          }
          case "paragraph":
            return <p key={key}>{renderInline(block.text, key)}</p>;
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={key}>
                {block.items.map((item, n) => (
                  <li key={`${key}-${n}`}>{renderInline(item, `${key}-${n}`)}</li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              <div key={key} className="rs-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, c) => (
                        <th key={c}>{renderInline(cell, `${key}-h${c}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>{renderInline(cell, `${key}-${r}-${c}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr key={key} />;
        }
      })}
    </div>
  );
}
