# Bubble Hide After Voice Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the existing 3.5-second chat-bubble hide timer only after the renderer has finished playing every PCM chunk for the completed reply.

**Architecture:** The main process assigns a strictly increasing playback epoch to each PCM chunk before forwarding it to the pet renderer. The renderer reports its final drained epoch only after its scheduled Web Audio sources end; a small pure gate in the main process permits the existing hide timer only when the reply is done and the reported epoch has caught up. Reset paths clear the gate and timer, and global epochs make delayed reports from an older reply harmless.

**Tech Stack:** Electron IPC, TypeScript, Web Audio API, Vitest.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/shared/ipc.ts` | Defines the renderer-facing PCM payload with an epoch, the renderer-to-main drained notification, and the typed preload API. |
| `src/preload/index.ts` | Safely exposes the narrowly scoped renderer-to-main drained notification. |
| `src/renderer/voice/pcmPlayer.ts` | Detects that all queued `AudioBufferSourceNode`s have actually ended and reports the last epoch, never reporting a deliberate stop as normal completion. |
| `src/renderer/voice/pcmPlayer.test.ts` | Uses a fake Web Audio context to prove completion and stop behavior. |
| `src/renderer/main.ts` | Gives the PCM player a callback that sends its drained epoch to the main process. |
| `src/main/shell/chatHideAfterVoice.ts` | Pure state gate for reply completion, audio epochs, stale reports, and reset. |
| `src/main/shell/chatHideAfterVoice.test.ts` | Verifies all gate transitions without Electron timers or windows. |
| `src/main/shell/index.ts` | Assigns epochs, routes the drained IPC, and starts/resets the existing 3.5-second timer at the permitted moment. |

### Task 1: Add the typed playback-completion IPC contract

**Files:**
- Modify: `src/shared/ipc.ts:74-78,310-326`
- Modify: `src/preload/index.ts:195-212`

- [ ] **Step 1: Add the new IPC constant and renderer payload types**

  In `src/shared/ipc.ts`, add the renderer-to-main channel beside the other voice channels and keep the sidecar payload distinct from the renderer payload:

  ```ts
  VOICE_PLAYBACK_IDLE: 'voice:playback-idle',
  ```

  ```ts
  export interface VoicePcmChunk { audioBase64: string; sampleRate: number }

  export interface VoicePlaybackChunk extends VoicePcmChunk {
    /** Main-process monotonic identifier for this queued browser playback chunk. */
    playbackEpoch: number
  }
  ```

  Replace the `VoiceApi` members with these exact signatures while leaving `onAudioDone` intact for its existing compatibility contract:

  ```ts
  onAudioChunk(cb: (c: VoicePlaybackChunk) => void): void
  onAudioDone(cb: () => void): void
  onAudioError(cb: (message: string) => void): void
  onPlaybackStop(cb: () => void): void
  /** Renderer→main: all queued PCM sources through this epoch ended normally. */
  reportPlaybackIdle(playbackEpoch: number): void
  stop(): void
  ```

- [ ] **Step 2: Expose only the drained notification through preload**

  In the existing `voiceApi` object in `src/preload/index.ts`, preserve the current listeners and add:

  ```ts
  reportPlaybackIdle: (playbackEpoch: number): void => {
    ipcRenderer.send(IPC.VOICE_PLAYBACK_IDLE, playbackEpoch)
  },
  ```

  Do not expose a generic IPC send function and do not alter the existing `VOICE_AUDIO_DONE` listener.

- [ ] **Step 3: Run the type checker to expose every call site that now needs an epoch**

  Run: `pnpm typecheck`

  Expected: it fails only at the renderer PCM-player call and any incomplete `VoiceApi` object caused by the new required method. Those failures are resolved in Tasks 2 and 4.

- [ ] **Step 4: Commit the contract-only change**

  ```bash
  git add src/shared/ipc.ts src/preload/index.ts
  git commit -m "feat(语音): 增加播放完成回报协议"
  ```

### Task 2: Make the renderer report normal PCM queue completion

**Files:**
- Modify: `src/renderer/voice/pcmPlayer.ts:4-71`
- Create: `src/renderer/voice/pcmPlayer.test.ts`
- Modify: `src/renderer/main.ts:146,194-196`

- [ ] **Step 1: Write failing PCM-player tests with a controllable fake Web Audio context**

  Create `src/renderer/voice/pcmPlayer.test.ts`. Define fake sources that retain `onended`, record `start`/`stop`, and expose `end()` to invoke `onended`. Replace `globalThis.AudioContext` for the test and restore it in `afterEach`. Test these exact outcomes:

  ```ts
  it('reports only the final epoch after every queued source ends', () => {
    const idleEpochs: number[] = []
    const { player, sources } = createFakePlayer((epoch) => idleEpochs.push(epoch))

    player.play(float32Base64([0, 0]), 24_000, 41)
    player.play(float32Base64([0, 0]), 24_000, 42)
    sources[0].end()
    expect(idleEpochs).toEqual([])
    sources[1].end()
    expect(idleEpochs).toEqual([42])
  })

  it('does not report idle when stop cancels queued sources', () => {
    const idleEpochs: number[] = []
    const { player, sources } = createFakePlayer((epoch) => idleEpochs.push(epoch))

    player.play(float32Base64([0, 0]), 24_000, 7)
    player.stop()
    sources[0].end()
    expect(idleEpochs).toEqual([])
  })
  ```

  The helper must return `createPcmPlayer({ onPlaybackIdle })` and fake enough of `AudioContext` for `createBuffer`, `createBufferSource`, `destination`, `currentTime`, `copyToChannel`, `connect`, `start`, and `stop`.

- [ ] **Step 2: Run the new test to verify it fails**

  Run: `pnpm vitest run src/renderer/voice/pcmPlayer.test.ts`

  Expected: FAIL because the current player ignores the third `play` argument and factory option, so `idleEpochs` remains empty after `sources[1].end()`.

- [ ] **Step 3: Implement the playback-idle callback and stop generation guard**

  In `src/renderer/voice/pcmPlayer.ts`, make the public API and factory options exactly:

  ```ts
  export interface PcmPlayer {
    play(audioBase64: string, sampleRate: number, playbackEpoch: number): void
    stop(): void
    getCurrentLevel(): number
  }

  export interface PcmPlayerOptions {
    onPlaybackIdle?: (playbackEpoch: number) => void
  }

  export function createPcmPlayer({ onPlaybackIdle }: PcmPlayerOptions = {}): PcmPlayer {
  ```

  Add these factory-local fields:

  ```ts
  let playbackGeneration = 0
  let lastScheduledEpoch = 0
  ```

  At the start of `play`, capture `const sourceGeneration = playbackGeneration`, then assign `lastScheduledEpoch = playbackEpoch` after the source is queued. Replace the source `onended` assignment with:

  ```ts
  src.onended = () => {
    sources = sources.filter((source) => source !== src)
    activeChunks = activeChunks.filter((active) => active !== chunk)
    if (
      sourceGeneration === playbackGeneration &&
      sources.length === 0 &&
      lastScheduledEpoch === playbackEpoch
    ) {
      onPlaybackIdle?.(playbackEpoch)
    }
  }
  ```

  Start `stop` with `playbackGeneration += 1` before stopping and clearing sources. This makes browser `onended` callbacks caused by explicit cancellation unable to report a normal completion. Do not reset the scheduler: its current monotonic scheduling behavior is intentionally unchanged.

- [ ] **Step 4: Connect the player to the typed renderer API**

  In `src/renderer/main.ts`, create the player with the explicit callback:

  ```ts
  const pcmPlayer = createPcmPlayer({
    onPlaybackIdle: (playbackEpoch) => window.voiceApi.reportPlaybackIdle(playbackEpoch)
  })
  ```

  Replace the chunk listener with:

  ```ts
  window.voiceApi.onAudioChunk((chunk) => {
    pcmPlayer.play(chunk.audioBase64, chunk.sampleRate, chunk.playbackEpoch)
  })
  ```

  Keep `onPlaybackStop(() => pcmPlayer.stop())` unchanged; that path must stay a cancellation, not an idle acknowledgement.

- [ ] **Step 5: Run the renderer tests and type check**

  Run: `pnpm vitest run src/renderer/voice/pcmPlayer.test.ts src/renderer/voice/playbackScheduler.test.ts && pnpm typecheck`

  Expected: all named tests PASS and both TypeScript configurations complete with exit code 0.

- [ ] **Step 6: Commit the renderer implementation**

  ```bash
  git add src/renderer/voice/pcmPlayer.ts src/renderer/voice/pcmPlayer.test.ts src/renderer/main.ts
  git commit -m "feat(语音): 回报PCM实际播放完成"
  ```

### Task 3: Add a pure main-process gate for reply and audio completion

**Files:**
- Create: `src/main/shell/chatHideAfterVoice.ts`
- Create: `src/main/shell/chatHideAfterVoice.test.ts`

- [ ] **Step 1: Write the failing state-transition tests**

  Create `src/main/shell/chatHideAfterVoice.test.ts` with these scenarios:

  ```ts
  import { createChatHideAfterVoiceGate } from './chatHideAfterVoice'

  describe('createChatHideAfterVoiceGate', () => {
    it('allows a text-only reply to start its hide delay immediately', () => {
      const gate = createChatHideAfterVoiceGate()
      expect(gate.noteReplyDone()).toBe(true)
    })

    it('waits for the latest audio epoch after the reply is done', () => {
      const gate = createChatHideAfterVoiceGate()
      gate.noteAudioChunk(4)
      gate.noteAudioChunk(5)
      expect(gate.noteReplyDone()).toBe(false)
      expect(gate.notePlaybackIdle(4)).toBe(false)
      expect(gate.notePlaybackIdle(5)).toBe(true)
    })

    it('does not let an old epoch complete a newer reply', () => {
      const gate = createChatHideAfterVoiceGate()
      gate.noteAudioChunk(20)
      expect(gate.noteReplyDone()).toBe(false)
      expect(gate.notePlaybackIdle(19)).toBe(false)
      expect(gate.notePlaybackIdle(20)).toBe(true)
    })

    it('requires a later chunk after an earlier idle report', () => {
      const gate = createChatHideAfterVoiceGate()
      expect(gate.noteReplyDone()).toBe(true)
      gate.noteAudioChunk(51)
      expect(gate.notePlaybackIdle(50)).toBe(false)
      expect(gate.notePlaybackIdle(51)).toBe(true)
    })

    it('forgets cancelled work so a new text-only reply is not delayed', () => {
      const gate = createChatHideAfterVoiceGate()
      gate.noteAudioChunk(30)
      gate.reset()
      expect(gate.notePlaybackIdle(30)).toBe(false)
      expect(gate.noteReplyDone()).toBe(true)
    })
  })
  ```

- [ ] **Step 2: Run the new test to verify it fails**

  Run: `pnpm vitest run src/main/shell/chatHideAfterVoice.test.ts`

  Expected: FAIL with a module-not-found error for `./chatHideAfterVoice`.

- [ ] **Step 3: Implement the minimal pure gate**

  Create `src/main/shell/chatHideAfterVoice.ts` with this complete state machine:

  ```ts
  export interface ChatHideAfterVoiceGate {
    reset(): void
    noteAudioChunk(playbackEpoch: number): void
    noteReplyDone(): boolean
    notePlaybackIdle(playbackEpoch: number): boolean
  }

  export function createChatHideAfterVoiceGate(): ChatHideAfterVoiceGate {
    let replyDone = false
    let latestAudioEpoch = 0
    let playedThroughEpoch = 0

    return {
      reset(): void {
        replyDone = false
        latestAudioEpoch = 0
        playedThroughEpoch = 0
      },
      noteAudioChunk(playbackEpoch: number): void {
        latestAudioEpoch = Math.max(latestAudioEpoch, playbackEpoch)
      },
      noteReplyDone(): boolean {
        replyDone = true
        return latestAudioEpoch === 0 || playedThroughEpoch >= latestAudioEpoch
      },
      notePlaybackIdle(playbackEpoch: number): boolean {
        playedThroughEpoch = Math.max(playedThroughEpoch, playbackEpoch)
        return replyDone && latestAudioEpoch > 0 && playedThroughEpoch >= latestAudioEpoch
      }
    }
  }
  ```

  This module deliberately has no timer, Electron import, or validation: callers validate untrusted IPC before calling it, and `index.ts` owns the existing 3.5-second timer.

- [ ] **Step 4: Run the state-machine test to verify it passes**

  Run: `pnpm vitest run src/main/shell/chatHideAfterVoice.test.ts`

  Expected: 5 tests PASS.

- [ ] **Step 5: Commit the pure gate**

  ```bash
  git add src/main/shell/chatHideAfterVoice.ts src/main/shell/chatHideAfterVoice.test.ts
  git commit -m "feat(交互): 增加语音完成隐藏状态机"
  ```

### Task 4: Gate the existing bubble timer in the main process

**Files:**
- Modify: `src/main/shell/index.ts:64-85,344-386,611-646,725-777,987-995`

- [ ] **Step 1: Wire the gate, epoch assignment, and validated renderer report in `index.ts`**

  Add this import with the other shell helpers:

  ```ts
  import { createChatHideAfterVoiceGate } from './chatHideAfterVoice'
  ```

  Beside `chatHideTimer`, add process-lifetime epoch allocation and the reset helper:

  ```ts
  let nextVoicePlaybackEpoch = 0
  const chatHideAfterVoice = createChatHideAfterVoiceGate()

  function resetChatHideAfterVoice(): void {
    clearChatHideTimer()
    chatHideAfterVoice.reset()
  }
  ```

  Keep `scheduleChatHide()` unchanged so the post-playback delay remains exactly `AMBIENT_TTL_MS` (3,500 ms). Make these presentation changes:

  ```ts
  pushDone: () => {
    dialog.window()?.webContents.send(IPC.CHAT_DONE)
    bubble.pushDone()
    if (chatHideAfterVoice.noteReplyDone()) scheduleChatHide()
  },
  pushError: (message) => {
    resetChatHideAfterVoice()
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, message)
    bubbleHasContent = true; refreshBubble(); bubble.pushError(message)
  },
  ```

  Replace the voice chunk forwarder with:

  ```ts
  onAudioChunk: (chunk) => {
    const playbackEpoch = ++nextVoicePlaybackEpoch
    clearChatHideTimer()
    chatHideAfterVoice.noteAudioChunk(playbackEpoch)
    petWin.webContents.send(IPC.VOICE_AUDIO_CHUNK, { ...chunk, playbackEpoch })
  },
  ```

  In the existing `emitPetEvent`, replace the `messageSent` branch body with a reset before clearing the old bubble:

  ```ts
  if (event === 'messageSent') {
    clearAmbientLine()
    resetChatHideAfterVoice()
    bubbleHasContent = false
    bubble.clear()
    bubble.hide()
  }
  ```

  At the successful pet-switch cleanup site, stop the renderer player and reset the same state:

  ```ts
  clearAmbientLine()
  resetChatHideAfterVoice()
  petWin.webContents.send(IPC.VOICE_PLAYBACK_STOP)
  bubbleHasContent = false
  bubble.clear()
  bubble.hide()
  ```

  In the `CHAT_SEND` and `CANCEL_CHAT` handlers, clear stale wait state before continuing, and add the sender-checked idle report handler:

  ```ts
  ipcMain.on(IPC.CHAT_SEND, (_event, raw) => {
    const payload = validateChatSend(raw)
    if (!payload) return
    resetChatHideAfterVoice()
    session.chat.handleSend(payload)
  })

  ipcMain.on(IPC.CANCEL_CHAT, () => {
    resetChatHideAfterVoice()
    session.chat.cancel()
    petWin.webContents.send(IPC.VOICE_PLAYBACK_STOP)
  })

  ipcMain.on(IPC.VOICE_PLAYBACK_IDLE, (event, raw) => {
    if (event.sender !== petWin.webContents) return
    if (!Number.isSafeInteger(raw) || raw <= 0) return
    if (chatHideAfterVoice.notePlaybackIdle(raw)) scheduleChatHide()
  })
  ```

  The duplicated `CHAT_SEND` and `messageSent` reset is intentional and harmless: the IPC boundary clears an already scheduled timer immediately, while `messageSent` preserves the same guarantee for any future sender that invokes the established event path.

- [ ] **Step 2: Run focused tests and static checks**

  Run: `pnpm vitest run src/main/shell/chatHideAfterVoice.test.ts src/renderer/voice/pcmPlayer.test.ts && pnpm typecheck`

  Expected: all tests PASS and both TypeScript configurations complete with exit code 0.

- [ ] **Step 3: Commit main-process integration**

  ```bash
  git add src/main/shell/index.ts src/main/shell/chatHideAfterVoice.test.ts
  git commit -m "fix(交互): 语音播放后再隐藏气泡"
  ```

### Task 5: Verify end-to-end behavior and consolidate the feature commit

- [ ] **Step 1: Run the full automated suite**

  Run: `pnpm test && pnpm typecheck && pnpm build`

  Expected: Vitest reports all test files passing; both TypeScript projects pass; electron-vite produces main, preload, and renderer bundles.

- [ ] **Step 2: Perform the required visual Electron verification**

  Run: `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; pnpm preview`

  Expected manual checks:

  1. With voice disabled, send a reply and confirm its bubble hides about 3.5 seconds after the text completes.
  2. With voice enabled, send a multi-sentence reply and confirm the bubble remains visible for the full audible playback plus about 3.5 seconds.
  3. Send a new message or cancel during playback and confirm audio stops, the old bubble does not later hide a newer reply, and no delayed old completion affects the next text-only reply.
  4. Switch pets during playback and confirm the old audio stops and no stale completion hides a later bubble.

- [ ] **Step 3: Squash interim implementation commits into one conventional Chinese commit**

  Keep the already committed design (`7c6826d`) and this plan-document commit separate. Squash only the four Task 1–4 implementation commits into one final feature commit:

  ```bash
  git reset --soft HEAD~4
  git commit -m "fix(交互): 语音播放后再隐藏气泡"
  ```

  Before the reset, record `git status --short` and confirm the pre-existing user change to `package.json` remains unstaged and unmodified. After the reset, run `git diff --cached --name-only`; it must list only the implementation files from Tasks 1–4, never `package.json` or either design/plan document.
