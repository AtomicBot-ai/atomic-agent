import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Node, Position } from 'unist'
import type { Code, Paragraph, Parent, Text } from 'mdast'
import { visit } from 'unist-util-visit'
import type { VFile } from 'vfile'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Remark plugin that disables indented code block syntax.
 * Converts indented code blocks to plain text paragraphs,
 * while preserving fenced code blocks with backticks.
 */
export function disableIndentedCodeBlockPlugin() {
  return (tree: Node, file: VFile) => {
    visit(tree, 'code', (node: Code, index, parent: Parent | undefined) => {
      // Convert indented code blocks (nodes without lang / meta property,
      // and are not surrounded by backticks) to plain text
      // Check if the parent exists so we can replace the node safely
      if (
        node.lang === null &&
        node.meta === null &&
        parent &&
        typeof index === 'number'
      ) {
        const nodePosition: Position | undefined = node.position
        if (
          nodePosition !== undefined &&
          file.value.at(nodePosition.start.offset!) !== '`'
        ) {
          const textNode: Text = {
            type: 'text',
            value: node.value,
            position: nodePosition,
          }
          const paragraphNode: Paragraph = {
            type: 'paragraph',
            children: [textNode],
            position: nodePosition,
          }
          parent.children[index] = paragraphNode
        }
      }
    })
  }
}

export function getReadableLanguageName(language: string): string {
  const languageMap: Record<string, string> = {
    js: 'JavaScript',
    jsx: 'React JSX',
    ts: 'TypeScript',
    tsx: 'React TSX',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    json: 'JSON',
    md: 'Markdown',
    py: 'Python',
    rb: 'Ruby',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    cs: 'C#',
    go: 'Go',
    rust: 'Rust',
    php: 'PHP',
    swift: 'Swift',
    kotlin: 'Kotlin',
    sql: 'SQL',
    sh: 'Shell',
    bash: 'Bash',
    ps1: 'PowerShell',
    yaml: 'YAML',
    yml: 'YAML',
    xml: 'XML',
  }

  return (
    languageMap[language] ||
    language.charAt(0).toUpperCase() + language.slice(1)
  )
}

export const toGigabytes = (
  input: number,
  options?: { hideUnit?: boolean; toFixed?: number }
) => {
  if (!input) return ''
  if (input > 1024 ** 3) {
    return (
      (input / 1024 ** 3).toFixed(options?.toFixed ?? 2) +
      (options?.hideUnit ? '' : 'GB')
    )
  } else if (input > 1024 ** 2) {
    return (
      (input / 1024 ** 2).toFixed(options?.toFixed ?? 2) +
      (options?.hideUnit ? '' : 'MB')
    )
  } else if (input > 1024) {
    return (
      (input / 1024).toFixed(options?.toFixed ?? 2) +
      (options?.hideUnit ? '' : 'KB')
    )
  } else {
    return input + (options?.hideUnit ? '' : 'B')
  }
}

export const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function isDev() {
  return window.location.host.startsWith('localhost:')
}

export function formatDuration(startTime: number, endTime?: number): string {
  const end = endTime || Date.now()
  const durationMs = end - startTime

  if (durationMs < 0) {
    return 'Invalid duration (start time is in the future)'
  }

  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  } else if (seconds > 0) {
    return `${seconds}s`
  } else {
    return `${durationMs}ms`
  }
}

export const extractThinkingContent = (text: string) => {
  return text
    .replace(/<\/?think>/g, '')
    .replace(/<\|channel\|>analysis<\|message\|>/g, '')
    .replace(/<\|start\|>assistant<\|channel\|>final<\|message\|>/g, '')
    .replace(/assistant<\|channel\|>final<\|message\|>/g, '')
    .replace(/<\|channel\|>/g, '') // remove any remaining channel markers
    .replace(/<\|message\|>/g, '') // remove any remaining message markers
    .replace(/<\|start\|>/g, '') // remove any remaining start markers
    .trim()
}
