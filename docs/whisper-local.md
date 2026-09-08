# Local Whisper dictation

Whisper is an opt-in local speech-to-text engine, independent of the session's
chat model and permissions. It never submits messages itself. The Desktop client
owns microphone permission, silence detection, the captured target session, and
ordinary chat submission. No Google, OpenAI, or remote inference credentials are
used by this service. Remote browser methods do not grant access to these RPCs.

## Host setup

This implementation does **not** ship a native engine binary. Install
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) on the host, or set the
absolute `AGENC_WHISPER_CLI` executable path in the daemon's startup environment.
Without this override, macOS checks `/opt/homebrew/bin/whisper-cli` and
`/usr/local/bin/whisper-cli`; other hosts check `/usr/local/bin/whisper-cli` and
`/usr/bin/whisper-cli`. Client params and client environment snapshots cannot
choose an executable, filesystem path, URL, shell argument, or engine provider.

Desktop Settings must request a model installation explicitly. Status checks
never download a model or create storage. Base is approximately 148 MB and Small
488 MB (decimal). Models are multilingual, pinned to ggml repository revision
`5359861c739e955e79d9a303bcbc70fb988958b1`, and checked against upstream LFS
SHA256 digests before atomic installation. Corrupt files are never used.

Models live under `<AGENC_HOME>/whisper` with private directory/file permissions.
Audio is accepted as canonical PCM16 mono 16 kHz WAV, maximum 30 seconds, decoded
only after strict base64/header validation. Each transcription uses a private
temporary directory removed on success, failure, timeout, and cancellation.
There is no audio history, logging of transcripts, or voice-note attachment.
One installation or transcription is admitted at a time; excess work receives
`WHISPER_BUSY`, not an unbounded queue. A transcription has a 90 second execution
deadline and a 64 KiB combined output limit. Download deadline is ten minutes.
Client cancellation and disconnect terminate the child; SIGKILL follows after
1.5 seconds if it does not stop. Silence returns an empty string, not filler text.

## Internal local RPCs

- `audio.whisper.status {}` returns `{engine:"whisper.cpp", available, reason?, models:[{id, installed, bytes}]}`.
- `audio.whisper.install {model:"base"|"small"}` explicitly downloads a model and returns the same status.
- `audio.whisper.transcribe {model, language:"auto"|"en"|"es", audio:{mimeType:"audio/wav", data:<base64>}}` returns `{text, model, provider:"local"}`.
- Use `request.cancel {requestId}` on the same connection to cancel installation or transcription. Closing that connection also cancels it.

Feature-detect these methods from `initialize.result.capabilities["daemon.methods"]`.
Use a dedicated client connection so inference/download does not block the normal
daemon control lane. Errors contain stable codes and user-safe messages, never
native stderr or temporary audio paths.

## Licenses and redistribution

[whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/LICENSE)
is MIT licensed. [OpenAI Whisper code and model weights](https://github.com/openai/whisper#license)
are MIT licensed. The downloaded ggml models are converted Whisper weights,
not a Google language model. Preserve applicable copyright and MIT permission
notices with any future redistribution of the engine or models; private repository
visibility does not replace license obligations. This implementation introduces
no FFmpeg, SDL, Silero, or Google runtime dependency. Native binary packaging,
platform signing, and bundled-license verification remain separate release work.

## Verification

Run the focused unit and dispatcher contracts through the repo's hermetic Vitest
wrapper. The opt-in real-engine check below creates its own temporary home,
downloads/verifies Base, transcribes the bundled upstream JFK fixture, checks
silence/temporary-file cleanup, and removes the test model/home afterward. It
never starts a daemon, reads real sessions, opens a microphone, or sends a chat.

```sh
cd runtime
WHISPER_VERIFY_DOWNLOAD=1 node --import tsx scripts/check-whisper-local.ts /opt/homebrew/opt/whisper-cpp/share/whisper-cpp/jfk.wav
```
