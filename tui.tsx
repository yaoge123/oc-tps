/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, type Accessor } from "solid-js"

type StreamSample = {
  at: number
  tokens: number
}

type StepTiming = {
  sessionID: string
  requestStartAt: number
  firstResponseAt?: number
  lastToolCallAt?: number
}

type SessionAverage = {
  totalTokens: number
  totalDurationMs: number
  totalTtftMs: number
  stepCount: number
}

type Tracker = {
  samples: Record<string, StreamSample[]>
  requestStarts: Record<string, number>
  timings: Record<string, StepTiming>
  averages: Record<string, SessionAverage>
}

const STREAM_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000

function estimateTokens(delta: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5))
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function formatTtft(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined
  return `${value.toFixed(1)}s`
}

function activeDuration(samples: StreamSample[], tailAt?: number) {
  if (samples.length === 0) return 0
  if (samples.length === 1) {
    const tailDuration = tailAt ? Math.max(0, tailAt - samples[0].at) : SINGLE_SAMPLE_MS
    return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS)
  }

  let duration = 0
  for (let i = 1; i < samples.length; i++) {
    duration += Math.max(0, samples[i].at - samples[i - 1].at)
  }
  if (tailAt) duration += Math.max(0, tailAt - samples[samples.length - 1].at)
  return Math.max(duration, SINGLE_SAMPLE_MS)
}

function Status(props: {
  context: Plugin.Context
  sessionID: string
  tracker: Tracker
  revision: Accessor<number>
}) {
  const content = createMemo(() => {
    props.revision()
    const totals = props.tracker.averages[props.sessionID]
    const average = totals
      ? formatRate(totals.totalTokens / (totals.totalDurationMs / 1_000))
      : undefined
    const ttft = totals?.stepCount
      ? formatTtft(totals.totalTtftMs / totals.stepCount / 1_000)
      : undefined

    let live: string | undefined
    if (props.context.data.session.status(props.sessionID) === "running") {
      const now = Date.now()
      const samples = (props.tracker.samples[props.sessionID] ?? []).filter(
        (sample) => now - sample.at <= STREAM_WINDOW_MS,
      )
      const last = samples[samples.length - 1]
      if (last && now - last.at <= LIVE_STALE_MS) {
        const tokens = samples.reduce((sum, sample) => sum + sample.tokens, 0)
        live = formatRate(tokens / (activeDuration(samples, now) / 1_000))
      }
    }

    return `TPS ${live ?? "-"} | AVG ${average ?? "-"} | TTFT ${ttft ?? "-"}`
  })

  return (
    <box position="absolute" right={2} bottom={2} height={1} flexDirection="row">
      <text fg={props.context.theme.text.subdued} flexShrink={0}>
        {content()}
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "oc-tps",
  setup(context) {
    const tracker: Tracker = {
      samples: {},
      requestStarts: {},
      timings: {},
      averages: {},
    }
    const [revision, setRevision] = createSignal(0)
    const bump = () => setRevision((value) => value + 1)

    const clearLive = (sessionID: string) => {
      if (!tracker.samples[sessionID]) return
      delete tracker.samples[sessionID]
      bump()
    }

    const appendSample = (sessionID: string, messageID: string, delta: string) => {
      const now = Date.now()
      tracker.samples[sessionID] = [
        ...(tracker.samples[sessionID] ?? []).filter((sample) => now - sample.at <= STREAM_WINDOW_MS),
        { at: now, tokens: estimateTokens(delta) },
      ]
      const timing = tracker.timings[messageID]
      if (timing && timing.firstResponseAt === undefined) timing.firstResponseAt = now
      bump()
    }

    const subscriptions = [
      context.data.on("session.execution.started", (event) => {
        tracker.requestStarts[event.data.sessionID] = event.created
      }),
      context.data.on("session.step.started", (event) => {
        tracker.timings[event.data.assistantMessageID] = {
          sessionID: event.data.sessionID,
          requestStartAt: tracker.requestStarts[event.data.sessionID] ?? event.created,
        }
        delete tracker.requestStarts[event.data.sessionID]
        bump()
      }),
      context.data.on("session.text.delta", (event) => {
        appendSample(event.data.sessionID, event.data.assistantMessageID, event.data.delta)
      }),
      context.data.on("session.reasoning.delta", (event) => {
        appendSample(event.data.sessionID, event.data.assistantMessageID, event.data.delta)
      }),
      context.data.on("session.tool.input.started", (event) => {
        clearLive(event.data.sessionID)
        const timing = tracker.timings[event.data.assistantMessageID]
        if (!timing) return
        timing.firstResponseAt ??= event.created
        bump()
      }),
      context.data.on("session.tool.called", (event) => {
        const timing = tracker.timings[event.data.assistantMessageID]
        if (!timing) return
        timing.lastToolCallAt = event.created
        bump()
      }),
      context.data.on("session.step.ended", (event) => {
        const timing = tracker.timings[event.data.assistantMessageID]
        if (timing?.firstResponseAt !== undefined) {
          const tokens = event.data.tokens.output + event.data.tokens.reasoning
          const endAt = event.data.finish === "tool-calls" ? timing.lastToolCallAt ?? event.created : event.created
          const duration = Math.max(endAt - timing.firstResponseAt, 1)
          if (tokens > 0) {
            const totals = tracker.averages[event.data.sessionID] ?? {
              totalTokens: 0,
              totalDurationMs: 0,
              totalTtftMs: 0,
              stepCount: 0,
            }
            tracker.averages[event.data.sessionID] = {
              totalTokens: totals.totalTokens + tokens,
              totalDurationMs: totals.totalDurationMs + duration,
              totalTtftMs: totals.totalTtftMs + Math.max(timing.firstResponseAt - timing.requestStartAt, 0),
              stepCount: totals.stepCount + 1,
            }
          }
        }
        delete tracker.timings[event.data.assistantMessageID]
        bump()
      }),
      context.data.on("session.step.failed", (event) => {
        delete tracker.timings[event.data.assistantMessageID]
        clearLive(event.data.sessionID)
        bump()
      }),
    ]

    for (const type of [
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ] as const) {
      subscriptions.push(
        context.data.on(type, (event) => {
          delete tracker.requestStarts[event.data.sessionID]
          clearLive(event.data.sessionID)
        }),
      )
    }

    const timer = setInterval(() => {
      const now = Date.now()
      for (const [sessionID, samples] of Object.entries(tracker.samples)) {
        const current = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS)
        if (current.length) tracker.samples[sessionID] = current
        else delete tracker.samples[sessionID]
      }
      bump()
    }, 1_000)

    context.ui.slot({
      append: "prompt.footer",
      render: (props) => {
        if (!props.sessionID || props.mode !== "normal") return null
        return <Status context={context} sessionID={props.sessionID} tracker={tracker} revision={revision} />
      },
    })

    return () => {
      subscriptions.forEach((unsubscribe) => unsubscribe())
      clearInterval(timer)
    }
  },
})
