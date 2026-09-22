# Cycore embedded video

Deploy the web editor, cloud server and `@aily-project/lib-cycore-gfx` 1.1.0 together. The web build copies the pinned single-thread FFmpeg WASM core and its worker modules into `assets/ffmpeg`; serve `.wasm` with `application/wasm`. The core is fetched on demand from the same deployment. See `public/assets/ffmpeg/NOTICE.txt` for upstream source/license information.

The library repository distributes C++ through `cycore_gfx/src.7z`. When updating a server that already extracted the old archive, refresh that library's extracted `src` directory from the new archive before compiling; the existing extraction service skips directories that already exist. No firmware is automatically flashed by this feature.

Original input <=5 MiB, converted resource <=7 MiB, total firmware capacity independently validated by the server. Default target: 10fps JPEG + 16kHz signed 16-bit mono PCM. Presets: 240×240, 240×320, 320×240. This is intended for short clips; the upload limit does not guarantee a clip fits.

The field is empty when a block is first inserted. Live code generation emits a readable `CYCORE_VIDEO_INVALID` compile guard and a valid empty resource instead of throwing. The compile action detects this guard before submitting a build; direct C++ compilation also fails safely. Selecting a valid video removes the guard on the next generation.

Server policy: project-local `.cycore/video-partitions.csv`, `package.json.cycoreVideoPartition`. Standard dual OTA + FFat layout only. A measurement pass uses the maximum legal dual-slot layout, followed by a final pass with the preserved or expanded layout; measurement binaries cannot become flash artifacts. Minimum FFat: 1MiB, expansion reserve: 256KiB, application alignment: 64KiB. Layout does not shrink when resources are removed. Requests for the same project are serialized inside the server process; use one compiler owner per project when running multiple server instances.

Compile response `videoCapacity`: firmwareBytes, appPartitionBytes, fileSystemBytes, flashBytes, partitionChanged, requiresUsb, fileSystemMayBeLost. The USB uploader reads actual Flash capacity and old partition data before writing, prompts when file storage changes, and never automatically erases the entire chip for video updates.

Validation:

- `python3 scripts/test-cycore-video.py`: browser/WASM codec matrix (H.264/AAC, H.265/AAC, MPEG-4/MP3, VP8/Opus, VP9/Opus), 5MiB boundary, corrupt input, silent/rotated/delayed audio, Blockly field resize/save/reload/cancel/clear.
- `npx tsc --noEmit -p tsconfig.app.json`, `ng build --configuration dev`.
- Server: `mvn -Dtest=VideoPartitionPlannerTest,CloudProjectServiceTest test`.
- Library: `node --test cycore_gfx/tests/video-generator.test.cjs`.
- ESP32-S3 Arduino 3.2.1 compile/link and actual TJpg decoder compatibility checked with a converted JPEG. Hardware playback, DMA behavior, GPIO wiring, 10fps and <=100ms sync/pause targets require physical board acceptance.

JPEG encoding first uses optimized Huffman tables (`-huffman optimal`). An encoding error, encoding timeout or 15 seconds without an advancing FFmpeg output timestamp triggers one retry with fixed tables (`-huffman default`) in a fresh worker. Fixed tables preserve the selected quality, frame rate, duration and audio but can increase resource size. The compatibility attempt has the same resource checks and terminates with an error if it fails. User cancellation, invalid input, loading/probing errors and capacity rejection do not trigger a retry. On slow devices the stall heuristic can choose compatibility mode even when the first attempt would eventually progress.

Regression with a local file (not copied into source control):
`python3 scripts/test-cycore-video.py --video /path/to/video.mp4 --expect-fallback`
