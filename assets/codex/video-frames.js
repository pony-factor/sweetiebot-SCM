// Decode dropped videos within the Codex webview and upload bounded JPEG screenshots.
// This never writes to the workspace or sends the original unsupported video.
async function scmToolkitVideoScreenshots(file, maxFrames = 8) {
    if (!file?.size) throw new Error('The video file is empty.');
    const waitFor = (element, type, timeoutMs) => new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            element.removeEventListener(type, success);
            element.removeEventListener('error', failure);
        };
        const success = () => { cleanup(); resolve(); };
        const failure = () => { cleanup(); reject(new Error('The video could not be decoded.')); };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Video decoding took too long.'));
        }, timeoutMs);
        element.addEventListener(type, success);
        element.addEventListener('error', failure);
    });

    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    try {
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        const loaded = waitFor(video, 'loadeddata', 15000);
        video.src = url;
        video.load();
        await loaded;
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) {
            throw new Error('The video has no readable duration or frames.');
        }
        const frameCount = Math.min(maxFrames, duration < 0.3 ? 1 : duration < 2 ? 3 : duration < 8 ? 5 : 8);
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Screenshot capture is unavailable.');
        const baseName = String(file.name || 'video').replace(/\.[^.]+$/, '').slice(0, 100) || 'video';
        const frames = [];
        for (let index = 0; index < frameCount; index++) {
            // Midpoints avoid black first frames and seeks to the exact end of a clip.
            const timestamp = duration * (index + 0.5) / frameCount;
            const seeked = waitFor(video, 'seeked', 10000);
            video.currentTime = timestamp;
            await seeked;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((resolve, reject) => canvas.toBlob(
                output => output ? resolve(output) : reject(new Error('Could not encode screenshot.')),
                'image/jpeg', 0.82
            ));
            const seconds = Math.round(timestamp * 100) / 100;
            frames.push(new File([blob], baseName + '-at-' + seconds + 's.jpg', { type: 'image/jpeg' }));
        }
        return frames;
    } finally {
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }
}
