export interface ChatHideAfterVoiceGate {
  reset(lastPlaybackEpoch?: number): void
  noteAudioChunk(playbackEpoch: number): void
  noteAudioProductionDone(): boolean
  noteReplyDone(): boolean
  notePlaybackIdle(playbackEpoch: number): boolean
}

export function createChatHideAfterVoiceGate(): ChatHideAfterVoiceGate {
  let replyDone = false
  let audioProductionDone = false
  let latestAudioEpoch = 0
  let playedThroughEpoch = 0
  let minimumAcceptedEpoch = 0

  return {
    reset(lastPlaybackEpoch = 0) {
      replyDone = false
      audioProductionDone = false
      latestAudioEpoch = 0
      minimumAcceptedEpoch = Math.max(minimumAcceptedEpoch, lastPlaybackEpoch)
      playedThroughEpoch = Math.max(playedThroughEpoch, minimumAcceptedEpoch)
    },
    noteAudioChunk(epoch) {
      if (epoch <= minimumAcceptedEpoch) return

      latestAudioEpoch = Math.max(latestAudioEpoch, epoch)
    },
    noteAudioProductionDone() {
      audioProductionDone = true
      return replyDone && (latestAudioEpoch === 0 || playedThroughEpoch >= latestAudioEpoch)
    },
    noteReplyDone() {
      replyDone = true
      return latestAudioEpoch === 0 || (audioProductionDone && playedThroughEpoch >= latestAudioEpoch)
    },
    notePlaybackIdle(epoch) {
      if (epoch <= minimumAcceptedEpoch) return false

      playedThroughEpoch = Math.max(playedThroughEpoch, epoch)
      return replyDone && audioProductionDone && latestAudioEpoch > 0 && playedThroughEpoch >= latestAudioEpoch
    }
  }
}
