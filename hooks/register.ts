import type { EngineInterface, Register } from 'claude-code'

// Turns shorter than this don't buzz: you're probably still looking at the screen.
const MIN_TURN_MS = 30_000
// Tapping a notification brings Termux to the front.
const OPEN_TERMUX = 'am start -n com.termux/.app.TermuxActivity'

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const dur = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** Fenced code blocks in a message, in order; an indented fence is dedented. */
const fences = (text: string) => {
  const out: { lang: string; code: string }[] = []
  const re = /^([ \t]*)```([^\n`]*)\n([\s\S]*?)\n\1```[ \t]*$/gm
  for (const [, indent = '', lang = '', body = ''] of text.matchAll(re)) {
    const code = indent
      ? body.split('\n').map(l => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n')
      : body
    out.push({ lang: lang.trim(), code })
  }
  return out
}

// How a refused tool call reads in the transcript: the auto-mode classifier's
// denial, or the person rejecting it at the permission prompt.
const BLOCKED = /denied by the Claude Code auto mode classifier|Permission for this action was denied|doesn't want to proceed with this tool use/i

/** One line naming a tool call specifically enough to consent to it. */
const describeCall = (tool: string, input: Record<string, unknown>) => {
  if (tool === 'Bash') {
    const what = typeof input.description === 'string' ? ` ("${input.description}")` : ''
    return `the Bash command${what}: ${oneLine(String(input.command ?? ''), 240)}`
  }
  if (typeof input.file_path === 'string') return `the ${tool} on ${input.file_path}`
  return `the ${tool} call ${oneLine(JSON.stringify(input), 200)}`
}

/** Fire-and-forget Android notification; never holds up the hook that sent it. */
const notify = ($: EngineInterface, id: string, title: string, content: string, vibrate: string) => {
  void $.process
    .run(
      ['termux-notification', '--id', id, '--title', title, '--content', content,
        '--priority', 'high', '--vibrate', vibrate, '--action', OPEN_TERMUX],
      { timeoutMs: 15_000 },
    )
    .catch(() => {})
}

const unnotify = ($: EngineInterface, id: string) => {
  void $.process.run(['termux-notification-remove', id], { timeoutMs: 15_000 }).catch(() => {})
}

export const register: Register = on => {
  // Whether a "needs you" notification is up, so answering it can take it down.
  let waiting = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'yy',
      description: "Yank the last code block of Claude's replies to the Android clipboard",
      argumentHint: '[n: nth block from the end]',
      immediate: true,
    })
    await $.command.register({
      name: 'dash',
      description: 'Open the tailnet dashboard (tdash); /dash --stop closes it',
      argumentHint: '[--stop | --probe HOST]',
      immediate: true,
    })
    await $.command.register({
      name: 'consent',
      description: 'Draft a consent message for the tool call that was just blocked; review it, then Enter',
      argumentHint: '[note to add]',
    })
    return next(e)
  })

  // ── 1. buzz when a long main-loop turn ends ────────────────────────────────
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (waiting) {
      unnotify($, 'claude-wait')
      waiting = false
    }
    if (!e.agentId && !e.isAborted && e.durationMs >= MIN_TURN_MS) {
      const title = e.reason === 'answer'
        ? `Claude finished · ${dur(e.durationMs)}`
        : `Claude stopped (${e.reason}) · ${dur(e.durationMs)}`
      notify($, 'claude-turn', title, oneLine(e.answer || '(no text)', 160), '0,200')
    }
    return result
  })

  // ── 1b. buzz (twice) when Claude is waiting on you: permission prompts etc. ─
  on('classic.Notification', async ($, e, next) => {
    const result = await next(e)
    const kind = e.notification_type ?? ''
    // idle reminders would double up on the turn-finished buzz
    if (!/idle/i.test(kind)) {
      const title = /permission/i.test(kind) ? 'Claude needs permission' : e.title || 'Claude needs you'
      notify($, 'claude-wait', title, oneLine(e.message, 160), '0,150,120,150')
      waiting = true
    }
    return result
  })

  // A permission answered means the call goes ahead: take the "needs you" ping down.
  on('tool.call', async ($, e, next) => {
    if (waiting) {
      unnotify($, 'claude-wait')
      waiting = false
    }
    return next(e)
  })

  // You're back at the prompt: clear both pings.
  on('prompt.submit', async ($, e, next) => {
    unnotify($, 'claude-turn')
    if (waiting) {
      unnotify($, 'claude-wait')
      waiting = false
    }
    return next(e)
  })

  // ── 2. /yy [n]: yank the nth-from-last code block of Claude's replies ──────
  on('command.run', { command: 'yy' }, async ($, e) => {
    const n = Math.max(1, Number.parseInt(e.args.trim() || '1', 10) || 1)
    const blocks = (await $.session.messages())
      .filter(m => m.role === 'assistant')
      .flatMap(m => fences(m.text))
    const pick = blocks[blocks.length - n]
    if (!pick) {
      return {
        text: blocks.length
          ? `Only ${blocks.length} code block${blocks.length === 1 ? '' : 's'} so far.`
          : "No code blocks in Claude's replies yet.",
      }
    }
    const ran = await $.process
      .run(['termux-clipboard-set'], { stdin: pick.code, timeoutMs: 15_000 })
      .catch(() => undefined)
    if (!ran || ran.exitCode !== 0) {
      // Termux:API unreachable: fall back to the terminal's own clipboard path.
      const copied = await $.ui.copy({ text: pick.code })
      if (!copied.isCopied) return { text: 'Yank failed: termux-clipboard-set did not run, and the terminal copy was refused.' }
    }
    const lines = pick.code.split('\n').length
    const lang = pick.lang ? ` ${pick.lang}` : ''
    return { text: `Yanked ${lines} line${lines === 1 ? '' : 's'}${lang}: ${oneLine(pick.code, 60)}` }
  })

  // ── 3. /consent [note]: draft consent for the last blocked call ────────────
  // Drafts, never sends: the message goes into the prompt box and only the
  // person's own Enter submits it, so the consent is literally theirs.
  on('command.run', { command: 'consent' }, async ($, e) => {
    const calls = (await $.session.messages())
      .filter(m => m.role === 'assistant')
      .flatMap(m => m.toolUses)
    const blocked = calls.reverse().find(u => u.isError && BLOCKED.test(u.text ?? ''))
    if (!blocked) return { text: 'No blocked tool call found in this session.' }

    const note = e.args.trim()
    const draft =
      `I consent to the action that was just blocked, ${describeCall(blocked.tool, blocked.input)}. ` +
      `Go ahead and run it.${note ? ` Note: ${note}` : ''}`
    const filled = await $.prompt.fill({ text: draft })
    if (filled.isFilled) return { text: 'Consent drafted in the prompt box: check it, then press Enter.' }

    // No box to fill (a dialog holds the keys, or a remote surface): yank it instead.
    const ran = await $.process
      .run(['termux-clipboard-set'], { stdin: draft, timeoutMs: 15_000 })
      .catch(() => undefined)
    return {
      text: ran?.exitCode === 0
        ? 'Could not fill the prompt box; the consent message is on your clipboard instead.'
        : `Could not fill the prompt box or the clipboard. The message: ${draft}`,
    }
  })

  // ── 4. /dash: open (or --stop / --probe) the tailnet dashboard ─────────────
  on('command.run', { command: 'dash' }, async ($, e) => {
    const args = e.args.trim() ? e.args.trim().split(/\s+/) : []
    const ran = await $.process
      .run(['sh', '-c', 'exec "$HOME/.local/bin/tdash" "$@"', 'tdash', ...args], { timeoutMs: 90_000 })
      .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    return { text: `${ran.stdout}${ran.stderr}`.trim() || `tdash exited ${ran.exitCode}` }
  })
}
