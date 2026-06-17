import { createFile, DataStream } from 'mp4box';

interface DecodeRequest {
    type: 'decode';
    requestId: number;
    fileName: string;
    mimeType: string;
    buffer: ArrayBuffer;
    width: number;
    height: number;
    fps: number;
    maxFrames: number;
    dither: boolean;
    threshold: number;
}

interface DecodeResult {
    width: number;
    height: number;
    fps: number;
    maxFrames: number;
    dither: boolean;
    threshold: number;
    frames: number[][][];
    sourceName: string;
    sourceType: string;
}

const DEFAULT_THRESHOLD = 127;
const MICROSECONDS_PER_SECOND = 1000000;

function postProgress(requestId: number, message: string, progress?: number) {
    self.postMessage({
        type: 'progress',
        requestId,
        message,
        progress,
    });
}

function postError(requestId: number, message: string) {
    self.postMessage({
        type: 'error',
        requestId,
        message,
    });
}

function normalizeDimension(value: number, fallback: number, min: number, max: number) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeDecodeOptions(request: DecodeRequest) {
    return {
        width: normalizeDimension(request.width, 128, 1, 256),
        height: normalizeDimension(request.height, 64, 1, 128),
        fps: normalizeDimension(request.fps, 10, 1, 60),
        maxFrames: normalizeDimension(request.maxFrames, 30, 1, 500),
        dither: !!request.dither,
        threshold: normalizeDimension(request.threshold, DEFAULT_THRESHOLD, 0, 255),
    };
}

function imageDataToBitmap(imageData: ImageData, width: number, height: number, dither: boolean, threshold: number): number[][] {
    return dither
        ? imageDataToDitheredBitmap(imageData, width, height)
        : imageDataToThresholdBitmap(imageData, width, height, threshold);
}

function getWeightedGray(red: number, green: number, blue: number): number {
    return (red * 4 + green * 10 + blue * 2) >> 4;
}

function imageDataToThresholdBitmap(imageData: ImageData, width: number, height: number, threshold: number): number[][] {
    const bitmap: number[][] = [];

    for (let y = 0; y < height; y++) {
        const row: number[] = [];
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const alpha = imageData.data[index + 3];
            if (alpha < 128) {
                row.push(0);
                continue;
            }

            const red = imageData.data[index];
            const green = imageData.data[index + 1];
            const blue = imageData.data[index + 2];
            const gray = getWeightedGray(red, green, blue);
            row.push(gray < threshold ? 1 : 0);
        }
        bitmap.push(row);
    }

    return bitmap;
}

function imageDataToDitheredBitmap(imageData: ImageData, width: number, height: number): number[][] {
    const luminance = new Float32Array(width * height);
    const opaque = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixelIndex = y * width + x;
            const dataIndex = pixelIndex * 4;
            const alpha = imageData.data[dataIndex + 3];
            opaque[pixelIndex] = alpha >= 128 ? 1 : 0;

            if (!opaque[pixelIndex]) {
                luminance[pixelIndex] = 255;
                continue;
            }

            const red = imageData.data[dataIndex];
            const green = imageData.data[dataIndex + 1];
            const blue = imageData.data[dataIndex + 2];
            luminance[pixelIndex] = getWeightedGray(red, green, blue);
        }
    }

    const addError = (x: number, y: number, error: number, factor: number) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const index = y * width + x;
        if (!opaque[index]) return;
        luminance[index] += error * factor;
    };

    const bitmap: number[][] = [];
    for (let y = 0; y < height; y++) {
        const row: number[] = [];
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (!opaque[index]) {
                row.push(0);
                continue;
            }

            const oldPixel = luminance[index];
            const newPixel = oldPixel < DEFAULT_THRESHOLD ? 0 : 255;
            const quantError = oldPixel - newPixel;
            luminance[index] = newPixel;
            row.push(newPixel === 0 ? 1 : 0);

            addError(x + 1, y, quantError, 7 / 16);
            addError(x - 1, y + 1, quantError, 3 / 16);
            addError(x, y + 1, quantError, 5 / 16);
            addError(x + 1, y + 1, quantError, 1 / 16);
        }
        bitmap.push(row);
    }

    return bitmap;
}

function frameToBitmap(frame: VideoFrame, width: number, height: number, dither: boolean, threshold: number): number[][] {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        throw new Error('无法创建取模画布');
    }

    context.clearRect(0, 0, width, height);
    context.drawImage(frame, 0, 0, width, height);

    const imageData = context.getImageData(0, 0, width, height);
    return imageDataToBitmap(imageData, width, height, dither, threshold);
}

function getBoxDescription(box: any): Uint8Array | undefined {
    if (!box || typeof box.write !== 'function') {
        return undefined;
    }

    const stream = new DataStream(undefined, 0, 1 as any) as any;
    box.write(stream);

    const byteLength = Number(stream.byteLength || stream.getPosition?.() || 0);
    if (byteLength <= 8) {
        return undefined;
    }

    return new Uint8Array(stream.buffer.slice(8, byteLength));
}

function getDecoderDescription(sample: any): Uint8Array | undefined {
    const description = sample?.description;
    return getBoxDescription(description?.avcC)
        || getBoxDescription(description?.hvcC)
        || getBoxDescription(description?.av1C)
        || getBoxDescription(description?.vpcC);
}

async function getMp4VideoSamples(buffer: ArrayBuffer): Promise<{ track: any; samples: any[] }> {
    return new Promise((resolve, reject) => {
        const mp4boxFile = createFile() as any;
        let videoTrack: any = null;
        const samples: any[] = [];

        mp4boxFile.onError = (module: string, message: string) => {
            reject(new Error(message || module || 'MP4 解析失败'));
        };

        mp4boxFile.onReady = (info: any) => {
            videoTrack = info.tracks?.find((track: any) => track.video);
            if (!videoTrack) {
                reject(new Error('MP4 中没有找到视频轨道'));
                return;
            }

            mp4boxFile.setExtractionOptions(videoTrack.id, null, {
                nbSamples: Math.max(1, Number(videoTrack.nb_samples || 1)),
            });
            mp4boxFile.start();
        };

        mp4boxFile.onSamples = (_id: number, _user: unknown, extractedSamples: any[]) => {
            samples.push(...extractedSamples);
        };

        const mp4Buffer = buffer.slice(0) as ArrayBuffer & { fileStart?: number };
        mp4Buffer.fileStart = 0;
        mp4boxFile.appendBuffer(mp4Buffer);
        mp4boxFile.flush();

        setTimeout(() => {
            if (!videoTrack) {
                reject(new Error('MP4 元数据解析失败'));
                return;
            }
            if (samples.length === 0) {
                reject(new Error('MP4 视频帧提取失败'));
                return;
            }
            resolve({ track: videoTrack, samples });
        }, 0);
    });
}

async function decodeMp4(request: DecodeRequest): Promise<DecodeResult> {
    const VideoDecoderCtor = (self as any).VideoDecoder;
    const EncodedVideoChunkCtor = (self as any).EncodedVideoChunk;
    if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
        throw new Error('当前浏览器不支持 WebCodecs VideoDecoder');
    }

    const options = normalizeDecodeOptions(request);
    postProgress(request.requestId, '正在解析 MP4...', 0.08);
    const { track, samples } = await getMp4VideoSamples(request.buffer);
    const firstSample = samples[0];
    const decoderDescription = getDecoderDescription(firstSample);
    const config: VideoDecoderConfig = {
        codec: track.codec,
        codedWidth: track.video?.width || track.track_width || options.width,
        codedHeight: track.video?.height || track.track_height || options.height,
    };

    if (decoderDescription) {
        config.description = decoderDescription;
    }

    if (typeof VideoDecoderCtor.isConfigSupported === 'function') {
        const support = await VideoDecoderCtor.isConfigSupported(config);
        if (!support.supported) {
            throw new Error(`当前浏览器不支持解码 ${track.codec}`);
        }
    }

    const frames: number[][][] = [];
    const intervalUs = MICROSECONDS_PER_SECOND / options.fps;
    let firstTimestamp: number | null = null;
    let nextCaptureAt = 0;

    const decoder = new VideoDecoderCtor({
        output: (frame: VideoFrame) => {
            try {
                const timestamp = Number.isFinite(frame.timestamp) ? frame.timestamp : 0;
                if (firstTimestamp === null) {
                    firstTimestamp = timestamp;
                    nextCaptureAt = timestamp;
                }

                if (frames.length < options.maxFrames && timestamp + 1 >= nextCaptureAt) {
                    frames.push(frameToBitmap(frame, options.width, options.height, options.dither, options.threshold));
                    nextCaptureAt += intervalUs;
                    postProgress(
                        request.requestId,
                        `正在取模 MP4 帧 ${frames.length}/${options.maxFrames}`,
                        Math.min(0.95, frames.length / options.maxFrames),
                    );
                }
            } finally {
                frame.close();
            }
        },
        error: (error: Error) => {
            throw error;
        },
    });

    decoder.configure(config);

    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const timestamp = Math.round((sample.cts ?? sample.dts ?? 0) * MICROSECONDS_PER_SECOND / track.timescale);
        const duration = Math.max(1, Math.round((sample.duration || 1) * MICROSECONDS_PER_SECOND / track.timescale));

        decoder.decode(new EncodedVideoChunkCtor({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp,
            duration,
            data: sample.data,
        }));
    }

    await decoder.flush();
    decoder.close();

    if (frames.length === 0) {
        throw new Error('MP4 解码成功，但没有取到有效帧');
    }

    return {
        ...options,
        frames,
        sourceName: request.fileName,
        sourceType: request.mimeType || 'video/mp4',
    };
}

function getImageDecoderType(request: DecodeRequest): string {
    const mimeType = (request.mimeType || '').toLowerCase();
    const fileName = request.fileName.toLowerCase();

    if (mimeType.includes('png') || fileName.endsWith('.png')) {
        return 'image/png';
    }

    return 'image/gif';
}

function getImageFormatLabel(imageType: string): string {
    return imageType === 'image/png' ? 'PNG' : 'GIF';
}

async function decodeImageAnimation(request: DecodeRequest): Promise<DecodeResult> {
    const ImageDecoderCtor = (self as any).ImageDecoder;
    if (!ImageDecoderCtor) {
        throw new Error('当前浏览器不支持 ImageDecoder');
    }

    const options = normalizeDecodeOptions(request);
    const imageType = getImageDecoderType(request);
    const imageLabel = getImageFormatLabel(imageType);
    const imageData = new Uint8Array(request.buffer);
    const decoder = new ImageDecoderCtor({
        data: imageData,
        type: imageType,
    });

    postProgress(request.requestId, `正在解析 ${imageLabel}...`, 0.08);
    await decoder.tracks.ready;

    const selectedTrack = decoder.tracks.selectedTrack;
    const trackFrameCount = Number(selectedTrack?.frameCount || 0);
    const sourceFrameCount = Number.isFinite(trackFrameCount) && trackFrameCount > 0
        ? Math.min(trackFrameCount, options.maxFrames)
        : options.maxFrames;
    const intervalUs = MICROSECONDS_PER_SECOND / options.fps;
    const frames: number[][][] = [];
    let nextCaptureAt = 0;
    let currentTimestamp = 0;

    for (let frameIndex = 0; frameIndex < sourceFrameCount && frames.length < options.maxFrames; frameIndex++) {
        let result: any;
        try {
            result = await decoder.decode({ frameIndex });
        } catch (error) {
            if (frames.length > 0) {
                break;
            }
            throw error;
        }

        const image = result.image as VideoFrame;

        if (frames.length === 0 || currentTimestamp + 1 >= nextCaptureAt) {
            frames.push(frameToBitmap(image, options.width, options.height, options.dither, options.threshold));
            nextCaptureAt += intervalUs;
            postProgress(
                request.requestId,
                `正在取模 ${imageLabel} 帧 ${frames.length}/${options.maxFrames}`,
                Math.min(0.95, frames.length / options.maxFrames),
            );
        }

        currentTimestamp += Number(image.duration || intervalUs);
        image.close();
    }

    decoder.close();

    if (frames.length === 0) {
        throw new Error(`${imageLabel} 解码成功，但没有取到有效帧`);
    }

    return {
        ...options,
        frames,
        sourceName: request.fileName,
        sourceType: request.mimeType || imageType,
    };
}

self.addEventListener('message', async (event: MessageEvent<DecodeRequest>) => {
    const request = event.data;
    if (!request || request.type !== 'decode') return;

    try {
        const fileName = request.fileName.toLowerCase();
        const mimeType = (request.mimeType || '').toLowerCase();
        const isGif = mimeType.includes('gif') || fileName.endsWith('.gif');
        const isPng = mimeType.includes('png') || fileName.endsWith('.png');
        const isMp4 = mimeType.includes('mp4') || fileName.endsWith('.mp4') || mimeType.includes('quicktime');

        if (!isGif && !isPng && !isMp4) {
            throw new Error('只支持 MP4、GIF 或 PNG 文件');
        }

        const result = isMp4 ? await decodeMp4(request) : await decodeImageAnimation(request);
        self.postMessage({
            type: 'done',
            requestId: request.requestId,
            result,
        });
    } catch (error: any) {
        postError(request.requestId, error?.message || '动画取模失败');
    }
});
